import type { ConfigAnotaAI } from './conectores/anotaai.ts';
import { pageIdDoToken } from './conectores/anotaai.ts';
import type { ConfigOpenDelivery } from './conectores/opendelivery.ts';
import type { ConfigWhatsApp } from './envio/whatsapp.ts';

/**
 * Lê a configuração das variáveis de ambiente (.env.local / .env.example documentam
 * cada uma). Integrações opcionais só aparecem quando todas as suas variáveis estão
 * preenchidas; preenchimento parcial vira erro, para não falhar calado.
 */
export interface Config {
  ambiente: string;
  fuso: string;
  databaseUrl?: string;
  whatsapp?: ConfigWhatsApp & { appSecret: string; verifyToken: string; limite24h: number; precoMarketingCentavos?: number };
  anotaai?: ConfigAnotaAI;
  openDelivery?: ConfigOpenDelivery;
  regras: { diasHibernacao: number; maxMensagensPorClienteDia: number; janelaAtribuicaoDias: number; diasParaRecuperado: number };
}

export interface ResultadoConfig { config: Config; erros: string[]; avisos: string[] }

type Env = Record<string, string | undefined>;

const val = (env: Env, k: string) => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

function grupo(env: Env, nome: string, obrigatorias: string[], erros: string[]): boolean {
  const cheias = obrigatorias.filter((k) => val(env, k));
  if (cheias.length === 0) return false;
  const faltam = obrigatorias.filter((k) => !val(env, k));
  if (faltam.length) { erros.push(`${nome}: faltam ${faltam.join(', ')}`); return false; }
  return true;
}

function inteiro(env: Env, k: string, padrao: number, erros: string[], min = 0): number {
  const v = val(env, k);
  if (v === undefined) return padrao;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) { erros.push(`${k}: "${v}" não é inteiro ≥ ${min}`); return padrao; }
  return n;
}

export function lerConfig(env: Env = process.env): ResultadoConfig {
  const erros: string[] = [];
  const avisos: string[] = [];
  const config: Config = {
    ambiente: val(env, 'NODE_ENV') ?? 'development',
    fuso: val(env, 'CRM_FUSO') ?? 'America/Sao_Paulo',
    databaseUrl: val(env, 'DATABASE_URL'),
    regras: {
      diasHibernacao: inteiro(env, 'CRM_DIAS_HIBERNACAO', 3, erros),
      maxMensagensPorClienteDia: inteiro(env, 'CRM_MAX_MENSAGENS_CLIENTE_DIA', 1, erros, 1),
      janelaAtribuicaoDias: inteiro(env, 'CRM_JANELA_ATRIBUICAO_DIAS', 3, erros, 1),
      diasParaRecuperado: inteiro(env, 'CRM_DIAS_PARA_RECUPERADO', 90, erros, 1),
    },
  };

  try { new Intl.DateTimeFormat('pt-BR', { timeZone: config.fuso }); } catch { erros.push(`CRM_FUSO: fuso inválido "${config.fuso}"`); }
  if (!config.databaseUrl) avisos.push('DATABASE_URL vazio: sem banco, só o repositório em memória funciona.');
  else if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) erros.push('DATABASE_URL deve começar com postgresql://');

  if (grupo(env, 'WhatsApp', ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'], erros)) {
    const preco = val(env, 'WHATSAPP_PRECO_MARKETING_CENTAVOS');
    const precoN = preco === undefined ? undefined : Number(preco.replace(',', '.'));
    if (precoN !== undefined && !(precoN >= 0)) erros.push(`WHATSAPP_PRECO_MARKETING_CENTAVOS: "${preco}" não é número`);
    if (precoN === undefined) avisos.push('WHATSAPP_PRECO_MARKETING_CENTAVOS vazio: o ROI sai sem custo de mensagem.');
    config.whatsapp = {
      phoneNumberId: val(env, 'WHATSAPP_PHONE_NUMBER_ID')!,
      accessToken: val(env, 'WHATSAPP_ACCESS_TOKEN')!,
      appSecret: val(env, 'WHATSAPP_APP_SECRET')!,
      verifyToken: val(env, 'WHATSAPP_VERIFY_TOKEN')!,
      versao: val(env, 'WHATSAPP_API_VERSION') ?? 'v24.0',
      limite24h: inteiro(env, 'WHATSAPP_LIMITE_24H', 250, erros, 1),
      ...(precoN !== undefined && precoN >= 0 ? { precoMarketingCentavos: precoN } : {}),
    };
  } else if (!erros.some((e) => e.startsWith('WhatsApp'))) {
    avisos.push('WhatsApp não configurado: nada será enviado.');
  }

  if (grupo(env, 'Anota AI', ['ANOTAAI_CLIENT_ID', 'ANOTAAI_CLIENT_SECRET', 'ANOTAAI_TOKEN_LOJA', 'ANOTAAI_LOJA_ID'], erros)) {
    try {
      config.anotaai = {
        lojaId: val(env, 'ANOTAAI_LOJA_ID')!,
        clientId: val(env, 'ANOTAAI_CLIENT_ID')!,
        clientSecret: val(env, 'ANOTAAI_CLIENT_SECRET')!,
        pageId: pageIdDoToken(val(env, 'ANOTAAI_TOKEN_LOJA')!),
      };
    } catch (e) { erros.push(`ANOTAAI_TOKEN_LOJA: ${(e as Error).message}`); }
  }

  if (grupo(env, 'Open Delivery', ['OPENDELIVERY_BASE_URL', 'OPENDELIVERY_CLIENT_ID', 'OPENDELIVERY_CLIENT_SECRET', 'OPENDELIVERY_LOJA_ID'], erros)) {
    const merchants = val(env, 'OPENDELIVERY_MERCHANT_IDS')?.split(',').map((s) => s.trim()).filter(Boolean);
    config.openDelivery = {
      lojaId: val(env, 'OPENDELIVERY_LOJA_ID')!,
      baseUrl: val(env, 'OPENDELIVERY_BASE_URL')!,
      clientId: val(env, 'OPENDELIVERY_CLIENT_ID')!,
      clientSecret: val(env, 'OPENDELIVERY_CLIENT_SECRET')!,
      ...(val(env, 'OPENDELIVERY_TOKEN_URL') ? { tokenUrl: val(env, 'OPENDELIVERY_TOKEN_URL') } : {}),
      ...(merchants?.length ? { merchantIds: merchants } : {}),
    };
  }

  if (!config.anotaai && !config.openDelivery) avisos.push('Nenhuma fonte de pedidos configurada (Anota AI ou Open Delivery).');
  return { config, erros, avisos };
}
