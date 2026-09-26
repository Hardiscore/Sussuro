/**
 * Sussurro - Electron Main Process (CommonJS)
 * 
 * Gerencia ciclo de vida do aplicativo de desktop, criação da janela principal,
 * permissões de hardware (microfone, webcam e câmeras virtuais como OBS),
 * comunicação IPC e Atalhos Globais de Sistema (Push to Talk e Mudo em segundo plano).
 */

const { app, BrowserWindow, ipcMain, shell, session, desktopCapturer, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Suporte a Atualização Automática via GitHub Releases (electron-updater)
let autoUpdater = null;
try {
  const updaterModule = require('electron-updater');
  autoUpdater = updaterModule.autoUpdater;
} catch (e) {
  console.warn('[AutoUpdater] electron-updater não carregado:', e.message);
}

// Otimizações para funcionamento em segundo plano (evita travamentos ao minimizar ou dar Alt+Tab)
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Garante que o áudio de outros jogadores toque sempre sem bloqueio de Autoplay
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Aceleração de Hardware por GPU (transfere decodificação de vídeo e renderização para a placa de vídeo)
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-hardware-overlays');
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');
app.commandLine.appendSwitch('use-angle', 'd3d11');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,PlatformHEVCDecoderSupport');

// Suporte a eventos globais de mouse via uiohook-napi
let uIOhook = null;
try {
  const uioModule = require('uiohook-napi');
  uIOhook = uioModule.uIOhook;
} catch (err) {
  console.warn('[uIOhook] uiohook-napi não pôde ser carregado no ambiente atual:', err.message);
}

let mainWindow = null;

function createWindow() {
  // Define o preload correto (.cjs ou .js)
  const preloadPath = fs.existsSync(path.join(__dirname, 'preload.cjs'))
    ? path.join(__dirname, 'preload.cjs')
    : path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    title: 'Sussurro - RPG Voice & Video',
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Inicialização da aplicação
app.whenReady().then(() => {
  createWindow();

  if (uIOhook) {
    try {
      uIOhook.on('mousedown', handleGlobalMouseDown);
      uIOhook.on('mouseup', handleGlobalMouseUp);
      uIOhook.start();
      console.log('[uIOhook] Hook global de mouse e teclado inicializado com sucesso.');
    } catch (err) {
      console.warn('[uIOhook] Falha ao inicializar uIOhook:', err);
    }
  }

  // Verificação e Notificação de Atualizações via GitHub Releases
  if (app.isPackaged && autoUpdater) {
    try {
      autoUpdater.checkForUpdatesAndNotify();

      autoUpdater.on('update-available', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-update-available', info);
        }
      });

      autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-update-downloaded', info);
        }
      });
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Ação para reiniciar e aplicar a nova versão baixada
ipcMain.on('restart-and-install-update', () => {
  if (autoUpdater) {
    autoUpdater.quitAndInstall();
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
let currentHotkeyMode = 'toggle';
let isRecordingHotkey = false;

ipcMain.on('start-recording-hotkey', () => {
  isRecordingHotkey = true;
});

ipcMain.on('stop-recording-hotkey', () => {
  isRecordingHotkey = false;
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
        mainWindow.webContents.send('push-to-talk-start', { button: e.button });
        mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-start', button: e.button });
      } else {
        mainWindow.webContents.send('push-to-talk-toggle', { button: e.button });
        mainWindow.webContents.send('global-hotkey-action', { type: 'toggle-mute', button: e.button });
      }
    } catch (err) {
      console.warn('[GlobalHotkey] Erro ao enviar push-to-talk:', err);
    }
  }
}

function handleGlobalMouseUp(e) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (targetMouseButton !== null && e.button === targetMouseButton) {
    try {
      if (currentHotkeyMode === 'push_to_talk') {
        mainWindow.webContents.send('push-to-talk-stop', { button: e.button });
        mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-end', button: e.button });
      }
    } catch (err) {
      console.warn('[GlobalHotkey] Erro ao enviar ptt-end:', err);
    }
  }
}

function unregisterActiveHotkey() {
  targetMouseButton = null;
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
  const cleanKey = String(key).trim().toLowerCase();

  // Suporte nativo a botões extras de mouse (Mouse 4, Mouse 5, etc.) via uIOhook
  if (cleanKey.startsWith('mouse') || cleanKey.startsWith('btn') || cleanKey.startsWith('button')) {
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

  const accelerator = convertToAccelerator(key);
  if (!accelerator) {
    console.warn(`[GlobalHotkey] Tecla inválida para acelerador: ${key}`);
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
        // No Windows/Linux/Mac, enquanto o usuário mantém a tecla pressionada no teclado,
        // o sistema operacional envia pulsos de repetição de tecla contínuos.
        // Se após 300ms nenhum novo pulso for recebido, a tecla foi solta pelo usuário.
        if (pttReleaseTimer) clearTimeout(pttReleaseTimer);
        pttReleaseTimer = setTimeout(() => {
          isPttActive = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('push-to-talk-stop', { key: accelerator });
            mainWindow.webContents.send('global-hotkey-action', { type: 'ptt-end' });
          }
        }, 500);
      } else {
        // Alternar Mudo (Toggle)
        mainWindow.webContents.send('push-to-talk-toggle', { key: accelerator });
        mainWindow.webContents.send('global-hotkey-action', { type: 'toggle-mute' });
      }
    });

    if (success) {
      currentRegisteredHotkey = accelerator;
      console.log(`[GlobalHotkey] Registrado globalmente no sistema: ${accelerator} (${currentHotkeyMode})`);
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
  if (uIOhook) {
    try {
      uIOhook.stop();
      console.log('[uIOhook] Hook global de mouse encerrado com sucesso.');
    } catch (err) {
      console.warn('[uIOhook] Erro ao encerrar uIOhook:', err);
    }
  }
});
