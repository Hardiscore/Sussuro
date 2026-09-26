/**
 * TavernRTC - Electron Preload Script
 * 
 * Ponte segura (ContextBridge) entre o Node.js/Electron e a aplicação Web/Renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,

  // Ações de Janela
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // Utilitários de Sistema
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),

  // Atalhos Globais de Sistema (Push-to-Talk e Muto mesmo com janela minimizada ou em segundo plano)
  registerGlobalHotkey: (config) => ipcRenderer.send('register-global-hotkey', config),
  unregisterGlobalHotkey: () => ipcRenderer.send('unregister-global-hotkey'),
  onGlobalHotkeyAction: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('global-hotkey-action', handler);
    return () => ipcRenderer.removeListener('global-hotkey-action', handler);
  },

  // Canais dedicados de Push-to-Talk (Mouse e Teclado via uIOhook)
  onPushToTalkStart: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('push-to-talk-start', handler);
    return () => ipcRenderer.removeListener('push-to-talk-start', handler);
  },
  onPushToTalkStop: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('push-to-talk-stop', handler);
    return () => ipcRenderer.removeListener('push-to-talk-stop', handler);
  },
  onPushToTalkToggle: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('push-to-talk-toggle', handler);
    return () => ipcRenderer.removeListener('push-to-talk-toggle', handler);
  },

  // Eventos globais de mouse capturados no SO (uIOhook)
  startRecordingHotkey: () => ipcRenderer.send('start-recording-hotkey'),
  stopRecordingHotkey: () => ipcRenderer.send('stop-recording-hotkey'),
  onGlobalMouseDown: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('global-mouse-down', handler);
    return () => ipcRenderer.removeListener('global-mouse-down', handler);
  },
  onGlobalMouseUp: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('global-mouse-up', handler);
    return () => ipcRenderer.removeListener('global-mouse-up', handler);
  },

  // Atualização Automática via GitHub
  onUpdateAvailable: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('app-update-available', handler);
    return () => ipcRenderer.removeListener('app-update-available', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('app-update-downloaded', handler);
    return () => ipcRenderer.removeListener('app-update-downloaded', handler);
  },
  restartAndInstallUpdate: () => ipcRenderer.send('restart-and-install-update')
});
