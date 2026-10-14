import type { PerfilCliente } from '../segmentacao/perfil.ts';
import { avaliarSegmento, bateNaRegra, bloqueioDoCanal, validarSegmento } from '../segmentacao/segmento.ts';
import { DIAS, dataLocal, diaEHora, horarioLocalParaUTC, type DiaSemana } from '../segmentacao/tempo.ts';
import { createHash } from 'node:crypto';
import {
  CONFIG_LOJA_PADRAO,
  type Campanha,
  type ConfigLoja,
  type ControleRegistrado,
  type EnvioPlanejado,
  type EnvioRegistrado,
  type MotivoNaoEnvio,
  type RelatorioCampanha,
} from './modelo.ts';

export interface ContextoDia {
  lojaId: string;
  /** Momento do planejamento; o plano cobre o dia local de `agora`. */
  agora: Date;
  perfis: PerfilCliente[];
  campanhas: Campanha[];
  /**
   * Envios já registrados da loja, com status — inclusive os de hoje se o planejador
   * já rodou. Basta a janela da carência de hibernação mais o histórico das campanhas
   * de envio único.
   */
  enviosAnteriores: EnvioRegistrado[];
  /** Grupo de controle já registrado (hiberna e ocupa o limite como se tivesse recebido). */
  controlesAnteriores?: ControleRegistrado[];
  diasPico: DiaSemana[];
  config?: Partial<ConfigLoja>;
}

export interface PlanoDoDia {
  /** Dia local planejado, "AAAA-MM-DD". */
  data: string;
  envios: EnvioPlanejado[];
  /** Clientes que receberiam, mas ficaram no grupo de controle. Persistir para a camada 5. */
  controles: ControleRegistrado[];
  relatorio: RelatorioCampanha[];
}

interface JanelaHibernacao { desde: number; ate: number }

const VALE = new Set(['planejado', 'enviado', 'entregue', 'lido', undefined]);

/**
 * Sorteio fixo: o mesmo cliente cai sempre no mesmo grupo da mesma campanha, em
 * qualquer dia e em qualquer servidor. Hash, não Math.random.
 */
