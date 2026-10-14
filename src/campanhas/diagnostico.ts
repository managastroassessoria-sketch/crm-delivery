import { CONFIG_LOJA_PADRAO, type Campanha } from './modelo.ts';

/** Dia exato que a campanha mira (ex.: "dias desde a última compra igual 4"), se houver. */
function diaAlvo(c: Campanha): { campo: string; dia: number } | null {
  for (const cj of c.segmento?.conjuntos ?? []) {
    for (const cond of cj.condicoes) {
      if ((cond.campo === 'dias_desde_ultima_compra' || cond.campo === 'dias_desde_primeira_compra') &&
          cond.operador === 'igual' && typeof cond.valor === 'number') {
        return { campo: cond.campo, dia: cond.valor };
      }
    }
  }
  return null;
}

/** "Número de compras igual N", se a campanha exigir. */
function comprasExigidas(c: Campanha): number | null {
  for (const cj of c.segmento?.conjuntos ?? []) {
    for (const cond of cj.condicoes) {
      if (cond.campo === 'numero_compras' && cond.operador === 'igual' && typeof cond.valor === 'number') return cond.valor;
    }
  }
  return null;
}

/**
 * Avisos de configuração de hibernação, antes de publicar. Os dois padrões abaixo
 * são os que, no Retorne, travaram 354 de 427 clientes (83%) de uma campanha que
 * parecia apenas ter volume baixo.
 */
export function diagnosticarHibernacao(campanhas: Campanha[], diasHibernacao = CONFIG_LOJA_PADRAO.diasHibernacao): string[] {
  const avisos: string[] = [];
  const ativas = campanhas.filter((c) => c.publicada);

  // 1. Campanhas que hibernam quem recebe E pulam quem está hibernando competem pela mesma base.
  const esgotam = ativas.filter((c) => !c.naoHibernar && !c.enviarParaHibernando);
  if (esgotam.length >= 2) {
    avisos.push(
      `${esgotam.length} campanhas hibernam quem recebe e pulam quem está hibernando (${esgotam.map((c) => `«${c.nome}»`).join(', ')}). ` +
      'Elas competem pela mesma base e podem esgotá-la sozinhas.',
    );
  }

  // 2. Régua: um passo que hiberna bloqueia o passo seguinte quando a carência é maior que o intervalo.
  const regua = ativas
    .filter((c) => c.tipo !== 'massa')
    .map((c) => ({ c, alvo: diaAlvo(c) }))
    .filter((x): x is { c: Campanha; alvo: { campo: string; dia: number } } => x.alvo !== null);
  for (const a of regua) {
    if (a.c.naoHibernar) continue;
    for (const b of regua) {
      if (a === b || b.c.enviarParaHibernando || a.alvo.campo !== b.alvo.campo) continue;
      // Exigências de número de compras diferentes = última compras diferentes; o contador
      // de dias reinicia entre uma e outra, então não há bloqueio real.
      const na = comprasExigidas(a.c);
      const nb = comprasExigidas(b.c);
      if (na !== null && nb !== null && na !== nb) continue;
      const intervalo = b.alvo.dia - a.alvo.dia;
      if (intervalo > 0 && intervalo < diasHibernacao) {
        avisos.push(
          `«${a.c.nome}» (dia ${a.alvo.dia}) hiberna por ${diasHibernacao} dias e bloqueia «${b.c.nome}» (dia ${b.alvo.dia}): ` +
          `quem recebe a primeira ainda estará hibernando ${intervalo} dia(s) depois.`,
        );
      }
    }
  }
  return avisos;
}
