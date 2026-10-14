import type { Telefone } from './modelo.ts';

// DDDs válidos no Brasil (Anatel).
const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * Normaliza um telefone brasileiro e classifica o tipo de linha.
 *
 * Classificar na entrada resolve o erro 131026 do original: no Retorne, telefone
 * fixo entra no segmento, vai para o disparo de WhatsApp e falha. Aqui o fixo é
 * guardado (o cliente continua identificado), mas marcado para que campanhas de
 * WhatsApp o excluam.
 *
 * Decisão conservadora: número de 10 dígitos que começa com 6–9 é celular antigo,
 * sem o nono dígito. Ele é marcado inválido em vez de "corrigido", porque inserir
 * o 9 pode mandar mensagem para outra pessoa.
 */
export function normalizarTelefone(entrada: string | null | undefined): Telefone {
  const original = entrada ?? '';
  const invalido: Telefone = { original, e164: null, tipo: 'invalido' };

  let d = original.replace(/\D/g, '');
  if (d.length === 0) return invalido;

  // Prefixo de país e zero de tronco.
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if ((d.length === 11 || d.length === 12) && d.startsWith('0')) d = d.slice(1);

  if (d.length !== 10 && d.length !== 11) return invalido;

  const ddd = Number(d.slice(0, 2));
  if (!DDDS.has(ddd)) return invalido;

  const assinante = d.slice(2);
  const primeiro = assinante[0];

  if (assinante.length === 9 && primeiro === '9') {
    return { original, e164: `+55${d}`, tipo: 'celular' };
  }
  if (assinante.length === 8 && primeiro >= '2' && primeiro <= '5') {
    return { original, e164: `+55${d}`, tipo: 'fixo' };
  }
  return invalido;
}
