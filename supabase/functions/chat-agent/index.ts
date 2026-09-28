// Proxy do chat: busca os documentos relevantes, monta o prompt e chama o provedor.
//
// Usa Chat Completions, formato compativel entre OpenRouter, NVIDIA NIM e OpenAI.
// A Chat Completions e stateless - nao ha conversa guardada no provedor - entao o
// historico e nosso, e vive em chat_sessions no Supabase.
// do docs/MIGRATION_ANALYSIS.md determina que a memoria de conversa deve ficar.
//
// O historico vem do BANCO, nao do corpo da requisicao. Numa function publica, aceitar
// historico do cliente permitiria forjar turnos de "assistant" e fazer o agente
// afirmar coisas que nunca disse.

const PROVIDERS = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    // Gratuito e verificado em 21/09/2026, com 1M de contexto. Modelos :free entram e
    // saem do catalogo; se este sair, a resposta aponta o secret LLM_MODEL.
    defaultModel: "nvidia/nemotron-3.5-lightning:free" as string | null,
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    // Sem default: cravar modelo pago no codigo o faz apodrecer quando o provedor
    // aposenta aquela versao.
    defaultModel: null as string | null,
  },
  anthropic: {
    // API nativa (/v1/messages), e nao a camada compativel com OpenAI que a Anthropic
    // tambem expoe. A documentacao dela diz que essa camada serve para testar e
    // comparar modelos e "nao e considerada solucao de longo prazo ou pronta para
    // producao", alem de nao suportar prompt caching. Usar o formato nativo custa as
    // tres adaptacoes tratadas abaixo - system como campo proprio, autenticacao por
    // x-api-key e stream em eventos content_block_delta - e evita depender de uma
    // camada que a propria fornecedora nao recomenda para producao.
    url: "https://api.anthropic.com/v1/messages",
    defaultModel: null as string | null,
  },
};

type ProviderName = keyof typeof PROVIDERS;

const corsHeaders = {
  // '*' porque o dominio muda entre preview e producao. CORS e protecao de navegador
  // e nao impede um curl - quem limita abuso e o rate limit, e no futuro a autenticacao.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const MAX_MESSAGE_LENGTH = 2000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
// Teto de tokens da resposta.
//
// Medido em producao em 23/09/2026, logo apos o provedor anthropic entrar no ar: com
// 1_200, a resposta de um processo longo parava no cabecalho da terceira
// tabela, sem uma linha de dado e sem o aviso final - 2.965 caracteres, exatamente o
// teto. O que escondia o defeito e que resposta curta cabia: "quais os passos das
// resposta de processo curto saia inteira, com o aviso no fim.
//
// Um POP inteiro em tabela e longo por natureza - o de Fechamento tem quatro blocos de
// atividades - entao o teto precisa caber o maior deles com folga. Token de saida e
// cobrado por token gerado, nao pelo teto, entao subir o limite nao custa nada em
// resposta curta.
//
// Vem de env para que ajustar nao exija deploy da edge function. O corte em 32_000
// credito. O corte em 32_000 evita que um valor digitado errado no secret vire uma
// conta alta sem querer.
const MAX_RESPOSTA_TOKENS = (() => {
  const bruto = Number(Deno.env.get("LLM_MAX_TOKENS"));
  return Number.isFinite(bruto) && bruto > 0 ? Math.min(Math.trunc(bruto), 32_000) : 8_000;
})();
const BANCO_TIMEOUT_MS = 10_000;

const MAX_HISTORY_MESSAGES = 6;

// Quantos documentos entram no prompt e quanto texto no total. A base toda tem ~93k
// tokens e o modelo aceita 1M, entao caberia inteira - mas mandar tudo a cada turno
// paga latencia por informacao irrelevante.
//
// Dois, e nao tres: como a busca ranqueia por titulo, o primeiro resultado quase sempre
// e a resposta, e os seguintes entram como ruido. Ver a migracao dos documentos.
// Quantos documentos entram no prompt e quanto texto no total.
//
// Dois documentos, e nao um: acervo de procedimentos tem titulo parecido de verdade -
// o mesmo nome de processo em duas areas, ou um nome que e prefixo do outro. Medido:
// numa pergunta generica por "reportes", o documento certo cai em 2o lugar. Com um so,
// o agente responderia pelo documento errado com total confianca.
//
// 42k caracteres porque o maior documento do acervo tem 19.804. Abaixo disso comeca a
// truncar procedimento no meio: com o teto anterior de 9k, 14 dos 37 documentos eram
// cortados, o maior perdendo 55%. Num POP contabil isso significa o agente descrever os
// primeiros passos sem saber que existem os seguintes - pior que demorar mais.
const MAX_DOCUMENTOS = 2;
const MAX_CHARS_DOCUMENTOS = 42_000;

// ---------------------------------------------------------------------------
// Rate limit: em memoria, por instancia.
//
// Edge functions sao efemeras e escalam, entao cada instancia conta separado. Segura
// rajada de um cliente so; nao e defesa contra abuso distribuido.
//
// Desde que a function passou a exigir login (ver authenticatedUserId), este limite
// deixou de ser a unica barreira: o chamador precisa de um token valido antes de
// chegar aqui.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const hits = new Map<string, number[]>();

function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();

  if (hits.size > 10_000) {
    for (const [k, times] of hits) {
      const recent = times.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) hits.delete(k);
      else hits.set(k, recent);
    }
  }

  const times = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (times.length >= RATE_LIMIT_MAX) {
    hits.set(key, times);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - times[0])) / 1000)),
    };
  }

  times.push(now);
  hits.set(key, times);
  return { allowed: true, retryAfterSeconds: 0 };
}

