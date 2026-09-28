// Envia docs/instrucao-do-agente.md para o secret LLM_INSTRUCTION.
//
//   node scripts/definir-instrucao.mjs
//
// Dois cuidados que parecem paranoia e nao sao:
//
// 1. O corte do cabecalho procura uma LINHA que seja exatamente "-->", e nao a
//    primeira ocorrencia da sequencia. O proprio cabecalho contem "-->" no meio de um
//    comando de exemplo, e cortar pela primeira ocorrencia enviou 519 dos 5039
//    caracteres - sem erro nenhum, porque 519 caracteres sao uma instrucao valida.
//
// 2. O valor vai como argumento de execFile, nao por linha de comando montada em
//    shell. O texto tem aspas, crase, cifrao e acento; qualquer um deles quebraria ou,
//    pior, seria reinterpretado.
//
// Confere o que foi enviado imprimindo tamanho e as pontas, porque secret nao pode ser
// lido de volta - se estiver errado, so o comportamento do agente denuncia, e tarde.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ARQUIVO = "docs/instrucao-do-agente.md";
const linhas = readFileSync(ARQUIVO, "utf8").split("\n");

const fimDoCabecalho = linhas.findIndex((l) => l.trim() === "-->");
if (fimDoCabecalho === -1) {
  console.error(`${ARQUIVO}: nao achei uma linha contendo apenas "-->"`);
  process.exit(1);
}
const valor = linhas.slice(fimDoCabecalho + 1).join("\n").replace(/^\n+/, "").trimEnd();

if (valor.length < 1000) {
  console.error(`instrucao suspeitamente curta (${valor.length} chars). Abortando.`);
  process.exit(1);
}

console.log(`instrucao: ${valor.length} caracteres, ${valor.split("\n").length} linhas`);
console.log(`  comeca: ${JSON.stringify(valor.slice(0, 60))}`);
console.log(`  termina: ${JSON.stringify(valor.slice(-60))}`);

const env = { ...process.env };
delete env.SUPABASE_ACCESS_TOKEN; // variavel legada no ambiente quebra o CLI

execFileSync("npx", ["--yes", "supabase@latest", "secrets", "set", `LLM_INSTRUCTION=${valor}`],
  { stdio: "inherit", env });
