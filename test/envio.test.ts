import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { despachar, type ContatoParaEnvio, type EnvioParaDespacho, type EntradaDespacho } from '../src/envio/despachante.ts';
import { interpretarErro } from '../src/envio/erros.ts';
import { preencherVariaveis, primeiroNome, type Criativo } from '../src/envio/variaveis.ts';
import { assinaturaValida, ehPedidoDeDescadastro, interpretarWebhook, proximoStatus, responderVerificacao } from '../src/envio/webhook.ts';
import { enviarTemplate } from '../src/envio/whatsapp.ts';
import type { ResultadoEnvio } from '../src/envio/whatsapp.ts';

const AGORA = new Date('2026-10-16T22:00:00Z');

const criativo: Criativo = {
  id: 'cri-1', nomeTemplate: 'saudade_bolo', idioma: 'pt_BR', categoria: 'marketing',
  variaveis: [{ fonte: 'primeiro_nome', reserva: 'tudo bem' }, { fonte: 'produto_favorito' }, { fonte: 'nome_loja' }],
};

test('variáveis: primeiro nome, reserva e recusa de texto quebrado', () => {
  assert.equal(primeiroNome('  maria SOUZA '), 'Maria');
  assert.equal(primeiroNome('123'), undefined);
  assert.equal(primeiroNome('Cliente2'), undefined);
  assert.deepEqual(preencherVariaveis(criativo, { nome: 'joão', produtoFavorito: 'bolo de\npote', nomeLoja: 'Vila do Amor' }),
    { ok: true, parametros: ['João', 'bolo de pote', 'Vila do Amor'] });
  assert.deepEqual(preencherVariaveis(criativo, { nome: '---', produtoFavorito: 'torta', nomeLoja: 'Vila do Amor' }),
    { ok: true, parametros: ['tudo bem', 'torta', 'Vila do Amor'] });
  // Produto favorito sem reserva e sem valor: não envia.
  assert.deepEqual(preencherVariaveis(criativo, { nome: 'Ana', nomeLoja: 'Vila do Amor' }), { ok: false, variavel: 2, fonte: 'produto_favorito' });
});

test('envio do template no formato da Cloud API', async () => {
  let pedido: { url: string; corpo: unknown; auth: string } | undefined;
  const r = await enviarTemplate(
    {
      phoneNumberId: '1098765', accessToken: 'tk',
      fetch: async (url, init) => {
        pedido = { url: String(url), corpo: JSON.parse(String(init!.body)), auth: (init!.headers as Record<string, string>).Authorization };
        return new Response(JSON.stringify({
          messaging_product: 'whatsapp', contacts: [{ input: '5521987654321', wa_id: '5521987654321' }],
          messages: [{ id: 'wamid.HBgLMTY1', message_status: 'accepted' }],
        }), { status: 200 });
      },
    },
    '+5521987654321', criativo, ['Maria', 'bolo', 'Vila'],
  );
  assert.deepEqual(r, { ok: true, wamid: 'wamid.HBgLMTY1' });
  assert.equal(pedido!.url, 'https://graph.facebook.com/v24.0/1098765/messages');
  assert.equal(pedido!.auth, 'Bearer tk');
  assert.deepEqual(pedido!.corpo, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '5521987654321', type: 'template',
    template: { name: 'saudade_bolo', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [
      { type: 'text', text: 'Maria' }, { type: 'text', text: 'bolo' }, { type: 'text', text: 'Vila' },
    ] }] },
  });

  const erro = await enviarTemplate({ phoneNumberId: '1', accessToken: 't', fetch: async () =>
    new Response(JSON.stringify({ error: { code: 132001, message: 'Template name does not exist in the translation', error_data: { details: 'template name (x) does not exist in pt_BR' } } }), { status: 400 }),
  }, '+5521987654321', criativo, []);
  assert.deepEqual(erro, { ok: false, codigo: 132001, mensagem: 'template name (x) does not exist in pt_BR' });
});