// ---------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

function clientIpFrom(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "desconhecido";
}

type ChatMessage = { role: "user" | "assistant"; content: string };
type Documento = { slug: string; titulo: string; grupo: string; conteudo: string; imagens: number };

// ---------------------------------------------------------------------------
// Acesso ao Supabase via PostgREST.
//
// fetch direto em vez do supabase-js: sao dois selects e um insert, e assim a function
// nao carrega dependencia externa. SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao
// injetadas automaticamente nas edge functions.
// ---------------------------------------------------------------------------

function supabaseConfig() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return {
    url,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    } as Record<string, string>,
  };
}

async function authenticatedUserId(req: Request): Promise<string> {
  const cfg = supabaseConfig();
  const authorization = req.headers.get("authorization");
  if (!cfg || !authorization?.toLowerCase().startsWith("bearer ")) {
    throw new HttpError("Entre na sua conta para usar o assistente.", 401);
  }

  const res = await fetch(`${cfg.url}/auth/v1/user`, {
    headers: { apikey: cfg.headers.apikey, Authorization: authorization },
    signal: AbortSignal.timeout(BANCO_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError("Sua sessão expirou. Entre novamente.", 401);
  const user = await res.json().catch(() => null) as { id?: unknown } | null;
  if (typeof user?.id !== "string") throw new HttpError("Sua sessão é inválida.", 401);
  return user.id;
}

async function loadHistory(sessionId: string, userId: string): Promise<ChatMessage[]> {
  const cfg = supabaseConfig();
  if (!cfg) return [];

  const query = new URLSearchParams({
    session_id: `eq.${sessionId}`,
    user_id: `eq.${userId}`,
    select: "role,content",
    order: "created_at.desc",
    limit: String(MAX_HISTORY_MESSAGES),
  });

  try {
    const res = await fetch(`${cfg.url}/rest/v1/chat_sessions?${query}`, {
      headers: cfg.headers,
      signal: AbortSignal.timeout(BANCO_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Falha ao ler historico (${res.status}):`, await res.text().catch(() => ""));
      return [];
    }
    const rows = (await res.json()) as ChatMessage[];
    // Vem decrescente para o limit pegar as mais recentes; o prompt precisa da ordem
    // cronologica.
    return Array.isArray(rows) ? rows.reverse() : [];
  } catch (err) {
    // Historico indisponivel degrada a memoria, mas nao deve derrubar a conversa.
    console.error("Erro ao ler historico:", err);
    return [];
  }
}

async function saveTurn(sessionId: string, userId: string, userMessage: string, assistantMessage: string) {
  const cfg = supabaseConfig();
  if (!cfg) return;

  try {
    const res = await fetch(`${cfg.url}/rest/v1/chat_sessions`, {
      method: "POST",
      headers: { ...cfg.headers, Prefer: "return=minimal" },
      body: JSON.stringify([
        { session_id: sessionId, user_id: userId, role: "user", content: userMessage },
        { session_id: sessionId, user_id: userId, role: "assistant", content: assistantMessage },
      ]),
      signal: AbortSignal.timeout(BANCO_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Falha ao gravar historico (${res.status}):`, await res.text().catch(() => ""));
    }
  } catch (err) {
    // O usuario ja tem a resposta; perder a gravacao nao justifica devolver erro.
    console.error("Erro ao gravar historico:", err);
  }
}

/**
 * Catalogo completo dos documentos: titulo e grupo dos 37.
 *
 * Vai no prompt em TODA requisicao, por dois motivos medidos:
 *
 * 1. Pergunta de enumeracao ("quais processos existem?") nao e respondida pela
 *    busca, que devolve os 2 documentos mais relevantes. O agente listava 4 de 26 em
 *    uma fracao do acervo e afirmava que o resto nao existia.
 * 2. Sem saber o que existe, ele inventa nome de documento - chegou a citar
 *    nome de processo que nao existe no acervo, com toda a convicçao.
 *
 * Custa ~200 tokens, medido sobre os titulos reais. Cache em memoria porque o catalogo
 * muda so quando os documentos sao recarregados; a instancia e efemera, entao o pior
 * caso e uma consulta a cada instancia nova.
 */
const CATALOGO_TTL_MS = 10 * 60 * 1000;
let catalogoCache: { texto: string; em: number } | null = null;

async function catalogoDeDocumentos(): Promise<string> {
  if (catalogoCache && Date.now() - catalogoCache.em < CATALOGO_TTL_MS) {
    return catalogoCache.texto;
  }

  const cfg = supabaseConfig();
  if (!cfg) return "";

  try {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/listar_documentos`, {
      method: "POST",
      headers: cfg.headers,
      body: "{}",
      signal: AbortSignal.timeout(BANCO_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Falha ao listar documentos (${res.status})`);
      return catalogoCache?.texto ?? "";
    }
    const rows = (await res.json()) as Array<{ titulo: string; grupo: string }>;
    if (!Array.isArray(rows) || rows.length === 0) return "";

    // Os grupos vem do proprio banco, nao de uma lista no codigo.
    //
    // A primeira versao deste trecho, herdada do projeto anterior, filtrava por
    // dois grupos cravados no codigo. Ao reusar em outro cliente, cujos grupos eram
    // entao os dois filtros voltavam vazios e o catalogo chegava ao modelo dizendo
    // "GRUPO (0 processos)". O agente respondia, com toda a educacao, que o catalogo
    // estava vazio e que os documentos ainda nao tinham sido carregados - enquanto a
    // busca funcionava normalmente na mesma requisicao.
    //
    // Derivar do dado faz o catalogo acompanhar qualquer mudanca de taxonomia sem
    // tocar no codigo, que e o unico jeito de esse bug nao voltar no proximo cliente.
    const grupos = [...new Set(rows.map((r) => r.grupo))].sort();
    const texto = grupos
      .map((g) => {
        const titulos = rows.filter((r) => r.grupo === g).map((r) => r.titulo).sort();
        return `${g.toUpperCase()} (${titulos.length}): ${titulos.join(", ")}.`;
      })
      .join("\n");

    catalogoCache = { texto, em: Date.now() };
    return texto;
  } catch (err) {
    console.error("Erro ao listar documentos:", err);
    return catalogoCache?.texto ?? "";
  }
}

/**
 * Busca os POPs e manuais relevantes para a pergunta.
 *
 * A ordenacao vem da funcao `buscar_documentos` no banco, que usa o indice full-text
 * em portugues com o titulo pesando mais que o corpo. Ver a migracao para o porque de
 * a consulta ser reconstruida com OR.
 */
async function buscarDocumentos(pergunta: string): Promise<Documento[]> {
  const cfg = supabaseConfig();
  if (!cfg) {
    console.error("Busca de documentos indisponivel: SUPABASE_URL/SERVICE_ROLE_KEY ausentes");
    return [];
  }

  try {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/buscar_documentos`, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({ consulta: pergunta, limite: MAX_DOCUMENTOS }),
      signal: AbortSignal.timeout(BANCO_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Falha na busca de documentos (${res.status}):`, await res.text().catch(() => ""));
      return [];
    }
    const rows = await res.json();
    return Array.isArray(rows) ? (rows as Documento[]) : [];
  } catch (err) {
    // Sem documentos o agente cai no comportamento de admitir que nao sabe, que e
    // seguro. Derrubar a conversa seria pior.
    console.error("Erro na busca de documentos:", err);
    return [];
  }
}

