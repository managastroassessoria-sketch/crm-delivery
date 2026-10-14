import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atribuirPedidos, relatorioDeReceita, type EnvioParaAtribuicao } from '../src/atribuicao/atribuicao.ts';
import { faixaDeNovos, painelDaLoja } from '../src/atribuicao/painel.ts';
import type { Cliente } from '../src/modelo.ts';
import type { PedidoSalvo } from '../src/repositorio.ts';
import type { StatusEnvio } from '../src/envio/webhook.ts';

const OUTUBRO = { inicio: new Date('2026-10-01T03:00:00Z'), fim: new Date('2026-11-01T03:00:00Z') };
const PRECOS = { marketing: 35, utility: 8 }; // valores de teste, não a tabela da Meta

let seq = 0;
function pedido(clienteId: string, criadoEm: string, totalCentavos: number, status: PedidoSalvo['status'] = 'concluido'): PedidoSalvo {
  return {
    fonte: 'open_delivery', lojaId: 'loja-1', idExterno: `p${++seq}`, criadoEm: new Date(criadoEm), status, totalCentavos,
    clienteId, marketplace: false, cliente: null, itens: [],
  };
}
function envio(id: string, campanhaId: string, clienteId: string, em: string, status: StatusEnvio, o: Partial<EnvioParaAtribuicao> = {}): EnvioParaAtribuicao {
  return { id, campanhaId, clienteId, em: new Date(em), status, contabilizaReceita: true, ...o };
}
const cobrado = (categoria: string) => ({ categoria, tipoCobranca: 'regular' });

function cenario() {
  const pedidos = [
    pedido('x', '2026-06-01T15:00:00Z', 5000),
    pedido('x', '2026-10-11T15:00:00Z', 10000),
    pedido('x', '2026-10-12T15:00:00Z', 9999, 'cancelado'),
    pedido('y', '2026-10-11T15:00:00Z', 5000),
    pedido('z', '2026-09-01T15:00:00Z', 3000),
    pedido('z', '2026-09-20T15:00:00Z', 3000),
    pedido('z', '2026-10-09T15:00:00Z', 8000),
    pedido('w', '2026-10-13T15:00:00Z', 7000),
    pedido('v', '2026-10-06T15:00:00Z', 6000),
    pedido('u', '2026-10-01T04:00:00Z', 4000),
  ];
  const envios = [
    envio('e1', 'A', 'x', '2026-10-10T12:00:00Z', 'entregue', cobrado('marketing')),
    envio('e2', 'A', 'y', '2026-10-10T12:00:00Z', 'enviado'),
    envio('e3', 'B', 'z', '2026-10-05T12:00:00Z', 'lido', cobrado('marketing')),
    envio('e4', 'A', 'z', '2026-10-08T12:00:00Z', 'entregue', cobrado('marketing')),
    envio('e5', 'C', 'w', '2026-10-12T12:00:00Z', 'entregue', { ...cobrado('utility'), contabilizaReceita: false }),
    envio('e6', 'A', 'v', '2026-10-01T12:00:00Z', 'entregue', cobrado('marketing')),
    envio('e7', 'A', 'u', '2026-09-29T12:00:00Z', 'entregue', cobrado('marketing')),
  ];
  return { pedidos, envios };
}

test('atribuição: último toque entregue, dentro da janela, sem contar duas vezes', () => {
  const { pedidos, envios } = cenario();
  const r = atribuirPedidos(pedidos, envios, 3);
  const porCliente = Object.fromEntries([...r].map(([k, e]) => [pedidos.find((p) => k.endsWith(`|${p.idExterno}`))!.clienteId, e.id]));
  assert.deepEqual(porCliente, {
    x: 'e1', // comprou 27 h depois
    z: 'e4', // recebeu B e depois A: vale o mais recente
    u: 'e7', // envio de setembro influencia pedido de 1º de outubro
  });
  // y: só "enviado", sem entrega · w: campanha fora da receita · v: 5 dias depois, fora da janela
});

