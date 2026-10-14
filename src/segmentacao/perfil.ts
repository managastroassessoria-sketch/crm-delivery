import type { Cliente, StatusCliente, TipoLinha } from '../modelo.ts';
import type { PedidoSalvo } from '../repositorio.ts';
import { diaEHora, diasDeCalendario, FUSO_PADRAO, moda, periodoDaHora, type DiaSemana, type Periodo } from './tempo.ts';

export type Quadrante = 'novo' | 'recorrente' | 'fiel' | 'campeao' | 'perdido';

/** Escada de intervalo da régua: 4 → 7 → 15 → 30 → 60 → 90 dias. */
export type FaixaRecencia = 'ate_4' | 'ate_7' | 'ate_15' | 'ate_30' | 'ate_60' | 'ate_90' | 'acima_90';
const ESCADA: Array<[number, FaixaRecencia]> = [
  [4, 'ate_4'], [7, 'ate_7'], [15, 'ate_15'], [30, 'ate_30'], [60, 'ate_60'], [90, 'ate_90'],
];

export function faixaDeRecencia(dias: number): FaixaRecencia {
  for (const [limite, faixa] of ESCADA) if (dias <= limite) return faixa;
  return 'acima_90';
}

/**
 * Cortes dos quadrantes. VALORES INICIAIS, a calibrar com os dados de cada loja:
 * a única referência firme é a régua (30D e 90D). O resto é ponto de partida.
 */
export interface CortesQuadrante {
  /** Acima disso o cliente é perdido, qualquer que seja o histórico. */
  diasPerdido: number;
  /** A partir de quantas compras o cliente deixa de ser recorrente e vira fiel. */
  comprasFiel: number;
  /** Fatia superior de total gasto, entre os fiéis ativos, que vira campeão (0.2 = 20%). */
  fatiaCampeao: number;
}

export const CORTES_PADRAO: CortesQuadrante = { diasPerdido: 90, comprasFiel: 4, fatiaCampeao: 0.2 };

export interface PerfilCliente {
  clienteId: string;
  lojaId: string;
  status: StatusCliente;
  tipoLinha: Exclude<TipoLinha, 'invalido'>;
  temEmail: boolean;
  descadastrado: boolean;
  semWhatsapp: boolean;
  numeroCompras: number;
  totalGastoCentavos: number;
  ticketMedioCentavos: number;
  primeiraCompraEm: Date;
  ultimaCompraEm: Date;
  diasDesdeUltimaCompra: number;
  diasDesdePrimeiraCompra: number;
  /** null com menos de duas compras. */
  mediaDiasEntreCompras: number | null;
  /** Compras por mês desde a primeira compra (mínimo de um mês no denominador). */
  comprasPorMes: number;
  diaPreferido: DiaSemana;
  periodoPreferido: Periodo;
  produtoFavorito?: string;
  produtosComprados: string[];
  quadrante: Quadrante;
  faixaRecencia: FaixaRecencia;
}

/** Normaliza nome de produto para comparar ("Bolo de Pote " = "bolo de pote"). */
export const chaveProduto = (nome: string) => nome.trim().toLowerCase();

/**
 * Calcula o perfil de cada cliente a partir dos pedidos CONCLUÍDOS. Cliente sem
 * pedido concluído não tem perfil. Só usa acumulados — nenhuma propriedade "do
 * mês", que zera no dia 1 e mata o segmento em silêncio.
 */
export function calcularPerfis(
  clientes: Cliente[],
  pedidos: PedidoSalvo[],
  agora: Date,
  opcoes: { cortes?: CortesQuadrante; fuso?: string } = {},
): PerfilCliente[] {
  const cortes = opcoes.cortes ?? CORTES_PADRAO;
  const fuso = opcoes.fuso ?? FUSO_PADRAO;

  const porCliente = new Map<string, PedidoSalvo[]>();
  for (const p of pedidos) {
    if (p.status !== 'concluido') continue;
    const lista = porCliente.get(p.clienteId) ?? [];
    lista.push(p);
    porCliente.set(p.clienteId, lista);
  }

  const parciais: Array<Omit<PerfilCliente, 'quadrante'>> = [];
  for (const c of clientes) {
    const lista = porCliente.get(c.id);
    if (!lista?.length) continue;
    lista.sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime());

    const primeira = lista[0].criadoEm;
    const ultima = lista.at(-1)!.criadoEm;
    const total = lista.reduce((s, p) => s + p.totalCentavos, 0);
    const n = lista.length;
    const momentos = lista.map((p) => diaEHora(p.criadoEm, fuso));
    const itens = lista.flatMap((p) => p.itens.map((i) => chaveProduto(i.nome))).filter(Boolean);
    const diasPrimeira = diasDeCalendario(primeira, agora, fuso);
    const diasUltima = diasDeCalendario(ultima, agora, fuso);

    parciais.push({
      clienteId: c.id,
      lojaId: c.lojaId,
      status: c.status,
      tipoLinha: c.tipoLinha,
      temEmail: Boolean(c.email),
      descadastrado: Boolean(c.descadastradoEm),
      semWhatsapp: Boolean(c.semWhatsappEm),
      numeroCompras: n,
      totalGastoCentavos: total,
      ticketMedioCentavos: Math.round(total / n),
      primeiraCompraEm: primeira,
      ultimaCompraEm: ultima,
      diasDesdeUltimaCompra: diasUltima,
      diasDesdePrimeiraCompra: diasPrimeira,
      mediaDiasEntreCompras: n > 1 ? Math.round(diasDeCalendario(primeira, ultima, fuso) / (n - 1)) : null,
      comprasPorMes: Math.round((n / Math.max(1, diasPrimeira / 30)) * 100) / 100,
      diaPreferido: moda(momentos.map((m) => m.dia))!,
      periodoPreferido: moda(momentos.map((m) => periodoDaHora(m.hora)))!,
      produtoFavorito: moda(itens),
      produtosComprados: [...new Set(itens)],
      faixaRecencia: faixaDeRecencia(diasUltima),
    });
  }

  // Campeão = fiel ativo na fatia superior de total gasto da loja.
  const fieisAtivos = parciais
    .filter((p) => p.diasDesdeUltimaCompra <= cortes.diasPerdido && p.numeroCompras >= cortes.comprasFiel)
    .sort((a, b) => b.totalGastoCentavos - a.totalGastoCentavos);
  // Arredonda para baixo: com menos de 5 fiéis não existe "os 20% de cima", e o único fiel não vira campeão.
  const qtdCampeoes = Math.floor(fieisAtivos.length * cortes.fatiaCampeao);
  const campeoes = new Set(fieisAtivos.slice(0, qtdCampeoes).map((p) => p.clienteId));

  return parciais.map((p) => ({ ...p, quadrante: quadranteDe(p, cortes, campeoes) }));
}

function quadranteDe(p: Omit<PerfilCliente, 'quadrante'>, cortes: CortesQuadrante, campeoes: Set<string>): Quadrante {
  if (p.diasDesdeUltimaCompra > cortes.diasPerdido) return 'perdido';
  if (campeoes.has(p.clienteId)) return 'campeao';
  if (p.numeroCompras >= cortes.comprasFiel) return 'fiel';
  if (p.numeroCompras >= 2) return 'recorrente';
  return 'novo';
}
