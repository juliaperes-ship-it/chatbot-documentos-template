-- Base de conhecimento do agente: os documentos internos do cliente.
--
-- Por que busca full-text do Postgres e nao embeddings/pgvector: o criterio e o
-- tamanho e a clareza do acervo. Embeddings resolvem o problema de achar o trecho
-- relevante entre milhares de fragmentos com titulos vagos. Com dezenas de documentos
-- de titulo autoexplicativo, full-text resolve igual, sem pipeline de indexacao, sem
-- custo por pergunta e com resultado que da para depurar lendo.
--
-- Se o acervo crescer o bastante para inverter essa conta, adicionar uma coluna
-- `vector` e incremento, nao reescrita.

-- ---------------------------------------------------------------------------
-- Configuracao de busca: portugues + remocao de acento.
--
-- Sem o unaccent a busca falha no caso mais comum. Os titulos vem dos nomes de
-- arquivo, que sao sem acento ("Inventario"), mas quem pergunta escreve certo
-- ("inventário"). O stemmer portugues gera lexemas diferentes para os dois
-- ('inventari' vs 'inventári') e o documento nao apareceria. Normalizar o acento dos
-- dois lados resolve.
-- ---------------------------------------------------------------------------

create extension if not exists unaccent;
-- pg_trgm para a etapa de similaridade: o stemmer portugues erra o plural de -cao/-coes
-- (ver comentario em buscar_documentos).
create extension if not exists pg_trgm;

do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'portugues_sem_acento') then
    create text search configuration public.portugues_sem_acento (copy = portuguese);
    alter text search configuration public.portugues_sem_acento
      alter mapping for hword, hword_part, word with unaccent, portuguese_stem;
  end if;
end
$$;

-- ---------------------------------------------------------------------------

create table if not exists public.documentos (
  slug text primary key,
  titulo text not null,
  -- Agrupamento do documento: a area a que ele pertence (comercial, logistica,
  -- fiscal...). Vem do nome da subpasta em documentos-fonte/, e aparece na resposta
  -- quando alguem pergunta quais processos existem.
  --
  -- Sem lista fixa de propria: um `check (grupo in (...))` com os grupos de um
  -- cliente recusaria todo documento do proximo, e o erro apareceria so no fim, na
  -- carga, longe da causa. Foi o que aconteceu ao reusar este codigo pela primeira
  -- vez.
  --
  -- Quando os grupos do cliente estiverem definidos e estaveis, vale trocar por um
  -- check com a lista: ele transforma erro de digitacao na carga em erro na hora, em
  -- vez de um grupo orfao que aparece semanas depois numa resposta errada.
  grupo text not null check (length(trim(grupo)) > 0),
  conteudo text not null,
  secoes text[] not null default '{}',
  imagens integer not null default 0,
  palavras integer not null default 0,
  atualizado_em timestamptz not null default now(),
  busca tsvector
);

-- Trigger em vez de coluna gerada: coluna gerada exige funcao IMMUTABLE, e passar a
-- configuracao de busca como literal para to_tsvector pode ser rejeitado por causa do
-- cast text->regconfig. O trigger nao tem essa restricao.
create or replace function public.documentos_atualiza_busca()
returns trigger
language plpgsql
as $$
begin
  -- Titulo com peso 'A' e conteudo com 'B': uma pergunta sobre "inventario" traz
  -- primeiro o documento chamado Inventario, nao um que menciona a palavra de
  -- passagem. ts_rank respeita esses pesos.
  new.busca :=
    setweight(to_tsvector('public.portugues_sem_acento', coalesce(new.titulo, '')), 'A') ||
    setweight(to_tsvector('public.portugues_sem_acento', coalesce(new.conteudo, '')), 'B');
  return new;
end
$$;

drop trigger if exists trg_documentos_busca on public.documentos;
create trigger trg_documentos_busca
before insert or update of titulo, conteudo on public.documentos
for each row execute function public.documentos_atualiza_busca();

create index if not exists idx_documentos_busca on public.documentos using gin (busca);
create index if not exists idx_documentos_grupo on public.documentos (grupo);

