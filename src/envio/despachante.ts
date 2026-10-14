import type { EnvioPlanejado } from '../campanhas/modelo.ts';
import { interpretarErro } from './erros.ts';
import { preencherVariaveis, type Criativo, type DadosDoCliente } from './variaveis.ts';
import type { ResultadoEnvio } from './whatsapp.ts';

export interface EnvioParaDespacho extends EnvioPlanejado {
  id: string;
  /** Tentativas já feitas. */
  tentativas: number;
  /** Quando adiado, não sai antes disso (espera de reenvio, limite da Meta, conta pausada). */
  proximaTentativaEm?: Date;
}

export interface ContatoParaEnvio extends DadosDoCliente {
  telefoneE164: string;
  descadastrado: boolean;
  semWhatsapp: boolean;
}

export type MotivoCancelamento = 'descadastrado' | 'sem_whatsapp' | 'variavel_ausente' | 'criativo_pausado' | 'criativo_desconhecido' | 'cliente_desconhecido';
export type MotivoAdiamento = 'limite_meta' | 'conta_pausada' | 'erro_temporario' | 'retido_pela_meta';

export type Desfecho =
  | { envioId: string; status: 'enviado'; wamid: string }
  | { envioId: string; status: 'cancelado'; motivo: MotivoCancelamento }
  | { envioId: string; status: 'adiado'; motivo: MotivoAdiamento; tentarDepoisDe: Date; codigo?: number }
  | { envioId: string; status: 'falhou'; codigo?: number; explicacao: string };

export interface EntradaDespacho {
  agora: Date;
  envios: EnvioParaDespacho[];
  contatos: Map<string, ContatoParaEnvio>;
  criativos: Map<string, Criativo>;
  /** Limite de destinatários únicos em 24 h do portfólio na Meta (250, 2.000, 10.000...). */
  limiteDestinatarios24h: number;
  /** Último envio por telefone nas últimas 24 h, somando todas as lojas do mesmo portfólio. */
  destinatarios24h: Map<string, Date>;
  /** Criativos já pausados antes deste ciclo. */
  criativosPausados?: Set<string>;
  maxTentativas?: number;
  enviar(telefoneE164: string, criativo: Criativo, parametros: string[]): Promise<ResultadoEnvio>;
}

export interface ResultadoDespacho {
  desfechos: Desfecho[];
  descadastrar: string[];          // clienteIds
  marcarSemWhatsapp: string[];     // clienteIds
  pausarCriativos: Map<string, string>; // criativoId → explicação
  /** Preenchido quando a conta inteira precisa de atenção; nada mais sai até resolver. */
  contaPausada?: { codigo?: number; explicacao: string };
}

const MINUTO = 60_000;
const DIA = 24 * 60 * MINUTO;

/**
 * Envia os envios já vencidos (planejadoPara ≤ agora), em ordem de horário.
 * Respeita o limite de destinatários da Meta: quem não cabe na janela de 24 h fica
 * adiado até a janela abrir, em vez de falhar.
 */
