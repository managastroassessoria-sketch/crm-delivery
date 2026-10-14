// Modelo normalizado da camada 1. Toda fonte de pedido é convertida para estes tipos
// antes de tocar no banco, para que segmentação, campanha e atribuição nunca precisem
// saber de onde o pedido veio.

export type Fonte = 'open_delivery' | 'anota_ai';

export type TipoLinha = 'celular' | 'fixo' | 'invalido';

export interface Telefone {
  original: string;
  /** +55DDNNNNNNNNN, ou null quando o número não é utilizável. */
  e164: string | null;
  tipo: TipoLinha;
}

export type StatusPedido = 'concluido' | 'cancelado' | 'em_andamento';

export interface ItemPedido {
  nome: string;
  quantidade: number;
  totalCentavos: number;
  codigo?: string;
}

export interface ClienteNoPedido {
  idExterno?: string;
  nome?: string;
  /** Telefone como veio da fonte; a normalização acontece na ingestão. */
  telefone?: string;
  email?: string;
  documento?: string;
}

export interface PedidoNormalizado {
  fonte: Fonte;
  lojaId: string;
  idExterno: string;
  criadoEm: Date;
  status: StatusPedido;
  /** Valor final do pedido em centavos (itens + taxas - descontos). */
  totalCentavos: number;
  /** Canal informado pela fonte (ex.: "anotaai", "ifood"). */
  canalVenda?: string;
  /** Verdadeiro quando o pedido veio de marketplace e não identifica o cliente. */
  marketplace: boolean;
  cliente: ClienteNoPedido | null;
  itens: ItemPedido[];
}

/**
 * Por que um pedido não virou histórico de cliente. Registrar o motivo é o que
 * evita o "sintoma mudo" do original: volume baixo sem nenhum erro visível.
 */
export type MotivoDescarte =
  | 'cancelado'
  | 'duplicado'
  | 'marketplace'
  | 'sem_cliente'
  | 'sem_telefone'
  | 'telefone_criptografado'
  | 'telefone_invalido'
  | 'telefone_central';

export type StatusCliente = 'ativo' | 'telefone_central';

export interface Cliente {
  id: string;
  lojaId: string;
  telefoneE164: string;
  tipoLinha: Exclude<TipoLinha, 'invalido'>;
  nome?: string;
  email?: string;
  documento?: string;
  status: StatusCliente;
  /** Nomes distintos já vistos com este telefone; base da detecção de central. */
  nomesVistos: Set<string>;
  criadoEm: Date;
  /** Pediu para não receber mais (palavra-chave ou erro 131050 da Meta). Vale para todos os canais. */
  descadastradoEm?: Date;
  /** A Meta informou que o número não recebe WhatsApp (erro 131026). */
  semWhatsappEm?: Date;
}

export type ResultadoIngestao =
  | { status: 'importado'; clienteId: string; clienteNovo: boolean }
  | { status: 'aguardando' }
  | { status: 'atualizado'; novoStatus: StatusPedido }
  | { status: 'descartado'; motivo: MotivoDescarte };

/** Converte um valor decimal (até 4 casas, como no Open Delivery) para centavos. */
export function paraCentavos(valor: number | string | undefined | null): number {
  const n = typeof valor === 'string' ? Number(valor) : (valor ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
