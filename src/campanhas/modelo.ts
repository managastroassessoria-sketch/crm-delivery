import type { Canal, MotivoExclusao, Segmento } from '../segmentacao/segmento.ts';
import type { DiaSemana } from '../segmentacao/tempo.ts';

/**
 * Três modos, dois caminhos de execução (como no original):
 * - gatilho e contínuo avaliam a base cliente a cliente, todo dia, no horário da campanha;
 * - massa congela uma lista na criação e a dispara em ondas agendadas.
 */
export type TipoCampanha = 'gatilho' | 'continuo' | 'massa';

export interface Onda {
  /** Instante do disparo (UTC). */
  em: Date;
  quantidade: number;
}

export interface Campanha {
  id: string;
  lojaId: string;
  nome: string;
  tipo: TipoCampanha;
  canal: Canal;
  /** Template aprovado no canal (ex.: criativo homologado pela Meta). */
  criativoId: string;
  /** 1 é a mais alta. Num mesmo dia, o cliente recebe da campanha de maior prioridade. */
  prioridade: number;
  publicada: boolean;
  inicioEm: Date;

  // Gatilho e contínuo
  /** Hora exata do disparo, "HH:MM" no fuso da loja. Não é janela. */
  hora?: string;
  /**
   * Dias em que a campanha pode disparar. "pico" é o padrão da operação: só nos
   * dias de pico da loja, medidos pela camada 2.
   */
  dias?: 'pico' | 'todos' | DiaSemana[];
  /** Regra de entrada, avaliada no dia do disparo. */
  segmento?: Segmento;

  // Massa
  /** Lista congelada na criação, na ordem em que será fatiada pelas ondas. */
  populacaoCongelada?: string[];
  ondas?: Onda[];

  /** Quem está neste segmento nunca recebe esta campanha. */
  segmentoExclusao?: Segmento;
  /** Uma mensagem por cliente, para sempre. */
  enviarApenasUmaVez: boolean;
  /** Falso (padrão do original): quem recebe fica hibernando e outras campanhas o pulam. */
  naoHibernar: boolean;
  /** Falso: esta campanha pula quem outra campanha hibernou. */
  enviarParaHibernando: boolean;
  /** Exclui os envios desta campanha da atribuição de receita (ex.: mensagens transacionais). */
  naoContabilizarReceita: boolean;
  /**
   * Fração da população elegível que NÃO recebe, sorteada de forma fixa por cliente
   * (ex.: 0.1 = 10%). Comparar a compra desse grupo com a de quem recebeu mede o
   * efeito real da campanha. Sem controle, a receita atribuída mostra correlação.
   */
  grupoControle?: number;
}

/** Cliente sorteado para o grupo de controle num dia em que receberia a campanha. */
export interface ControleRegistrado {
  campanhaId: string;
  clienteId: string;
  /** Horário em que teria recebido. */
  em: Date;
  /**
   * O controle hiberna como se tivesse recebido. Sem isso, ele ficaria livre para
   * campanhas de prioridade menor que bloqueiam quem recebeu, e os grupos deixariam
   * de ser comparáveis.
   */
  hiberna: boolean;
}

export interface EnvioPlanejado {
  lojaId: string;
  campanhaId: string;
  clienteId: string;
  canal: Canal;
  criativoId: string;
  planejadoPara: Date;
  contabilizaReceita: boolean;
  /** A campanha hiberna quem recebe (não marcou "não hibernar"). */
  hiberna: boolean;
  /** Índice da onda, em disparo em massa. */
  onda?: number;
}

/**
 * Envio já registrado (de hoje ou de dias anteriores). É a ÚNICA fonte de hibernação,
 * de "enviar uma vez" e do limite diário — assim, cancelar um envio libera o cliente.
 */
export interface EnvioRegistrado {
  campanhaId: string;
  clienteId: string;
  planejadoPara: Date;
  /** Sem status = planejado. Cancelado e falhou não contam como recebido nem hibernam. */
  status?: 'planejado' | 'enviado' | 'entregue' | 'lido' | 'falhou' | 'cancelado';
  hiberna?: boolean;
}

/**
 * Por que um cliente da população da campanha não recebeu. É o que o original não
 * mostra: na Auditoria do Retorne só aparecem envios, e 83% de uma base travada por
 * hibernação pareceu "volume baixo".
 */
export type MotivoNaoEnvio =
  | MotivoExclusao
  | 'segmento_de_exclusao'
  | 'ja_recebeu'
  | 'hibernando'
  | 'outra_campanha_no_dia'
  | 'cliente_indisponivel'
  | 'grupo_controle';

export type SituacaoCampanha = 'executada' | 'inativa' | 'invalida' | 'nao_iniciada' | 'fora_do_dia' | 'sem_onda_hoje';

export interface RelatorioCampanha {
  campanhaId: string;
  nome: string;
  situacao: SituacaoCampanha;
  /** Preenchido quando a situação é "invalida". */
  erros?: string[];
  /** Clientes que bateram na regra (ou da onda do dia, em massa). */
  populacao: number;
  planejados: number;
  naoEnviados: Partial<Record<MotivoNaoEnvio, number>>;
}

export interface ConfigLoja {
  fuso: string;
  /** Dias de carência depois de receber de uma campanha que hiberna. PROVISÓRIO: calibrar por loja. */
  diasHibernacao: number;
  /** Mensagens por cliente por dia, somando todas as campanhas. */
  maxMensagensPorClienteDia: number;
}

export const CONFIG_LOJA_PADRAO: ConfigLoja = {
  fuso: 'America/Sao_Paulo',
  diasHibernacao: 3,
  maxMensagensPorClienteDia: 1,
};
