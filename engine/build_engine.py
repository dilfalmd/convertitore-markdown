#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Compila engine/converter.py in un binario autonomo con PyInstaller (--onefile) e lo copia in
src-tauri/binaries/convertitore-engine-<target-triple>[.exe], il nome che Tauri si aspetta
per i "sidecar" (bundle.externalBin).

Uso (dalla radice del progetto, con le dipendenze gia' installate):
    python engine/build_engine.py

Non installa nulla: servono prima engine/requirements.txt e engine/requirements-dev.txt.
"""

import shutil
import subprocess
import sys
from pathlib import Path

ENGINE_NAME = "convertitore-engine"
ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
BUILD_DIR = ENGINE_DIR / "build"
BINARIES_DIR = ROOT / "src-tauri" / "binaries"

# Pacchetti con dati o moduli caricati dinamicamente che PyInstaller non trova da solo
COLLECT_ALL = [
    "magika",
    "markitdown",
    "pymupdf",
    "onnxruntime",
    "mammoth",
    "pptx",
    "openpyxl",
    "pdfminer",
    "pdfplumber",
]
EXCLUDE = ["tkinter", "matplotlib", "scipy", "IPython", "pytest", "notebook"]


def host_triple() -> str:
    """Il target triple dell'host, dalla riga `host:` di `rustc -vV`."""
    out = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("Impossibile ricavare il target triple da `rustc -vV`.")


def main() -> int:
    triple = host_triple()
    is_windows = "windows" in triple
    suffix = ".exe" if is_windows else ""
    print(f"Target: {triple}")

    dist = BUILD_DIR / "dist"
    work = BUILD_DIR / "work"
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile",
        "--name", ENGINE_NAME,
        "--distpath", str(dist),
        "--workpath", str(work),
        "--specpath", str(BUILD_DIR),
    ]
    for pkg in COLLECT_ALL:
        cmd += ["--collect-all", pkg]
    for mod in EXCLUDE:
        cmd += ["--exclude-module", mod]
    cmd.append(str(ENGINE_DIR / "converter.py"))

    print("Eseguo PyInstaller...")
    subprocess.run(cmd, check=True)

    built = dist / f"{ENGINE_NAME}{suffix}"
    if not built.exists():
        print(f"ERRORE: {built} non trovato dopo la compilazione.", file=sys.stderr)
        return 1

    BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    target = BINARIES_DIR / f"{ENGINE_NAME}-{triple}{suffix}"
    shutil.copy2(built, target)
    print(f"Motore copiato in {target} ({target.stat().st_size / 1_000_000:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
