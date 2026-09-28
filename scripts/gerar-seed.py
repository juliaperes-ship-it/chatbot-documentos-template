#!/usr/bin/env python3
"""Gera a migracao que carrega os documentos extraidos no banco.

    python3 scripts/extrair-pops.py && python3 scripts/gerar-seed.py

Usa `on conflict (slug) do update`: rodar duas vezes nao duplica nada, e reextrair um
documento corrigido so atualiza a linha dele.
"""
import json
from datetime import date
from pathlib import Path

ENTRADA = Path("documentos-extraidos")
SAIDA = Path("supabase/migrations") / f"{date.today():%Y%m%d}120000_seed_documentos.sql"


def literal(txt):
    """Literal SQL. Aspas simples dobradas; nada de concatenar string a mao."""
    return "'" + txt.replace("'", "''") + "'"


def main():
    indice = json.loads((ENTRADA / "indice.json").read_text(encoding="utf-8"))
    partes = [
        "-- Base de conhecimento do agente: os documentos internos do cliente.",
        "--",
        "-- Gerado por scripts/gerar-seed.py a partir de documentos-extraidos/.",
        "-- Nao editar a mao: reextraia e regenere.",
        "--",
        f"-- {len(indice)} documentos.",
        "",
    ]
    total = 0
    for doc in indice:
        conteudo = (ENTRADA / doc["arquivo"]).read_text(encoding="utf-8")
        total += len(conteudo)
        partes.append(
            "insert into public.documentos (slug, titulo, grupo, conteudo, imagens, palavras)\n"
            f"values (\n  {literal(doc['slug'])},\n  {literal(doc['titulo'])},\n"
            f"  {literal(doc['grupo'])},\n  {literal(conteudo)},\n"
            f"  {doc['imagens']},\n  {doc['palavras']}\n)\n"
            "on conflict (slug) do update set\n"
            "  titulo = excluded.titulo,\n  grupo = excluded.grupo,\n"
            "  conteudo = excluded.conteudo,\n  imagens = excluded.imagens,\n"
            "  palavras = excluded.palavras,\n  atualizado_em = now();\n"
        )
    SAIDA.write_text("\n".join(partes), encoding="utf-8")
    print(f"{SAIDA}")
    print(f"{len(indice)} documentos, {total:,} caracteres de conteudo, "
          f"~{total//4:,} tokens estimados")
    print(f"arquivo: {SAIDA.stat().st_size/1024:.0f} KB")


if __name__ == "__main__":
    main()