-- ---------------------------------------------------------------------------
-- Busca usada pela edge function.
--
-- Tres decisoes aqui, cada uma vinda de um erro observado em teste:
--
-- 1. A expressao NAO passa por to_tsquery, e sim pelo cast ::tsquery.
--    Os lexemas vindos de to_tsvector ja estao stemizados. Passa-los por to_tsquery
--    os stemiza de novo: 'inventari' virava 'inventar', que nao casa com nada. O
--    resultado era busca no titulo sempre falhando, e o acerto acontecendo por
--    acidente, ao achar variantes no corpo do texto. O cast trata a string como
--    sintaxe de tsquery ja normalizada.
--
-- 2. Busca em duas etapas, titulo antes de conteudo. Palavras genericas da pergunta
--    ("processo", "passos", "funciona") aparecem em quase todos os documentos, e com
--    OR o ts_rank de um documento longo que repete a palavra comum supera o do
--    documento cujo TITULO e a resposta. Medido: uma pergunta da forma "como funciona
--    o processo de X?" devolvia em primeiro um documento longo que repetia "processo"
--    varias vezes, em vez daquele chamado X.
--
-- 3. Entre titulo e conteudo entra uma etapa de similaridade por trigrama, porque o
--    stemmer portugues nao casa o plural de -cao/-coes. Medido no proprio Postgres:
--    "devolucao" gera o lexema `devoluca` e "devolucoes" gera `devoluco` - nunca
--    casam, e um documento chamado "Devolucoes" fica invisivel para quem perguntar no
--    singular. O contraste deixa claro que e especifico desse sufixo:
--
--      conferencia / conferencias  -> `conferenc` e `conferenc`   casam
--      cotacao     / cotacoes      -> `cotaca`    e `cotaco`      NAO casam
--      devolucao   / devolucoes    -> `devoluca`  e `devoluco`    NAO casam
--
--    Em portugues de processo, nome em -cao e a regra e nao a excecao, entao esta
--    etapa costuma ser a que salva metade do acervo.
--
--    O limiar de 0.25 e calibrado, nao arbitrario: os casos que esta etapa precisa
--    pegar ficam entre 0.273 e 0.786, e perguntas fora do dominio (testadas dez, de
--    "previsao do tempo" a "quem ganhou a copa") nao passam de 0.222.
--
-- 4. A etapa de conteudo usa AND, nao OR. Com OR, uma pergunta sem relacao nenhuma
--    ("qual a capital da mongolia") casava com 4 documentos por causa de "capital",
--    com rank indistinguivel do de um acerto real - nao havia limiar que separasse.
--    Exigindo todos os termos, pergunta fora do dominio devolve vazio, e o agente cai
--    no comportamento de dizer que nao encontrou.
-- ---------------------------------------------------------------------------

create or replace function public.buscar_documentos(consulta text, limite integer default 3)
returns table (
  slug text,
  titulo text,
  grupo text,
  conteudo text,
  imagens integer,
  relevancia real
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lexemas text[];
  tsq_ou tsquery;
  tsq_e tsquery;
  n_limite integer := greatest(1, least(coalesce(limite, 3), 10));
begin
  select array_agg(quote_literal(lexeme))
    into lexemas
    from unnest(to_tsvector('public.portugues_sem_acento', coalesce(consulta, '')));

  if lexemas is null or array_length(lexemas, 1) = 0 then
    return;
  end if;

  tsq_ou := array_to_string(lexemas, ' | ')::tsquery;
  tsq_e := array_to_string(lexemas, ' & ')::tsquery;

  -- Etapa 1: o titulo responde a pergunta.
  return query
    select d.slug, d.titulo, d.grupo, d.conteudo, d.imagens,
           ts_rank(to_tsvector('public.portugues_sem_acento', d.titulo), tsq_ou) as relevancia
    from public.documentos d
    where to_tsvector('public.portugues_sem_acento', d.titulo) @@ tsq_ou
    order by relevancia desc, d.palavras desc
    limit n_limite;

  if found then
    return;
  end if;

  -- Etapa 2: o titulo e parecido, mesmo sem casar no stemmer (plural de -cao/-coes).
  return query
    with pontuado as (
      select d.*,
             word_similarity(unaccent(lower(consulta)), unaccent(lower(d.titulo))) as sim
      from public.documentos d
    )
    select p.slug, p.titulo, p.grupo, p.conteudo, p.imagens, p.sim::real
    from pontuado p
    where p.sim >= 0.25
    order by p.sim desc, p.palavras desc
    limit n_limite;

  if found then
    return;
  end if;

  -- Etapa 3: o conteudo contem todos os termos.
  return query
    select d.slug, d.titulo, d.grupo, d.conteudo, d.imagens,
           ts_rank(d.busca, tsq_e) as relevancia
    from public.documentos d
    where d.busca @@ tsq_e
    order by relevancia desc, d.palavras desc
    limit n_limite;

  if found then
    return;
  end if;

  -- Etapa 4: a pergunta e o proprio nome do documento, escrito de outra forma.
  return query
    select d.slug, d.titulo, d.grupo, d.conteudo, d.imagens, 0::real as relevancia
    from public.documentos d
    where unaccent(lower(d.titulo)) like '%' || unaccent(lower(consulta)) || '%'
    order by d.palavras desc
    limit n_limite;
end
$$;

-- Lista os documentos existentes, para o agente saber o que pode ser consultado.
create or replace function public.listar_documentos()
returns table (slug text, titulo text, grupo text, palavras integer)
language sql
stable
security definer
set search_path = public
as $$
  select d.slug, d.titulo, d.grupo, d.palavras
  from public.documentos d
  order by d.grupo, d.titulo;
$$;

-- ---------------------------------------------------------------------------
-- RLS ligado sem policies: so a service_role acessa, por bypass. E o que a edge
-- function usa.
--
-- Intencional: sao documentos internos de processo do cliente. Dar leitura com a anon
-- key colocaria a base inteira a disposicao de qualquer visitante da pagina, ja que a
-- anon key vai no bundle do frontend.
-- ---------------------------------------------------------------------------
-- Idem: bypass de RLS nao dispensa privilegio de tabela.
grant all on public.documentos to service_role;
grant execute on function public.buscar_documentos(text, integer) to service_role;
grant execute on function public.listar_documentos() to service_role;

alter table public.documentos enable row level security;

revoke all on function public.buscar_documentos(text, integer) from anon, authenticated;
revoke all on function public.listar_documentos() from anon, authenticated;
