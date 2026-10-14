import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticarHibernacao } from '../src/campanhas/diagnostico.ts';
import { podeEditarMassa, validarDisparoEmMassa } from '../src/campanhas/massa.ts';
import type { Campanha, EnvioRegistrado } from '../src/campanhas/modelo.ts';
import { planejarDia, type ContextoDia } from '../src/campanhas/planejador.ts';
import type { PerfilCliente } from '../src/segmentacao/perfil.ts';
import { REGUA } from '../src/segmentacao/regua.ts';
import type { Segmento } from '../src/segmentacao/segmento.ts';
import { dataLocal, horarioLocalParaUTC } from '../src/segmentacao/tempo.ts';

const SEXTA = new Date('2026-10-16T13:00:00Z'); // sexta, 10h em São Paulo
const DIA = 86_400_000;

function perfil(id: string, o: Partial<PerfilCliente> = {}): PerfilCliente {
  return {
    clienteId: id, lojaId: 'loja-1', status: 'ativo', tipoLinha: 'celular', temEmail: false,
    descadastrado: false, semWhatsapp: false,
    numeroCompras: 1, totalGastoCentavos: 5000, ticketMedioCentavos: 5000,
    primeiraCompraEm: new Date('2026-09-16T12:00:00Z'), ultimaCompraEm: new Date('2026-09-16T12:00:00Z'),
    diasDesdeUltimaCompra: 30, diasDesdePrimeiraCompra: 30, mediaDiasEntreCompras: null, comprasPorMes: 1,
    diaPreferido: 'sex', periodoPreferido: 'noite', produtoFavorito: 'bolo', produtosComprados: ['bolo'],
    quadrante: 'novo', faixaRecencia: 'ate_30', ...o,
  };
}

const regra = (condicoes: Segmento['conjuntos'][number]['condicoes']): Segmento =>
  ({ combinar: 'E', conjuntos: [{ tipo: 'E', condicoes }] });
const DIAS_30 = regra([{ campo: 'dias_desde_ultima_compra', operador: 'igual', valor: 30 }]);
const UMA_COMPRA = regra([{ campo: 'numero_compras', operador: 'igual', valor: 1 }]);

function campanha(id: string, o: Partial<Campanha> = {}): Campanha {
  return {
    id, lojaId: 'loja-1', nome: id, tipo: 'gatilho', canal: 'whatsapp', criativoId: `tpl-${id}`,
    prioridade: 5, publicada: true, inicioEm: new Date('2026-01-01T00:00:00Z'),
    hora: '19:00', dias: 'todos', segmento: DIAS_30,
    enviarApenasUmaVez: false, naoHibernar: false, enviarParaHibernando: false, naoContabilizarReceita: false,
    ...o,
  };
}

function ctx(o: Partial<ContextoDia>): ContextoDia {
  return { lojaId: 'loja-1', agora: SEXTA, perfis: [], campanhas: [], enviosAnteriores: [], diasPico: ['sex', 'sab'], ...o };
}

const registrados = (envios: ReturnType<typeof planejarDia>['envios'], status: EnvioRegistrado['status'] = 'planejado'): EnvioRegistrado[] =>
  envios.map(({ campanhaId, clienteId, planejadoPara, hiberna }) => ({ campanhaId, clienteId, planejadoPara, hiberna, status }));

test('fuso: horário local vira UTC, inclusive com horário de verão', () => {
  assert.equal(horarioLocalParaUTC('2026-10-17', '19:00').toISOString(), '2026-10-17T22:00:00.000Z');
  assert.equal(dataLocal(new Date('2026-10-14T01:30:00Z')), '2026-10-13');
  assert.equal(horarioLocalParaUTC('2026-01-15', '19:00', 'America/New_York').toISOString(), '2026-01-16T00:00:00.000Z');
  assert.equal(horarioLocalParaUTC('2026-07-15', '19:00', 'America/New_York').toISOString(), '2026-07-15T23:00:00.000Z');
});

