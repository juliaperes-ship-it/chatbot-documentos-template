# Backend do chat

O chat conversa com a Edge Function `chat-agent` do Supabase. Ela busca os POPs
relevantes no banco, monta o prompt e chama o provedor de LLM. A chave de API fica so na
function - nunca no frontend.

```
Browser  ->  chat-agent  ->  buscar_documentos()  (os documentos do acervo)
                         ->  chat_sessions        (historico da conversa)
                         ->  OpenRouter (ou OpenAI)
```

Como aplicar migracoes e publicar: ver o [README](README.md).

## Variaveis de ambiente

Nos secrets das Edge Functions do Supabase (nao no `.env`, que vai pro git):

| Variavel | Obrigatoria | Para que serve |
|---|---|---|
| `LLM_API_KEY` | sim | Chave do provedor. Aceita `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `LLM_INSTRUCTIONS` | **sim** | Prompt de sistema. Aceita `LLM_INSTRUCTION` no singular |
| `LLM_PROVIDER` | nao | `openrouter` (padrao), `anthropic` ou `openai` |
| `LLM_MODEL` | nao | So tem padrao no `openrouter`: `nvidia/nemotron-3.5-lightning:free`. Nos outros e obrigatoria |
| `LLM_MAX_TOKENS` | nao | Teto de tokens da resposta. Padrao 8000, maximo 32000. Existe para ajustar sem deploy |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` sao injetadas pelo Supabase - nao cadastrar.

### Trocar de provedor

Sao dois secrets, e nenhum deles exige deploy - a function le `Deno.env` a cada
requisicao, entao vale no proximo cold start.

| Destino | `LLM_PROVIDER` | `LLM_MODEL` | Chave |
|---|---|---|---|
| Claude pela Anthropic | `anthropic` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| Claude pelo OpenRouter | `openrouter` | `anthropic/claude-haiku-4.5` | a que ja existe |
| Gratuito | `openrouter` | nenhum, usa o padrao | a que ja existe |

Cadastrar o provedor `anthropic` **exigiu deploy uma unica vez**, porque a URL e o
formato do corpo estao no codigo. Dai em diante, trocar entre os tres e so secret.

Os dois catalogos escrevem o identificador diferente: na API nativa o ID e
`claude-haiku-4-5`, com hifen; no OpenRouter e `anthropic/claude-haiku-4.5`, com
ponto. Trocar um pelo outro devolve 404, que a function traduz em "o provedor
rejeitou o modelo".

Escolha do modelo: o Haiku 4.5 nao pensa por padrao, enquanto o Sonnet 5 e o Opus 5
tem raciocinio adaptativo ligado de fabrica. Como a tarefa aqui e reformatar em
tabela um POP que ja veio inteiro no contexto, o raciocinio so somaria latencia - e
latencia por raciocinio foi justamente o que quebrou a experiencia com o modelo
gratuito, com ~70s ate o primeiro caractere.

O caminho da Anthropic usa a API nativa (`/v1/messages`), nao a camada compativel com
OpenAI: a documentacao da propria Anthropic diz que aquela camada serve para testar e
comparar modelos e nao e solucao pronta para producao.

### `LLM_INSTRUCTIONS` e obrigatoria de proposito

Se o secret estiver ausente, a function devolve **500 e nao chama o modelo**. Nao e
rigor gratuito: o prompt de sistema e o que impede o modelo de inventar transacao do
sistema, numero de conta e passo de processo. Rodar sem ele seria pior que nao
rodar, porque a resposta errada chega com a mesma confianca da certa.

Por isso tambem aceita o nome no singular: um plural trocado ao cadastrar o secret nao
pode desligar silenciosamente um controle de seguranca.

## Base de conhecimento

Os documentos vivem na tabela `documentos`, um por linha, com o texto inteiro em
Markdown. Nao ha fragmentacao: a busca devolve documentos inteiros.

Por que nao fragmentar: um procedimento e uma sequencia. Entregar o passo 7 sem os
passos 1 a 6 produz resposta errada com aparencia de certa. Fragmentar faz sentido
quando o documento e uma colecao de fatos independentes; nao quando e um processo.

Para carregar:

```
python3 scripts/extrair-documentos.py
python3 scripts/gerar-seed.py
node scripts/testa-migracoes.mjs
npx supabase db push
```

### Busca: full-text do Postgres, nao embeddings

