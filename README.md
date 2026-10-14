# crm-delivery

Núcleo do CRM de delivery.

- **Camada 1 — entrada de pedidos:** recebe pedidos das plataformas de canal próprio, identifica o cliente pelo telefone e grava o histórico de compras.
- **Camada 2 — segmentação:** calcula o perfil de cada cliente, classifica em quadrantes pela metodologia da Maná e monta segmentos com travas por canal.
- **Camada 3 — motor de campanha:** planeja, todo dia, quem recebe qual mensagem e a que horas, e registra quem ficou de fora e por quê.
- **Camada 4 — canal de envio:** envia pela WhatsApp Cloud API, interpreta os avisos de status e erros da Meta e cuida do descadastro.
- **Camada 5 — atribuição e ROI:** calcula a receita que as campanhas geraram, o custo, o ROI e, com grupo de controle, o efeito real; e o painel da loja com as definições da Maná.

Especificação completa: documento **Motor de Campanha — Especificação para Reconstrução**.

## Rodar

Node.js 22.18 ou mais recente (roda TypeScript direto, sem build).

```
npm install
npm test          # 82 testes
npm run typecheck
```

## Revisão independente

Depois das cinco camadas, o código passou por uma revisão feita por outro agente, sem acesso às decisões tomadas na construção. Ela encontrou 11 defeitos que os 70 testes da época não pegavam. Todos foram corrigidos, cada um com teste de regressão, e três deles foram revertidos de propósito para confirmar que os testes novos acusam.

| # | Defeito | Correção |
|---|---|---|
| 1 | Dias contados em blocos de 24 h: o D+1 de um pedido das 20h saía no D+2 | `diasDeCalendario` no fuso da loja, para recência, régua e média entre compras |
| 2 | O mesmo pedido descartado era registrado de novo a cada reenvio da fonte | Um descarte por pedido (`UNIQUE` no banco); o Anota AI não busca de novo o que foi descartado |
| 3 | Dias de pico enviesados: em 90 dias, um dia da semana cai 12 vezes e os outros 13 | Média por ocorrência de cada dia, em datas locais, sem contar hoje |
| 4 | Campanha das 20h hibernava o cliente para outra das 10h do mesmo dia | Hibernação com início e fim |
| 5 | Grupo de controle não comparável: escapava do limite diário e só os entregues eram comparados | Controle ocupa o limite e hiberna; comparação por intenção de tratar |
| 6 | Erros avisados pelo webhook (131026, 131050, 131049) não tinham consequência | `consequenciasDoWebhook` |
| 7 | Despachante ignorava o horário de nova tentativa e o canal | Filtro por `proximaTentativaEm` e só WhatsApp |
| 8 | Envio cancelado contava como recebido e hibernava o cliente | Histórico com status; hibernação calculada a partir dos envios válidos |
| 9 | Preço por mensagem em centavos inteiros, mas a Meta cobra frações | `numeric(10,4)` |
| 10 | Corte de "recuperado" (≥ 90) diferente do de "perdido" (> 90); o único fiel virava campeão | Mesmo corte; campeão só quando há fiéis suficientes para existir "os 20% de cima" |
| 11 | Fração do controle arredondada ao salvar; template sem chave estrangeira | `numeric(6,5)`; `criativo_id uuid` com FK |

O `schema.sql` foi aplicado num PostgreSQL 16 real: cria 19 tabelas e 2 visões, aceita os dados válidos de teste e recusa os 6 inválidos testados.

## Camada 5 — atribuição de receita e ROI

| Peça | Arquivo | O que faz |
|---|---|---|
| Atribuição | `src/atribuicao/atribuicao.ts` | Liga cada pedido ao envio que o influenciou; receita influenciada, recuperada e recorrente; custo; ROI; efeito medido pelo grupo de controle |
| Painel | `src/atribuicao/painel.ts` | Recompra, recorrência, participação de novos, ticket, LTV, base identificada |
| Grupo de controle | `src/campanhas/planejador.ts` | Sorteio fixo por cliente de uma fração que não recebe |

