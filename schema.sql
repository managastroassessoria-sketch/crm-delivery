-- Camada 1 do CRM de delivery — PostgreSQL.
-- Espelha src/modelo.ts. O repositório de produção implementa src/repositorio.ts sobre estas tabelas.

CREATE TYPE fonte_pedido   AS ENUM ('open_delivery', 'anota_ai');
CREATE TYPE tipo_linha     AS ENUM ('celular', 'fixo');
CREATE TYPE status_pedido  AS ENUM ('concluido', 'cancelado', 'em_andamento');
CREATE TYPE status_cliente AS ENUM ('ativo', 'telefone_central');
CREATE TYPE motivo_descarte AS ENUM (
  'cancelado', 'duplicado', 'marketplace', 'sem_cliente', 'sem_telefone',
  'telefone_criptografado', 'telefone_invalido', 'telefone_central'
);

CREATE TABLE loja (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL,
  criada_em  timestamptz NOT NULL DEFAULT now()
);

-- Uma linha por fonte conectada a uma loja. ultima_compra_em alimenta o monitor de saúde.
CREATE TABLE integracao (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id          uuid NOT NULL REFERENCES loja(id),
  fonte            fonte_pedido NOT NULL,
  ativa            boolean NOT NULL DEFAULT true,
  ultima_compra_em timestamptz,
  ultima_sincronizacao_em timestamptz,
  UNIQUE (loja_id, fonte)
);

-- O cliente é identificado pelo telefone dentro da loja.
CREATE TABLE cliente (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id       uuid NOT NULL REFERENCES loja(id),
  telefone_e164 text NOT NULL CHECK (telefone_e164 ~ '^\+55[0-9]{10,11}$'),
  tipo_linha    tipo_linha NOT NULL,          -- fixo nunca entra em campanha de WhatsApp
  nome          text,
  email         text,
  documento     text,
  status        status_cliente NOT NULL DEFAULT 'ativo',
  criado_em     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loja_id, telefone_e164)
);

-- Primeiros nomes distintos vistos por telefone: base da detecção de número de central.
CREATE TABLE cliente_nome_visto (
  cliente_id uuid NOT NULL REFERENCES cliente(id) ON DELETE CASCADE,
  nome_chave text NOT NULL,
  PRIMARY KEY (cliente_id, nome_chave)
);

CREATE TABLE pedido (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id        uuid NOT NULL REFERENCES loja(id),
  cliente_id     uuid NOT NULL REFERENCES cliente(id),
  fonte          fonte_pedido NOT NULL,
  id_externo     text NOT NULL,
  criado_em      timestamptz NOT NULL,
  status         status_pedido NOT NULL,
  total_centavos bigint NOT NULL CHECK (total_centavos >= 0),
  canal_venda    text,
  importado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fonte, loja_id, id_externo)
);
CREATE INDEX pedido_cliente_data ON pedido (cliente_id, criado_em DESC);
CREATE INDEX pedido_loja_data    ON pedido (loja_id, criado_em DESC);

CREATE TABLE pedido_item (
  pedido_id      uuid NOT NULL REFERENCES pedido(id) ON DELETE CASCADE,
  posicao        int  NOT NULL,
  nome           text NOT NULL,
  quantidade     numeric(12,3) NOT NULL,
  total_centavos bigint NOT NULL,
  codigo         text,
  PRIMARY KEY (pedido_id, posicao)
);

-- Todo pedido que não virou histórico, com o motivo. É daqui que sai a resposta
-- para "por que o volume está baixo" — o que no original fica invisível.
CREATE TABLE descarte (
  id          bigserial PRIMARY KEY,
  loja_id     uuid NOT NULL REFERENCES loja(id),
  fonte       fonte_pedido NOT NULL,
  id_externo  text NOT NULL,
  motivo      motivo_descarte NOT NULL,
  em          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fonte, loja_id, id_externo)           -- a mesma fonte reenvia o pedido; conta uma vez
);
CREATE INDEX descarte_loja_motivo ON descarte (loja_id, motivo, em DESC);

-- Integrações em alerta: 4 dias ou mais sem compra (mesma regra do monitor do Retorne).
CREATE VIEW integracao_em_alerta AS
SELECT i.*, date_part('day', now() - i.ultima_compra_em)::int AS dias_sem_compra
FROM integracao i
WHERE i.ativa AND (i.ultima_compra_em IS NULL OR i.ultima_compra_em <= now() - interval '4 days');

-- ── Camada 2: segmentação ─────────────────────────────────────────────────────
-- Acumulados por cliente, só de pedidos concluídos. Nenhuma métrica "do mês":
-- propriedade de período zera no dia 1 e o segmento morre em silêncio.
-- Quadrante, faixa de recência, dia e período preferidos e produto favorito são
-- calculados na aplicação (src/segmentacao/perfil.ts), que conhece os cortes e o fuso.
CREATE VIEW perfil_cliente_base AS
SELECT c.id                                   AS cliente_id,
       c.loja_id,
       c.status,
       c.tipo_linha,
       (c.email IS NOT NULL AND c.email <> '') AS tem_email,
       count(p.id)                            AS numero_compras,
       sum(p.total_centavos)                  AS total_gasto_centavos,
       round(avg(p.total_centavos))::bigint   AS ticket_medio_centavos,
       min(p.criado_em)                       AS primeira_compra_em,
       max(p.criado_em)                       AS ultima_compra_em,
       date_part('day', now() - max(p.criado_em))::int AS dias_desde_ultima_compra