/** Monta o bloco de contexto, respeitando o teto de caracteres. */
function contextoDosDocumentos(docs: Documento[]): { bloco: string; usados: Documento[] } {
  const usados: Documento[] = [];
  const partes: string[] = [];
  let total = 0;

  // O teto tambem e reforcado aqui, e nao so no `limite` passado a RPC: a garantia
  // fica local, sem depender de o banco honrar o parametro.
  for (const d of docs.slice(0, MAX_DOCUMENTOS)) {
    if (total + d.conteudo.length > MAX_CHARS_DOCUMENTOS && usados.length > 0) break;
    const conteudo =
      d.conteudo.length > MAX_CHARS_DOCUMENTOS
        ? d.conteudo.slice(0, MAX_CHARS_DOCUMENTOS) + "\n\n[documento truncado]"
        : d.conteudo;
    partes.push(`--- INICIO DO DOCUMENTO: ${d.titulo} ---\n${conteudo}\n--- FIM DO DOCUMENTO: ${d.titulo} ---`);
    total += conteudo.length;
    usados.push(d);
  }

  return { bloco: partes.join("\n\n"), usados };
}

// ---------------------------------------------------------------------------

function resolveProvider() {
  const raw = (Deno.env.get("LLM_PROVIDER") ?? "openrouter").toLowerCase();
  if (raw !== "openrouter" && raw !== "openai" && raw !== "anthropic") {
    throw new HttpError('LLM_PROVIDER invalido: use "openrouter", "anthropic" ou "openai".', 500);
  }
  const name = raw as ProviderName;
  const provider = PROVIDERS[name];

  // Aceita o nome neutro e os especificos, pra troca de provedor nao exigir
  // recadastrar o secret da chave.
  const nomeDaChave: Record<ProviderName, string> = {
    openrouter: "OPENROUTER_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };
  const apiKey = Deno.env.get("LLM_API_KEY") ?? Deno.env.get(nomeDaChave[name]);
  if (!apiKey) {
    throw new HttpError("Backend sem chave de API configurada (LLM_API_KEY).", 500);
  }

  const model = Deno.env.get("LLM_MODEL") ?? provider.defaultModel;
  if (!model) {
    throw new HttpError("Backend sem LLM_MODEL configurada.", 500);
  }

  return { name, url: provider.url, model, apiKey };
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 5_000);
  return 600 * (attempt + 1) + Math.floor(Math.random() * 300);
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A Anthropic nao aceita `system` dentro de `messages`: e um campo proprio do corpo.
 * E a lista de turnos tem duas regras que a nossa nao garante sozinha - tem de comecar
 * com `user` e nao pode ter dois turnos seguidos do mesmo papel.
 *
 * O historico vem do banco em pares, mas um par gravado pela metade quebraria a
 * chamada com 400 - e isso acontece de verdade aqui: quando o stream falha depois de
 * a pergunta ter sido gravada, sobra um `user` sem `assistant`. Normalizar na saida e
 * mais barato do que depender de o banco estar sempre consistente.
 */
function corpoAnthropic(model: string, messages: Array<{ role: string; content: string }>) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const turnos: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    // Historico que comeca com resposta do agente: descarta ate achar a primeira
    // pergunta, porque a API recusa lista que nao comece em `user`.
    if (turnos.length === 0 && m.role === "assistant") continue;
    const ultimo = turnos[turnos.length - 1];
    if (ultimo?.role === m.role) {
      ultimo.content += `\n\n${m.content}`;
      continue;
    }
    turnos.push({ role: m.role, content: m.content });
  }

  return { model, system, messages: turnos, stream: true, max_tokens: MAX_RESPOSTA_TOKENS };
}

