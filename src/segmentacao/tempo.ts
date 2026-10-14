// Dia da semana e hora no fuso da loja. Pedido das 22h em São Paulo é 01h UTC do
// dia seguinte; sem o fuso, "dia preferido" e "dias de pico" saem trocados.

export const FUSO_PADRAO = 'America/Sao_Paulo';

export type DiaSemana = 'dom' | 'seg' | 'ter' | 'qua' | 'qui' | 'sex' | 'sab';
export const DIAS: DiaSemana[] = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

export type Periodo = 'madrugada' | 'manha' | 'tarde' | 'noite';

const DIA_EN: Record<string, DiaSemana> = {
  Sun: 'dom', Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab',
};

const formatadores = new Map<string, Intl.DateTimeFormat>();
function formatador(fuso: string) {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: fuso, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    formatadores.set(fuso, f);
  }
  return f;
}

export function diaEHora(data: Date, fuso = FUSO_PADRAO): { dia: DiaSemana; hora: number } {
  const partes = formatador(fuso).formatToParts(data);
  const dia = DIA_EN[partes.find((p) => p.type === 'weekday')!.value];
  const hora = Number(partes.find((p) => p.type === 'hour')!.value);
  return { dia, hora };
}

export function periodoDaHora(hora: number): Periodo {
  if (hora < 6) return 'madrugada';
  if (hora < 12) return 'manha';
  if (hora < 18) return 'tarde';
  return 'noite';
}

const partesCompletas = new Map<string, Intl.DateTimeFormat>();
function partesNoFuso(data: Date, fuso: string) {
  let f = partesCompletas.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partesCompletas.set(fuso, f);
  }
  const p = f.formatToParts(data);
  const v = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { ano: v('year'), mes: v('month'), dia: v('day'), hora: v('hour'), minuto: v('minute'), segundo: v('second') };
}

/** Data do calendário local da loja, "AAAA-MM-DD". */
export function dataLocal(data: Date, fuso = FUSO_PADRAO): string {
  const p = partesNoFuso(data, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

function deslocamentoMs(instante: Date, fuso: string): number {
  const p = partesNoFuso(instante, fuso);
  return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - instante.getTime();
}

/** "2026-10-17" + "19:00" no fuso da loja → instante UTC. Corrige o deslocamento duas vezes por causa de horário de verão. */
export function horarioLocalParaUTC(data: string, hora: string, fuso = FUSO_PADRAO): Date {
  const [a, m, d] = data.split('-').map(Number);
  const [h, mi] = hora.split(':').map(Number);
  const ingenuo = Date.UTC(a, m - 1, d, h, mi);
  let t = ingenuo - deslocamentoMs(new Date(ingenuo), fuso);
  t = ingenuo - deslocamentoMs(new Date(t), fuso);
  return new Date(t);
}

const DIA_MS = 24 * 60 * 60 * 1000;
/** Diferença em blocos de 24 h. Para durações (janela de atribuição, carência), não para "D+N". */
export function diasEntre(antes: Date, depois: Date): number {
  return Math.floor((depois.getTime() - antes.getTime()) / DIA_MS);
}

/**
 * Diferença em DIAS DE CALENDÁRIO no fuso da loja. É o que a régua quer dizer com
 * "D+1": pedido de segunda às 20h é D+1 na terça, a qualquer hora que o planejador rode.
 * Com blocos de 24 h, a mensagem sairia um dia depois para a maioria dos pedidos de delivery,
 * que acontecem à noite.
 */
export function diasDeCalendario(antes: Date, depois: Date, fuso = FUSO_PADRAO): number {
  const [a1, m1, d1] = dataLocal(antes, fuso).split('-').map(Number);
  const [a2, m2, d2] = dataLocal(depois, fuso).split('-').map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / DIA_MS);
}

/** O valor mais frequente; empate fica com o que apareceu primeiro. */
export function moda<T>(valores: T[]): T | undefined {
  const contagem = new Map<T, number>();
  let melhor: T | undefined;
  let max = 0;
  for (const v of valores) {
    const n = (contagem.get(v) ?? 0) + 1;
    contagem.set(v, n);
    if (n > max) { max = n; melhor = v; }
  }
  return melhor;
}
