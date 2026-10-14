import type { Cliente } from '../modelo.ts';
import type { PedidoSalvo } from '../repositorio.ts';
import type { Periodo } from './atribuicao.ts';

const DIA = 86_400_000;

export type FaixaNovos = 'ruim' | 'ok' | 'excelente' | 'sem_referencia' | 'nao_saudavel';

/**
 * Faixas de participação de clientes novos no mês, da metodologia da Maná:
 * ruim abaixo de 10% ou acima de 50%; ok 10–20%; excelente 20–35%; acima de 40%
 * não é saudável. Entre 35% e 40% não há faixa definida.
 */
export function faixaDeNovos(percentual: number): FaixaNovos {
  if (percentual < 10 || percentual > 50) return 'ruim';
  if (percentual < 20) return 'ok';
  if (percentual <= 35) return 'excelente';
  if (percentual <= 40) return 'sem_referencia';
  return 'nao_saudavel';
}

export interface PainelDaLoja {
  periodo: Periodo;
  pedidos: number;
  clientesUnicos: number;
  faturamentoCentavos: number;
  ticketMedioCentavos: number;
  clientesNovos: number;
  /** Percentual de clientes do período cuja primeira compra foi no período. */
  participacaoNovos: number;
  faixaNovos: FaixaNovos;
  /** Recompra = clientes do período que já tinham comprado antes ÷ clientes únicos × 100. */
  recompra: number;
  /** Recorrência = pedidos do período ÷ clientes únicos. Queda = cliente espaçando pedidos. */
  recorrencia: number;
  /** LTV = ticket médio × frequência mensal × meses ativos (médias da base), em centavos. */
  ltvCentavos: number;
  baseIdentificada: number;
  /** Clientes sem nenhuma compra concluída (ex.: só pedidos cancelados). */
  semCompras: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Indicadores da loja com as definições da Maná. */
export function painelDaLoja(entrada: { periodo: Periodo; pedidos: PedidoSalvo[]; clientes: Cliente[] }): PainelDaLoja {
  const { periodo } = entrada;
  const concluidos = entrada.pedidos.filter((p) => p.status === 'concluido');
  const doPeriodo = concluidos.filter((p) => p.criadoEm >= periodo.inicio && p.criadoEm < periodo.fim);

  const primeiraCompra = new Map<string, Date>();
  for (const p of concluidos) {
    const a = primeiraCompra.get(p.clienteId);
    if (!a || p.criadoEm < a) primeiraCompra.set(p.clienteId, p.criadoEm);
  }

  const unicos = new Set(doPeriodo.map((p) => p.clienteId));
  const novos = [...unicos].filter((id) => primeiraCompra.get(id)! >= periodo.inicio).length;
  const recompraram = unicos.size - novos;
  const faturamento = doPeriodo.reduce((s, p) => s + p.totalCentavos, 0);
  const participacaoNovos = unicos.size ? (novos / unicos.size) * 100 : 0;

  // LTV pelas médias da base inteira.
  const porCliente = new Map<string, PedidoSalvo[]>();
  for (const p of concluidos) porCliente.set(p.clienteId, [...(porCliente.get(p.clienteId) ?? []), p]);
  let somaFreq = 0, somaMeses = 0;
  for (const lista of porCliente.values()) {
    const tempos = lista.map((p) => p.criadoEm.getTime());
    const meses = Math.max(1, (Math.max(...tempos) - Math.min(...tempos)) / (30 * DIA));
    somaMeses += meses;
    somaFreq += lista.length / meses;
  }
  const n = porCliente.size;
  const ticketGeral = concluidos.length ? concluidos.reduce((s, p) => s + p.totalCentavos, 0) / concluidos.length : 0;
  const ltv = n ? ticketGeral * (somaFreq / n) * (somaMeses / n) : 0;

  const ativos = entrada.clientes.filter((c) => c.status === 'ativo');
  return {
    periodo,
    pedidos: doPeriodo.length,
    clientesUnicos: unicos.size,
    faturamentoCentavos: faturamento,
    ticketMedioCentavos: doPeriodo.length ? Math.round(faturamento / doPeriodo.length) : 0,
    clientesNovos: novos,
    participacaoNovos: r1(participacaoNovos),
    faixaNovos: faixaDeNovos(participacaoNovos),
    recompra: unicos.size ? r1((recompraram / unicos.size) * 100) : 0,
    recorrencia: unicos.size ? Math.round((doPeriodo.length / unicos.size) * 100) / 100 : 0,
    ltvCentavos: Math.round(ltv),
    baseIdentificada: ativos.length,
    semCompras: ativos.filter((c) => !primeiraCompra.has(c.id)).length,
  };
}