async function openLlmStream(
  provider: ReturnType<typeof resolveProvider>,
  messages: Array<{ role: string; content: string }>,
): Promise<Response> {
  const ehAnthropic = provider.name === "anthropic";
  const headers: Record<string, string> = ehAnthropic
    ? {
        // A Anthropic nativa autentica por x-api-key, nao por Bearer, e exige a
        // versao da API declarada em todo pedido.
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      }
    : {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      };
  // Nome que aparece no painel do OpenRouter. Troque pelo do projeto.
  if (provider.name === "openrouter") headers["X-Title"] = "Assistente de Procedimentos";

  // `reasoning` e campo do OpenRouter e nao existe na Anthropic; mandar para ela seria
  // ruido. O controle de raciocinio no lado da Anthropic e o campo `thinking`, que
  // deixamos no default do modelo de proposito - nos modelos Haiku ele e adaptativo.
  const corpo = ehAnthropic
    ? corpoAnthropic(provider.model, messages)
    : {
        model: provider.model,
        messages,
        stream: true,
        max_tokens: MAX_RESPOSTA_TOKENS,
        reasoning: { enabled: false },
      };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(provider.url, {
        method: "POST",
        headers,
        body: JSON.stringify(corpo),
      });
    } catch {
      if (attempt === 0) {
        await wait(700);
        continue;
      }
      throw new HttpError("Nao foi possivel alcancar o provedor do modelo.", 502);
    }

    if (res.ok && res.body) return res;
    const detail = await res.text().catch(() => "<sem corpo>");
    console.error(`${provider.name} respondeu ${res.status} para o modelo ${provider.model}: ${detail}`);
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await wait(retryDelayMs(res, attempt));
      continue;
    }
    // A mensagem antiga dizia "aguarde um instante", o que e verdade so para o teto
    // por minuto. No tier gratuito do OpenRouter o teto que bate na pratica e o
    // diario, de 50 requisicoes por conta que nunca comprou credito - ali a espera e
    // de horas, e a mensagem antiga fazia o usuario tentar de novo em vao.
    if (res.status === 429) {
      throw new HttpError(
        "O provedor recusou por limite de uso. Em modelo gratuito esse teto e diario.",
        429,
      );
    }
    if (res.status === 400 || res.status === 404) {
      throw new HttpError(`O provedor rejeitou o modelo "${provider.model}". Verifique o secret LLM_MODEL.`, 502);
    }
    if (res.status === 401 || res.status === 403) throw new HttpError("A chave de API foi recusada pelo provedor.", 502);
    throw new HttpError("O agente nao conseguiu responder agora.", 502);
  }
  throw new HttpError("O agente nao conseguiu responder agora.", 502);
}

