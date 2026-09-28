// Testa as migracoes e a busca num Postgres descartavel, sem instalar banco nem Docker.
//
// O PGlite e o Postgres compilado para WebAssembly: sobe em segundos dentro do Node e
// roda SQL de verdade, com unaccent e pg_trgm. Serve para a migracao e a funcao de
// busca nao estrearem direto em producao.
//
//   npm install --no-save @electric-sql/pglite
//   node scripts/testa-migracoes.mjs
//
// RODE ISTO ANTES DE TODO `supabase db push`. Nos projetos em que este template
// nasceu, esta bateria pegou, antes de chegarem em producao:
//   - restricao de grupo herdada de outro cliente, que recusaria todo documento;
//   - tabela de passos com o cabecalho na linha errada;
//   - dupla stemizacao na busca, que fazia o rank por titulo ser sempre zero.
//
// O pacote pglite fica FORA do package.json de proposito: e usado so por este script,
// pesa dezenas de MB, e dependencia de script local no package.json entra no build do
// frontend sem precisar.
import { PGlite } from "@electric-sql/pglite";
// As extensoes contrib nao vem ligadas: precisam ser importadas e registradas.
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Caminho relativo a este arquivo, e nao absoluto: o script tem de rodar na maquina
// de qualquer pessoa do time.
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

// ===========================================================================
// PREENCHA: perguntas reais do acervo deste cliente.
//
// Uma linha por caso: [pergunta, titulo esperado em primeiro lugar, por que importa].
//
// Inclua, no minimo:
//   - o titulo exato de um documento;
//   - o mesmo titulo COM e SEM acento, se ele tiver acento;
//   - uma pergunta natural completa ("quais os passos de ...?");
//   - dois documentos de nome parecido, para ver se a busca os distingue;
//   - cada uma das sugestoes de APP.sugestoes, com o texto exato que o clique envia.
//
// Com a lista vazia, os testes de estrutura e de fora-de-dominio rodam igual.
// ===========================================================================
const CASOS = [
  // ["titulo exato do documento", "Titulo Exato Do Documento", "titulo exato"],
];

// Perguntas que NAO devem achar nada. Se alguma achar, a busca esta frouxa e o agente
// vai responder sobre assunto que nao e dele.
const FORA_DO_DOMINIO = [
  "previsão do tempo",
  "quem ganhou a copa",
  "qual a capital da Mongólia",
  "me ensina a fazer bolo",
  "quanto custa um carro",
];

let falhas = 0;
const ok = (nome, cond, extra = "") => {
  console.log(`${cond ? "PASSA" : "FALHA"}  ${nome}${extra ? "  -> " + extra : ""}`);
  if (!cond) falhas += 1;
};

const db = await PGlite.create({ extensions: { unaccent, pg_trgm } });

// O Supabase ja tem esses papeis; o Postgres cru nao. Criar aqui e o que permite as
// migracoes rodarem iguais ao que vao rodar em producao, com os grants e tudo.
await db.exec("create role service_role; create role anon; create role authenticated;");

for (const arquivo of readdirSync(RAIZ).filter((a) => a.endsWith(".sql")).sort()) {
  try {
    await db.exec(readFileSync(join(RAIZ, arquivo), "utf8"));
    ok(`migracao aplica: ${arquivo}`, true);
  } catch (e) {
    ok(`migracao aplica: ${arquivo}`, false, String(e.message).slice(0, 200));
    console.log("\nInterrompido: a migracao acima precisa passar antes dos testes.");
    process.exit(1);
  }
}

// Sem seed carregado, insere documentos sinteticos para a busca ainda ser testavel.
const { rows: antes } = await db.query("select count(*)::int as n from documentos");
const comSeed = antes[0].n > 0;
if (!comSeed) {
  console.log("\n(nenhum seed encontrado: usando documentos sinteticos)\n");
  const sinteticos = [
    ["geral-devolucao", "Devolução de Produto", "geral"],
    ["geral-conferencia", "Conferência de Estoque", "geral"],
  ];
  for (const [slug, titulo, grupo] of sinteticos) {
    // Conteudo longo o bastante para passar na checagem de documento truncado, que
    // exige 200 caracteres. Fixture curto fazia a propria bateria acusar falha.
    const conteudo = [
      `## Objetivo`,
      `Padronizar a execução de ${titulo}, do início ao fim, para que todo atendimento`,
      `siga a mesma estrutura e gere registro rastreável.`,
      ``,
      `## Descrição das atividades`,
      ``,
      `| Nº | O que é feito | Quem faz | Documento ou ferramenta |`,
      `| --- | --- | --- | --- |`,
      `| 1 | Abrir o sistema e localizar o registro | Analista | Sistema |`,
      `| 1.1 | Conferir se os dados estão coerentes | Analista | Sistema |`,
      `| 2 | Registrar o encerramento e notificar a área | Analista | E-mail |`,
    ].join("\n");
    await db.query(
      "insert into documentos (slug, titulo, grupo, conteudo, palavras) values ($1,$2,$3,$4,$5)",
      [slug, titulo, grupo, conteudo, conteudo.split(/\s+/).length],
    );
  }
  CASOS.push(
    ["devolução de produto", "Devolução de Produto", "acento na pergunta e no titulo"],
    ["devolucao de produto", "Devolução de Produto", "sem acento na pergunta"],
    ["devoluções", "Devolução de Produto", "plural de -cao/-coes"],
    ["conferencia de estoque", "Conferência de Estoque", "titulo com acento, pergunta sem"],
  );
}

const { rows: total } = await db.query("select count(*)::int as n from documentos");
ok("ha documentos carregados", total[0].n > 0, `n=${total[0].n}`);

const { rows: ruins } = await db.query(
  "select slug from documentos where length(trim(conteudo)) < 200 or trim(titulo) = ''");
ok("nenhum documento vazio ou truncado", ruins.length === 0, JSON.stringify(ruins));

const { rows: dup } = await db.query(
  "select titulo from documentos group by titulo having count(*) > 1");
ok("nenhum titulo duplicado", dup.length === 0, JSON.stringify(dup));

const { rows: grupos } = await db.query(
  "select grupo, count(*)::int as n from documentos group by grupo order by grupo");
console.log(`       grupos no banco: ${grupos.map((g) => `${g.grupo}=${g.n}`).join(", ")}`);

const busca = async (q) => {
  const { rows } = await db.query("select titulo from buscar_documentos($1, 2)", [q]);
  return rows.map((r) => r.titulo);
};

if (CASOS.length === 0) {
  console.log("\n(CASOS esta vazio: preencha com perguntas reais do acervo)\n");
}
for (const [pergunta, esperado, porque] of CASOS) {
  const r = await busca(pergunta);
  ok(`"${pergunta}" -> ${esperado}`, r[0] === esperado, `${porque}; veio: ${JSON.stringify(r)}`);
}

for (const q of FORA_DO_DOMINIO) {
  const r = await busca(q);
  ok(`fora do dominio devolve vazio: "${q}"`, r.length === 0, `veio: ${JSON.stringify(r)}`);
}

const { rows: hist } = await db.query(
  `insert into chat_sessions (session_id, user_id, role, content)
   values ('sessao-de-teste', gen_random_uuid(), 'user', 'oi') returning id`);
ok("chat_sessions aceita insercao", hist.length === 1);

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
