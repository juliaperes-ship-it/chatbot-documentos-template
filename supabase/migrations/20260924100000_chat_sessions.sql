-- Memoria de conversa do chat.
--
-- O modelo nao tem memoria entre chamadas: cada pergunta chega sozinha. Esta tabela e
-- o que permite uma conversa ter continuidade - a edge function le os ultimos turnos
-- por session_id e os manda junto no contexto.

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  -- uuid, nao text: e o id do usuario autenticado. No projeto anterior esta coluna
  -- nasceu text e teve de ser convertida depois, com o banco ja em producao.
  user_id uuid,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- A edge function le sempre pelo mesmo caminho: filtra por usuario e sessao, ordena
-- por data. O indice composto cobre exatamente essa consulta.
create index if not exists idx_chat_sessions_user_session_created
  on public.chat_sessions (user_id, session_id, created_at);

-- RLS ligado sem policy de leitura: so a service_role acessa, por bypass. E o que a
-- edge function usa.
--
-- Consequencia importante e intencional: o navegador NAO le esta tabela com a chave
-- anonima. Sem isso, como o session_id e gerado no cliente, uma pessoa poderia ler a
-- conversa de outra.
grant all on public.chat_sessions to service_role;
alter table public.chat_sessions enable row level security;
revoke all on public.chat_sessions from anon, authenticated;
