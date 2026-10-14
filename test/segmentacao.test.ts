import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptarOpenDelivery } from '../src/adaptadores/opendelivery.ts';
import { ingerirPedido } from '../src/ingestao.ts';
import { RepositorioEmMemoria } from '../src/repositorio.ts';
import { calcularPerfis, faixaDeRecencia } from '../src/segmentacao/perfil.ts';
import { diasDePico } from '../src/segmentacao/pico.ts';
import { REGUA } from '../src/segmentacao/regua.ts';
import { avaliarSegmento, descreverSegmento, validarSegmento, type Segmento } from '../src/segmentacao/segmento.ts';
import { diaEHora } from '../src/segmentacao/tempo.ts';
import { pedidoOpenDelivery } from './fixtures.ts';

const AGORA = new Date('2026-10-13T15:00:00Z'); // terça, 12h em São Paulo
// 12h UTC (9h em São Paulo), antes da hora de AGORA: assim "d dias atrás" mede exatamente d dias.
const diasAtras = (d: number, horaUTC = 12) => {
  const t = new Date(AGORA.getTime() - d * 86_400_000);
  t.setUTCHours(horaUTC, 0, 0, 0);
  return t.toISOString();
};

/** Monta uma loja com clientes de históricos conhecidos, passando pela ingestão real. */
async function lojaDeExemplo() {
  const repo = new RepositorioEmMemoria();
  let seq = 0;
  const compra = async (tel: string, nome: string, dias: number, valor: number, item = 'Bolo de pote', extra = {}) => {
    const p = pedidoOpenDelivery({
      id: `p${++seq}`,
      createdAt: diasAtras(dias),
      total: { orderAmount: { value: valor, currency: 'BRL' } },
      items: [{ id: `i${seq}`, name: item, quantity: 1, totalPrice: { value: valor, currency: 'BRL' } }],
      customer: { name: nome, phone: { number: tel }, ...extra },
    });
    const r = await ingerirPedido(repo, adaptarOpenDelivery(p, 'loja-1', 'CONCLUDED'));
    assert.equal(r.status, 'importado');
  };

  await compra('21911110001', 'Nina', 1, 40);                       // novo, comprou ontem
  await compra('21911110002', 'Rui', 20, 50); await compra('21911110002', 'Rui', 7, 50);  // recorrente, D+7
  for (const d of [80, 60, 40, 20, 5]) await compra('21911110003', 'Fátima', d, 200, 'Torta'); // fiel de gasto alto
  for (const d of [70, 50, 30, 10]) await compra('21911110004', 'Gil', d, 30);                  // fiel de gasto baixo
  await compra('21911110005', 'Paula', 120, 80);                     // perdida
  await compra('2133334444', 'Bar do Zé', 30, 60, 'Brigadeiro');      // fixo, 30 dias
  await compra('21911110006', 'Lia', 4, 45, 'Brigadeiro', { email: 'lia@example.com' }); // D+4
  return repo;
}

test('faixas de recência seguem a escada 4/7/15/30/60/90', () => {
  assert.deepEqual([0, 4, 5, 7, 8, 15, 30, 31, 60, 90, 91].map(faixaDeRecencia),
    ['ate_4', 'ate_4', 'ate_7', 'ate_7', 'ate_15', 'ate_15', 'ate_30', 'ate_60', 'ate_60', 'ate_90', 'acima_90']);
});

test('pedido das 23h UTC conta como dia de São Paulo', () => {
  // 2026-10-13T01:00Z é segunda 22h em São Paulo, não terça.
  assert.deepEqual(diaEHora(new Date('2026-10-13T01:00:00Z')), { dia: 'seg', hora: 22 });
});

test('perfis e quadrantes saem do histórico concluído', async () => {
  const repo = await lojaDeExemplo();
  const perfis = calcularPerfis(await repo.listarClientes('loja-1'), await repo.listarPedidos('loja-1'), AGORA);
  const porNome = Object.fromEntries(perfis.map((p) => [[...repo.clientes.values()].find((c) => c.id === p.clienteId)!.nome, p]));

  assert.equal(porNome['Nina'].quadrante, 'novo');
  assert.equal(porNome['Rui'].quadrante, 'recorrente');
  assert.equal(porNome['Rui'].mediaDiasEntreCompras, 13);
  // Só 2 fiéis: não existe "os 20% de cima", então ninguém é campeão.
  assert.equal(porNome['Fátima'].quadrante, 'fiel');
  assert.equal(porNome['Gil'].quadrante, 'fiel');
  assert.equal(porNome['Paula'].quadrante, 'perdido');
  assert.equal(porNome['Fátima'].ticketMedioCentavos, 20000);
  assert.equal(porNome['Fátima'].produtoFavorito, 'torta');
  assert.equal(porNome['Bar do Zé'].tipoLinha, 'fixo');
});

