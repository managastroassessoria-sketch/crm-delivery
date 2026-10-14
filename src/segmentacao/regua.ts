import type { Segmento } from './segmento.ts';

/**
 * A régua de recompra da Maná como segmentos prontos: D+1 avaliação, D+4 pós 1ª
 * compra, D+7 forçar a 3ª compra, clientes 30D e 90D. Aniversário entra quando a
 * data de nascimento for coletada.
 *
 * Cada segmento usa "igual" nos dias: avaliado uma vez por dia, ele pega quem
 * completa exatamente aquele intervalo hoje — é assim que funciona como gatilho.
 * Leitura adotada para o D+7: o cliente tem 2 compras e a última foi há 7 dias.
 */
export const REGUA: Record<string, { descricao: string; segmento: Segmento }> = {
  d1_avaliacao: {
    descricao: 'D+1 — pedido de avaliação, um dia depois de qualquer compra',
    segmento: { combinar: 'E', canal: 'whatsapp', conjuntos: [{ tipo: 'E', condicoes: [
      { campo: 'dias_desde_ultima_compra', operador: 'igual', valor: 1 },
    ] }] },
  },
  d4_pos_primeira: {
    descricao: 'D+4 — experiência pós 1ª compra',
    segmento: { combinar: 'E', canal: 'whatsapp', conjuntos: [{ tipo: 'E', condicoes: [
      { campo: 'numero_compras', operador: 'igual', valor: 1 },
      { campo: 'dias_desde_ultima_compra', operador: 'igual', valor: 4 },
    ] }] },
  },
  d7_terceira_compra: {
    descricao: 'D+7 — forçar a 3ª compra',
    segmento: { combinar: 'E', canal: 'whatsapp', conjuntos: [{ tipo: 'E', condicoes: [
      { campo: 'numero_compras', operador: 'igual', valor: 2 },
      { campo: 'dias_desde_ultima_compra', operador: 'igual', valor: 7 },
    ] }] },
  },
  clientes_30d: {
    descricao: 'Clientes 30D — 30 dias sem comprar',
    segmento: { combinar: 'E', canal: 'whatsapp', conjuntos: [{ tipo: 'E', condicoes: [
      { campo: 'dias_desde_ultima_compra', operador: 'igual', valor: 30 },
    ] }] },
  },
  clientes_90d: {
    descricao: 'Clientes 90D — 90 dias sem comprar',
    segmento: { combinar: 'E', canal: 'whatsapp', conjuntos: [{ tipo: 'E', condicoes: [
      { campo: 'dias_desde_ultima_compra', operador: 'igual', valor: 90 },
    ] }] },
  },
};