test('relatório: receita influenciada, recuperada, recorrente, custo e ROI', () => {
  const { pedidos, envios } = cenario();
  const r = relatorioDeReceita({ periodo: OUTUBRO, pedidos, envios, opcoes: { janelaDias: 3, diasParaRecuperado: 90, precoPorMensagemCentavos: PRECOS } });

  assert.equal(r.receitaTotalCentavos, 40000);           // cancelado fora
  assert.equal(r.receitaInfluenciadaCentavos, 22000);    // x 100 + z 80 + u 40
  assert.equal(r.participacao, 0.55);
  assert.equal(r.receitaRecuperadaCentavos, 10000);      // x estava sem comprar desde junho
  assert.equal(r.clientesRecuperados, 1);
  assert.equal(r.receitaRecorrenteInfluenciadaCentavos, 8000); // z já tinha 2 compras
  assert.equal(r.custoCentavos, 140);                    // 4 mensagens de marketing cobradas no período
  assert.equal(r.custoNaoContabilizadoCentavos, 8);      // a de utilidade, fora da receita
  assert.equal(r.roi, 157.1);
  assert.equal(r.mensagensEntregues, 4);
  assert.deepEqual(r.porCampanha.map((c) => [c.campanhaId, c.entregues, c.lidas, c.pedidosAtribuidos, c.receitaCentavos, c.custoCentavos, c.roi]), [
    ['A', 3, 0, 3, 22000, 105, 209.5],
    ['B', 1, 1, 0, 0, 35, 0],
    ['C', 1, 0, 0, 0, 8, 0],
  ]);
  assert.deepEqual(r.avisos, []);
});

test('janela maior muda o número — por isso ela é exposta', () => {
  const { pedidos, envios } = cenario();
  const r = relatorioDeReceita({ periodo: OUTUBRO, pedidos, envios, opcoes: { janelaDias: 7, diasParaRecuperado: 90, precoPorMensagemCentavos: PRECOS } });
  assert.equal(r.receitaInfluenciadaCentavos, 28000); // v (5 dias) entra
  assert.equal(r.janelaDias, 7);
});

test('categoria sem preço gera aviso em vez de custo inventado', () => {
  const { pedidos, envios } = cenario();
  const r = relatorioDeReceita({ periodo: OUTUBRO, pedidos, envios, opcoes: { janelaDias: 3, diasParaRecuperado: 90, precoPorMensagemCentavos: { marketing: 35 } } });
  assert.deepEqual(r.avisos, ['Sem preço configurado para: utility. Essas mensagens ficaram fora do custo.']);
});

test('grupo de controle mede o efeito real da campanha', () => {
  const pedidos: PedidoSalvo[] = [];
  const envios: EnvioParaAtribuicao[] = [];
  const controles = [];
  for (let i = 0; i < 40; i++) {
    envios.push(envio(`t${i}`, 'K', `t${i}`, '2026-10-10T12:00:00Z', 'entregue'));
    if (i < 10) pedidos.push(pedido(`t${i}`, '2026-10-11T12:00:00Z', 5000));
    controles.push({ campanhaId: 'K', clienteId: `c${i}`, em: new Date('2026-10-10T12:00:00Z'), hiberna: true });
    if (i < 4) pedidos.push(pedido(`c${i}`, '2026-10-11T12:00:00Z', 5000));
  }
  const r = relatorioDeReceita({ periodo: OUTUBRO, pedidos, envios, controles, opcoes: { janelaDias: 3, diasParaRecuperado: 90, precoPorMensagemCentavos: PRECOS } });
  const k = r.porCampanha.find((c) => c.campanhaId === 'K')!;
  // A atribuição simples daria R$ 500 à campanha; o controle mostra que R$ 200 disso viria de qualquer jeito.
  assert.equal(k.receitaCentavos, 50000);
  assert.deepEqual(k.controle, {
    tratados: 40, controle: 40, conversaoTratados: 0.25, conversaoControle: 0.1,
    liftPontos: 15, receitaIncrementalCentavos: 30000, amostraPequena: false,
  });

  const pequeno = relatorioDeReceita({
    periodo: OUTUBRO, pedidos, envios: envios.slice(0, 5), controles: controles.slice(0, 5),
    opcoes: { janelaDias: 3, diasParaRecuperado: 90, precoPorMensagemCentavos: PRECOS },
  });
  assert.equal(pequeno.porCampanha.find((c) => c.campanhaId === 'K')!.controle!.amostraPequena, true);
});

