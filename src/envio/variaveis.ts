/** De onde vem o valor de cada variável {{n}} do template. */
export type FonteVariavel =
  | { fonte: 'primeiro_nome'; reserva?: string }
  | { fonte: 'produto_favorito'; reserva?: string }
  | { fonte: 'nome_loja' }
  | { fonte: 'texto'; texto: string };

export interface Criativo {
  id: string;
  /** Nome do template aprovado na Meta. */
  nomeTemplate: string;
  idioma: string;
  /** Categoria aprovada; define o preço por mensagem. */
  categoria: 'marketing' | 'utility';
  /** Na ordem de {{1}}, {{2}}, ... */
  variaveis: FonteVariavel[];
}

export interface DadosDoCliente {
  nome?: string;
  produtoFavorito?: string;
  nomeLoja: string;
}

export type ResultadoVariaveis =
  | { ok: true; parametros: string[] }
  | { ok: false; variavel: number; fonte: FonteVariavel['fonte'] };

/** "maria souza" → "Maria". Nome sem letras ("123", "-") conta como ausente. */
export function primeiroNome(nome: string | undefined): string | undefined {
  const p = nome?.trim().split(/\s+/)[0];
  if (!p || !/\p{L}/u.test(p) || /\d/.test(p)) return undefined;
  return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR');
}

/** A Meta recusa parâmetro com quebra de linha, tabulação ou mais de 4 espaços seguidos. */
function limpar(texto: string): string {
  return texto.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Preenche as variáveis do template. Sem valor e sem reserva, o envio não sai —
 * melhor não enviar do que mandar "Olá , seu  favorito te espera".
 */
export function preencherVariaveis(criativo: Criativo, dados: DadosDoCliente): ResultadoVariaveis {
  const parametros: string[] = [];
  for (const [i, v] of criativo.variaveis.entries()) {
    let valor: string | undefined;
    switch (v.fonte) {
      case 'primeiro_nome': valor = primeiroNome(dados.nome) ?? v.reserva; break;
      case 'produto_favorito': valor = dados.produtoFavorito ?? v.reserva; break;
      case 'nome_loja': valor = dados.nomeLoja; break;
      case 'texto': valor = v.texto; break;
    }
    const limpo = valor ? limpar(valor) : '';
    if (!limpo) return { ok: false, variavel: i + 1, fonte: v.fonte };
    parametros.push(limpo);
  }
  return { ok: true, parametros };
}