FROM cliente c
JOIN pedido p ON p.cliente_id = c.id AND p.status = 'concluido'
GROUP BY c.id;

-- ── Camada 3: motor de campanha ───────────────────────────────────────────────
CREATE TYPE tipo_campanha AS ENUM ('gatilho', 'continuo', 'massa');
CREATE TYPE canal_envio   AS ENUM ('whatsapp', 'sms', 'email');
CREATE TYPE status_envio  AS ENUM ('planejado', 'enviado', 'entregue', 'lido', 'falhou', 'cancelado');

CREATE TABLE config_loja (
  loja_id                   uuid PRIMARY KEY REFERENCES loja(id),
  fuso                      text NOT NULL DEFAULT 'America/Sao_Paulo',
  dias_hibernacao           int  NOT NULL DEFAULT 3 CHECK (dias_hibernacao >= 0),  -- provisório
  max_mensagens_cliente_dia int  NOT NULL DEFAULT 1 CHECK (max_mensagens_cliente_dia >= 1)
);

CREATE TABLE campanha (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id                  uuid NOT NULL REFERENCES loja(id),
  nome                     text NOT NULL,
  tipo                     tipo_campanha NOT NULL,
  canal                    canal_envio NOT NULL,
  criativo_id              uuid NOT NULL,                      -- FK para criativo, criada na camada 4
  prioridade               int  NOT NULL DEFAULT 5,            -- 1 é a mais alta
  publicada                boolean NOT NULL DEFAULT false,
  inicio_em                timestamptz NOT NULL DEFAULT now(),
  hora                     time,                               -- hora exata no fuso da loja
  dias                     text NOT NULL DEFAULT 'pico'
    CHECK (dias ~ '^(pico|todos|(dom|seg|ter|qua|qui|sex|sab)(,(dom|seg|ter|qua|qui|sex|sab))*)$'),
  segmento                 jsonb,                              -- src/segmentacao/segmento.ts
  segmento_exclusao        jsonb,
  enviar_apenas_uma_vez    boolean NOT NULL DEFAULT false,
  nao_hibernar             boolean NOT NULL DEFAULT false,
  enviar_para_hibernando   boolean NOT NULL DEFAULT false,
  nao_contabilizar_receita boolean NOT NULL DEFAULT false,
  criada_em                timestamptz NOT NULL DEFAULT now(),
  CHECK (tipo = 'massa' OR (hora IS NOT NULL AND segmento IS NOT NULL))
);

-- Disparo em massa: população congelada na criação, fatiada pelas ondas na ordem de posicao.
CREATE TABLE campanha_populacao (
  campanha_id uuid NOT NULL REFERENCES campanha(id) ON DELETE CASCADE,
  posicao     int  NOT NULL,
  cliente_id  uuid NOT NULL REFERENCES cliente(id),
  PRIMARY KEY (campanha_id, posicao),
  UNIQUE (campanha_id, cliente_id)
);

CREATE TABLE campanha_onda (
  campanha_id uuid NOT NULL REFERENCES campanha(id) ON DELETE CASCADE,
  posicao     int  NOT NULL,
  em          timestamptz NOT NULL,
  quantidade  int  NOT NULL CHECK (quantidade > 0),
  PRIMARY KEY (campanha_id, posicao)
);

CREATE TABLE envio (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id             uuid NOT NULL REFERENCES loja(id),
  campanha_id         uuid NOT NULL REFERENCES campanha(id),
  cliente_id          uuid NOT NULL REFERENCES cliente(id),
  canal               canal_envio NOT NULL,
  criativo_id         uuid NOT NULL,                           -- FK para criativo, criada na camada 4
  planejado_para      timestamptz NOT NULL,
  onda                int,
  contabiliza_receita boolean NOT NULL,
  status              status_envio NOT NULL DEFAULT 'planejado',
  erro_codigo         text,                                    -- ex.: código de erro da Meta
  enviado_em          timestamptz,
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campanha_id, cliente_id, planejado_para)             -- replanejar o dia não duplica
);
CREATE INDEX envio_cliente_data ON envio (cliente_id, planejado_para DESC);
CREATE INDEX envio_loja_data    ON envio (loja_id, planejado_para DESC);

CREATE TABLE cliente_hibernacao (
  cliente_id     uuid PRIMARY KEY REFERENCES cliente(id) ON DELETE CASCADE,
  hibernando_ate timestamptz NOT NULL
);

