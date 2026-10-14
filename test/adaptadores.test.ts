import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptarAnotaAI } from '../src/adaptadores/anotaai.ts';
import { adaptarOpenDelivery, statusDoEvento } from '../src/adaptadores/opendelivery.ts';
import { anotaAIExemploOficial, pedidoOpenDelivery } from './fixtures.ts';

test('Anota AI: exemplo oficial é normalizado', () => {
  const p = adaptarAnotaAI(anotaAIExemploOficial, 'loja-1');
  assert.equal(p.fonte, 'anota_ai');
  assert.equal(p.idExterno, '66b6258e890ffb00126c4233');
  assert.equal(p.status, 'em_andamento'); // check 1 = em produção
  assert.equal(p.totalCentavos, 1000);
  assert.equal(p.marketplace, false);
  assert.deepEqual(p.cliente, { idExterno: '66633c661b756b00127118e4', nome: 'Teste', telefone: '43123456789' });
  assert.deepEqual(p.itens, [{ nome: 'Refrigerante 1L', quantidade: 1, totalCentavos: 1000, codigo: '66b6259876994faecbf911c2' }]);
  assert.equal(p.criadoEm.toISOString(), '2024-08-09T14:19:58.182Z');
});

test('Anota AI: check 3 é concluído, 4 e 6 cancelado', () => {
  assert.equal(adaptarAnotaAI({ ...anotaAIExemploOficial, check: 3 }, 'l').status, 'concluido');
  assert.equal(adaptarAnotaAI({ ...anotaAIExemploOficial, check: 4 }, 'l').status, 'cancelado');
  assert.equal(adaptarAnotaAI({ ...anotaAIExemploOficial, check: 6 }, 'l').status, 'cancelado');
});

test('Anota AI: pedido vindo do iFood é marcado como marketplace', () => {
  assert.equal(adaptarAnotaAI({ ...anotaAIExemploOficial, salesChannel: 'ifood' }, 'l').marketplace, true);
});

test('Open Delivery: pedido é normalizado em centavos, sem erro de ponto flutuante', () => {
  const p = adaptarOpenDelivery(pedidoOpenDelivery(), 'loja-1', 'CONCLUDED');
  assert.equal(p.status, 'concluido');
  assert.equal(p.totalCentavos, 5730);
  assert.deepEqual(p.itens.map((i) => i.totalCentavos), [3180, 1800]);
  assert.equal(p.cliente?.telefone, '(21) 98765-4321');
  assert.equal(p.cliente?.email, 'maria@example.com');
});

test('Open Delivery: status vem do evento ou do lastEvent', () => {
  assert.equal(statusDoEvento('DELIVERED'), 'concluido');
  assert.equal(statusDoEvento('CANCELLED'), 'cancelado');
  assert.equal(statusDoEvento('PREPARING'), 'em_andamento');
  assert.equal(adaptarOpenDelivery(pedidoOpenDelivery({ lastEvent: 'CONCLUDED' }), 'l').status, 'concluido');
});

test('Open Delivery: Keeta é marketplace pelo sourceAppId', () => {
  const p = adaptarOpenDelivery(pedidoOpenDelivery({ salesChannel: undefined, sourceAppId: 'keeta-br' }), 'l', 'CONCLUDED');
  assert.equal(p.marketplace, true);
});
