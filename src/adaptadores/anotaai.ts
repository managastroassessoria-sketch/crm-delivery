import { paraCentavos, type PedidoNormalizado, type StatusPedido } from '../modelo.ts';
import { ehMarketplace } from './marketplace.ts';

/**
 * Formato do detalhe de pedido da API de Pedidos v2 do Anota AI
 * (GET /ping/get/{order_Id}, campo `info`). A documentação avisa que o payload
 * varia conforme o contexto, então todo campo é tratado como opcional.
 * https://integ-public-platform-docs.anota.ai/docs/integracao-parceiros/api-pedidos-v2
 */
export interface PedidoAnotaAI {
  _id?: string;
  id?: string;
  check?: number;
  createdAt?: string;
  customer?: { id?: string; name?: string; phone?: string } | null;
  items?: Array<{ _id?: string; name?: string; quantity?: number; price?: number; total?: number }>;
  total?: number;
  salesChannel?: string;
  from?: string;
  type?: string;
}

/** check: 0 em análise · 1 em produção · 2 pronto · 3 finalizado · 4 cancelado (6 após cancelamento via API). */
function statusDoCheck(check: number | undefined): StatusPedido {
  if (check === 3) return 'concluido';
  if (check === 4 || check === 6) return 'cancelado';
  return 'em_andamento';
}

export function adaptarAnotaAI(pedido: PedidoAnotaAI, lojaId: string): PedidoNormalizado {
  const idExterno = pedido.id ?? pedido._id;
  if (!idExterno) throw new Error('Pedido Anota AI sem id');
  if (!pedido.createdAt) throw new Error(`Pedido Anota AI ${idExterno} sem createdAt`);

  const c = pedido.customer;
  return {
    fonte: 'anota_ai',
    lojaId,
    idExterno,
    criadoEm: new Date(pedido.createdAt),
    status: statusDoCheck(pedido.check),
    totalCentavos: paraCentavos(pedido.total),
    canalVenda: pedido.salesChannel,
    marketplace: ehMarketplace(pedido.salesChannel, pedido.from),
    cliente: c ? { idExterno: c.id, nome: c.name, telefone: c.phone } : null,
    itens: (pedido.items ?? []).map((i) => ({
      nome: i.name ?? '',
      quantidade: i.quantity ?? 1,
      totalCentavos: paraCentavos(i.total ?? (i.price ?? 0) * (i.quantity ?? 1)),
      codigo: i._id,
    })),
  };
}
