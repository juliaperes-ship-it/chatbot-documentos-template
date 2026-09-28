# Manual: como construir um chatbot de documentos, do zero

Este manual ensina a construir um chatbot que responde perguntas sobre um conjunto de
documentos internos — POPs, manuais, procedimentos — citando sempre de qual
documento a resposta veio, e sem inventar conteúdo.

**Ele assume que você nunca fez isso.** Cada conceito é explicado antes de ser usado, e
há um [glossário no fim](#glossário). Se algum termo aparecer sem explicação, é erro
meu — procure no glossário.

Tudo aqui foi medido num sistema real, em produção. As armadilhas descritas
aconteceram de verdade e custaram dias.

---

## Sumário

- [Parte 0 — O que você vai construir](#parte-0--o-que-você-vai-construir)
- [Parte 1 — Os conceitos que você precisa antes de começar](#parte-1--os-conceitos-que-você-precisa-antes-de-começar)
- [Parte 2 — As peças do sistema](#parte-2--as-peças-do-sistema)
- [Parte 3 — Contas que você precisa criar](#parte-3--contas-que-você-precisa-criar)
- [Etapa 1 — Transformar os documentos em texto](#etapa-1--transformar-os-documentos-em-texto)
- [Etapa 2 — Guardar os documentos num banco de dados](#etapa-2--guardar-os-documentos-num-banco-de-dados)
- [Etapa 3 — Ensinar o sistema a encontrar o documento certo](#etapa-3--ensinar-o-sistema-a-encontrar-o-documento-certo)
- [Etapa 4 — O cérebro: a função que conversa com a IA](#etapa-4--o-cérebro-a-função-que-conversa-com-a-ia)
- [Etapa 5 — A instrução do agente](#etapa-5--a-instrução-do-agente)
- [Etapa 6 — A tela de conversa](#etapa-6--a-tela-de-conversa)
- [Etapa 7 — Login, para o acervo não ficar público](#etapa-7--login-para-o-acervo-não-ficar-público)
- [Etapa 8 — Escolher a IA e entender o custo](#etapa-8--escolher-a-ia-e-entender-o-custo)
- [Etapa 9 — Colocar no ar](#etapa-9--colocar-no-ar)
- [Armadilhas que custaram dias](#armadilhas-que-custaram-dias)
- [Checklist antes de entregar](#checklist-antes-de-entregar)
- [Glossário](#glossário)

---

## Parte 0 — O que você vai construir

Imagine um funcionário novo que leu todos os procedimentos da empresa e está sempre
disponível para responder perguntas sobre eles. É isso.

A pessoa digita *"quais os passos da conferência de estoque?"* e recebe de volta o
processo organizado em tabela, com a numeração original do documento, e uma linha
dizendo de qual POP aquilo saiu.

**O que ele faz:**

- Responde sobre os documentos que você carregou
- Cita a fonte de cada resposta
- Diz "não encontrei" quando a pergunta está fora do acervo

**O que ele não faz, de propósito:**

- Não responde sobre assuntos gerais (não é o ChatGPT)
- Não inventa procedimento que não está nos documentos
- Não lê imagens — se o POP tem prints de tela, ele avisa que não os leu

Esse último ponto parece uma limitação, e é. Mas dizer a verdade sobre o que o sistema
não sabe vale mais do que fingir completude. Num processo contábil, um passo inventado
tem consequência real.

---

## Parte 1 — Os conceitos que você precisa antes de começar

Leia esta parte inteira antes de seguir. Ela tem oito ideias, e todo o resto do manual
se apoia nelas.

### 1. O que é um modelo de IA (LLM)

Um **LLM** (*Large Language Model*, ou modelo de linguagem) é um programa que recebe
texto e devolve texto. Ele não tem acesso à internet, não tem memória entre conversas,
e não sabe nada sobre a sua empresa.

Isso é importantíssimo e contra-intuitivo: **o modelo não "aprende" os seus
documentos**. Toda vez que alguém faz uma pergunta, você precisa *mandar junto* o
documento relevante, no mesmo texto da pergunta. O modelo lê aquilo na hora, responde,
e esquece tudo.

### 2. O que é um token

O modelo não lê letras nem palavras: lê **tokens**, pedaços de palavra. Em português,
um token equivale a mais ou menos **3 caracteres**. A palavra "fechamento" pode virar
dois ou três tokens.

Isso importa por dois motivos:

- **Você paga por token**, tanto o que manda quanto o que recebe
- Existe um **limite** de quantos tokens cabem numa conversa

### 3. O que é contexto

**Contexto** é tudo que você manda para o modelo numa única chamada: suas instruções,
o documento, o histórico da conversa e a pergunta. Cada modelo tem um teto — o que
usamos aceita 200 mil tokens, o equivalente a umas 150 mil palavras.

Pense no contexto como a mesa de trabalho do modelo. Tudo que estiver em cima da mesa
ele enxerga. O que não estiver, não existe para ele.

### 4. O que é um prompt de sistema (ou "instrução")

É um texto que você manda antes da pergunta do usuário, explicando ao modelo quem ele
é e como deve se comportar. Algo como:

> *"Você é o assistente de procedimentos internos desta empresa. Responda sempre em
> tabela. Nunca invente um passo. Se a pergunta for fora desse assunto, diga que está
> fora do seu escopo."*

O usuário nunca vê esse texto. Ele é a diferença entre um chatbot que funciona e um
que inventa coisas.

### 5. O que é uma API e uma chave de API

**API** é a forma de um programa conversar com outro. Em vez de você abrir o site da
IA e digitar, o seu sistema manda a pergunta por trás dos panos e recebe a resposta.

A **chave de API** é uma senha longa que identifica quem está chamando e para quem vai
a conta. Duas regras absolutas:

- **A chave nunca pode ir para o navegador do usuário.** Qualquer pessoa consegue ver
  o que o navegador recebeu, e usaria sua chave por conta própria.
- **A chave nunca vai para o Git.** Ela vive numa configuração à parte, chamada
  *secret*.

### 6. Frontend, backend e por que existem dois

| | Frontend | Backend |
|---|---|---|
| Onde roda | no navegador do usuário | num servidor |
| Quem consegue ver o código | qualquer um | ninguém |
| Guarda a chave de API? | **nunca** | sim |

O usuário digita no frontend. O frontend manda a pergunta para o backend. O backend —
que é a única parte segura — busca o documento, chama a IA com a chave secreta, e
devolve a resposta.

### 7. O que é streaming

Sem streaming, o sistema fica calado até a resposta inteira ficar pronta, e só então
mostra tudo de uma vez. Com **streaming**, o texto aparece aos poucos, como você vê no
ChatGPT.

Não é enfeite: uma resposta longa leva mais de um minuto para terminar. Sem streaming,
o usuário encara uma tela parada e conclui que quebrou.

### 8. O que é deploy

**Deploy** é publicar uma versão nova do código para valer. Enquanto você não faz
deploy, suas alterações existem só no seu computador.

Guarde esta frase, porque ela é a armadilha nº 1 deste manual: **o frontend e o
backend têm deploys separados.** Publicar um não publica o outro.

---

## Parte 2 — As peças do sistema

```
   A pessoa digita a pergunta
              │
              ▼
   ┌───────────────────────┐
   │  FRONTEND             │   a tela de conversa, no navegador
   └───────────┬───────────┘
               │  manda: a pergunta + quem é o usuário
               ▼
   ┌───────────────────────┐
   │  BACKEND              │   1. confere se a pessoa está logada
   │  (uma função no       │   2. procura o documento certo
   │   servidor)           │   3. monta o texto para a IA
   │                       │   4. chama a IA
   └─────┬────────────┬────┘   5. devolve aos pedaços
         │            │
         ▼            ▼
   ┌──────────┐  ┌──────────┐
   │  BANCO   │  │    IA    │
   │  DE      │  │ (modelo) │
   │  DADOS   │  └──────────┘
   └──────────┘
   documentos +
   histórico
```

Cada peça e por que ela existe:

| Peça | O que faz | Por que não dá para tirar |
|---|---|---|
| Frontend | a tela de conversa | é o que a pessoa usa |
| Backend | busca, monta o prompt, chama a IA | é o único lugar seguro para a chave |
| Banco de dados | guarda documentos e histórico | o modelo não tem memória |
| Modelo (IA) | escreve a resposta | é o que gera o texto |

---

## Parte 3 — Contas que você precisa criar

| Serviço | Para que serve | Custo |
|---|---|---|
| **Supabase** | banco de dados + backend + login | plano grátis serve |
| **Anthropic** (ou outro provedor de IA) | o modelo que escreve as respostas | pague pelo uso, ~US$ 0,03 por pergunta |
| **GitHub** | guardar o código e disparar publicações | grátis |
| **Vercel** | hospedar a tela de conversa | plano grátis serve |

No seu computador: **Node.js** versão 18 ou mais nova, e **Python 3** se os documentos
forem `.docx`.

> **Sobre dinheiro:** não tente economizar usando modelo gratuito. A seção
> [Etapa 8](#etapa-8--escolher-a-ia-e-entender-o-custo) mostra, com números medidos,
> por que isso custa mais caro em tempo do que economiza em dinheiro.

---

## Etapa 1 — Transformar os documentos em texto

O modelo só lê texto simples. Um arquivo `.docx` é, por dentro, um pacote compactado
cheio de marcação — não dá para mandar direto.

**Objetivo desta etapa:** um arquivo de texto limpo (formato Markdown) para cada
documento.

### O que é Markdown

É uma forma de escrever texto com formatação usando só sinais de pontuação. `## Título`
vira um título, `| a | b |` vira uma tabela. É o formato que os modelos entendem
melhor.

### Como extrair

Um `.docx` é um arquivo `.zip` com XML dentro. Dá para abrir com a biblioteca padrão do
Python, sem instalar nada:

```python
import zipfile, xml.etree.ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

with zipfile.ZipFile("001. POP Conferencia de Estoque.docx") as zf:
    raiz = ET.fromstring(zf.read("word/document.xml"))
```

### Os cinco cuidados que fazem diferença

**1. Tabela tem que virar tabela.** Num POP, a tabela de passos *é* o conteúdo. Se
você achatar para texto corrido, perde quem faz o quê, e o chatbot passa a dar resposta
confusa.

**2. Preserve a numeração original**, inclusive subpassos como `1.1` e `1.2`. A pessoa
vai conferir a resposta contra o documento impresso. Numeração diferente destrói a
confiança.

**3. Jogue fora o sumário.** O índice automático do Word vira lixo no texto extraído —
uma lista de títulos com números de página soltos, que confunde a busca.

**4. Guarde os links.** No `.docx` eles ficam separados do texto, num arquivo à parte
(`document.xml.rels`). Se você ignorar, o texto do link fica e o endereço some.

**5. Conte as imagens.** Prints de tela não viram texto. Conte quantos há por documento
e guarde esse número — na resposta, o chatbot vai avisar: *"contém 13 capturas de tela
que o agente não lê"*.

> **Cuidado com acentos nos nomes dos arquivos.** O comando `unzip` estraga nomes
> vindos do Windows — "Normalizações.docx" vira algo ilegível. Use a biblioteca
> `zipfile` do Python.

> **Como o Word grava os estilos.** Ele salva o nome do estilo sem acento (`Ttulo1`, e
> não `Título1`), e em inglês quando o arquivo veio de outra instalação (`Heading 1`).
> Se você procurar só por "Título", não vai achar nenhum.

---

## Etapa 2 — Guardar os documentos num banco de dados

### Por que banco de dados, e não os arquivos soltos

Porque você precisa **procurar**. Com 37 documentos, achar o certo em milissegundos é o
que faz o chatbot parecer rápido.

### A tabela

Uma tabela é como uma planilha: colunas e linhas. Esta tem uma linha por documento.

```sql
create table public.documentos (
  slug text primary key,   -- identificador único, tipo "logistica-conferencia"
  titulo text not null,    -- "Conferência de Estoque"
  grupo text not null,     -- a área: "logistica", "comercial", "fiscal"...
  conteudo text not null,  -- o documento inteiro em Markdown
  imagens integer,         -- quantos prints ele tem
  palavras integer,
  busca tsvector           -- explicado na Etapa 3
);
```

### Proteger o acervo

São documentos internos do cliente. Duas linhas garantem que só o backend leia:

```sql
grant all on public.documentos to service_role;
alter table public.documentos enable row level security;
```

Em português: ligue a trava (`row level security`) sem criar nenhuma exceção, e dê a
chave mestra só para o backend (`service_role`).

**Por que isso importa:** o frontend carrega uma chave pública do banco, que vai junto
no código que o navegador recebe. Sem essa trava, qualquer visitante da página poderia
baixar o acervo inteiro.

> **Pegadinha:** ter a chave mestra não dispensa ter permissão na tabela. Sem o
> `grant`, o backend leva "permission denied" mesmo usando a chave certa.

### Carregar os documentos

Gere um arquivo SQL com um `insert` por documento, usando
`on conflict (slug) do update`. Isso faz o arquivo poder ser rodado várias vezes sem
duplicar nada.

Se o painel do seu provedor não aceitar colar um arquivo grande — o nosso tinha 350 KB
e travava — **divida em partes de no máximo 45 KB**, numeradas (`01-de-09.sql` até
`09-de-09.sql`). Rode em ordem e confira no fim:

```sql
select count(*) from documentos;
```

---

## Etapa 3 — Ensinar o sistema a encontrar o documento certo

Esta é a etapa que mais dá errado, e a que mais definimos por tentativa e erro. Leia
com calma.

### O problema

A pessoa pergunta *"como faço as normalizações?"*. Você precisa descobrir que o
documento certo se chama "Devolução de Produto" — e não devolver o "Atendimento", que
por acaso menciona a palavra "normalização" no meio.

### Busca por palavra, não por significado

Existem duas famílias de solução:

| | Busca por palavra (escolhemos esta) | Busca por significado (*embeddings*) |
|---|---|---|
| Como funciona | compara as palavras da pergunta com as do documento | transforma texto em números e compara |
| Infraestrutura | nenhuma extra | precisa de indexação, e reindexar a cada mudança |
| Custo por pergunta | zero | uma chamada paga a cada pergunta |
| Dá para depurar? | sim, você lê o resultado | não, são vetores de números |

**Escolha a busca por palavra se** o acervo tem dezenas de documentos com títulos
claros ("Devolução", "Conferência de Estoque"). Busca por significado resolve o
problema de achar um trecho entre milhares de fragmentos com títulos vagos — que não é
o seu caso.

Migrar depois é adicionar uma coluna, não reescrever. Começar complexo cobra
manutenção desde o primeiro dia.

### Fazer a busca entender português

Sem isso, a busca falha no caso mais comum. Os títulos vêm dos nomes de arquivo,
geralmente sem acento ("Inventario"), mas quem pergunta escreve certo ("inventário").
Para o banco, são palavras diferentes.

```sql
create extension if not exists unaccent;   -- ignora acentos
create extension if not exists pg_trgm;    -- compara palavras parecidas

create text search configuration public.portugues_sem_acento (copy = portuguese);
alter text search configuration public.portugues_sem_acento
  alter mapping for hword, hword_part, word with unaccent, portuguese_stem;
```

O `portuguese_stem` corta as variações: "fechamentos", "fechamento" e "fechar" viram a
mesma raiz.

### Título vale mais que conteúdo

```sql
new.busca :=
  setweight(to_tsvector('public.portugues_sem_acento', new.titulo),   'A') ||
  setweight(to_tsvector('public.portugues_sem_acento', new.conteudo), 'B');
```

O peso `A` é mais forte que o `B`. Assim, uma pergunta sobre "inventário" traz primeiro
o documento **chamado** Inventário, e não um que menciona a palavra de passagem.

### A busca em quatro tentativas

Cada tentativa nasceu de um erro real. Elas rodam em ordem, e a seguinte só roda se a
anterior não achou nada.

**Tentativa 1 — o título responde a pergunta.**
Procura as palavras da pergunta só no título.
*Por quê:* palavras genéricas como "processo" e "passos" aparecem em quase todo
documento. Medimos: uma pergunta da forma *"como funciona o processo de X?"* devolvia
documento errado em primeiro lugar, porque ele é longo e repete "processo" várias
vezes.

**Tentativa 2 — o título é parecido, mas escrito diferente.**
Compara letra por letra, aceitando semelhança de 25% para cima.
*Por quê:* o processador de texto do Postgres erra o plural de `-ção`/`-ções`.
Medido no próprio banco: "devolução" vira `devoluca` e "devoluções" vira `devoluco` —
nunca casam. O contraste mostra que é específico desse sufixo: "conferência" e
"conferências" viram as duas `conferenc` e casam sem problema.

Em português de processo, nome terminado em `-ção` é a regra e não a exceção:
devolução, cotação, provisão, movimentação, reclassificação. Por isso esta etapa
costuma salvar metade do acervo.

> **O número 0,25 é calibrado, não chutado.** Os casos que precisávamos pegar ficam
> entre 0,273 e 0,786. Dez perguntas fora do assunto — de "previsão do tempo" a "quem
> ganhou a copa" — não passaram de 0,222. **Meça antes de escolher um limiar.**

**Tentativa 3 — o conteúdo tem todos os termos.**
Procura no texto do documento, exigindo **todas** as palavras.
*Por quê:* exigindo só uma delas, *"qual a capital da Mongólia"* casava com 4
documentos por causa da palavra "capital" — e com pontuação parecida com a de um acerto
real. Não havia limiar que separasse. Exigindo todas, pergunta fora do domínio devolve
vazio.

**Tentativa 4 — a pergunta é o nome do documento, escrito de outro jeito.**
Última rede de segurança.

Se nenhuma acha nada, o chatbot diz que não encontrou. Esse é o comportamento **certo**.

### Um bug silencioso que vale conhecer

As palavras que saem do processamento **já estão cortadas na raiz**. Processá-las de
novo corta demais: `inventari` vira `inventar`, que não casa com nada.

```sql
tsq := array_to_string(lexemas, ' | ')::tsquery;    -- certo
tsq := to_tsquery(array_to_string(lexemas, ' | ')); -- ERRADO: corta duas vezes
```

O que torna isso perigoso: **a busca continua devolvendo resultados**. Ela acerta por
acidente, achando variações no corpo do texto. Só medindo a pontuação por título dá
para perceber.

### Como testar sem instalar um banco

Use **PGlite** (`@electric-sql/pglite`): é o Postgres inteiro compilado para rodar
dentro do Node, sem instalar nada e sem Docker. Sobe em segundos e permite testar a
busca de verdade antes de tocar em produção.

---

## Etapa 4 — O cérebro: a função que conversa com a IA

Uma função que roda no servidor e faz seis coisas, nesta ordem:

1. **Confere o limite de uso.** 10 perguntas por minuto por pessoa já barra abuso.
2. **Confere quem é o usuário.** Valida o crachá digital (*token*) que o frontend
   mandou.
3. **Busca os documentos** e **carrega o histórico da conversa**.
4. **Monta o texto** que vai para a IA: instrução + lista de documentos + documento
   encontrado + histórico + pergunta.
5. **Chama a IA** pedindo resposta aos pedaços.
6. **Devolve os pedaços** ao navegador e **grava a conversa** no banco.

### Faça ao mesmo tempo o que não depende um do outro

Conferir o usuário leva um tempo de ida e volta à rede. Buscar o documento não depende
disso. Faça os dois em paralelo — economiza quase meio segundo em toda pergunta:

```ts
const usuarioPromise = conferirUsuario(req);
const docsPromise = buscarDocumentos(pergunta);
const usuario = await usuarioPromise;
```

### Mande o primeiro pedaço antes de chamar a IA

Assim que a busca termina — o que é quase instantâneo — mande para a tela **qual
documento** foi encontrado. A pessoa passa a ver "consultando: Conferência de Estoque" enquanto
a IA ainda escreve, em vez de encarar uma bolinha girando.

É a melhoria de percepção de velocidade mais barata que existe: não acelera nada, e
muda completamente a sensação de uso.

O formato que trafega é uma linha JSON por evento:

```
{"type":"meta","fontes":[{"titulo":"Conferência de Estoque","imagens":1}]}
{"type":"delta","text":"## Conferência de Estoque"}
{"type":"delta","text":"\n\nPadroniza a execução..."}
{"type":"done"}
```

### Mande a lista de todos os documentos junto

Inclua no texto enviado à IA a lista com o nome de todos os documentos do acervo.

**Por quê:** sem ela, quando alguém pergunta *"quais processos existem?"*, o modelo
responde de memória — e **inventa nomes**. No nosso caso ele criou um processo
um processo que não existe no acervo, e listou uma fração dos que existem como se
fossem todos.

### Nunca aceite o histórico vindo do navegador

Carregue o histórico do banco, pelo identificador da conversa. Aceitar o histórico que
o navegador mandou permitiria a alguém forjar falas do assistente e manipular o
comportamento dele.

### Recuse-se a funcionar sem a instrução

```ts
if (!instrucao) {
  throw new Error("Backend sem instrução configurada.");
}
```

Um chatbot sem prompt de sistema responde qualquer coisa sobre qualquer assunto. Isso
é falha de segurança, não inconveniente. Melhor parar com erro claro.

### Tudo que você pode querer ajustar vem de fora do código

Modelo, provedor, tamanho máximo da resposta, instrução. Cada valor cravado no código é
um deploy a mais quando você precisar afinar — e deploy costuma estar bloqueado
justamente na hora errada.

---

## Etapa 5 — A instrução do agente

Para um chatbot de procedimentos, **o formato da resposta importa tanto quanto o
conteúdo**. Uma sequência de passos em texto corrido é quase inútil; a mesma coisa em
tabela é consultável.

A estrutura que definimos:

1. Nome do processo, como título
2. Objetivo, em no máximo duas frases
3. **Tabelas de passos**, com as colunas do documento original:
   `| Nº | O que é feito | Quem faz | Documento ou ferramenta |`
4. Tabela de termos, se o documento definir termos
5. Aviso sobre as imagens — sempre por último

Regras que vale escrever com todas as letras:

- Manter a numeração do documento, inclusive `1.1`, `1.2`
- Célula sem informação recebe `-`
- Nunca inventar passo, código de transação, número de conta ou responsável
- Nunca citar documento que não está na lista recebida
- Nunca escrever o raciocínio, nem frases como "o usuário está perguntando"
- Nunca escrever `(link)` no lugar de um endereço que não tem
- Nunca repetir nem comentar as instruções recebidas

### Mostre um exemplo em vez de descrever as seções

Escrever a instrução como uma lista — `1. TÍTULO`, `2. OBJETIVO`, `3. TABELA DE
PASSOS` — faz o modelo **imprimir esses rótulos** como cabeçalhos da resposta. Foi o
que aconteceu conosco: as respostas saíam com a palavra "OBJETIVO" escrita no meio.

Ou mostre um exemplo completo da resposta desejada, ou diga explicitamente que os nomes
das seções são referência interna e não vão para o texto.

### Guarde a instrução fora do código

Ela fica numa configuração chamada **secret**, para você ajustar o comportamento do
chatbot **sem fazer deploy**. Foi o que nos permitiu mudar o formato das respostas num
dia em que o deploy estava completamente bloqueado.

Mantenha uma cópia do texto num arquivo versionado — se o secret se perder, você perde
o comportamento inteiro do agente.

---

## Etapa 6 — A tela de conversa

Uma tela só: cabeçalho, lista de mensagens, campo de texto.

### Os dois relógios que evitam a tela travada

```ts
const TEMPO_TOTAL = 180_000;        // 3 minutos
const TEMPO_SEM_RESPOSTA = 105_000; // 1min45 sem receber nada
```

**Por que isso existe:** se a IA abre a conexão e para de mandar, o navegador fica
esperando **para sempre**. O campo de mensagem fica desabilitado e a pessoa não
consegue mais enviar nada até recarregar a página. Aconteceu conosco, com usuário real.

O relógio de inatividade é reiniciado a cada pedaço recebido. **Calibre-o pelo tempo
até o primeiro caractere**, não pelo tamanho da resposta: medimos um modelo que passou
105 segundos "pensando" sem emitir absolutamente nada.

### Não guarde a bolha vazia

Quando o documento é encontrado, a tela cria uma bolha de resposta ainda vazia — e é
ela que desenha o "Consultando o documento...".

Se essa bolha vazia for salva na memória do navegador, ao recarregar a página ela
reaparece e o "Consultando..." **fica para sempre**, porque não há mais nenhuma
resposta a caminho. Descarte bolhas vazias ao salvar e ao carregar.

### Mostrar tabelas

Use `react-markdown` com `remark-gfm` — o segundo é o que habilita tabelas.
**Não habilite HTML bruto**: o conteúdo vem de um modelo, e permitir HTML abre porta
para injeção de código na sua página.

---

## Etapa 7 — Login, para o acervo não ficar público

Documentos internos de cliente não podem ficar abertos. Com o Supabase Auth você tem
login por e-mail e senha praticamente pronto.

Três cuidados:

**1. Proteger a tela não é proteger o sistema.** Esconder a página no frontend é
conveniência. O endereço do backend continua público e precisa validar o crachá por
conta própria — senão qualquer um chama direto.

**2. Separe o histórico por pessoa.** Sem isso, uma pessoa lê a conversa da outra.

**3. Configure os endereços de retorno.** O campo **Site URL** define para onde apontam
os links de confirmação de e-mail.

> **Ordem importa:** primeiro autorize o novo endereço na lista de permitidos, **só
> depois** aponte a Site URL para ele. Na ordem contrária existe uma janela em que os
> links vão para um endereço ainda não autorizado — e todo cadastro feito nesse
> intervalo quebra.

---

## Etapa 8 — Escolher a IA e entender o custo

### Por que não usar modelo gratuito

Tentamos por dois dias. O resultado medido:

| Problema | Com que frequência |
|---|---|
| Resposta em branco | recorrente |
| O "pensamento" do modelo vazando no meio da resposta | recorrente |
| Resposta virar texto sem sentido, com caracteres de outros alfabetos | 3 em cada 12 |
| Espera de 70 a 105 segundos até a primeira letra | sempre |

E existe um teto: **50 perguntas por dia**, contadas na conta inteira e não por modelo.
Trocar de modelo gratuito não contorna.

Some tudo: dois dias de trabalho perdidos para economizar alguns dólares.

### Modelo que "pensa" não serve para esta tarefa

Alguns modelos raciocinam antes de responder. Isso ajuda em problemas difíceis — e
**atrapalha aqui**, porque reformatar em tabela um documento que já está inteiro no
contexto não é difícil. O raciocínio só acrescenta espera.

Prefira um modelo rápido e barato, com raciocínio desligado. Usamos o **Claude Haiku
4.5**: não pensa por padrão, aceita 200 mil tokens de contexto, custa US$ 1 por milhão
de tokens de entrada e US$ 5 por milhão de saída.

### Quanto custa de verdade

Medido com contexto de 42 mil caracteres e resposta completa em tabela:

| | Tokens | Custo |
|---|---|---|
| Entrada (instrução + lista + documento + histórico) | ~13 500 | US$ 0,013 |
| Saída (a resposta) | ~3 400 | US$ 0,017 |
| **Total por pergunta** | | **~US$ 0,03** |

Cerca de **30 perguntas por dólar**. Perguntas simples custam bem menos, porque você
paga pelo texto realmente gerado, não pelo limite configurado.

### Prefira a API oficial

Vários provedores oferecem um endereço "compatível com OpenAI", que facilita a
migração. A Anthropic é explícita: aquela camada serve para **testar e comparar**
modelos e **não é considerada pronta para produção**.

Usar a interface nativa custa três ajustes — as instruções vão num campo separado, a
autenticação usa um cabeçalho diferente, e os pedaços da resposta chegam num formato
próprio — e evita depender de algo que o próprio fornecedor não recomenda.

> **Ao ler a resposta aos pedaços, aproveite só o texto.** Modelos que pensam mandam o
> raciocínio em eventos separados. Se você juntar tudo, o "pensamento" aparece na tela
> do usuário. Foi exatamente esse o bug que vimos.

---

## Etapa 9 — Colocar no ar

| Parte | Onde | O que dispara |
|---|---|---|
| Frontend | Vercel | enviar código para o GitHub |
| Backend | provedor do backend | **comando explícito seu** |
| Banco | provedor do backend | rodar o SQL no painel |

**Leia de novo a linha do meio.** Enviar código para o GitHub publica o frontend
automaticamente, mas **não** publica o backend. Essa confusão custou um dia inteiro.

### Fazer links diretos funcionarem

Sem esta configuração, abrir `seusite.com/login` direto, ou apertar F5, dá erro 404:

```json
{
  "rewrites": [
    { "source": "/((?!assets/).*)", "destination": "/index.html" }
  ]
}
```

A exclusão de `assets/` é importante: sem ela, um arquivo faltando no build devolve a
página inicial com status "tudo certo", e o problema aparece como uma tela branca
inexplicável em vez de um erro honesto.

### Dê o mínimo de acesso possível

Ao conectar a hospedagem ao GitHub, escolha **"Only select repositories"** e marque só
o repositório do projeto. O padrão é dar acesso a todos — inclusive aos que você criar
no futuro.

---

## Armadilhas que custaram dias

Em ordem de quanto tempo consumiram.

### 1. Publicar o frontend não publica o backend

O site fica atualizadíssimo enquanto a função do backend é de dez versões atrás — e
tudo *parece* publicado. Passamos um dia depurando o comportamento de uma versão que
não estava rodando.

**Como descobrir qual versão está no ar, de forma barata:** mude de propósito uma
**mensagem de erro** na versão nova e provoque aquele erro. O texto que voltar diz com
certeza qual código está rodando. Foi assim que descobrimos: configuramos uma opção
nova e recebemos de volta a mensagem de erro antiga, que nem conhecia aquela opção.

### 2. Campos mascarados podem comer o seu texto

O campo onde se cola a instrução era do tipo "senha". A especificação do HTML manda
esse tipo de campo **descartar quebras de linha**. Medimos: um texto de 4113
caracteres e 110 linhas entrou como **4112 caracteres e zero linhas**.

A instrução chegava ao modelo como uma linha só — e uma versão que dependia de um
exemplo de tabela teria ensinado o formato errado.

**Sempre confira o que foi gravado, não o que você digitou.** Com o console do
navegador aberto na página:

```js
const campo = document.querySelector('input[type=password]');
campo.value.length;                      // tamanho real
(campo.value.match(/\n/g) || []).length; // quebras de linha que sobreviveram
```

E atenção: os pontinhos que aparecem no campo são **placeholder**, não conteúdo. Um
clique que não pegou o foco faz você salvar um campo **vazio** sem perceber — e no
nosso caso isso derrubaria o chatbot inteiro.

### 3. Instalar pacote com a ferramenta errada

O ambiente buildava com `bun`; instalamos com `npm`. O arquivo de controle do `npm` foi
atualizado, o do `bun` ficou para trás, o pacote novo nunca foi baixado e **todo build
falhava em silêncio** — nem frontend nem backend subiam.

Descubra com qual ferramenta o ambiente builda **antes** de instalar qualquer coisa.

### 4. E-mail do commit inválido bloqueia a publicação

A Vercel recusou nossa publicação:

> *The deployment was blocked because the commit author email
> (`usuario@MacBook-de-Fulano.local`) is not valid.*

A máquina nunca teve e-mail configurado no Git, então ele inventava um a partir do nome
do computador. O GitHub aceita qualquer e-mail — só não o vincula a uma conta — por
isso o problema ficou invisível por 33 publicações.

```
git config user.email "ID+usuario@users.noreply.github.com"
```

O número está em `https://api.github.com/users/SEU_USUARIO`, no campo `id`. Esse
endereço `noreply` atribui corretamente sem expor e-mail pessoal.

### 5. Resposta cortada no meio

Com o limite de resposta em 1200 tokens, a resposta parava no cabeçalho da terceira
tabela — **sem nenhuma linha e sem o aviso final**.

O que escondeu o problema: resposta curta cabia no limite e saía perfeita. Só
comparando uma longa com uma curta ficou claro.

**Como reconhecer:** a resposta para num ponto arbitrário, sem mensagem de erro
nenhuma. Parar logo depois de um cabeçalho de tabela é a assinatura clássica.

### 6. Outro agente de IA mexendo no mesmo projeto

Se a plataforma tem um assistente próprio, ele pode desfazer o que você configurou. No
nosso caso, reduziu o contexto de 2 documentos para 1, e de 42 mil para 9 mil
caracteres — truncando 14 dos 37 documentos, o maior perdendo 55% do conteúdo.

Meça o impacto antes de aceitar e **deixe o número escrito num comentário no código**,
para a decisão não ser desfeita por engano de novo.

### 7. "Parar de usar" não é "apagar"

Interpretamos "não vamos mais usar essa ferramenta" como autorização para remover os
arquivos dela. Aquilo contradizia um documento de arquitetura do próprio projeto e
custou desfazer tudo.

Parar de usar é uma coisa. Apagar é outra. Na dúvida, pergunte.

---

## Checklist antes de entregar

Teste cada linha e anote o resultado. Não confie na memória.

### A busca acha o documento certo

- [ ] Pergunta com o nome exato do documento traz aquele documento em primeiro
- [ ] Pergunta no plural traz o mesmo que no singular
- [ ] Pergunta com acento traz o mesmo que sem acento
- [ ] Pergunta fora do assunto não traz nada (teste ao menos cinco)

### A resposta sai completa e correta

- [ ] Resposta **longa** chega até o fim, com a última seção presente
- [ ] O formato definido na instrução é respeitado
- [ ] Nenhum rótulo de seção vaza para o texto
- [ ] A fonte citada corresponde ao conteúdo
- [ ] Pergunta sobre processo inexistente **não** recebe resposta inventada

### O sistema aguenta erro

- [ ] Chamada sem login recebe recusa
- [ ] Recarregar a página no meio de uma resposta não trava o campo de mensagem
- [ ] Conexão interrompida libera o campo e mostra erro legível
- [ ] Link direto para uma rota interna abre, não dá 404

### Você tem controle da operação

- [ ] Você sabe dizer qual versão está no ar **no backend**
- [ ] Trocar de modelo não exige deploy
- [ ] Ajustar a instrução não exige deploy
- [ ] O custo por pergunta foi **medido**, não estimado

---

## Glossário

**API** — a forma de um programa conversar com outro, sem interface gráfica.

**Backend** — a parte que roda no servidor. Ninguém vê o código. É onde ficam as
chaves.

**Chave de API** — senha longa que identifica quem está chamando e para quem vai a
conta. Nunca vai para o navegador nem para o Git.

**Commit** — uma versão salva do código, com descrição do que mudou.

**Contexto** — tudo que você manda para a IA numa chamada: instruções, documento,
histórico e pergunta. Tem tamanho máximo.

**Deploy** — publicar uma versão nova para valer. Frontend e backend têm deploys
separados.

**Edge function** — um pedacinho de backend que roda sob demanda, sem você administrar
servidor.

**Embeddings** — técnica de busca que transforma texto em números para comparar
significado em vez de palavras.

**Frontend** — a parte que roda no navegador. Todo mundo consegue ver o código.

**LLM** — o modelo de IA que recebe texto e devolve texto. Não tem memória nem acesso
à internet.

**Markdown** — formato de texto com formatação por pontuação. `##` faz título, `|` faz
tabela.

**Prompt de sistema** (ou instrução) — texto que define quem a IA é e como deve se
comportar. O usuário não vê.

**RLS** (*Row Level Security*) — trava do banco de dados que controla quem lê cada
linha.

**Secret** — configuração guardada fora do código, para valores sensíveis como chaves.

**Streaming** — receber a resposta aos pedaços, em vez de esperar ela inteira.

**Token** — pedaço de palavra. É a unidade que a IA lê e pela qual você paga. Em
português, cerca de 3 caracteres.