export function noGrupoControle(campanhaId: string, clienteId: string, fracao: number | undefined): boolean {
  if (!fracao || fracao <= 0) return false;
  const h = createHash('sha256').update(`${campanhaId}|${clienteId}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000 < fracao;
}

const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIA_MS = 86_400_000;

export function validarCampanha(c: Campanha): string[] {
  const erros: string[] = [];
  if (c.tipo === 'massa') {
    if (!c.populacaoCongelada?.length) erros.push('Disparo em massa sem população congelada.');
    if (!c.ondas?.length) erros.push('Disparo em massa sem ondas.');
  } else {
    if (!c.hora || !RE_HORA.test(c.hora)) erros.push('Hora do disparo ausente ou fora do formato HH:MM.');
    if (!c.segmento) erros.push('Campanha sem segmento de entrada.');
    else erros.push(...validarSegmento(c.segmento).map((e) => `Segmento de entrada: ${e}`));
  }
  if (c.segmentoExclusao) erros.push(...validarSegmento(c.segmentoExclusao).map((e) => `Segmento de exclusão: ${e}`));
  if (c.grupoControle !== undefined && !(c.grupoControle >= 0 && c.grupoControle <= 0.5)) {
    erros.push('Grupo de controle precisa estar entre 0 e 0,5 (50%).');
  }
  return erros;
}

interface Candidato { clienteId: string; horario: Date; onda?: number }

/**
 * Planeja os envios de um dia para uma loja. Função pura: não envia nada nem grava
 * nada; devolve o plano, o relatório por campanha e o novo estado de hibernação.
 *
 * Ordem das travas para cada cliente da população:
 * canal → segmento de exclusão → enviar uma vez → hibernação → limite diário.
 * Rodar duas vezes no mesmo dia, passando os envios já planejados, não duplica nada.
 */
export function planejarDia(ctx: ContextoDia): PlanoDoDia {
  const cfg: ConfigLoja = { ...CONFIG_LOJA_PADRAO, ...ctx.config };
  const data = dataLocal(ctx.agora, cfg.fuso);
  const diaHoje = diaEHora(horarioLocalParaUTC(data, '12:00', cfg.fuso), cfg.fuso).dia;

  const perfis = new Map(ctx.perfis.map((p) => [p.clienteId, p]));
  const recebidos = new Set<string>();
  const jaPlanejadoHoje = new Set<string>();
  const mensagensHoje = new Map<string, number>();
  const hib = new Map<string, JanelaHibernacao[]>();
  const carencia = cfg.diasHibernacao * DIA_MS;
  const hibernar = (clienteId: string, inicio: Date) => {
    const l = hib.get(clienteId) ?? [];
    l.push({ desde: inicio.getTime(), ate: inicio.getTime() + carencia });
    hib.set(clienteId, l);
  };
  // Hiberna se alguma janela já começou e ainda não terminou no horário do envio.
  // Uma campanha das 20h não bloqueia outra das 10h do mesmo dia.
  const hibernando = (clienteId: string, horario: Date) =>
    (hib.get(clienteId) ?? []).some((j) => j.desde <= horario.getTime() && horario.getTime() < j.ate);

  for (const e of ctx.enviosAnteriores) {
    const chave = `${e.campanhaId}|${e.clienteId}`;
    const hoje = dataLocal(e.planejadoPara, cfg.fuso) === data;
    if (hoje) jaPlanejadoHoje.add(chave); // replanejar nunca refaz, qualquer que seja o status
    if (!VALE.has(e.status)) continue;    // cancelado e falhou: não recebeu, não hiberna, não ocupa o dia
    recebidos.add(chave);
    if (hoje) mensagensHoje.set(e.clienteId, (mensagensHoje.get(e.clienteId) ?? 0) + 1);
    if (e.hiberna !== false) hibernar(e.clienteId, e.planejadoPara);
  }
  for (const k of ctx.controlesAnteriores ?? []) {
    if (dataLocal(k.em, cfg.fuso) === data) {
      jaPlanejadoHoje.add(`${k.campanhaId}|${k.clienteId}`);
      mensagensHoje.set(k.clienteId, (mensagensHoje.get(k.clienteId) ?? 0) + 1);
    }
    if (k.hiberna) hibernar(k.clienteId, k.em);
  }

  const envios: EnvioPlanejado[] = [];
  const controles: ControleRegistrado[] = [];
  const relatorio: RelatorioCampanha[] = [];

  const campanhas = ctx.campanhas
    .filter((c) => c.lojaId === ctx.lojaId)
    .sort((a, b) => a.prioridade - b.prioridade || a.id.localeCompare(b.id));

  for (const c of campanhas) {
    const rel: RelatorioCampanha = { campanhaId: c.id, nome: c.nome, situacao: 'executada', populacao: 0, planejados: 0, naoEnviados: {} };
    relatorio.push(rel);
    const naoEnviar = (m: MotivoNaoEnvio, n = 1) => { rel.naoEnviados[m] = (rel.naoEnviados[m] ?? 0) + n; };

    if (!c.publicada) { rel.situacao = 'inativa'; continue; }
    const erros = validarCampanha(c);
    if (erros.length) { rel.situacao = 'invalida'; rel.erros = erros; continue; }

    let candidatos: Candidato[] = [];
    let aplicarCanal = false;

    if (c.tipo === 'massa') {
      let inicio = 0;
      c.ondas!.forEach((o, i) => {
        const fatia = c.populacaoCongelada!.slice(inicio, inicio + o.quantidade);
        inicio += o.quantidade;
        if (dataLocal(o.em, cfg.fuso) === data) candidatos.push(...fatia.map((clienteId) => ({ clienteId, horario: o.em, onda: i })));
      });
      if (!candidatos.length) { rel.situacao = 'sem_onda_hoje'; continue; }
      rel.populacao = candidatos.length;
      aplicarCanal = true;
    } else {
      const horario = horarioLocalParaUTC(data, c.hora!, cfg.fuso);
      if (horario.getTime() < c.inicioEm.getTime()) { rel.situacao = 'nao_iniciada'; continue; }
      const dias = c.dias ?? 'pico';
      const permitidos = dias === 'pico' ? ctx.diasPico : dias === 'todos' ? DIAS : dias;
      if (!permitidos.includes(diaHoje)) { rel.situacao = 'fora_do_dia'; continue; }

      const r = avaliarSegmento(ctx.perfis, { ...c.segmento!, canal: c.canal });
      rel.populacao = r.populacaoDaRegra;
      for (const [m, n] of Object.entries(r.excluidos)) naoEnviar(m as MotivoNaoEnvio, n);
      candidatos = r.clienteIds.map((clienteId) => ({ clienteId, horario }));
    }

    for (const cand of candidatos) {
      const chave = `${c.id}|${cand.clienteId}`;
      if (jaPlanejadoHoje.has(chave)) continue; // já está no plano de hoje

      const p = perfis.get(cand.clienteId);
      if (!p) { naoEnviar('cliente_indisponivel'); continue; }
      if (aplicarCanal) {
        const bloqueio = bloqueioDoCanal(p, c.canal);
        if (bloqueio) { naoEnviar(bloqueio); continue; }
      }
      if (c.segmentoExclusao && bateNaRegra(p, c.segmentoExclusao)) { naoEnviar('segmento_de_exclusao'); continue; }
      if (c.enviarApenasUmaVez && recebidos.has(chave)) { naoEnviar('ja_recebeu'); continue; }
      if (!c.enviarParaHibernando && hibernando(cand.clienteId, cand.horario)) { naoEnviar('hibernando'); continue; }
      if ((mensagensHoje.get(cand.clienteId) ?? 0) >= cfg.maxMensagensPorClienteDia) { naoEnviar('outra_campanha_no_dia'); continue; }
      // O sorteio vem por último: o controle passou por todas as travas, então é comparável a quem recebe.
      // O controle segue daqui igual a quem recebe: ocupa o limite do dia e hiberna.
      if (noGrupoControle(c.id, cand.clienteId, c.grupoControle)) {
        naoEnviar('grupo_controle');
        controles.push({ campanhaId: c.id, clienteId: cand.clienteId, em: cand.horario, hiberna: !c.naoHibernar });
        jaPlanejadoHoje.add(chave);
        mensagensHoje.set(cand.clienteId, (mensagensHoje.get(cand.clienteId) ?? 0) + 1);
        if (!c.naoHibernar) hibernar(cand.clienteId, cand.horario);
        continue;
      }

      envios.push({
        lojaId: ctx.lojaId,
        campanhaId: c.id,
        clienteId: cand.clienteId,
        canal: c.canal,
        criativoId: c.criativoId,
        planejadoPara: cand.horario,
        contabilizaReceita: !c.naoContabilizarReceita,
        hiberna: !c.naoHibernar,
        ...(cand.onda !== undefined ? { onda: cand.onda } : {}),
      });
      rel.planejados++;
      recebidos.add(chave);
      jaPlanejadoHoje.add(chave);
      mensagensHoje.set(cand.clienteId, (mensagensHoje.get(cand.clienteId) ?? 0) + 1);
      if (!c.naoHibernar) hibernar(cand.clienteId, cand.horario);
    }
  }

  envios.sort((a, b) => a.planejadoPara.getTime() - b.planejadoPara.getTime());
  return { data, envios, controles, relatorio };
}
