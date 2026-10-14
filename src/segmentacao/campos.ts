import type { PerfilCliente } from './perfil.ts';

export type TipoCampo = 'numero' | 'dinheiro' | 'opcao' | 'lista' | 'booleano';

export interface DefinicaoCampo {
  rotulo: string;
  tipo: TipoCampo;
  /** Valores válidos para campos de opção, com o rótulo de cada um. */
  opcoes?: Record<string, string>;
  ler(p: PerfilCliente): number | string | string[] | boolean | null | undefined;
}

/**
 * Campos que a camada 1 já sustenta. Os demais do Retorne (aniversário, NPS, cupom,
 * pesquisa, agendamento, indicação, carrinho) entram quando os módulos que geram
 * esses dados existirem.
 */
export const CAMPOS = {
  quadrante: {
    rotulo: 'Quadrante',
    tipo: 'opcao',
    opcoes: { novo: 'Novo', recorrente: 'Recorrente', fiel: 'Fiel', campeao: 'Campeão', perdido: 'Perdido' },
    ler: (p) => p.quadrante,
  },
  faixa_recencia: {
    rotulo: 'Faixa de recência',
    tipo: 'opcao',
    opcoes: {
      ate_4: 'até 4 dias', ate_7: '5 a 7 dias', ate_15: '8 a 15 dias', ate_30: '16 a 30 dias',
      ate_60: '31 a 60 dias', ate_90: '61 a 90 dias', acima_90: 'mais de 90 dias',
    },
    ler: (p) => p.faixaRecencia,
  },
  numero_compras: { rotulo: 'Número de compras', tipo: 'numero', ler: (p) => p.numeroCompras },
  total_gasto: { rotulo: 'Total gasto', tipo: 'dinheiro', ler: (p) => p.totalGastoCentavos },
  ticket_medio: { rotulo: 'Ticket médio', tipo: 'dinheiro', ler: (p) => p.ticketMedioCentavos },
  dias_desde_ultima_compra: { rotulo: 'Dias desde a última compra', tipo: 'numero', ler: (p) => p.diasDesdeUltimaCompra },
  dias_desde_primeira_compra: { rotulo: 'Dias desde a primeira compra', tipo: 'numero', ler: (p) => p.diasDesdePrimeiraCompra },
  media_dias_entre_compras: { rotulo: 'Média de dias entre compras', tipo: 'numero', ler: (p) => p.mediaDiasEntreCompras },
  compras_por_mes: { rotulo: 'Compras por mês', tipo: 'numero', ler: (p) => p.comprasPorMes },
  dia_preferido: {
    rotulo: 'Dia da semana preferido',
    tipo: 'opcao',
    opcoes: { dom: 'domingo', seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta', sex: 'sexta', sab: 'sábado' },
    ler: (p) => p.diaPreferido,
  },
  periodo_preferido: {
    rotulo: 'Período do dia preferido',
    tipo: 'opcao',
    opcoes: { madrugada: 'madrugada', manha: 'manhã', tarde: 'tarde', noite: 'noite' },
    ler: (p) => p.periodoPreferido,
  },
  produto_favorito: { rotulo: 'Produto favorito', tipo: 'lista', ler: (p) => (p.produtoFavorito ? [p.produtoFavorito] : []) },
  produto_comprado: { rotulo: 'Produto comprado', tipo: 'lista', ler: (p) => p.produtosComprados },
  tem_email: { rotulo: 'Tem e-mail', tipo: 'booleano', ler: (p) => p.temEmail },
} satisfies Record<string, DefinicaoCampo>;

export type Campo = keyof typeof CAMPOS;

export type Operador = 'maior_que' | 'menor_que' | 'igual' | 'diferente' | 'entre' | 'contem' | 'nao_contem';

export const OPERADORES_POR_TIPO: Record<TipoCampo, Operador[]> = {
  numero: ['maior_que', 'menor_que', 'igual', 'diferente', 'entre'],
  dinheiro: ['maior_que', 'menor_que', 'igual', 'diferente', 'entre'],
  opcao: ['igual', 'diferente'],
  lista: ['contem', 'nao_contem'],
  booleano: ['igual'],
};

export const ROTULO_OPERADOR: Record<Operador, string> = {
  maior_que: 'maior que', menor_que: 'menor que', igual: 'igual a', diferente: 'diferente de',
  entre: 'entre', contem: 'contém', nao_contem: 'não contém',
};
