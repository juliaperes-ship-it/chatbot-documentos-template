import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// As duas variaveis sao publicas por design e vao no bundle do navegador. A chave
// `publishable` (anon) so pode o que as policies de RLS permitirem - e neste projeto
// as tabelas de documentos e de historico nao permitem nada a ela. A chave que da
// acesso de verdade, e a do modelo, vivem so na edge function.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  // Falhar aqui, no carregamento, e melhor do que deixar o app subir e quebrar so na
  // primeira tentativa de login, com um erro que nao aponta para a causa.
  throw new Error(
    "Faltam VITE_SUPABASE_URL e/ou VITE_SUPABASE_PUBLISHABLE_KEY. Copie o .env.example para .env e preencha.",
  );
}

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
