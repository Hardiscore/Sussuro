/**
 * TavernRTC - Script Principal da Interface (Renderer Process)
 * 
 * Orquestra eventos da interface, controle de mídia (áudio/vídeo/OBS),
 * gestão de salas, rolagens de dados de RPG e integração com Electron / WebRTC.
 */

import { TavernWebRTC, getSavedIceServers, saveIceServers, DEFAULT_ICE_SERVERS } from './webrtc.js';
import { getStoredFirebaseConfig, saveFirebaseConfig, resetFirebaseConfig, BUILTIN_FIREBASE_CONFIG } from './firebase-config.js';

const STORAGE_KEYS = {
  USERNAME: 'tavern_username',
  ROLE: 'tavern_role',
  CLASS_ICON: 'tavern_class_icon',
  AUDIO_DEVICE: 'tavern_audio_device',
  VIDEO_DEVICE: 'tavern_video_device',
  MIRROR_VIDEO: 'tavern_mirror_video',
  MIC_MODE: 'tavern_mic_mode',
  MIC_HOTKEY: 'tavern_mic_hotkey',
  NOISE_SUPPRESSION_MODE: 'tavern_noise_suppression_mode',
  NOISE_GATE_THRESHOLD: 'tavern_noise_gate_threshold',
  LAYOUT_MODE: 'tavern_layout_mode',
  FIXED_GRID_SLOTS: 'tavern_fixed_grid_slots',
  SOUND_FEEDBACK: 'tavern_sound_feedback',
  SAVED_ROOMS: 'tavern_saved_rooms'
};

// Configuração de paginação do Lobby
export const ROOMS_PER_PAGE = 2; // Exatamente no máximo 2 salas visíveis por vez no lobby
let currentRoomPage = 0;

const StorageService = {
  get(key, defaultValue = null) {
    try {
      const val = localStorage.getItem(key);
      if (val === null) return defaultValue;
      return val;
    } catch (e) {
      console.warn(`[StorageService] Failed to read key '${key}':`, e);
      return defaultValue;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
      return true;
    } catch (e) {
      console.warn(`[StorageService] Failed to save key '${key}':`, e);
      return false;
    }
  },

  getAllPreferences() {
    return {
      userName: this.get(STORAGE_KEYS.USERNAME, 'Aventureiro'),
      userRole: this.get(STORAGE_KEYS.ROLE, 'jogador'),
      classIcon: this.get(STORAGE_KEYS.CLASS_ICON, '⚔️'),
      audioDeviceId: this.get(STORAGE_KEYS.AUDIO_DEVICE, null),
      videoDeviceId: this.get(STORAGE_KEYS.VIDEO_DEVICE, null),
      mirrorVideo: this.get(STORAGE_KEYS.MIRROR_VIDEO, 'true') !== 'false',
      micMode: this.get(STORAGE_KEYS.MIC_MODE, 'toggle'),
      micHotkey: this.get(STORAGE_KEYS.MIC_HOTKEY, '='),
      noiseSuppressionMode: this.get(STORAGE_KEYS.NOISE_SUPPRESSION_MODE, 'noisegate'),
      noiseGateThreshold: parseInt(this.get(STORAGE_KEYS.NOISE_GATE_THRESHOLD, '14'), 10) || 14,
      layoutMode: this.get(STORAGE_KEYS.LAYOUT_MODE, 'movel'),
      fixedGridSlots: Math.max(1, Math.min(15, parseInt(this.get(STORAGE_KEYS.FIXED_GRID_SLOTS, '5'), 10) || 5)),
      soundFeedback: this.get(STORAGE_KEYS.SOUND_FEEDBACK, 'true') !== 'false'
    };
  },

  savePreference(key, value) {
    return this.set(key, value);
  },

  saveAudioDevice(deviceId) {
    return this.set(STORAGE_KEYS.AUDIO_DEVICE, deviceId || '');
  },

  saveVideoDevice(deviceId) {
    return this.set(STORAGE_KEYS.VIDEO_DEVICE, deviceId || '');
  },

  saveNoiseGateThreshold(threshold) {
    return this.set(STORAGE_KEYS.NOISE_GATE_THRESHOLD, threshold);
  },

  saveLayoutMode(layout) {
    return this.set(STORAGE_KEYS.LAYOUT_MODE, layout);
  },

  saveClassIcon(icon) {
    return this.set(STORAGE_KEYS.CLASS_ICON, icon);
  },

  saveUsername(name) {
    return this.set(STORAGE_KEYS.USERNAME, name);
  },

  saveRole(role) {
    return this.set(STORAGE_KEYS.ROLE, role);
  },

  saveMicMode(mode) {
    return this.set(STORAGE_KEYS.MIC_MODE, mode);
  },

  saveMicHotkey(hotkey) {
    return this.set(STORAGE_KEYS.MIC_HOTKEY, hotkey);
  },

  saveNoiseSuppressionMode(mode) {
    return this.set(STORAGE_KEYS.NOISE_SUPPRESSION_MODE, mode);
  },

  saveSoundFeedback(enabled) {
    return this.set(STORAGE_KEYS.SOUND_FEEDBACK, enabled);
  },

  saveFixedGridSlots(slots) {
    return this.set(STORAGE_KEYS.FIXED_GRID_SLOTS, slots);
  },

  getSavedRooms() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SAVED_ROOMS);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    // Salas padrão para mesa de RPG se o usuário ainda não tiver nenhuma salva
    return [
      { id: 'taverna-do-dragao', name: 'Taverna do Dragão', createdAt: Date.now() - 3600000 },
      { id: 'masmorra-antiga', name: 'Masmorra Antiga', createdAt: Date.now() - 7200000 }
    ];
  },

  saveRoom(roomId) {
    if (!roomId) return;
    try {
      let rooms = this.getSavedRooms();
      rooms = rooms.filter(r => (typeof r === 'string' ? r !== roomId : r.id !== roomId));
      rooms.unshift({
        id: roomId,
        name: roomId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        createdAt: Date.now()
      });
      if (rooms.length > 20) rooms = rooms.slice(0, 20);
      localStorage.setItem(STORAGE_KEYS.SAVED_ROOMS, JSON.stringify(rooms));
    } catch (e) {}
  },

  deleteRoom(roomId) {
    try {
      let rooms = this.getSavedRooms();
      rooms = rooms.filter(r => (typeof r === 'string' ? r !== roomId : r.id !== roomId));
      localStorage.setItem(STORAGE_KEYS.SAVED_ROOMS, JSON.stringify(rooms));
      return rooms;
    } catch (e) {
      return [];
    }
  }
};

// Limite máximo de participantes suportados na malha P2P (mesh)
const MAX_PARTICIPANTS = 15;

// Versão Oficial do Sussurro RPG
export const APP_VERSION = '1.0.6';

const savedPrefs = StorageService.getAllPreferences();

// Estado global da aplicação
const state = {
  appVersion: APP_VERSION,
  webrtc: null,
  userName: savedPrefs.userName,
  userRole: savedPrefs.userRole,
  isMestreRoleUnlocked: false,
  userClassIcon: savedPrefs.classIcon,
  selectedAudioDeviceId: savedPrefs.audioDeviceId,
  selectedVideoDeviceId: savedPrefs.videoDeviceId,
  mirrorLocalVideo: savedPrefs.mirrorVideo,
  isAudioMuted: false,
  isVideoOff: false,
  isInCall: false,
  // Atalhos de voz e microfone
  micActivationMode: savedPrefs.micMode,
  micHotkey: savedPrefs.micHotkey.toLowerCase(),
  isPttActive: false,
  isRecordingHotkey: false,
  // Supressão de Ruído & Noise Gate
  noiseSuppressionMode: savedPrefs.noiseSuppressionMode,
  noiseGateThreshold: savedPrefs.noiseGateThreshold,
  // Layouts de tela
  currentLayout: savedPrefs.layoutMode,
  fixedGridSlots: savedPrefs.fixedGridSlots,
  activeSpeakerId: 'local',
  // Volumes individuais de participantes remotos (0 a 200)
  peerVolumes: {},
  // Sons de feedback para microfone e PTT
  soundFeedbackEnabled: savedPrefs.soundFeedback,
  // Mutar áudio de transmissão de tela localmente (apenas para este espectador)
  localStreamMutes: {},
  // Fontes de tela/janela para transmissão
  screenShareSources: { screens: [], windows: [] },
  selectedScreenSource: null,
  selectedScreenTab: 'screen',
  // Rolagem de Dados de RPG & Controles de Mestre
  gmDiceSoundMuted: false,
  diceBlockedForAll: false
};

// ============================================================================
// EFEITOS SONOROS DE MICROFONE & PUSH TO TALK (Web Audio API Synthesizer)
// ============================================================================
let audioFeedbackCtx = null;

function getAudioFeedbackContext() {
  if (!audioFeedbackCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      audioFeedbackCtx = new AudioCtx();
    }
  }
  if (audioFeedbackCtx && audioFeedbackCtx.state === 'suspended') {
    audioFeedbackCtx.resume().catch(() => {});
  }
  return audioFeedbackCtx;
}

/**
 * Reproduz sons sutis e modernos de feedback acústico (Discord-style)
 * @param {'mute' | 'unmute' | 'ptt-start' | 'ptt-end'} type 
 */
function playMicFeedbackSound(type) {
  if (!state.soundFeedbackEnabled) return;

  try {
    const ctx = getAudioFeedbackContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);

    if (type === 'mute') {
      // Tom duplo descendente suave (540Hz -> 380Hz)
      masterGain.gain.setValueAtTime(0.09, now);
      masterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(540, now);
      osc.frequency.setValueAtTime(540, now + 0.06);
      osc.frequency.setValueAtTime(380, now + 0.07);
      osc.connect(masterGain);

      osc.start(now);
      osc.stop(now + 0.18);
    } else if (type === 'unmute') {
      // Tom duplo ascendente alegre (380Hz -> 580Hz)
      masterGain.gain.setValueAtTime(0.09, now);
      masterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(380, now);
      osc.frequency.setValueAtTime(380, now + 0.06);
      osc.frequency.setValueAtTime(580, now + 0.07);
      osc.connect(masterGain);

      osc.start(now);
      osc.stop(now + 0.18);
    } else if (type === 'ptt-start') {
      // Beep curto e nítido de ativação do Push to Talk (780Hz, 38 milissegundos)
      masterGain.gain.setValueAtTime(0.08, now);
      masterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(780, now);
      osc.connect(masterGain);

      osc.start(now);
      osc.stop(now + 0.04);
    } else if (type === 'ptt-end') {
      // Beep sutil de liberação do Push to Talk (520Hz, 28 milissegundos)
      masterGain.gain.setValueAtTime(0.06, now);
      masterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.connect(masterGain);

      osc.start(now);
      osc.stop(now + 0.03);
    }
  } catch (err) {
    // Falha silenciosa se áudio não permitido pelo navegador
  }
}

// ============================================================================
// EFEITOS SONOROS DE DADOS DE RPG (Web Audio API Synthesizer)
// ============================================================================
function playDiceSound(isCritical = false) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    // Simula o chocalho de dados rolando na mesa com ruído modulado
    const bufferSize = ctx.sampleRate * 0.25;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.05));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(isCritical ? 1200 : 800, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start();

    // Se for um acerto crítico (20 natural), toca um acorde de triunfo
    if (isCritical) {
      setTimeout(() => {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.15); // E5
        oscGain.gain.setValueAtTime(0.2, ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        osc.connect(oscGain);
        oscGain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      }, 120);
    }
  } catch (err) {
    // Web Audio silencioso se bloqueado
  }
}

// ============================================================================
// EFEITOS SONOROS DE PRESENÇA (Entrada e Saída da Conversa)
// ============================================================================
function playPresenceSound(type = 'join') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    if (type === 'join') {
      // Notificação de entrada: acorde ascendente harmônico e agradável (estilo Discord)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now); // A4
      osc.frequency.setValueAtTime(554.37, now + 0.1); // C#5
      osc.frequency.setValueAtTime(659.25, now + 0.2); // E5

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.43);
    } else {
      // Notificação de saída: tom descendente suave
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, now); // E5
      osc.frequency.setValueAtTime(554.37, now + 0.1); // C#5
      osc.frequency.setValueAtTime(440, now + 0.2); // A4

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.16, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.43);
    }
  } catch (err) {
    // Ignora se áudio estiver desabilitado pelo navegador
  }
}

let presenceToastTimer = null;
function showPresenceToast(message, type = 'join') {
  const toast = document.getElementById('presence-toast');
  const text = document.getElementById('presence-toast-text');
  const icon = document.getElementById('presence-toast-icon');
  if (!toast || !text) return;

  text.textContent = message;
  if (icon) {
    icon.textContent = type === 'join' ? '👋' : '🚪';
  }
  toast.className = `presence-toast ${type} show`;

  if (presenceToastTimer) clearTimeout(presenceToastTimer);
  presenceToastTimer = setTimeout(() => {
    toast.className = 'presence-toast hidden';
  }, 3200);
}

function showNoAudioWarning(msg) {
  const banner = document.getElementById('no-audio-warning-banner');
  const text = document.getElementById('no-audio-warning-text');
  if (banner && text) {
    if (msg) text.textContent = msg;
    banner.classList.remove('hidden');
  }
}

// ============================================================================
// GERADOR DE NOMES DE SALA DE RPG
// ============================================================================
const RPG_PREFIXES = ['taverna', 'masmorra', 'torre', 'gruta', 'floresta', 'castelo', 'abismo', 'pantano'];
const RPG_SUFFIXES = ['do-dragao', 'do-grifo', 'arcana', 'esquecida', 'do-lobo', 'sombria', 'do-bardo', 'estelar'];

