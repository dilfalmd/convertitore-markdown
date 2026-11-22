use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;

/// Repository GitHub da cui si leggono le release (formato `utente/repository`).
const REPO: &str = "dilfalmd/convertitore-markdown";

/// Nome del motore di conversione (sidecar compilato con PyInstaller).
const ENGINE_NAME: &str = "convertitore-engine";

#[derive(Debug, Serialize, Deserialize)]
pub struct ConversionStats {
    pub pages: Option<usize>,
    pub chars: Option<usize>,
    pub elapsed_sec: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConversionResult {
    pub success: bool,
    pub file: String,
    pub name: String,
    pub markdown: Option<String>,
    pub error: Option<String>,
    pub method: Option<String>,
    pub stats: Option<ConversionStats>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileToSave {
    pub name: String,
    pub markdown: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveSummary {
    pub total: usize,
    pub saved: usize,
    /// Nomi dei file che non è stato possibile scrivere.
    pub failed: Vec<String>,
    pub target_dir: String,
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    /// `true` se il controllo è andato a buon fine (anche quando non ci sono novità).
    pub ok: bool,
    pub update_available: bool,
    pub current: String,
    pub latest: Option<String>,
    pub message: String,
}

/// Crea un Command senza finestra console (su Windows l'app è una GUI e altrimenti ogni
/// avvio del motore farebbe lampeggiare una console).
fn new_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Estrae il JSON dall'output del motore. Prova l'output intero e, se fallisce
/// (log o avvisi finiti per sbaglio su stdout), l'ultima riga che inizia con `{`.
fn parse_engine_json<T: serde::de::DeserializeOwned>(stdout: &str) -> Option<T> {
    if let Ok(v) = serde_json::from_str::<T>(stdout.trim()) {
        return Some(v);
    }
    stdout
        .lines()
        .rev()
        .map(|l| l.trim())
        .filter(|l| l.starts_with('{'))
        .find_map(|l| serde_json::from_str::<T>(l).ok())
}

/// Percorso del motore di conversione: sta accanto all'eseguibile dell'app, sia in
/// `tauri dev` (cartella target) sia nei pacchetti installati.
fn engine_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Impossibile trovare l'eseguibile dell'app: {}", e))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "Cartella dell'eseguibile non valida.".to_string())?;
    let file_name = if cfg!(windows) {
        format!("{}.exe", ENGINE_NAME)
    } else {
        ENGINE_NAME.to_string()
    };
    let path = dir.join(file_name);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!(
            "Motore di conversione non trovato: {}",
            path.display()
        ))
    }
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn select_files() -> Vec<String> {
    let dialog = rfd::FileDialog::new()
        .set_title("Seleziona documenti da convertire")
        .add_filter(
            "Tutti i file supportati",
            &[
                "pdf", "docx", "pptx", "xlsx", "html", "htm", "epub", "csv", "txt",
            ],
        )
        .add_filter("Documenti PDF (*.pdf)", &["pdf"])
        .add_filter("Documenti Word (*.docx)", &["docx"])
        .add_filter("Presentazioni (*.pptx)", &["pptx"])
        .add_filter("Fogli Excel (*.xlsx)", &["xlsx"])
        .add_filter("E-Book EPUB (*.epub)", &["epub"])
        .add_filter("File Web (*.html, *.htm)", &["html", "htm"]);

    if let Some(paths) = dialog.pick_files() {
        paths
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    } else {
        Vec::new()
    }
}

#[tauri::command]
fn select_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Seleziona cartella di destinazione")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn convert_single_file(
    file_path: String,
    pdf_column_aware: bool,
    riquadri_citazione: bool,
) -> Result<ConversionResult, String> {
    // Il lavoro gira su un thread a parte: la finestra resta reattiva.
    tauri::async_runtime::spawn_blocking(move || {
        let engine = engine_path()?;

        let mut cmd = new_command(&engine);
        cmd.env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .arg("--action")
            .arg("convert")
            .arg("--file")
            .arg(&file_path);

        if pdf_column_aware {
            cmd.arg("--pdf-column-aware");
        } else {
            cmd.arg("--no-pdf-column-aware");
        }
        if riquadri_citazione {
            cmd.arg("--riquadri-citazione");
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Errore di avvio conversione: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(res) = parse_engine_json::<ConversionResult>(&stdout) {
            Ok(res)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Ok(ConversionResult {
                success: false,
                file: file_path.clone(),
                name: Path::new(&file_path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| file_path.clone()),
                markdown: None,
                error: Some(format!(
                    "Output non valido:\nSTDOUT: {}\nSTDERR: {}",
                    stdout, stderr
                )),
                method: None,
                stats: None,
            })
        }
    })
    .await
    .map_err(|e| format!("Errore interno: {}", e))?
}

#[tauri::command]
fn save_file_dialog(default_name: String, content: String) -> Result<Option<String>, String> {
    let target = rfd::FileDialog::new()
        .set_title("Salva file Markdown")
        .set_file_name(&default_name)
        .add_filter("Markdown (*.md)", &["md"])
        .save_file();

    if let Some(path) = target {
        fs::write(&path, content.as_bytes())
            .map_err(|e| format!("Impossibile scrivere il file {}: {}", path.display(), e))?;
        Ok(Some(path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn save_all_files(target_dir: String, files: Vec<FileToSave>) -> Result<SaveSummary, String> {
    let dir = Path::new(&target_dir);
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("Impossibile creare la cartella: {}", e))?;
    }

    let mut saved_count = 0;
    let mut failed: Vec<String> = Vec::new();
    // Nomi già usati in questo salvataggio (confronto senza maiuscole/minuscole, come nei
    // file system di Windows e macOS): i doppi diventano `nome-2.md`, `nome-3.md`...
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for item in &files {
        let base_name = Path::new(&item.name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "documento".to_string());
        let mut md_name = format!("{}.md", base_name);
        let mut n = 2;
        while !used.insert(md_name.to_lowercase()) {
            md_name = format!("{}-{}.md", base_name, n);
            n += 1;
        }
        let dest = dir.join(&md_name);
        if fs::write(&dest, item.markdown.as_bytes()).is_ok() {
            saved_count += 1;
        } else {
            failed.push(md_name);
        }
    }

    Ok(SaveSummary {
        total: files.len(),
        saved: saved_count,
        failed,
        target_dir,
    })
}

/// Apre una cartella nel file manager del sistema (Windows, macOS, Linux).
#[tauri::command]
fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("Impossibile aprire la cartella: {}", e))
}

/// Confronta due versioni nel formato `1.2.3` (con o senza `v` iniziale).
fn parse_version(s: &str) -> Vec<u64> {
    s.trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let mut a = parse_version(latest);
    let mut b = parse_version(current);
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a > b
}

fn fetch_latest_tag() -> Result<Option<String>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let url = format!("https://api.github.com/repos/{}/releases/latest", REPO);

    let mut response = match agent
        .get(&url)
        .header("User-Agent", "convertitore-markdown")
        .header("Accept", "application/vnd.github+json")
        .call()
    {
        Ok(r) => r,
        // Nessuna release pubblicata (o repository non raggiungibile): non è un errore di rete.
        Err(ureq::Error::StatusCode(404)) => return Ok(None),
        Err(ureq::Error::StatusCode(code)) => {
            return Err(format!("Il server ha risposto con il codice {}.", code))
        }
        Err(e) => return Err(e.to_string()),
    };

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

/// Controlla se su GitHub c'è una release più recente. Non fallisce mai: gli errori di rete
/// diventano un messaggio per l'utente.
#[tauri::command]
async fn check_for_updates() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = env!("CARGO_PKG_VERSION").to_string();
        match fetch_latest_tag() {
            Ok(Some(tag)) => {
                let newer = is_newer(&tag, &current);
                let message = if newer {
                    format!("È disponibile la versione {} (hai la {}).", tag, current)
                } else {
                    format!("Hai già l'ultima versione ({}).", current)
                };
                UpdateInfo {
                    ok: true,
                    update_available: newer,
                    current,
                    latest: Some(tag),
                    message,
                }
            }
            Ok(None) => UpdateInfo {
                ok: true,
                update_available: false,
                message: format!("Nessuna versione pubblicata trovata: hai la {}.", current),
                current,
                latest: None,
            },
            Err(_) => UpdateInfo {
                ok: false,
                update_available: false,
                message: "Non riesco a controllare gli aggiornamenti: verifica la connessione a Internet e riprova più tardi.".to_string(),
                current,
                latest: None,
            },
        }
    })
    .await
    .map_err(|e| format!("Errore interno: {}", e))
}

/// Apre nel browser la pagina dell'ultima release.
#[tauri::command]
fn open_release_page(app: tauri::AppHandle) -> Result<(), String> {
    let url = format!("https://github.com/{}/releases/latest", REPO);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Impossibile aprire il browser: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            select_files,
            select_folder,
            convert_single_file,
            save_file_dialog,
            save_all_files,
            open_folder,
            check_for_updates,
            open_release_page
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
