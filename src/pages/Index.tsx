import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, Loader2, LogOut, RotateCcw, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { MAX_MESSAGE_LENGTH, useChat } from "@/hooks/useChat";
import { supabase } from "@/integrations/supabase/client";
import { APP } from "@/config";

type IndexProps = { userId: string };

const Index = ({ userId }: IndexProps) => {
  const { messages, isLoading, isStreaming, sendMessage, resetConversation, hasConversation } = useChat(userId);
  const [input, setInput] = useState("");
  const { toast } = useToast();

  // O ref do ScrollArea aponta para o Root do Radix, que tem overflow-hidden:
  // quem rola de fato e o Viewport interno. Por isso definir scrollTop no Root
  // (ou chamar scrollIntoView numa sentinela) nao leva a lista ao fim - e
  // preciso alcancar o Viewport pelo data-attribute que o Radix expoe.
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const isFirstPaint = useRef(true);

  useEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (!viewport) return;

    // Na primeira pintura a conversa vem inteira do localStorage: rolar suave
    // por centenas de pixels ficaria estranho, entao vai direto pro fim.
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: isFirstPaint.current ? "auto" : "smooth",
    });
    isFirstPaint.current = false;
  }, [messages, isLoading]);

  const handleSend = async (texto?: string) => {
    const error = await sendMessage(texto ?? input);
    if (error) {
      toast({ title: "Erro", description: error, variant: "destructive" });
      return;
    }
    setInput("");
  };

  // A bolha do assistente sem texto (criada pelo evento `meta`) ja e o indicador de
  // espera. Sem este check, ela e o indicador avulso apareciam juntos.
  const ultima = messages[messages.length - 1];
  const esperandoNaBolha = ultima?.role === "assistant" && !ultima.content;

  const isOverLimit = input.length > MAX_MESSAGE_LENGTH;
  const canSend = input.trim().length > 0 && !isLoading && !isOverLimit;

  return (
    // Altura cheia em vez de um card de 600px centralizado: numa tela de laptop a
    // caixa fixa deixava metade do espaco morto e a conversa parecia um widget.
    <div className="flex h-[100dvh] flex-col bg-muted/30">
      <Card className="mx-auto flex h-full w-full max-w-3xl flex-col rounded-none border-x-0 border-b-0 sm:my-4 sm:h-[calc(100dvh-2rem)] sm:rounded-lg sm:border">
        <div className="flex items-start justify-between gap-4 border-b p-4">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            {/* w-auto em vez de largura fixa: largura cravada estica a marca de um
                cliente cuja proporcao seja diferente da esperada. Ver APP.logo. */}
            {APP.logo && (
              <img src={APP.logo} alt={APP.nome} className="h-8 w-auto shrink-0 sm:h-11" />
            )}
            <div className={`min-w-0 ${APP.logo ? "border-l pl-3 sm:pl-4" : ""}`}>
              <h1 className="truncate text-base font-bold sm:text-xl">{APP.nome}</h1>
              {/* O subtitulo sai no mobile: com ele, 375px nao acomodava logo, titulo e
                  os dois botoes, e o titulo sobrepunha "Nova conversa". */}
              <p className="hidden truncate text-sm text-muted-foreground sm:block">
                {APP.subtitulo}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {hasConversation && (
              <Button variant="ghost" size="sm" onClick={resetConversation} disabled={isLoading} className="text-muted-foreground">
                <RotateCcw className="h-3.5 w-3.5 sm:mr-2" />
                <span className="hidden sm:inline">Nova conversa</span>
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => void supabase.auth.signOut()} aria-label="Sair" title="Sair">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <ScrollArea ref={scrollRootRef} className="flex-1 p-4">
          <div className="space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center gap-6 py-10 text-center">
                <div>
                  <p className="text-lg font-semibold">{APP.boasVindas}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{APP.explicacao}</p>
                </div>
                {/* Sugestoes nao sao enfeite: no historico de conversas havia gente
                    digitando "oi" e "me fala sobre oq vc pode fazer" por nao saber o
                    que pedir, e perguntas genericas trazem documento errado. */}
                <div className="flex flex-wrap justify-center gap-2">
                  {APP.sugestoes.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void handleSend(s)}
                      disabled={isLoading}
                      className="rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={
                    msg.role === "user"
                      ? // Vermelho da marca com leve transparencia: puro em 89% de
                        // saturacao fica agressivo como fundo de texto pequeno.
                        "max-w-[85%] rounded-2xl rounded-br-md bg-primary/95 px-4 py-2.5 text-primary-foreground shadow-sm"
                      : // Balao cinza, por preferencia do time. Um pouco mais largo que
                        // os 80% originais porque a resposta costuma trazer a tabela de
                        // passos do POP, que aperta em largura menor.
                        "min-w-0 max-w-[88%] rounded-2xl rounded-bl-md bg-muted px-4 py-3"
                  }
                >
                  {msg.role === "assistant" ? (
                    <>
                      {msg.content ? (
                        <ChatMarkdown content={msg.content} />
                      ) : (
                        // Bolha criada pelo evento `meta`, antes do primeiro texto:
                        // mostra que a fonte ja foi localizada em vez de ficar vazia.
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Consultando o documento...
                        </p>
                      )}
                      {/* Sem as fontes o usuario nao sabe se a resposta veio de um POP
                          ou do conhecimento geral do modelo - distincao que importa
                          quando alguem vai executar um lancamento contabil. */}
                      {msg.fontes?.length ? (
                        <div className="mt-3 border-t border-foreground/15 pt-2">
                          <p className="mb-1 text-xs font-medium text-muted-foreground">
                            {msg.fontes.length === 1 ? "Fonte" : "Fontes"}
                          </p>
                          <ul className="space-y-0.5">
                            {msg.fontes.map((f) => (
                              <li key={f.slug} className="flex items-start gap-1.5 text-xs">
                                <FileText className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                                <span>
                                  {f.titulo}
                                  {f.imagens > 0 && (
                                    <span className="text-muted-foreground">
                                      {" "}
                                      {/* Texto generico de proposito: a imagem de conteudo pode ser
                                          print de sistema, fluxograma ou diagrama, e isso varia por
                                          acervo. Se o documento trouxer link para o diagrama, a
                                          instrucao pede que o agente o inclua na resposta. */}
                                      — contém {f.imagens} imagem{f.imagens > 1 ? "ns" : ""} que o
                                      agente não lê
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    // Mensagem do usuario fica como texto puro: nao ha motivo
                    // para interpretar markdown no que ela mesma digitou.
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
                  )}
                </div>
              </div>
            ))}

            {isLoading && !isStreaming && !esperandoNaBolha && (
              <div className="flex justify-start">
                <div
                  className="flex items-center gap-2 rounded-lg bg-muted p-3 text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Consultando os documentos...</span>
                </div>
              </div>
            )}

          </div>
        </ScrollArea>

        <div className="border-t p-4">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) void handleSend();
                }
              }}
              placeholder={APP.placeholder}
              disabled={isLoading}
              aria-label="Mensagem"
              aria-invalid={isOverLimit}
            />
            <Button onClick={() => void handleSend()} disabled={!canSend} size="icon" aria-label="Enviar">
              <Send className="h-4 w-4" />
            </Button>
          </div>
          {/* O contador so aparece perto do limite, para nao poluir o uso normal. */}
          {input.length > MAX_MESSAGE_LENGTH * 0.8 && (
            <p className={`mt-2 text-xs ${isOverLimit ? "text-destructive" : "text-muted-foreground"}`}>
              {input.length} / {MAX_MESSAGE_LENGTH} caracteres
            </p>
          )}
        </div>
      </Card>
    </div>
  );
};

export default Index;