test('planeja no horário exato e conta quem a trava do canal tirou', () => {
  const plano = planejarDia(ctx({
    perfis: [perfil('a'), perfil('b', { tipoLinha: 'fixo' }), perfil('c', { diasDesdeUltimaCompra: 10 })],
    campanhas: [campanha('trinta-dias')],
  }));
  assert.equal(plano.data, '2026-10-16');
  assert.deepEqual(plano.envios.map((e) => [e.clienteId, e.planejadoPara.toISOString(), e.criativoId]),
    [['a', '2026-10-16T22:00:00.000Z', 'tpl-trinta-dias']]);
  assert.deepEqual(plano.relatorio[0], {
    campanhaId: 'trinta-dias', nome: 'trinta-dias', situacao: 'executada', populacao: 2, planejados: 1, naoEnviados: { telefone_fixo: 1 },
  });
});

test('padrão "pico": só dispara nos dias de pico da loja', () => {
  const perfis = [perfil('a')];
  const fora = planejarDia(ctx({ perfis, campanhas: [campanha('x', { dias: 'pico' })], diasPico: ['sab', 'dom'] }));
  assert.equal(fora.relatorio[0].situacao, 'fora_do_dia');
  assert.equal(fora.envios.length, 0);
  const dentro = planejarDia(ctx({ perfis, campanhas: [campanha('x', { dias: undefined })], diasPico: ['sex'] }));
  assert.equal(dentro.relatorio[0].situacao, 'executada');
  assert.equal(dentro.envios.length, 1);
});

test('inativa, ainda não iniciada e inválida não disparam', () => {
  const plano = planejarDia(ctx({
    perfis: [perfil('a')],
    campanhas: [
      campanha('a-inativa', { publicada: false }),
      campanha('b-futura', { inicioEm: new Date('2026-10-17T00:00:00Z') }),
      campanha('c-hora-errada', { hora: '25:00' }),
    ],
  }));
  assert.deepEqual(plano.relatorio.map((r) => r.situacao), ['inativa', 'nao_iniciada', 'invalida']);
  assert.deepEqual(plano.relatorio[2].erros, ['Hora do disparo ausente ou fora do formato HH:MM.']);
  assert.equal(plano.envios.length, 0);
});

test('prioridade e limite diário: o cliente recebe só da campanha mais importante', () => {
  const perfis = [perfil('a')];
  const campanhas = [
    campanha('segunda', { prioridade: 2, naoHibernar: true }),
    campanha('primeira', { prioridade: 1, naoHibernar: true }),
  ];
  const plano = planejarDia(ctx({ perfis, campanhas }));
  assert.deepEqual(plano.envios.map((e) => e.campanhaId), ['primeira']);
  assert.deepEqual(plano.relatorio.find((r) => r.campanhaId === 'segunda')!.naoEnviados, { outra_campanha_no_dia: 1 });

  const comLimite2 = planejarDia(ctx({ perfis, campanhas, config: { maxMensagensPorClienteDia: 2 } }));
  assert.equal(comLimite2.envios.length, 2);
});

test('o cenário dos 83%: hibernação aparece no relatório em vez de virar "volume baixo"', () => {
  const perfis = Array.from({ length: 12 }, (_, i) => perfil(`c${i}`, { diasDesdeUltimaCompra: i < 10 ? 30 : 45 }));

  // Dia 1: uma campanha que hiberna atinge 10 dos 12.
  const dia1 = planejarDia(ctx({ perfis, campanhas: [campanha('recuperacao')] }));
  assert.equal(dia1.envios.length, 10);

  // Dia 2: outra campanha mira os 12, mas pula quem está hibernando.
  const dia2 = planejarDia(ctx({
    agora: new Date(SEXTA.getTime() + DIA),
    perfis,
    campanhas: [campanha('primeira-compra', { segmento: UMA_COMPRA })],
    enviosAnteriores: registrados(dia1.envios),
  }));
  assert.deepEqual(dia2.relatorio[0], {
    campanhaId: 'primeira-compra', nome: 'primeira-compra', situacao: 'executada',
    populacao: 12, planejados: 2, naoEnviados: { hibernando: 10 },
  });

  // Com "enviar para clientes hibernando", alcança todos.
  const dia2b = planejarDia(ctx({
    agora: new Date(SEXTA.getTime() + DIA), perfis,
    campanhas: [campanha('primeira-compra', { segmento: UMA_COMPRA, enviarParaHibernando: true })],
    enviosAnteriores: registrados(dia1.envios),
  }));
  assert.equal(dia2b.envios.length, 12);
});