export async function despachar(e: EntradaDespacho): Promise<ResultadoDespacho> {
  const res: ResultadoDespacho = { desfechos: [], descadastrar: [], marcarSemWhatsapp: [], pausarCriativos: new Map() };
  const pausados = new Set(e.criativosPausados);
  const maxTentativas = e.maxTentativas ?? 3;
  const janela = new Map([...e.destinatarios24h].filter(([, em]) => e.agora.getTime() - em.getTime() < DIA));

  // Só WhatsApp: SMS e e-mail têm despachante próprio e não podem sair como template.
  const vencidos = e.envios
    .filter((x) => x.canal === 'whatsapp')
    .filter((x) => (x.proximaTentativaEm ?? x.planejadoPara).getTime() <= e.agora.getTime())
    .sort((a, b) => a.planejadoPara.getTime() - b.planejadoPara.getTime());

  for (const env of vencidos) {
    const id = env.id;
    if (res.contaPausada) {
      res.desfechos.push({ envioId: id, status: 'adiado', motivo: 'conta_pausada', tentarDepoisDe: new Date(e.agora.getTime() + 60 * MINUTO) });
      continue;
    }
    const contato = e.contatos.get(env.clienteId);
    if (!contato) { res.desfechos.push({ envioId: id, status: 'cancelado', motivo: 'cliente_desconhecido' }); continue; }
    if (contato.descadastrado) { res.desfechos.push({ envioId: id, status: 'cancelado', motivo: 'descadastrado' }); continue; }
    if (contato.semWhatsapp) { res.desfechos.push({ envioId: id, status: 'cancelado', motivo: 'sem_whatsapp' }); continue; }
    const criativo = e.criativos.get(env.criativoId);
    if (!criativo) { res.desfechos.push({ envioId: id, status: 'cancelado', motivo: 'criativo_desconhecido' }); continue; }
    if (pausados.has(criativo.id)) { res.desfechos.push({ envioId: id, status: 'cancelado', motivo: 'criativo_pausado' }); continue; }

    const vars = preencherVariaveis(criativo, contato);
    if (!vars.ok) { res.desfechos.push({ envioId: id, status: 'cancelado', motivo: 'variavel_ausente' }); continue; }

    const tel = contato.telefoneE164;
    if (!janela.has(tel) && janela.size >= e.limiteDestinatarios24h) {
      const maisAntigo = Math.min(...[...janela.values()].map((d) => d.getTime()));
      res.desfechos.push({ envioId: id, status: 'adiado', motivo: 'limite_meta', tentarDepoisDe: new Date(maisAntigo + DIA) });
      continue;
    }

    const r = await e.enviar(tel, criativo, vars.parametros);
    if (r.ok) {
      janela.set(tel, e.agora);
      res.desfechos.push({ envioId: id, status: 'enviado', wamid: r.wamid });
      continue;
    }

    const erro = interpretarErro(r.codigo);
    const esgotou = env.tentativas + 1 >= maxTentativas;
    switch (erro.acao) {
      case 'reenviar':
      case 'reenviar_amanha':
        if (esgotou) {
          res.desfechos.push({ envioId: id, status: 'falhou', codigo: r.codigo, explicacao: erro.explicacao });
        } else {
          const espera = erro.acao === 'reenviar_amanha' ? DIA : 5 * MINUTO * 2 ** env.tentativas;
          res.desfechos.push({
            envioId: id, status: 'adiado', codigo: r.codigo, tentarDepoisDe: new Date(e.agora.getTime() + espera),
            motivo: erro.acao === 'reenviar_amanha' ? 'retido_pela_meta' : 'erro_temporario',
          });
        }
        break;
      case 'descadastrar':
        res.descadastrar.push(env.clienteId);
        res.desfechos.push({ envioId: id, status: 'falhou', codigo: r.codigo, explicacao: erro.explicacao });
        break;
      case 'marcar_sem_whatsapp':
        res.marcarSemWhatsapp.push(env.clienteId);
        res.desfechos.push({ envioId: id, status: 'falhou', codigo: r.codigo, explicacao: erro.explicacao });
        break;
      case 'pausar_criativo':
        pausados.add(criativo.id);
        res.pausarCriativos.set(criativo.id, erro.explicacao);
        res.desfechos.push({ envioId: id, status: 'falhou', codigo: r.codigo, explicacao: erro.explicacao });
        break;
      case 'pausar_conta':
        res.contaPausada = { codigo: r.codigo, explicacao: erro.explicacao };
        res.desfechos.push({ envioId: id, status: 'adiado', motivo: 'conta_pausada', codigo: r.codigo, tentarDepoisDe: new Date(e.agora.getTime() + 60 * MINUTO) });
        break;
      case 'desistir':
        res.desfechos.push({ envioId: id, status: 'falhou', codigo: r.codigo, explicacao: erro.explicacao });
        break;
    }
  }
  return res;
}
