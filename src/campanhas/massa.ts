import { diaEHora, FUSO_PADRAO, diasEntre, type DiaSemana } from '../segmentacao/tempo.ts';
import type { Campanha, Onda } from './modelo.ts';

const NOME_DIA: Record<DiaSemana, string> = { dom: 'dom', seg: 'seg', ter: 'ter', qua: 'qua', qui: 'qui', sex: 'sex', sab: 'sáb' };

const formatoData = new Map<string, Intl.DateTimeFormat>();
function dataHoraLegivel(em: Date, fuso: string): string {
  let f = formatoData.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('pt-BR', {
      timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatoData.set(fuso, f);
  }
  return `${NOME_DIA[diaEHora(em, fuso).dia]} ${f.format(em).replace(',', '')}`;
}

/** Intervalo entre ondas que gera aviso. PROVISÓRIO: o original avisa de "espaçamento grande" sem dizer o número. */
const INTERVALO_LONGO_DIAS = 14;

export interface ValidacaoMassa {
  erros: string[];
  avisos: string[];
  /**
   * Uma linha por onda, gerada a partir dos valores que serão gravados. É o que a
   * tela de confirmação mostra — no original, datas de ondas já reverteram entre o
   * ajuste e o salvamento, e o formulário não provava o que foi gravado.
   */
  resumo: string[];
}

export function validarDisparoEmMassa(entrada: {
  populacao: string[];
  ondas: Onda[];
  agora: Date;
  fuso?: string;
  diasPico?: DiaSemana[];
}): ValidacaoMassa {
  const fuso = entrada.fuso ?? FUSO_PADRAO;
  const { populacao, ondas, agora } = entrada;
  const erros: string[] = [];
  const avisos: string[] = [];

  if (!populacao.length) erros.push('A população está vazia.');
  const repetidos = populacao.length - new Set(populacao).size;
  if (repetidos) erros.push(`A população tem ${repetidos} cliente(s) repetido(s); cada cliente recebe uma vez só.`);
  if (!ondas.length) erros.push('Adicione ao menos uma onda.');

  ondas.forEach((o, i) => {
    if (!Number.isInteger(o.quantidade) || o.quantidade <= 0) erros.push(`Onda ${i + 1}: a quantidade precisa ser um número inteiro maior que zero.`);
    if (o.em.getTime() <= agora.getTime()) erros.push(`Onda ${i + 1}: a data (${dataHoraLegivel(o.em, fuso)}) já passou.`);
    if (i > 0 && o.em.getTime() <= ondas[i - 1].em.getTime()) {
      erros.push(`Onda ${i + 1}: precisa ser depois da onda ${i}.`);
    } else if (i > 0) {
      const intervalo = diasEntre(ondas[i - 1].em, o.em);
      if (intervalo > INTERVALO_LONGO_DIAS) avisos.push(`Intervalo de ${intervalo} dias entre a onda ${i} e a onda ${i + 1}.`);
    }
    if (entrada.diasPico?.length) {
      const dia = diaEHora(o.em, fuso).dia;
      if (!entrada.diasPico.includes(dia)) {
        avisos.push(`Onda ${i + 1} (${dataHoraLegivel(o.em, fuso)}) cai fora dos dias de pico da loja (${entrada.diasPico.map((d) => NOME_DIA[d]).join(', ')}).`);
      }
    }
  });

  const soma = ondas.reduce((s, o) => s + (o.quantidade > 0 ? o.quantidade : 0), 0);
  const unicos = new Set(populacao).size;
  if (ondas.length && unicos && soma !== unicos) {
    const dif = Math.abs(unicos - soma);
    erros.push(`A soma das ondas (${soma}) é diferente da população (${unicos}): ${soma < unicos ? 'faltam' : 'sobram'} ${dif} cliente(s).`);
  }

  const resumo = ondas.map((o, i) => `Onda ${i + 1} · ${dataHoraLegivel(o.em, fuso)} · ${o.quantidade} clientes`);
  return { erros, avisos, resumo };
}

/** No original não existe edição de disparo em massa, nem agendado. Aqui pode editar até a primeira onda sair. */
export function podeEditarMassa(c: Campanha, agora: Date): boolean {
  const primeira = c.ondas?.[0];
  return c.tipo === 'massa' && Boolean(primeira) && primeira!.em.getTime() > agora.getTime();
}
