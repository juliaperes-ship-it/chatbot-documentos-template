import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renderiza a resposta do assistente como markdown.
 *
 * Seguranca: o react-markdown nao interpreta HTML bruto por padrao (nao usamos
 * rehype-raw), entao uma resposta contendo <script> aparece como texto literal.
 *
 * Os estilos sao definidos elemento por elemento em vez de usar a classe `prose`
 * do @tailwindcss/typography: o prose traz a propria escala de cores, que brigaria
 * com o fundo da bolha do chat.
 */
export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold">{children}</h3>,
          a: ({ children, href }) => (
            // Resposta de modelo e conteudo nao confiavel: noreferrer evita passar
            // a URL de origem, e noopener impede acesso a window.opener.
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            // Sem className => code inline; com language-* => bloco de codigo.
            const isBlock = Boolean(className);
            if (isBlock) {
              return <code className="block font-mono text-xs">{children}</code>;
            }
            return (
              <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md bg-foreground/10 p-3">{children}</pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-foreground/30 pl-3 opacity-90">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-foreground/20 px-2 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border border-foreground/20 px-2 py-1">{children}</td>,
          hr: () => <hr className="my-3 border-foreground/20" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
