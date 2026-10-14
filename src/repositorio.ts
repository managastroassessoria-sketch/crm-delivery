import type { Cliente, Fonte, MotivoDescarte, PedidoNormalizado, StatusPedido } from './modelo.ts';

export interface PedidoSalvo extends PedidoNormalizado {
  clienteId: string;
}

export interface Descarte {
  lojaId: string;
  fonte: Fonte;
  idExterno: string;
  motivo: MotivoDescarte;
  em: Date;
}

/**
 * Contrato de persistência. A implementação em memória serve aos testes; a de
 * produção segue o mesmo contrato sobre o schema em `schema.sql`.
 */
export interface Repositorio {
  buscarPedido(fonte: Fonte, lojaId: string, idExterno: string): Promise<PedidoSalvo | undefined>;
  salvarPedido(pedido: PedidoNormalizado, clienteId: string): Promise<void>;
  atualizarStatusPedido(fonte: Fonte, lojaId: string, idExterno: string, status: StatusPedido): Promise<void>;
  buscarClientePorTelefone(lojaId: string, e164: string): Promise<Cliente | undefined>;
  salvarCliente(cliente: Cliente): Promise<void>;
  /** Registra um descarte. Um pedido tem no máximo um descarte: registrar de novo não duplica. */
  registrarDescarte(descarte: Descarte): Promise<void>;
  buscarDescarte(fonte: Fonte, lojaId: string, idExterno: string): Promise<Descarte | undefined>;
  /** Marca a data da compra mais recente recebida por uma integração (monitor de saúde). */
  registrarCompra(lojaId: string, fonte: Fonte, em: Date): Promise<void>;
  /** Base da segmentação. */
  listarClientes(lojaId: string): Promise<Cliente[]>;
  listarPedidos(lojaId: string): Promise<PedidoSalvo[]>;
}

const chavePedido = (fonte: Fonte, lojaId: string, id: string) => `${fonte}|${lojaId}|${id}`;
const chaveCliente = (lojaId: string, e164: string) => `${lojaId}|${e164}`;
const chaveIntegracao = (lojaId: string, fonte: Fonte) => `${lojaId}|${fonte}`;

export class RepositorioEmMemoria implements Repositorio {
  readonly pedidos = new Map<string, PedidoSalvo>();
  readonly clientes = new Map<string, Cliente>();
  readonly descartes = new Map<string, Descarte>();
  readonly ultimaCompra = new Map<string, Date>();

  async buscarPedido(fonte: Fonte, lojaId: string, idExterno: string) {
    return this.pedidos.get(chavePedido(fonte, lojaId, idExterno));
  }

  async salvarPedido(pedido: PedidoNormalizado, clienteId: string) {
    this.pedidos.set(chavePedido(pedido.fonte, pedido.lojaId, pedido.idExterno), { ...pedido, clienteId });
  }

  async atualizarStatusPedido(fonte: Fonte, lojaId: string, idExterno: string, status: StatusPedido) {
    const p = this.pedidos.get(chavePedido(fonte, lojaId, idExterno));
    if (p) p.status = status;
  }

  async buscarClientePorTelefone(lojaId: string, e164: string) {
    return this.clientes.get(chaveCliente(lojaId, e164));
  }

  async salvarCliente(cliente: Cliente) {
    this.clientes.set(chaveCliente(cliente.lojaId, cliente.telefoneE164), cliente);
  }

  async registrarDescarte(descarte: Descarte) {
    const k = chavePedido(descarte.fonte, descarte.lojaId, descarte.idExterno);
    if (!this.descartes.has(k)) this.descartes.set(k, descarte);
  }

  async buscarDescarte(fonte: Fonte, lojaId: string, idExterno: string) {
    return this.descartes.get(chavePedido(fonte, lojaId, idExterno));
  }

  async registrarCompra(lojaId: string, fonte: Fonte, em: Date) {
    const k = chaveIntegracao(lojaId, fonte);
    const atual = this.ultimaCompra.get(k);
    if (!atual || em > atual) this.ultimaCompra.set(k, em);
  }

  async listarClientes(lojaId: string) {
    return [...this.clientes.values()].filter((c) => c.lojaId === lojaId);
  }

  async listarPedidos(lojaId: string) {
    return [...this.pedidos.values()].filter((p) => p.lojaId === lojaId);
  }

  /** Quantos pedidos foram descartados por motivo — a resposta para "por que o volume está baixo". */
  resumoDescartes(lojaId: string): Partial<Record<MotivoDescarte, number>> {
    const r: Partial<Record<MotivoDescarte, number>> = {};
    for (const d of this.descartes.values()) if (d.lojaId === lojaId) r[d.motivo] = (r[d.motivo] ?? 0) + 1;
    return r;
  }
}