function generateRpgRoomName() {
  const p = RPG_PREFIXES[Math.floor(Math.random() * RPG_PREFIXES.length)];
  const s = RPG_SUFFIXES[Math.floor(Math.random() * RPG_SUFFIXES.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${p}-${s}-${num}`;
}

// ============================================================================
// INICIALIZAÇÃO DA INTERFACE
// ============================================================================
async function initApp() {
  try {
    setupElectronTitlebar();
  } catch (e) {
    console.error('[Init] Erro em setupElectronTitlebar:', e);
  }

  try {
    setupLobbyInputs();
    setupSettingsModal();
    setupScreenShareModal();
    setupDiceRoller();
    setupCallControls();
    setupLayoutSelector();
    setupKeyboardShortcuts();
    applyGridLayout(state.currentLayout);
  } catch (e) {
    console.error('[Init] Erro na configuração dos controles da UI:', e);
  }

  // Inicializa enumeração de dispositivos e prévia local no Lobby
  try {
    await enumerateDevices();
    await initLobbyPreview();
  } catch (e) {
    console.warn('[Init] Erro ao enumerar dispositivos locais:', e);
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      console.log('[Media] Dispositivos de áudio/vídeo alterados no sistema.');
      await enumerateDevices().catch(() => {});
    });
  }
}

// ============================================================================
// INTEGRAÇÃO COM ELECTRON (Window Controls)
// ============================================================================
function setupElectronTitlebar() {
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);
  const statusBadge = document.getElementById('titlebar-status');
  const windowControls = document.getElementById('window-controls');

  if (isElectron) {
    if (statusBadge) statusBadge.textContent = 'Electron Desktop';
    const btnMin = document.getElementById('btn-window-minimize');
    const btnMax = document.getElementById('btn-window-maximize');
    const btnClose = document.getElementById('btn-window-close');
    if (btnMin) btnMin.onclick = () => window.electronAPI.minimize();
    if (btnMax) btnMax.onclick = () => window.electronAPI.maximize();
    if (btnClose) btnClose.onclick = () => window.electronAPI.close();

    // Notificações de Atualização Automática via GitHub Releases
    if (typeof window.electronAPI.onUpdateAvailable === 'function') {
      window.electronAPI.onUpdateAvailable((info) => {
        showLayoutNotification(`📦 Nova versão v${info?.version || ''} detectada no GitHub! Baixando atualização em segundo plano...`);
      });
    }

    if (typeof window.electronAPI.onUpdateProgress === 'function') {
      let lastProgressToast = 0;
      window.electronAPI.onUpdateProgress((progress) => {
        const now = Date.now();
        // Atualiza a cada 3 segundos ou quando atingir 100% para não inundar a tela
        if (now - lastProgressToast > 3000 || progress.percent >= 99) {
          lastProgressToast = now;
          const mbDownloaded = (progress.transferred / 1048576).toFixed(1);
          const mbTotal = (progress.total / 1048576).toFixed(1);
          showLayoutNotification(`⬇️ Baixando atualização: ${Math.round(progress.percent)}% (${mbDownloaded}MB / ${mbTotal}MB)...`);
        }
      });
    }

    if (typeof window.electronAPI.onUpdateDownloaded === 'function') {
      window.electronAPI.onUpdateDownloaded((info) => {
        showUpdateBanner(info);
      });
    }

    if (typeof window.electronAPI.onUpdateError === 'function') {
      window.electronAPI.onUpdateError((err) => {
        console.warn('[AutoUpdater UI] Erro:', err);
      });
    }
  } else {
    if (statusBadge) statusBadge.textContent = 'WebRTC Mesh (Navegador)';
    // Em modo navegador normal, esconde os botões de janela do sistema
    if (windowControls) windowControls.style.display = 'none';
  }
}

// ============================================================================
// CONTROLE DO LOBBY
// ============================================================================
function setupLobbyInputs() {
  const nameInput = document.getElementById('input-user-name');
  const roomInput = document.getElementById('input-room-id');
  const btnGenerate = document.getElementById('btn-generate-room');
  const btnJoin = document.getElementById('btn-join-room');
  const roleJogador = document.getElementById('role-jogador');
  const roleMestre = document.getElementById('role-mestre');

  nameInput.value = state.userName;
  roomInput.value = generateRpgRoomName();

  nameInput.addEventListener('input', (e) => {
    state.userName = e.target.value.trim() || 'Aventureiro';
    StorageService.saveUsername(state.userName);
    updateAvatarVisuals();
  });

  btnGenerate.addEventListener('click', () => {
    roomInput.value = generateRpgRoomName();
    roomInput.focus();
  });

  roleJogador.addEventListener('click', () => {
    state.userRole = 'jogador';
    roleJogador.classList.add('active');
    roleMestre.classList.remove('active');
    StorageService.saveRole('jogador');
    updateAvatarVisuals();
  });

  roleMestre.addEventListener('click', () => {
    state.userRole = 'mestre';
    roleMestre.classList.add('active');
    roleJogador.classList.remove('active');
    StorageService.saveRole('mestre');
    updateAvatarVisuals();
  });

  // Atalho exclusivo para Mestres: Ctrl + Shift + M para desbloquear e revelar a opção
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm' || e.code === 'KeyM')) {
      e.preventDefault();
      state.isMestreRoleUnlocked = !state.isMestreRoleUnlocked;
      if (state.isMestreRoleUnlocked) {
        roleMestre.classList.remove('hidden');
        roleMestre.click();
        showLayoutNotification('👑 Modo Mestre (GM) desbloqueado com sucesso!');
      } else {
        roleMestre.classList.add('hidden');
        roleJogador.click();
        showLayoutNotification('Papel de Mestre ocultado.');
      }
    }
  });

  // Por padrão, a opção de Mestre fica oculta. Só seleciona se desbloqueado
  if (state.userRole === 'mestre' && state.isMestreRoleUnlocked) {
    roleMestre.classList.remove('hidden');
    roleMestre.click();
  } else {
    state.userRole = 'jogador';
    roleJogador.click();
  }

  btnJoin.addEventListener('click', () => {
    const roomId = roomInput.value.trim();
    if (!roomId) {
      alert('Por favor, informe um código ou ID para a sala.');
      roomInput.focus();
      return;
    }
    StorageService.saveRoom(roomId);
    startCall(roomId);
  });

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnJoin.click();
    }
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      roomInput.focus();
    }
  });

  // Inicializa a lista de salas criadas/recentes (máximo 2 por vez)
  setupLobbyRoomsList();
}

// ============================================================================
// GESTÃO DE SALAS ATIVAS NO FIREBASE (Salas que já têm pessoas conectadas)
// ============================================================================
let activeFirebaseRooms = [];
let isLoadingRooms = false;
let activeRoomsPollTimer = null;

async function fetchActiveRoomsFromFirebase() {
  if (isLoadingRooms) return;
  isLoadingRooms = true;
  renderLobbyRoomsLoading();

  const refreshIcon = document.getElementById('icon-room-refresh');
  if (refreshIcon) refreshIcon.classList.add('spin-animation');

  const cfg = getStoredFirebaseConfig();
  const dbUrl = (cfg?.databaseURL || BUILTIN_FIREBASE_CONFIG.databaseURL || 'https://sussurro-4ef44-default-rtdb.firebaseio.com').replace(/\/$/, '');

  let foundRooms = [];

  try {
    // Timeout resiliente com AbortController (4.5s) para GARANTIR que a interface nunca trave
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4500);

    const res = await fetch(`${dbUrl}/rooms.json?shallow=true`, {
      signal: controller.signal
    });

    if (res.ok) {
      const roomKeysObj = await res.json();
      if (roomKeysObj && typeof roomKeysObj === 'object') {
        const roomIds = Object.keys(roomKeysObj);

        // Busca dados dos participantes de cada sala em paralelo com timeout individual
        const peerPromises = roomIds.map(async (roomId) => {
          try {
            const peerCtrl = new AbortController();
            const pTimeout = setTimeout(() => peerCtrl.abort(), 3500);
            const pRes = await fetch(`${dbUrl}/rooms/${encodeURIComponent(roomId)}/peers.json`, {
              signal: peerCtrl.signal
            });
            clearTimeout(pTimeout);

            if (pRes.ok) {
              const peersData = await pRes.json();
              if (peersData && typeof peersData === 'object') {
                const peerIds = Object.keys(peersData);
                if (peerIds.length > 0) {
                  const peerList = peerIds.map(pid => {
                    const p = peersData[pid];
                    return {
                      id: pid,
                      name: p?.name || 'Aventureiro',
                      role: p?.role || 'jogador',
                      joinedAt: p?.joinedAt || Date.now()
                    };
                  });

                  return {
                    id: roomId,
                    name: roomId.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    peerCount: peerList.length,
                    peers: peerList,
                    latestActivity: Math.max(...peerList.map(p => p.joinedAt || 0), Date.now())
                  };
                }
              }
            }
          } catch (e) {
            // Falha individual na sala ignorada silenciosamente para preservar outras
          }
          return null;
        });

        const settled = await Promise.allSettled(peerPromises);
        foundRooms = settled
          .filter(s => s.status === 'fulfilled' && s.value !== null)
          .map(s => s.value);

        // Ordena por maior número de aventureiros online e atividade recente
        foundRooms.sort((a, b) => b.peerCount - a.peerCount || b.latestActivity - a.latestActivity);
      }
    }
    clearTimeout(timeoutId);
  } catch (err) {
    console.warn('[Firebase] Não foi possível consultar salas ativas (timeout ou rede):', err);
  } finally {
    isLoadingRooms = false;
    activeFirebaseRooms = foundRooms;
    if (refreshIcon) refreshIcon.classList.remove('spin-animation');

    const maxPages = Math.max(1, Math.ceil(activeFirebaseRooms.length / ROOMS_PER_PAGE));
    if (currentRoomPage >= maxPages) {
      currentRoomPage = 0;
    }
    renderLobbyRooms();
  }
}

function renderLobbyRoomsLoading() {
  const container = document.getElementById('lobby-rooms-list');
  if (!container) return;
  container.innerHTML = `
    <div class="lobby-rooms-empty">
      <svg class="spin-animation" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blurple)" stroke-width="2.5">
        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
      </svg>
      <span style="margin-top: 6px; font-weight: 500;">Pesquisando salas com aventureiros no Firebase...</span>
    </div>
  `;
}

function setupLobbyRoomsList() {
  const btnPrev = document.getElementById('btn-room-prev');
  const btnNext = document.getElementById('btn-room-next');
  const btnRefresh = document.getElementById('btn-room-refresh');

  if (btnPrev) {
    btnPrev.onclick = () => {
      if (currentRoomPage > 0) {
        currentRoomPage--;
        renderLobbyRooms();
      }
    };
  }

  if (btnNext) {
    btnNext.onclick = () => {
      const maxPages = Math.ceil(activeFirebaseRooms.length / ROOMS_PER_PAGE);
      if (currentRoomPage < maxPages - 1) {
        currentRoomPage++;
        renderLobbyRooms();
      }
    };
  }

  if (btnRefresh) {
    btnRefresh.onclick = () => {
      fetchActiveRoomsFromFirebase();
    };
  }

  // Busca inicial no Firebase
  fetchActiveRoomsFromFirebase();

  // Polling automático suave a cada 25 segundos enquanto estiver no Lobby
  if (activeRoomsPollTimer) clearInterval(activeRoomsPollTimer);
  activeRoomsPollTimer = setInterval(() => {
    if (!state.isInCall) {
      fetchActiveRoomsFromFirebase();
    }
  }, 25000);
}

function renderLobbyRooms() {
  const container = document.getElementById('lobby-rooms-list');
  const pageInfo = document.getElementById('room-page-info');
  const btnPrev = document.getElementById('btn-room-prev');
  const btnNext = document.getElementById('btn-room-next');
  const roomInput = document.getElementById('input-room-id');

  if (!container) return;

  const totalRooms = activeFirebaseRooms.length;
  const maxPages = Math.max(1, Math.ceil(totalRooms / ROOMS_PER_PAGE));

  if (currentRoomPage >= maxPages) {
    currentRoomPage = maxPages - 1;
  }
  if (currentRoomPage < 0) currentRoomPage = 0;

  if (pageInfo) {
    pageInfo.textContent = `${currentRoomPage + 1} / ${maxPages}`;
  }
  if (btnPrev) btnPrev.disabled = (currentRoomPage === 0);
  if (btnNext) btnNext.disabled = (currentRoomPage >= maxPages - 1);

  if (totalRooms === 0) {
    container.innerHTML = `
      <div class="lobby-rooms-empty">
        <span style="font-size: 16px; margin-bottom: 2px;">🛡️</span>
        <span style="font-weight: 500;">Nenhuma sala com pessoas online no momento.</span>
        <span style="font-size: 10.5px; color: var(--text-muted); margin-top: 2px;">Crie ou digite um ID acima para começar sua mesa de RPG!</span>
      </div>
    `;
    return;
  }

  const pageRooms = activeFirebaseRooms.slice(currentRoomPage * ROOMS_PER_PAGE, (currentRoomPage + 1) * ROOMS_PER_PAGE);

  container.innerHTML = pageRooms.map(room => {
    const roomId = room.id;
    const roomName = room.name || roomId;
    const count = room.peerCount || 1;
    const countText = count === 1 ? '1 online' : `${count} online`;
    const memberNames = (room.peers || []).map(p => p.name).slice(0, 3).join(', ');

    return `
      <div class="lobby-room-card" data-room-id="${escapeHtml(roomId)}">
        <div class="lobby-room-info">
          <div class="lobby-room-name" title="${escapeHtml(roomName)}">
            <span>🏰</span>
            <span style="max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(roomName)}</span>
            <span class="badge-active-peers" title="${countText} no momento">
              <span class="badge-active-peers-dot"></span>
              ${countText}
            </span>
          </div>
          <div class="lobby-room-meta">
            <span>ID: <code>${escapeHtml(roomId)}</code></span>
            ${memberNames ? `<span>•</span><span title="${escapeHtml(memberNames)}" style="max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(memberNames)}</span>` : ''}
          </div>
        </div>
        <div class="lobby-room-actions">
          <button type="button" class="btn-join-saved-room" title="Entrar nesta sala imediatamente">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>Entrar</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Associa cliques aos botões das salas renderizadas
  container.querySelectorAll('.lobby-room-card').forEach(card => {
    const roomId = card.getAttribute('data-room-id');
    const joinBtn = card.querySelector('.btn-join-saved-room');

    if (joinBtn) {
      joinBtn.onclick = (e) => {
        e.stopPropagation();
        if (roomInput) roomInput.value = roomId;
        startCall(roomId);
      };
    }

    card.onclick = () => {
      if (roomInput) roomInput.value = roomId;
    };
  });
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Recente';
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Agora';
  if (diffMin < 60) return `Há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Há ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `Há ${diffDays}d`;
}

// ============================================================================
// PRÉVIA DE MÍDIA NO LOBBY
// ============================================================================
let lobbyStream = null;
let lobbyAudioAnalyser = null;
let lobbyAudioInterval = null;

async function initLobbyPreview() {
  const videoEl = document.getElementById('lobby-preview-video');
  const fillEl = document.getElementById('lobby-audio-meter-fill');
  const previewBox = document.getElementById('lobby-preview-box');

  try {
    const audioConstraints = state.selectedAudioDeviceId 
      ? { deviceId: { exact: state.selectedAudioDeviceId } }
      : true;

    const videoConstraints = state.selectedVideoDeviceId 
      ? { deviceId: { exact: state.selectedVideoDeviceId } }
      : true;

    lobbyStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints
    });

    videoEl.srcObject = lobbyStream;

    // Medidor de áudio do Lobby
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(lobbyStream);
      lobbyAudioAnalyser = audioCtx.createAnalyser();
      lobbyAudioAnalyser.fftSize = 256;
      source.connect(lobbyAudioAnalyser);

      const buffer = new Uint8Array(lobbyAudioAnalyser.frequencyBinCount);
      if (lobbyAudioInterval) clearInterval(lobbyAudioInterval);

      lobbyAudioInterval = setInterval(() => {
        lobbyAudioAnalyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i];
        const avg = sum / buffer.length;
        const pct = Math.min(100, Math.round((avg / 60) * 100));
        fillEl.style.width = pct + '%';

        if (avg > 15) {
          previewBox.classList.add('speaking');
        } else {
          previewBox.classList.remove('speaking');
        }
      }, 80);
    }
  } catch (err) {
    console.warn('[Lobby] Permissão de câmera/microfone ainda não concedida:', err);
  }
}

// ============================================================================
// ENUMERAÇÃO DE DISPOSITIVOS (Microfones e Câmeras / OBS)
// ============================================================================
async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selectLobbyMic = document.getElementById('select-lobby-mic');
    const selectLobbyCam = document.getElementById('select-lobby-cam');
    const selectSettingsMic = document.getElementById('settings-select-mic');
    const selectSettingsCam = document.getElementById('settings-select-cam');

    selectLobbyMic.innerHTML = '';
    selectLobbyCam.innerHTML = '';
    selectSettingsMic.innerHTML = '';
    selectSettingsCam.innerHTML = '';

    let audioCount = 0;
    let videoCount = 0;

    devices.forEach(dev => {
      if (dev.kind === 'audioinput') {
        audioCount++;
        const label = dev.label || `Microfone ${audioCount}`;
        const opt1 = new Option(label, dev.deviceId);
        const opt2 = new Option(label, dev.deviceId);
        if (dev.deviceId === state.selectedAudioDeviceId) {
          opt1.selected = true;
          opt2.selected = true;
        }
        selectLobbyMic.add(opt1);
        selectSettingsMic.add(opt2);
      } else if (dev.kind === 'videoinput') {
        videoCount++;
        let label = dev.label || `Câmera ${videoCount}`;
        // Destaca OBS Virtual Camera ou ManyCam no nome
        if (label.toLowerCase().includes('obs') || label.toLowerCase().includes('virtual')) {
          label = `🎥 ${label} (Câmera Virtual)`;
        }
        const opt1 = new Option(label, dev.deviceId);
        const opt2 = new Option(label, dev.deviceId);
        if (dev.deviceId === state.selectedVideoDeviceId) {
          opt1.selected = true;
          opt2.selected = true;
        }
        selectLobbyCam.add(opt1);
        selectSettingsCam.add(opt2);
      }
    });

    const handleMicChange = async (deviceId) => {
      state.selectedAudioDeviceId = deviceId;
      StorageService.saveAudioDevice(deviceId);
      selectLobbyMic.value = deviceId;
      selectSettingsMic.value = deviceId;
      if (state.isInCall && state.webrtc) {
        await state.webrtc.switchAudioDevice(deviceId);
      } else {
        await initLobbyPreview();
      }
    };

    const handleCamChange = async (deviceId) => {
      state.selectedVideoDeviceId = deviceId;
      StorageService.saveVideoDevice(deviceId);
      selectLobbyCam.value = deviceId;
      selectSettingsCam.value = deviceId;
      if (state.isInCall && state.webrtc) {
        await state.webrtc.switchVideoDevice(deviceId);
      } else {
        await initLobbyPreview();
      }
    };

    selectLobbyMic.onchange = (e) => handleMicChange(e.target.value);
    selectSettingsMic.onchange = (e) => handleMicChange(e.target.value);

    selectLobbyCam.onchange = (e) => handleCamChange(e.target.value);
    selectSettingsCam.onchange = (e) => handleCamChange(e.target.value);

  } catch (err) {
    console.error('[Media] Erro ao enumerar dispositivos:', err);
  }
}

// ============================================================================
// INÍCIO E GERENCIAMENTO DA CHAMADA
// ============================================================================
async function startCall(roomId) {
  // Encerra stream prévia do lobby para liberar o hardware
  if (lobbyStream) {
    lobbyStream.getTracks().forEach(t => t.stop());
    lobbyStream = null;
  }
  if (lobbyAudioInterval) {
    clearInterval(lobbyAudioInterval);
    lobbyAudioInterval = null;
  }

  // Transiciona telas
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('call-screen').classList.remove('hidden');
  document.getElementById('call-room-title').textContent = roomId;
  state.isInCall = true;

  // Garante que o AudioContext do navegador não esteja em estado suspenso
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const dummyCtx = new AudioCtx();
      if (dummyCtx.state === 'suspended') {
        dummyCtx.resume().catch(() => {});
      }
    }
  } catch (e) {}

  // Por padrão, ao entrar na chamada NÃO liga a câmera automaticamente
  state.isVideoOff = true;
  updateCamUI();

  // Instancia controlador WebRTC Mesh
  state.webrtc = new TavernWebRTC({
    name: state.userName,
    role: state.userRole,
    audioDeviceId: state.selectedAudioDeviceId,
    videoDeviceId: state.selectedVideoDeviceId,
    noiseSuppressionMode: state.noiseSuppressionMode,
    noiseGateThreshold: state.noiseGateThreshold,

    onNoAudioWarning: (warningMsg) => {
      showNoAudioWarning(warningMsg);
    },

    onLocalStreamReady: (stream) => {
      const localVideo = document.getElementById('local-video');
      localVideo.srcObject = stream;
      localVideo.play().catch(() => {});
      updateAvatarVisuals();
    },

    onNoiseGateState: (isPassingVoice, currentAvg, threshold) => {
      updateNoiseGateIndicator(isPassingVoice, currentAvg, threshold);
    },

    onPeerStreamAdded: (peerId, peerInfo, remoteStream) => {
      addOrUpdatePeerTile(peerId, peerInfo, remoteStream);
      updateParticipantCount();
    },

    onLocalScreenStreamReady: (stream) => {
      addOrUpdateScreenTile('local', { name: state.userName + ' (Você)' }, stream);
    },

    onScreenShareEnded: () => {
      removeScreenTile('local');
    },

    onRemoteScreenStreamAdded: (peerId, peerInfo, stream) => {
      addOrUpdateScreenTile(peerId, peerInfo, stream);
      updateParticipantCount();
    },

    onRemoteScreenStreamEnded: (peerId) => {
      removeScreenTile(peerId);
      updateParticipantCount();
    },

    onPeerStreamRemoved: (peerId) => {
      removePeerTile(peerId);
      removeScreenTile(peerId);
      updateParticipantCount();
    },

    onPeerInfoUpdated: (peerId, peerInfo) => {
      updatePeerMetadata(peerId, peerInfo);
    },

    appVersion: APP_VERSION,

    onVersionMismatch: (data) => {
      showVersionMismatchModal(data.yourVersion || APP_VERSION, data.requiredVersion || data.peerVersion || 'Outra Versão');
      leaveCall();
    },

    onDiceBlockedStateChange: (blocked, gmName) => {
      state.diceBlockedForAll = blocked;
      updateDiceButtonsBlockedState();
      displayDiceToast(blocked ? `🎲 ${escapeHtml(gmName || 'O Mestre')} desabilitou a rolagem de dados para todos.` : `🎲 ${escapeHtml(gmName || 'O Mestre')} liberou a rolagem de dados!`);
    },

    onSpeakingState: (targetId, isSpeaking, volume) => {
      if (targetId === 'local') {
        const localTile = document.getElementById('tile-local');
        if (localTile) {
          if (isSpeaking) {
            localTile.classList.add('speaking');
          } else {
            localTile.classList.remove('speaking');
          }
        }
      } else {
        const peerTile = document.getElementById(`tile-${targetId}`);
        if (peerTile) {
          if (isSpeaking) {
            peerTile.classList.add('speaking');
          } else {
            peerTile.classList.remove('speaking');
          }
        }
      }

      // No modo Grid Destaque, quem fala ganha o espaço maior (até 50% da tela)
      if (isSpeaking && state.currentLayout === 'destaque') {
        setFeaturedSpeaker(targetId);
      }
    },

    onDataMessage: (peerId, data) => {
      if (data.type === 'rpg-dice-roll') {
        showDiceRollNotification(data);
      }
      if (data.type === 'gm-toggle-dice-rolling') {
        state.diceBlockedForAll = !!data.blocked;
        updateDiceButtonsBlockedState();
        displayDiceToast(data.blocked ? `🎲 ${escapeHtml(data.gmName || 'O Mestre')} desabilitou a rolagem de dados para todos.` : `🎲 ${escapeHtml(data.gmName || 'O Mestre')} liberou a rolagem de dados!`);
      }
      if (data.type === 'gm-mute-player') {
        if (data.targetId === 'all' || (state.webrtc && data.targetId === state.webrtc.myPeerId)) {
          handleGmMuteReceived(data.gmName || 'Mestre');
        }
      }
      if (data.type === 'gm-unmute-player') {
        if (data.targetId === 'all' || (state.webrtc && data.targetId === state.webrtc.myPeerId)) {
          handleGmUnmuteReceived(data.gmName || 'Mestre');
        }
      }
    },

    onStatusChange: (status) => {
      const iceDot = document.getElementById('call-ice-dot');
      const iceText = document.getElementById('call-ice-status');
      if (status.mode === 'server') {
        iceText.textContent = 'Servidor Conectado';
        iceDot.className = 'indicator-dot';
      } else if (status.mode === 'firebase') {
        iceText.textContent = 'Firebase Conectado';
        iceDot.className = 'indicator-dot';
      } else {
        iceText.textContent = 'Modo Local Mesh';
        iceDot.className = 'indicator-dot warning';
      }
    }
  });

  // Notificação e atualização de UI quando o compartilhamento de tela é interrompido
  state.webrtc.onScreenShareEnded = () => {
    const btnShareScreen = document.getElementById('btn-share-screen');
    if (btnShareScreen) {
      btnShareScreen.classList.remove('active-danger');
      btnShareScreen.setAttribute('data-tooltip', 'Compartilhar Tela');
    }
    removeScreenTile('local');
    showLayoutNotification('Transmissão de tela finalizada.');
  };

  try {
    await state.webrtc.joinRoom(roomId, {
      name: state.userName,
      role: state.userRole,
      audioMuted: state.isAudioMuted,
      videoOff: state.isVideoOff,
      appVersion: APP_VERSION
    });

    // Se entrou como Mestre (GM), exibe o botão de silenciar todos na barra superior
    const btnGmMuteAll = document.getElementById('btn-gm-mute-all');
    if (btnGmMuteAll) {
      if (state.userRole === 'mestre') {
        btnGmMuteAll.classList.remove('hidden');
        btnGmMuteAll.onclick = () => gmMuteAllPlayers();
      } else {
        btnGmMuteAll.classList.add('hidden');
      }
    }
  } catch (err) {
    console.error('[WebRTC] Erro ao entrar na sala:', err);
    if (err.message && err.message.startsWith('VERSION_MISMATCH')) {
      const parts = err.message.split(':');
      showVersionMismatchModal(parts[1] || APP_VERSION, parts[2] || 'Outra Versão');
    } else {
      alert('Erro ao conectar na sala: ' + err.message);
    }
    leaveCall();
  }
}

function leaveCall() {
  if (state.webrtc) {
    state.webrtc.leaveRoom();
    state.webrtc = null;
  }
  state.isInCall = false;

  const btnGmMuteAll = document.getElementById('btn-gm-mute-all');
  if (btnGmMuteAll) {
    btnGmMuteAll.classList.add('hidden');
  }

  const btnShareScreen = document.getElementById('btn-share-screen');
  if (btnShareScreen) {
    btnShareScreen.classList.remove('active-danger');
    btnShareScreen.setAttribute('data-tooltip', 'Compartilhar Tela');
  }

  const tileLocal = document.getElementById('tile-local');
  if (tileLocal) {
    tileLocal.classList.remove('is-screen-sharing');
    tileLocal.classList.remove('screen-share');
  }

  state.localStreamMutes = {};

  // Limpa tiles remotos
  const grid = document.getElementById('video-grid');
  const tiles = grid.querySelectorAll('.video-tile:not(#tile-local)');
  tiles.forEach(t => t.remove());
  grid.setAttribute('data-count', '1');

  // Volta para a tela de Lobby
  document.getElementById('no-audio-warning-banner')?.classList.add('hidden');
  document.getElementById('call-screen').classList.add('hidden');
  document.getElementById('lobby-screen').classList.remove('hidden');
  fetchActiveRoomsFromFirebase();
  initLobbyPreview();
}

// ============================================================================
// GESTÃO DINÂMICA DO VIDEO GRID (Tiles de Participantes)
// ============================================================================
function addOrUpdatePeerTile(peerId, peerInfo, stream) {
  const grid = document.getElementById('video-grid');
  let tile = document.getElementById(`tile-${peerId}`);

  // Volume inicial salvo ou padrão 100%
  if (state.peerVolumes[peerId] === undefined) {
    state.peerVolumes[peerId] = 100;
  }
  const currentVol = state.peerVolumes[peerId];

  if (!tile) {
    // Toca som de entrada e exibe aviso de presença
    playPresenceSound('join');
    showPresenceToast(`${peerInfo.name || 'Um aventureiro'} entrou na conversa`, 'join');

    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${peerId}`;

    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <audio autoplay playsinline id="audio-${peerId}"></audio>
      <div class="avatar-fallback ${peerInfo.role === 'mestre' ? 'mestre' : ''}" id="avatar-${peerId}" style="display: none;">
        <span class="avatar-class-icon" style="font-size: 32px; margin-bottom: 6px;">${peerInfo.classIcon || '⚔️'}</span>
        <span class="avatar-name" style="font-size: 13px; font-weight: 600; color: var(--text-bright); text-align: center; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(peerInfo.name || 'Aventureiro')}</span>
      </div>
      <div class="tile-overlay">
        <div class="tile-participant-info">
          <span class="participant-name" id="name-${peerId}">${escapeHtml(peerInfo.name || 'Aventureiro')}</span>
          <span class="badge-role ${peerInfo.role === 'mestre' ? 'mestre' : 'jogador'}">${peerInfo.role === 'mestre' ? 'Mestre' : 'Jogador'}</span>
          <span class="tile-live-badge ${peerInfo.isScreenSharing ? '' : 'hidden'}" id="badge-live-${peerId}">AO VIVO</span>
          <span class="tile-stream-muted-badge ${state.localStreamMutes[peerId] ? '' : 'hidden'}" id="badge-stream-muted-${peerId}">🔇 Mutado Local</span>
        </div>
        <div class="tile-status-icons">
          <!-- Botão para Mutar Transmissão Localmente (Apenas para este espectador) -->
          <button class="tile-stream-mute-btn ${state.localStreamMutes[peerId] ? 'is-muted' : ''} ${peerInfo.isScreenSharing ? '' : 'hidden'}" id="btn-stream-mute-${peerId}" title="Mutar áudio da transmissão apenas para mim" type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
            <span id="txt-stream-mute-${peerId}">${state.localStreamMutes[peerId] ? 'Transmissão Mutada' : 'Mutar Transmissão'}</span>
          </button>

          <!-- Controle de Volume Individual -->
          <div class="tile-volume-wrapper" id="vol-wrap-${peerId}">
            <button class="tile-volume-btn ${currentVol === 0 ? 'is-muted' : ''}" id="btn-vol-${peerId}" title="Ajuste de volume de ${escapeHtml(peerInfo.name || 'Aventureiro')}" type="button">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
            <div class="tile-volume-popover hidden" id="popover-vol-${peerId}">
              <div class="tile-volume-popover-header">
                <span>Volume</span>
                <span class="tile-volume-percent" id="vol-val-${peerId}">${currentVol}%</span>
              </div>
              <input type="range" class="tile-volume-slider" id="slider-vol-${peerId}" min="0" max="200" value="${currentVol}" step="5" />
              
              <!-- Ação no popover para mutar transmissão localmente -->
              <div class="tile-volume-popover-stream-action ${peerInfo.isScreenSharing ? '' : 'hidden'}" id="popover-stream-action-${peerId}">
                <button class="btn btn-secondary" id="btn-popover-stream-mute-${peerId}" style="width: 100%; font-size: 11px; padding: 4px 6px;" type="button">
                  ${state.localStreamMutes[peerId] ? '🔊 Desmutar Transmissão' : '🔇 Mutar Transmissão para Mim'}
                </button>
              </div>

              ${state.userRole === 'mestre' ? `
                <div class="tile-volume-popover-gm-action">
                  <button class="btn btn-secondary" id="btn-popover-gm-mute-${peerId}" style="width: 100%; font-size: 11px; padding: 4px 6px; color: var(--accent-gold); border-color: rgba(240, 178, 50, 0.4);" type="button">
                    👑 ${peerInfo.audioMuted ? 'Permitir Voz' : 'Silenciar Jogador'}
                  </button>
                </div>
              ` : ''}
            </div>
          </div>

          <!-- Botão do Mestre para Mutar Jogador -->
          ${state.userRole === 'mestre' ? `
            <button class="tile-gm-mute-btn ${peerInfo.audioMuted ? 'is-muted' : ''}" id="btn-gm-mute-${peerId}" title="Silenciar microfone deste jogador (Comando do Mestre)" type="button">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="1" y1="1" x2="23" y2="23"/>
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
                <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
              <span id="txt-gm-mute-${peerId}">${peerInfo.audioMuted ? 'Silenciado' : 'Silenciar'}</span>
            </button>
          ` : ''}

          <span class="tile-icon-badge ${peerInfo.audioMuted ? 'muted' : ''}" id="icon-audio-${peerId}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
          </span>
          <span class="tile-icon-badge ${peerInfo.videoOff ? 'muted' : ''}" id="icon-video-${peerId}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </span>
        </div>
      </div>
    `;

    grid.appendChild(tile);

    // Clique duplo para tela cheia
    tile.ondblclick = (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        tile.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    };

    // Eventos do botão de volume
    const btnVol = tile.querySelector(`#btn-vol-${peerId}`);
    const popoverVol = tile.querySelector(`#popover-vol-${peerId}`);
    const sliderVol = tile.querySelector(`#slider-vol-${peerId}`);

    if (btnVol && popoverVol && sliderVol) {
      btnVol.onclick = (e) => {
        e.stopPropagation();
        // Fecha outros popovers se abertos
        document.querySelectorAll('.tile-volume-popover').forEach(p => {
          if (p !== popoverVol) p.classList.add('hidden');
        });
        popoverVol.classList.toggle('hidden');
      };

      sliderVol.onclick = (e) => e.stopPropagation();
      sliderVol.oninput = (e) => {
        const val = parseInt(e.target.value, 10);
        setPeerVolume(peerId, val);
      };
    }

    // Eventos de mutar transmissão pelo espectador
    const btnStreamMute = tile.querySelector(`#btn-stream-mute-${peerId}`);
    const btnPopoverStreamMute = tile.querySelector(`#btn-popover-stream-mute-${peerId}`);
    const handleStreamMuteClick = (e) => {
      e.stopPropagation();
      toggleLocalStreamMute(peerId, peerInfo);
    };
    if (btnStreamMute) btnStreamMute.onclick = handleStreamMuteClick;
    if (btnPopoverStreamMute) btnPopoverStreamMute.onclick = handleStreamMuteClick;

    // Eventos exclusivos do Mestre para silenciar/desmutar o jogador
    if (state.userRole === 'mestre') {
      const btnGmMute = tile.querySelector(`#btn-gm-mute-${peerId}`);
      const btnPopoverGmMute = tile.querySelector(`#btn-popover-gm-mute-${peerId}`);
      const handleGmMuteAction = (e) => {
        e.stopPropagation();
        toggleGmMutePlayer(peerId, peerInfo);
      };

      if (btnGmMute) btnGmMute.onclick = handleGmMuteAction;
      if (btnPopoverGmMute) btnPopoverGmMute.onclick = handleGmMuteAction;
    }
  }

  const video = tile.querySelector('video');
  const audio = tile.querySelector('audio');
  const avatarEl = tile.querySelector(`#avatar-${peerId}`);

  const hasLiveVideoTrack = stream && stream.getVideoTracks && stream.getVideoTracks().length > 0 && stream.getVideoTracks().some(t => t.enabled !== false && t.readyState === 'live');
  const isVideoVisible = (peerInfo.videoOff === false) || hasLiveVideoTrack;

  if (avatarEl && video) {
    if (!isVideoVisible) {
      avatarEl.style.display = 'flex';
      video.style.display = 'none';
    } else {
      avatarEl.style.display = 'none';
      video.style.display = 'block';
    }
  }

  if (video) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.muted = true; // Vídeo sempre mutado para não duplicar som
    video.play().catch(() => {});
  }
  if (audio) {
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    const isMuted = (currentVol === 0 || !!state.localStreamMutes[peerId]);
    audio.muted = isMuted;
    audio.volume = isMuted ? 0 : Math.min(1.0, currentVol / 100);
    const p = audio.play();
    if (p !== undefined) {
      p.catch(err => {
        console.warn(`[Audio] Autoplay inicial aguardando interação para ${peerId}:`, err.message);
        const unlock = () => {
          audio.play().catch(() => {});
          window.removeEventListener('click', unlock);
          window.removeEventListener('keydown', unlock);
        };
        window.addEventListener('click', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
      });
    }
  }
  setPeerVolume(peerId, currentVol);

  scheduleGridLayoutUpdate();
}