// Os eventos do stream nativo da Anthropic. Reconhecer a lista, em vez de aceitar
// qualquer payload que tenha `type`, evita que um formato futuro do OpenRouter com
// esse campo caia no ramo errado e a resposta suma sem erro nenhum.
const EVENTOS_ANTHROPIC = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
  "error",
]);

function ndjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

async function pipeLlmAttempt(
  upstream: Response,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<string> {
  const reader = upstream.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const payload = JSON.parse(data);

      // Dois formatos de stream. A Anthropic nativa manda eventos tipados e o texto
      // vem so em `content_block_delta` com delta do tipo `text_delta`; o raciocinio
      // vem em `thinking_delta`, que NAO entra na resposta - foi exatamente esse
      // vazamento que apareceu na tela em 21/09/2026 com o modelo gratuito.
      if (typeof payload?.type === "string" && EVENTOS_ANTHROPIC.has(payload.type)) {
        if (payload.type === "error") {
          console.error("Anthropic sinalizou erro no meio do stream:", payload.error);
          return;
        }
        if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
          const texto = typeof payload.delta.text === "string" ? payload.delta.text : "";
          if (texto) {
            answer += texto;
            controller.enqueue(ndjson({ type: "delta", text: texto }));
          }
        }
        return;
      }

      const delta = payload?.choices?.[0]?.delta;
      const content = typeof delta?.content === "string" ? delta.content : "";
      const reasoning = !content && typeof delta?.reasoning === "string" ? delta.reasoning : "";
      const chunk = content || reasoning;
      if (chunk) {
        answer += chunk;
        controller.enqueue(ndjson({ type: "delta", text: chunk }));
      }
    } catch (error) {
      console.warn("Evento SSE invalido do provedor:", error);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  return answer.trim();
}