test('hibernação termina depois da carência configurada', () => {
  const perfis = [perfil('a')];
  const dia1 = planejarDia(ctx({ perfis, campanhas: [campanha('x', { segmento: UMA_COMPRA })], config: { diasHibernacao: 3 } }));
  const em = (dias: number) => planejarDia(ctx({
    agora: new Date(SEXTA.getTime() + dias * DIA), perfis,
    campanhas: [campanha('y', { segmento: UMA_COMPRA })],
    enviosAnteriores: registrados(dia1.envios), config: { diasHibernacao: 3 },
  }));
  assert.deepEqual(em(2).relatorio[0].naoEnviados, { hibernando: 1 });
  assert.equal(em(3).envios.length, 1); // mesma hora, 3 dias depois: carência acabou
});

test('enviar apenas uma vez, segmento de exclusão e receita', () => {
  const contínua = campanha('continua', {
    tipo: 'continuo', naoHibernar: true, enviarApenasUmaVez: true, naoContabilizarReceita: true,
    segmento: regra([{ campo: 'dias_desde_ultima_compra', operador: 'entre', valor: [20, 60] }]),
    segmentoExclusao: regra([{ campo: 'quadrante', operador: 'igual', valor: 'campeao' }]),
  });
  const perfis = [perfil('a'), perfil('vip', { quadrante: 'campeao' })];
  const dia1 = planejarDia(ctx({ perfis, campanhas: [contínua] }));
  assert.deepEqual(dia1.envios.map((e) => [e.clienteId, e.contabilizaReceita]), [['a', false]]);
  assert.deepEqual(dia1.relatorio[0].naoEnviados, { segmento_de_exclusao: 1 });

  const dia2 = planejarDia(ctx({ agora: new Date(SEXTA.getTime() + DIA), perfis, campanhas: [contínua], enviosAnteriores: registrados(dia1.envios) }));
  assert.deepEqual(dia2.relatorio[0].naoEnviados, { segmento_de_exclusao: 1, ja_recebeu: 1 });
});

test('rodar o planejador duas vezes no mesmo dia não duplica envios', () => {
  const base = ctx({ perfis: [perfil('a'), perfil('b')], campanhas: [campanha('x')] });
  const primeira = planejarDia(base);
  const segunda = planejarDia({ ...base, enviosAnteriores: registrados(primeira.envios) });
  assert.equal(primeira.envios.length, 2);
  assert.equal(segunda.envios.length, 0);
  assert.deepEqual(segunda.relatorio[0].naoEnviados, {});
});

test('disparo em massa: ondas fatiam a população congelada no dia certo', () => {
  const massa = campanha('black-friday', {
    tipo: 'massa', hora: undefined, segmento: undefined, naoHibernar: true,
    populacaoCongelada: ['m1', 'm2', 'm3', 'm4', 'm5'],
    ondas: [
      { em: horarioLocalParaUTC('2026-10-16', '20:00'), quantidade: 3 },
      { em: horarioLocalParaUTC('2026-10-17', '20:00'), quantidade: 2 },
    ],
  });
  const perfis = ['m1', 'm3', 'm4', 'm5'].map((id) => perfil(id)).concat(perfil('m2', { tipoLinha: 'fixo' }));
  const hoje = planejarDia(ctx({ perfis, campanhas: [massa] }));
  assert.deepEqual(hoje.envios.map((e) => [e.clienteId, e.onda]), [['m1', 0], ['m3', 0]]);
  assert.deepEqual(hoje.relatorio[0].naoEnviados, { telefone_fixo: 1 });
  assert.equal(hoje.relatorio[0].populacao, 3);

  const amanha = planejarDia(ctx({ agora: new Date(SEXTA.getTime() + DIA), perfis, campanhas: [massa] }));
  assert.deepEqual(amanha.envios.map((e) => [e.clienteId, e.onda]), [['m4', 1], ['m5', 1]]);

  const depois = planejarDia(ctx({ agora: new Date(SEXTA.getTime() + 2 * DIA), perfis, campanhas: [massa] }));
  assert.equal(depois.relatorio[0].situacao, 'sem_onda_hoje');
});

