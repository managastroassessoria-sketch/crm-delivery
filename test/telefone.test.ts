import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarTelefone } from '../src/telefone.ts';

test('celular com máscara vira E.164', () => {
  assert.deepEqual(normalizarTelefone('(21) 98765-4321'), {
    original: '(21) 98765-4321', e164: '+5521987654321', tipo: 'celular',
  });
});

test('aceita +55, 55 e zero de tronco', () => {
  for (const n of ['+55 21 98765-4321', '5521987654321', '021987654321']) {
    assert.equal(normalizarTelefone(n).e164, '+5521987654321', n);
  }
});

test('fixo é identificado e mantido, para ser excluído do WhatsApp', () => {
  const t = normalizarTelefone('(21) 3333-4444');
  assert.equal(t.tipo, 'fixo');
  assert.equal(t.e164, '+552133334444');
});

test('celular antigo sem o nono dígito é inválido, não "corrigido"', () => {
  assert.equal(normalizarTelefone('(21) 8765-4321').tipo, 'invalido');
});

test('DDD inexistente, 0800 e lixo são inválidos', () => {
  for (const n of ['(20) 98765-4321', '0800 123 4567', 'abc', '', '123']) {
    assert.equal(normalizarTelefone(n).tipo, 'invalido', n);
  }
});

test('o telefone do exemplo oficial do Anota AI é fictício e cai como inválido', () => {
  // "43123456789": DDD 43 válido, mas assinante começando com 1 não existe.
  assert.equal(normalizarTelefone('43123456789').tipo, 'invalido');
});