**Regra de atribuição (último toque):** um pedido concluído vai para o envio mais recente ao mesmo cliente, feito antes do pedido e dentro da janela. Só conta envio **entregue** ou lido, de campanha que conta receita. Um pedido nunca é atribuído a duas campanhas.

**Janela exposta e configurável**, ao contrário do Retorne, que esconde a dele. Valor provisório: 3 dias. Nos testes, a mesma loja mostra R$ 220 com janela de 3 dias e R$ 280 com 7 — por isso o número precisa vir com a janela ao lado.

**Definições:**

- **Receita influenciada:** pedidos atribuídos.
- **Recuperada:** parte da influenciada em que o cliente estava há mais de 90 dias de calendário sem comprar antes do envio — o mesmo corte e a mesma comparação de "perdido".
- **Recorrente influenciada:** parte da influenciada vinda de cliente com 2 ou mais compras anteriores.
- **Participação:** influenciada ÷ faturamento total.
- **Custo:** mensagens cobradas pela Meta no período, ao preço da categoria. Os preços entram por configuração (`preco_mensagem`); nenhum valor está fixo no código. Categoria sem preço gera aviso.
- **ROI:** influenciada ÷ custo, como múltiplo (ex.: 44,7x). Campanhas marcadas para não contar receita ficam fora do custo do ROI e aparecem à parte.

**Grupo de controle (opcional por campanha):** uma fração da população elegível (até 50%) é sorteada para não receber. O sorteio é fixo por campanha e cliente e acontece depois de todas as travas. Quem cai no controle ocupa o limite do dia e hiberna como se tivesse recebido, e a comparação usa todos os designados para receber (intenção de tratar), entregues ou não — assim os dois grupos são comparáveis. O relatório mostra a conversão de cada grupo, a diferença em pontos e a **receita incremental**: quanto a campanha gerou além do que viria de qualquer jeito. Com menos de 30 pessoas em algum grupo, sai marcado como amostra pequena.

**Painel da loja, com as definições da Maná:**

- Recompra = clientes do período que já tinham comprado antes ÷ clientes únicos × 100.
- Recorrência = pedidos do período ÷ clientes únicos.
- LTV = ticket médio × frequência mensal × meses ativos (médias da base).
- Participação de novos, com as faixas: ruim abaixo de 10% ou acima de 50%; ok 10–20%; excelente 20–35%; acima de 40% não saudável. Entre 35% e 40% não há faixa definida, e o painel diz isso em vez de inventar.

## Camada 4 — canal de envio

| Peça | Arquivo | O que faz |
|---|---|---|
| Cliente da API | `src/envio/whatsapp.ts` | Envia template pela Cloud API (`POST /{phone-number-id}/messages`) |
| Variáveis | `src/envio/variaveis.ts` | Preenche {{1}}, {{2}}... a partir do cliente; sem valor e sem reserva, não envia |
| Despachante | `src/envio/despachante.ts` | Envia o que venceu, respeita o limite da Meta e aplica a consequência de cada erro |
| Erros | `src/envio/erros.ts` | Tabela de códigos da Meta com explicação em português e ação |
| Webhook | `src/envio/webhook.ts` | Assinatura, verificação, status de entrega e leitura, cobrança, descadastro por palavra-chave |

**Regras da Meta tratadas:**

- **Limite de destinatários únicos em 24 h é por portfólio**, não por número; começa em 250. Quem não cabe na janela fica adiado até ela abrir, em vez de falhar.
- **Cobrança por mensagem** (desde julho/2025): a categoria e o tipo cobrado vêm no webhook e ficam gravados no envio, para a camada 5 calcular o custo.
- **"Lido" pode chegar sem "entregue" antes**, e webhooks podem chegar fora de ordem: o status nunca regride.
- **Assinatura `X-Hub-Signature-256`** conferida sobre o corpo bruto.

**O que cada erro provoca:**