-- Relatório de quem ficou de fora, por campanha, dia e motivo. No original só os
-- envios aparecem; hibernação, exclusões e limites ficam invisíveis.
CREATE TABLE nao_envio (
  campanha_id uuid NOT NULL REFERENCES campanha(id) ON DELETE CASCADE,
  data        date NOT NULL,
  motivo      text NOT NULL CHECK (motivo IN (
    'descadastrado', 'telefone_fixo', 'telefone_central', 'sem_whatsapp', 'sem_email', 'segmento_de_exclusao',
    'ja_recebeu', 'hibernando', 'outra_campanha_no_dia', 'cliente_indisponivel', 'grupo_controle')),
  quantidade  int  NOT NULL CHECK (quantidade > 0),
  PRIMARY KEY (campanha_id, data, motivo)
);

-- ── Camada 4: canal de envio (WhatsApp Cloud API) ─────────────────────────────
ALTER TABLE cliente
  ADD COLUMN descadastrado_em timestamptz,     -- vale para todos os canais
  ADD COLUMN sem_whatsapp_em  timestamptz;     -- erro 131026 da Meta

-- Registro de cada descadastro, com a origem. Base para comprovar o respeito ao pedido.
CREATE TABLE descadastro (
  id         bigserial PRIMARY KEY,
  cliente_id uuid NOT NULL REFERENCES cliente(id),
  origem     text NOT NULL CHECK (origem IN ('palavra_chave', 'erro_meta_131050', 'manual')),
  texto      text,                             -- a mensagem recebida, quando houver
  em         timestamptz NOT NULL DEFAULT now()
);

-- Conta WhatsApp de cada loja. O limite de destinatários é do PORTFÓLIO na Meta:
-- lojas no mesmo portfólio dividem a mesma cota de 24 h.
CREATE TABLE conta_whatsapp (
  loja_id             uuid PRIMARY KEY REFERENCES loja(id),
  portfolio_id        text NOT NULL,
  phone_number_id     text NOT NULL,
  limite_24h          int  NOT NULL DEFAULT 250,  -- whatsapp_business_manager_messaging_limit
  pausada_em          timestamptz,
  motivo_pausa        text
);

CREATE TABLE criativo (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id       uuid NOT NULL REFERENCES loja(id),
  nome_template text NOT NULL,
  idioma        text NOT NULL DEFAULT 'pt_BR',
  categoria     text NOT NULL CHECK (categoria IN ('marketing', 'utility')),
  variaveis     jsonb NOT NULL DEFAULT '[]',     -- src/envio/variaveis.ts
  pausado_em    timestamptz,
  motivo_pausa  text,
  UNIQUE (loja_id, nome_template, idioma)
);
ALTER TABLE campanha ADD CONSTRAINT campanha_criativo_fk FOREIGN KEY (criativo_id) REFERENCES criativo(id);
ALTER TABLE envio    ADD CONSTRAINT envio_criativo_fk    FOREIGN KEY (criativo_id) REFERENCES criativo(id);

ALTER TABLE envio
  ADD COLUMN wamid                text UNIQUE,   -- id da mensagem na Meta; liga os webhooks ao envio
  ADD COLUMN tentativas           int  NOT NULL DEFAULT 0,
  ADD COLUMN proxima_tentativa_em timestamptz,
  ADD COLUMN motivo_cancelamento  text,
  ADD COLUMN erro_detalhe         text,
  ADD COLUMN categoria_cobranca   text,          -- pricing.category do webhook
  ADD COLUMN tipo_cobranca        text,          -- pricing.type: regular (cobrado) ou free_*
  ADD COLUMN entregue_em          timestamptz,
  ADD COLUMN lido_em              timestamptz;
CREATE INDEX envio_pendente ON envio (planejado_para) WHERE status = 'planejado';

-- ── Camada 5: atribuição de receita e ROI ─────────────────────────────────────
ALTER TABLE config_loja
  ADD COLUMN janela_atribuicao_dias int NOT NULL DEFAULT 3 CHECK (janela_atribuicao_dias BETWEEN 1 AND 30),  -- provisório, exposto
  ADD COLUMN dias_para_recuperado   int NOT NULL DEFAULT 90 CHECK (dias_para_recuperado > 0);

ALTER TABLE campanha
  -- 5 casas: a fração entra no sorteio; arredondar ao salvar mudaria quem é controle.
  ADD COLUMN grupo_controle numeric(6,5) CHECK (grupo_controle BETWEEN 0 AND 0.5);

-- Quem foi sorteado para não receber. Comparado com quem recebeu, mede o efeito real.
CREATE TABLE grupo_controle (
  campanha_id uuid NOT NULL REFERENCES campanha(id) ON DELETE CASCADE,
  cliente_id  uuid NOT NULL REFERENCES cliente(id),
  em          timestamptz NOT NULL,          -- quando teria recebido
  PRIMARY KEY (campanha_id, cliente_id, em)
);

-- Preço por mensagem cobrada, por categoria, com vigência. Vem da tabela vigente da Meta;
-- nada é fixado no código.
CREATE TABLE preco_mensagem (
  categoria       text NOT NULL,             -- marketing, utility, ...
  preco_centavos  numeric(10,4) NOT NULL CHECK (preco_centavos >= 0),  -- a Meta cobra frações de centavo
  vigente_desde   date NOT NULL,
  PRIMARY KEY (categoria, vigente_desde)
);