test('pedido cancelado depois de importado sai do perfil', async () => {
  const repo = await lojaDeExemplo();
  const ped = [...repo.pedidos.values()].find((p) => p.idExterno === 'p1')!;
  await repo.atualizarStatusPedido('open_delivery', 'loja-1', 'p1', 'cancelado');
  const perfis = calcularPerfis(await repo.listarClientes('loja-1'), await repo.listarPedidos('loja-1'), AGORA);
  assert.ok(!perfis.some((p) => p.clienteId === ped.clienteId), 'Nina só tinha esse pedido');
});

test('dias de pico: dias acima da média, no fuso da loja', () => {
  const pedidos = [
    // 3 pedidos sexta 20h SP (23h UTC), 1 terça 12h SP
    ...['2026-10-09', '2026-10-02', '2026-09-25'].map((d, i) => ({ status: 'concluido', criadoEm: new Date(`${d}T23:00:00Z`), i })),
    { status: 'concluido', criadoEm: new Date('2026-10-06T15:00:00Z') },
    { status: 'cancelado', criadoEm: new Date('2026-10-07T15:00:00Z') },
  ] as never[];
  const r = diasDePico(pedidos, AGORA);
  assert.equal(r[0].dia, 'sex');
  assert.equal(r[0].pedidos, 3);
  assert.equal(r[0].participacao, 0.75);
  assert.deepEqual(r.filter((d) => d.pico).map((d) => d.dia), ['sex', 'ter']);
});

test('segmento com entre, OU e produto; travas do WhatsApp contam o motivo', async () => {
  const repo = await lojaDeExemplo();
  const perfis = calcularPerfis(await repo.listarClientes('loja-1'), await repo.listarPedidos('loja-1'), AGORA);
  const s: Segmento = {
    combinar: 'E',
    canal: 'whatsapp',
    conjuntos: [
      { tipo: 'E', condicoes: [{ campo: 'dias_desde_ultima_compra', operador: 'entre', valor: [4, 30] }] },
      { tipo: 'OU', condicoes: [
        { campo: 'produto_comprado', operador: 'contem', valor: 'Brigadeiro ' },
        { campo: 'ticket_medio', operador: 'maior_que', valor: 100 },
      ] },
    ],
  };
  const r = avaliarSegmento(perfis, s);
  // Bate na regra: Fátima (5 dias, ticket R$200), Bar do Zé (30 dias, brigadeiro), Lia (4 dias, brigadeiro).
  assert.equal(r.populacaoDaRegra, 3);
  assert.equal(r.clienteIds.length, 2);
  assert.deepEqual(r.excluidos, { telefone_fixo: 1 });
  assert.equal(
    descreverSegmento(s),
    'Dias desde a última compra entre 4 e 30 e (Produto comprado contém Brigadeiro ou Ticket médio maior que R$ 100,00) · WhatsApp',
  );
});

test('canal e-mail exclui quem não tem e-mail', async () => {
  const repo = await lojaDeExemplo();
  const perfis = calcularPerfis(await repo.listarClientes('loja-1'), await repo.listarPedidos('loja-1'), AGORA);
  const r = avaliarSegmento(perfis, { combinar: 'E', canal: 'email', conjuntos: [{ tipo: 'E', condicoes: [
    { campo: 'dias_desde_ultima_compra', operador: 'menor_que', valor: 10 },
  ] }] });
  assert.equal(r.clienteIds.length, 1); // só Lia tem e-mail
  assert.equal(r.excluidos.sem_email, 3);
});

