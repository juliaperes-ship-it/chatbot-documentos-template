import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type Fonte = {
  slug: string;
  titulo: string;
  imagens: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  fontes?: Fonte[];
};

export const MAX_MESSAGE_LENGTH = 2000;

// Teto total e teto de inatividade do stream.
//
// Sem eles, um stream que abre e para de enviar (acontece com o endpoint gratuito)
// deixava `await reader.read()` pendurado para sempre: o `finally` nunca rodava,
// isLoading ficava true e o campo de mensagem ficava desabilitado ate recarregar a
// pagina. O usuario nao conseguia mais enviar nada.
//
// O teto de inatividade NAO pode ser calibrado por "quanto tempo uma resposta longa
// demora". Modelo de raciocinio passa o inicio inteiro pensando, sem emitir byte
// nenhum, e o relogio conta esse tempo todo.
//
// Medido em producao: uma pergunta recebeu o evento `meta` na hora e o primeiro
// caractere de texto so ~73 segundos depois. Com o teto em 45s, o cliente abortava
// uma resposta que estava CORRETA - ela chegou completa ao banco 73s depois do
// pedido, no formato certo. O usuario via "o agente parou de responder" e perdia uma
// resposta que existia.
//
// Calibre pelo tempo ate o PRIMEIRO caractere, nao pelo tamanho da resposta. E
// mantenha o teto abaixo do corte que a edge function aplica no provedor
// (LLM_TIMEOUT_MS) somado ao overhead dela: assim ele continua sendo rede de
// seguranca para stream morto, e nao um mascarador do erro que a function ja daria.
//
// Com `reasoning` desligado no provedor, esse tempo cai muito e o teto volta a ser
// folga pura - mas deixe folgado de todo jeito, porque o custo de errar para baixo e
// perder resposta boa.
const TIMEOUT_TOTAL_MS = 180_000;
const TIMEOUT_INATIVIDADE_MS = 105_000;

// O sufixo de versao existe para poder invalidar o estado salvo quando o formato
// mudar: basta incrementar, e todo navegador comeca limpo em vez de tentar ler um
// formato antigo.
const STORAGE_KEY = "chat-state-v1";

type PersistedState = {
  sessionId: string;
  messages: ChatMessage[];
};

function newSessionId() {
  return crypto.randomUUID();
}

/**
 * sessionId e mensagens sao gravados juntos, numa chave so.
 *
 * O historico de verdade vive no banco (chat_sessions), chaveado pelo
 * sessionId - o localStorage aqui so repinta a tela. Se os dois fossem gravados
 * separados poderiam dessincronizar: o agente lembraria da conversa enquanto a tela
 * apareceria vazia, ou o contrario.
 */
