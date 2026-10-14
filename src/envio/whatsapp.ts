import { userAgent, type Fetch } from '../conectores/http.ts';
import type { Criativo } from './variaveis.ts';

export interface ConfigWhatsApp {
  phoneNumberId: string;
  accessToken: string;
  /** Versão da Graph API. */
  versao?: string;
  fetch?: Fetch;
}

export type ResultadoEnvio =
  | { ok: true; wamid: string }
  | { ok: false; codigo?: number; mensagem: string };

/**
 * Envia um template pela WhatsApp Cloud API.
 * POST /{phone-number-id}/messages, type "template".
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
export async function enviarTemplate(
  cfg: ConfigWhatsApp,
  telefoneE164: string,
  criativo: Criativo,
  parametros: string[],
): Promise<ResultadoEnvio> {
  const f = cfg.fetch ?? fetch;
  const url = `https://graph.facebook.com/${cfg.versao ?? 'v24.0'}/${cfg.phoneNumberId}/messages`;
  const corpo = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: telefoneE164.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: criativo.nomeTemplate,
      language: { code: criativo.idioma },
      ...(parametros.length
        ? { components: [{ type: 'body', parameters: parametros.map((text) => ({ type: 'text', text })) }] }
        : {}),
    },
  };

  let r: Response;
  try {
    r = await f(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json', 'User-Agent': userAgent() },
      body: JSON.stringify(corpo),
    });
  } catch (e) {
    return { ok: false, codigo: 131000, mensagem: `Falha de rede: ${(e as Error).message}` };
  }

  const j = (await r.json().catch(() => ({}))) as {
    messages?: Array<{ id: string }>;
    error?: { code?: number; message?: string; error_data?: { details?: string } };
  };
  const wamid = j.messages?.[0]?.id;
  if (r.ok && wamid) return { ok: true, wamid };
  return {
    ok: false,
    codigo: j.error?.code,
    mensagem: j.error?.error_data?.details ?? j.error?.message ?? `HTTP ${r.status}`,
  };
}