| Erro | Consequência |
|---|---|
| 131050 — recusou marketing | cliente descadastrado de vez |
| 131026 — não recebe WhatsApp | cliente marcado; sai das próximas campanhas de WhatsApp |
| 132000, 132001, 132015, 132016 — problema no template | criativo pausado; os demais envios dele são cancelados sem tentar |
| 190, 368, 131031, 131048, 133010 — problema na conta | conta pausada; nada mais sai até resolver |
| 130429, 131056, 131000, 4, 80007 — temporário | reenvio com espera crescente, até 3 tentativas |
| 131049 — retido pela Meta | reenvio em 24 h |

**Descadastro:** mensagem recebida que seja inteira "sair", "parar", "stop", "descadastrar", "remover" ou "não quero mais receber" descadastra o cliente em todos os canais. "Cancelar" fica fora de propósito: "quero cancelar meu pedido" não é pedido de descadastro.

**Não envia texto quebrado:** variável sem valor e sem reserva cancela o envio com o motivo `variavel_ausente`, em vez de mandar "Olá , seu  favorito".

**Erros avisados depois, pelo webhook:** a Meta costuma informar 131026, 131050 e 131049 no status "failed", não na resposta do envio. `consequenciasDoWebhook` devolve quem descadastrar, quem marcar sem WhatsApp, quais envios voltam para a fila e quando, e se algum template ou a conta precisa ser pausada.

**Falta:** o servidor HTTP que recebe o webhook e o loop que chama o despachante a cada minuto; as funções estão prontas para serem ligadas a eles.

## Camada 3 — motor de campanha

| Peça | Arquivo | O que faz |
|---|---|---|
| Modelo | `src/campanhas/modelo.ts` | Campanha (gatilho, contínuo, massa), envio planejado, motivos de não envio, configuração da loja |
| Planejador | `src/campanhas/planejador.ts` | `planejarDia`: função pura que devolve envios do dia, relatório por campanha e novo estado de hibernação |
| Disparo em massa | `src/campanhas/massa.ts` | Valida ondas e gera o resumo legível que a tela de confirmação mostra |
| Diagnóstico | `src/campanhas/diagnostico.ts` | Avisa, antes de publicar, quando a hibernação vai travar a base ou a régua |

**Ordem das travas para cada cliente:** canal → segmento de exclusão → enviar uma vez → hibernação → limite diário. Quem para em qualquer uma é contado no relatório com o motivo.

**Regras da operação embutidas:**

- Dias de disparo padrão = `pico`: a campanha só dispara nos dias de pico da loja, calculados pela camada 2.
- Prioridade: num mesmo dia, o cliente recebe da campanha de prioridade mais alta (1). Limite padrão de uma mensagem por cliente por dia.
- Hora exata do disparo no fuso da loja, como no original.

**Diferenças em relação ao Retorne:**

- Hibernação visível: o relatório conta quantos foram pulados por hibernação, por campanha e por dia. No Retorne só os envios aparecem, e 83% de uma população travada pareceu "volume baixo".
- Diagnóstico antes de publicar: aponta campanhas que hibernam e pulam hibernados ao mesmo tempo (a base se esgota sozinha) e passos da régua que bloqueiam o passo seguinte.
- Disparo em massa editável até a primeira onda sair.
- Resumo de confirmação gerado a partir do que será gravado, com o dia da semana. No Retorne, datas de ondas já reverteram entre o ajuste e o salvamento.
- Replanejar o mesmo dia não duplica envio.

**Valores provisórios, a calibrar:** carência de hibernação de 3 dias e aviso de intervalo longo entre ondas a partir de 14 dias.

**Achado do diagnóstico sobre a régua:** se o D+1 (pedido de avaliação) hibernar com carência de 7 dias, ele bloqueia o D+4 e o D+7 do mesmo cliente. O D+1 deve ser configurado com "não hibernar".

## Camada 2 — segmentação