test('erros da Meta viram ação', () => {
  assert.equal(interpretarErro(131026).acao, 'marcar_sem_whatsapp');
  assert.equal(interpretarErro(131050).acao, 'descadastrar');
  assert.equal(interpretarErro(132015).acao, 'pausar_criativo');
  assert.equal(interpretarErro(190).acao, 'pausar_conta');
  assert.equal(interpretarErro(99999).acao, 'desistir');
});

// ── despachante ─────────────────────────────────────────────────────────────

function envio(id: string, clienteId: string, o: Partial<EnvioParaDespacho> = {}): EnvioParaDespacho {
  return {
    id, clienteId, lojaId: 'loja-1', campanhaId: 'c1', canal: 'whatsapp', criativoId: 'cri-1',
    planejadoPara: new Date('2026-10-16T21:00:00Z'), contabilizaReceita: true, hiberna: true, tentativas: 0, ...o,
  };
}
function contato(tel: string, o: Partial<ContatoParaEnvio> = {}): ContatoParaEnvio {
  return { telefoneE164: tel, nome: 'Maria', produtoFavorito: 'bolo', nomeLoja: 'Vila do Amor', descadastrado: false, semWhatsapp: false, ...o };
}
function entrada(o: Partial<EntradaDespacho> & { respostas?: Record<string, ResultadoEnvio> }): EntradaDespacho & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    agora: AGORA, envios: [], contatos: new Map(), criativos: new Map([['cri-1', criativo]]),
    limiteDestinatarios24h: 250, destinatarios24h: new Map(),
    enviar: async (tel) => { chamadas.push(tel); return o.respostas?.[tel] ?? { ok: true, wamid: `wamid.${tel}` }; },
    ...o, chamadas,
  };
}

test('despachante: só envia o que venceu, e cancela com motivo o que não pode sair', async () => {
  const e = entrada({
    envios: [
      envio('e1', 'a'),
      envio('e2', 'b'),
      envio('e3', 'c'),
      envio('e4', 'd'),
      envio('futuro', 'a', { planejadoPara: new Date('2026-10-17T21:00:00Z') }),
    ],
    contatos: new Map([
      ['a', contato('+5521900000001')],
      ['b', contato('+5521900000002', { descadastrado: true })],
      ['c', contato('+5521900000003', { produtoFavorito: undefined })],
      ['d', contato('+5521900000004', { semWhatsapp: true })],
    ]),
  });
  const r = await despachar(e);
  assert.deepEqual(r.desfechos, [
    { envioId: 'e1', status: 'enviado', wamid: 'wamid.+5521900000001' },
    { envioId: 'e2', status: 'cancelado', motivo: 'descadastrado' },
    { envioId: 'e3', status: 'cancelado', motivo: 'variavel_ausente' },
    { envioId: 'e4', status: 'cancelado', motivo: 'sem_whatsapp' },
  ]);
  assert.deepEqual(e.chamadas, ['+5521900000001']);
});

test('despachante: limite de destinatários da Meta adia em vez de falhar', async () => {
  const janela = new Map([['+5521911111111', new Date('2026-10-16T10:00:00Z')], ['+5521922222222', new Date('2026-10-16T12:00:00Z')]]);
  const e = entrada({
    limiteDestinatarios24h: 3, destinatarios24h: janela,
    envios: [envio('e1', 'a'), envio('e2', 'b'), envio('e3', 'ja-na-janela')],
    contatos: new Map([['a', contato('+5521900000001')], ['b', contato('+5521900000002')], ['ja-na-janela', contato('+5521911111111')]]),
  });
  const r = await despachar(e);
  assert.equal(r.desfechos[0].status, 'enviado');
  assert.deepEqual(r.desfechos[1], { envioId: 'e2', status: 'adiado', motivo: 'limite_meta', tentarDepoisDe: new Date('2026-10-17T10:00:00Z') });
  assert.equal(r.desfechos[2].status, 'enviado'); // quem já está na janela não consome vaga nova
});

