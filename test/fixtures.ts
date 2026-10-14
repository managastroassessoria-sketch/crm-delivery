import type { PedidoAnotaAI } from '../src/adaptadores/anotaai.ts';
import type { PedidoOpenDelivery } from '../src/adaptadores/opendelivery.ts';

/** Exemplo literal de GET /ping/get/{order_Id} da documentação do Anota AI (campo info). */
export const anotaAIExemploOficial: PedidoAnotaAI = {
  _id: '66b6258e890ffb00126c4233',
  check: 1,
  createdAt: '2024-08-09T14:19:58.182Z',
  customer: { id: '66633c661b756b00127118e4', name: 'Teste', phone: '43123456789' },
  from: 'menu-share-adm',
  id: '66b6258e890ffb00126c4233',
  items: [{ _id: '66b6259876994faecbf911c2', name: 'Refrigerante 1L', quantity: 1, price: 10, total: 10 }],
  salesChannel: 'anotaai',
  total: 10,
  type: 'LOCAL',
};

/** Pedido no formato Order da especificação Open Delivery v1.7.1, só com campos usados pelo CRM. */
export function pedidoOpenDelivery(sobrescrever: Partial<PedidoOpenDelivery> = {}): PedidoOpenDelivery {
  return {
    id: 'od-1001',
    displayId: '1001',
    type: 'DELIVERY',
    createdAt: '2026-10-10T22:15:00Z',
    salesChannel: 'deliverydireto',
    merchant: { id: 'merchant-1', name: 'Vila do Amor' },
    items: [
      { id: 'i1', name: 'Bolo de pote', externalCode: 'BP01', quantity: 2, totalPrice: { value: 31.8, currency: 'BRL' } },
      { id: 'i2', name: 'Brigadeiro', externalCode: 'BR01', quantity: 6, totalPrice: { value: 18.0, currency: 'BRL' } },
    ],
    total: { orderAmount: { value: 57.3, currency: 'BRL' } },
    customer: {
      id: 'c-77',
      name: 'Maria Souza',
      email: 'maria@example.com',
      phone: { number: '(21) 98765-4321' },
    },
    ...sobrescrever,
  };
}
