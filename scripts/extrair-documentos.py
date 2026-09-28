#!/usr/bin/env python3
"""Converte documentos .docx em Markdown, prontos para carregar no banco.

Sem dependencia externa: um .docx e um zip com XML dentro, e a biblioteca padrao do
Python abre os dois.

    # organize os arquivos assim (a subpasta define o grupo):
    #   documentos-fonte/comercial/001. POP Atendimento.docx
    #   documentos-fonte/logistica/002. POP Conferencia.docx
    # arquivos na raiz de documentos-fonte/ caem no GRUPO_PADRAO

    python3 scripts/extrair-documentos.py

ANTES DE CONFIAR NA SAIDA, olhe um arquivo gerado. Template de documento varia, e
duas coisas mudam de cliente para cliente:

1. COMO OS TITULOS DE SECAO SAO MARCADOS. Este extrator detecta por NEGRITO. Ha
   templates que usam estilo de paragrafo ("Titulo 1", "Heading 1") e nesses o
   negrito nao marca nada - o extrator devolveria um bloco unico de texto corrido.
   Se for o caso, troque `e_negrito()` por uma checagem de `w:pPr/w:pStyle`.
   Cuidado: o Word grava o nome do estilo SEM acento ("Ttulo1") e em ingles quando o
   arquivo veio de outra instalacao.

2. OS NOMES DAS SECOES. Ajuste SECOES_CORRIGIDAS e SECOES_IGNORADAS ao template do
   cliente.
"""

import hashlib
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

ENTRADA = Path("documentos-fonte")
SAIDA = Path("documentos-extraidos")

# Grupo de cada documento = nome da subpasta onde ele esta.
#
# O grupo aparece na resposta quando alguem pergunta "quais processos existem", e e
# por ele que o catalogo agrupa. Use as areas reais do cliente (comercial, logistica,
# fiscal...), nao uma taxonomia inventada - tire do proprio documento, a secao de
# escopo costuma dizer a que area ele se aplica.
GRUPO_PADRAO = "geral"

# Prefixos a remover do titulo, alem da numeracao inicial.
#
# Se todo documento se chamar "POP Alguma Coisa", a palavra "POP" entra no indice de
# busca com peso de titulo sem distinguir nada. Pior: palavra repetida em todo titulo
# ja fez a busca devolver o documento errado, porque um documento longo que repete
# uma palavra comum vence no ranking o documento cujo titulo E a resposta.
PREFIXOS_A_REMOVER = [r"^POP\s+", r"^MOP\s+", r"^Manual\s+de\s+"]

# Secoes que nao vao para o corpus.
#
# Controle de versao e um exemplo: "Emissao inicial" e uma data nao ajudam a
# responder pergunta nenhuma, e ainda competem na busca com conteudo util.
SECOES_IGNORADAS = {"CONTROLE DE EDIÇÃO", "CONTROLE DE VERSÃO", "HISTÓRICO DE REVISÕES"}

# O cabecalho da tabela de atividades vem em caixa alta e com espaco nao-separavel
# ("DOCUMENTO OU FERRAMENTA\xa0ACESSADA"). Normalizar aqui deixa o corpus no mesmo
# formato que a instrucao pede que o agente use na resposta.
CABECALHOS = {
    "Nº.": "Nº",
    "O QUE É FEITO": "O que é feito",
    "QUEM FAZ": "Quem faz",
    "DOCUMENTO OU FERRAMENTA ACESSADA": "Documento ou ferramenta",
    "DOCUMENTO OU FERRAMENTA": "Documento ou ferramenta",
}

# Nome de secao como deve aparecer na resposta, indexado pelo texto cru do documento.
#
# Serve para dois casos. Um e a caixa alta, que nao se quer na resposta. O outro sao
# os erros do documento original - a entrada "RESPONSAVÉIS" abaixo e real, com o
# acento na letra errada, e corrigir importa porque esse texto vai para a tela que o
# usuario le. Acrescente aqui o que o template do cliente trouxer.
SECOES_CORRIGIDAS = {
    "RESPONSAVÉIS": "Responsáveis",
    "DEFINIÇÕES (GLOSSÁRIO)": "Definições",
    "DESCRIÇÃO DAS ATIVIDADES": "Descrição das atividades",
    "CONTROLE DE EDIÇÃO": "Controle de edição",
    "DOCUMENTOS RELACIONADOS": "Documentos relacionados",
    "FLUXOGRAMA": "Fluxograma",
    "OBJETIVO": "Objetivo",
    "ESCOPO": "Escopo",
}


def texto_de(el):
    """Texto de um elemento, com quebra de linha e tabulacao virando espaco.

    Sem isso os titulos sairiam grudados - o Word guarda "POP Recuperacao<br/>de
    Carrinhos" e a juncao ingenua produz "POP Recuperacaode Carrinhos".
    """
    partes = []
    for no in el.iter():
        tag = no.tag.replace(W, "")
        if tag == "t":
            partes.append(no.text or "")
        elif tag in ("br", "tab", "cr"):
            partes.append(" ")
    return " ".join("".join(partes).split()).strip()