Com 37 documentos e titulos autoexplicativos ("Inventario", "Depreciacao", "Diferimento
FVE"), embeddings seriam over-engineering - eles resolvem o problema de achar trecho
relevante entre milhares de fragmentos com titulos vagos. Adicionar uma coluna `vector`
depois e incremento, nao reescrita.

Tres decisoes na migracao `20260921130000_documentos.sql` que uma versao ingenua erraria:

- **`unaccent`.** Os titulos vem dos nomes de arquivo, sem acento ("Inventario"), mas
  quem pergunta escreve certo ("inventário"). O stemmer portugues gera lexemas
  diferentes (`inventari` vs `inventári`) e o documento nao apareceria. A configuracao
  `portugues_sem_acento` normaliza os dois lados.
- **OR em vez de AND.** `websearch_to_tsquery` une os termos com AND: "me fala mais
  sobre o inventario" exigiria que o documento tivesse "fala" E "inventario". A consulta
  e reconstruida com `|` a partir dos lexemas.
- **Peso no titulo.** Titulo com peso `A`, conteudo com `B`, para a pergunta sobre
  inventario trazer primeiro o documento chamado Inventario, e nao um que menciona a
  palavra de passagem.

### As imagens nao estao no texto

Diagrama, fluxograma e print de tela nao viram Markdown. O extrator conta quantas
imagens de CONTEUDO cada documento tem - descartando logo e rodape, que ele identifica
por aparecerem em todos os arquivos - e grava em `documentos.imagens`.

A interface mostra esse numero junto da fonte, e a instrucao pede que o agente avise.
Dizer a verdade sobre o que o sistema nao sabe vale mais que fingir completude: em
procedimento operacional, um passo inventado tem consequencia real.

Se os documentos trouxerem link para o diagrama, peca na instrucao que o agente o
inclua. E o que transforma a limitacao em resposta util: ele nao le a imagem, mas diz
onde ela esta.

## Historico da conversa

Fica em `chat_sessions`, chaveado pelo `sessionId` que o frontend gera com
`crypto.randomUUID()`.

**O historico vem do banco, nao do corpo da requisicao.** Uma versao anterior aceitava
`history` enviado pelo cliente; como o endpoint e publico, isso permitia forjar turnos de
`assistant` e fazer o agente afirmar coisas que nunca disse - por exemplo, que ja
validou um lancamento.

Se o banco estiver indisponivel, a function **responde sem contexto e sem documentos**
em vez de falhar: o agente cai no comportamento de admitir que nao sabe, que e seguro.

O teto de 20 mensagens e paliativo. A secao 10 do `docs/MIGRATION_ANALYSIS.md` (repo
`chatbook-`) critica o padrao de "despejar tudo no prompt" e define que o alvo e virar
tool call parametrizado.

## Contrato da API

`POST /functions/v1/chat-agent`

```jsonc
// Request
{ "message": "me fala sobre o inventario", "sessionId": "uuid-gerado-no-cliente" }

// 200
{
  "response": "texto em markdown",
  "fontes": [{ "slug": "comercial-atendimento", "titulo": "Atendimento", "imagens": 1 }]
}

// 4xx / 5xx
{ "error": "mensagem legivel para exibir ao usuario" }
```

| Status | Quando |
|---|---|
| 400 | `message` vazia, JSON invalido, `sessionId` ausente ou fora do formato |
| 413 | Mensagem acima de 2000 caracteres |
| 429 | Rate limit local (10/min por IP) ou limite do tier gratuito do provedor |
| 500 | Falta `LLM_API_KEY` ou `LLM_INSTRUCTIONS` |
| 502 | Provedor falhou, recusou o modelo, recusou a chave, ou respondeu sem texto |
| 504 | Provedor passou de 90s |

`fontes` vazio numa pergunta sobre processo e o sinal de que as migracoes de documentos
nao foram aplicadas - o agente responde, mas sem a base.

## Estrutura no frontend

| Arquivo | Papel |
|---|---|
| `src/hooks/useChat.ts` | Estado, sessionId, persistencia e chamada da function |
| `src/components/ChatMarkdown.tsx` | Renderiza a resposta como markdown |
| `src/pages/Index.tsx` | A tela, incluindo o bloco de fontes |

"Nova conversa" gera um `sessionId` novo em vez de apagar: o historico antigo permanece
na tabela e o agente deixa de receber o contexto abandonado.

## Seguranca - o que falta

**A function esta publica.** `verify_jwt = false`, e a anon key que o frontend envia e
publica por design. Qualquer pessoa com a URL pode chamar.

Com modelo gratuito isso deixou de ser risco financeiro. Mas **agora ha risco de dados**:
a function le os documentos internos de processo do cliente e os devolve em texto. Quem
descobrir a URL consegue extrair a base conversando.

O rate limit de 10 req/min por IP e quebra-molas: e em memoria, e edge functions sao
efemeras e escalam, entao cada instancia conta separado.

Antes de expor pra valer:

1. Autenticacao (Supabase Auth) com `verify_jwt = true`
2. Policies de RLS reais, se nem todo usuario puder ver todos os documentos

**Politica de dados do provedor.** O OpenRouter tem ajustes de privacidade separados
para modelos pagos e gratuitos, incluindo restringir o roteamento a provedores que
possam treinar com os dados enviados. Como agora o conteudo dos POPs vai no prompt, isso
deixou de ser precaucao e virou pre-requisito: **Settings -> Privacy** no OpenRouter.

**Os documentos estao versionados no git** (na migracao de carga). E a unica forma de
carrega-los sem alguem manipular a service_role key do projeto. O repositorio e privado -
se isso mudar, a migracao precisa sair do git e a carga passa a ser por script com
credencial local.
