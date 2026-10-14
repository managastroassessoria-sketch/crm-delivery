// Canais cujo pedido não identifica o cliente final para software de terceiros:
// iFood não compartilha o telefone, 99Food não envia o consumidor, Keeta criptografa.
const MARKETPLACES = /ifood|keeta|99\s*food|rappi|aiqfome/i;

export function ehMarketplace(...campos: Array<string | undefined | null>): boolean {
  return campos.some((c) => typeof c === 'string' && MARKETPLACES.test(c));
}
