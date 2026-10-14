import type { ControleRegistrado } from '../campanhas/modelo.ts';
import type { StatusEnvio } from '../envio/webhook.ts';
import type { PedidoSalvo } from '../repositorio.ts';
import { diasDeCalendario, FUSO_PADRAO } from '../segmentacao/tempo.ts';

const DIA = 86_400_000;

export interface EnvioParaAtribuicao {
  id: string;
  campanhaId: string;
  clienteId: string;
  /** Momento do envio. */
  em: Date;
  status: StatusEnvio;
  contabilizaReceita: boolean;
  /** pricing.category do webhook (marketing, utility...). */
  categoria?: string;
  /** pricing.type do webhook: "regular" é cobrado; "free_*" não. */
  tipoCobranca?: string;
}

export interface OpcoesAtribuicao {
  /**
   * Dias depois do envio em que um pedido ainda conta como influenciado.
   * Exposto e configurável de propósito — o Retorne esconde o dele, e o número
   * deixa de ser conferível. PROVISÓRIO: 3 dias, conservador.
   */
  janelaDias: number;
  /**
   * Mais de tantos dias de calendário sem comprar antes do envio = cliente recuperado.
   * Mesmo corte e mesma comparação de "perdido" (> 90): quem é perdido e volta é recuperado.
   */
  diasParaRecuperado: number;
  /** Preço por mensagem cobrada, por categoria, em centavos. Vem da tabela de preços vigente da Meta. */
  precoPorMensagemCentavos: Record<string, number>;
  fuso?: string;
}

export const OPCOES_ATRIBUICAO_PADRAO: Omit<OpcoesAtribuicao, 'precoPorMensagemCentavos'> = {
  janelaDias: 3,
  diasParaRecuperado: 90,
};

export interface Periodo {
  inicio: Date;
  /** Exclusivo. */
  fim: Date;
}

const chave = (p: PedidoSalvo) => `${p.fonte}|${p.lojaId}|${p.idExterno}`;
const conta = (e: EnvioParaAtribuicao) => (e.status === 'entregue' || e.status === 'lido') && e.contabilizaReceita;
const dentro = (d: Date, p: Periodo) => d.getTime() >= p.inicio.getTime() && d.getTime() < p.fim.getTime();

/**
 * Último toque: cada pedido concluído vai para o envio ENTREGUE mais recente ao mesmo
 * cliente, feito antes do pedido e dentro da janela. Um pedido nunca conta para duas
 * campanhas. Envio só enviado (sem entrega) não influencia ninguém.
 */
export function atribuirPedidos(
  pedidos: PedidoSalvo[],
  envios: EnvioParaAtribuicao[],
  janelaDias: number,
): Map<string, EnvioParaAtribuicao> {
  const porCliente = new Map<string, EnvioParaAtribuicao[]>();
  for (const e of envios) {
    if (!conta(e)) continue;
    const l = porCliente.get(e.clienteId) ?? [];
    l.push(e);
    porCliente.set(e.clienteId, l);
  }
  for (const l of porCliente.values()) l.sort((a, b) => b.em.getTime() - a.em.getTime());

  const r = new Map<string, EnvioParaAtribuicao>();
  for (const p of pedidos) {
    if (p.status !== 'concluido') continue;
    const t = p.criadoEm.getTime();
    const toque = porCliente.get(p.clienteId)?.find((e) => e.em.getTime() < t);
    if (toque && t - toque.em.getTime() <= janelaDias * DIA) r.set(chave(p), toque);
  }
  return r;
}

export interface Controle {
  tratados: number;
  controle: number;
  /** Fração que comprou dentro da janela. */
  conversaoTratados: number;
  conversaoControle: number;
  /** Diferença de conversão, em pontos percentuais. */
  liftPontos: number;
  /** (receita por tratado − receita por controle) × tratados, em centavos. Pode ser negativa. */
  receitaIncrementalCentavos: number;
  /** Menos de 30 em algum dos grupos: a diferença ainda pode ser acaso. */
  amostraPequena: boolean;
}

