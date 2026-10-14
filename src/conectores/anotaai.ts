import { adaptarAnotaAI, type PedidoAnotaAI } from '../adaptadores/anotaai.ts';
import { ingerirPedido, type OpcoesIngestao } from '../ingestao.ts';
import type { Repositorio } from '../repositorio.ts';
import { chamarAutenticado, ErroHttp, ProvedorDeToken, type Fetch } from './http.ts';
import type { ResumoSincronizacao } from './opendelivery.ts';

const BASE_PADRAO = 'https://gateway-partners.anota.ai';

export interface ConfigAnotaAI {
  lojaId: string;
  /** client_id e client_secret do parceiro, no Portal de Integração. */
  clientId: string;
  clientSecret: string;
  /** idpage do token da loja no Portal de Integração (vai no header x-page-id). */
  pageId: string;
  baseUrl?: string;
  fetch?: Fetch;
}

interface ListaAnotaAI {
  success: boolean;
  info: { docs: Array<{ _id: string; check: number }>; count: number; limit: number; currentpage: number };
}

/** Lê o idpage do token da loja exibido no Portal de Integração (JWT; só o payload é usado). */
export function pageIdDoToken(tokenDaLoja: string): string {
  const payload = tokenDaLoja.split('.')[1];
  if (!payload) throw new Error('Token da loja não parece um JWT');
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { idpage?: string };
  if (!json.idpage) throw new Error('Token da loja sem o campo idpage');
  return json.idpage;
}

/**
 * Um ciclo de sincronização do Anota AI.
 *
 * A API só lista pedidos DO DIA. Consequências:
 * - não existe importação de histórico; a base começa quando a integração liga;
 * - o ciclo precisa rodar ao longo do dia e uma última vez perto da meia-noite,
 *   senão pedidos finalizados tarde se perdem.
 *
 * Apenas leitura: o conector nunca chama aceite, cancelamento, pronto ou finalização.
 */
export async function sincronizarAnotaAI(
  cfg: ConfigAnotaAI,
  repo: Repositorio,
  opcoes: OpcoesIngestao = {},
  token?: ProvedorDeToken,
): Promise<ResumoSincronizacao> {
  const f = cfg.fetch ?? fetch;
  const base = (cfg.baseUrl ?? BASE_PADRAO).replace(/\/$/, '');
  const api = `${base}/api-old/partnerauth/v2`;
  const tk =
    token ??
    new ProvedorDeToken({
      url: `${base}/integ/integ-oauth-api/oauth-client/token`,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      fetch: f,
    });
  const headers = { 'x-page-id': cfg.pageId };
  const resumo: ResumoSincronizacao = { eventos: 0, confirmados: 0, resultados: {}, erros: [] };

  // Lista paginada (100 por página). `filtro` acrescenta parâmetros de status.
  async function listar(filtro: Record<string, string>) {
    const docs: ListaAnotaAI['info']['docs'] = [];
    for (let pagina = 1; ; pagina++) {
      const q = new URLSearchParams({ excludeIfood: '1', currentpage: String(pagina), ...filtro });
      const url = `${api}/ping/list?${q}`;
      const r = await chamarAutenticado(f, tk, url, { headers });
      if (!r.ok) throw new ErroHttp(r.status, await r.text(), url);
      const lista = (await r.json()) as ListaAnotaAI;
      docs.push(...lista.info.docs);
      if (lista.info.docs.length === 0 || docs.length >= lista.info.count) return docs;
    }
  }

  async function processar(id: string) {
    try {
      const url = `${api}/ping/get/${encodeURIComponent(id)}`;
      const r = await chamarAutenticado(f, tk, url, { headers });
      if (!r.ok) throw new ErroHttp(r.status, await r.text(), url);
      const corpo = (await r.json()) as { info: PedidoAnotaAI };
      const resultado = await ingerirPedido(repo, adaptarAnotaAI(corpo.info, cfg.lojaId), opcoes);
      const chave = resultado.status === 'descartado' ? `descartado:${resultado.motivo}` : resultado.status;
      resumo.resultados[chave] = (resumo.resultados[chave] ?? 0) + 1;
    } catch (e) {
      resumo.erros.push(`${id}: ${(e as Error).message}`);
    }
  }

  // Sem filtro de status a API devolve check 0–3; só o 3 (finalizado) vira histórico.
  const pendentes: string[] = [];
  for (const d of await listar({})) {
    if (d.check !== 3) continue;
    if (await repo.buscarPedido('anota_ai', cfg.lojaId, d._id)) continue;
    if (await repo.buscarDescarte('anota_ai', cfg.lojaId, d._id)) continue; // não busca de novo o que já foi descartado
    pendentes.push(d._id);
  }

  // Cancelados (check 4) só interessam se o pedido já tinha sido importado: atualizam o status.
  for (const d of await listar({ cancelled: '1' })) {
    const salvo = await repo.buscarPedido('anota_ai', cfg.lojaId, d._id);
    if (salvo && salvo.status !== 'cancelado') pendentes.push(d._id);
  }

  resumo.eventos = pendentes.length;
  for (const id of pendentes) await processar(id);
  return resumo;
}