test('validação de massa: soma, datas, pico e resumo legível', () => {
  const ondas = [
    { em: horarioLocalParaUTC('2026-10-17', '10:00'), quantidade: 150 },
    { em: horarioLocalParaUTC('2026-10-18', '10:00'), quantidade: 100 },
  ];
  const v = validarDisparoEmMassa({
    populacao: Array.from({ length: 487 }, (_, i) => `c${i}`), ondas, agora: SEXTA, diasPico: ['sex', 'sab'],
  });
  assert.deepEqual(v.erros, ['A soma das ondas (250) é diferente da população (487): faltam 237 cliente(s).']);
  assert.deepEqual(v.avisos, ['Onda 2 (dom 18/10/2026 10:00) cai fora dos dias de pico da loja (sex, sáb).']);
  assert.deepEqual(v.resumo, ['Onda 1 · sáb 17/10/2026 10:00 · 150 clientes', 'Onda 2 · dom 18/10/2026 10:00 · 100 clientes']);

  const datasRuins = validarDisparoEmMassa({
    populacao: ['a', 'b'],
    ondas: [{ em: new Date('2026-10-01T12:00:00Z'), quantidade: 1 }, { em: new Date('2026-09-30T12:00:00Z'), quantidade: 1 }],
    agora: SEXTA,
  });
  assert.deepEqual(datasRuins.erros, [
    'Onda 1: a data (qui 01/10/2026 09:00) já passou.',
    'Onda 2: a data (qua 30/09/2026 09:00) já passou.',
    'Onda 2: precisa ser depois da onda 1.',
  ]);
});

test('massa pode ser editada até a primeira onda sair', () => {
  const c = campanha('m', { tipo: 'massa', ondas: [{ em: horarioLocalParaUTC('2026-10-17', '10:00'), quantidade: 1 }] });
  assert.equal(podeEditarMassa(c, SEXTA), true);
  assert.equal(podeEditarMassa(c, new Date('2026-10-17T14:00:00Z')), false);
});

test('diagnóstico: a régua inteira hibernando bloqueia a própria régua', () => {
  const regua = Object.entries(REGUA).map(([id, r]) => campanha(id, { segmento: r.segmento }));
  const avisos = diagnosticarHibernacao(regua, 7);
  assert.equal(avisos.length, 3);
  assert.match(avisos[0], /^5 campanhas hibernam quem recebe e pulam quem está hibernando/);
  assert.ok(avisos.includes('«d1_avaliacao» (dia 1) hiberna por 7 dias e bloqueia «d4_pos_primeira» (dia 4): quem recebe a primeira ainda estará hibernando 3 dia(s) depois.'));
  assert.ok(avisos.includes('«d1_avaliacao» (dia 1) hiberna por 7 dias e bloqueia «d7_terceira_compra» (dia 7): quem recebe a primeira ainda estará hibernando 6 dia(s) depois.'));

  // D+1 sem hibernar resolve os bloqueios da régua.
  const corrigida = regua.map((c) => (c.id === 'd1_avaliacao' ? { ...c, naoHibernar: true } : c));
  assert.deepEqual(diagnosticarHibernacao(corrigida, 7).filter((a) => a.includes('bloqueia')), []);
});

test('descadastrado sai de qualquer canal; sem WhatsApp só do WhatsApp', () => {
  const perfis = [
    perfil('optout', { descadastrado: true, temEmail: true }),
    perfil('semzap', { semWhatsapp: true, temEmail: true }),
  ];
  const zap = planejarDia(ctx({ perfis, campanhas: [campanha('z')] }));
  assert.deepEqual(zap.relatorio[0].naoEnviados, { descadastrado: 1, sem_whatsapp: 1 });
  const email = planejarDia(ctx({ perfis, campanhas: [campanha('e', { canal: 'email' })] }));
  assert.deepEqual(email.envios.map((x) => x.clienteId), ['semzap']);
  assert.deepEqual(email.relatorio[0].naoEnviados, { descadastrado: 1 });
});