/**
 * Permite ao espectador mutar a transmissão de outro usuário exclusivamente para si mesmo
 */
function toggleLocalStreamMute(peerId, peerInfo) {
  const isCurrentlyMuted = !!state.localStreamMutes[peerId];
  const nextMuted = !isCurrentlyMuted;
  state.localStreamMutes[peerId] = nextMuted;

  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;

  const audio = tile.querySelector('audio');
  const video = tile.querySelector('video');
  if (audio) {
    audio.muted = nextMuted || (state.peerVolumes[peerId] === 0);
  }
  if (video) {
    video.muted = true;
  }

  const btn = document.getElementById(`btn-stream-mute-${peerId}`);
  const txt = document.getElementById(`txt-stream-mute-${peerId}`);
  const popoverBtn = document.getElementById(`btn-popover-stream-mute-${peerId}`);
  const badgeMuted = document.getElementById(`badge-stream-muted-${peerId}`);

  const playerName = peerInfo?.name || (tile ? tile.querySelector('.participant-name')?.textContent : 'Jogador') || 'Jogador';

  if (nextMuted) {
    if (btn) btn.classList.add('is-muted');
    if (txt) txt.textContent = 'Transmissão Mutada';
    if (popoverBtn) popoverBtn.textContent = '🔊 Desmutar Transmissão';
    if (badgeMuted) badgeMuted.classList.remove('hidden');
    showLayoutNotification(`🔇 Transmissão de ${escapeHtml(playerName)} mutada apenas para você.`);
  } else {
    if (btn) btn.classList.remove('is-muted');
    if (txt) txt.textContent = 'Mutar Transmissão';
    if (popoverBtn) popoverBtn.textContent = '🔇 Mutar Transmissão para Mim';
    if (badgeMuted) badgeMuted.classList.add('hidden');
    showLayoutNotification(`🔊 Transmissão de ${escapeHtml(playerName)} desmutada.`);
  }
}

