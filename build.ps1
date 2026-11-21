# build.ps1 - Compila Convertitore Markdown (motore Python + app Tauri) su Windows.
# Uso:  .\build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "=== Convertitore Markdown: compilazione ===" -ForegroundColor Cyan

# 1. Ambiente Python locale (.venv nella cartella del progetto)
if (-not (Test-Path ".venv")) {
    Write-Host "Creo l'ambiente virtuale .venv..." -ForegroundColor Yellow
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "Impossibile creare .venv (serve Python 3 nel PATH)." }
}
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "Installo le dipendenze del motore..." -ForegroundColor Yellow
& $py -m pip install -r engine/requirements.txt -r engine/requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw "Installazione delle dipendenze Python fallita." }

# 2. Motore compilato (sidecar) in src-tauri/binaries
Write-Host "Compilo il motore con PyInstaller..." -ForegroundColor Yellow
& $py engine/build_engine.py
if ($LASTEXITCODE -ne 0) { throw "Compilazione del motore fallita." }

# 3. App Tauri
if (-not (Test-Path "node_modules")) {
    Write-Host "Installo le dipendenze npm..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install fallito." }
}
Write-Host "Compilo l'app Tauri..." -ForegroundColor Yellow
npx tauri build
if ($LASTEXITCODE -ne 0) { throw "Compilazione di Tauri fallita." }

Write-Host "Completato. Installer in src-tauri\target\release\bundle\" -ForegroundColor Green
