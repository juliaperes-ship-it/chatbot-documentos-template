# Template: chatbot de documentos internos

Código base para chatbots que respondem perguntas sobre um acervo fechado de
documentos internos — POPs, manuais, procedimentos — citando sempre de qual documento
a resposta veio, e sem inventar conteúdo.

Este repositório **não é de nenhum cliente**. Não há acervo, marca nem projeto
vinculado. É o ponto de partida para um projeto novo.

Para entender *por que* cada peça é como é, leia
[docs/manual-como-construir-um-chatbot.md](docs/manual-como-construir-um-chatbot.md) —
ele explica a arquitetura desde o zero e traz uma seção de armadilhas que custaram
dias em projetos reais.

---

## O que vem pronto

| Camada | O que já está resolvido |
|---|---|
| Tela de conversa | streaming, markdown com tabelas, auto-scroll, tetos de tempo |
| Autenticação | login por e-mail e senha, validada também no backend |
| Backend | edge function com busca, catálogo, histórico e rate limit |
| Busca | full-text em português, 4 etapas, tolerante a acento e a plural de `-ção` |
| Modelo | Anthropic, OpenAI ou OpenRouter — trocável por variável de ambiente |
| Extração | `.docx` → Markdown, preservando tabelas, numeração e links |
| Testes | 15+ verificações de schema e busca, sem precisar de banco instalado |

## O que você precisa decidir e preencher

Em ordem. Cada item tem uma seção abaixo.

- [ ] Criar o projeto Supabase e preencher o `.env`
- [ ] Extrair e carregar os documentos do cliente
- [ ] Escrever a instrução do agente
- [ ] Cadastrar a chave do modelo
- [ ] Personalizar marca e textos
- [ ] Preencher os casos de teste
- [ ] Publicar o frontend

---

## 1. Projeto Supabase

```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF
npx supabase db push
npx supabase functions deploy chat-agent
```

Depois, copie o `.env.example` para `.env` e preencha com a URL e a chave
*publishable* do projeto (Project Settings → API Keys).

Ao criar o projeto no painel, duas opções valem atenção:

- **Automatically expose new tables** — desligue. O painel da Supabase recomenda o
  mesmo. Este frontend nunca lê tabela direto; só faz login.
- **Enable automatic RLS** — ligue. É rede de segurança para tabela criada depois.

## 2. Documentos

```bash
# organize por área — a subpasta define o grupo:
#   documentos-fonte/comercial/001. POP Atendimento.docx
#   documentos-fonte/logistica/002. POP Conferencia.docx

python3 scripts/extrair-documentos.py     # .docx -> Markdown
python3 scripts/gerar-seed.py             # Markdown -> migração SQL

npm install --no-save @electric-sql/pglite
node scripts/testa-migracoes.mjs          # valida ANTES de produção
npx supabase db push
```

**Abra um arquivo gerado antes de seguir.** Template de documento varia, e o extrator
detecta seção por **negrito**. Se o template do cliente usar estilo de parágrafo
("Título 1"), o extrator devolve um bloco único de texto corrido — o próprio script
explica no cabeçalho o que trocar.

> Os documentos do cliente **não entram neste repositório**. O `.gitignore` já barra
> `documentos-fonte/`, `documentos-extraidos/` e o seed gerado. No repositório do
> cliente, que deve ser **privado**, o seed é versionado normalmente.

## 3. Instrução do agente

Edite [docs/instrucao-do-agente.md](docs/instrucao-do-agente.md) — o cabeçalho lista
os cinco pontos a adaptar — e envie:

```bash
node scripts/definir-instrucao.mjs
```

O script recusa valor com menos de 1000 caracteres e imprime tamanho e as duas pontas
do que enviou. Isso existe porque secret **não pode ser lido de volta**: uma
instrução truncada não gera erro, só comportamento ruim, e tarde.

## 4. Chave do modelo

```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
npx supabase secrets set LLM_PROVIDER=anthropic LLM_MODEL=claude-haiku-4-5
```

Prefira um modelo **sem raciocínio** para esta tarefa: reformatar em tabela um
documento que já veio inteiro no contexto não é raciocínio difícil, e raciocínio só
soma espera. Ver a seção de modelo no manual.

## 5. Marca e textos

| Onde | O quê |
|---|---|
| `src/config.ts` | nome, subtítulo, textos da tela, sugestões |
| `index.html` | título da aba e metadados |
| `src/index.css` | paleta — **meça o contraste**, o arquivo explica como |
| `public/favicon.png` | ícone |

Sobre o logo: PNG com fundo transparente, e `w-auto` na classe. Um bom atalho para o
favicon é recortar só o símbolo, sem o texto.

**Meça o contraste antes de aceitar a cor da marca.** Cor viva costuma reprovar com
texto branco, e o caso que mais escapa é a cor virando *letra* de 14px — a variante
`link` do shadcn/ui usa `text-primary`. O `src/index.css` traz o código de medição.

## 6. Casos de teste

Preencha `CASOS` em `scripts/testa-migracoes.mjs` com perguntas reais do acervo. No
mínimo: título exato, com e sem acento, uma pergunta natural completa, dois
documentos de nome parecido, e cada sugestão da tela com o texto exato que o clique
envia.

Rode **antes de todo** `supabase db push`.

## 7. Publicar

Importe o repositório na Vercel. O `vercel.json` já faz o fallback de SPA.

Cadastre `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` nas variáveis do
projeto — aqui o `.env` não é versionado.

Depois, no Supabase, em Authentication → URL Configuration: **primeiro** adicione a
URL publicada aos Redirect URLs, **depois** aponte a Site URL para ela. Na ordem
inversa há uma janela em que os links de confirmação vão para um endereço não
autorizado, e todo cadastro feito nesse intervalo quebra.

> **Antes do primeiro push, confira o e-mail do git.** A Vercel bloqueia deployment
> cujo autor tenha e-mail inválido, e máquina sem `user.email` configurado inventa um
> a partir do hostname. O GitHub aceita; a Vercel não.
>
> ```bash
> git config user.email "ID+usuario@users.noreply.github.com"
> ```
>
> O `ID` numérico está em `https://api.github.com/users/SEU_USUARIO`.

---

## O que exige deploy e o que não exige

Três das cinco coisas que você vai querer mudar não exigem.

| Mudar | Como | Deploy? |
|---|---|---|
| Comportamento do agente | editar a instrução e rodar o script | não |
| Modelo ou provedor | `supabase secrets set` | não |
| Os documentos | reextrair, regerar e `db push` | não |
| Código da função | `supabase functions deploy chat-agent` | sim |
| Frontend | push na branch principal | automático |

## Estrutura

```
src/config.ts               ponto unico de personalizacao da interface
src/                        frontend (Vite + React + Tailwind + shadcn/ui)
supabase/functions/         a edge function que conversa com o modelo
supabase/migrations/        schema do banco e a funcao de busca
scripts/extrair-documentos.py   .docx -> Markdown
scripts/gerar-seed.py           Markdown -> migracao SQL
scripts/testa-migracoes.mjs     valida schema e busca sem instalar banco
scripts/definir-instrucao.mjs   envia a instrucao para o secret
docs/                       o manual da arquitetura e a instrucao do agente
```

## Rodar localmente

```bash
cp .env.example .env    # e preencher
npm install
npm run dev
```