test('despachante: cada erro da Meta tem a consequência certa', async () => {
  const e = entrada({
    envios: [
      envio('e1', 'recusou'), envio('e2', 'fixo'), envio('e3', 'lento'),
      envio('e4', 'template', { criativoId: 'cri-1' }), envio('e5', 'depois-do-template'),
    ],
    contatos: new Map([
      ['recusou', contato('+5521900000001')], ['fixo', contato('+5521900000002')], ['lento', contato('+5521900000003')],
      ['template', contato('+5521900000004')], ['depois-do-template', contato('+5521900000005')],
    ]),
    respostas: {
      '+5521900000001': { ok: false, codigo: 131050, mensagem: 'opted out' },
      '+5521900000002': { ok: false, codigo: 131026, mensagem: 'undeliverable' },
      '+5521900000003': { ok: false, codigo: 130429, mensagem: 'rate limit' },
      '+5521900000004': { ok: false, codigo: 132015, mensagem: 'paused' },
    },
  });
  const r = await despachar(e);
  assert.deepEqual(r.descadastrar, ['recusou']);
  assert.deepEqual(r.marcarSemWhatsapp, ['fixo']);
  assert.deepEqual(r.desfechos[2], { envioId: 'e3', status: 'adiado', motivo: 'erro_temporario', codigo: 130429, tentarDepoisDe: new Date(AGORA.getTime() + 5 * 60_000) });
  assert.equal(r.pausarCriativos.get('cri-1'), 'Template pausado pela Meta por baixa qualidade.');
  assert.deepEqual(r.desfechos[4], { envioId: 'e5', status: 'cancelado', motivo: 'criativo_pausado' });
  assert.equal(e.chamadas.length, 4); // o quinto nem foi tentado
});

test('despachante: erro de conta para tudo; erro temporário desiste após o limite de tentativas', async () => {
  const conta = entrada({
    envios: [envio('e1', 'a'), envio('e2', 'b')],
    contatos: new Map([['a', contato('+5521900000001')], ['b', contato('+5521900000002')]]),
    respostas: { '+5521900000001': { ok: false, codigo: 190, mensagem: 'token expired' } },
  });
  const r = await despachar(conta);
  assert.deepEqual(r.contaPausada, { codigo: 190, explicacao: 'Token de acesso expirado.' });
  assert.deepEqual(r.desfechos.map((d) => d.status), ['adiado', 'adiado']);
  assert.equal(conta.chamadas.length, 1);

  const terceira = await despachar(entrada({
    envios: [envio('e1', 'a', { tentativas: 2 })],
    contatos: new Map([['a', contato('+5521900000001')]]),
    respostas: { '+5521900000001': { ok: false, codigo: 131000, mensagem: 'x' } },
  }));
  assert.deepEqual(terceira.desfechos[0], { envioId: 'e1', status: 'falhou', codigo: 131000, explicacao: 'Erro desconhecido no envio.' });
});

// ── webhook ─────────────────────────────────────────────────────────────────

test('webhook: assinatura e verificação', () => {
  const corpo = '{"object":"whatsapp_business_account"}';
  const sig = `sha256=${createHmac('sha256', 'segredo').update(corpo).digest('hex')}`;
  assert.equal(assinaturaValida(corpo, sig, 'segredo'), true);
  assert.equal(assinaturaValida(corpo + ' ', sig, 'segredo'), false);
  assert.equal(assinaturaValida(corpo, sig, 'outro'), false);
  assert.equal(assinaturaValida(corpo, undefined, 'segredo'), false);
  assert.equal(responderVerificacao({ 'hub.mode': 'subscribe', 'hub.verify_token': 'v', 'hub.challenge': '42' }, 'v'), '42');
  assert.equal(responderVerificacao({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '42' }, 'v'), null);
});

