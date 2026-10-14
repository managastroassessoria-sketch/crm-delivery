import { adaptarOpenDelivery, type PedidoOpenDelivery } from '../adaptadores/opendelivery.ts';
import { ingerirPedido, type OpcoesIngestao } from '../ingestao.ts';
import type { ResultadoIngestao } from '../modelo.ts';
import type { Repositorio } from '../repositorio.ts';
import { chamarAutenticado, ErroHttp, ProvedorDeToken, type Fetch } from './http.ts';

export interface ConfigOpenDelivery {
  /** Loja do CRM à qual estes pedidos pertencem. */
  lojaId: string;
  /** URL base do app de pedido, ex.: a do Delivery Direto. */
  baseUrl: string;
  /** URL do token OAuth2; na especificação é `oauth/token` relativo à base. */
  tokenUrl?: string;
  clientId: string;
  clientSecret: string;
  /** Lojas do app de pedido a consultar (header x-polling-merchants). */
  merchantIds?: string[];
  fetch?: Fetch;
}

interface EventoPolling {
  eventId: string;
  eventType: string;
  orderId: string;
  orderURL?: string;
  createdAt: string;
}

export interface ResumoSincronizacao {
  eventos: number;
  confirmados: number;
  resultados: Record<string, number>;
  erros: string[];
}

// Só estes eventos mudam o histórico do CRM; os intermediários são confirmados e ignorados.
const EVENTOS_RELEVANTES = new Set(['CONCLUDED', 'DELIVERED', 'CANCELLED']);

function contar(resumo: ResumoSincronizacao, r: ResultadoIngestao) {
  const chave = r.status === 'descartado' ? `descartado:${r.motivo}` : r.status;
  resumo.resultados[chave] = (resumo.resultados[chave] ?? 0) + 1;
}

/**
 * Um ciclo de sincronização: consulta /v1/events:polling, busca os pedidos dos
 * eventos relevantes, ingere e confirma em /v1/events/acknowledgment.
 *
 * Evento cujo processamento falha NÃO é confirmado: volta no próximo ciclo.
 */
export async function sincronizarOpenDelivery(
  cfg: ConfigOpenDelivery,
  repo: Repositorio,
  opcoes: OpcoesIngestao = {},
  token?: ProvedorDeToken,
): Promise<ResumoSincronizacao> {
  const f = cfg.fetch ?? fetch;
  const base = cfg.baseUrl.replace(/\/$/, '');
  const tk =
    token ??
    new ProvedorDeToken({
      url: cfg.tokenUrl ?? `${base}/oauth/token`,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      escopo: 'od.all',
      fetch: f,
    });

  const resumo: ResumoSincronizacao = { eventos: 0, confirmados: 0, resultados: {}, erros: [] };
  const headers: Record<string, string> = {};
  if (cfg.merchantIds?.length) headers['x-polling-merchants'] = cfg.merchantIds.join(',');

  const url = `${base}/v1/events:polling`;
  const r = await chamarAutenticado(f, tk, url, { headers });
  if (r.status === 204) return resumo;
  if (!r.ok) throw new ErroHttp(r.status, await r.text(), url);

  const eventos = (await r.json()) as EventoPolling[];
  resumo.eventos = eventos.length;
  const confirmar: Array<{ id: string; orderId: string; eventType: string }> = [];

  for (const ev of eventos) {
    try {
      if (EVENTOS_RELEVANTES.has(ev.eventType)) {
        const urlPedido = ev.orderURL ?? `${base}/v1/orders/${encodeURIComponent(ev.orderId)}`;
        const rp = await chamarAutenticado(f, tk, urlPedido);
        if (!rp.ok) throw new ErroHttp(rp.status, await rp.text(), urlPedido);
        const pedido = (await rp.json()) as PedidoOpenDelivery;
        const resultado = await ingerirPedido(repo, adaptarOpenDelivery(pedido, cfg.lojaId, ev.eventType), opcoes);
        contar(resumo, resultado);
      }
      confirmar.push({ id: ev.eventId, orderId: ev.orderId, eventType: ev.eventType });
    } catch (e) {
      resumo.erros.push(`${ev.eventId} (${ev.orderId}): ${(e as Error).message}`);
    }
  }

  if (confirmar.length) {
    const urlAck = `${base}/v1/events/acknowledgment`;
    const ra = await chamarAutenticado(f, tk, urlAck, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmar),
    });
    if (!ra.ok) throw new ErroHttp(ra.status, await ra.text(), urlAck);
    resumo.confirmados = confirmar.length;
  }
  return resumo;
}
