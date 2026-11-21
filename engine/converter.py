#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
engine/converter.py
Motore di conversione di Convertitore Markdown.
Integra:
1. Microsoft MarkItDown per DOCX, XLSX, PPTX, HTML, EPUB, CSV, ecc.
2. Un motore PDF a colonne basato su PyMuPDF, per PDF a 1, 2 o 3 colonne, con
   de-sillabazione, filtro di testate e numeri di pagina e indice (TOC) in Markdown.

Protocollo con l'app: l'ultima riga di stdout e' un oggetto JSON; i log vanno su stderr.
"""

import sys
import os
import re
import json
import time
import argparse
from pathlib import Path

# Assicuriamo che l'input/output standard sia UTF-8
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        if _stream is not None and (_stream.encoding or '').lower() != 'utf-8':
            _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Fix Magika per il binario compilato (PyInstaller): cerca il modello dentro il pacchetto
try:
    import magika
    _orig_magika_init = magika.Magika.__init__
    def _patched_magika_init(self, model_dir=None, **kwargs):
        if model_dir is None:
            if getattr(sys, 'frozen', False):
                base_dir = Path(getattr(sys, '_MEIPASS', sys.executable))
                candidates = [
                    base_dir / "magika" / "models" / "standard_v3_3",
                    base_dir / "models" / "standard_v3_3",
                ]
                for c in candidates:
                    if c.is_dir():
                        model_dir = c
                        break
        return _orig_magika_init(self, model_dir=model_dir, **kwargs)
    magika.Magika.__init__ = _patched_magika_init
except Exception:
    pass

APP_NAME = "Convertitore Markdown"

# Formati audio: non supportati
AUDIO_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wma",
    ".aiff", ".aif", ".amr", ".mid", ".midi", ".mp2",
}

# ==============================================================================
# 1. Column-Aware Native PDF Engine
# ==============================================================================

def make_slug(title):
    s = title.lower()
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s or "section"

def convert_pdf_column_aware(pdf_path, riquadri_citazione=False, format_refs=True, add_toc=True):
    """
    Estrazione a colonne geometrica basata su PyMuPDF.
    Gestisce layout a 1 colonna, 2 colonne (con intestazioni full-width) o 3 colonne (indici),
    filtra testate e numeri di pagina, de-sillaba le parole spezzate da \xad o trattino a capo,
    genera TOC Markdown interattivo.
    """
    import pymupdf

    doc = pymupdf.open(pdf_path)
    total_pages = len(doc)

    meta = doc.metadata or {}
    title = meta.get("title") or os.path.splitext(os.path.basename(pdf_path))[0]
    author = meta.get("author") or ""

    toc = doc.get_toc()
    toc_by_page = {}
    for lvl, t, pno in toc:
        if pno > 0:
            toc_by_page.setdefault(pno, []).append((lvl, t))

    header_parts = [
        "---",
        f'title: {json.dumps(title, ensure_ascii=False)}',
        f'author: {json.dumps(author, ensure_ascii=False)}',
        'source_format: "PDF (Column-Aware Native Vector Extraction)"',
        f'total_pages: {total_pages}',
        "---\n",
        f"# {title}\n"
    ]
    if author:
        header_parts.append(f"**Autore / Autori:** {author}\n")
    header_parts.append("---\n")

    if add_toc and toc:
        header_parts.append("## Indice dei Contenuti\n")
        for lvl, t, pno in toc:
            if t.lower() in ["cover", "half title page", "title page", "copyright", "dedication", "contents", "sommario"]:
                continue
            slug = make_slug(t)
            indent = "  " * max(0, lvl - 1)
            if lvl == 1:
                header_parts.append(f"{indent}- **[{t}](#{slug})**")
            elif lvl == 2:
                header_parts.append(f"{indent}- *[{t}](#{slug})*")
            else:
                header_parts.append(f"{indent}- [{t}](#{slug})")
        header_parts.append("\n---\n")

    full_md_chunks = ["\n".join(header_parts)]
    in_case = False
    in_refs = False
    curr_ref_lines = []

    for page_idx in range(total_pages):
        pno = page_idx + 1
        page = doc[page_idx]
        rect = page.rect
        height = rect.height

        # TOC ancore
        if pno in toc_by_page:
            if in_refs and curr_ref_lines:
                rentry = " ".join(curr_ref_lines)
                rentry_clean = re.sub(r'  +', ' ', rentry).strip()
                if rentry_clean:
                    full_md_chunks.append(f"- {rentry_clean}\n")
                curr_ref_lines = []
                in_refs = False

            in_case = False

            for lvl, t in toc_by_page[pno]:
                slug = make_slug(t)
                heading_hashes = "#" * min(lvl, 4)
                full_md_chunks.append(f'\n\n<a id="{slug}"></a>\n{heading_hashes} {t}\n\n')

        text_dict = page.get_text("dict")
        raw_blocks = text_dict.get("blocks", [])

        valid_blocks = []
        for b in raw_blocks:
            if "lines" not in b:
                continue
            full_b_text = "".join("".join(s["text"] for s in l["spans"]) for l in b["lines"]).strip()
            if not full_b_text:
                continue

            bbox = b["bbox"]
            y0, y1 = bbox[1], bbox[3]

            # Filtro testate fisse (y0 < 50 e y1 < 62)
            if y0 < 50 and y1 < 62 and len(b["lines"]) <= 2:
                continue
            # Filtro piè di pagina e numeri pagina (y0 >= height - 55)
            if y0 >= (height - 55) and len(b["lines"]) <= 2 and len(full_b_text) < 40:
                continue

            valid_blocks.append(b)

        if not valid_blocks:
            continue

        # Ordinamento geometrico colonne
        # Caso 3 colonne (indice analitico)
        col1_test = [b for b in valid_blocks if b["bbox"][2] <= 195]
        col2_test = [b for b in valid_blocks if b["bbox"][0] >= 190 and b["bbox"][2] <= 330]
        col3_test = [b for b in valid_blocks if b["bbox"][0] >= 325]

        if len(col1_test) >= 4 and len(col2_test) >= 4 and len(col3_test) >= 4:
            col1_test.sort(key=lambda b: b["bbox"][1])
            col2_test.sort(key=lambda b: b["bbox"][1])
            col3_test.sort(key=lambda b: b["bbox"][1])
            ordered_blocks = col1_test + col2_test + col3_test
        else:
            has_left = any(b["bbox"][0] < 200 and b["bbox"][2] < 265 for b in valid_blocks)
            has_right = any(b["bbox"][0] > 240 and b["bbox"][2] > 320 for b in valid_blocks)
            is_two_col = has_left and has_right

            if not is_two_col:
                valid_blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
                ordered_blocks = valid_blocks
            else:
                top_wide = []
                left_col = []
                right_col = []
                bottom_wide = []
                for b in valid_blocks:
                    bbox = b["bbox"]
                    x0, y0, x1, y1 = bbox[0], bbox[1], bbox[2], bbox[3]
                    if y0 < 250 and (x1 - x0 > 240 or (x0 < 180 and x1 > 280)):
                        top_wide.append(b)
                    elif x1 <= 265:
                        left_col.append(b)
                    elif x0 >= 240:
                        right_col.append(b)
                    else:
                        bottom_wide.append(b)

                top_wide.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
                left_col.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
                right_col.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
                bottom_wide.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
                ordered_blocks = top_wide + left_col + right_col + bottom_wide

        for b in ordered_blocks:
            b_lines = b["lines"]
            full_raw = "".join("".join(s["text"] for s in l["spans"]) for l in b_lines).strip()
            if not full_raw:
                continue

            first_span = b_lines[0]["spans"][0] if b_lines and b_lines[0].get("spans") else {"font": "", "size": 10}
            is_heading_candidate = (first_span["size"] >= 12.0 or "Bold" in first_span.get("font", "")) and len(full_raw) < 80 and not full_raw.endswith('.')

            if format_refs and re.match(r'^(REFERENCES|BIBLIOGRAFIA|Riferimenti bibliografici)\b', full_raw, re.I) and len(full_raw) < 30:
                if in_refs and curr_ref_lines:
                    rentry = " ".join(curr_ref_lines)
                    rentry_clean = re.sub(r'  +', ' ', rentry).strip()
                    if rentry_clean:
                        full_md_chunks.append(f"- {rentry_clean}\n")
                    curr_ref_lines = []
                in_refs = True
                in_case = False
                full_md_chunks.append(f"\n### {full_raw}\n\n")
                continue

            if in_refs:
                is_new_author = bool(re.match(r'^[A-Z][a-zA-Z\.\s\-\,]+,\s*(?:[A-Z]\.|\d{4})', full_raw)) or bool(re.match(r'^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+\(\d{4}\)', full_raw))
                if is_new_author or is_heading_candidate:
                    if curr_ref_lines:
                        rentry = " ".join(curr_ref_lines)
                        rentry_clean = re.sub(r'  +', ' ', rentry).strip()
                        if rentry_clean:
                            full_md_chunks.append(f"- {rentry_clean}\n")
                        curr_ref_lines = []
                    if is_heading_candidate:
                        in_refs = False
                        full_md_chunks.append(f"\n### {full_raw}\n\n")
                        continue

                curr_ref_lines.append(full_raw)
                continue

            if riquadri_citazione and (re.match(r'^(CASE EXAMPLE|CASO CLINICO|Vignetta clinica|ESEMPIO)\b', full_raw, re.I) or ("Case Example" in full_raw and len(full_raw) < 50)):
                in_case = True
                full_md_chunks.append(f"\n> ### {full_raw}\n>\n")
                continue

            # Processamento del blocco di testo con dehyphenation
            block_lines_text = []
            for l in b_lines:
                line_str = "".join(s["text"] for s in l["spans"])
                block_lines_text.append(line_str)

            # Dehyphenation tra righe consecutive del medesimo blocco
            merged_lines = []
            for i, line in enumerate(block_lines_text):
                line_stripped = line.rstrip()
                if not line_stripped:
                    continue
                if merged_lines:
                    prev = merged_lines[-1]
                    # Se finisce con soft-hyphen \xad o trattino a capo tra lettere
                    if prev.endswith('\xad') or (prev.endswith('-') and re.search(r'[a-zA-Z]\-$', prev)):
                        clean_prev = prev[:-1]
                        merged_lines[-1] = clean_prev + line_stripped.lstrip()
                        continue
                merged_lines.append(line_stripped)

            joined_text = " ".join(merged_lines)
            joined_text = re.sub(r'\s{2,}', ' ', joined_text).strip()

            if is_heading_candidate and len(joined_text) < 80:
                in_case = False  # un titolo chiude l'eventuale citazione aperta
                full_md_chunks.append(f"\n### {joined_text}\n\n")
            elif in_case:
                case_lines = [f"> {l}" for l in joined_text.split("\n")]
                full_md_chunks.append("\n" + "\n".join(case_lines) + "\n")
            else:
                full_md_chunks.append(f"\n\n{joined_text}")

    if in_refs and curr_ref_lines:
        rentry = " ".join(curr_ref_lines)
        rentry_clean = re.sub(r'  +', ' ', rentry).strip()
        if rentry_clean:
            full_md_chunks.append(f"- {rentry_clean}\n")

    result_md = "".join(full_md_chunks)
    # Pulizia newline ridondanti
    result_md = re.sub(r'\n{3,}', '\n\n', result_md).strip() + "\n"
    return result_md, total_pages


# ==============================================================================
# 2. Microsoft MarkItDown Engine
# ==============================================================================

def convert_with_markitdown(file_path):
    """
    Conversione generica per documenti DOCX, PPTX, XLSX, HTML, EPUB, CSV, ecc.
    """
    from markitdown import MarkItDown
    md = MarkItDown(enable_plugins=False)
    result = md.convert_local(file_path)
    return result.markdown


# ==============================================================================
# Dispatcher Principale
# ==============================================================================

def convert_file(file_path, options=None):
    if options is None:
        options = {}

    path = Path(file_path)
    if not path.exists():
        return {
            "success": False,
            "error": f"File non trovato: {file_path}",
            "file": file_path,
            "name": path.name,
        }

    ext = path.suffix.lower()
    if ext in AUDIO_EXTENSIONS:
        return {
            "success": False,
            "file": str(path),
            "name": path.name,
            "error": "I file audio non sono supportati: il programma converte solo documenti "
                     "(PDF, Word, Excel, PowerPoint, EPUB, HTML, CSV e testo).",
        }

    pdf_column_aware = options.get("pdf_column_aware", True)
    riquadri_citazione = options.get("riquadri_citazione", False)

    start_time = time.time()
    method_used = "markitdown"
    total_pages = 1

    try:
        if ext == ".pdf" and pdf_column_aware:
            method_used = "pdf-column-aware"
            markdown_content, total_pages = convert_pdf_column_aware(
                str(path), riquadri_citazione=riquadri_citazione
            )
        else:
            method_used = "markitdown"
            markdown_content = convert_with_markitdown(str(path))

        if not markdown_content or not markdown_content.strip():
            raise RuntimeError("Nessun testo estratto dal documento (potrebbe essere una scansione o un file vuoto).")

        elapsed = round(time.time() - start_time, 2)
        return {
            "success": True,
            "file": str(path),
            "name": path.name,
            "markdown": markdown_content,
            "method": method_used,
            "stats": {
                "pages": total_pages,
                "chars": len(markdown_content),
                "elapsed_sec": elapsed,
            }
        }
    except Exception as e:
        elapsed = round(time.time() - start_time, 2)
        return {
            "success": False,
            "file": str(path),
            "name": path.name,
            "error": str(e),
            "method": method_used,
            "stats": {
                "elapsed_sec": elapsed
            }
        }


def engine_status():
    """Versioni delle librerie incluse (utile per la diagnostica)."""
    import importlib.metadata as md
    info = {"app": APP_NAME}
    for pkg in ("markitdown", "pymupdf"):
        try:
            info[pkg] = md.version(pkg)
        except Exception:
            info[pkg] = None
    return info


def main():
    parser = argparse.ArgumentParser(description=f"{APP_NAME} - motore di conversione")
    parser.add_argument("--action", choices=["convert", "status"], default="convert")
    parser.add_argument("--file", help="Percorso del file da convertire")
    parser.add_argument("--pdf-column-aware", action="store_true", default=True)
    parser.add_argument("--no-pdf-column-aware", dest="pdf_column_aware", action="store_false")
    parser.add_argument("--riquadri-citazione", action="store_true", default=False,
                        help="Mette in citazione (>) i riquadri come casi clinici ed esempi")

    args = parser.parse_args()

    if args.action == "status":
        print(json.dumps(engine_status(), ensure_ascii=False))
        return

    if not args.file:
        print(json.dumps({"success": False, "error": "Parametro --file mancante"}))
        sys.exit(1)

    opts = {
        "pdf_column_aware": args.pdf_column_aware,
        "riquadri_citazione": args.riquadri_citazione,
    }
    res = convert_file(args.file, opts)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
