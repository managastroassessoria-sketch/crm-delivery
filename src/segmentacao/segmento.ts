import { CAMPOS, OPERADORES_POR_TIPO, ROTULO_OPERADOR, type Campo, type DefinicaoCampo, type Operador } from './campos.ts';
import { chaveProduto, type PerfilCliente } from './perfil.ts';

export type ValorCondicao = number | string | boolean | [number, number];

export interface Condicao {
  campo: Campo;
  operador: Operador;
  /** Dinheiro em reais (ex.: 50 = R$ 50,00); "entre" recebe [mínimo, máximo], inclusivo. */
  valor: ValorCondicao;
}

export interface Conjunto {
  tipo: 'E' | 'OU';
  condicoes: Condicao[];
}

export type Canal = 'whatsapp' | 'sms' | 'email';

export interface Segmento {
  /** Como os conjuntos se combinam entre si. */
  combinar: 'E' | 'OU';
  conjuntos: Conjunto[];
  /** Canal da campanha; liga as travas de alcance correspondentes. */
  canal?: Canal;
}

/** Por que um cliente que bate na regra não entra na lista de envio. */
export type MotivoExclusao = 'descadastrado' | 'telefone_fixo' | 'telefone_central' | 'sem_whatsapp' | 'sem_email';

export interface ResultadoSegmento {
  /** Clientes que batem na regra E podem receber pelo canal. */
  clienteIds: string[];
  /** Clientes que batem na regra. */
  populacaoDaRegra: number;
  /** Quem bateu na regra mas ficou de fora, por motivo. */
  excluidos: Partial<Record<MotivoExclusao, number>>;
}

const campo = (c: Campo): DefinicaoCampo => CAMPOS[c];

/** Erros de montagem, em português, prontos para mostrar na tela. Lista vazia = segmento válido. */
export function validarSegmento(s: Segmento): string[] {
  const erros: string[] = [];
  if (!s.conjuntos.length) erros.push('O segmento precisa de ao menos um conjunto de condições.');
  s.conjuntos.forEach((cj, i) => {
    const onde = `Conjunto ${i + 1}`;
    if (!cj.condicoes.length) erros.push(`${onde}: sem condições.`);
    for (const c of cj.condicoes) {
      const def = (CAMPOS as Record<string, DefinicaoCampo>)[c.campo];
      if (!def) { erros.push(`${onde}: campo desconhecido "${c.campo}".`); continue; }
      if (!OPERADORES_POR_TIPO[def.tipo].includes(c.operador)) {
        erros.push(`${onde}: "${def.rotulo}" não aceita "${ROTULO_OPERADOR[c.operador] ?? c.operador}".`);
        continue;
      }
      const v = c.valor;
      if (c.operador === 'entre') {
        if (!Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== 'number')) {
          erros.push(`${onde}: "${def.rotulo} entre" precisa de dois números.`);
        } else if (v[0] > v[1]) {
          erros.push(`${onde}: em "${def.rotulo} entre", o mínimo (${v[0]}) é maior que o máximo (${v[1]}).`);
        }
      } else if ((def.tipo === 'numero' || def.tipo === 'dinheiro') && typeof v !== 'number') {
        erros.push(`${onde}: "${def.rotulo}" precisa de um número.`);
      } else if (def.tipo === 'opcao' && !(typeof v === 'string' && def.opcoes && v in def.opcoes)) {
        erros.push(`${onde}: valor "${String(v)}" não existe em "${def.rotulo}".`);
      } else if (def.tipo === 'lista' && (typeof v !== 'string' || !v.trim())) {
        erros.push(`${onde}: "${def.rotulo}" precisa de um texto.`);
      } else if (def.tipo === 'booleano' && typeof v !== 'boolean') {
        erros.push(`${onde}: "${def.rotulo}" precisa de sim ou não.`);
      }
    }
  });
  return erros;
}

function emUnidadeDoPerfil(def: DefinicaoCampo, n: number): number {
  return def.tipo === 'dinheiro' ? Math.round(n * 100) : n;
}