function setPeerVolume(peerId, val) {
  state.peerVolumes[peerId] = val;
  const tile = document.getElementById(`tile-${peerId}`);
  if (!tile) return;

  const audio = tile.querySelector('audio');
  const video = tile.querySelector('video');
  const label = tile.querySelector(`#vol-val-${peerId}`);
  const btn = tile.querySelector(`#btn-vol-${peerId}`);

  if (label) label.textContent = `${val}%`;

  const isMuted = (val === 0 || !!state.localStreamMutes[peerId]);
  const targetVolume = isMuted ? 0 : Math.min(1.0, val / 100);

  if (audio) {
    audio.muted = isMuted;
    audio.volume = targetVolume;
    if (!isMuted && audio.paused) {
      audio.play().catch(() => {});
    }
  }

  if (video) {
    video.muted = true; // Mantém vídeo sempre mutado
  }

  if (btn) {
    if (isMuted) btn.classList.add('is-muted');
    else btn.classList.remove('is-muted');
  }
}

function removePeerTile(peerId) {
  peerTileCache.delete(peerId);
  const tile = document.getElementById(`tile-${peerId}`);
  let peerName = 'Um aventureiro';
  if (tile) {
    const nameEl = tile.querySelector('.participant-name');
    if (nameEl && nameEl.textContent) {
      peerName = nameEl.textContent;
    }
    tile.remove();
  }
  removeScreenTile(peerId);
  // Toca som de saída e exibe aviso de presença
  playPresenceSound('leave');
  showPresenceToast(`${peerName} saiu da conversa`, 'leave');
  scheduleGridLayoutUpdate();
}

function addOrUpdateScreenTile(peerId, peerInfo, stream) {
  const grid = document.getElementById('video-grid');
  if (!grid) return;

  const tileId = `tile-${peerId}-screen`;
  let tile = document.getElementById(tileId);

  const titleName = peerId === 'local' ? 'Sua Tela' : `${peerInfo?.name || 'Aventureiro'} (Tela)`;
  const currentVol = state.peerVolumes[`${peerId}-screen`] !== undefined ? state.peerVolumes[`${peerId}-screen`] : 100;

  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile is-screen-sharing screen-share';
    tile.id = tileId;
    tile.innerHTML = `
      <video autoplay playsinline ${peerId === 'local' ? 'muted' : ''}></video>
      <audio autoplay playsinline style="display:none;" ${peerId === 'local' ? 'muted' : ''}></audio>
      <div class="screen-tile-overlay">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span class="participant-name">🖥️ ${escapeHtml(titleName)}</span>
          <span class="screen-audio-badge" id="badge-audio-screen-${peerId}"></span>
        </div>
        <div class="tile-status-icons" style="display: flex; gap: 6px; align-items: center;">
          ${peerId !== 'local' ? `
            <button class="btn btn-unmute-screen hidden" id="btn-unmute-screen-${peerId}" title="Clique para ouvir o áudio transmitido" style="font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer;" type="button">
              🔊 Ativar Som
            </button>
          ` : ''}
          <div class="tile-volume-wrapper">
            <button class="tile-volume-btn ${currentVol === 0 ? 'is-muted' : ''}" id="btn-vol-screen-${peerId}" title="Volume da transmissão de tela" type="button">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
            <div class="tile-volume-popover hidden" id="popover-vol-screen-${peerId}">
              <div class="tile-volume-popover-header">
                <span>Volume Tela</span>
                <span class="tile-volume-percent" id="vol-val-screen-${peerId}">${currentVol}%</span>
              </div>
              <input type="range" class="tile-volume-slider" id="slider-vol-screen-${peerId}" min="0" max="200" value="${currentVol}" step="5" />
            </div>
          </div>
          <button class="btn btn-secondary" id="btn-close-screen-${peerId}" title="Fechar esta transmissão apenas para mim" style="font-size: 10px; padding: 2px 6px; background: rgba(220,50,50,0.3); border-color: rgba(220,50,50,0.5);" type="button">❌ Fechar</button>
        </div>
      </div>
    `;
    grid.appendChild(tile);

    const btnUnmute = tile.querySelector(`#btn-unmute-screen-${peerId}`);
    if (btnUnmute) {
      btnUnmute.onclick = (e) => {
        e.stopPropagation();
        const v = tile.querySelector('video');
        const a = tile.querySelector('audio');
        const currentV = state.peerVolumes[`${peerId}-screen`] !== undefined ? state.peerVolumes[`${peerId}-screen`] : 100;
        if (v) { v.muted = false; v.volume = currentV / 100; v.play().catch(() => {}); }
        if (a) { a.muted = false; a.volume = currentV / 100; a.play().catch(() => {}); }
        btnUnmute.classList.add('hidden');
      };
    }

    const btnVol = tile.querySelector(`#btn-vol-screen-${peerId}`);
    const popoverVol = tile.querySelector(`#popover-vol-screen-${peerId}`);
    const sliderVol = tile.querySelector(`#slider-vol-screen-${peerId}`);
    const valSpan = tile.querySelector(`#vol-val-screen-${peerId}`);

    if (btnVol && popoverVol && sliderVol) {
      btnVol.onclick = (e) => {
        e.stopPropagation();
        popoverVol.classList.toggle('hidden');
      };
      sliderVol.onclick = (e) => e.stopPropagation();
      sliderVol.oninput = (e) => {
        const val = parseInt(e.target.value, 10);
        state.peerVolumes[`${peerId}-screen`] = val;
        if (valSpan) valSpan.textContent = `${val}%`;
        const videoEl = tile.querySelector('video');
        const audioEl = tile.querySelector('audio');
        const isMuted = (val === 0);
        if (videoEl) {
          videoEl.volume = val / 100;
          videoEl.muted = isMuted;
          videoEl.play().catch(() => {});
        }
        if (audioEl) {
          audioEl.volume = val / 100;
          audioEl.muted = isMuted;
          audioEl.play().catch(() => {});
        }
        if (val === 0) btnVol.classList.add('is-muted');
        else btnVol.classList.remove('is-muted');
      };
    }

    const btnClose = tile.querySelector(`#btn-close-screen-${peerId}`);
    if (btnClose) {
      btnClose.onclick = (e) => {
        e.stopPropagation();
        removeScreenTile(peerId);
        showLayoutNotification('🖥️ Transmissão fechada localmente.');
      };
    }

    tile.onclick = () => {
      // Interação do usuário desmuta o áudio caso o navegador tenha bloqueado autoplay
      if (peerId !== 'local') {
        const vol = state.peerVolumes[`${peerId}-screen`] !== undefined ? state.peerVolumes[`${peerId}-screen`] : 100;
        if (vol > 0) {
          const v = tile.querySelector('video');
          const a = tile.querySelector('audio');
          const b = tile.querySelector(`#btn-unmute-screen-${peerId}`);
          if (v && v.muted) { v.muted = false; v.volume = vol / 100; v.play().catch(() => {}); }
          if (a && a.muted) { a.muted = false; a.volume = vol / 100; a.play().catch(() => {}); }
          if (b) b.classList.add('hidden');
        }
      }
    };

    tile.ondblclick = (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        tile.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    };
  }

  const hasAudioTrack = (stream && stream.getAudioTracks().length > 0) || (peerInfo && peerInfo.hasScreenAudio);
  const audioBadge = tile.querySelector(`#badge-audio-screen-${peerId}`);
  if (audioBadge) {
    if (peerId === 'local') {
      if (hasAudioTrack) {
        audioBadge.innerHTML = '🔊 <span style="color:#68d391; font-weight:600;">Áudio do sistema ativo</span>';
      } else {
        audioBadge.innerHTML = '🔇 <span style="color:var(--text-muted);">Sem áudio do sistema</span>';
      }
    } else {
      if (hasAudioTrack) {
        audioBadge.innerHTML = '🔊 <span style="color:#68d391; font-weight:600;">Com áudio</span>';
      } else {
        audioBadge.innerHTML = '🔇 <span style="color:var(--text-muted);">Sem áudio</span>';
      }
    }
  }

  const video = tile.querySelector('video');
  const audio = tile.querySelector('audio');
  const btnUnmute = tile.querySelector(`#btn-unmute-screen-${peerId}`);
  const vol = state.peerVolumes[`${peerId}-screen`] !== undefined ? state.peerVolumes[`${peerId}-screen`] : 100;
  const isMuted = peerId === 'local' || vol === 0;

  if (video) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.volume = vol / 100;
    video.muted = isMuted;
    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        console.warn('[ScreenShare] Autoplay com som bloqueado pelo navegador. Ativando muted e botão:', err);
        video.muted = true;
        video.play().catch(e => console.error('[ScreenShare] Erro na reprodução de tela:', e));
        if (btnUnmute && peerId !== 'local' && hasAudioTrack) {
          btnUnmute.classList.remove('hidden');
        }
      });
    }
  }

  if (audio && stream && peerId !== 'local') {
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.volume = vol / 100;
    audio.muted = isMuted;
    audio.play().catch((err) => {
      console.warn('[ScreenShare] Autoplay do elemento <audio> bloqueado:', err);
      if (btnUnmute && hasAudioTrack) {
        btnUnmute.classList.remove('hidden');
      }
    });
  }
  updateParticipantCount();
  applyGridLayout(state.currentLayout);
}

function removeScreenTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}-screen`);
  if (tile) {
    const video = tile.querySelector('video');
    const audio = tile.querySelector('audio');
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch (e) {}
    }
    if (audio) {
      try {
        audio.pause();
        audio.srcObject = null;
      } catch (e) {}
    }
    tile.remove();
  }

  const grid = document.getElementById('video-grid');
  const remainingScreenTiles = document.querySelectorAll('.video-tile.screen-share');
  if (grid && remainingScreenTiles.length === 0) {
    grid.classList.remove('has-screen-share');
  }

  updateParticipantCount();
  applyGridLayout(state.currentLayout);
}

// Cache de memoização para evitar re-renderizações e reflows desnecessários no Grid de Vídeo
const peerTileCache = new Map();
let gridLayoutRaf = null;

function scheduleGridLayoutUpdate() {
  if (gridLayoutRaf) return;
  gridLayoutRaf = requestAnimationFrame(() => {
    gridLayoutRaf = null;
    applyGridLayout(state.currentLayout);
  });
}

function updatePeerMetadata(peerId, peerInfo) {
  if (!peerInfo) return;

  const cached = peerTileCache.get(peerId);
  // Memoização: se nenhum estado relevante mudou, evita tocar no DOM
  if (cached &&
      cached.name === peerInfo.name &&
      cached.audioMuted === peerInfo.audioMuted &&
      cached.videoOff === peerInfo.videoOff &&
      cached.isSpeaking === peerInfo.isSpeaking &&
      cached.isScreenSharing === peerInfo.isScreenSharing) {
    return;
  }

  peerTileCache.set(peerId, {
    name: peerInfo.name,
    audioMuted: peerInfo.audioMuted,
    videoOff: peerInfo.videoOff,
    isSpeaking: peerInfo.isSpeaking,
    isScreenSharing: peerInfo.isScreenSharing
  });

  const nameEl = document.getElementById(`name-${peerId}`);
  const audioIcon = document.getElementById(`icon-audio-${peerId}`);
  const videoIcon = document.getElementById(`icon-video-${peerId}`);
  const avatarEl = document.getElementById(`avatar-${peerId}`);
  const tile = document.getElementById(`tile-${peerId}`);

  if (nameEl && (!cached || cached.name !== peerInfo.name)) {
    nameEl.textContent = peerInfo.name;
  }
  if (audioIcon && (!cached || cached.audioMuted !== peerInfo.audioMuted)) {
    if (peerInfo.audioMuted) audioIcon.classList.add('muted');
    else audioIcon.classList.remove('muted');
  }
  if (!peerInfo.isScreenSharing) {
    removeScreenTile(peerId);
  }
  if (videoIcon && tile && (!cached || cached.videoOff !== peerInfo.videoOff)) {
    const video = tile.querySelector('video');
    const hasLiveVideo = video && video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks().some(t => t.enabled !== false && t.readyState === 'live');
    const showVideo = (peerInfo.videoOff === false) || (!peerInfo.videoOff && hasLiveVideo);

    if (!showVideo && peerInfo.videoOff) {
      videoIcon.classList.add('muted');
      if (avatarEl) avatarEl.style.display = 'flex';
      if (video) video.style.display = 'none';
    } else {
      videoIcon.classList.remove('muted');
      if (avatarEl) avatarEl.style.display = 'none';
      if (video) {
        video.style.display = 'block';
        video.play().catch(() => {});
      }
    }
  }

  if (tile && (!cached || cached.isSpeaking !== peerInfo.isSpeaking)) {
    if (peerInfo.isSpeaking) {
      tile.classList.add('speaking');
    } else {
      tile.classList.remove('speaking');
    }
  }

  // Indicador de transmissão de tela ao vivo e botão de mutar pelo espectador
  const liveBadge = document.getElementById(`badge-live-${peerId}`);
  const streamMuteBtn = document.getElementById(`btn-stream-mute-${peerId}`);
  const popoverStreamAction = document.getElementById(`popover-stream-action-${peerId}`);

  if (peerInfo.isScreenSharing) {
    if (liveBadge) liveBadge.classList.remove('hidden');
    if (streamMuteBtn) streamMuteBtn.classList.remove('hidden');
    if (popoverStreamAction) popoverStreamAction.classList.remove('hidden');
  } else {
    if (liveBadge) liveBadge.classList.add('hidden');
    if (streamMuteBtn) streamMuteBtn.classList.add('hidden');
    if (popoverStreamAction) popoverStreamAction.classList.add('hidden');
  }

  // Atualiza estado do botão de silenciamento do Mestre se presente
  const gmMuteBtn = document.getElementById(`btn-gm-mute-${peerId}`);
  const gmMuteTxt = document.getElementById(`txt-gm-mute-${peerId}`);
  const popoverGmBtn = document.getElementById(`btn-popover-gm-mute-${peerId}`);

  if (gmMuteBtn && gmMuteTxt) {
    if (peerInfo.audioMuted) {
      gmMuteBtn.classList.add('is-muted');
      gmMuteTxt.textContent = 'Silenciado';
    } else {
      gmMuteBtn.classList.remove('is-muted');
      gmMuteTxt.textContent = 'Silenciar';
    }
  }
  if (popoverGmBtn) {
    popoverGmBtn.textContent = peerInfo.audioMuted ? '👑 Permitir Voz' : '👑 Silenciar Jogador';
  }
}

// ============================================================================
// CÁLCULO DINÂMICO DE GRADE DE VÍDEO (1 a 15 Câmeras)
// ============================================================================
/**
 * Calcula colunas e linhas ideais para que n câmeras preencham a tela toda
 * com proporção de aspecto próxima de 16:9, evitando scroll horizontal/vertical.
 *
 * Mapeamento otimizado para telas widescreen (16:9 / 16:10 / ultrawide):
 *  1  -> 1 col x 1 lin
 *  2  -> 2 cols x 1 lin
 *  3  -> 3 cols x 1 lin
 *  4  -> 2 cols x 2 lins
 *  5, 6 -> 3 cols x 2 lins
 *  7, 8 -> 4 cols x 2 lins
 *  9, 10, 11, 12 -> 4 cols x 3 lins
 *  13, 14, 15 -> 5 cols x 3 lins
 */
function computeGridLayout(n) {
  const count = Math.max(1, Math.min(15, n || 1));
  let cols, rows;

  if (count === 1) {
    cols = 1; rows = 1;
  } else if (count === 2) {
    cols = 2; rows = 1;
  } else if (count === 3) {
    cols = 3; rows = 1;
  } else if (count === 4) {
    cols = 2; rows = 2;
  } else if (count <= 6) {
    cols = 3; rows = 2;
  } else if (count <= 8) {
    cols = 4; rows = 2;
  } else if (count <= 12) {
    cols = 4; rows = 3;
  } else {
    // 13 a 15 câmeras
    cols = 5; rows = 3;
  }

  return { cols, rows };
}

function updateParticipantCount() {
  const grid = document.getElementById('video-grid');
  if (!grid) return;

  const realTiles = grid.querySelectorAll('.video-tile:not(.empty-slot)').length;
  const countEl = document.getElementById('call-participant-count');
  if (countEl) {
    countEl.textContent = `${realTiles}/${MAX_PARTICIPANTS} Aventureiros`;
  }

  // Define total de elementos a acomodar no grid:
  // - No modo Fixo: acomoda a quantidade de vagas escolhida (state.fixedGridSlots)
  // - Nos outros modos: acomoda os tiles reais existentes
  let totalForLayout = realTiles;
  if (state.currentLayout === 'fixo') {
    totalForLayout = Math.max(realTiles, state.fixedGridSlots);
  }

  const screenTiles = grid.querySelectorAll('.video-tile.screen-share, .video-tile.is-screen-sharing');
  if (screenTiles.length > 0) {
    grid.classList.add('has-screen-share');
  } else {
    grid.classList.remove('has-screen-share');
  }

  // Atribui variáveis CSS --grid-cols e --grid-rows para o CSS calcular perfeitamente
  const { cols, rows } = computeGridLayout(totalForLayout);
  grid.style.setProperty('--grid-cols', cols);
  grid.style.setProperty('--grid-rows', rows);

  grid.setAttribute('data-count', totalForLayout.toString());
}

// ============================================================================
// AÇÕES DE MESTRE: SILENCIAR JOGADORES
// ============================================================================
function toggleGmMutePlayer(peerId, peerInfo) {
  if (state.userRole !== 'mestre' || !state.webrtc) return;

  const tile = document.getElementById(`tile-${peerId}`);
  const gmMuteBtn = document.getElementById(`btn-gm-mute-${peerId}`);
  const isCurrentlyMuted = gmMuteBtn && gmMuteBtn.classList.contains('is-muted');
  const playerName = peerInfo?.name || (tile ? tile.querySelector('.participant-name')?.textContent : 'Jogador') || 'Jogador';

  if (!isCurrentlyMuted) {
    // Mestre silencia o microfone do jogador
    state.webrtc.broadcastRpgAction({
      type: 'gm-mute-player',
      targetId: peerId,
      targetName: playerName,
      gmName: state.userName
    });

    // Muta também localmente para corte de áudio imediato
    setPeerVolume(peerId, 0);

    const txt = document.getElementById(`txt-gm-mute-${peerId}`);
    if (gmMuteBtn) gmMuteBtn.classList.add('is-muted');
    if (txt) txt.textContent = 'Silenciado';

    const popoverGmBtn = document.getElementById(`btn-popover-gm-mute-${peerId}`);
    if (popoverGmBtn) popoverGmBtn.textContent = '👑 Permitir Voz';

    showLayoutNotification(`👑 Você silenciou o microfone de ${escapeHtml(playerName)}`);
  } else {
    // Mestre autoriza a voz do jogador
    state.webrtc.broadcastRpgAction({
      type: 'gm-unmute-player',
      targetId: peerId,
      targetName: playerName,
      gmName: state.userName
    });

    // Restaura o volume para 100%
    setPeerVolume(peerId, 100);

    const txt = document.getElementById(`txt-gm-mute-${peerId}`);
    if (gmMuteBtn) gmMuteBtn.classList.remove('is-muted');
    if (txt) txt.textContent = 'Silenciar';

    const popoverGmBtn = document.getElementById(`btn-popover-gm-mute-${peerId}`);
    if (popoverGmBtn) popoverGmBtn.textContent = '👑 Silenciar Jogador';

    showLayoutNotification(`👑 Você autorizou a voz de ${escapeHtml(playerName)}`);
  }
}

function gmMuteAllPlayers() {
  if (state.userRole !== 'mestre' || !state.webrtc) return;

  // Envia comando para todos os jogadores silenciarem seus microfones
  state.webrtc.broadcastRpgAction({
    type: 'gm-mute-player',
    targetId: 'all',
    gmName: state.userName
  });

  // Muta volume local de todos os remotos para corte imediato
  const grid = document.getElementById('video-grid');
  const remoteTiles = grid.querySelectorAll('.video-tile:not(#tile-local)');
  remoteTiles.forEach(tile => {
    const peerId = tile.id.replace('tile-', '');
    setPeerVolume(peerId, 0);
    const btn = tile.querySelector(`#btn-gm-mute-${peerId}`);
    const txt = tile.querySelector(`#txt-gm-mute-${peerId}`);
    if (btn) btn.classList.add('is-muted');
    if (txt) txt.textContent = 'Silenciado';
    const popoverGmBtn = tile.querySelector(`#btn-popover-gm-mute-${peerId}`);
    if (popoverGmBtn) popoverGmBtn.textContent = '👑 Permitir Voz';
  });

  showLayoutNotification('👑 Você silenciou todos os jogadores da mesa');
}

function handleGmMuteReceived(gmName) {
  // Se o microfone local estiver ativo, desativa-o imediatamente
  if (!state.isAudioMuted) {
    setAudioMute(true);
  }
  showLayoutNotification(`👑 O Mestre (${escapeHtml(gmName)}) silenciou seu microfone!`);
}

function handleGmUnmuteReceived(gmName) {
  showLayoutNotification(`👑 O Mestre (${escapeHtml(gmName)}) autorizou que você fale novamente.`);
}

