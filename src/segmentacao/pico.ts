import type { PedidoSalvo } from '../repositorio.ts';
import { DIAS, dataLocal, diaEHora, FUSO_PADRAO, horarioLocalParaUTC, type DiaSemana } from './tempo.ts';

export interface VendasNoDia {
  dia: DiaSemana;
  pedidos: number;
  /** Quantas vezes esse dia da semana caiu na janela. */
  ocorrencias: number;
  /** Pedidos por ocorrência — é isso que se compara, não o total. */
  mediaPorDia: number;
  /** Fração dos pedidos da janela (0–1). */
  participacao: number;
  pico: boolean;
}

const DIA_MS = 86_400_000;

/**
 * Pedidos concluídos por dia da semana nos últimos `janelaDias` dias de calendário
 * da loja, SEM contar hoje (dia incompleto). É dia de pico o que tem média por
 * ocorrência acima da média geral.
 *
 * A média por ocorrência corrige o viés da janela: 90 dias são 12 semanas e 6 dias,
 * então seis dias da semana aparecem 13 vezes e um aparece 12. Comparando totais,
 * uma loja com vendas idênticas todo dia teria 6 dos 7 dias marcados como pico.
 *
 * Regra da operação: campanha só é ativada nos dias de pico do cliente.
 */
export function diasDePico(
  pedidos: PedidoSalvo[],
  agora: Date,
  opcoes: { janelaDias?: number; fuso?: string } = {},
): VendasNoDia[] {
  const janela = opcoes.janelaDias ?? 90;
  const fuso = opcoes.fuso ?? FUSO_PADRAO;

  // Datas locais da janela: de hoje − janela até ontem.
  const hojeMeioDia = horarioLocalParaUTC(dataLocal(agora, fuso), '12:00', fuso).getTime();
  const datas = new Set<string>();
  const ocorrencias = new Map<DiaSemana, number>(DIAS.map((d) => [d, 0]));
  for (let i = 1; i <= janela; i++) {
    const meioDia = new Date(hojeMeioDia - i * DIA_MS);
    datas.add(dataLocal(meioDia, fuso));
    const d = diaEHora(meioDia, fuso).dia;
    ocorrencias.set(d, ocorrencias.get(d)! + 1);
  }

  const contagem = new Map<DiaSemana, number>(DIAS.map((d) => [d, 0]));
  let total = 0;
  for (const p of pedidos) {
    if (p.status !== 'concluido' || !datas.has(dataLocal(p.criadoEm, fuso))) continue;
    const { dia } = diaEHora(p.criadoEm, fuso);
    contagem.set(dia, contagem.get(dia)! + 1);
    total++;
  }

  const medias = DIAS.map((dia) => contagem.get(dia)! / Math.max(1, ocorrencias.get(dia)!));
  const mediaGeral = medias.reduce((s, m) => s + m, 0) / 7;
  return DIAS.map((dia, i) => ({
    dia,
    pedidos: contagem.get(dia)!,
    ocorrencias: ocorrencias.get(dia)!,
    mediaPorDia: Math.round(medias[i] * 100) / 100,
    participacao: total ? contagem.get(dia)! / total : 0,
    pico: total > 0 && medias[i] > mediaGeral + 1e-9,
  })).sort((a, b) => b.mediaPorDia - a.mediaPorDia || b.pedidos - a.pedidos);
}
