import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integracoesEmAlerta } from '../src/saude.ts';

test('alerta a partir de 4 dias sem compra e quando nunca houve compra', () => {
  const agora = new Date('2026-10-13T12:00:00Z');
  const alertas = integracoesEmAlerta(
    [
      { lojaId: 'a', fonte: 'open_delivery', ultimaCompraEm: new Date('2026-10-12T20:00:00Z') },
      { lojaId: 'b', fonte: 'anota_ai', ultimaCompraEm: new Date('2026-10-09T11:00:00Z') },
      { lojaId: 'c', fonte: 'open_delivery', ultimaCompraEm: new Date('2026-10-01T00:00:00Z') },
      { lojaId: 'd', fonte: 'anota_ai', ultimaCompraEm: null },
    ],
    agora,
  );
  assert.deepEqual(alertas.map((a) => [a.lojaId, a.diasSemCompra]), [['d', null], ['c', 12], ['b', 4]]);
});