def e_negrito(p):
    """Negrito = titulo de secao neste template."""
    for run in p.iter(f"{W}r"):
        if "".join(t.text or "" for t in run.iter(f"{W}t")).strip():
            rpr = run.find(f"{W}rPr")
            return rpr is not None and rpr.find(f"{W}b") is not None
    return False


def links_do(zf):
    try:
        rels = ET.fromstring(zf.read("word/_rels/document.xml.rels"))
    except KeyError:
        return {}
    return {r.get("Id"): r.get("Target") for r in rels
            if r.get("Type", "").endswith("/hyperlink")}


def paragrafo_markdown(p, links):
    """Paragrafo em Markdown, preservando hyperlink como [texto](url)."""
    partes = []
    for filho in p:
        tag = filho.tag.replace(W, "")
        if tag == "hyperlink":
            rotulo = texto_de(filho)
            destino = links.get(filho.get(f"{R}id"))
            partes.append(f"[{rotulo}]({destino})" if destino and rotulo else rotulo)
        else:
            partes.append(texto_de(filho))
    return " ".join(" ".join(partes).split()).strip()


def celula(txt):
    # Pipe dentro da celula quebraria a tabela Markdown.
    return txt.replace("|", "\\|") or "-"


def tabela_markdown(tbl):
    """Tabela em Markdown. Linha de uma celula so vira subtitulo em negrito.

    Na tabela de atividades, as linhas de celula unica sao os grupos de etapa
    ("Abertura do atendimento e identificacao da demanda"). Trata-las como linha
    normal jogaria o nome do grupo na coluna do numero do passo.

    O cabecalho e LEMBRADO e reemitido a cada grupo. A primeira versao deste codigo
    apenas zerava o estado ao ver um grupo, e a linha seguinte - um passo de verdade -
    virava cabecalho: o passo "1 | Abrir o PDV" sumia como dado e aparecia como
    titulo de coluna, enquanto o cabecalho real ficava sozinho sobre uma tabela vazia.

    Emitir o cabecalho so quando existe uma linha de dados evita tambem a tabela vazia
    quando um grupo aparece logo depois do cabecalho.
    """
    saida, cabecalho, n_colunas = [], None, 0
    precisa_cabecalho = True

    def linha(cels):
        return "| " + " | ".join(celula(c) for c in cels) + " |"

    for tr in tbl.findall(f"{W}tr"):
        cels = [texto_de(tc) for tc in tr.findall(f"{W}tc")]
        if not cels or not any(cels):
            continue
        if len(cels) == 1:
            saida.extend(["", f"**{cels[0]}**", ""])
            precisa_cabecalho = True
            continue
        if cabecalho is None:
            cabecalho = [CABECALHOS.get(c.replace("\xa0", " ").strip().upper(), c) for c in cels]
            n_colunas = len(cabecalho)
            continue
        if precisa_cabecalho:
            saida.append(linha(cabecalho))
            saida.append("| " + " | ".join("---" for _ in cabecalho) + " |")
            precisa_cabecalho = False
        cels = (cels + ["-"] * n_colunas)[:n_colunas]
        saida.append(linha(cels))
    return "\n".join(saida).strip()


def blocos(corpo, links):
    """Percorre corpo na ordem, devolvendo ('p'|'tbl', conteudo)."""
    for el in corpo:
        tag = el.tag.replace(W, "")
        if tag == "p":
            yield "p", el, paragrafo_markdown(el, links)
        elif tag == "tbl":
            yield "tbl", el, tabela_markdown(el)


def titulo_do_arquivo(caminho):
    """Titulo a partir do nome do arquivo, nao do texto interno.

    O titulo dentro do documento vem quebrado em varias linhas e sai grudado. O nome
    do arquivo e limpo e e tambem como as pessoas se referem ao processo.

    Caem tambem a numeracao inicial, um prefixo entre colchetes e o que estiver em
    PREFIXOS_A_REMOVER - ver o comentario daquela lista para o porque.
    """
    nome = caminho.stem
    nome = re.sub(r"^\d+[.\-)]?\s*", "", nome)
    nome = re.sub(r"^\[.*?\]\s*-\s*", "", nome)
    for prefixo in PREFIXOS_A_REMOVER:
        nome = re.sub(prefixo, "", nome, flags=re.I)
    return nome.replace(" - ", " — ").strip()


def slug_de(titulo, grupo):
    base = unicodedata.normalize("NFKD", titulo).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()
    return f"{grupo}-{base}"


def hashes_de_template(caminhos):
    """Imagens que aparecem em TODO documento sao template, nao conteudo.

    Cada POP tem 5 imagens, mas 4 sao logo e rodape repetidos nos 8 arquivos - uma
    delas com 2,5 MB, que e o que faz cada .docx pesar 3,5 MB. Contar as 5 como
    conteudo faria o agente avisar "contem 5 imagens que nao leio" quando ha uma so,
    o fluxograma.
    """
    contagem = {}
    for caminho in caminhos:
        with zipfile.ZipFile(caminho) as zf:
            vistos = {hashlib.sha1(zf.read(n)).hexdigest()
                      for n in zf.namelist() if n.startswith("word/media/")}
        for h in vistos:
            contagem[h] = contagem.get(h, 0) + 1
    return {h for h, n in contagem.items() if n > 1}


