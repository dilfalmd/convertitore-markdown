#!/usr/bin/env bash
# build.sh - Compila Convertitore Markdown (motore Python + app Tauri) su macOS e Linux.
# Uso:  ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Convertitore Markdown: compilazione ==="

# 1. Ambiente Python locale (.venv nella cartella del progetto)
if [ ! -d ".venv" ]; then
    echo "Creo l'ambiente virtuale .venv..."
    python3 -m venv .venv
fi
PY=".venv/bin/python"

echo "Installo le dipendenze del motore..."
"$PY" -m pip install -r engine/requirements.txt -r engine/requirements-dev.txt

# 2. Motore compilato (sidecar) in src-tauri/binaries
echo "Compilo il motore con PyInstaller..."
"$PY" engine/build_engine.py

# 3. App Tauri
if [ ! -d "node_modules" ]; then
    echo "Installo le dipendenze npm..."
    npm install
fi
echo "Compilo l'app Tauri..."
npx tauri build

echo "Completato. Installer in src-tauri/target/release/bundle/"