// ============================================================================
// GESTÃO DOS MODOS DE EXIBIÇÃO DE VÍDEO (Layout Grid: Móvel, Fixo, Destaque)
// ============================================================================
function applyGridLayout(layoutMode, notifyUser = false) {
  const allowed = ['movel', 'fixo', 'destaque'];
  if (!allowed.includes(layoutMode)) layoutMode = 'movel';

  state.currentLayout = layoutMode;
  StorageService.saveLayoutMode(layoutMode);

  const grid = document.getElementById('video-grid');
  if (!grid) return;

  // Atualiza classes no elemento do grid
  grid.classList.remove('layout-movel', 'layout-fixo', 'layout-destaque');
  grid.classList.add(`layout-${layoutMode}`);

  // Atualiza botão do cabeçalho
  const iconSpan = document.getElementById('layout-active-icon') || document.getElementById('current-layout-icon');
  const textSpan = document.getElementById('layout-active-label') || document.getElementById('current-layout-text');
  const layoutLabels = {
    movel: { icon: '🔀', text: 'Grid Móvel' },
    fixo: { icon: '🏛️', text: 'Grid Fixo' },
    destaque: { icon: '⭐', text: 'Grid Destaque' }
  };

  if (iconSpan) iconSpan.textContent = layoutLabels[layoutMode].icon;
  if (textSpan) textSpan.textContent = layoutLabels[layoutMode].text;

  // Atualiza active nos itens do dropdown
  document.querySelectorAll('.layout-dropdown-item').forEach(item => {
    if (item.getAttribute('data-layout') === layoutMode) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Atualiza active nos cards do modal de configurações
  document.querySelectorAll('.layout-card-option').forEach(card => {
    const radio = card.querySelector('input[type="radio"]');
    if (radio && radio.value === layoutMode) {
      radio.checked = true;
      card.classList.add('active');
    } else {
      if (radio) radio.checked = false;
      card.classList.remove('active');
    }
  });

  // Lógica específica de cada modo:
  if (layoutMode === 'fixo') {
    // Modo Fixo: remove slots vazios anteriores e recria até completar state.fixedGridSlots vagas
    grid.querySelectorAll('.empty-slot').forEach(el => el.remove());
    grid.querySelectorAll('.video-tile').forEach(t => t.classList.remove('featured-speaker'));

    const realTiles = grid.querySelectorAll('.video-tile:not(.empty-slot)').length;
    const slotsNeeded = Math.max(0, state.fixedGridSlots - realTiles);

    for (let i = 0; i < slotsNeeded; i++) {
      const emptySlot = document.createElement('div');
      emptySlot.className = 'video-tile empty-slot';
      emptySlot.innerHTML = `
        <div class="empty-slot-content">
          <span>🛡️</span>
          <span>Vaga de Aventureiro</span>
          <span class="empty-slot-sub">Aguardando jogador...</span>
        </div>
      `;
      grid.appendChild(emptySlot);
    }
  } else if (layoutMode === 'destaque') {
    // Modo Destaque: remove slots vazios e atribui destaque a quem está falando
    grid.querySelectorAll('.empty-slot').forEach(el => el.remove());
    setFeaturedSpeaker(state.activeSpeakerId || 'local');
  } else {
    // Modo Móvel: remove slots vazios e remove classes de destaque
    grid.querySelectorAll('.empty-slot').forEach(el => el.remove());
    grid.querySelectorAll('.video-tile').forEach(t => t.classList.remove('featured-speaker'));
  }

  // Atualiza controle rápido de vagas fixas no cabeçalho
  const fixedHeaderCtrl = document.getElementById('fixed-slots-header-control');
  if (fixedHeaderCtrl) {
    fixedHeaderCtrl.style.display = (layoutMode === 'fixo') ? 'inline-flex' : 'none';
  }
  const labelSlots = document.getElementById('label-fixed-slots');
  if (labelSlots) labelSlots.textContent = state.fixedGridSlots.toString();

  const inputSlots = document.getElementById('input-fixed-grid-slots');
  if (inputSlots) inputSlots.value = state.fixedGridSlots;

  updateParticipantCount();

  if (notifyUser) {
    showLayoutNotification(`Modo de exibição alterado para ${layoutLabels[layoutMode].text}`);
  }
}

/**
 * Permite ao jogador selecionar quantas câmeras ficarão presas ao grid fixo (1 a 15)
 */
function setFixedGridSlots(newSlots, notify = true) {
  const parsed = Math.max(1, Math.min(15, parseInt(newSlots, 10) || 5));
  state.fixedGridSlots = parsed;
  StorageService.saveFixedGridSlots(parsed);

  const labelSlots = document.getElementById('label-fixed-slots');
  if (labelSlots) labelSlots.textContent = parsed.toString();

  const inputSlots = document.getElementById('input-fixed-grid-slots');
  if (inputSlots) inputSlots.value = parsed;

  if (state.currentLayout === 'fixo') {
    applyGridLayout('fixo', false);
  }
  if (notify) {
    showLayoutNotification(`Grid Fixo configurado para ${parsed} vagas`);
  }
}

/**
 * Gerenciamento de Supressão de Ruído e Noise Gate
 */
function setNoiseSuppression(enabled) {
  state.noiseSuppressionEnabled = enabled;
  StorageService.saveNoiseSuppression(enabled);
  if (state.webrtc) {
    state.webrtc.setNoiseSuppression(enabled);
  }
  const sliderGroup = document.getElementById('noise-gate-slider-group');
  if (sliderGroup) {
    sliderGroup.style.opacity = enabled ? '1' : '0.5';
    sliderGroup.style.pointerEvents = enabled ? 'auto' : 'none';
  }
  updateNoiseGateIndicator(true, 0, state.noiseGateThreshold);
}

function setNoiseGateThreshold(val) {
  const threshold = Math.max(2, Math.min(40, parseInt(val, 10) || 14));
  state.noiseGateThreshold = threshold;
  StorageService.saveNoiseGateThreshold(threshold);
  const label = document.getElementById('noise-gate-threshold-val');
  if (label) label.textContent = threshold.toString();
  if (state.webrtc) {
    state.webrtc.setNoiseGateThreshold(threshold);
  }
}

function updateNoiseGateIndicator(isPassingVoice, currentAvg, threshold) {
  const badge = document.getElementById('noise-gate-indicator-badge');
  if (!badge) return;
  if (!state.noiseSuppressionEnabled) {
    badge.textContent = 'Filtro Desativado';
    badge.style.background = 'rgba(148, 155, 164, 0.2)';
    badge.style.color = 'var(--text-muted)';
    return;
  }
  if (isPassingVoice) {
    badge.textContent = '🎙️ Voz Transmitindo';
    badge.style.background = 'rgba(35, 165, 90, 0.15)';
    badge.style.color = 'var(--accent-green)';
  } else {
    badge.textContent = '🛡️ Ruído Bloqueado';
    badge.style.background = 'rgba(240, 178, 50, 0.15)';
    badge.style.color = 'var(--accent-gold)';
  }
}

function cycleGridLayout() {
  const modes = ['movel', 'fixo', 'destaque'];
  const currentIndex = modes.indexOf(state.currentLayout);
  const nextIndex = (currentIndex + 1) % modes.length;
  applyGridLayout(modes[nextIndex], true);
}

function setFeaturedSpeaker(targetId) {
  state.activeSpeakerId = targetId;
  if (state.currentLayout !== 'destaque') return;

  const grid = document.getElementById('video-grid');
  if (!grid) return;

  grid.querySelectorAll('.video-tile').forEach(t => t.classList.remove('featured-speaker'));

  const targetTile = targetId === 'local' 
    ? document.getElementById('tile-local') 
    : document.getElementById(`tile-${targetId}`);

  if (targetTile) {
    targetTile.classList.add('featured-speaker');
  } else {
    const localTile = document.getElementById('tile-local');
    if (localTile) localTile.classList.add('featured-speaker');
  }
}

function showLayoutNotification(message) {
  const toast = document.createElement('div');
  toast.className = 'dice-toast';
  toast.style.borderColor = 'var(--accent-blurple)';
  toast.style.background = '#232428';
  toast.innerHTML = `<span style="font-size: 13px; font-weight: 600; color: var(--text-bright);">🎛️ ${escapeHtml(message)}</span>`;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

function showUpdateBanner(info) {
  const existing = document.getElementById('app-update-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'app-update-banner';
  banner.style.cssText = `
    position: fixed;
    top: 38px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, #5865f2 0%, #4752c4 100%);
    color: #fff;
    padding: 10px 18px;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    z-index: 99999;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    font-weight: 600;
  `;
  banner.innerHTML = `
    <span>🚀 Nova versão <strong>v${escapeHtml(info?.version || '1.0.1')}</strong> pronta para instalar!</span>
    <button id="btn-restart-update" style="
      background: #fff;
      color: #5865f2;
      border: none;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    ">Reiniciar e Atualizar</button>
    <button id="btn-dismiss-update" style="
      background: transparent;
      border: none;
      color: rgba(255,255,255,0.8);
      cursor: pointer;
      font-size: 14px;
      padding: 2px;
    ">✕</button>
  `;
  document.body.appendChild(banner);

  const btnRestart = banner.querySelector('#btn-restart-update');
  if (btnRestart) {
    btnRestart.onclick = () => {
      if (window.electronAPI && typeof window.electronAPI.restartAndInstallUpdate === 'function') {
        window.electronAPI.restartAndInstallUpdate();
      }
    };
  }

  const btnDismiss = banner.querySelector('#btn-dismiss-update');
  if (btnDismiss) {
    btnDismiss.onclick = () => banner.remove();
  }
}

function updateAvatarVisuals() {
  const initial = (state.userName || 'A')[0].toUpperCase();
  document.getElementById('local-avatar-letter').textContent = initial;
  document.getElementById('local-class-icon').textContent = state.userClassIcon;
  document.getElementById('local-tile-name').textContent = `Você (${state.userName})`;

  const badge = document.getElementById('local-tile-badge');
  badge.textContent = state.userRole === 'mestre' ? 'Mestre' : 'Jogador';
  badge.className = `badge-role ${state.userRole === 'mestre' ? 'mestre' : 'jogador'}`;

  const localAvatar = document.getElementById('local-avatar-fallback');
  const localVideo = document.getElementById('local-video');

  if (state.isVideoOff) {
    localAvatar.style.display = 'flex';
    localVideo.style.display = 'none';
    document.getElementById('local-icon-video').classList.add('muted');
  } else {
    localAvatar.style.display = 'none';
    localVideo.style.display = 'block';
    localVideo.play().catch(() => {});
    document.getElementById('local-icon-video').classList.remove('muted');
  }

  if (state.isAudioMuted) {
    document.getElementById('local-icon-audio').classList.add('muted');
  } else {
    document.getElementById('local-icon-audio').classList.remove('muted');
  }
}

// ============================================================================
// CONTROLES DE ÁUDIO E MICROFONE (Mudo / Desmudo e Push to Talk)
// ============================================================================
function setAudioMute(muted, isPtt = false) {
  const previousState = state.isAudioMuted;
  state.isAudioMuted = muted;

  if (state.webrtc) {
    state.webrtc.setAudioEnabled(!muted);
  }

  updateMicUI();
  updateAvatarVisuals();

  // Toca feedback sonoro se o estado mudou
  if (previousState !== muted) {
    if (!isPtt) {
      playMicFeedbackSound(muted ? 'mute' : 'unmute');
    }
  }
}

function toggleMute() {
  setAudioMute(!state.isAudioMuted, false);
}

function updateMicUI() {
  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const iconOn = document.getElementById('icon-mic-on');
  const iconOff = document.getElementById('icon-mic-off');

  if (!btnToggleMic || !iconOn || !iconOff) return;

  if (state.isAudioMuted) {
    iconOn.classList.add('hidden');
    iconOff.classList.remove('hidden');
    btnToggleMic.classList.add('active-danger');
    btnToggleMic.setAttribute('data-tooltip', `Desmutar Microfone (Atalho: ${state.micHotkey.toUpperCase()})`);
  } else {
    iconOn.classList.remove('hidden');
    iconOff.classList.add('hidden');
    btnToggleMic.classList.remove('active-danger');
    btnToggleMic.setAttribute('data-tooltip', `Mutar Microfone (Atalho: ${state.micHotkey.toUpperCase()})`);
  }
}

function updateCamUI() {
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const iconOn = document.getElementById('icon-cam-on');
  const iconOff = document.getElementById('icon-cam-off');

  if (!btnToggleCam || !iconOn || !iconOff) return;

  if (state.isVideoOff) {
    iconOn.classList.add('hidden');
    iconOff.classList.remove('hidden');
    btnToggleCam.classList.add('active-danger');
    btnToggleCam.setAttribute('data-tooltip', 'Ligar Câmera');
  } else {
    iconOn.classList.remove('hidden');
    iconOff.classList.add('hidden');
    btnToggleCam.classList.remove('active-danger');
    btnToggleCam.setAttribute('data-tooltip', 'Desligar Câmera');
  }
}

// ============================================================================
// ATALHOS DE TECLADO GLOBAIS (Push-to-Talk, Mute e Modos de Layout)
// ============================================================================
let lastToggleTime = 0;
let pttDebounceTimer = null;

function handlePttDown() {
  if (state.micActivationMode !== 'push_to_talk') return;

  if (pttDebounceTimer) {
    clearTimeout(pttDebounceTimer);
    pttDebounceTimer = null;
  }

  if (!state.isPttActive) {
    state.isPttActive = true;
    playMicFeedbackSound('ptt-start');
    setAudioMute(false, true);
  }
}

function handlePttUp() {
  if (state.micActivationMode !== 'push_to_talk') return;
  if (!state.isPttActive) return;

  if (pttDebounceTimer) clearTimeout(pttDebounceTimer);

  pttDebounceTimer = setTimeout(() => {
    state.isPttActive = false;
    playMicFeedbackSound('ptt-end');
    setAudioMute(true, true);
    pttDebounceTimer = null;
  }, 120);
}

/**
 * Sincroniza o atalho de microfone com o processo principal do Electron.
 * Isso garante funcionamento global no PC, mesmo com o app minimizado ou em segundo plano.
 */
function formatHotkeyLabel(key) {
  if (!key) return 'M';
  const clean = String(key).toLowerCase();
  if (clean === 'mouse4' || clean === 'btn4' || clean === 'button4') return 'MOUSE 4';
  if (clean === 'mouse5' || clean === 'btn5' || clean === 'button5') return 'MOUSE 5';
  if (clean === 'mouse3' || clean === 'middle' || clean === 'btn3') return 'MOUSE 3';
  if (clean.startsWith('mouse')) return clean.toUpperCase();
  return clean.toUpperCase();
}

function syncGlobalHotkeyWithElectron() {
  if (window.electronAPI && typeof window.electronAPI.registerGlobalHotkey === 'function') {
    window.electronAPI.registerGlobalHotkey({
      key: state.micHotkey,
      mode: state.micActivationMode
    });
    console.log(`[Atalhos] Atalho sincronizado com Electron: "${formatHotkeyLabel(state.micHotkey)}" (${state.micActivationMode})`);
  }
}

function setupKeyboardShortcuts() {
  // Registra o atalho global no sistema operacional via Electron
  syncGlobalHotkeyWithElectron();

  // Escuta ações disparadas pelo Electron quando a janela estiver minimizada ou o jogador estiver em outro aplicativo/jogo
  if (window.electronAPI) {
    if (typeof window.electronAPI.onGlobalHotkeyAction === 'function') {
      window.electronAPI.onGlobalHotkeyAction((action) => {
        if (!action) return;

        if (action.type === 'toggle-mute') {
          const now = Date.now();
          if (now - lastToggleTime < 280) return; // Evita duplo disparo se janela também capturar evento
          lastToggleTime = now;
          toggleMute();
        } else if (action.type === 'ptt-start') {
          handlePttDown();
        } else if (action.type === 'ptt-end') {
          handlePttUp();
        }
      });
    }

    // Canais IPC dedicados de Push to Talk e Toggle (suportando teclado e botões extras de mouse via uIOhook)
    if (typeof window.electronAPI.onPushToTalkStart === 'function') {
      window.electronAPI.onPushToTalkStart(() => {
        handlePttDown();
      });
    }

    if (typeof window.electronAPI.onPushToTalkStop === 'function') {
      window.electronAPI.onPushToTalkStop(() => {
        handlePttUp();
      });
    }

    if (typeof window.electronAPI.onPushToTalkToggle === 'function') {
      window.electronAPI.onPushToTalkToggle(() => {
        const now = Date.now();
        if (now - lastToggleTime < 280) return;
        lastToggleTime = now;
        toggleMute();
      });
    }

    // Captura teclas e botões gravados no SO via RawInput (node-global-key-listener)
    if (typeof window.electronAPI.onGlobalHotkeyRecorded === 'function') {
      window.electronAPI.onGlobalHotkeyRecorded((data) => {
        if (state.isRecordingHotkey && data && data.key) {
          finishHotkeyRecording(data.key);
        }
      });
    }

    // Captura cliques globais de mouse para permitir gravar Mouse 4, Mouse 5, etc. direto do hardware
    if (typeof window.electronAPI.onGlobalMouseDown === 'function') {
      window.electronAPI.onGlobalMouseDown((data) => {
        if (state.isRecordingHotkey && data && data.button) {
          let recKey = null;
          if (data.button === 4) recKey = 'mouse4';
          else if (data.button === 5) recKey = 'mouse5';
          else if (data.button === 3) recKey = 'mouse3';
          else if (data.button >= 6) recKey = `mouse${data.button}`;

          if (recKey) {
            finishHotkeyRecording(recKey);
          }
        }
      });
    }
  }

  // Gravação de cliques de mouse (Mouse 4, Mouse 5, Mouse 3) no navegador/janela focada
  const handleMouseRecording = (e) => {
    if (!state.isRecordingHotkey) return;
    if (e.button === 0 || e.button === 2) return; // Não grava clique esquerdo/direito comum

    e.preventDefault();
    e.stopPropagation();

    let mouseKey = null;
    if (e.button === 3) mouseKey = 'mouse4'; // XButton1 / Voltar
    else if (e.button === 4) mouseKey = 'mouse5'; // XButton2 / Avançar
    else if (e.button === 1) mouseKey = 'mouse3'; // Clique do meio
    else if (e.button >= 5) mouseKey = `mouse${e.button + 1}`;

    if (mouseKey) {
      finishHotkeyRecording(mouseKey);
    }
  };

  window.addEventListener('mousedown', handleMouseRecording, true);
  window.addEventListener('auxclick', handleMouseRecording, true);
  window.addEventListener('pointerdown', handleMouseRecording, true);

  // Manipulação de cliques de mouse locais na janela quando o atalho ativo for um botão do mouse
  window.addEventListener('mousedown', (e) => {
    if (state.isRecordingHotkey) return;
    const isMouseKey = state.micHotkey.startsWith('mouse') || state.micHotkey === 'middle';
    if (!isMouseKey) return;

    let clickedKey = null;
    if (e.button === 3) clickedKey = 'mouse4';
    else if (e.button === 4) clickedKey = 'mouse5';
    else if (e.button === 1) clickedKey = 'mouse3';
    else if (e.button >= 5) clickedKey = `mouse${e.button + 1}`;

    if (clickedKey === state.micHotkey) {
      if (state.micActivationMode === 'toggle') {
        const now = Date.now();
        if (now - lastToggleTime < 280) return;
        lastToggleTime = now;
        toggleMute();
      } else if (state.micActivationMode === 'push_to_talk') {
        handlePttDown();
      }
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (state.isRecordingHotkey) return;
    const isMouseKey = state.micHotkey.startsWith('mouse') || state.micHotkey === 'middle';
    if (!isMouseKey) return;

    let releasedKey = null;
    if (e.button === 3) releasedKey = 'mouse4';
    else if (e.button === 4) releasedKey = 'mouse5';
    else if (e.button === 1) releasedKey = 'mouse3';
    else if (e.button >= 5) releasedKey = `mouse${e.button + 1}`;

    if (releasedKey === state.micHotkey && state.micActivationMode === 'push_to_talk') {
      handlePttUp();
    }
  });

  window.addEventListener('keydown', (e) => {
    // Se o foco estiver em campo de texto, não dispara atalhos de voz
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');

    // Se estiver gravando nova tecla de atalho no modal de configurações
    if (state.isRecordingHotkey) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        finishHotkeyRecording(null);
        return;
      }

      finishHotkeyRecording(e.key.toLowerCase());
      return;
    }

    if (isInput) return;

    const pressedKey = e.key.toLowerCase();
    const pressedCode = e.code.toLowerCase();
    const isHotkeyMatch = (pressedKey === state.micHotkey || pressedCode === state.micHotkey || pressedCode.replace('key', '') === state.micHotkey || pressedCode.replace('digit', '') === state.micHotkey);

    // Atalho configurável de microfone
    if (isHotkeyMatch) {
      if (state.micActivationMode === 'toggle') {
        if (!e.repeat) {
          e.preventDefault();
          const now = Date.now();
          if (now - lastToggleTime < 280) return;
          lastToggleTime = now;
          toggleMute();
        }
      } else if (state.micActivationMode === 'push_to_talk') {
        if (!e.repeat) {
          e.preventDefault();
          handlePttDown();
        }
      }
    }

    // Atalho para alternar Modo de Exibição das câmeras (Tecla: "L")
    if ((pressedKey === 'l' || pressedCode === 'keyl') && !e.repeat) {
      e.preventDefault();
      cycleGridLayout();
    }
  });

  window.addEventListener('keyup', (e) => {
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (isInput) return;

    const releasedKey = e.key.toLowerCase();
    const releasedCode = e.code.toLowerCase();
    const isHotkeyMatch = (releasedKey === state.micHotkey || releasedCode === state.micHotkey || releasedCode.replace('key', '') === state.micHotkey || releasedCode.replace('digit', '') === state.micHotkey);

    // Push to Talk: muta novamente ao soltar a tecla (com debounce para evitar flicker)
    if (isHotkeyMatch && state.micActivationMode === 'push_to_talk') {
      handlePttUp();
    }
  });
}

function finishHotkeyRecording(newKey) {
  state.isRecordingHotkey = false;
  if (window.electronAPI && typeof window.electronAPI.stopRecordingHotkey === 'function') {
    window.electronAPI.stopRecordingHotkey();
  }
  const badge = document.getElementById('settings-hotkey-display');
  const btn = document.getElementById('btn-record-hotkey');
  const hint = document.getElementById('hotkey-hint');

  if (badge) badge.classList.remove('recording');
  if (btn) btn.querySelector('span').textContent = 'Alterar Tecla / Botão';

  if (newKey) {
    let cleanKey = newKey.toLowerCase();
    if (cleanKey.startsWith('key')) cleanKey = cleanKey.replace('key', '');
    if (cleanKey.startsWith('digit')) cleanKey = cleanKey.replace('digit', '');

    state.micHotkey = cleanKey;
    StorageService.saveMicHotkey(cleanKey);
    const label = formatHotkeyLabel(cleanKey);
    if (badge) badge.textContent = label;
    if (hint) {
      hint.innerHTML = `Ao acionar <strong style="color: var(--accent-gold);">${label}</strong>, seu microfone será acionado conforme o modo selecionado.`;
    }
    updateMicUI();
    syncGlobalHotkeyWithElectron();
    showLayoutNotification(`Atalho de voz alterado para "${label}"`);
  } else {
    if (badge) badge.textContent = formatHotkeyLabel(state.micHotkey);
  }
}

// ============================================================================
// SELETOR DE LAYOUT NO CABEÇALHO DA CHAMADA
// ============================================================================
function setupLayoutSelector() {
  const btnToggle = document.getElementById('btn-toggle-layout-menu');
  const dropdown = document.getElementById('layout-dropdown-menu');

  if (!btnToggle || !dropdown) return;

  btnToggle.onclick = (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  };

  document.querySelectorAll('.layout-dropdown-item').forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      const selectedMode = item.getAttribute('data-layout');
      applyGridLayout(selectedMode, true);
      dropdown.classList.add('hidden');
    };
  });

  // Fechar ao clicar fora
  document.addEventListener('click', (e) => {
    if (!dropdown.classList.contains('hidden')) {
      if (!dropdown.contains(e.target) && !btnToggle.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    }
  });

  // Botões de ajuste rápido de vagas no cabeçalho (Modo Grid Fixo)
  const btnDecSlots = document.getElementById('btn-dec-slots');
  const btnIncSlots = document.getElementById('btn-inc-slots');
  if (btnDecSlots) {
    btnDecSlots.onclick = (e) => {
      e.stopPropagation();
      setFixedGridSlots(state.fixedGridSlots - 1, true);
    };
  }
  if (btnIncSlots) {
    btnIncSlots.onclick = (e) => {
      e.stopPropagation();
      setFixedGridSlots(state.fixedGridSlots + 1, true);
    };
  }
}

// ============================================================================
// CONTROLES DE CHAMADA (Botões da Floating Bar)
// ============================================================================
function setupCallControls() {
  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const btnShareScreen = document.getElementById('btn-share-screen');
  const btnLeaveCall = document.getElementById('btn-leave-call');
  const btnCopyRoomId = document.getElementById('btn-copy-room-id');

  // Mutar / Desmutar Microfone
  btnToggleMic.addEventListener('click', () => {
    toggleMute();
  });

  // Ligar / Desligar Câmera
  btnToggleCam.addEventListener('click', async () => {
    if (!state.webrtc) return;
    try {
      state.isVideoOff = await state.webrtc.toggleVideo();
      updateCamUI();
      updateAvatarVisuals();
    } catch (camErr) {
      console.error('[WebRTC] Erro ao alternar câmera:', camErr);
    }
  });

  // Fechar banner de ausência de microfone
  const btnCloseAudioWarning = document.getElementById('btn-close-audio-warning');
  if (btnCloseAudioWarning) {
    btnCloseAudioWarning.addEventListener('click', () => {
      document.getElementById('no-audio-warning-banner')?.classList.add('hidden');
    });
  }

  // Compartilhar Tela (Abre modal para configuração de áudio, qualidade e instruções)
  btnShareScreen.addEventListener('click', async () => {
    if (!state.webrtc) return;
    if (state.webrtc.isScreenSharing) {
      await state.webrtc.stopScreenShare();
      btnShareScreen.classList.remove('active-danger');
      btnShareScreen.setAttribute('data-tooltip', 'Compartilhar Tela');
      showLayoutNotification('Transmissão de tela finalizada.');
    } else {
      openScreenShareModal();
    }
  });

  // Sair da Sala (Botão Vermelho Discord)
  btnLeaveCall.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    leaveCall();
  };

  // Copiar ID da Sala
  btnCopyRoomId.addEventListener('click', () => {
    const roomId = document.getElementById('call-room-title').textContent;
    navigator.clipboard.writeText(roomId).then(() => {
      const btnSpan = btnCopyRoomId.querySelector('span');
      const originalText = btnSpan.textContent;
      btnSpan.textContent = 'Copiado!';
      setTimeout(() => btnSpan.textContent = originalText, 2000);
    });
  });

  // Atalhos para abrir modal de configurações direcionado para cada aba
  document.getElementById('btn-open-settings').onclick = () => openSettingsModal('tab-devices');
  document.getElementById('btn-call-settings').onclick = () => openSettingsModal('tab-layout');
  document.getElementById('btn-control-settings').onclick = () => openSettingsModal('tab-devices');
  document.getElementById('btn-mic-arrow').onclick = () => openSettingsModal('tab-devices');
  document.getElementById('btn-cam-arrow').onclick = () => openSettingsModal('tab-devices');
}

