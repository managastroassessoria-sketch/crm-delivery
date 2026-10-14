export type Fetch = typeof fetch;

/**
 * User-Agent no formato exigido pelo Anota AI e aplicado a todas as fontes:
 * <serviço>/<versão> (<ambiente>; <runtime>). Header ausente ou genérico pode
 * cair em bloqueio de borda ou rate limit mais agressivo.
 */
export function userAgent(ambiente = process.env.NODE_ENV ?? 'production'): string {
  return `crm-ingestao/0.1.0 (${ambiente}; Node.js/${process.versions.node})`;
}

export class ErroHttp extends Error {
  readonly status: number;
  readonly corpo: string;
  constructor(status: number, corpo: string, url: string) {
    super(`HTTP ${status} em ${url}: ${corpo.slice(0, 200)}`);
    this.status = status;
    this.corpo = corpo;
  }
}

interface TokenEmCache {
  valor: string;
  expiraEm: number;
}

/**
 * Token OAuth2 client_credentials com cache. Reutiliza até 60 s antes de expirar e
 * renova em 401 — as duas fontes pedem isso, e o Anota AI limita a rota de token
 * a 15 requisições por minuto.
 */
export class ProvedorDeToken {
  private cache: TokenEmCache | undefined;
  private readonly url: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetch: Fetch;
  private readonly agora: () => number;
  private readonly escopo?: string;

  constructor(cfg: {
    url: string;
    clientId: string;
    clientSecret: string;
    escopo?: string;
    fetch?: Fetch;
    agora?: () => number;
  }) {
    this.url = cfg.url;
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
    this.escopo = cfg.escopo;
    this.fetch = cfg.fetch ?? fetch;
    this.agora = cfg.agora ?? Date.now;
  }

  invalidar() {
    this.cache = undefined;
  }

  async obter(): Promise<string> {
    if (this.cache && this.cache.expiraEm - 60_000 > this.agora()) return this.cache.valor;

    const corpo = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    if (this.escopo) corpo.set('scope', this.escopo);

    const r = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent() },
      body: corpo,
    });
    const texto = await r.text();
    if (!r.ok) throw new ErroHttp(r.status, texto, this.url);

    const j = JSON.parse(texto) as Record<string, unknown>;
    // OAuth padrão (access_token/expires_in) ou o formato do Anota AI (accessToken/expiresIn).
    const valor = (j.access_token ?? j.accessToken) as string | undefined;
    const expira = Number(j.expires_in ?? j.expiresIn ?? 3600);
    if (!valor) throw new Error(`Resposta de token sem access_token em ${this.url}`);

    this.cache = { valor, expiraEm: this.agora() + expira * 1000 };
    return valor;
  }
}

/** Faz a chamada autenticada e, em 401, renova o token e tenta uma vez mais. */
export async function chamarAutenticado(
  fetchFn: Fetch,
  token: ProvedorDeToken,
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const tentar = async () =>
    fetchFn(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await token.obter()}`, 'User-Agent': userAgent() },
    });

  let r = await tentar();
  if (r.status === 401) {
    token.invalidar();
    r = await tentar();
  }
  return r;
}