function loadState(userId: string): PersistedState {
  const fresh = (): PersistedState => ({ sessionId: newSessionId(), messages: [] });

  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${userId}`);
    if (!raw) return fresh();

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return fresh();

    const { sessionId, messages } = parsed as Partial<PersistedState>;
    if (typeof sessionId !== "string" || !sessionId || !Array.isArray(messages)) return fresh();

    // Descarta entradas malformadas em vez de deixar o render quebrar depois.
    const valid = messages.filter(
      (m): m is ChatMessage =>
        typeof m === "object" &&
        m !== null &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    );

    return { sessionId, messages: valid.filter(naoEhBolhaVazia) };
  } catch {
    // localStorage indisponivel (modo privado) ou JSON corrompido: comeca limpo.
    return fresh();
  }
}

/**
 * Uma bolha de assistente sem texto e um estado transitorio valido: ela e criada no
 * evento `meta`, antes do primeiro pedaco de texto, para as fontes aparecerem na hora.
 * Persistida, virava defeito - ao recarregar a pagina ela reaparecia e o indicador
 * "Consultando o documento..." ficava eterno, porque quem desenha o indicador e a
 * propria bolha vazia e nao havia mais stream nenhum para preenche-la. Aconteceu em
 * teste em 22/09/2026, com duas bolhas vazias no localStorage.
 */
function naoEhBolhaVazia(m: ChatMessage) {
  return m.role !== "assistant" || m.content.trim().length > 0;
}

function parseFontes(raw: unknown): Fonte[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const fontes = raw.filter(
    (f): f is Fonte =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as Fonte).slug === "string" &&
      typeof (f as Fonte).titulo === "string",
  );
  return fontes.length ? fontes : undefined;
}

export function useChat(userId: string) {
  const initial = useRef<PersistedState>();
  if (!initial.current) initial.current = loadState(userId);

  const [messages, setMessages] = useState<ChatMessage[]>(initial.current.messages);
  const [sessionId, setSessionId] = useState<string>(initial.current.sessionId);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        `${STORAGE_KEY}:${userId}`,
        JSON.stringify({ sessionId, messages: messages.filter(naoEhBolhaVazia) }),
      );
    } catch {
      // Cota estourada ou storage bloqueado: a conversa segue viva em memoria.
    }
  }, [sessionId, messages, userId]);

  /**
   * @returns null em caso de sucesso, ou a mensagem de erro a ser exibida.
   */
  const sendMessage = useCallback(
    async (rawInput: string): Promise<string | null> => {
      const message = rawInput.trim();
      if (!message || isLoading) return null;
      if (message.length > MAX_MESSAGE_LENGTH) {
        return `A mensagem passa de ${MAX_MESSAGE_LENGTH} caracteres.`;
      }

      // A mensagem do usuario permanece na tela mesmo se a resposta falhar -
      // assim ela nao precisa redigitar para tentar de novo.
      setMessages((prev) => [...prev, { role: "user", content: message }]);
      setIsLoading(true);

      const controller = new AbortController();
      let porInatividade = false;
      let inatividade: ReturnType<typeof setTimeout> | undefined;
      const rearmaInatividade = () => {
        if (inatividade) clearTimeout(inatividade);
        inatividade = setTimeout(() => {
          porInatividade = true;
          controller.abort();
        }, TIMEOUT_INATIVIDADE_MS);
      };
      const total = setTimeout(() => controller.abort(), TIMEOUT_TOTAL_MS);
      rearmaInatividade();

      try {
        // Só a mensagem e o sessionId vao no corpo. O historico NAO e enviado pelo
        // cliente de proposito: aceitar historico daqui permitiria forjar turnos de
        // "assistant" e manipular o agente.
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) return "Sua sessão expirou. Entre novamente.";

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-agent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ message, sessionId }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const data = await response.json().catch(() => null);
          // O backend manda uma mensagem legivel em `error`; sem ela, generico.
          return data?.error ?? "Nao foi possivel enviar a mensagem.";
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/x-ndjson") || !response.body) {
          const data = await response.json().catch(() => null);
          if (!data || typeof data.response !== "string" || !data.response) {
            return "O agente respondeu em branco. Tente de novo.";
          }
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: data.response, fontes: parseFontes(data.fontes) },
          ]);
          return null;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let answer = "";
        let fontes: Fonte[] | undefined;
        let streamError: string | null = null;

        const consumeLine = (line: string) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line) as { type?: string; text?: unknown; fontes?: unknown; error?: unknown };
            if (event.type === "meta") {
              fontes = parseFontes(event.fontes);
              // Cria a bolha do assistente já com as fontes, antes do primeiro texto.
              // O `meta` chega quase instantaneamente (a busca termina antes de o
              // modelo ser chamado), então o usuário passa a ver de qual POP a
              // resposta virá enquanto o modelo ainda está gerando - em vez de
              // encarar o spinner sem informação nenhuma.
              if (fontes) {
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role === "assistant") return prev;
                  return [...prev, { role: "assistant", content: "", fontes }];
                });
              }
            }
            if (event.type === "delta" && typeof event.text === "string") {
              const text = event.text;
              answer += text;
              setIsStreaming(true);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  return [...prev.slice(0, -1), { ...last, content: last.content + text, fontes }];
                }
                return [...prev, { role: "assistant", content: text, fontes }];
              });
            }
            if (event.type === "error") {
              streamError = typeof event.error === "string" ? event.error : "O agente nao concluiu a resposta.";
            }
          } catch {
            streamError = "A resposta do agente chegou em um formato invalido.";
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Cada pedaco recebido reinicia o teto de inatividade.
          rearmaInatividade();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) consumeLine(line);
        }
        buffer += decoder.decode();
        if (buffer) consumeLine(buffer);

        if (streamError) return streamError;
        if (!answer.trim()) return "O agente respondeu em branco. Tente de novo.";
        return null;
      } catch {
        if (porInatividade || controller.signal.aborted) {
          return "O agente parou de responder no meio. Tente de novo.";
        }
        return "Falha de conexao. Verifique sua internet e tente de novo.";
      } finally {
        // Sempre limpa os timers e libera o campo, inclusive quando o stream aborta.
        clearTimeout(total);
        if (inatividade) clearTimeout(inatividade);
        setIsStreaming(false);
        setIsLoading(false);
      }
    },
    [isLoading, sessionId],
  );

  /**
   * Comeca uma sessao nova em vez de apagar a anterior: o historico antigo permanece
   * em chat_sessions, e o sessionId novo garante que o agente nao receba
   * mais o contexto da conversa abandonada.
   */
  const resetConversation = useCallback(() => {
    setMessages([]);
    setSessionId(newSessionId());
  }, []);

  return { messages, isLoading, isStreaming, sendMessage, resetConversation, hasConversation: messages.length > 0 };
}