function avaliarCondicao(p: PerfilCliente, c: Condicao): boolean {
  const def = campo(c.campo);
  const atual = def.ler(p);

  if (def.tipo === 'lista') {
    const tem = (atual as string[]).includes(chaveProduto(String(c.valor)));
    return c.operador === 'contem' ? tem : !tem;
  }
  // Valor ausente (ex.: média entre compras com uma compra só) nunca satisfaz condição numérica.
  if (atual === null || atual === undefined) return false;

  if (def.tipo === 'numero' || def.tipo === 'dinheiro') {
    const n = atual as number;
    if (c.operador === 'entre') {
      const [a, b] = c.valor as [number, number];
      return n >= emUnidadeDoPerfil(def, a) && n <= emUnidadeDoPerfil(def, b);
    }
    const alvo = emUnidadeDoPerfil(def, c.valor as number);
    switch (c.operador) {
      case 'maior_que': return n > alvo;
      case 'menor_que': return n < alvo;
      case 'igual': return n === alvo;
      case 'diferente': return n !== alvo;
    }
    return false;
  }
  return c.operador === 'igual' ? atual === c.valor : atual !== c.valor;
}

function avaliarConjunto(p: PerfilCliente, cj: Conjunto): boolean {
  return cj.tipo === 'E' ? cj.condicoes.every((c) => avaliarCondicao(p, c)) : cj.condicoes.some((c) => avaliarCondicao(p, c));
}

export function bateNaRegra(p: PerfilCliente, s: Segmento): boolean {
  return s.combinar === 'E' ? s.conjuntos.every((cj) => avaliarConjunto(p, cj)) : s.conjuntos.some((cj) => avaliarConjunto(p, cj));
}

/** Por que este cliente não pode receber por este canal; null se pode. */
export function bloqueioDoCanal(p: PerfilCliente, canal: Canal | undefined): MotivoExclusao | null {
  // Descadastro vale para qualquer canal de campanha.
  if (canal && p.descadastrado) return 'descadastrado';
  if (canal === 'whatsapp' || canal === 'sms') {
    if (p.status === 'telefone_central') return 'telefone_central';
    if (p.tipoLinha === 'fixo') return 'telefone_fixo';
  }
  if (canal === 'whatsapp' && p.semWhatsapp) return 'sem_whatsapp';
  if (canal === 'email' && !p.temEmail) return 'sem_email';
  return null;
}

/**
 * Aplica a regra e, em seguida, as travas do canal. As travas não dependem de quem
 * monta o segmento lembrar delas — no Retorne, esquecer "tem telefone" dilui a
 * conversão e fixo entra no disparo de WhatsApp.
 */
export function avaliarSegmento(perfis: PerfilCliente[], s: Segmento): ResultadoSegmento {
  const erros = validarSegmento(s);
  if (erros.length) throw new Error(`Segmento inválido: ${erros.join(' ')}`);

  const resultado: ResultadoSegmento = { clienteIds: [], populacaoDaRegra: 0, excluidos: {} };
  const excluir = (m: MotivoExclusao) => { resultado.excluidos[m] = (resultado.excluidos[m] ?? 0) + 1; };

  for (const p of perfis) {
    if (!bateNaRegra(p, s)) continue;
    resultado.populacaoDaRegra++;
    const bloqueio = bloqueioDoCanal(p, s.canal);
    if (bloqueio) { excluir(bloqueio); continue; }
    resultado.clienteIds.push(p.clienteId);
  }
  return resultado;
}

const reais = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`;

function descreverValor(def: DefinicaoCampo, v: ValorCondicao): string {
  if (Array.isArray(v)) {
    const [a, b] = def.tipo === 'dinheiro' ? v.map(reais) : v;
    return `${a} e ${b}`;
  }
  if (def.tipo === 'dinheiro' && typeof v === 'number') return reais(v);
  if (def.tipo === 'opcao' && def.opcoes && typeof v === 'string') return def.opcoes[v] ?? v;
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  return String(v).trim();
}

/**
 * Nome gerado a partir da regra. No Retorne o nome é digitado livre e mente: um
 * segmento "<2 Pedidos" com regra "menor que 3" é, na verdade, até 2.
 */
export function descreverSegmento(s: Segmento): string {
  const conjuntos = s.conjuntos.map((cj) => {
    const partes = cj.condicoes.map((c) => {
      const def = campo(c.campo);
      return `${def.rotulo} ${ROTULO_OPERADOR[c.operador]} ${descreverValor(def, c.valor)}`;
    });
    const texto = partes.join(cj.tipo === 'E' ? ' e ' : ' ou ');
    return s.conjuntos.length > 1 && partes.length > 1 ? `(${texto})` : texto;
  });
  const regra = conjuntos.join(s.combinar === 'E' ? ' e ' : ' ou ');
  return s.canal ? `${regra} · ${s.canal === 'whatsapp' ? 'WhatsApp' : s.canal === 'sms' ? 'SMS' : 'e-mail'}` : regra;
}
