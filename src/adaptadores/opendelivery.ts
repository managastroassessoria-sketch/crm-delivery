import { paraCentavos, type PedidoNormalizado, type StatusPedido } from '../modelo.ts';
import { ehMarketplace } from './marketplace.ts';

/**
 * Subconjunto do objeto Order da especificação Open Delivery v1.7.1 usado pelo CRM.
 * Atende Delivery Direto, Cardápio Web (API Open Delivery), Accon, Brendi e os
 * demais emissores do padrão.
 * https://github.com/abrasel-nacional/opendelivery
 */
interface Preco { value: number; currency: string }

export interface PedidoOpenDelivery {
  id: string;
  displayId?: string;
  type?: 'DELIVERY' | 'TAKEOUT' | 'INDOOR';
  createdAt: string;
  sourceAppId?: string;
  salesChannel?: string;
  lastEvent?: string;
  merchant?: { id: string; name?: string };
  items: Array<{ id: string; name: string; externalCode?: string; quantity: number; totalPrice: Preco }>;
  total: { orderAmount: Preco; itemsPrice?: Preco; otherFees?: Preco; discount?: Preco };
  customer?: {
    id?: string;
    name?: string;
    documentNumber?: string;
    email?: string;
    /** Pode ser o telefone real (com consentimento) ou o da central do app de pedido. */
    phone?: { number?: string; extension?: string };
    ordersCountOnMerchant?: number;
  } | null;
}

export type EventoOpenDelivery =
  | 'CREATED' | 'CONFIRMED' | 'PREPARATION_REQUESTED' | 'PREPARING' | 'DISPATCHED'
  | 'READY_FOR_PICKUP' | 'PICKUP_AREA_ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CONCLUDED'
  | 'CANCELLATION_REQUESTED' | 'CANCELLATION_REQUEST_DENIED' | 'CANCELLED'
  | 'ORDER_CANCELLATION_REQUEST' | 'CANCELLED_DENIED';

export function statusDoEvento(evento: string | undefined): StatusPedido {
  if (evento === 'CONCLUDED' || evento === 'DELIVERED') return 'concluido';
  if (evento === 'CANCELLED') return 'cancelado';
  return 'em_andamento';
}

/**
 * @param evento Tipo do evento que trouxe o pedido; se ausente, usa `lastEvent` do próprio pedido.
 */
export function adaptarOpenDelivery(
  pedido: PedidoOpenDelivery,
  lojaId: string,
  evento?: string,
): PedidoNormalizado {
  const c = pedido.customer;
  return {
    fonte: 'open_delivery',
    lojaId,
    idExterno: pedido.id,
    criadoEm: new Date(pedido.createdAt),
    status: statusDoEvento(evento ?? pedido.lastEvent),
    totalCentavos: paraCentavos(pedido.total?.orderAmount?.value),
    canalVenda: pedido.salesChannel ?? pedido.sourceAppId,
    marketplace: ehMarketplace(pedido.salesChannel, pedido.sourceAppId),
    cliente: c
      ? {
          idExterno: c.id,
          nome: c.name,
          telefone: c.phone?.number,
          email: c.email,
          documento: c.documentNumber,
        }
      : null,
    itens: (pedido.items ?? []).map((i) => ({
      nome: i.name,
      quantidade: i.quantity,
      totalCentavos: paraCentavos(i.totalPrice?.value),
      codigo: i.externalCode ?? i.id,
    })),
  };
}