| Peça | Arquivo | O que faz |
|---|---|---|
| Perfil | `src/segmentacao/perfil.ts` | Métricas por cliente a partir dos pedidos concluídos; quadrante e faixa de recência |
| Dias de pico | `src/segmentacao/pico.ts` | Pedidos por dia da semana na janela; marca os dias acima da média |
| Campos | `src/segmentacao/campos.ts` | Catálogo de campos filtráveis e operadores por tipo |
| Segmentos | `src/segmentacao/segmento.ts` | Validação, avaliação, travas por canal e nome gerado pela regra |
| Régua | `src/segmentacao/regua.ts` | D+1, D+4, D+7, 30D e 90D como segmentos prontos |
| Fuso | `src/segmentacao/tempo.ts` | Dia e hora no fuso da loja (padrão America/Sao_Paulo) |

**Método:** primeiro o quadrante, depois a recência.

- Quadrantes: novo, recorrente, fiel, campeão, perdido.
- Recência pela escada da régua: até 4, 7, 15, 30, 60, 90 e acima de 90 dias.

**Cortes dos quadrantes são provisórios** (`CORTES_PADRAO`), a calibrar com os dados de cada loja:

- perdido acima de 90 dias sem comprar;
- fiel a partir de 4 compras;
- campeão é o fiel ativo nos 20% de maior gasto da loja;
- recorrente com 2 ou 3 compras;
- novo com 1 compra.

**Diferenças em relação ao Retorne:**

- Operador "entre" (no Retorne, faixa exige dois filtros).
- Travas automáticas por canal: WhatsApp e SMS excluem telefone fixo e número de central; e-mail exclui quem não tem e-mail. Cada exclusão é contada com o motivo.
- Nome do segmento gerado a partir da regra, então não há como o nome contradizer o filtro.
- Só métricas acumuladas, nenhuma "do mês".
- Dias de pico medidos pelo sistema: a regra da operação é só ativar campanha nos dias de pico da loja.

**Ainda não suportados** (dependem de módulos que geram o dado): aniversário, NPS, cupom, pesquisa, agendamento, indicação, carrinho abandonado.

## Camada 1 — o que está pronto

| Peça | Arquivo | O que faz |
|---|---|---|
| Modelo | `src/modelo.ts` | Pedido, cliente e motivos de descarte normalizados; valores em centavos |
| Telefone | `src/telefone.ts` | Normaliza para E.164 e classifica celular, fixo ou inválido |
| Adaptador Open Delivery | `src/adaptadores/opendelivery.ts` | Order da especificação v1.7.1 → pedido normalizado |
| Adaptador Anota AI | `src/adaptadores/anotaai.ts` | Detalhe da API de Pedidos v2 → pedido normalizado |
| Ingestão | `src/ingestao.ts` | Importa, aguarda, atualiza ou descarta com motivo |
| Conector Open Delivery | `src/conectores/opendelivery.ts` | Polling de eventos, busca do pedido, confirmação |
| Conector Anota AI | `src/conectores/anotaai.ts` | Lista do dia paginada, detalhe, só leitura |
| Monitor de saúde | `src/saude.ts` | Integração em alerta com 4 dias ou mais sem compra |
| Banco | `schema.sql` | Tabelas PostgreSQL espelhando o modelo, mais a visão `perfil_cliente_base` |

O conector Open Delivery atende Delivery Direto e Cardápio Web (API Open Delivery), além de Accon, Brendi e qualquer outro emissor do padrão.

## Decisões que vêm da análise do Retorne

