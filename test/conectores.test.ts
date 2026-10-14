import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sincronizarOpenDelivery } from '../src/conectores/opendelivery.ts';
import { pageIdDoToken, sincronizarAnotaAI } from '../src/conectores/anotaai.ts';
import { ProvedorDeToken, type Fetch } from '../src/conectores/http.ts';
import { RepositorioEmMemoria } from '../src/repositorio.ts';
import { anotaAIExemploOficial, pedidoOpenDelivery } from './fixtures.ts';

interface Chamada { metodo: string; url: string; headers: Record<string, string>; corpo?: string }

/** fetch falso: cada rota responde por uma função; registra todas as chamadas. */
function fetchFalso(rotas: Array<[RegExp, (c: Chamada) => Response]>) {
  const chamadas: Chamada[] = [];
  const f: Fetch = async (entrada, init) => {
    const c: Chamada = {
      metodo: init?.method ?? 'GET',
      url: String(entrada),
      headers: (init?.headers ?? {}) as Record<string, string>,
      corpo: init?.body ? String(init.body) : undefined,
    };
    chamadas.push(c);
    const rota = rotas.find(([re]) => re.test(c.url));
    if (!rota) throw new Error(`rota não simulada: ${c.metodo} ${c.url}`);
    return rota[1](c);
  };
  return { f, chamadas };
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

test('Open Delivery: polling, busca do pedido, ingestão e confirmação', async () => {
  const { f, chamadas } = fetchFalso([
    [/oauth\/token$/, () => json({ access_token: 'tok-1', expires_in: 3600 })],
    [/events:polling$/, () => json([
      { eventId: 'e1', eventType: 'CREATED', orderId: 'od-1001', createdAt: '2026-10-10T22:00:00Z' },
      { eventId: 'e2', eventType: 'CONCLUDED', orderId: 'od-1001', createdAt: '2026-10-10T23:00:00Z' },
    ])],
    [/\/v1\/orders\/od-1001$/, () => json(pedidoOpenDelivery())],
    [/events\/acknowledgment$/, () => new Response(null, { status: 202 })],
  ]);
  const repo = new RepositorioEmMemoria();
  const resumo = await sincronizarOpenDelivery(
    { lojaId: 'loja-1', baseUrl: 'https://dd.test', clientId: 'id', clientSecret: 's', merchantIds: ['m1'], fetch: f },
    repo,
  );

  assert.deepEqual(resumo, { eventos: 2, confirmados: 2, resultados: { importado: 1 }, erros: [] });
  assert.equal(repo.pedidos.size, 1);

  const polling = chamadas.find((c) => c.url.endsWith('events:polling'))!;
  assert.equal(polling.headers.Authorization, 'Bearer tok-1');
  assert.equal(polling.headers['x-polling-merchants'], 'm1');
  assert.match(polling.headers['User-Agent'], /^crm-ingestao\/0\.1\.0 \(.+; Node\.js\/\d/);

  const ack = chamadas.find((c) => c.url.endsWith('acknowledgment'))!;
  assert.deepEqual(JSON.parse(ack.corpo!), [
    { id: 'e1', orderId: 'od-1001', eventType: 'CREATED' },
    { id: 'e2', orderId: 'od-1001', eventType: 'CONCLUDED' },
  ]);
  // Um único token para o ciclo inteiro.
  assert.equal(chamadas.filter((c) => c.url.endsWith('oauth/token')).length, 1);
});

test('Open Delivery: 204 encerra o ciclo sem confirmar nada', async () => {
  const { f, chamadas } = fetchFalso([
    [/oauth\/token$/, () => json({ access_token: 't', expires_in: 3600 })],
    [/events:polling$/, () => new Response(null, { status: 204 })],
  ]);
  const resumo = await sincronizarOpenDelivery(
    { lojaId: 'l', baseUrl: 'https://dd.test', clientId: 'id', clientSecret: 's', fetch: f },
    new RepositorioEmMemoria(),
  );
  assert.equal(resumo.eventos, 0);
  assert.ok(!chamadas.some((c) => c.url.endsWith('acknowledgment')));
});

test('Open Delivery: evento com falha não é confirmado e volta no próximo ciclo', async () => {
  const { f, chamadas } = fetchFalso([
    [/oauth\/token$/, () => json({ access_token: 't', expires_in: 3600 })],
    [/events:polling$/, () => json([
      { eventId: 'ok', eventType: 'CONCLUDED', orderId: 'od-1001', createdAt: 'x' },
      { eventId: 'falha', eventType: 'CONCLUDED', orderId: 'od-404', createdAt: 'x' },
    ])],
    [/orders\/od-1001$/, () => json(pedidoOpenDelivery())],
    [/orders\/od-404$/, () => json({ message: 'not found' }, 404)],
    [/acknowledgment$/, () => new Response(null, { status: 202 })],
  ]);
  const resumo = await sincronizarOpenDelivery(
    { lojaId: 'l', baseUrl: 'https://dd.test', clientId: 'id', clientSecret: 's', fetch: f },
    new RepositorioEmMemoria(),
  );
  assert.equal(resumo.erros.length, 1);
  assert.match(resumo.erros[0], /^falha \(od-404\): HTTP 404/);
  const ack = chamadas.find((c) => c.url.endsWith('acknowledgment'))!;
  assert.deepEqual(JSON.parse(ack.corpo!).map((e: { id: string }) => e.id), ['ok']);
});

test('token: reaproveitado dentro da validade e renovado em 401', async () => {
  let emitidos = 0;
  let recusarProxima = false;
  const { f } = fetchFalso([
    [/token$/, () => json({ accessToken: `t${++emitidos}`, expiresIn: 3600 })],
    [/recurso$/, (c) => {
      if (recusarProxima) { recusarProxima = false; return new Response('expirado', { status: 401 }); }
      return json({ usado: c.headers.Authorization });
    }],
  ]);
  const { chamarAutenticado } = await import('../src/conectores/http.ts');
  const tk = new ProvedorDeToken({ url: 'https://x.test/token', clientId: 'a', clientSecret: 'b', fetch: f });

  assert.deepEqual(await (await chamarAutenticado(f, tk, 'https://x.test/recurso')).json(), { usado: 'Bearer t1' });
  assert.deepEqual(await (await chamarAutenticado(f, tk, 'https://x.test/recurso')).json(), { usado: 'Bearer t1' });
  recusarProxima = true;
  assert.deepEqual(await (await chamarAutenticado(f, tk, 'https://x.test/recurso')).json(), { usado: 'Bearer t2' });
  assert.equal(emitidos, 2);
});

test('Anota AI: lê o idpage do token da loja', () => {
  const payload = Buffer.from(JSON.stringify({ idpartner: 'p', idpage: '507f1f77bcf86cd799439011', iat: 1 })).toString('base64url');
  assert.equal(pageIdDoToken(`xxx.${payload}.yyy`), '507f1f77bcf86cd799439011');
});

test('Anota AI: pagina a lista, importa só finalizados novos e nunca altera pedidos', async () => {
  const pagina1 = Array.from({ length: 100 }, (_, i) => ({ _id: `p${i}`, check: i === 0 ? 3 : 1 }));
  const pagina2 = [{ _id: 'p100', check: 3 }];
  const { f, chamadas } = fetchFalso([
    [/oauth-client\/token$/, () => json({ accessToken: 'tk', tokenType: 'Bearer', expiresIn: 3600 })],
    [/ping\/list\?.*cancelled=1/, () => json({ success: true, info: { docs: [], count: 0, limit: 100, currentpage: 1 } })],
    [/ping\/list\?.*currentpage=1/, () => json({ success: true, info: { docs: pagina1, count: 101, limit: 100, currentpage: 1 } })],
    [/ping\/list\?.*currentpage=2/, () => json({ success: true, info: { docs: pagina2, count: 101, limit: 100, currentpage: 2 } })],
    [/ping\/get\/(p0|p100)$/, (c) => json({
      success: true,
      info: {
        ...anotaAIExemploOficial,
        _id: c.url.split('/').at(-1), id: c.url.split('/').at(-1), check: 3,
        customer: { id: 'x', name: 'Joana', phone: '(43) 99876-5432' },
      },
    })],
  ]);
  const repo = new RepositorioEmMemoria();
  const resumo = await sincronizarAnotaAI(
    { lojaId: 'loja-1', clientId: 'id', clientSecret: 's', pageId: 'page-9', fetch: f },
    repo,
  );

  assert.deepEqual(resumo.resultados, { importado: 2 });
  assert.equal(repo.pedidos.size, 2);
  const listas = chamadas.filter((c) => c.url.includes('/ping/list'));
  assert.ok(listas.every((c) => c.headers['x-page-id'] === 'page-9' && c.url.includes('excludeIfood=1')));
  assert.ok(chamadas.every((c) => !c.url.includes('/order/')), 'o conector é só leitura');

  // Segundo ciclo no mesmo dia não reprocessa o que já foi importado.
  const antes = chamadas.length;
  await sincronizarAnotaAI({ lojaId: 'loja-1', clientId: 'id', clientSecret: 's', pageId: 'page-9', fetch: f }, repo);
  assert.ok(!chamadas.slice(antes).some((c) => c.url.includes('/ping/get/')));
});

test('regressão: Anota AI não busca de novo nem reconta pedido já descartado', async () => {
  const { f, chamadas } = fetchFalso([
    [/oauth-client\/token$/, () => json({ accessToken: 'tk', expiresIn: 3600 })],
    [/ping\/list\?.*cancelled=1/, () => json({ success: true, info: { docs: [], count: 0, limit: 100, currentpage: 1 } })],
    [/ping\/list/, () => json({ success: true, info: { docs: [{ _id: 'ruim', check: 3 }], count: 1, limit: 100, currentpage: 1 } })],
    [/ping\/get\/ruim$/, () => json({ success: true, info: { ...anotaAIExemploOficial, _id: 'ruim', id: 'ruim', check: 3 } })],
  ]);
  const repo = new RepositorioEmMemoria();
  for (let i = 0; i < 3; i++) await sincronizarAnotaAI({ lojaId: 'loja-1', clientId: 'id', clientSecret: 's', pageId: 'p', fetch: f }, repo);
  assert.deepEqual(repo.resumoDescartes('loja-1'), { telefone_invalido: 1 });
  assert.equal(chamadas.filter((c) => c.url.includes('/ping/get/')).length, 1);
});