// ============================================================================
// DADOS DE RPG (Rolagens, Sons e Notificações)
// ============================================================================
let diceToastTimeout = null;

function displayDiceToast(message) {
  const toast = document.getElementById('dice-toast');
  const toastText = document.getElementById('dice-toast-text');
  if (!toast || !toastText) return;

  toastText.innerHTML = message;
  toast.classList.remove('hidden');

  if (diceToastTimeout) clearTimeout(diceToastTimeout);
  diceToastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

function setupDiceRoller() {
  const dicePanel = document.getElementById('dice-roller-modal');
  const btnToggle = document.getElementById('btn-toggle-dice-panel');
  const btnQuick = document.getElementById('btn-quick-dice');
  const btnClose = document.getElementById('btn-close-dice');
  const btnDismissBottom = document.getElementById('btn-dismiss-dice-bottom');
  const resultDisplay = document.getElementById('dice-result-display');
  const btnGmMuteSound = document.getElementById('btn-gm-mute-dice-sound');
  const btnGmBlockAll = document.getElementById('btn-gm-block-dice-all');

  function refreshGmDiceControls() {
    const isMestre = state.userRole === 'mestre';
    if (btnGmMuteSound) {
      if (isMestre) {
        btnGmMuteSound.classList.remove('hidden');
        btnGmMuteSound.classList.toggle('active', state.gmDiceSoundMuted);
        btnGmMuteSound.setAttribute('title', state.gmDiceSoundMuted ? 'Som dos dados silenciado para você (Clique para reativar som)' : 'Desabilitar som dos dados para mim (Mestre)');
      } else {
        btnGmMuteSound.classList.add('hidden');
      }
    }
    if (btnGmBlockAll) {
      if (isMestre) {
        btnGmBlockAll.classList.remove('hidden');
        btnGmBlockAll.classList.toggle('active', state.diceBlockedForAll);
        btnGmBlockAll.setAttribute('title', state.diceBlockedForAll ? 'Rolagem de dados bloqueada para todos (Clique para liberar)' : 'Desabilitar rolagem de dados para todos');
      } else {
        btnGmBlockAll.classList.add('hidden');
      }
    }
    updateDiceButtonsBlockedState();
  }

  if (btnGmMuteSound) {
    btnGmMuteSound.onclick = (e) => {
      e.stopPropagation();
      state.gmDiceSoundMuted = !state.gmDiceSoundMuted;
      refreshGmDiceControls();
      showLayoutNotification(state.gmDiceSoundMuted ? '🔇 Som dos dados desativado para você (Mestre).' : '🔊 Som dos dados ativado.');
    };
  }

  if (btnGmBlockAll) {
    btnGmBlockAll.onclick = (e) => {
      e.stopPropagation();
      state.diceBlockedForAll = !state.diceBlockedForAll;
      refreshGmDiceControls();
      if (state.webrtc) {
        state.webrtc.broadcastRpgAction({
          type: 'gm-toggle-dice-rolling',
          blocked: state.diceBlockedForAll,
          gmName: state.userName
        });
      }
      showLayoutNotification(state.diceBlockedForAll ? '🚫 Rolagem de dados desabilitada para todos os jogadores.' : '🎲 Rolagem de dados liberada para todos.');
    };
  }

  function openDicePanel() {
    dicePanel.classList.remove('hidden');
    btnToggle.classList.add('active-tool');
    refreshGmDiceControls();
  }

  function closeDicePanel() {
    dicePanel.classList.add('hidden');
    btnToggle.classList.remove('active-tool');
  }

  function toggleDicePanel() {
    if (dicePanel.classList.contains('hidden')) {
      openDicePanel();
    } else {
      closeDicePanel();
    }
  }

  btnToggle.onclick = (e) => {
    e.stopPropagation();
    toggleDicePanel();
  };

  btnQuick.onclick = () => {
    rollDie(20);
  };

  if (btnClose) btnClose.onclick = closeDicePanel;
  if (btnDismissBottom) btnDismissBottom.onclick = closeDicePanel;

  // Fechar ao clicar fora do painel de dados
  document.addEventListener('click', (e) => {
    if (!dicePanel.classList.contains('hidden')) {
      if (!dicePanel.contains(e.target) && !btnToggle.contains(e.target)) {
        closeDicePanel();
      }
    }
  });

  // Fechar no ESC
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dicePanel.classList.contains('hidden')) {
      closeDicePanel();
    }
  });

  dicePanel.querySelectorAll('.dice-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const sides = parseInt(btn.getAttribute('data-die'), 10);
      rollDie(sides);
    };
  });

  function rollDie(sides) {
    if (state.diceBlockedForAll && state.userRole !== 'mestre') {
      showLayoutNotification('🚫 O Mestre desabilitou a rolagem de dados para todos os jogadores.');
      displayDiceToast('🚫 A rolagem de dados foi bloqueada pelo Mestre.');
      return;
    }

    const roll = Math.floor(Math.random() * sides) + 1;
    const isCritical = (sides === 20 && roll === 20);
    const isCriticalFumble = (sides === 20 && roll === 1);

    if (!(state.userRole === 'mestre' && state.gmDiceSoundMuted)) {
      playDiceSound(isCritical);
    }

    let criticalLabel = '';
    if (isCritical) criticalLabel = ' 🌟 ACERTO CRÍTICO!';
    else if (isCriticalFumble) criticalLabel = ' 💀 FALHA CRÍTICA!';

    resultDisplay.innerHTML = `Você rolou D${sides}: <span class="dice-result-val">${roll}</span>${criticalLabel}`;

    // Mostra toast flutuante sem forçar abertura do painel
    displayDiceToast(`<strong>Você</strong> rolou D${sides}: <span style="font-weight: 800; color: var(--accent-gold); font-size: 15px;">${roll}</span>${criticalLabel}`);

    // Notifica os outros participantes via DataChannel WebRTC
    if (state.webrtc) {
      state.webrtc.broadcastRpgAction({
        type: 'rpg-dice-roll',
        dieSides: sides,
        result: roll,
        isCritical,
        isCriticalFumble
      });
    }
  }
}

function showDiceRollNotification(data) {
  if (!(state.userRole === 'mestre' && state.gmDiceSoundMuted)) {
    playDiceSound(data.isCritical);
  }

  let critText = '';
  if (data.isCritical) critText = ' 🌟 CRÍTICO!';
  if (data.isCriticalFumble) critText = ' 💀 FALHA CRÍTICA!';

  const resultDisplay = document.getElementById('dice-result-display');
  if (resultDisplay) {
    resultDisplay.innerHTML = `<strong>${escapeHtml(data.senderName)}</strong> rolou D${data.dieSides}: <span class="dice-result-val">${data.result}</span>${critText}`;
  }

  // Notificação flutuante leve e não-intrusiva (não abre o modal na tela)
  displayDiceToast(`<strong>${escapeHtml(data.senderName)}</strong> rolou D${data.dieSides}: <span style="font-weight: 800; color: var(--accent-gold); font-size: 15px;">${data.result}</span>${critText}`);
}

function updateDiceButtonsBlockedState() {
  const dicePanel = document.getElementById('dice-roller-modal');
  if (!dicePanel) return;
  const isBlocked = state.diceBlockedForAll && state.userRole !== 'mestre';
  dicePanel.querySelectorAll('.dice-btn').forEach(btn => {
    btn.disabled = isBlocked;
    if (isBlocked) {
      btn.classList.add('blocked');
      btn.setAttribute('title', 'Rolagem temporariamente bloqueada pelo Mestre');
    } else {
      btn.classList.remove('blocked');
      btn.removeAttribute('title');
    }
  });
  const btnQuick = document.getElementById('btn-quick-dice');
  if (btnQuick) {
    btnQuick.disabled = isBlocked;
  }
}

function showVersionMismatchModal(yourVer, roomVer) {
  const modal = document.getElementById('version-mismatch-modal');
  if (!modal) return;
  const yourEl = document.getElementById('mismatch-your-version');
  const roomEl = document.getElementById('mismatch-room-version');
  if (yourEl) yourEl.textContent = `v${yourVer}`;
  if (roomEl) roomEl.textContent = `v${roomVer}`;
  modal.classList.remove('hidden');

  const btnClose = document.getElementById('btn-close-version-mismatch');
  if (btnClose) {
    btnClose.onclick = () => {
      modal.classList.add('hidden');
    };
  }
}

function setNoiseSuppressionMode(mode) {
  state.noiseSuppressionMode = mode;
  StorageService.saveNoiseSuppressionMode(mode);
  const sliderGroup = document.getElementById('noise-gate-slider-group');
  if (sliderGroup) {
    sliderGroup.style.display = (mode === 'noisegate') ? 'block' : 'none';
  }
  if (state.webrtc) {
    state.webrtc.setNoiseSuppressionMode(mode);
  }
  updateNoiseGateIndicator(true, 0, state.noiseGateThreshold);
  showLayoutNotification(`Supressor de ruído alterado para: ${mode === 'rnnoise' ? 'RNNoise (IA Neural)' : mode === 'noisegate' ? 'Portão de Ruído' : 'Nenhum'}`);
}

// ============================================================================
// MODAL DE CONFIGURAÇÕES (ICE / STUN / TURN / FIREBASE)
// ============================================================================
function setupSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const btnClose = document.getElementById('btn-close-settings-modal');
  const navItems = modal.querySelectorAll('.settings-nav-item');
  const tabPanes = modal.querySelectorAll('.settings-tab-pane');

  btnClose.onclick = closeSettingsModal;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeSettingsModal();
    }

    // Atalho secreto Ctrl+Shift+C para desocultar a aba de Rede e Conexão caso necessário
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c' || e.code === 'KeyC')) {
      e.preventDefault();
      const navTabIce = document.getElementById('nav-tab-ice');
      if (navTabIce) {
        const isHidden = window.getComputedStyle(navTabIce).display === 'none' || navTabIce.style.display === 'none';
        if (isHidden) {
          navTabIce.style.display = 'flex';
          openSettingsModal('tab-ice');
          showPresenceToast('Aba "Rede e Conexão" desocultada', 'join');
        } else {
          navTabIce.style.display = 'none';
          openSettingsModal('tab-mic');
          showPresenceToast('Aba "Rede e Conexão" ocultada', 'leave');
        }
      }
    }
  });

  navItems.forEach(nav => {
    nav.addEventListener('click', () => {
      const tabId = nav.getAttribute('data-tab');
      navItems.forEach(n => n.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));
      nav.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    });
  });

  // Espelho de vídeo
  const checkMirror = document.getElementById('settings-check-mirror');
  if (checkMirror) {
    checkMirror.checked = state.mirrorLocalVideo;
    checkMirror.onchange = (e) => {
      state.mirrorLocalVideo = e.target.checked;
      StorageService.savePreference('tavern_mirror_video', state.mirrorLocalVideo);
      const localTile = document.getElementById('tile-local');
      if (state.mirrorLocalVideo) {
        localTile.classList.add('local-tile');
      } else {
        localTile.classList.remove('local-tile');
      }
    };
  }

  // Sons de feedback do microfone e Push to Talk
  const checkSoundFeedback = document.getElementById('settings-check-sound-feedback');
  if (checkSoundFeedback) {
    checkSoundFeedback.checked = state.soundFeedbackEnabled;
    checkSoundFeedback.onchange = (e) => {
      state.soundFeedbackEnabled = e.target.checked;
      StorageService.saveSoundFeedback(state.soundFeedbackEnabled);
      if (state.soundFeedbackEnabled) {
        playMicFeedbackSound('unmute');
      }
    };
  }

  // Carrega configuração de TURN salva
  const savedIce = getSavedIceServers();
  const turnServer = savedIce.find(s => {
    const u = Array.isArray(s.urls) ? s.urls[0] : s.urls;
    return u && (u.startsWith('turn:') || u.startsWith('turns:'));
  });

  if (turnServer) {
    const url = Array.isArray(turnServer.urls) ? turnServer.urls[0] : turnServer.urls;
    document.getElementById('input-turn-url').value = url || '';
    document.getElementById('input-turn-username').value = turnServer.username || '';
    document.getElementById('input-turn-credential').value = turnServer.credential || '';
  }

  // Salvar Servidores TURN / STUN
  document.getElementById('btn-save-turn').onclick = () => {
    const turnUrl = document.getElementById('input-turn-url').value.trim();
    const turnUser = document.getElementById('input-turn-username').value.trim();
    const turnPass = document.getElementById('input-turn-credential').value.trim();

    const servers = [...DEFAULT_ICE_SERVERS];
    if (turnUrl) {
      const turnEntry = { urls: turnUrl };
      if (turnUser) turnEntry.username = turnUser;
      if (turnPass) turnEntry.credential = turnPass;
      servers.push(turnEntry);
    }

    saveIceServers(servers);
    alert('Configurações de servidores ICE salvas com sucesso!');
  };

  // Restaurar TURN Padrão
  document.getElementById('btn-reset-turn').onclick = () => {
    saveIceServers(DEFAULT_ICE_SERVERS);
    document.getElementById('input-turn-url').value = '';
    document.getElementById('input-turn-username').value = '';
    document.getElementById('input-turn-credential').value = '';
    alert('Servidores ICE restaurados para os padrões gratuitos da Google.');
  };

  // Configuração do Modo de Microfone (Alternar Mudo vs Push to Talk)
  const radioToggle = modal.querySelector('input[name="mic-activation-mode"][value="toggle"]');
  const radioPtt = modal.querySelector('input[name="mic-activation-mode"][value="push_to_talk"]');
  if (radioToggle && radioPtt) {
    if (state.micActivationMode === 'push_to_talk') {
      radioPtt.checked = true;
    } else {
      radioToggle.checked = true;
    }

    modal.querySelectorAll('input[name="mic-activation-mode"]').forEach(radio => {
      radio.onchange = (e) => {
        state.micActivationMode = e.target.value;
        StorageService.saveMicMode(state.micActivationMode);

        // Se ativou Push to Talk, inicia mutado por padrão
        if (state.micActivationMode === 'push_to_talk') {
          setAudioMute(true);
        }
        updateMicUI();
        syncGlobalHotkeyWithElectron();
      };
    });
  }

  // Tecla de atalho configurável
  const hotkeyDisplay = document.getElementById('settings-hotkey-display');
  const btnRecordHotkey = document.getElementById('btn-record-hotkey');
  const btnResetHotkey = document.getElementById('btn-reset-hotkey');
  const hotkeyHint = document.getElementById('hotkey-hint');

  if (hotkeyDisplay) {
    hotkeyDisplay.textContent = formatHotkeyLabel(state.micHotkey);
  }
  if (hotkeyHint) {
    hotkeyHint.innerHTML = `Ao acionar <strong style="color: var(--accent-gold);">${formatHotkeyLabel(state.micHotkey)}</strong>, seu microfone será acionado instantaneamente.`;
  }

  if (btnRecordHotkey) {
    btnRecordHotkey.onclick = (e) => {
      e.stopPropagation();
      state.isRecordingHotkey = true;
      if (window.electronAPI && typeof window.electronAPI.startRecordingHotkey === 'function') {
        window.electronAPI.startRecordingHotkey();
      }
      if (hotkeyDisplay) {
        hotkeyDisplay.textContent = '...';
        hotkeyDisplay.classList.add('recording');
      }
      btnRecordHotkey.querySelector('span').textContent = 'Pressione tecla ou botão do mouse...';
    };
  }

  if (btnResetHotkey) {
    btnResetHotkey.onclick = (e) => {
      e.stopPropagation();
      finishHotkeyRecording('=');
    };
  }

  // Seleção de Modos de Exibição na aba de Configurações
  modal.querySelectorAll('.layout-card-option').forEach(card => {
    card.onclick = () => {
      const radio = card.querySelector('input[type="radio"]');
      if (radio) {
        applyGridLayout(radio.value, true);
      }
    };
  });

  // Input de quantidade de vagas fixas no grid
  const inputFixedSlots = document.getElementById('input-fixed-grid-slots');
  if (inputFixedSlots) {
    inputFixedSlots.value = state.fixedGridSlots;
    inputFixedSlots.onchange = (e) => {
      setFixedGridSlots(e.target.value, true);
    };
  }

  // Controles de Supressão de Ruído (RNNoise, Noise Gate, Nenhum)
  const radioNoiseModes = modal.querySelectorAll('input[name="noise-suppression-mode"]');
  const sliderGroup = document.getElementById('noise-gate-slider-group');
  const sliderNoiseGate = document.getElementById('slider-noise-gate');
  const thresholdVal = document.getElementById('noise-gate-threshold-val');

  radioNoiseModes.forEach(radio => {
    if (radio.value === state.noiseSuppressionMode) {
      radio.checked = true;
    }
    radio.onchange = (e) => {
      setNoiseSuppressionMode(e.target.value);
    };
  });

  if (sliderGroup) {
    sliderGroup.style.display = (state.noiseSuppressionMode === 'noisegate') ? 'block' : 'none';
  }

  if (sliderNoiseGate) {
    sliderNoiseGate.value = state.noiseGateThreshold;
    if (thresholdVal) thresholdVal.textContent = state.noiseGateThreshold.toString();
    sliderNoiseGate.oninput = (e) => {
      setNoiseGateThreshold(e.target.value);
    };
  }

  // Seleção de classe de RPG
  modal.querySelectorAll('.rpg-class-pick').forEach(btn => {
    btn.onclick = () => {
      modal.querySelectorAll('.rpg-class-pick').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.userClassIcon = btn.getAttribute('data-icon');
      StorageService.saveClassIcon(state.userClassIcon);
      updateAvatarVisuals();
    };
  });

  // Configuração da aba de Versão e Atualizações
  setupVersionSettingsTab(modal);
}