def extrai(caminho, template):
    with zipfile.ZipFile(caminho) as zf:
        links = links_do(zf)
        corpo = ET.fromstring(zf.read("word/document.xml")).find(f"{W}body")
        imagens = sum(
            1 for n in zf.namelist()
            if n.startswith("word/media/")
            and hashlib.sha1(zf.read(n)).hexdigest() not in template
        )

    linhas, secao_atual, mapeamento = [], None, None
    titulo_arquivo = titulo_do_arquivo(caminho)
    for tipo, el, conteudo in blocos(corpo, links):
        if tipo == "tbl":
            if secao_atual not in SECOES_IGNORADAS and conteudo:
                linhas.append(conteudo)
                linhas.append("")
            continue
        if not conteudo:
            continue
        if e_negrito(el):
            chave = conteudo.upper()
            conhecida = chave in SECOES_CORRIGIDAS or chave in SECOES_IGNORADAS
            numerada = bool(re.match(r"^\d+(\.\d+)*\.?\s+\S", conteudo))

            # Negrito sozinho NAO basta para ser titulo. Documento narrativo costuma
            # trazer frases inteiras em negrito dentro de uma secao, e trata-las como
            # cabecalho picota o arquivo em dezenas de secoes de uma linha - o que
            # estraga tanto a leitura quanto a busca. So e titulo o que tem nome de
            # secao conhecido ou numeracao.
            if not (conhecida or numerada):
                if secao_atual is None:
                    continue  # texto de capa, antes da primeira secao
                linhas.append(f"**{conteudo}**")
                linhas.append("")
                continue

            secao_atual = chave
            if chave in SECOES_IGNORADAS:
                continue
            # Sem .capitalize() em titulo desconhecido: ele rebaixa nome proprio
            # (um nome proprio em caixa alta virava minuscula).
            linhas.append(f"## {SECOES_CORRIGIDAS.get(chave, conteudo)}")
            linhas.append("")
            continue
        if secao_atual in SECOES_IGNORADAS:
            continue
        # O titulo interno do documento repete o que ja esta no cabecalho do arquivo.
        if secao_atual is None and titulo_arquivo.lower() in conteudo.lower():
            continue
        if conteudo.startswith("[") and "](" in conteudo:
            mapeamento = conteudo
        linhas.append(conteudo)
        linhas.append("")

    md = re.sub(r"\n{3,}", "\n\n", "\n".join(linhas)).strip() + "\n"
    return md, imagens, mapeamento


def grupo_do_caminho(caminho):
    """Grupo = nome da subpasta. Arquivo na raiz cai no GRUPO_PADRAO."""
    relativo = caminho.relative_to(ENTRADA)
    if len(relativo.parts) > 1:
        return slugify(relativo.parts[0])
    return GRUPO_PADRAO


def slugify(texto):
    base = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()


def main():
    if not ENTRADA.is_dir():
        sys.exit(
            f"pasta {ENTRADA}/ nao encontrada.\n"
            "Crie-a e ponha os .docx dentro, opcionalmente em subpastas por area:\n"
            f"  {ENTRADA}/comercial/001. POP Atendimento.docx"
        )

    caminhos = sorted(ENTRADA.rglob("*.docx"))
    # O Word deixa arquivo de lock (~$nome.docx) quando o documento esta aberto; ele
    # nao e um .docx valido e quebraria a extracao com um erro obscuro de zip.
    caminhos = [c for c in caminhos if not c.name.startswith("~$")]
    if not caminhos:
        sys.exit(f"nenhum .docx em {ENTRADA}/")

    template = hashes_de_template(caminhos)
    SAIDA.mkdir(exist_ok=True)
    indice = []

    for caminho in caminhos:
        grupo = grupo_do_caminho(caminho)
        titulo = titulo_do_arquivo(caminho)
        md, imagens, mapeamento = extrai(caminho, template)
        slug = slug_de(titulo, grupo)
        (SAIDA / f"{slug}.md").write_text(f"# {titulo}\n\n{md}", encoding="utf-8")
        indice.append({
            "slug": slug, "titulo": titulo, "grupo": grupo,
            "arquivo": f"{slug}.md",
            "palavras": len(md.split()), "imagens": imagens,
            "mapeamento": mapeamento,
        })
        print(f"{titulo[:36]:<38} {grupo:<12} {len(md.split()):>5} palavras  "
              f"{imagens} img  {'link' if mapeamento else '----'}")

    (SAIDA / "indice.json").write_text(
        json.dumps(indice, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum(d["palavras"] for d in indice)
    print(f"\n{len(indice)} documentos em {SAIDA}/  ({total:,} palavras)")
    print("\nConfira um arquivo gerado antes de seguir. Em especial:")
    print("  - as tabelas viraram tabelas markdown, com as colunas separadas?")
    print("  - a numeracao dos passos foi preservada, inclusive subpassos (1.1, 1.2)?")
    print("  - a contagem de imagens bate com os diagramas de conteudo, sem contar logo?")


if __name__ == "__main__":
    main()