/**
 * Devolve a resposta em streaming.
 *
 * A conexao com o modelo e aberta DENTRO do stream, de proposito. Antes ela era
 * aguardada antes de retornar a Response: o navegador nao recebia nada enquanto o
 * provedor nao aceitasse a requisicao e devolvesse o primeiro byte, e nesse intervalo
 * a tela ficava so com o spinner. Como o modelo gratuito costuma demorar para comecar,
 * era ai que ia a maior parte do tempo percebido.
 *
 * Agora a Response volta imediatamente e o primeiro evento e o `meta` com as fontes -
 * que ja estao em maos, porque a busca terminou antes. O usuario ve de qual POP a
 * resposta vem enquanto o modelo ainda esta pensando.
 */
function streamedReply(
  provider: ReturnType<typeof resolveProvider>,
  messages: Array<{ role: string; content: string }>,
  sessionId: string,
  userId: string,
  userMessage: string,
  fontes: Array<{ slug: string; titulo: string; imagens: number }>,
): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Primeiro byte imediato: as fontes ja estao resolvidas neste ponto.
      controller.enqueue(ndjson({ type: "meta", fontes }));
      try {
        const initialUpstream = await openLlmStream(provider, messages);
        let answer = await pipeLlmAttempt(initialUpstream, controller);
        if (!answer) {
          console.warn("Modelo encerrou o stream sem texto; fazendo uma unica nova tentativa.");
          const retry = await openLlmStream(provider, messages);
          answer = await pipeLlmAttempt(retry, controller);
        }
        if (!answer) throw new Error("O agente respondeu em branco duas vezes.");
        await saveTurn(sessionId, userId, userMessage, answer);
        controller.enqueue(ndjson({ type: "done" }));
      } catch (error) {
        console.error("Falha durante o stream do chat-agent:", error);
        controller.enqueue(ndjson({
          type: "error",
          error: error instanceof HttpError ? error.message : "O agente nao conseguiu concluir a resposta.",
        }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "POST, OPTIONS" });
  }

  const { allowed, retryAfterSeconds } = checkRateLimit(clientIpFrom(req));
  if (!allowed) {
    return json({ error: "Muitas mensagens seguidas. Aguarde alguns segundos." }, 429, {
      "Retry-After": String(retryAfterSeconds),
    });
  }

  try {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Corpo da requisicao nao e JSON valido." }, 400);
    }

    const { message, sessionId } = (payload ?? {}) as { message?: unknown; sessionId?: unknown };

    if (typeof message !== "string" || !message.trim()) {
      return json({ error: "O campo 'message' e obrigatorio." }, 400);
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return json({ error: `A mensagem passa de ${MAX_MESSAGE_LENGTH} caracteres.` }, 413);
    }
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
      return json({ error: "sessionId invalido." }, 400);
    }

    const trimmed = message.trim();

    // A autenticacao era serial e custava um round trip inteiro antes de qualquer
    // outra coisa comecar. A busca de documentos nao depende do usuario, entao as duas
    // partem juntas. O historico depende do userId (e escopado por usuario), por isso
    // so pode comecar depois do auth - mas ai ja sobrepoe o final da busca.
    const authPromise = authenticatedUserId(req);
    const docsPromise = buscarDocumentos(trimmed);
    const catalogoPromise = catalogoDeDocumentos();

    // Se a autenticacao falhar, ninguem mais espera por estas duas. Sem um handler
    // aqui, uma rejeicao delas vira unhandled rejection e derruba o isolate inteiro -
    // o `await` la embaixo continua enxergando o erro normalmente.
    docsPromise.catch(() => {});
    catalogoPromise.catch(() => {});

    const userId = await authPromise;

    // Configuracao so e checada DEPOIS de autenticar.
    //
    // Na ordem inversa, uma requisicao anonima a um backend mal configurado recebia
    // 500 com "Backend sem chave de API configurada" - contando a quem nao esta
    // logado em que estado esta a instalacao, e mascarando o 401 que deveria ter
    // vindo. Foi o que apareceu no primeiro teste deste projeto, antes de qualquer
    // secret existir.
    const provider = resolveProvider();

    // O prompt de sistema aqui NAO e enfeite: e o que impede o modelo de inventar
    // passo de procedimento que nao existe.
    //
    // Por isso duas decisoes:
    // 1. Aceita variacoes do nome do secret - um plural trocado nao pode desligar
    //    silenciosamente um controle de seguranca.
    // 2. Falta de instrucao e erro explicito, nao degradacao silenciosa.
    const instructions =
      Deno.env.get("LLM_INSTRUCTIONS") ??
      Deno.env.get("LLM_INSTRUCTION") ??
      Deno.env.get("OPENAI_INSTRUCTIONS");
    if (!instructions?.trim()) {
      console.error("LLM_INSTRUCTIONS ausente - recusando responder sem prompt de sistema");
      throw new HttpError("Backend sem LLM_INSTRUCTIONS configurada.", 500);
    }
    const [historico, encontrados, catalogo] = await Promise.all([
      loadHistory(sessionId, userId),
      docsPromise,
      catalogoPromise,
    ]);
    const { bloco, usados } = contextoDosDocumentos(encontrados);

    // Os documentos vao numa mensagem `system` propria, depois das instrucoes: assim a
    // persona e as regras de seguranca continuam valendo, e o conteudo aparece como
    // material de consulta - nao como ordem vinda do usuario.
    const contextoSystem = bloco
      ? [
          {
            role: "system",
            content:
              "Documentos internos recuperados para esta pergunta. Responda com base " +
              "APENAS neles quando a pergunta for sobre um processo interno, e cite o " +
              "titulo do documento usado. Se a resposta nao estiver neles, diga isso " +
              "em vez de supor.\n\n" +
              bloco,
          },
        ]
      : [
          {
            role: "system",
            content:
              "Nenhum documento interno correspondeu a esta pergunta. Nao invente " +
              "procedimento: diga que nao encontrou o documento e sugira reformular ou " +
              "consultar a base de POPs.",
          },
        ];

    // Catalogo antes dos documentos recuperados: o agente precisa saber o que existe
    // para enumerar e para negar com seguranca, sem inventar nome de documento.
    const catalogoSystem = catalogo
      ? [
          {
            role: "system",
            content:
              "Catalogo completo dos documentos que existem na base. Use esta lista " +
              "para responder QUAIS processos existem, e para dizer com seguranca que " +
              "algo nao esta documentado. NUNCA cite um documento que nao esteja nesta " +
              "lista. Ter o titulo aqui nao significa ter o conteudo: o conteudo so " +
              "esta disponivel quando o documento aparece na secao de documentos " +
              "recuperados abaixo.\n\n" +
              catalogo,
          },
        ]
      : [];

    const messages = [
      { role: "system", content: instructions },
      ...catalogoSystem,
      {
        role: "system",
        content:
          "Responda de forma direta e concisa. Priorize somente os passos e dados " +
          "necessarios para a pergunta atual; nao repita trechos inteiros do documento.",
      },
      ...contextoSystem,
      ...historico,
      { role: "user", content: trimmed },
    ];

    return streamedReply(
      provider,
      messages,
      sessionId,
      userId,
      trimmed,
      usados.map((d) => ({ slug: d.slug, titulo: d.titulo, imagens: d.imagens })),
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    console.error("Erro inesperado no chat-agent:", error);
    return json({ error: "Erro ao processar a mensagem." }, 500);
  }
});