// ============================================================================
// ABA DE VERSÃO E ATUALIZAÇÕES NAS CONFIGURAÇÕES
// ============================================================================
function setupVersionSettingsTab(modal) {
  const versionPill = document.getElementById('version-pill-badge');
  const versionText = document.getElementById('version-current-text');
  const envText = document.getElementById('version-runtime-env');
  const updatedAtText = document.getElementById('version-updated-at');
  const btnCheckUpdate = document.getElementById('btn-check-update-manual');
  const btnCheckText = document.getElementById('btn-check-update-text');
  const btnInstallNow = document.getElementById('btn-install-update-now');
  const feedbackBox = document.getElementById('version-feedback-box');
  const feedbackIcon = document.getElementById('version-feedback-icon');
  const feedbackMsg = document.getElementById('version-feedback-msg');
  const progressWrapper = document.getElementById('version-progress-wrapper');
  const progressLabel = document.getElementById('version-download-status-label');
  const progressPct = document.getElementById('version-download-pct');
  const progressBar = document.getElementById('version-download-bar');

  let currentAppVersion = APP_VERSION;

  // Obter versão instalada do Electron
  if (window.electronAPI && typeof window.electronAPI.getAppVersion === 'function') {
    window.electronAPI.getAppVersion().then(info => {
      if (info && info.version) {
        currentAppVersion = info.version;
        if (versionPill) versionPill.textContent = `v${info.version}`;
        if (versionText) versionText.innerHTML = `Versão instalada: <strong>v${info.version}</strong>`;
        if (envText) envText.textContent = info.isPackaged ? 'Desktop Oficial (Electron Windows)' : 'Modo Desenvolvimento (Electron)';
      }
    }).catch(() => {});
  } else {
    if (envText) envText.textContent = 'Navegador Web / PWA';
  }

  function setFeedback(icon, message, type = 'info') {
    if (feedbackIcon) feedbackIcon.textContent = icon;
    if (feedbackMsg) feedbackMsg.innerHTML = message;
    if (feedbackBox) {
      if (type === 'success') {
        feedbackBox.style.borderColor = 'rgba(35, 165, 90, 0.4)';
        feedbackBox.style.backgroundColor = 'rgba(35, 165, 90, 0.08)';
      } else if (type === 'warn') {
        feedbackBox.style.borderColor = 'rgba(240, 178, 50, 0.4)';
        feedbackBox.style.backgroundColor = 'rgba(240, 178, 50, 0.08)';
      } else if (type === 'error') {
        feedbackBox.style.borderColor = 'rgba(237, 66, 69, 0.4)';
        feedbackBox.style.backgroundColor = 'rgba(237, 66, 69, 0.08)';
      } else {
        feedbackBox.style.borderColor = 'var(--border-subtle)';
        feedbackBox.style.backgroundColor = 'var(--bg-card)';
      }
    }
  }

  // Listener para o botão de Procurar Update
  if (btnCheckUpdate) {
    btnCheckUpdate.onclick = async () => {
      if (btnCheckText) btnCheckText.textContent = 'procurando...';
      btnCheckUpdate.disabled = true;
      setFeedback('🔍', 'Conectando ao GitHub Releases para verificar novidades...', 'info');

      // Se estiver no Electron, dispara a checagem nativa
      if (window.electronAPI && typeof window.electronAPI.checkForUpdatesManual === 'function') {
        window.electronAPI.checkForUpdatesManual();
      }

      // Verificação direta complementar via API pública do GitHub
      try {
        const response = await fetch('https://api.github.com/repos/Hardiscore/Sussuro/releases/latest', {
          headers: { 'Accept': 'application/vnd.github.v3+json' }
        });

        if (response.ok) {
          const release = await response.json();
          const latestTag = (release.tag_name || release.name || '').replace(/^v/, '');
          const releaseDate = release.published_at ? new Date(release.published_at).toLocaleDateString('pt-BR') : 'Hoje';
          
          if (updatedAtText) updatedAtText.textContent = releaseDate;

          const isNewer = compareVersions(latestTag, currentAppVersion) > 0;

          if (isNewer) {
            setFeedback('📦', `Nova versão <strong>v${latestTag}</strong> encontrada no GitHub (Lançada em ${releaseDate})! Baixando instalador...`, 'success');
            if (progressWrapper) progressWrapper.classList.remove('hidden');
          } else {
            setFeedback('✅', `Você já está utilizando a versão mais recente (<strong>v${currentAppVersion}</strong>). Nenhuma atualização necessária no momento.`, 'success');
          }
        } else {
          setFeedback('ℹ️', `Verificação concluída. Versão atual: <strong>v${currentAppVersion}</strong>.`, 'info');
        }
      } catch (err) {
        console.warn('[VersionTab] Erro ao consultar GitHub API:', err);
        setFeedback('ℹ️', `Checagem concluída. Versão instalada: <strong>v${currentAppVersion}</strong>.`, 'info');
      } finally {
        setTimeout(() => {
          if (btnCheckText) btnCheckText.textContent = 'procurar update';
          btnCheckUpdate.disabled = false;
        }, 1200);
      }
    };
  }

  // Ouvintes de eventos do Electron AutoUpdater
  if (window.electronAPI) {
    if (typeof window.electronAPI.onUpdateChecking === 'function') {
      window.electronAPI.onUpdateChecking(() => {
        setFeedback('🔍', 'Verificando atualizações no GitHub Releases...', 'info');
      });
    }

    if (typeof window.electronAPI.onUpdateAvailable === 'function') {
      window.electronAPI.onUpdateAvailable((info) => {
        const newVer = info?.version || '';
        setFeedback('📦', `Nova versão <strong>v${newVer}</strong> detectada! Baixando atualização em segundo plano...`, 'success');
        if (progressWrapper) progressWrapper.classList.remove('hidden');
      });
    }

    if (typeof window.electronAPI.onUpdateProgress === 'function') {
      window.electronAPI.onUpdateProgress((progress) => {
        if (progressWrapper) progressWrapper.classList.remove('hidden');
        const pct = Math.round(progress.percent || 0);
        if (progressPct) progressPct.textContent = `${pct}%`;
        if (progressBar) progressBar.style.width = `${pct}%`;
        const mbTransferred = (progress.transferred / 1048576).toFixed(1);
        const mbTotal = (progress.total / 1048576).toFixed(1);
        if (progressLabel) progressLabel.textContent = `Baixando instalador: ${mbTransferred}MB de ${mbTotal}MB (${pct}%)`;
      });
    }

    if (typeof window.electronAPI.onUpdateDownloaded === 'function') {
      window.electronAPI.onUpdateDownloaded((info) => {
        const newVer = info?.version || '';
        setFeedback('🎉', `Atualização <strong>v${newVer}</strong> pronta para instalação!`, 'success');
        if (progressWrapper) progressWrapper.classList.add('hidden');
        if (btnInstallNow) btnInstallNow.classList.remove('hidden');
      });
    }

    if (typeof window.electronAPI.onUpdateNotAvailable === 'function') {
      window.electronAPI.onUpdateNotAvailable((info) => {
        setFeedback('✅', `O Sussurro RPG já está atualizado na versão mais recente (<strong>v${currentAppVersion}</strong>).`, 'success');
      });
    }

    if (typeof window.electronAPI.onUpdateError === 'function') {
      window.electronAPI.onUpdateError((err) => {
        setFeedback('⚠️', `Aviso na checagem: ${err?.message || 'Falha ao buscar no GitHub.'}`, 'warn');
      });
    }
  }

  // Ação de Reiniciar e Atualizar
  if (btnInstallNow) {
    btnInstallNow.onclick = () => {
      if (window.electronAPI && typeof window.electronAPI.restartAndInstallUpdate === 'function') {
        btnInstallNow.disabled = true;
        btnInstallNow.textContent = 'Reiniciando o Sussurro...';
        window.electronAPI.restartAndInstallUpdate();
      }
    };
  }
}

function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  const parts1 = v1.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const parts2 = v2.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function openSettingsModal(targetTabId = null) {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');

  if (targetTabId) {
    const navItems = modal.querySelectorAll('.settings-nav-item');
    const tabPanes = modal.querySelectorAll('.settings-tab-pane');
    navItems.forEach(n => {
      if (n.getAttribute('data-tab') === targetTabId) {
        n.classList.add('active');
      } else {
        n.classList.remove('active');
      }
    });
    tabPanes.forEach(p => {
      if (p.id === targetTabId) {
        p.classList.add('active');
      } else {
        p.classList.remove('active');
      }
    });
  }
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// MODAL DE COMPARTILHAMENTO DE TELA (DISCORD STYLE)
// ============================================================================
function setupScreenShareModal() {
  const modal = document.getElementById('screenshare-modal');
  const btnClose = document.getElementById('btn-close-screenshare-modal');
  const btnCancel = document.getElementById('btn-cancel-screenshare');
  const btnConfirm = document.getElementById('btn-confirm-screenshare');
  const tabScreens = document.getElementById('tab-btn-screens');
  const tabWindows = document.getElementById('tab-btn-windows');

  if (!modal) return;

  const handleClose = () => closeScreenShareModal();
  if (btnClose) btnClose.onclick = handleClose;
  if (btnCancel) btnCancel.onclick = handleClose;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeScreenShareModal();
    }
  });

  if (tabScreens) {
    tabScreens.onclick = () => {
      state.selectedScreenTab = 'screen';
      state.selectedScreenSource = state.screenShareSources?.screens?.[0] || null;
      tabScreens.classList.add('active');
      tabWindows?.classList.remove('active');
      renderScreenShareSources();
    };
  }

  if (tabWindows) {
    tabWindows.onclick = () => {
      state.selectedScreenTab = 'window';
      state.selectedScreenSource = state.screenShareSources?.windows?.[0] || null;
      tabWindows.classList.add('active');
      tabScreens?.classList.remove('active');
      renderScreenShareSources();
    };
  }

  if (btnConfirm) {
    btnConfirm.onclick = confirmScreenShare;
  }
}

async function openScreenShareModal() {
  const modal = document.getElementById('screenshare-modal');
  if (!modal) return;

  state.selectedScreenSource = null;
  state.selectedScreenTab = 'screen';

  const tabScreens = document.getElementById('tab-btn-screens');
  const tabWindows = document.getElementById('tab-btn-windows');
  if (tabScreens) tabScreens.classList.add('active');
  if (tabWindows) tabWindows.classList.remove('active');

  modal.classList.remove('hidden');
  await loadScreenShareSources();
}

function closeScreenShareModal() {
  const modal = document.getElementById('screenshare-modal');
  if (modal) modal.classList.add('hidden');
}

async function loadScreenShareSources() {
  const grid = document.getElementById('screenshare-source-grid');
  if (!grid) return;

  grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 30px 0;">Carregando telas e janelas disponíveis...</div>';

  if (window.electronAPI && typeof window.electronAPI.getDesktopSources === 'function') {
    try {
      const sources = await window.electronAPI.getDesktopSources();
      const screens = [];
      const windows = [];

      sources.forEach(s => {
        if (s.id.startsWith('screen:')) {
          screens.push(s);
        } else {
          windows.push(s);
        }
      });

      state.screenShareSources = { screens, windows };
      renderScreenShareSources();
      return;
    } catch (err) {
      console.warn('[ScreenShare] Erro ao carregar fontes via Electron:', err);
    }
  }

  // Fallback padrão Navegador WebRTC
  state.screenShareSources = { screens: [], windows: [] };
  renderScreenShareSources();
}

function renderScreenShareSources() {
  const grid = document.getElementById('screenshare-source-grid');
  if (!grid) return;

  grid.innerHTML = '';
  const isScreenTab = state.selectedScreenTab === 'screen';
  const list = isScreenTab ? state.screenShareSources.screens : state.screenShareSources.windows;

  // Se houver lista de fontes do Electron com miniaturas
  if (list && list.length > 0) {
    list.forEach((source, index) => {
      const card = document.createElement('div');
      card.className = `screenshare-source-card ${index === 0 ? 'selected' : ''}`;
      if (index === 0 && !state.selectedScreenSource) {
        state.selectedScreenSource = source;
      }

      card.innerHTML = `
        <img class="screenshare-card-thumb" src="${source.thumbnail}" alt="${escapeHtml(source.name)}" />
        <div class="screenshare-card-info">
          ${source.appIcon ? `<img class="screenshare-card-icon" src="${source.appIcon}" />` : (isScreenTab ? '🖥️' : '🪟')}
          <span class="screenshare-card-title" title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</span>
        </div>
      `;

      card.onclick = () => {
        grid.querySelectorAll('.screenshare-source-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.selectedScreenSource = source;
      };

      grid.appendChild(card);
    });
  } else {
    // Opção genérica / Navegador WebRTC
    const isScreen = state.selectedScreenTab === 'screen';
    const card = document.createElement('div');
    card.className = 'screenshare-generic-card selected';
    card.style.gridColumn = '1 / -1';

    card.innerHTML = `
      <div style="font-size: 36px;">${isScreen ? '🖥️' : '🪟'}</div>
      <h3 style="font-size: 15px; font-weight: 700; color: var(--text-bright); margin: 0;">
        ${isScreen ? 'Transmitir Tela Inteira' : 'Transmitir Janela de Aplicativo'}
      </h3>
      <p style="font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.5; max-width: 480px;">
        ${isScreen 
          ? 'Transmita o monitor completo do seu computador (jogos, mapas e vídeos). Para transmitir áudio no Windows, marque a caixinha "Compartilhar áudio do sistema" no canto inferior da tela de seleção.' 
          : 'Transmita uma janela específica. Nota: Por restrição de segurança dos navegadores web, o Chrome/Edge não captura áudio de janelas isoladas. Para transmitir com som, escolha Tela Inteira ou Guia.'}
      </p>
    `;

    grid.appendChild(card);
  }
}

async function confirmScreenShare() {
  closeScreenShareModal();
  if (!state.webrtc) return;

  const checkAudio = document.getElementById('screenshare-check-audio')?.checked ?? true;
  const checkMic = document.getElementById('screenshare-check-mic')?.checked ?? true;
  const qualityVal = document.getElementById('screenshare-select-quality')?.value || '720p30';

  let width = 1280;
  let height = 720;
  let frameRate = 30;

  if (qualityVal === '1080p60') {
    width = 1920;
    height = 1080;
    frameRate = 60;
  } else if (qualityVal === '1080p30') {
    width = 1920;
    height = 1080;
    frameRate = 30;
  }

  const isWindow = state.selectedScreenTab === 'window';
  const options = {
    sourceId: state.selectedScreenSource?.id || null,
    sourceType: isWindow ? 'window' : 'screen',
    includeAudio: checkAudio,
    includeMic: checkMic,
    width,
    height,
    frameRate,
    title: state.selectedScreenSource?.name || (isWindow ? 'Janela de Aplicativo' : 'Tela Inteira')
  };

  const isSharing = await state.webrtc.startScreenShare(options);
  const btnShareScreen = document.getElementById('btn-share-screen');

  if (isSharing) {
    if (btnShareScreen) {
      btnShareScreen.classList.add('active-danger');
      btnShareScreen.setAttribute('data-tooltip', 'Parar Compartilhamento de Tela');
    }
    if (state.webrtc.hasScreenAudio) {
      showLayoutNotification(`🖥️ Transmitindo: ${options.title} (com áudio do sistema/guia)`);
    } else if (checkAudio) {
      showLayoutNotification(`ℹ️ Transmitindo: ${options.title} (somente vídeo). Para enviar som de jogos/vídeos, selecione Tela Inteira marcando "Compartilhar áudio do sistema" ou Guia.`);
    } else {
      showLayoutNotification(`🖥️ Transmitindo: ${options.title} (somente vídeo)`);
    }
  } else {
    showLayoutNotification('Compartilhamento de tela cancelado.');
  }
}

// ============================================================================
// PONTO DE ENTRADA DO APLICATIVO
// ============================================================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