test('webhook: status com cobrança e erro, e mensagem recebida', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '5521...', phone_number_id: '1098765' },
      statuses: [
        { id: 'wamid.A', status: 'delivered', timestamp: '1792188000', recipient_id: '5521900000001',
          pricing: { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' } },
        { id: 'wamid.B', status: 'failed', timestamp: '1792188060', recipient_id: '5521900000002',
          errors: [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.', message: 'This message was not delivered to maintain healthy ecosystem engagement.', error_data: { details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.' } }] },
      ],
      messages: [{ from: '5521900000003', id: 'wamid.C', timestamp: '1792188120', type: 'text', text: { body: 'SAIR' } }],
    } }] }],
  };
  const r = interpretarWebhook(payload);
  assert.deepEqual(r.status, [
    { wamid: 'wamid.A', status: 'entregue', em: new Date(1792188000_000), telefone: '+5521900000001', categoria: 'marketing', tipoCobranca: 'regular' },
    { wamid: 'wamid.B', status: 'falhou', em: new Date(1792188060_000), telefone: '+5521900000002', codigoErro: 131049,
      detalheErro: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.' },
  ]);
  assert.deepEqual(r.mensagens, [{ telefone: '+5521900000003', texto: 'SAIR', em: new Date(1792188120_000) }]);
});

test('status não regride e lido sem entregue antes vale', () => {
  assert.equal(proximoStatus('enviado', 'lido'), 'lido');
  assert.equal(proximoStatus('lido', 'entregue'), 'lido');
  assert.equal(proximoStatus('entregue', 'enviado'), 'entregue');
  assert.equal(proximoStatus('entregue', 'falhou'), 'entregue');
  assert.equal(proximoStatus('enviado', 'falhou'), 'falhou');
  assert.equal(proximoStatus('cancelado', 'enviado'), 'cancelado');
});

test('descadastro só com a mensagem inteira', () => {
  for (const t of ['SAIR', ' sair. ', 'Parar', 'STOP', 'Não quero mais receber!']) assert.equal(ehPedidoDeDescadastro(t), true, t);
  for (const t of ['quero cancelar meu pedido', 'cancelar', 'vou sair agora, chega às 20h?', 'parar de vender bolo?']) {
    assert.equal(ehPedidoDeDescadastro(t), false, t);
  }
});

test('regressão: erros que chegam pelo webhook têm consequência', async () => {
  const { consequenciasDoWebhook } = await import('../src/envio/webhook.ts');
  const falha = (wamid: string, tel: string, code: number) =>
    ({ id: wamid, status: 'failed', timestamp: '1792188000', recipient_id: tel, errors: [{ code, message: 'x' }] });
  const w = interpretarWebhook({ entry: [{ changes: [{ field: 'messages', value: {
    statuses: [falha('w1', '5521900000001', 131050), falha('w2', '5521900000002', 131026), falha('w3', '5521900000003', 131049), falha('w4', '5521900000004', 132015)],
    messages: [{ from: '5521900000005', timestamp: '1792188000', type: 'text', text: { body: 'Parar' } }],
  } }] }] });
  const c = consequenciasDoWebhook(w);
  assert.deepEqual(c.descadastrar, ['+5521900000005', '+5521900000001']);
  assert.deepEqual(c.semWhatsapp, ['+5521900000002']);
  assert.deepEqual(c.reenviar, [{ wamid: 'w3', depoisDe: new Date(1792188000_000 + 86_400_000) }]);
  assert.deepEqual(c.pausarCriativoDoEnvio, [{ wamid: 'w4', explicacao: 'Template pausado pela Meta por baixa qualidade.' }]);
});

test('regressão: despachante respeita a próxima tentativa e só manda WhatsApp', async () => {
  const e = entrada({
    envios: [
      envio('espera', 'a', { proximaTentativaEm: new Date(AGORA.getTime() + 60_000) }),
      envio('email', 'a', { canal: 'email' }),
      envio('pronto', 'a', { proximaTentativaEm: new Date(AGORA.getTime() - 60_000) }),
    ],
    contatos: new Map([['a', contato('+5521900000001')]]),
  });
  const r = await despachar(e);
  assert.deepEqual(r.desfechos.map((d) => d.envioId), ['pronto']);
});
