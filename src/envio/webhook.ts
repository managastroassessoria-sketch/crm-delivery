import { createHmac, timingSafeEqual } from 'node:crypto';
import { interpretarErro } from './erros.ts';

/**
 * Confere o cabeçalho X-Hub-Signature-256 ("sha256=<hex>"): HMAC-SHA256 do corpo
 * BRUTO com o app secret. Sem isso, qualquer um pode forjar "entregue" e "lido".
 */
export function assinaturaValida(corpoBruto: string | Buffer, cabecalho: string | undefined, appSecret: string): boolean {
  if (!cabecalho?.startsWith('sha256=')) return false;
  const esperado = createHmac('sha256', appSecret).update(corpoBruto).digest();
  const recebido = Buffer.from(cabecalho.slice(7), 'hex');
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

/** Verificação de assinatura do webhook (GET com hub.mode, hub.verify_token, hub.challenge). */
export function responderVerificacao(query: Record<string, string | undefined>, verifyToken: string): string | null {
  return query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === verifyToken ? (query['hub.challenge'] ?? null) : null;
}

export type StatusMeta = 'sent' | 'delivered' | 'read' | 'played' | 'failed';
export type StatusEnvio = 'planejado' | 'enviado' | 'entregue' | 'lido' | 'falhou' | 'cancelado';

export interface AtualizacaoStatus {
  wamid: string;
  status: StatusEnvio;
  em: Date;
  telefone: string;
  codigoErro?: number;
  detalheErro?: string;
  /** Categoria cobrada (marketing, utility...). Vem em um dos webhooks de sent/delivered/read. */
  categoria?: string;
  /** "regular" = cobrado; "free_*" = gratuito. */
  tipoCobranca?: string;
}

export interface MensagemRecebida {
  telefone: string;
  texto: string;
  em: Date;
}

const MAPA: Record<StatusMeta, StatusEnvio> = { sent: 'enviado', delivered: 'entregue', read: 'lido', played: 'lido', failed: 'falhou' };

interface PayloadMeta {
  entry?: Array<{ changes?: Array<{ field?: string; value?: {
    statuses?: Array<{
      id: string; status: StatusMeta; timestamp: string; recipient_id: string;
      pricing?: { category?: string; type?: string };
      errors?: Array<{ code?: number; message?: string; error_data?: { details?: string } }>;
    }>;
    messages?: Array<{ from: string; timestamp: string; type: string; text?: { body?: string }; button?: { text?: string } }>;
  } }> }>;
}

const mais = (t: string) => `+${t.replace(/^\+/, '')}`;

/** Extrai status de envio e mensagens recebidas de um webhook da Cloud API. */
export function interpretarWebhook(payload: unknown): { status: AtualizacaoStatus[]; mensagens: MensagemRecebida[] } {
  const p = payload as PayloadMeta;
  const status: AtualizacaoStatus[] = [];
  const mensagens: MensagemRecebida[] = [];
  for (const entrada of p.entry ?? []) {
    for (const mudanca of entrada.changes ?? []) {
      if (mudanca.field !== 'messages') continue;
      for (const s of mudanca.value?.statuses ?? []) {
        const mapeado = MAPA[s.status];
        if (!mapeado) continue;
        const erro = s.errors?.[0];
        status.push({
          wamid: s.id,
          status: mapeado,
          em: new Date(Number(s.timestamp) * 1000),
          telefone: mais(s.recipient_id),
          ...(erro ? { codigoErro: erro.code, detalheErro: erro.error_data?.details ?? erro.message } : {}),
          ...(s.pricing ? { categoria: s.pricing.category, tipoCobranca: s.pricing.type } : {}),
        });
      }
      for (const m of mudanca.value?.messages ?? []) {
        const texto = m.text?.body ?? m.button?.text;
        if (texto) mensagens.push({ telefone: mais(m.from), texto, em: new Date(Number(m.timestamp) * 1000) });
      }
    }
  }
  return { status, mensagens };
}

const ORDEM: Record<StatusEnvio, number> = { planejado: 0, enviado: 1, entregue: 2, lido: 3, falhou: 1, cancelado: 0 };

/**
 * Aplica um status novo sem regredir. Webhooks podem chegar fora de ordem, e o
 * "entregue" pode nem chegar quando a mensagem é lida na hora: lido implica entregue.
 * Falha só vale enquanto a mensagem não foi entregue.
 */
export function proximoStatus(atual: StatusEnvio, novo: StatusEnvio): StatusEnvio {
  if (atual === 'cancelado' || atual === 'lido') return atual;
  if (novo === 'falhou') return atual === 'entregue' ? atual : 'falhou';
  if (atual === 'falhou') return novo === 'entregue' || novo === 'lido' ? novo : atual;
  return ORDEM[novo] > ORDEM[atual] ? novo : atual;
}

const PALAVRAS_DESCADASTRO = new Set(['sair', 'parar', 'stop', 'descadastrar', 'remover', 'nao quero mais receber', 'nao quero mais']);

/**
 * Pedido de descadastro por mensagem. Só a mensagem inteira conta — "quero cancelar
 * meu pedido" não é descadastro, e por isso "cancelar" fica fora da lista.
 */
export function ehPedidoDeDescadastro(texto: string): boolean {
  const t = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  return PALAVRAS_DESCADASTRO.has(t);
}

export interface ConsequenciasDoWebhook {
  /** Telefones a descadastrar: pediram por mensagem ou a Meta devolveu 131050. */
  descadastrar: string[];
  /** Telefones sem WhatsApp (131026). */
  semWhatsapp: string[];
  /** Envios que voltam para a fila: status de volta a "planejado", tentativas + 1, não antes de `depoisDe`. */
  reenviar: Array<{ wamid: string; depoisDe: Date }>;
  /** Envios cujo template precisa ser pausado (erro no template). */
  pausarCriativoDoEnvio: Array<{ wamid: string; explicacao: string }>;
  contaPausada?: { codigo?: number; explicacao: string };
}

/**
 * O que fazer com um webhook além de atualizar o status. A Meta costuma avisar
 * 131026, 131050 e 131049 no status "failed", não na resposta do envio — sem isto,
 * esses clientes nunca seriam descadastrados ou marcados, e um 131049 ("tente em
 * 24 h") viraria falha definitiva.
 */
export function consequenciasDoWebhook(w: { status: AtualizacaoStatus[]; mensagens: MensagemRecebida[] }): ConsequenciasDoWebhook {
  const r: ConsequenciasDoWebhook = { descadastrar: [], semWhatsapp: [], reenviar: [], pausarCriativoDoEnvio: [] };
  for (const m of w.mensagens) if (ehPedidoDeDescadastro(m.texto)) r.descadastrar.push(m.telefone);
  for (const s of w.status) {
    if (s.status !== 'falhou' || s.codigoErro === undefined) continue;
    const erro = interpretarErro(s.codigoErro);
    switch (erro.acao) {
      case 'descadastrar': r.descadastrar.push(s.telefone); break;
      case 'marcar_sem_whatsapp': r.semWhatsapp.push(s.telefone); break;
      case 'reenviar_amanha': r.reenviar.push({ wamid: s.wamid, depoisDe: new Date(s.em.getTime() + 86_400_000) }); break;
      case 'reenviar': r.reenviar.push({ wamid: s.wamid, depoisDe: new Date(s.em.getTime() + 5 * 60_000) }); break;
      case 'pausar_criativo': r.pausarCriativoDoEnvio.push({ wamid: s.wamid, explicacao: erro.explicacao }); break;
      case 'pausar_conta': r.contaPausada = { codigo: s.codigoErro, explicacao: erro.explicacao }; break;
    }
  }
  r.descadastrar = [...new Set(r.descadastrar)];
  r.semWhatsapp = [...new Set(r.semWhatsapp)];
  return r;
}
