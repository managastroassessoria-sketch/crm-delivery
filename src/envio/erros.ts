/**
 * Erros da WhatsApp Cloud API e o que o sistema faz com cada um.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
export type AcaoErro =
  | 'reenviar'            // tentar de novo mais tarde
  | 'reenviar_amanha'     // segurado pela Meta; esperar 24 h
  | 'descadastrar'        // cliente recusou marketing
  | 'marcar_sem_whatsapp' // número não recebe WhatsApp
  | 'pausar_criativo'     // problema no template: todos os envios dele falhariam
  | 'pausar_conta'        // problema na conta/token: nada sai até resolver
  | 'desistir';           // não adianta repetir

export interface ErroConhecido {
  explicacao: string;
  acao: AcaoErro;
}

export const ERROS_WHATSAPP: Record<number, ErroConhecido> = {
  131026: { acao: 'marcar_sem_whatsapp', explicacao: 'O número não recebe mensagens (sem WhatsApp, termos não aceitos ou aplicativo antigo).' },
  131049: { acao: 'reenviar_amanha', explicacao: 'A Meta segurou a mensagem para preservar o engajamento; o limite de marketing por pessoa pode ter sido atingido.' },
  130429: { acao: 'reenviar', explicacao: 'Limite de velocidade de envio da Cloud API.' },
  131056: { acao: 'reenviar', explicacao: 'Mensagens demais para a mesma pessoa em pouco tempo.' },
  131000: { acao: 'reenviar', explicacao: 'Erro desconhecido no envio.' },
  4: { acao: 'reenviar', explicacao: 'O app atingiu o limite de chamadas da API.' },
  80007: { acao: 'reenviar', explicacao: 'A conta WhatsApp Business atingiu o limite de chamadas.' },
  131050: { acao: 'descadastrar', explicacao: 'O cliente recusou receber mensagens de marketing.' },
  132000: { acao: 'pausar_criativo', explicacao: 'A quantidade de variáveis não bate com o template.' },
  132001: { acao: 'pausar_criativo', explicacao: 'Template inexistente nesse idioma ou não aprovado.' },
  132015: { acao: 'pausar_criativo', explicacao: 'Template pausado pela Meta por baixa qualidade.' },
  132016: { acao: 'pausar_criativo', explicacao: 'Template desativado de vez pela Meta; é preciso criar outro.' },
  131048: { acao: 'pausar_conta', explicacao: 'Envio restringido para este número por bloqueios ou denúncias de spam.' },
  131031: { acao: 'pausar_conta', explicacao: 'Conta restringida por violação de política.' },
  368: { acao: 'pausar_conta', explicacao: 'Conta restringida ou desativada por violação de política.' },
  133010: { acao: 'pausar_conta', explicacao: 'O número da loja não está registrado na plataforma.' },
  190: { acao: 'pausar_conta', explicacao: 'Token de acesso expirado.' },
  131047: { acao: 'desistir', explicacao: 'Mais de 24 horas desde a última resposta do cliente; só template pode ser enviado.' },
  131051: { acao: 'desistir', explicacao: 'Tipo de mensagem não suportado.' },
  130472: { acao: 'desistir', explicacao: 'A mensagem ficou fora de um experimento da Meta.' },
};

export function interpretarErro(codigo: number | undefined): ErroConhecido {
  return (codigo !== undefined && ERROS_WHATSAPP[codigo]) || { acao: 'desistir', explicacao: `Erro não catalogado (${codigo ?? 'sem código'}).` };
}
