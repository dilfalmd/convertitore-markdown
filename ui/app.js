// Convertitore Markdown - logica dell'interfaccia e comandi Tauri
(function () {
  // Utility per verificare se l'app gira dentro Tauri
  const isTauri = typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core;
  const invoke = isTauri ? window.__TAURI__.core.invoke : async (cmd, args) => {
    console.warn(`[Browser Mock] Invoked: ${cmd}`, args);
    return null;
  };

  // Stato dell'applicazione
  const state = {
    files: [], // Array di oggetti file: { path, name, ext, status, markdown, error, method, stats }
    selectedFilePath: null,
    isConverting: false
  };

  // Elementi DOM
  const elements = {
    btnSelectFiles: document.getElementById('btn-select-files'),
    btnConvertAll: document.getElementById('btn-convert-all'),
    btnSaveAll: document.getElementById('btn-save-all'),
    btnClearList: document.getElementById('btn-clear-list'),
    optColumnAware: document.getElementById('opt-column-aware'),
    optRiquadriCitazione: document.getElementById('opt-riquadri-citazione'),
    dropZone: document.getElementById('drop-zone'),
    fileList: document.getElementById('file-list'),
    filesCount: document.getElementById('files-count'),
    previewFilename: document.getElementById('preview-filename'),
    previewMethodBadge: document.getElementById('preview-method-badge'),
    btnCopyPreview: document.getElementById('btn-copy-preview'),
    btnSaveSingle: document.getElementById('btn-save-single'),
    tabRendered: document.getElementById('tab-rendered'),
    tabRaw: document.getElementById('tab-raw'),
    rawMarkdownEditor: document.getElementById('raw-markdown-editor'),
    progressBar: document.getElementById('progress-bar'),
    statusMessage: document.getElementById('status-message'),
    statusStats: document.getElementById('status-stats'),
    appVersion: document.getElementById('app-version'),
    btnCheckUpdates: document.getElementById('btn-check-updates'),
    tabButtons: document.querySelectorAll('.tab-btn')
  };

  // Inizializzazione
  async function init() {
    setupEventListeners();
    try {
      const version = await invoke('app_version');
      if (version) elements.appVersion.textContent = `v${version}`;
    } catch (err) {
      console.warn("Errore app_version:", err);
    }
    updateStatus("Pronto.");
  }

  // Controllo manuale degli aggiornamenti (nessun controllo automatico)
  async function handleCheckUpdates() {
    elements.btnCheckUpdates.disabled = true;
    updateStatus("Controllo aggiornamenti in corso...");
    try {
      const res = await invoke('check_for_updates');
      if (!res) {
        updateStatus("Controllo aggiornamenti non disponibile.");
        return;
      }
      updateStatus(res.message);
      if (res.update_available) {
        if (confirm(`${res.message}

Vuoi aprire la pagina di download nel browser?`)) {
          await invoke('open_release_page');
        }
      } else {
        alert(res.message);
      }
    } catch (err) {
      updateStatus("Impossibile controllare gli aggiornamenti.");
      alert("Impossibile controllare gli aggiornamenti. Riprova più tardi.");
    } finally {
      elements.btnCheckUpdates.disabled = false;
    }
  }

  // Event Listeners
  function setupEventListeners() {
    // Seleziona file da dialog nativo
    elements.btnSelectFiles.addEventListener('click', handleSelectFiles);

    // Converti tutto
    elements.btnConvertAll.addEventListener('click', handleConvertAll);

    // Salva tutti
    elements.btnSaveAll.addEventListener('click', handleSaveAll);

    // Pulisci lista
    elements.btnClearList.addEventListener('click', () => {
      state.files = [];
      state.selectedFilePath = null;
      renderFileList();
      renderPreview();
      updateButtonsState();
      updateProgress(0);
      updateStatus("Elenco svuotato.");
    });

    // Copia Markdown
    elements.btnCopyPreview.addEventListener('click', handleCopyPreview);

    // Salva singolo file
    elements.btnSaveSingle.addEventListener('click', handleSaveSingle);

    // Modifica del sorgente Markdown
    elements.rawMarkdownEditor.addEventListener('input', handleRawEdit);

    // Controlla aggiornamenti
    elements.btnCheckUpdates.addEventListener('click', handleCheckUpdates);

    // I link nell'anteprima non devono mai portare la finestra fuori dall'app:
    // si seguono solo i rimandi interni (#indice)
    elements.tabRendered.addEventListener('click', (e) => {
      const link = e.target.closest ? e.target.closest('a') : null;
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#') && href.length > 1) {
        let id = href.slice(1);
        try { id = decodeURIComponent(id); } catch (_) { /* resta com'e' */ }
        const target = elements.tabRendered.querySelector(`[id="${CSS.escape(id)}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    // Tab switcher (Anteprima renderizzata vs Markdown grezzo)
    elements.tabButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.getAttribute('data-tab');
        elements.tabButtons.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');

        if (tab === 'rendered') {
          elements.tabRendered.classList.add('active');
          elements.tabRaw.classList.remove('active');
        } else {
          elements.tabRendered.classList.remove('active');
          elements.tabRaw.classList.add('active');
        }
      });
    });

    // Click sul pulsante e sulla Drop Zone
    elements.dropZone.addEventListener('click', handleSelectFiles);

    // Drag & Drop HTML5 / Webview fallback
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.dropZone.classList.add('dragover');
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      elements.dropZone.classList.remove('dragover');
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.dropZone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const droppedPaths = [];
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const f = e.dataTransfer.files[i];
          if (f.path) {
            droppedPaths.push(f.path);
          }
        }
        if (droppedPaths.length > 0) {
          addFilePaths(droppedPaths);
        }
      }
    });

    // Ascolto eventi drag-drop nativi di Tauri v2
    setupTauriDragDrop();
  }

  function extractPaths(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.paths)) return payload.paths;
    if (payload.paths && Array.isArray(payload.paths)) return payload.paths;
    return [];
  }

  function setupTauriDragDrop() {
    if (typeof window === 'undefined' || !window.__TAURI__) return;

    // 1. Prova con WebviewWindow (Tauri v2 API)
    try {
      if (window.__TAURI__.webviewWindow && typeof window.__TAURI__.webviewWindow.getCurrentWebviewWindow === 'function') {
        const appWin = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
        if (appWin && typeof appWin.onDragDropEvent === 'function') {
          appWin.onDragDropEvent((evt) => {
            if (evt && evt.payload) {
              if (evt.payload.type === 'enter') {
                elements.dropZone.classList.add('dragover');
              } else if (evt.payload.type === 'leave') {
                elements.dropZone.classList.remove('dragover');
              } else if (evt.payload.type === 'drop') {
                elements.dropZone.classList.remove('dragover');
                const paths = extractPaths(evt.payload);
                if (paths.length > 0) {
                  addFilePaths(paths);
                }
              }
            }
          });
        }
      }
    } catch (e) {
      console.warn("Could not register onDragDropEvent:", e);
    }

    // 2. Prova con event.listen globale ('tauri://drag-drop')
    try {
      if (window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
        window.__TAURI__.event.listen('tauri://drag-enter', () => {
          elements.dropZone.classList.add('dragover');
        });
        window.__TAURI__.event.listen('tauri://drag-leave', () => {
          elements.dropZone.classList.remove('dragover');
        });
        window.__TAURI__.event.listen('tauri://drag-drop', (event) => {
          elements.dropZone.classList.remove('dragover');
          const paths = extractPaths(event ? event.payload : null);
          if (paths.length > 0) {
            addFilePaths(paths);
          }
        });
      }
    } catch (e) {
      console.warn("Could not register tauri://drag-drop listener:", e);
    }
  }

  // Gestione aggiunta file
  async function handleSelectFiles() {
    try {
      const selected = await invoke('select_files');
      if (selected && selected.length > 0) {
        addFilePaths(selected);
      }
    } catch (err) {
      console.error("Errore select_files:", err);
    }
  }

  function addFilePaths(paths) {
    let addedCount = 0;
    paths.forEach(p => {
      // Evita duplicati
      if (!state.files.some(f => f.path === p)) {
        const name = p.split(/[\\/]/).pop();
        const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        state.files.push({
          path: p,
          name: name,
          ext: ext,
          status: 'waiting', // 'waiting' | 'converting' | 'done' | 'error'
          markdown: '',
          error: '',
          method: '',
          stats: null
        });
        addedCount++;
      }
    });

    if (addedCount > 0) {
      if (!state.selectedFilePath && state.files.length > 0) {
        state.selectedFilePath = state.files[0].path;
      }
      renderFileList();
      renderPreview();
      updateButtonsState();
      updateStatus(`Aggiunti ${addedCount} documenti alla coda.`);
    }
  }

  // Render dell'elenco file
  function renderFileList() {
    elements.fileList.innerHTML = '';
    elements.filesCount.textContent = state.files.length;

    state.files.forEach(file => {
      const li = document.createElement('li');
      li.className = `file-item ${file.path === state.selectedFilePath ? 'active' : ''}`;
      li.addEventListener('click', () => {
        state.selectedFilePath = file.path;
        renderFileList();
        renderPreview();
      });

      // Icona estensione
      const iconClass = ['pdf', 'docx', 'xlsx', 'pptx', 'epub'].includes(file.ext) ? file.ext : 'other';
      const iconText = escapeHtml(file.ext ? file.ext.slice(0, 4) : 'FILE');

      // Badge stato
      let statusClass = 'status-waiting';
      let statusLabel = 'In attesa';
      if (file.status === 'converting') {
        statusClass = 'status-converting';
        statusLabel = 'Conversione...';
      } else if (file.status === 'done') {
        statusClass = 'status-done';
        statusLabel = 'Completato';
      } else if (file.status === 'error') {
        statusClass = 'status-error';
        statusLabel = 'Errore';
      }

      li.innerHTML = `
        <div class="file-item-left">
          <div class="file-item-icon ${iconClass}">${iconText}</div>
          <div class="file-item-details">
            <span class="file-item-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
            <span class="file-item-status-text">${escapeHtml(file.method ? methodLabel(file.method) : file.ext.toUpperCase())}</span>
          </div>
        </div>
        <div class="file-item-right">
          <span class="status-indicator ${statusClass}">${statusLabel}</span>
          <button class="btn-remove-item" title="Rimuovi">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `;

      // Evento rimozione singolo
      const removeBtn = li.querySelector('.btn-remove-item');
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFile(file.path);
      });

      elements.fileList.appendChild(li);
    });
  }

  function removeFile(path) {
    state.files = state.files.filter(f => f.path !== path);
    if (state.selectedFilePath === path) {
      state.selectedFilePath = state.files.length > 0 ? state.files[0].path : null;
    }
    renderFileList();
    renderPreview();
    updateButtonsState();
  }

  // Render Anteprima
  function renderPreview() {
    const file = state.files.find(f => f.path === state.selectedFilePath);

    if (!file) {
      elements.previewFilename.textContent = "Nessun file selezionato";
      elements.previewMethodBadge.style.display = "none";
      elements.tabRendered.innerHTML = '<div class="empty-state"><p>Seleziona un documento dall\'elenco per visualizzare l\'anteprima.</p></div>';
      elements.rawMarkdownEditor.value = '';
      elements.btnCopyPreview.disabled = true;
      elements.btnSaveSingle.disabled = true;
      return;
    }

    elements.previewFilename.textContent = file.name;
    elements.previewFilename.title = file.path;

    if (file.method) {
      elements.previewMethodBadge.style.display = "inline-flex";
      elements.previewMethodBadge.textContent = methodLabel(file.method);
    } else {
      elements.previewMethodBadge.style.display = "none";
    }

    // Il sorgente si può modificare solo quando la conversione è riuscita
    elements.rawMarkdownEditor.readOnly = file.status !== 'done';

    if (file.status === 'done') {
      renderMarkdownPreview(file.markdown);
      elements.rawMarkdownEditor.value = file.markdown;
      elements.btnCopyPreview.disabled = false;
      elements.btnSaveSingle.disabled = false;
    } else if (file.status === 'error') {
      elements.tabRendered.innerHTML = `
        <div class="empty-state" style="color: #f87171;">
          <div>
            <h3>Errore durante la conversione</h3>
            <p style="margin-top: 8px; font-family: monospace;">${escapeHtml(file.error || 'Errore sconosciuto')}</p>
          </div>
        </div>
      `;
      elements.rawMarkdownEditor.value = `ERRORE:\n${file.error || ''}`;
      elements.btnCopyPreview.disabled = true;
      elements.btnSaveSingle.disabled = true;
    } else if (file.status === 'converting') {
      elements.tabRendered.innerHTML = '<div class="empty-state"><p>Conversione in corso...</p></div>';
      elements.rawMarkdownEditor.value = 'Conversione in corso...';
      elements.btnCopyPreview.disabled = true;
      elements.btnSaveSingle.disabled = true;
    } else {
      elements.tabRendered.innerHTML = '<div class="empty-state"><p>File in attesa. Clicca su <strong>"Converti Tutto"</strong> per avviare l\'elaborazione.</p></div>';
      elements.rawMarkdownEditor.value = 'In attesa di conversione...';
      elements.btnCopyPreview.disabled = true;
      elements.btnSaveSingle.disabled = true;
    }
  }

  // Anteprima renderizzata: l'HTML prodotto da marked passa sempre da DOMPurify
  function renderMarkdownPreview(markdown) {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      elements.tabRendered.innerHTML = DOMPurify.sanitize(marked.parse(markdown || ''));
    } else {
      elements.tabRendered.innerHTML = `<pre>${escapeHtml(markdown || '')}</pre>`;
    }
  }

  // Modifica del sorgente: aggiorna il testo del file selezionato e l'anteprima
  function handleRawEdit() {
    const file = state.files.find(f => f.path === state.selectedFilePath);
    if (!file || file.status !== 'done') return;
    file.markdown = elements.rawMarkdownEditor.value;
    renderMarkdownPreview(file.markdown);
    elements.btnCopyPreview.disabled = !file.markdown;
    elements.btnSaveSingle.disabled = !file.markdown;
  }

  // Conversione
  async function handleConvertAll() {
    if (state.isConverting) return;

    const toConvert = state.files.filter(f => f.status === 'waiting' || f.status === 'error');
    if (toConvert.length === 0) {
      updateStatus("Nessun documento in attesa di conversione.");
      return;
    }

    state.isConverting = true;
    updateButtonsState();

    const columnAware = elements.optColumnAware.checked;
    const riquadriCitazione = elements.optRiquadriCitazione.checked;

    let completed = 0;
    const total = toConvert.length;
    updateProgress(0);

    for (const file of toConvert) {
      file.status = 'converting';
      renderFileList();
      if (file.path === state.selectedFilePath) renderPreview();

      updateStatus(`Conversione in corso: ${file.name} (${completed + 1}/${total})...`);

      try {
        const res = await invoke('convert_single_file', {
          filePath: file.path,
          pdfColumnAware: columnAware,
          riquadriCitazione: riquadriCitazione
        });

        if (res && res.success) {
          file.status = 'done';
          file.markdown = res.markdown || '';
          file.method = res.method || '';
          file.stats = res.stats || {};
        } else {
          file.status = 'error';
          file.error = (res && res.error) ? res.error : 'Errore sconosciuto';
        }
      } catch (err) {
        file.status = 'error';
        file.error = String(err);
      }

      completed++;
      updateProgress((completed / total) * 100);
      renderFileList();
      if (file.path === state.selectedFilePath) renderPreview();
    }

    state.isConverting = false;
    updateButtonsState();
    updateStatus(`Conversione completata: ${completed} documenti elaborati.`);
  }

  // Salva singolo file
  async function handleSaveSingle() {
    const file = state.files.find(f => f.path === state.selectedFilePath);
    if (!file || !file.markdown) return;

    const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
    const defaultName = `${baseName}.md`;

    try {
      const savedPath = await invoke('save_file_dialog', {
        defaultName: defaultName,
        content: file.markdown
      });

      if (savedPath) {
        updateStatus(`File salvato con successo: ${savedPath}`);
      }
    } catch (err) {
      alert(`Errore nel salvataggio: ${err}`);
    }
  }

  // Salva tutti i file completati
  async function handleSaveAll() {
    const doneFiles = state.files.filter(f => f.status === 'done' && f.markdown);
    if (doneFiles.length === 0) {
      alert("Nessun documento convertito da salvare.");
      return;
    }

    try {
      const targetDir = await invoke('select_folder');
      if (!targetDir) return;

      const payloadFiles = doneFiles.map(f => ({
        name: f.name,
        markdown: f.markdown
      }));

      const summary = await invoke('save_all_files', {
        targetDir: targetDir,
        files: payloadFiles
      });

      if (summary) {
        let msg = `Salvati ${summary.saved} file su ${summary.total} nella cartella:\n${summary.target_dir}`;
        const failed = summary.failed || [];
        if (failed.length > 0) {
          alert(`Attenzione: ${failed.length} file non sono stati salvati:\n${failed.join('\n')}`);
        }
        msg += '\n\nVuoi aprire la cartella?';
        if (confirm(msg)) {
          await invoke('open_folder', { path: summary.target_dir });
        }
        updateStatus(`Salvataggio completato: ${summary.saved} file salvati.`);
      }
    } catch (err) {
      alert(`Errore salvataggio multiplo: ${err}`);
    }
  }

  // Copia negli appunti
  function handleCopyPreview() {
    const file = state.files.find(f => f.path === state.selectedFilePath);
    if (!file || !file.markdown) return;

    navigator.clipboard.writeText(file.markdown).then(() => {
      const originalText = elements.btnCopyPreview.textContent;
      elements.btnCopyPreview.textContent = "Copiato! ✓";
      setTimeout(() => {
        elements.btnCopyPreview.textContent = originalText;
      }, 1500);
      updateStatus("Testo Markdown copiato negli appunti.");
    }).catch(err => {
      console.error("Errore copia appunti:", err);
    });
  }

  // Aggiornamento stato pulsanti
  function updateButtonsState() {
    const hasWaiting = state.files.some(f => f.status === 'waiting' || f.status === 'error');
    const hasDone = state.files.some(f => f.status === 'done');

    elements.btnConvertAll.disabled = state.isConverting || !hasWaiting;
    elements.btnSaveAll.disabled = state.isConverting || !hasDone;
    elements.btnSelectFiles.disabled = state.isConverting;
    elements.btnClearList.disabled = state.isConverting || state.files.length === 0;
  }

  function updateProgress(percent) {
    elements.progressBar.style.width = `${Math.min(Math.max(percent, 0), 100)}%`;
  }

  function updateStatus(msg) {
    elements.statusMessage.textContent = msg;
  }

  function methodLabel(method) {
    return method === 'pdf-column-aware' ? 'PDF a colonne' : 'MarkItDown';
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Avvio al caricamento del DOM
  document.addEventListener('DOMContentLoaded', init);
})();
