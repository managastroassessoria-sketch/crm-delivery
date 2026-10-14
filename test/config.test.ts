import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerConfig } from '../src/config.ts';

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

test('config vazia: sem erros, só avisos', () => {
  const r = lerConfig({});
  assert.deepEqual(r.erros, []);
  assert.equal(r.config.whatsapp, undefined);
  assert.equal(r.config.regras.diasHibernacao, 3);
  assert.ok(r.avisos.length >= 2);
});

test('grupo preenchido pela metade vira erro', () => {
  const r = lerConfig({ WHATSAPP_PHONE_NUMBER_ID: '123' });
  assert.match(r.erros.join(), /WhatsApp: faltam WHATSAPP_ACCESS_TOKEN/);
});

test('config completa monta as integrações', () => {
  const r = lerConfig({
    DATABASE_URL: 'postgresql://u:p@h/db',
    WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v',
    WHATSAPP_LIMITE_24H: '2000', WHATSAPP_PRECO_MARKETING_CENTAVOS: '35,5',
    ANOTAAI_CLIENT_ID: 'c', ANOTAAI_CLIENT_SECRET: 's', ANOTAAI_TOKEN_LOJA: jwt({ idpage: 'pg1' }), ANOTAAI_LOJA_ID: 'loja1',
    OPENDELIVERY_BASE_URL: 'https://x', OPENDELIVERY_CLIENT_ID: 'c', OPENDELIVERY_CLIENT_SECRET: 's', OPENDELIVERY_LOJA_ID: 'l', OPENDELIVERY_MERCHANT_IDS: 'a, b',
  });
  assert.deepEqual(r.erros, []);
  assert.equal(r.config.whatsapp?.limite24h, 2000);
  assert.equal(r.config.whatsapp?.precoMarketingCentavos, 35.5);
  assert.equal(r.config.anotaai?.pageId, 'pg1');
  assert.deepEqual(r.config.openDelivery?.merchantIds, ['a', 'b']);
});

test('valores inválidos são apontados', () => {
  const r = lerConfig({ CRM_FUSO: 'Lua/Base', DATABASE_URL: 'mysql://x', CRM_DIAS_HIBERNACAO: '-1' });
  assert.equal(r.erros.length, 3);
});