- **Só pedido concluído e com telefone vira histórico.** Em andamento aguarda; cancelado depois de importado tem o status atualizado.
- **Todo descarte tem motivo gravado** (`cancelado`, `marketplace`, `sem_cliente`, `sem_telefone`, `telefone_criptografado`, `telefone_invalido`, `telefone_central`). No Retorne, quem fica de fora não aparece em lugar nenhum e o volume baixo vira um sintoma mudo.
- **Telefone fixo é guardado, mas marcado.** O cliente continua identificado; campanhas de WhatsApp devem excluir `tipo_linha = 'fixo'`. Isso evita o erro 131026 da Meta, que no Retorne acontece porque o segmento não distingue fixo de celular.
- **Celular antigo sem o nono dígito é inválido, não corrigido.** Inserir o 9 pode mandar mensagem para outra pessoa.
- **Detecção de número de central.** O Open Delivery permite que o app mande o telefone da própria central no lugar do cliente. Se um telefone acumula mais de 5 primeiros nomes distintos na loja, o cliente vira `telefone_central` e sai das campanhas.
- **Pedidos de marketplace são descartados** (iFood, Keeta, 99Food, Rappi, aiqfome): não identificam o cliente. A Keeta manda o telefone criptografado com prefixo `ENC_`, e esse caso tem motivo próprio.
- **Conector Anota AI é só leitura.** Nunca chama aceite, cancelamento, pronto ou finalização.
- **Evento Open Delivery que falha não é confirmado** e volta no ciclo seguinte.
- **User-Agent identificado** em todas as chamadas, no formato que o Anota AI exige.

## Limites conhecidos

- **Anota AI só lista pedidos do dia.** Não há importação de histórico, e o ciclo precisa rodar ao longo do dia e uma vez perto da meia-noite. A pergunta sobre histórico foi enviada a integracao@anota.ai.
- **Saipos ainda não tem adaptador.** A Saipos Data API exige token pago por loja (R$ 59,90/mês) e o layout dos campos de venda precisa ser lido na documentação com acesso.
- **Cardápio Web** entra pela API Open Delivery. O webhook em tempo real da API Aberta fica para depois.
- **Repositório de produção** (PostgreSQL sobre `schema.sql`), agendador dos ciclos (sincronização e planejamento diário) e cofre de credenciais ainda não existem; os testes usam o repositório em memória.

## Configuração por fonte

**Delivery Direto (Open Delivery):** o lojista gera a credencial em Módulos › Administrar › Acessos para integração (serviço "Chaves de API", cobrado à parte pelo Delivery Direto).

```ts
await sincronizarOpenDelivery(
  { lojaId, baseUrl: '<URL Open Delivery do app>', clientId, clientSecret, merchantIds: ['<id da loja no app>'] },
  repositorio,
);
```

**Anota AI:** o parceiro pega `client_id` e `client_secret` no Portal de Integração (integracao.anota.ai). Depois que a loja é cadastrada no portal, o token exibido para ela traz o `idpage`.

```ts
await sincronizarAnotaAI(
  { lojaId, clientId, clientSecret, pageId: pageIdDoToken('<token da loja>') },
  repositorio,
);
```

## Fontes

- [Especificação Open Delivery v1.7.1](https://github.com/abrasel-nacional/opendelivery)
- [Delivery Direto — Open Delivery API](https://developers.deliverydireto.com.br/open-delivery-api/docs/)
- [Anota AI — API de Pedidos v2](https://integ-public-platform-docs.anota.ai/docs/integracao-parceiros/api-pedidos-v2)
- [Anota AI — autenticação OAuth](https://integ-public-platform-docs.anota.ai/docs/integracao-parceiros/oauth-api)
- [Anota AI — User-Agent](https://integ-public-platform-docs.anota.ai/docs/integracao-parceiros/secao-user-agent-obrigatoriedade)

## Configuração (.env.local)

1. O `.env.example` documenta todas as variáveis e vai para o Git. O `.env.local` guarda as suas credenciais e fica fora do Git (`.gitignore`).
2. Preencha o `.env.local` e rode `npm run env:check`. O comando mostra o que está configurado e aponta grupos preenchidos pela metade ou valores inválidos.
3. As integrações são opcionais por grupo. WhatsApp, Anota AI e Open Delivery só ligam com todas as suas variáveis preenchidas.
4. `src/config.ts` (`lerConfig`) transforma o ambiente nas configs que os conectores e o despachante recebem.

## Publicar no GitHub

```
gh repo create crm-delivery --private --source . --push
```
ou crie o repositório vazio no github.com e rode:
```
git remote add origin https://github.com/<seu-usuario>/crm-delivery.git
git push -u origin main
```
