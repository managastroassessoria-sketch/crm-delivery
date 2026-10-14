import type { Fonte } from './modelo.ts';

export interface EstadoIntegracao {
  lojaId: string;
  fonte: Fonte;
  ultimaCompraEm: Date | null;
}

export interface Alerta extends EstadoIntegracao {
  /** null quando a integração nunca registrou compra. */
  diasSemCompra: number | null;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Integração quebrada em silêncio zera a atribuição sem nenhum erro visível.
 * Mesma regra do monitor do Retorne: alerta a partir de 4 dias sem compra.
 */
export function integracoesEmAlerta(
  estados: EstadoIntegracao[],
  agora: Date = new Date(),
  dias = 4,
): Alerta[] {
  return estados
    .map((e) => ({
      ...e,
      diasSemCompra: e.ultimaCompraEm ? Math.floor((agora.getTime() - e.ultimaCompraEm.getTime()) / DIA_MS) : null,
    }))
    .filter((e) => e.diasSemCompra === null || e.diasSemCompra >= dias)
    .sort((a, b) => (b.diasSemCompra ?? Infinity) - (a.diasSemCompra ?? Infinity));
}
