import { randomUUID } from 'node:crypto';
import type { Cliente, MotivoDescarte, PedidoNormalizado, ResultadoIngestao } from './modelo.ts';
import type { Repositorio } from './repositorio.ts';
import { normalizarTelefone } from './telefone.ts';

export interface OpcoesIngestao {
  /**
   * Quantos primeiros nomes distintos um mesmo telefone pode acumular na loja antes
   * de ser tratado como número de central. O Open Delivery permite que o app de
   * pedido mande o telefone da própria central no lugar do cliente; sem essa trava,
   * dezenas de pedidos viram um único "cliente" e a atribuição é falseada.
   */
  limiteNomesPorTelefone?: number;
  agora?: () => Date;
}

/** Primeiro nome, sem acento e em minúsculas: "Maria Silva" e "maria" contam como o mesmo nome. */
export function chaveDeNome(nome: string | undefined): string | undefined {
  const primeiro = nome?.trim().split(/\s+/)[0];
  if (!primeiro) return undefined;
  return primeiro.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Recebe um pedido já normalizado e decide: importa, aguarda, atualiza ou descarta
 * com motivo registrado. Só pedido concluído e com cliente identificável por
 * telefone vira histórico de compra.
 */
export async function ingerirPedido(
  repo: Repositorio,
  pedido: PedidoNormalizado,
  opcoes: OpcoesIngestao = {},
): Promise<ResultadoIngestao> {
  const limite = opcoes.limiteNomesPorTelefone ?? 5;
  const agora = opcoes.agora ?? (() => new Date());
  const { fonte, lojaId, idExterno } = pedido;

  const descartar = async (motivo: MotivoDescarte): Promise<ResultadoIngestao> => {
    await repo.registrarDescarte({ lojaId, fonte, idExterno, motivo, em: agora() });
    return { status: 'descartado', motivo };
  };

  // Pedido já importado: só interessa mudança de status (ex.: cancelado depois de concluído).
  const existente = await repo.buscarPedido(fonte, lojaId, idExterno);
  if (existente) {
    if (existente.status !== pedido.status && pedido.status !== 'em_andamento') {
      await repo.atualizarStatusPedido(fonte, lojaId, idExterno, pedido.status);
      return { status: 'atualizado', novoStatus: pedido.status };
    }
    return { status: 'descartado', motivo: 'duplicado' };
  }

  // Já descartado antes (a mesma fonte manda o pedido de novo: DELIVERED e CONCLUDED, ou a lista
  // do dia do Anota AI a cada ciclo). Responde o mesmo motivo sem contar outra vez.
  const descartado = await repo.buscarDescarte(fonte, lojaId, idExterno);
  if (descartado) return { status: 'descartado', motivo: descartado.motivo };

  if (pedido.status === 'em_andamento') return { status: 'aguardando' };
  if (pedido.status === 'cancelado') return descartar('cancelado');
  if (pedido.marketplace) return descartar('marketplace');
  if (!pedido.cliente) return descartar('sem_cliente');

  const bruto = pedido.cliente.telefone?.trim();
  if (!bruto) return descartar('sem_telefone');
  // Keeta devolve dados pessoais criptografados com prefixo ENC_.
  if (bruto.startsWith('ENC_')) return descartar('telefone_criptografado');

  const tel = normalizarTelefone(bruto);
  if (!tel.e164 || tel.tipo === 'invalido') return descartar('telefone_invalido');

  const nome = chaveDeNome(pedido.cliente.nome);
  let cliente = await repo.buscarClientePorTelefone(lojaId, tel.e164);
  let clienteNovo = false;

  if (cliente) {
    if (cliente.status === 'telefone_central') return descartar('telefone_central');
    if (nome) cliente.nomesVistos.add(nome);
    if (cliente.nomesVistos.size > limite) {
      cliente.status = 'telefone_central';
      await repo.salvarCliente(cliente);
      return descartar('telefone_central');
    }
    cliente.nome ||= pedido.cliente.nome;
    cliente.email ||= pedido.cliente.email;
    cliente.documento ||= pedido.cliente.documento;
  } else {
    cliente = {
      id: randomUUID(),
      lojaId,
      telefoneE164: tel.e164,
      tipoLinha: tel.tipo,
      nome: pedido.cliente.nome,
      email: pedido.cliente.email,
      documento: pedido.cliente.documento,
      status: 'ativo',
      nomesVistos: new Set(nome ? [nome] : []),
      criadoEm: agora(),
    } satisfies Cliente;
    clienteNovo = true;
  }

  await repo.salvarCliente(cliente);
  await repo.salvarPedido(pedido, cliente.id);
  await repo.registrarCompra(lojaId, fonte, pedido.criadoEm);
  return { status: 'importado', clienteId: cliente.id, clienteNovo };
}