export interface ReceitaDaCampanha {
  campanhaId: string;
  entregues: number;
  lidas: number;
  pedidosAtribuidos: number;
  receitaCentavos: number;
  custoCentavos: number;
  /** Receita ÷ custo (ex.: 44.7 = 44,7x). null sem custo. */
  roi: number | null;
  controle: Controle | null;
}

export interface RelatorioDeReceita {
  periodo: Periodo;
  janelaDias: number;
  receitaTotalCentavos: number;
  receitaInfluenciadaCentavos: number;
  receitaRecuperadaCentavos: number;
  receitaRecorrenteInfluenciadaCentavos: number;
  /** Influenciada ÷ total (0–1). */
  participacao: number;
  custoCentavos: number;
  /** Custo de campanhas marcadas para não contar receita (ex.: transacionais); fora do ROI. */
  custoNaoContabilizadoCentavos: number;
  roi: number | null;
  pedidosAtribuidos: number;
  clientesRecuperados: number;
  mensagensEntregues: number;
  porCampanha: ReceitaDaCampanha[];
  avisos: string[];
}

/** Primeiro toque (envio entregue ou controle) de cada cliente por campanha no período. */
function primeiros<T extends { campanhaId: string; clienteId: string; em: Date }>(itens: T[], periodo: Periodo) {
  const m = new Map<string, Map<string, Date>>();
  for (const x of itens) {
    if (!dentro(x.em, periodo)) continue;
    const porCliente = m.get(x.campanhaId) ?? new Map<string, Date>();
    const atual = porCliente.get(x.clienteId);
    if (!atual || x.em < atual) porCliente.set(x.clienteId, x.em);
    m.set(x.campanhaId, porCliente);
  }
  return m;
}

