import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptarAnotaAI } from '../src/adaptadores/anotaai.ts';
import { adaptarOpenDelivery } from '../src/adaptadores/opendelivery.ts';
import { chaveDeNome, ingerirPedido } from '../src/ingestao.ts';
import { RepositorioEmMemoria } from '../src/repositorio.ts';
import { anotaAIExemploOficial, pedidoOpenDelivery } from './fixtures.ts';

const concluido = (s: Parameters<typeof pedidoOpenDelivery>[0] = {}) =>
  adaptarOpenDelivery(pedidoOpenDelivery(s), 'loja-1', 'CONCLUDED');

test('pedido concluído com celular cria cliente e histórico', async () => {
  const repo = new RepositorioEmMemoria();
  const r = await ingerirPedido(repo, concluido());
  assert.equal(r.status, 'importado');
  assert.ok(r.status === 'importado' && r.clienteNovo);
  const cliente = [...repo.clientes.values()][0];
  assert.equal(cliente.telefoneE164, '+5521987654321');
  assert.equal(cliente.tipoLinha, 'celular');
  assert.equal(repo.pedidos.size, 1);
  assert.equal(repo.ultimaCompra.get('loja-1|open_delivery')?.toISOString(), '2026-10-10T22:15:00.000Z');
});

test('o mesmo pedido duas vezes não duplica', async () => {
  const repo = new RepositorioEmMemoria();
  await ingerirPedido(repo, concluido());
  assert.deepEqual(await ingerirPedido(repo, concluido()), { status: 'descartado', motivo: 'duplicado' });
  assert.equal(repo.pedidos.size, 1);
});

test('segundo pedido do mesmo telefone vai para o mesmo cliente', async () => {
  const repo = new RepositorioEmMemoria();
  const a = await ingerirPedido(repo, concluido());
  const b = await ingerirPedido(repo, concluido({ id: 'od-1002', customer: { name: 'Maria', phone: { number: '21987654321' } } }));
  if (a.status !== 'importado' || b.status !== 'importado') assert.fail('os dois pedidos deveriam ser importados');
  assert.equal(a.clienteId, b.clienteId);
  assert.equal(b.clienteNovo, false);
});

test('pedido em andamento aguarda; cancelado depois de importado é atualizado', async () => {
  const repo = new RepositorioEmMemoria();
  const andamento = adaptarOpenDelivery(pedidoOpenDelivery(), 'loja-1', 'PREPARING');
  assert.deepEqual(await ingerirPedido(repo, andamento), { status: 'aguardando' });
  assert.equal(repo.pedidos.size, 0);

  await ingerirPedido(repo, concluido());
  const cancelado = adaptarOpenDelivery(pedidoOpenDelivery(), 'loja-1', 'CANCELLED');
  assert.deepEqual(await ingerirPedido(repo, cancelado), { status: 'atualizado', novoStatus: 'cancelado' });
  assert.equal([...repo.pedidos.values()][0].status, 'cancelado');
});

test('cada motivo de descarte fica registrado', async () => {
  const repo = new RepositorioEmMemoria();
  const casos: Array<[Parameters<typeof pedidoOpenDelivery>[0], string, string]> = [
    [{ id: 'm1', salesChannel: 'ifood' }, 'CONCLUDED', 'marketplace'],
    [{ id: 'm2', customer: null }, 'CONCLUDED', 'sem_cliente'],
    [{ id: 'm3', customer: { name: 'Ana' } }, 'CONCLUDED', 'sem_telefone'],
    [{ id: 'm4', customer: { name: 'Ana', phone: { number: 'ENC_a8f3c1' } } }, 'CONCLUDED', 'telefone_criptografado'],
    [{ id: 'm5', customer: { name: 'Ana', phone: { number: '0800 123 4567' } } }, 'CONCLUDED', 'telefone_invalido'],
    [{ id: 'm6' }, 'CANCELLED', 'cancelado'],
  ];
  for (const [s, evento, motivo] of casos) {
    const r = await ingerirPedido(repo, adaptarOpenDelivery(pedidoOpenDelivery(s), 'loja-1', evento));
    assert.deepEqual(r, { status: 'descartado', motivo }, `${s?.id}`);
  }
  assert.deepEqual(repo.resumoDescartes('loja-1'), {
    marketplace: 1, sem_cliente: 1, sem_telefone: 1, telefone_criptografado: 1, telefone_invalido: 1, cancelado: 1,
  });
});

test('exemplo oficial do Anota AI finalizado é descartado pelo telefone fictício', async () => {
  const repo = new RepositorioEmMemoria();
  const p = adaptarAnotaAI({ ...anotaAIExemploOficial, check: 3 }, 'loja-1');
  assert.deepEqual(await ingerirPedido(repo, p), { status: 'descartado', motivo: 'telefone_invalido' });
});

test('telefone fixo identifica o cliente, marcado como fixo', async () => {
  const repo = new RepositorioEmMemoria();
  const r = await ingerirPedido(repo, concluido({ customer: { name: 'Bar do Zé', phone: { number: '2133334444' } } }));
  assert.equal(r.status, 'importado');
  assert.equal([...repo.clientes.values()][0].tipoLinha, 'fixo');
});

test('telefone com muitos nomes diferentes é tratado como central', async () => {
  const repo = new RepositorioEmMemoria();
  const central = '(11) 99999-0000';
  const nomes = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eva', 'Fábio', 'Gabi'];
  const resultados = [];
  for (const [i, nome] of nomes.entries()) {
    resultados.push(await ingerirPedido(repo, concluido({ id: `c${i}`, customer: { name: nome, phone: { number: central } } })));
  }
  assert.deepEqual(resultados.map((r) => r.status), ['importado', 'importado', 'importado', 'importado', 'importado', 'descartado', 'descartado']);
  assert.deepEqual(resultados.at(-1), { status: 'descartado', motivo: 'telefone_central' });
  assert.equal([...repo.clientes.values()][0].status, 'telefone_central');
});

test('variações do mesmo nome não disparam a detecção de central', async () => {
  assert.equal(chaveDeNome('Fábio Lima'), 'fabio');
  assert.equal(chaveDeNome('  fabio '), 'fabio');
  const repo = new RepositorioEmMemoria();
  for (const [i, nome] of ['Maria', 'maria souza', 'MARIA', 'Mária S.', 'maria', 'Maria'].entries()) {
    const r = await ingerirPedido(repo, concluido({ id: `v${i}`, customer: { name: nome, phone: { number: '21987654321' } } }));
    assert.equal(r.status, 'importado');
  }
});

test('regressão: o mesmo pedido descartado conta uma vez só', async () => {
  const repo = new RepositorioEmMemoria();
  const invalido = { customer: { name: 'Ana', phone: { number: '0800 123 4567' } } };
  for (const evento of ['DELIVERED', 'CONCLUDED']) {
    const r = await ingerirPedido(repo, adaptarOpenDelivery(pedidoOpenDelivery(invalido), 'loja-1', evento));
    assert.deepEqual(r, { status: 'descartado', motivo: 'telefone_invalido' });
  }
  assert.deepEqual(repo.resumoDescartes('loja-1'), { telefone_invalido: 1 });
});
