/**
 * Sussurro - Electron Main Process (CommonJS)
 * 
 * Gerencia ciclo de vida do aplicativo de desktop, criação da janela principal,
 * permissões de hardware (microfone, webcam e câmeras virtuais como OBS),
 * comunicação IPC e Atalhos Globais de Sistema (Push to Talk e Mudo em segundo plano).
 */

const { app, BrowserWindow, ipcMain, shell, session, desktopCapturer, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Estado de ciclo de vida e bandeja do sistema
let isQuitting = false;
let minimizeToTray = true; // Ativado por padrão (pode ser alternado na aba Geral das Configurações)
let tray = null;


// Suporte a Atualização Automática via GitHub Releases (electron-updater)
let autoUpdater = null;
let autoUpdaterLoadError = null;
try {
  const updaterModule = require('electron-updater');
  autoUpdater = updaterModule.autoUpdater;
} catch (e) {
  autoUpdaterLoadError = e.message;
  console.warn('[AutoUpdater] electron-updater não carregado:', e.message);
}

// Registro das atualizações em arquivo (pasta do app: %APPDATA%/<app>/updater.log) para diagnóstico
function getUpdaterLogPath() {
  try { return require('path').join(require('electron').app.getPath('userData'), 'updater.log'); } catch (e) { return null; }
}
function updaterLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ` + args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }).join(' ') + '\n';
  try {
    const fsMod = require('fs');
    const p = getUpdaterLogPath();
    if (p) {
      // Mantém o arquivo pequeno (máx. ~512 KB)
      try { if (fsMod.statSync(p).size > 512 * 1024) fsMod.writeFileSync(p, ''); } catch (e) {}
      fsMod.appendFileSync(p, line);
    }
  } catch (e) {}
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line.trim());
}
const updaterFileLogger = {
  info: (...a) => updaterLog('info', ...a),
  warn: (...a) => updaterLog('warn', ...a),
  error: (...a) => updaterLog('error', ...a),
  debug: () => {}
};

// Otimizações para funcionamento em segundo plano (evita travamentos ao minimizar ou dar Alt+Tab)
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Garante que o áudio de outros jogadores toque sempre sem bloqueio de Autoplay
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Aceleração de Hardware por GPU estável e proteção para computadores fracos
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-hardware-overlays');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '80');

// Suporte a atalhos globais de teclado e mouse via uiohook-napi (64-bit nativo, sem WinKeyServer.exe)
let uIOhook = null;
let UiohookKey = null;
let uIOhookStarted = false;
try {
  const uioModule = require('uiohook-napi');
  uIOhook = uioModule.uIOhook;
  UiohookKey = uioModule.UiohookKey;
} catch (err) {
  console.warn('[uIOhook] uiohook-napi não pôde ser carregado no ambiente atual:', err.message);
}

let mainWindow = null;

function createWindow() {
  // Define o preload correto (.cjs ou .js)
  const preloadPath = fs.existsSync(path.join(__dirname, 'preload.cjs'))
    ? path.join(__dirname, 'preload.cjs')
    : path.join(__dirname, 'preload.js');

  const iconPath = fs.existsSync(path.join(__dirname, 'icon.ico'))
    ? path.join(__dirname, 'icon.ico')
    : undefined;

  mainWindow = new BrowserWindow({
    title: 'Sussurro - RPG Voice & Video',
    icon: iconPath,
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 580,
    backgroundColor: '#1e1f22', // Discord Dark
    frame: false, // Permite barra de título customizada estilo Discord
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: false,
      backgroundThrottling: false // CRÍTICO: Não congela timers, áudio ou WebRTC ao minimizar/Alt+Tab
    }
  });

  // Configura permissões de microfone e câmera automaticamente no Electron
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'camera' || permission === 'microphone') {
      return true;
    }
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'camera', 'microphone', 'display-capture'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Suporte oficial do Electron (Electron 17+) para getDisplayMedia com suporte completo a janelas e telas
  if (typeof session.defaultSession.setDisplayMediaRequestHandler === 'function') {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        let chosen = null;
        if (currentSelectedSourceId) {
          chosen = sources.find(s => s.id === currentSelectedSourceId);
        }
        if (!chosen) {
          chosen = sources.find(s => s.id.startsWith('screen:')) || sources[0];
        }
        if (chosen) {
          const isScreen = chosen.id.startsWith('screen:');
          const result = { video: chosen };
          if (request.audioRequested) {
            // Áudio do sistema (loopback) também para janelas: o Windows não isola o som por aplicativo
            result.audio = 'loopback';
          }
          callback(result);
        } else {
          callback({});
        }
      }).catch((err) => {
        console.warn('[ScreenCapture] Erro em setDisplayMediaRequestHandler:', err);
        callback({});
      });
    });
  }

  // Determina se deve carregar servidor local (dev) ou o arquivo index.html direto
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((err) => {
      console.error('Falha ao carregar index.html empacotado:', err);
    });
  } else {
    const targetUrl = process.env.ELECTRON_START_URL;
    if (targetUrl) {
      mainWindow.loadURL(targetUrl).catch(() => {
        mainWindow.loadFile(path.join(__dirname, 'index.html'));
      });
    } else {
      const http = require('http');
      // Tenta primeiro conectar ao servidor em localhost:3000 se estiver ativo em desenvolvimento
      const req = http.get('http://localhost:3000', (res) => {
        mainWindow.loadURL('http://localhost:3000').catch(() => {
          mainWindow.loadFile(path.join(__dirname, 'index.html'));
        });
      });

      req.on('error', () => {
        mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((err) => {
          console.error('Falha ao carregar index.html local:', err);
        });
      });

      req.setTimeout(400, () => {
        req.abort();
        mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((err) => {
          console.error('Falha ao carregar index.html local:', err);
        });
      });
    }
  }

  // Abre links externos no navegador padrão do sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Atalho F12 ou Ctrl+Shift+I para abrir o console de inspeção
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(iconPath) {
  if (tray) return;
  try {
    let trayIcon = null;
    if (iconPath && fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
    } else {
      trayIcon = nativeImage.createEmpty();
    }
    tray = new Tray(trayIcon);
    tray.setToolTip('Sussurro RPG');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Abrir Sussurro RPG',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Silenciar Microfone',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('global-hotkey-action', 'toggle-mute');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Sair do Sussurro RPG',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn('[Tray] Erro ao criar ícone na bandeja:', err);
  }
}

// Inicialização da aplicação
app.whenReady().then(() => {
  const iconPath = fs.existsSync(path.join(__dirname, 'icon.ico'))
    ? path.join(__dirname, 'icon.ico')
    : undefined;

  createWindow();
  createTray(iconPath);

  if (uIOhook) {
    try {
      uIOhook.on('keydown', handleGlobalKeyDown);
      uIOhook.on('keyup', handleGlobalKeyUp);
      uIOhook.on('mousedown', handleGlobalMouseDown);
      uIOhook.on('mouseup', handleGlobalMouseUp);
      uIOhook.start();
      uIOhookStarted = true;
      console.log('[uIOhook] Hook global de teclado e mouse inicializado com sucesso.');
    } catch (err) {
      uIOhookStarted = false;
      console.warn('[uIOhook] Falha ao inicializar uIOhook:', err);
    }
  }

  // Verificação e Notificação de Atualizações via GitHub Releases
  function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }

  // Na Microsoft Store (process.windowsStore), as atualizações são gerenciadas pela própria Loja
  if (app.isPackaged && autoUpdater && !process.windowsStore) {
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.disableDifferentialDownload = true; // Força download completo para evitar erro de blockmap/range no GitHub
      autoUpdater.disableWebInstaller = true;
      autoUpdater.logger = updaterFileLogger;
      updaterLog('info', `App v${app.getVersion()} iniciado; verificando atualizações.`);

      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'Hardiscore',
        repo: 'Sussuro'
      });

      autoUpdater.on('checking-for-update', () => {
        console.log('[AutoUpdater] Verificando atualizações no GitHub...');
        sendToRenderer('app-update-checking');
      });

      autoUpdater.on('update-available', (info) => {
        console.log('[AutoUpdater] Nova versão encontrada:', info.version);
        sendToRenderer('app-update-available', info);
      });

      autoUpdater.on('download-progress', (progressObj) => {
        console.log(`[AutoUpdater] Progresso do download: ${Math.round(progressObj.percent)}%`);
        sendToRenderer('app-update-progress', progressObj);
      });

      autoUpdater.on('update-not-available', (info) => {
        console.log('[AutoUpdater] O aplicativo já está na versão mais recente.');
        sendToRenderer('app-update-not-available', info);
      });

      autoUpdater.on('update-downloaded', (info) => {
        console.log('[AutoUpdater] Atualização baixada com sucesso:', info.version);
        sendToRenderer('app-update-downloaded', info);
      });

      autoUpdater.on('error', (err) => {
        updaterLog('error', 'Erro no autoUpdater:', err);
        sendToRenderer('app-update-error', { message: err.message, logPath: getUpdaterLogPath() });
      });

      // Aguarda o HTML carregar antes de checar atualizações para não perder eventos IPC
      if (mainWindow) {
        mainWindow.webContents.once('did-finish-load', () => {
          setTimeout(() => {
            autoUpdater.checkForUpdatesAndNotify().catch((err) => {
              updaterLog('error', 'Falha em checkForUpdatesAndNotify:', err);
            });
          }, 1500);
        });
      }
    } catch (updateErr) {
      console.warn('[AutoUpdater] Erro ao buscar atualizações:', updateErr);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (!minimizeToTray || isQuitting) {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
});


// Ação para obter versão atual e status do app
ipcMain.handle('get-app-version', () => {
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    isWindowsStore: !!process.windowsStore,
    platform: process.platform,
    arch: process.arch
  };
});

// Ação manual: Procurar Update
ipcMain.on('check-for-updates-manual', async () => {
  console.log('[AutoUpdater] Checagem manual solicitada pelo usuário...');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-update-checking');
  }

  if (process.windowsStore) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update-not-available', {
          version: app.getVersion(),
          isWindowsStore: true,
          reason: 'windows-store'
        });
      }
    }, 300);
    return;
  }

  if (autoUpdater && app.isPackaged) {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-update-not-available', { version: app.getVersion() });
        }
      }
    } catch (err) {
      updaterLog('error', 'Erro na checagem manual:', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update-error', { message: err.message, logPath: getUpdaterLogPath() });
      }
    }
  } else {
    if (app.isPackaged) updaterLog('error', 'Atualizador indisponível:', autoUpdaterLoadError || 'desconhecido');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update-not-available', {
          version: app.getVersion(),
          isDev: !app.isPackaged,
          reason: app.isPackaged ? 'updater-missing' : 'dev',
          error: autoUpdaterLoadError
        });
      }
    }, 800);
  }
});

// Ação para reiniciar e aplicar a nova versão baixada
ipcMain.on('open-updater-log', () => {
  const p = getUpdaterLogPath();
  if (!p) return;
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    shell.showItemInFolder(p);
  } catch (e) {}
});

ipcMain.on('restart-and-install-update', () => {
  if (autoUpdater) {
    console.log('[AutoUpdater] Executando quitAndInstall(true, true) modo silencioso...');
    // isSilent: true (não exibe janela feia/quadrada do Windows, atualiza silenciosamente)
    // isForceRunAfter: true (reabre o app automaticamente logo após atualizar)
    autoUpdater.quitAndInstall(true, true);
  }
});

// ==========================================
// Handlers IPC para Controle de Janela
// ==========================================
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on('open-external', (event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

// Suporte para capturar janelas/telas no Electron
let currentSelectedSourceId = null;

// ============================================================================
// ÁUDIO POR APLICATIVO (Windows 10 2004+): captura só o som da janela compartilhada
// Usa o módulo nativo "loopback-capture" (WASAPI process loopback). Se não estiver disponível,
// o renderer cai automaticamente para o áudio do sistema inteiro.
// ============================================================================
let appAudioCapture = null;

function getWindowPidFromSourceId(sourceId) {
  return new Promise((resolve) => {
    const match = /^window:(\d+):/.exec(String(sourceId || ''));
    if (!match || process.platform !== 'win32') return resolve(null);
    const hwnd = match[1];
    const { execFile } = require('child_process');
    const script = `(Get-Process | Where-Object { [int64]$_.MainWindowHandle -eq ${hwnd} } | Select-Object -First 1).Id`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      const pid = parseInt(String(stdout || '').trim(), 10);
      resolve(!err && pid > 0 ? pid : null);
    });
  });
}

function stopAppAudioCapture() {
  if (appAudioCapture) {
    try { appAudioCapture.stop(); } catch (e) {}
    appAudioCapture = null;
  }
}

ipcMain.handle('app-audio-start', async (event, sourceId) => {
  stopAppAudioCapture();
  if (process.platform !== 'win32') return { ok: false, reason: 'platform' };
  let loopback;
  try {
    loopback = require('loopback-capture');
  } catch (err) {
    console.warn('[AppAudio] loopback-capture não carregou:', err.message);
    return { ok: false, reason: 'module' };
  }
  const pid = await getWindowPidFromSourceId(sourceId);
  if (!pid) return { ok: false, reason: 'pid' };
  try {
    const Cap = (loopback.default && loopback.default.LoopbackCapture) || loopback.LoopbackCapture;
    appAudioCapture = new Cap();
    const target = event.sender;
    appAudioCapture.start(pid, true, (chunk) => {
      if (!target.isDestroyed()) target.send('app-audio-chunk', chunk);
    });
    console.log('[AppAudio] Capturando áudio do processo', pid);
    return { ok: true, pid };
  } catch (err) {
    console.warn('[AppAudio] Falha ao iniciar captura por aplicativo:', err);
    stopAppAudioCapture();
    return { ok: false, reason: 'start' };
  }
});

ipcMain.on('app-audio-stop', () => stopAppAudioCapture());
app.on('will-quit', () => stopAppAudioCapture());


ipcMain.on('set-selected-source-id', (event, sourceId) => {
  currentSelectedSourceId = sourceId;
});

ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: true
    });
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon ? source.appIcon.toDataURL() : null
    }));
  } catch (err) {
    console.error('Erro ao obter fontes de captura:', err);
    return [];
  }
});

// ============================================================================
// CONFIGURAÇÕES GERAIS DE DESKTOP (Bandeja do Sistema e Inicialização com Windows)
// ============================================================================
ipcMain.handle('get-desktop-settings', () => {
  let openAtLogin = false;
  try {
    const loginItem = app.getLoginItemSettings();
    openAtLogin = !!loginItem.openAtLogin;
  } catch (e) {}
  return {
    minimizeToTray,
    openAtLogin
  };
});

// Aviso de mensagens não lidas do Chat Geral no ícone da barra de tarefas
ipcMain.on('set-unread-badge', (_event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const count = (payload && payload.count) || 0;
  try {
    if (count > 0 && payload.image) {
      const img = nativeImage.createFromDataURL(payload.image);
      if (process.platform === 'win32') mainWindow.setOverlayIcon(img, `${count} mensagem(ns) nova(s)`);
      if (typeof app.setBadgeCount === 'function' && process.platform !== 'win32') app.setBadgeCount(count);
      if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
    } else {
      if (process.platform === 'win32') mainWindow.setOverlayIcon(null, '');
      if (typeof app.setBadgeCount === 'function' && process.platform !== 'win32') app.setBadgeCount(0);
      mainWindow.flashFrame(false);
    }
  } catch (e) {
    console.warn('[Badge] Falha ao atualizar aviso no ícone:', e);
  }
});

ipcMain.on('set-minimize-to-tray', (_event, enabled) => {
  minimizeToTray = !!enabled;
  console.log('[Desktop] Minimizar para a bandeja configurado como:', minimizeToTray);
});

ipcMain.on('set-open-at-login', (_event, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath
    });
    console.log('[Desktop] Iniciar com o Windows configurado como:', enabled);
  } catch (e) {
    console.warn('[LoginSettings] Erro ao configurar login item:', e);
  }
});

// Escaneamento de imagens em pastas locais no Electron (file:// protocol)
ipcMain.handle('get-custom-assets', () => {
  try {
    const validImgRegex = /\.(png|jpe?g|webp|svg)$/i;
    const bgDir = path.join(__dirname, 'public', 'backgrounds');
    const accDir = path.join(__dirname, 'public', 'accessories');

    let backgrounds = [];
    let accessories = [];

    if (fs.existsSync(bgDir)) {
      backgrounds = fs.readdirSync(bgDir).filter(f => validImgRegex.test(f)).map(file => ({
        id: file.replace(/\.[^/.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
        name: file.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
        fileName: file,
        url: 'public/backgrounds/' + file
      }));
    }

    if (fs.existsSync(accDir)) {
      accessories = fs.readdirSync(accDir).filter(f => validImgRegex.test(f)).map(file => {
        const lower = file.toLowerCase();
        let anchor = "head";
        if (/oculos|tapa_olho|olho|eye|glasses/i.test(lower)) anchor = "eyes";
        else if (/mascara|barba|bigode|boca|queixo|mouth|beard|mask/i.test(lower)) anchor = "mouth";
        else if (/peito|colar|armadura|ombro|chest/i.test(lower)) anchor = "chest";
        else if (/dragao|mascote|asa|lateral|side|pet|wing/i.test(lower)) anchor = "side";
        return {
          id: file.replace(/\.[^/.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
          name: file.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
          fileName: file,
          defaultAnchor: anchor,
          url: 'public/accessories/' + file
        };
      });
    }

    return { success: true, backgrounds, accessories };
  } catch (err) {
    console.warn('[Assets] Erro ao escanear pastas locais no Electron:', err);
    return { success: false, backgrounds: [], accessories: [] };
  }
});

// ============================================================================
// ATALHOS GLOBAIS DE SISTEMA (Push-to-Talk e Mudo em Segundo Plano no PC)
// ============================================================================
let currentRegisteredHotkey = null;
let pttReleaseTimer = null;
let isPttActive = false;

function convertToAccelerator(key) {
  if (!key || typeof key !== 'string') return null;
  const clean = key.trim().toLowerCase();

  const keyMap = {
    ' ': 'Space',
    'space': 'Space',
    'enter': 'Return',
    'return': 'Return',
    'escape': 'Escape',
    'esc': 'Escape',
    'tab': 'Tab',
    'backspace': 'Backspace',
    'capslock': 'Capslock',
    'control': 'CommandOrControl',
    'ctrl': 'CommandOrControl',
    'alt': 'Alt',
    'shift': 'Shift',
    'arrowup': 'Up',
    'arrowdown': 'Down',
    'arrowleft': 'Left',
    'arrowright': 'Right',
    'up': 'Up',
    'down': 'Down',
    'left': 'Left',
    'right': 'Right',
    'home': 'Home',
    'end': 'End',
    'pageup': 'PageUp',
    'pagedown': 'PageDown',
    'insert': 'Insert',
    'delete': 'Delete',
    // Numpad mappings
    'numpad0': 'Num0', 'num0': 'Num0', 'numpad(0)': 'Num0', 'num(0)': 'Num0', 'numpadpad0': 'Num0',
    'numpad1': 'Num1', 'num1': 'Num1', 'numpad(1)': 'Num1', 'num(1)': 'Num1', 'numpadpad1': 'Num1',
    'numpad2': 'Num2', 'num2': 'Num2', 'numpad(2)': 'Num2', 'num(2)': 'Num2', 'numpadpad2': 'Num2',
    'numpad3': 'Num3', 'num3': 'Num3', 'numpad(3)': 'Num3', 'num(3)': 'Num3', 'numpadpad3': 'Num3',
    'numpad4': 'Num4', 'num4': 'Num4', 'numpad(4)': 'Num4', 'num(4)': 'Num4', 'numpadpad4': 'Num4',
    'numpad5': 'Num5', 'num5': 'Num5', 'numpad(5)': 'Num5', 'num(5)': 'Num5', 'numpadpad5': 'Num5',
    'numpad6': 'Num6', 'num6': 'Num6', 'numpad(6)': 'Num6', 'num(6)': 'Num6', 'numpadpad6': 'Num6',
    'numpad7': 'Num7', 'num7': 'Num7', 'numpad(7)': 'Num7', 'num(7)': 'Num7', 'numpadpad7': 'Num7',
    'numpad8': 'Num8', 'num8': 'Num8', 'numpad(8)': 'Num8', 'num(8)': 'Num8', 'numpadpad8': 'Num8',
    'numpad9': 'Num9', 'num9': 'Num9', 'numpad(9)': 'Num9', 'num(9)': 'Num9', 'numpadpad9': 'Num9',
    'decimal': 'Decimal', 'numpaddecimal': 'Decimal', 'numdec': 'Decimal', 'numpad.': 'Decimal', 'numpaddecimalpoint': 'Decimal',
    'add': 'Add', 'numpadadd': 'Add', 'numadd': 'Add', '+': 'Add', 'numpad+': 'Add', 'numpadplus': 'Add',
    'subtract': 'Subtract', 'numpadsubtract': 'Subtract', 'numsub': 'Subtract', '-': 'Subtract', 'numpad-': 'Subtract', 'numpadminus': 'Subtract',
    'multiply': 'Multiply', 'numpadmultiply': 'Multiply', 'nummult': 'Multiply', '*': 'Multiply', 'numpad*': 'Multiply', 'numpadmultiply': 'Multiply',
    'divide': 'Divide', 'numpaddivide': 'Divide', 'numdiv': 'Divide', '/': 'Divide', 'numpad/': 'Divide', 'numpaddivide': 'Divide',
    'numpadenter': 'Return', 'numpadreturn': 'Return'
  };

  if (keyMap[clean]) return keyMap[clean];

  // Teclas de função F1 a F24
  const fMatch = clean.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (fMatch) {
    return clean.toUpperCase();
  }

  // Letra única (a-z)
  if (clean.length === 1 && clean >= 'a' && clean <= 'z') {
    return clean.toUpperCase();
  }

  // Dígito único (0-9)
  if (clean.length === 1 && clean >= '0' && clean <= '9') {
    return clean;
  }

  // Combinações (ex: Alt+M, Ctrl+Shift+V)
  if (clean.includes('+')) {
    const parts = clean.split('+').map(p => {
      const pClean = p.trim();
      return keyMap[pClean] || (pClean.length === 1 ? pClean.toUpperCase() : pClean);
    });
    return parts.join('+');
  }

  return clean.toUpperCase();
}

let targetMouseButton = null;
let activeRawHotkey = null;
let activeHotkeySpec = null;
let currentHotkeyMode = 'toggle';
let isRecordingHotkey = false;
let lastRawToggleTime = 0;
let isHookPttPressed = false;
let isMousePttPressed = false;
const pressedKeycodes = new Set();

function buildUiohookKeycodeMap() {
  const map = new Map();
  if (!UiohookKey) return map;

  const explicitMap = {
    Backspace: 'backspace',
    Tab: 'tab',
    Enter: 'enter',
    NumpadEnter: 'enter',
    CapsLock: 'capslock',
    Escape: 'escape',
    Space: 'space',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    End: 'end',
    Home: 'home',
    ArrowLeft: 'arrowleft',
    ArrowUp: 'arrowup',
    ArrowRight: 'arrowright',
    ArrowDown: 'arrowdown',
    Insert: 'insert',
    Delete: 'delete',
    Numpad0: 'num0',
    Numpad1: 'num1',
    Numpad2: 'num2',
    Numpad3: 'num3',
    Numpad4: 'num4',
    Numpad5: 'num5',
    Numpad6: 'num6',
    Numpad7: 'num7',
    Numpad8: 'num8',
    Numpad9: 'num9',
    NumpadInsert: 'num0',
    NumpadEnd: 'num1',
    NumpadArrowDown: 'num2',
    NumpadPageDown: 'num3',
    NumpadArrowLeft: 'num4',
    NumpadArrowRight: 'num6',
    NumpadHome: 'num7',
    NumpadArrowUp: 'num8',
    NumpadPageUp: 'num9',
    NumpadDelete: 'decimal',
    NumpadMultiply: '*',
    NumpadAdd: '+',
    NumpadSubtract: '-',
    NumpadDecimal: 'decimal',
    NumpadDivide: '/',
    Semicolon: ';',
    Equal: '=',
    Comma: ',',
    Minus: '-',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    BracketLeft: '[',
    Backslash: '\\',
    BracketRight: ']',
    Quote: "'",
    Ctrl: 'ctrl',
    CtrlRight: 'ctrl',
    Alt: 'alt',
    AltRight: 'alt',
    Shift: 'shift',
    ShiftRight: 'shift',
    Meta: 'meta',
    MetaRight: 'meta',
    NumLock: 'numlock',
    ScrollLock: 'scrolllock',
    PrintScreen: 'printscreen'
  };

  for (const [k, code] of Object.entries(UiohookKey)) {
    if (typeof code !== 'number') continue;
    if (explicitMap[k]) {
      map.set(code, explicitMap[k]);
    } else if (/^[A-Z]$/.test(k)) {
      map.set(code, k.toLowerCase());
    } else if (/^[0-9]$/.test(k)) {
      map.set(code, k);
    } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) {
      map.set(code, k.toLowerCase());
    }
  }

  return map;
}

const UIOHOOK_KEYCODE_TO_NAME = buildUiohookKeycodeMap();

function normalizeSingleKeyToken(token) {
  if (token === undefined || token === null) return '';
  const raw = String(token);
  if (raw === ' ') return 'space';
  const clean = raw.trim().toLowerCase();
  if (!clean) return 'space';
  if (clean === 'spacebar') return 'space';
  if (clean === 'control' || clean === 'commandorcontrol' || clean === 'ctrlleft' || clean === 'ctrlright') return 'ctrl';
  if (clean === 'altleft' || clean === 'altright') return 'alt';
  if (clean === 'shiftleft' || clean === 'shiftright') return 'shift';
  if (clean === 'metaleft' || clean === 'metaright' || clean === 'os' || clean === 'win' || clean === 'super') return 'meta';
  if (clean === 'esc') return 'escape';
  if (clean === 'return' || clean === 'numpadenter' || clean === 'numpadreturn') return 'enter';
  if (clean === 'equal' || clean === 'equals') return '=';
  if (clean === 'minus') return '-';
  if (clean === 'mouse x1' || clean === 'mouse 4' || clean === 'xbutton1' || clean === 'btn4' || clean === 'button4') return 'mouse4';
  if (clean === 'mouse x2' || clean === 'mouse 5' || clean === 'xbutton2' || clean === 'btn5' || clean === 'button5') return 'mouse5';
  if (clean === 'mouse middle' || clean === 'mouse 3' || clean === 'middle' || clean === 'btn3' || clean === 'button3') return 'mouse3';
  if (/^numpad\s*\(?\d\)?$/.test(clean) || /^num\s*\(?\d\)?$/.test(clean)) {
    const d = clean.match(/\d/);
    if (d) return `num${d[0]}`;
  }
  if (clean.startsWith('page ')) return clean.replace('page ', 'page');
  if (clean.startsWith('key') && clean.length === 4) return clean.slice(3);
  if (clean.startsWith('digit') && clean.length === 6) return clean.slice(5);
  return clean.replace(/\s+/g, '');
}

function normalizeKeyName(name) {
  if (name === undefined || name === null) return '';
  const raw = String(name);
  if (raw === ' ') return 'space';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes('+') && trimmed.length > 1) {
    return trimmed.split('+').map(p => normalizeSingleKeyToken(p)).filter(Boolean).join('+');
  }
  return normalizeSingleKeyToken(trimmed);
}

function parseHotkeySpec(hotkeyStr) {
  const norm = normalizeKeyName(hotkeyStr);
  if (!norm) return null;
  if (norm === '+') {
    return { raw: '+', ctrl: false, alt: false, shift: false, meta: false, hasModifiers: false, key: '+' };
  }
  const parts = norm.split('+').filter(Boolean);
  if (parts.length === 0) return null;
  const spec = { raw: norm, ctrl: false, alt: false, shift: false, meta: false, hasModifiers: parts.length > 1, key: '' };
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i];
    if (mod === 'ctrl') spec.ctrl = true;
    else if (mod === 'alt') spec.alt = true;
    else if (mod === 'shift') spec.shift = true;
    else if (mod === 'meta') spec.meta = true;
  }
  spec.key = parts[parts.length - 1];
  return spec;
}

function resolveUiohookKeyName(e) {
  if (!e || typeof e.keycode !== 'number') return '';
  return UIOHOOK_KEYCODE_TO_NAME.get(e.keycode) || `key_${e.keycode}`;
}

function matchesHotkeyOnKeyDown(e, keyName, spec) {
  if (!spec || !keyName || keyName !== spec.key) return false;
  if (!spec.hasModifiers) return true;
  return (!spec.ctrl || !!e.ctrlKey) &&
         (!spec.alt || !!e.altKey) &&
         (!spec.shift || !!e.shiftKey) &&
         (!spec.meta || !!e.metaKey);
}

function handleGlobalKeyDown(e) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof e.keycode !== 'number') return;

  // Ignora repetição automática do Windows enquanto a tecla está segurada
  if (pressedKeycodes.has(e.keycode)) return;
  pressedKeycodes.add(e.keycode);

  const keyName = resolveUiohookKeyName(e);
  if (!keyName) return;

  if (isRecordingHotkey) {
    try {
      if (keyName === 'escape') {
        mainWindow.webContents.send('global-hotkey-recorded', { key: null });
      } else {
        mainWindow.webContents.send('global-hotkey-recorded', { key: keyName });
      }
    } catch (err) {}
    return;
  }

  if (activeHotkeySpec && matchesHotkeyOnKeyDown(e, keyName, activeHotkeySpec)) {
    try {
      if (currentHotkeyMode === 'push_to_talk') {
        if (!isHookPttPressed) {
          isHookPttPressed = true;
          mainWindow.webContents.send('push-to-talk-start', { key: activeHotkeySpec.raw });
          mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-start' });
        }
      } else {
        const now = Date.now();
        if (now - lastRawToggleTime > 250) {
          lastRawToggleTime = now;
          mainWindow.webContents.send('push-to-talk-toggle', { key: activeHotkeySpec.raw });
          mainWindow.webContents.send('global-hotkey-action', { type: 'toggle-mute' });
        }
      }
    } catch (err) {
      console.warn('[GlobalHotkey] Erro ao despachar evento uIOhook keydown:', err);
    }
  }
}

function handleGlobalKeyUp(e) {
  if (typeof e.keycode === 'number') {
    pressedKeycodes.delete(e.keycode);
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isRecordingHotkey || !activeHotkeySpec || currentHotkeyMode !== 'push_to_talk' || !isHookPttPressed) return;

  const keyName = resolveUiohookKeyName(e);
  const releasedTarget = keyName === activeHotkeySpec.key;
  const releasedModifier = activeHotkeySpec.hasModifiers && (
    (activeHotkeySpec.ctrl && keyName === 'ctrl') ||
    (activeHotkeySpec.alt && keyName === 'alt') ||
    (activeHotkeySpec.shift && keyName === 'shift') ||
    (activeHotkeySpec.meta && keyName === 'meta')
  );

  if (releasedTarget || releasedModifier) {
    isHookPttPressed = false;
    try {
      mainWindow.webContents.send('push-to-talk-stop', { key: activeHotkeySpec.raw });
      mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-end' });
    } catch (err) {
      console.warn('[GlobalHotkey] Erro ao despachar evento uIOhook keyup:', err);
    }
  }
}

ipcMain.on('start-recording-hotkey', () => {
  isRecordingHotkey = true;
  pressedKeycodes.clear();
});

ipcMain.on('stop-recording-hotkey', () => {
  isRecordingHotkey = false;
  pressedKeycodes.clear();
});

function handleGlobalMouseDown(e) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Se o usuário estiver ativamente gravando novo atalho no modal, repassa botões extras
  if (isRecordingHotkey) {
    // Ignora cliques esquerdo (1) e direito (2) para não atrapalhar a navegação do sistema
    if (e.button !== 1 && e.button !== 2) {
      try {
        mainWindow.webContents.send('global-mouse-down', { button: e.button });
      } catch (err) {}
    }
    return;
  }

  // Se o botão pressionado corresponder ao atalho de mouse configurado (ex: Mouse 4 ou Mouse 5)
  if (targetMouseButton !== null && e.button === targetMouseButton) {
    try {
      if (currentHotkeyMode === 'push_to_talk') {
        if (!isMousePttPressed) {
          isMousePttPressed = true;
          mainWindow.webContents.send('push-to-talk-start', { button: e.button });
          mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-start', button: e.button });
        }
      } else {
        const now = Date.now();
        if (now - lastRawToggleTime > 250) {
          lastRawToggleTime = now;
          mainWindow.webContents.send('push-to-talk-toggle', { button: e.button });
          mainWindow.webContents.send('global-hotkey-action', { type: 'toggle-mute', button: e.button });
        }
      }
    } catch (err) {
      console.warn('[GlobalHotkey] Erro ao enviar evento de mouse:', err);
    }
  }
}

function handleGlobalMouseUp(e) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (targetMouseButton !== null && e.button === targetMouseButton && currentHotkeyMode === 'push_to_talk') {
    isMousePttPressed = false;
    try {
      mainWindow.webContents.send('push-to-talk-stop', { button: e.button });
      mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-end', button: e.button });
    } catch (err) {
      console.warn('[GlobalHotkey] Erro ao enviar ptt-end de mouse:', err);
    }
  }
}

function unregisterActiveHotkey() {
  targetMouseButton = null;
  activeRawHotkey = null;
  activeHotkeySpec = null;
  isHookPttPressed = false;
  isMousePttPressed = false;
  pressedKeycodes.clear();
  if (currentRegisteredHotkey) {
    try {
      globalShortcut.unregister(currentRegisteredHotkey);
      console.log(`[GlobalHotkey] Desregistrado do SO: ${currentRegisteredHotkey}`);
    } catch (err) {
      console.warn('[GlobalHotkey] Falha ao desregistrar:', err);
    }
    currentRegisteredHotkey = null;
  }
  if (pttReleaseTimer) {
    clearTimeout(pttReleaseTimer);
    pttReleaseTimer = null;
  }
  isPttActive = false;
}

ipcMain.on('register-global-hotkey', (event, { key, mode }) => {
  unregisterActiveHotkey();
  if (!key) return;

  currentHotkeyMode = mode || 'toggle';
  activeRawHotkey = normalizeKeyName(key);

  const cleanKey = String(key).trim().toLowerCase();

  // Suporte nativo a botões extras de mouse (Mouse 4, Mouse 5, etc.) via uIOhook
  if (cleanKey.startsWith('mouse') || cleanKey.startsWith('btn') || cleanKey.startsWith('button') || cleanKey === 'middle') {
    const numMatch = cleanKey.match(/\d+/);
    if (numMatch) {
      targetMouseButton = parseInt(numMatch[0], 10);
    } else if (cleanKey.includes('middle')) {
      targetMouseButton = 3;
    }
    console.log(`[GlobalHotkey] Registrado atalho global de MOUSE via uIOhook: Botão ${targetMouseButton} (${currentHotkeyMode})`);
    return;
  }

  targetMouseButton = null;
  activeHotkeySpec = parseHotkeySpec(activeRawHotkey);

  if (uIOhookStarted && activeHotkeySpec) {
    console.log(`[GlobalHotkey] Registrado via uIOhook: "${activeHotkeySpec.raw}" (${currentHotkeyMode})`);
    return;
  }

  // Fallback com globalShortcut apenas se uIOhook não estiver ativo no ambiente
  const accelerator = convertToAccelerator(key);
  if (!accelerator) {
    console.warn(`[GlobalHotkey] Tecla inválida para acelerador: ${key}`);
    return;
  }

  const isSafeForOsGrab = /^F([1-9]|1[0-9]|2[0-4])$/i.test(accelerator) ||
    accelerator.includes('+') ||
    ['Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(accelerator);
  if (!isSafeForOsGrab) {
    console.log(`[GlobalHotkey] "${accelerator}" é tecla de digitação e uIOhook está inativo; funcionando apenas com a janela focada.`);
    return;
  }

  try {
    const success = globalShortcut.register(accelerator, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;

      if (currentHotkeyMode === 'push_to_talk') {
        if (!isPttActive) {
          isPttActive = true;
          mainWindow.webContents.send('push-to-talk-start', { key: accelerator });
          mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-start' });
        }
        if (pttReleaseTimer) clearTimeout(pttReleaseTimer);
        pttReleaseTimer = setTimeout(() => {
          isPttActive = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('push-to-talk-stop', { key: accelerator });
            mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-end' });
          }
        }, 500);
      } else {
        mainWindow.webContents.send('push-to-talk-toggle', { key: accelerator });
        mainWindow.webContents.send('global-hotkey-action', { type: 'toggle-mute' });
      }
    });

    if (success) {
      currentRegisteredHotkey = accelerator;
      console.log(`[GlobalHotkey] Registrado globalmente via fallback: ${accelerator} (${currentHotkeyMode})`);
    } else {
      console.warn(`[GlobalHotkey] Não foi possível registrar o atalho global: ${accelerator} (já pode estar em uso pelo sistema)`);
    }
  } catch (err) {
    console.error(`[GlobalHotkey] Erro ao registrar atalho global:`, err);
  }
});

ipcMain.on('unregister-global-hotkey', () => {
  unregisterActiveHotkey();
});

app.on('will-quit', () => {
  unregisterActiveHotkey();
  globalShortcut.unregisterAll();
  if (uIOhook && uIOhookStarted) {
    try {
      uIOhook.stop();
      uIOhookStarted = false;
      console.log('[uIOhook] Hook global de teclado e mouse encerrado com sucesso.');
    } catch (err) {
      console.warn('[uIOhook] Erro ao encerrar uIOhook:', err);
    }
  }
});