export function relatorioDeReceita(entrada: {
  periodo: Periodo;
  pedidos: PedidoSalvo[];
  envios: EnvioParaAtribuicao[];
  controles?: ControleRegistrado[];
  opcoes: OpcoesAtribuicao;
}): RelatorioDeReceita {
  const { periodo, pedidos, envios, opcoes } = entrada;
  const janela = opcoes.janelaDias * DIA;
  const avisos: string[] = [];
  const concluidos = pedidos.filter((p) => p.status === 'concluido');
  const doPeriodo = concluidos.filter((p) => dentro(p.criadoEm, periodo));

  // Histórico de compras de cada cliente, em ordem, para recuperado e recorrente.
  const historico = new Map<string, Date[]>();
  for (const p of concluidos) historico.set(p.clienteId, [...(historico.get(p.clienteId) ?? []), p.criadoEm]);
  for (const l of historico.values()) l.sort((a, b) => a.getTime() - b.getTime());

  const atribuicao = atribuirPedidos(doPeriodo, envios, opcoes.janelaDias);
  const porCampanha = new Map<string, ReceitaDaCampanha>();
  const campanha = (id: string) => {
    let c = porCampanha.get(id);
    if (!c) {
      c = { campanhaId: id, entregues: 0, lidas: 0, pedidosAtribuidos: 0, receitaCentavos: 0, custoCentavos: 0, roi: null, controle: null };
      porCampanha.set(id, c);
    }
    return c;
  };

  let influenciada = 0, recuperada = 0, recorrente = 0;
  const recuperados = new Set<string>();
  for (const p of doPeriodo) {
    const toque = atribuicao.get(chave(p));
    if (!toque) continue;
    influenciada += p.totalCentavos;
    const c = campanha(toque.campanhaId);
    c.pedidosAtribuidos++;
    c.receitaCentavos += p.totalCentavos;

    const antes = historico.get(p.clienteId)!.filter((d) => d.getTime() < p.criadoEm.getTime());
    const ultimaAntesDoEnvio = antes.filter((d) => d.getTime() < toque.em.getTime()).at(-1);
    if (ultimaAntesDoEnvio && diasDeCalendario(ultimaAntesDoEnvio, toque.em, opcoes.fuso ?? FUSO_PADRAO) > opcoes.diasParaRecuperado) {
      recuperada += p.totalCentavos;
      recuperados.add(p.clienteId);
    }
    if (antes.length >= 2) recorrente += p.totalCentavos;
  }

  // Custo: mensagens cobradas no período, pelo preço da categoria.
  let custo = 0, custoFora = 0, entregues = 0;
  const semPreco = new Set<string>();
  for (const e of envios) {
    if (!dentro(e.em, periodo)) continue;
    const c = campanha(e.campanhaId);
    if (e.status === 'entregue' || e.status === 'lido') { c.entregues++; if (e.contabilizaReceita) entregues++; }
    if (e.status === 'lido') c.lidas++;
    if (e.tipoCobranca !== 'regular') continue;
    const preco = e.categoria ? opcoes.precoPorMensagemCentavos[e.categoria] : undefined;
    if (preco === undefined) { semPreco.add(e.categoria ?? 'sem categoria'); continue; }
    c.custoCentavos += preco;
    if (e.contabilizaReceita) custo += preco; else custoFora += preco;
  }
  if (semPreco.size) avisos.push(`Sem preço configurado para: ${[...semPreco].join(', ')}. Essas mensagens ficaram fora do custo.`);

  // Grupo de controle: compara compra de quem recebeu com a de quem foi sorteado para não receber.
  // Intenção de tratar: conta todo envio da campanha, entregue ou não. O controle inclui
  // gente cuja mensagem também falharia; comparar só os entregues inflaria o efeito.
  const tratadosPorCampanha = primeiros(envios, periodo);
  const controlePorCampanha = primeiros(entrada.controles ?? [], periodo);
  const receitaNaJanela = (clienteId: string, em: Date) =>
    concluidos
      .filter((p) => p.clienteId === clienteId && p.criadoEm.getTime() > em.getTime() && p.criadoEm.getTime() - em.getTime() <= janela)
      .reduce((s, p) => s + p.totalCentavos, 0);

  for (const [campanhaId, grupoC] of controlePorCampanha) {
    const grupoT = tratadosPorCampanha.get(campanhaId) ?? new Map<string, Date>();
    if (!grupoT.size || !grupoC.size) continue;
    const medir = (g: Map<string, Date>) => {
      let compraram = 0, receita = 0;
      for (const [clienteId, em] of g) {
        const r = receitaNaJanela(clienteId, em);
        if (r > 0) compraram++;
        receita += r;
      }
      return { conversao: compraram / g.size, receitaPorMembro: receita / g.size };
    };
    const t = medir(grupoT), k = medir(grupoC);
    campanha(campanhaId).controle = {
      tratados: grupoT.size,
      controle: grupoC.size,
      conversaoTratados: t.conversao,
      conversaoControle: k.conversao,
      liftPontos: Math.round((t.conversao - k.conversao) * 1000) / 10,
      receitaIncrementalCentavos: Math.round((t.receitaPorMembro - k.receitaPorMembro) * grupoT.size),
      amostraPequena: grupoT.size < 30 || grupoC.size < 30,
    };
  }

  for (const c of porCampanha.values()) c.roi = c.custoCentavos > 0 ? Math.round((c.receitaCentavos / c.custoCentavos) * 10) / 10 : null;

  const total = doPeriodo.reduce((s, p) => s + p.totalCentavos, 0);
  return {
    periodo,
    janelaDias: opcoes.janelaDias,
    receitaTotalCentavos: total,
    receitaInfluenciadaCentavos: influenciada,
    receitaRecuperadaCentavos: recuperada,
    receitaRecorrenteInfluenciadaCentavos: recorrente,
    participacao: total ? influenciada / total : 0,
    custoCentavos: custo,
    custoNaoContabilizadoCentavos: custoFora,
    roi: custo > 0 ? Math.round((influenciada / custo) * 10) / 10 : null,
    pedidosAtribuidos: atribuicao.size,
    clientesRecuperados: recuperados.size,
    mensagensEntregues: entregues,
    porCampanha: [...porCampanha.values()].sort((a, b) => b.receitaCentavos - a.receitaCentavos),
    avisos,
  };
}