test('grupo de controle: sorteio fixo, comparável e sem duplicar ao replanejar', async () => {
  const { noGrupoControle } = await import('../src/campanhas/planejador.ts');
  const perfis = Array.from({ length: 200 }, (_, i) => perfil(`p${i}`));
  const c = campanha('teste-ab', { grupoControle: 0.5, naoHibernar: true });
  const plano = planejarDia(ctx({ perfis, campanhas: [c] }));

  assert.equal(plano.envios.length + plano.controles.length, 200);
  assert.ok(plano.controles.length > 70 && plano.controles.length < 130, `controle com ${plano.controles.length}`);
  assert.equal(plano.relatorio[0].naoEnviados.grupo_controle, plano.controles.length);
  assert.deepEqual(plano.controles.map((k) => noGrupoControle('teste-ab', k.clienteId, 0.5)), plano.controles.map(() => true));
  assert.deepEqual(planejarDia(ctx({ perfis, campanhas: [c] })).controles, plano.controles); // mesmo sorteio

  const replanejado = planejarDia(ctx({
    perfis, campanhas: [c], enviosAnteriores: registrados(plano.envios), controlesAnteriores: plano.controles,
  }));
  assert.equal(replanejado.envios.length + replanejado.controles.length, 0);

  const invalida = planejarDia(ctx({ perfis, campanhas: [campanha('x', { grupoControle: 0.8 })] }));
  assert.deepEqual(invalida.relatorio[0].erros, ['Grupo de controle precisa estar entre 0 e 0,5 (50%).']);
});

test('regressão: campanha das 20h não hiberna o cliente para outra das 10h do mesmo dia', () => {
  const perfis = [perfil('a')];
  const campanhas = [campanha('noite', { prioridade: 1, hora: '20:00' }), campanha('manha', { prioridade: 2, hora: '10:00' })];
  const um = planejarDia(ctx({ perfis, campanhas }));
  assert.deepEqual(um.relatorio.find((r) => r.campanhaId === 'manha')!.naoEnviados, { outra_campanha_no_dia: 1 });
  const dois = planejarDia(ctx({ perfis, campanhas, config: { maxMensagensPorClienteDia: 2 } }));
  assert.deepEqual(dois.envios.map((e) => e.campanhaId), ['manha', 'noite']);
});

test('regressão: o grupo de controle ocupa o limite do dia como quem recebe', async () => {
  const { noGrupoControle } = await import('../src/campanhas/planejador.ts');
  const perfis = Array.from({ length: 60 }, (_, i) => perfil(`k${i}`));
  const a = campanha('a', { prioridade: 1, grupoControle: 0.5 });
  const b = campanha('b', { prioridade: 2, naoHibernar: true, enviarParaHibernando: true });
  const plano = planejarDia(ctx({ perfis, campanhas: [a, b] }));
  // Ninguém do controle de A recebe B: B não alcança nenhum dos 60.
  assert.equal(plano.envios.filter((e) => e.campanhaId === 'b').length, 0);
  assert.ok(plano.controles.length > 0 && plano.controles.every((k) => noGrupoControle('a', k.clienteId, 0.5)));
  assert.ok(plano.controles.every((k) => k.hiberna));
});

test('regressão: envio cancelado não conta como recebido nem hiberna', () => {
  const perfis = [perfil('a')];
  const unica = campanha('unica', { tipo: 'continuo', enviarApenasUmaVez: true, segmento: UMA_COMPRA });
  const dia1 = planejarDia(ctx({ perfis, campanhas: [unica] }));
  const amanha = new Date(SEXTA.getTime() + DIA);

  const cancelado = planejarDia(ctx({ agora: amanha, perfis, campanhas: [unica, campanha('outra', { segmento: UMA_COMPRA, naoHibernar: true })], enviosAnteriores: registrados(dia1.envios, 'cancelado'), config: { maxMensagensPorClienteDia: 2 } }));
  assert.deepEqual(cancelado.envios.map((e) => e.campanhaId).sort(), ['outra', 'unica']);

  const entregue = planejarDia(ctx({ agora: amanha, perfis, campanhas: [unica, campanha('outra', { segmento: UMA_COMPRA, naoHibernar: true })], enviosAnteriores: registrados(dia1.envios, 'entregue'), config: { maxMensagensPorClienteDia: 2 } }));
  assert.deepEqual(entregue.relatorio.map((r) => [r.campanhaId, r.naoEnviados]), [['outra', { hibernando: 1 }], ['unica', { ja_recebeu: 1 }]]);
});
