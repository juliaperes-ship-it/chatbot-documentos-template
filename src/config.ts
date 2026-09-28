/**
 * Ponto unico de personalizacao por cliente.
 *
 * Tudo que muda de um chatbot para outro na INTERFACE esta aqui. A intencao e que
 * adaptar o template para um cliente novo seja editar este arquivo, o `index.html`,
 * a paleta no `src/index.css` e a instrucao do agente - e mais nada.
 *
 * O que NAO fica aqui, de proposito:
 * - a chave do modelo e a instrucao do agente, que sao secret da edge function;
 * - a URL do Supabase, que vem do .env;
 * - os grupos dos documentos, que saem do proprio banco.
 */

export const APP = {
  /** Aparece no cabecalho, ao lado do logo. */
  nome: "Assistente",

  /** Linha abaixo do nome. Some em telas estreitas. */
  subtitulo: "Procedimentos internos",

  /** Titulo da tela vazia, antes da primeira pergunta. */
  boasVindas: "Como posso ajudar com os procedimentos?",

  /** Explicacao curta abaixo do titulo. Diga em que o agente se baseia. */
  explicacao:
    "Pergunte pelo nome do procedimento. Respondo com base nos documentos internos, " +
    "sempre citando a fonte.",

  /** Texto dentro do campo de mensagem. */
  placeholder: "Pergunte sobre um procedimento...",

  /**
   * Botoes de sugestao da tela inicial.
   *
   * PREENCHA com nomes de processo REAIS do acervo, tirados de
   * `select titulo from documentos order by palavras desc limit 4`.
   *
   * Nao invente: sugestao que nao corresponde a um documento faz a pessoa clicar e
   * receber "nao encontrei" na primeira interacao - o pior primeiro contato
   * possivel. Vale adicionar cada uma como caso de teste em
   * `scripts/testa-migracoes.mjs`, com o texto exato que o clique envia.
   *
   * Com a lista vazia, a area de sugestoes simplesmente nao aparece.
   */
  sugestoes: [] as string[],

  /**
   * Marca do cliente no cabecalho.
   *
   * Com `logo: null`, aparece o texto de `nome` e nada mais. Para usar imagem:
   * ponha o arquivo em `src/assets/`, importe no topo de `src/pages/Index.tsx` e
   * troque aqui.
   *
   * Prefira PNG com fundo transparente e use `w-auto` na classe - largura cravada
   * estica marcas cuja proporcao seja diferente da esperada.
   */
  logo: null as string | null,
} as const;