test('faixas de clientes novos da Maná', () => {
  assert.deepEqual([5, 10, 19.9, 20, 35, 37, 45, 55].map(faixaDeNovos),
    ['ruim', 'ok', 'ok', 'excelente', 'excelente', 'sem_referencia', 'nao_saudavel', 'ruim']);
});

test('painel: recompra, recorrência, novos e LTV pelas definições da Maná', () => {
  const pedidos = [
    pedido('a', '2026-10-10T15:00:00Z', 5000),
    pedido('b', '2026-09-01T15:00:00Z', 6000),
    pedido('b', '2026-10-15T15:00:00Z', 7000),
    pedido('c', '2026-10-05T15:00:00Z', 3000),
    pedido('c', '2026-10-20T15:00:00Z', 3000),
    pedido('d', '2026-10-21T15:00:00Z', 9000, 'cancelado'),
  ];
  const cliente = (id: string): Cliente => ({
    id, lojaId: 'loja-1', telefoneE164: '+5521900000000', tipoLinha: 'celular', status: 'ativo', nomesVistos: new Set(), criadoEm: new Date(),
  });
  const p = painelDaLoja({ periodo: OUTUBRO, pedidos, clientes: ['a', 'b', 'c', 'd'].map(cliente) });
  assert.deepEqual(
    { ...p, periodo: undefined },
    {
      periodo: undefined, pedidos: 4, clientesUnicos: 3, faturamentoCentavos: 18000, ticketMedioCentavos: 4500,
      clientesNovos: 2, participacaoNovos: 66.7, faixaNovos: 'ruim', recompra: 33.3, recorrencia: 1.33,
      ltvCentavos: 8068, baseIdentificada: 4, semCompras: 1,
    },
  );
});

test('regressão: controle comparado com todos os designados, não só os entregues', () => {
  const pedidos: PedidoSalvo[] = [];
  const envios: EnvioParaAtribuicao[] = [];
  const controles = [];
  for (let i = 0; i < 40; i++) {
    // Metade dos envios falhou; quem falhou não compra. Entre os entregues, 10 de 20 compram.
    envios.push(envio(`t${i}`, 'K', `t${i}`, '2026-10-10T12:00:00Z', i < 20 ? 'entregue' : 'falhou'));
    if (i < 10) pedidos.push(pedido(`t${i}`, '2026-10-11T12:00:00Z', 5000));
    controles.push({ campanhaId: 'K', clienteId: `c${i}`, em: new Date('2026-10-10T12:00:00Z'), hiberna: true });
    if (i < 4) pedidos.push(pedido(`c${i}`, '2026-10-11T12:00:00Z', 5000));
  }
  const r = relatorioDeReceita({ periodo: OUTUBRO, pedidos, envios, controles, opcoes: { janelaDias: 3, diasParaRecuperado: 90, precoPorMensagemCentavos: PRECOS } });
  const k = r.porCampanha.find((c) => c.campanhaId === 'K')!.controle!;
  // 10/40 = 25% (e não 10/20 = 50%) contra 4/40 = 10% no controle.
  assert.equal(k.tratados, 40);
  assert.equal(k.conversaoTratados, 0.25);
  assert.equal(k.liftPontos, 15);
});

test('regressão: recuperado usa o mesmo corte de perdido (mais de 90 dias de calendário)', () => {
  const pedidos = [pedido('r', '2026-07-12T15:00:00Z', 1000), pedido('r', '2026-10-11T15:00:00Z', 5000)];
  // Envio em 10/10: 90 dias de calendário depois de 12/07 — ainda não é perdido, então não é recuperado.
  const envios = [envio('e', 'A', 'r', '2026-10-10T15:00:00Z', 'entregue')];
  const r = relatorioDeReceita({ periodo: OUTUBRO, pedidos, envios, opcoes: { janelaDias: 3, diasParaRecuperado: 90, precoPorMensagemCentavos: PRECOS } });
  assert.equal(r.receitaInfluenciadaCentavos, 5000);
  assert.equal(r.receitaRecuperadaCentavos, 0);
});