test('régua da Maná: cada gatilho pega exatamente quem completa o intervalo hoje', async () => {
  const repo = await lojaDeExemplo();
  const perfis = calcularPerfis(await repo.listarClientes('loja-1'), await repo.listarPedidos('loja-1'), AGORA);
  const contar = (k: keyof typeof REGUA) => avaliarSegmento(perfis, REGUA[k].segmento);
  assert.equal(contar('d1_avaliacao').clienteIds.length, 1);        // Nina
  assert.equal(contar('d4_pos_primeira').clienteIds.length, 1);     // Lia
  assert.equal(contar('d7_terceira_compra').clienteIds.length, 1);  // Rui
  assert.deepEqual(contar('clientes_30d').excluidos, { telefone_fixo: 1 }); // Bar do Zé é fixo
  assert.equal(contar('clientes_90d').populacaoDaRegra, 0);
});

test('validação aponta os erros em português', () => {
  const erros = validarSegmento({ combinar: 'E', conjuntos: [
    { tipo: 'E', condicoes: [
      { campo: 'numero_compras', operador: 'contem', valor: 2 },
      { campo: 'total_gasto', operador: 'entre', valor: [100, 50] },
      { campo: 'quadrante', operador: 'igual', valor: 'vip' },
    ] },
    { tipo: 'OU', condicoes: [] },
  ] });
  assert.deepEqual(erros, [
    'Conjunto 1: "Número de compras" não aceita "contém".',
    'Conjunto 1: em "Total gasto entre", o mínimo (100) é maior que o máximo (50).',
    'Conjunto 1: valor "vip" não existe em "Quadrante".',
    'Conjunto 2: sem condições.',
  ]);
  assert.throws(() => avaliarSegmento([], { combinar: 'E', conjuntos: [] }), /Segmento inválido/);
});

test('campeão: o fiel ativo nos 20% de maior gasto, quando a base de fiéis permite', async () => {
  const repo = new RepositorioEmMemoria();
  let n = 0;
  for (const [tel, valor] of [['21911120001', 500], ['21911120002', 100], ['21911120003', 90], ['21911120004', 80], ['21911120005', 70]] as const) {
    for (const d of [40, 30, 20, 10]) {
      const p = pedidoOpenDelivery({
        id: `ch${++n}`, createdAt: diasAtras(d), total: { orderAmount: { value: valor, currency: 'BRL' } }, items: [],
        customer: { name: `Fiel${tel.slice(-1)}`, phone: { number: tel } },
      });
      await ingerirPedido(repo, adaptarOpenDelivery(p, 'loja-1', 'CONCLUDED'));
    }
  }
  const perfis = calcularPerfis(await repo.listarClientes('loja-1'), await repo.listarPedidos('loja-1'), AGORA);
  const campeoes = perfis.filter((p) => p.quadrante === 'campeao');
  assert.equal(campeoes.length, 1); // 20% de 5 fiéis
  assert.equal(campeoes[0].totalGastoCentavos, 200000);
});

test('D+1 é dia de calendário no fuso da loja, a qualquer hora que o planejador rode', async () => {
  const repo = new RepositorioEmMemoria();
  // Pedido de segunda 20h em São Paulo (23h UTC).
  const p = pedidoOpenDelivery({ id: 'cal1', createdAt: '2026-10-12T23:00:00Z', customer: { name: 'Bia', phone: { number: '21911130001' } } });
  await ingerirPedido(repo, adaptarOpenDelivery(p, 'loja-1', 'CONCLUDED'));
  const clientes = await repo.listarClientes('loja-1'), pedidos = await repo.listarPedidos('loja-1');
  // Terça 06h e terça 23h em São Paulo: os dois são D+1.
  for (const agora of ['2026-10-13T09:00:00Z', '2026-10-14T02:00:00Z']) {
    assert.equal(calcularPerfis(clientes, pedidos, new Date(agora))[0].diasDesdeUltimaCompra, 1, agora);
  }
  // Segunda 23h50 em São Paulo: ainda D+0.
  assert.equal(calcularPerfis(clientes, pedidos, new Date('2026-10-13T02:50:00Z'))[0].diasDesdeUltimaCompra, 0);
});

test('dias de pico não são enviesados por quantas vezes cada dia cai na janela', () => {
  // Exatamente 1 pedido por dia nos 90 dias anteriores a hoje: nenhum dia é pico.
  const pedidos = Array.from({ length: 90 }, (_, i) => ({
    status: 'concluido', criadoEm: new Date(Date.parse('2026-10-12T15:00:00Z') - i * 86_400_000),
  })) as never[];
  const r = diasDePico(pedidos, AGORA);
  assert.deepEqual(r.filter((d) => d.pico), []);
  assert.deepEqual(new Set(r.map((d) => d.mediaPorDia)), new Set([1]));
});
