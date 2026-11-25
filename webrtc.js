/**
 * TavernRTC - Módulo de Conexão WebRTC Mesh para RPG de Mesa
 * 
 * Gerencia captura de mídia, conexões P2P em malha (mesh) para até 15 participantes,
 * servidores STUN/TURN, troca de sinalização (Firebase RTDB ou BroadcastChannel fallback),
 * supressão de ruído e noise gate, detecção de voz ativa e troca de dispositivos em tempo real.
 */

import { 
  initFirebase, 
  ref, 
  set, 
  onValue, 
  onChildAdded, 
  onChildChanged,
  onChildRemoved, 
  remove, 
  get,
  onDisconnect,
  getStoredFirebaseConfig,
  BUILTIN_FIREBASE_CONFIG
} from './firebase-config.js';

const STORAGE_KEY_ICE = 'tavern_rtc_ice_servers';
const STORAGE_KEY_ACTIVE_TABS = 'sussurro_active_tabs';

function getLocalTabId() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      let id = window.sessionStorage.getItem('tavern_tab_id');
      if (!id) {
        id = 'tab_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
        window.sessionStorage.setItem('tavern_tab_id', id);
      }
      return id;
    }
  } catch (e) {}
  return 'tab_' + Math.random().toString(36).substring(2, 10);
}

function replaceStreamTrackByKind(stream, newTrack) {
  if (!stream || !newTrack) return false;
  let replaced = false;
  for (const existing of stream.getTracks()) {
    if (existing.kind === newTrack.kind && existing !== newTrack) {
      try { stream.removeTrack(existing); } catch (e) {}
      try { existing.stop(); } catch (e) {}
      replaced = true;
    }
  }
  if (!stream.getTracks().includes(newTrack)) {
    stream.addTrack(newTrack);
  }
  return replaced;
}

// Configuração padrão de ICE Servers (STUN gratuito do Google)
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];

/**
 * Obtém os servidores ICE configurados no localStorage ou os padrões
 */
export function getSavedIceServers() {
  try {
    if (typeof window !== 'undefined' && 'localStorage' in window && window.localStorage) {
      const saved = window.localStorage.getItem(STORAGE_KEY_ICE);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('[WebRTC] Falha ao carregar ICE servers salvos:', err);
  }
  return DEFAULT_ICE_SERVERS;
}

/**
 * Salva a lista de servidores ICE personalizada
 */
export function saveIceServers(servers) {
  try {
    if (typeof window !== 'undefined' && 'localStorage' in window && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY_ICE, JSON.stringify(servers));
      return true;
    }
  } catch (err) {
    console.error('[WebRTC] Erro ao salvar ICE servers:', err);
  }
  return false;
}

/**
 * Remove recursivamente propriedades undefined de um objeto para compatibilidade com Firebase Realtime Database
 */
function removeUndefined(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(removeUndefined);
  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      clean[key] = (typeof value === 'object' && value !== null) ? removeUndefined(value) : value;
    }
  }
  return clean;
}

/**
 * Otimiza a descrição SDP para economizar banda e CPU:
 * Ativa Opus DTX (Discontinuous Transmission) e prioriza voz em conexões Mesh.
 */
function optimizeSdp(desc) {
  if (!desc || !desc.sdp) return desc;
  let sdp = desc.sdp;
  if (sdp.includes('a=fmtp:111') && !sdp.includes('usedtx=1')) {
    sdp = sdp.replace(/a=fmtp:111 ((?:(?!usedtx=).)*)$/m, 'a=fmtp:111 $1;usedtx=1;stereo=0');
  }
  return { type: desc.type, sdp };
}

/**
 * Classe controladora de chamada WebRTC Mesh
 */
export class TavernWebRTC {
  constructor(options = {}) {
    this.roomId = null;
    this.myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.userInfo = {
      name: options.name || 'Aventureiro',
      role: options.role || 'jogador', // 'mestre' ou 'jogador'
      classIcon: options.classIcon || '⚔️',
      customAvatar: options.customAvatar || null,
      audioMuted: false,
      videoOff: false,
      isScreenSharing: false,
      hasScreenAudio: false,
      // Observador: só assiste/ouve os jogadores; fala apenas com outros observadores
      observer: !!options.observer
    };
    this.isObserver = !!options.observer;
    // Todos os registros da sala no Firebase (inclui quem foi ignorado), usado no limite de 15 pessoas
    this.roomRoster = new Map();
    this.capacityCheckTimer = null;

    // Regulador adaptativo oculto de qualidade e desempenho
    this.adaptiveProfile = 'balanced'; // 'high', 'balanced', 'low'
    this.adaptiveMetrics = { rtt: 0, packetLoss: 0, profile: 'balanced', lastCheck: 0 };
    this.adaptiveInterval = null;

    // Mídia local
    this.localStream = null;
    this.screenStream = null;
    this.screenStreamId = null;
    this.isScreenSharing = false;
    this.hasScreenAudio = false;
    this.selectedAudioDeviceId = options.audioDeviceId || null;
    this.selectedVideoDeviceId = options.videoDeviceId || null;
    this.hayfaPcMode = options.hayfaPcMode || false;

    // Conexões Mesh: peerId -> { connection: RTCPeerConnection, dataChannel, remoteStream, pendingCandidates: [], isPolite: boolean }
    this.peers = new Map();

    // Detecção de voz ativa (Local e Remota)
    this.audioContext = null;
    this.analyser = null;
    this.audioMeterInterval = null;
    this.remoteAnalysers = new Map(); // peerId -> { source, analyser, interval }
    this.remoteAudioContext = null;

    // Mixagem de áudio para transmissão de tela (som do app/jogo + microfone)
    this.mixerCtx = null;
    this.mixerMicGain = null;
    this.mixerScreenGain = null;
    this.currentMixedAudioTrack = null;
    this.onScreenShareEnded = null;

    // Stream e faixa da câmera crua do hardware (isolada de filtros/canvas)
    this.rawVideoTrack = null;
    this.rawVideoStream = null;

    // Sinalização e ciclo de vida
    this.firebaseDb = null;
    this.isFirebaseMode = false;
    this.isServerSignalingMode = false;
    this.serverEventSource = null;
    this.broadcastChannel = null;
    this.signalingCleanups = [];
    this.hasAudioDevice = true;
    this._signalSeq = 0;
    this._hbSeq = 0;
    this._leftRoom = false;
    this._tabId = getLocalTabId();
    this.peerQueues = new Map();
    this.peerLocalHeartbeats = new Map();
    this.heartbeatInterval = null;
    this.pruneInterval = null;
    this.localTabInterval = null;

    // Supressão de ruído (RNNoise / Noise Gate / Nenhum)
    this.noiseSuppressionMode = options.noiseSuppressionMode || 'rnnoise';
    this.noiseGateThreshold = options.noiseGateThreshold !== undefined ? options.noiseGateThreshold : 14;
    this.highpassFilter = null;

    // Versão do Cliente e Compatibilidade Estrita
    this.appVersion = options.appVersion || '1.1.2';
    this.userInfo.appVersion = this.appVersion;

    // Callbacks do UI
    this.onLocalStreamReady = options.onLocalStreamReady || (() => {});
    this.onPeerStreamAdded = options.onPeerStreamAdded || (() => {});
    this.onLocalScreenStreamReady = options.onLocalScreenStreamReady || (() => {});
    this.onScreenShareEnded = options.onScreenShareEnded || (() => {});
    this.onRemoteScreenStreamAdded = options.onRemoteScreenStreamAdded || (() => {});
    this.onRemoteScreenStreamEnded = options.onRemoteScreenStreamEnded || (() => {});
    this.onPeerStreamRemoved = options.onPeerStreamRemoved || (() => {});
    this.onPeerInfoUpdated = options.onPeerInfoUpdated || (() => {});
    this.onSpeakingState = options.onSpeakingState || (() => {});
    this.onNoiseGateState = options.onNoiseGateState || (() => {});
    this.onDataMessage = options.onDataMessage || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onNoAudioWarning = options.onNoAudioWarning || (() => {});
    this.onFirebaseRoomReady = options.onFirebaseRoomReady || null;
    this.onVersionMismatch = options.onVersionMismatch || (() => {});
    this.onDiceBlockedStateChange = options.onDiceBlockedStateChange || (() => {});
    this.onObserverVoiceAdded = options.onObserverVoiceAdded || (() => {});
    this.onObserversChanged = options.onObserversChanged || (() => {});
    this.onObserverCapacityExceeded = options.onObserverCapacityExceeded || (() => {});
    // Sussurro: observador fala com um ou mais jogadores (ver setWhisperTargets)
    this.whisperTargets = new Set();
    this.onWhisperState = options.onWhisperState || (() => {});
    this.onWhisperTargetChanged = options.onWhisperTargetChanged || (() => {});
    // Chamado quando o áudio de um peer parou de chegar (passo 1 do reparo: reanexar na tela)
    this.onPeerMediaStalled = options.onPeerMediaStalled || (() => {});
  }

  /**
   * Retorna a MediaStream contendo exclusivamente a trilha crua da webcam física,
   * completamente isolada de filtros de tela e capturas de canvas para prevenir loops de zoom.
   */
  getRawVideoStream() {
    if (!this.rawVideoStream) {
      this.rawVideoStream = new MediaStream();
    }
    if (this.rawVideoTrack) {
      const currentTracks = this.rawVideoStream.getVideoTracks();
      if (!currentTracks.includes(this.rawVideoTrack)) {
        currentTracks.forEach(t => this.rawVideoStream.removeTrack(t));
        this.rawVideoStream.addTrack(this.rawVideoTrack);
      }
    }
    return this.rawVideoStream;
  }

  /**
   * Captura a mídia do usuário (Microfone por padrão; câmera desativada ao entrar)
   */
  async startLocalMedia(audioDeviceId = null, videoDeviceId = null, requestVideo = false) {
    if (audioDeviceId) this.selectedAudioDeviceId = audioDeviceId;
    if (videoDeviceId) this.selectedVideoDeviceId = videoDeviceId;

    // Se já houver stream ativa, encerra faixas antigas
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    const useSuppression = this.noiseSuppressionMode !== 'none';
    const audioConstraints = {
      ...(this.selectedAudioDeviceId ? { deviceId: { exact: this.selectedAudioDeviceId } } : {}),
      echoCancellation: useSuppression,
      noiseSuppression: useSuppression,
      autoGainControl: useSuppression,
      googEchoCancellation: useSuppression,
      googAutoGainControl: useSuppression,
      googNoiseSuppression: useSuppression,
      googHighpassFilter: useSuppression,
      googTypingNoiseDetection: useSuppression
    };

    let audioStream = null;
    this.hasAudioDevice = true;

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });
    } catch (err) {
      console.warn('[WebRTC] Falha com restrições exatas de áudio. Tentando fallback sem deviceId:', err);
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
      } catch (audioSimpleErr) {
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
          });
        } catch (audioFallbackErr) {
          console.warn('[WebRTC] Microfone não detectado ou permissão negada:', audioFallbackErr);
          this.hasAudioDevice = false;
          this.userInfo.audioMuted = true;
          this.userInfo.noAudioDevice = true;
          if (typeof this.onNoAudioWarning === 'function') {
            this.onNoAudioWarning('Aviso: Microfone não liberado ou não detectado. Toque no ícone de microfone para solicitar permissão.');
          }
        }
      }
    }

    // Se o usuário não possui microfone, cria uma faixa de áudio silenciosa
    // para que a negociação WebRTC P2P (SDP) continue funcionando com perfeição
    if (!audioStream) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const dummyCtx = new AudioCtx();
          const dest = dummyCtx.createMediaStreamDestination();
          const silentTrack = dest.stream.getAudioTracks()[0];
          if (silentTrack) {
            silentTrack.enabled = false;
            audioStream = new MediaStream([silentTrack]);
          }
        }
      } catch (dummyErr) {}
      if (!audioStream) {
        audioStream = new MediaStream();
      }
    }

    this.localStream = audioStream;

    // Câmera: Ao entrar na chamada, NÃO ligar a câmera automaticamente (fica desligada por padrão)
    if (requestVideo) {
      let camStream = null;
      try {
        const videoConstraints = this.selectedVideoDeviceId
          ? { deviceId: { exact: this.selectedVideoDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
          : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };

        camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      } catch (camErr) {
        try {
          camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (camFallbackErr) {
          console.warn('[WebRTC] Câmera não encontrada ou acesso recusado:', camFallbackErr);
          this.userInfo.videoOff = true;
        }
      }

      if (camStream) {
        const camTrack = camStream.getVideoTracks()[0];
        if (camTrack) {
          this.rawVideoTrack = camTrack;
          this.getRawVideoStream();
          this.localStream.addTrack(camTrack);
          camTrack.enabled = !this.userInfo.videoOff;
        }
      }
    } else {
      this.userInfo.videoOff = true;
    }

    // Aplica estado inicial de áudio
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !this.userInfo.audioMuted;
    }

    if (this.hasAudioDevice) {
      this.setupAudioAnalyser(this.localStream);
    }
    this.onLocalStreamReady(this.localStream, this.getRawVideoStream());

    return this.localStream;
  }

  /**
   * Monitora amplitude de áudio para acender o anel verde de voz ativa (estilo Discord)
   * e processa o Noise Gate (corte de ruído de fundo/teclado/ventoinha quando não está falando).
   */
  setupAudioAnalyser(stream) {
    try {
      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      this.audioContext = new AudioCtx();
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }
      this.rawAudioStream = stream;
      this.rawAudioTrack = stream.getAudioTracks()[0];

      const source = this.audioContext.createMediaStreamSource(stream);

      // Filtro passa-altas para remover zumbidos elétricos (< 80Hz) e vibrações de mesa
      this.highpassFilter = this.audioContext.createBiquadFilter();
      this.highpassFilter.type = 'highpass';
      this.highpassFilter.frequency.setValueAtTime(this.noiseSuppressionMode === 'none' ? 10 : 80, this.audioContext.currentTime);

      // GainNode para Noise Gate e atenuação real de ruído
      this.noiseGateGain = this.audioContext.createGain();
      this.noiseGateGain.gain.setValueAtTime(1.0, this.audioContext.currentTime);

      // Analisador pré-gate para medir a voz do microfone com precisão contínua
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 1024;
      const timeData = new Uint8Array(this.analyser.fftSize);

      // Destino Web Audio: gera o track de áudio processado que será transmitido via WebRTC aos participantes
      this.audioDestination = this.audioContext.createMediaStreamDestination();

      // CONEXÃO DE ÁUDIO CORRETA:
      // O analisador é conectado no sinal de entrada (pré-gate) para nunca parar de detectar voz quando o portão fechar!
      source.connect(this.highpassFilter);
      this.highpassFilter.connect(this.analyser);
      this.highpassFilter.connect(this.noiseGateGain);
      this.noiseGateGain.connect(this.audioDestination);

      const processedTrack = this.audioDestination.stream.getAudioTracks()[0];
      if (processedTrack) {
        this.processedAudioTrack = processedTrack;
        this.processedAudioTrack.enabled = !this.userInfo.audioMuted;

        if (this.localStream) {
          const oldTrack = this.localStream.getAudioTracks()[0];
          if (oldTrack && oldTrack !== this.processedAudioTrack) {
            this.localStream.removeTrack(oldTrack);
          }
          this.localStream.addTrack(this.processedAudioTrack);
        }

        // Atualiza a faixa nos peer senders WebRTC já conectados
        for (const [, peer] of this.peers.entries()) {
          if (peer.connection && peer.connection.connectionState !== 'closed') {
            const senders = peer.connection.getSenders();
            let audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (!audioSender) {
              const audioTr = this.findAudioTransceiver(peer.connection);
              if (audioTr) audioSender = audioTr.sender;
            }
            if (audioSender) {
              audioSender.replaceTrack(this.processedAudioTrack).catch(e => console.warn('[WebRTC] Erro ao substituir track no sender:', e));
            }
          }
        }
      }

      // Aplica restrições iniciais do modo selecionado
      this.setNoiseSuppressionMode(this.noiseSuppressionMode);

      let wasSpeaking = false;
      let lastSpokeTime = 0;

      if (this.audioMeterInterval) clearInterval(this.audioMeterInterval);

      this.audioMeterInterval = setInterval(() => {
        if (!this.localStream || this.userInfo.audioMuted) {
          if (wasSpeaking) {
            wasSpeaking = false;
            this.userInfo.isSpeaking = false;
            this.broadcastMetadata();
            this.onSpeakingState('local', false, 0);
            this.onNoiseGateState(false, 0, this.noiseGateThreshold);
          }
          if (this.noiseGateGain && this.audioContext) {
            this.noiseGateGain.gain.setTargetAtTime(0.0, this.audioContext.currentTime, 0.02);
          }
          return;
        }

        this.analyser.getByteTimeDomainData(timeData);
        let sumSquares = 0;
        for (let i = 0; i < timeData.length; i++) {
          const val = (timeData[i] - 128) / 128; // -1 a 1
          sumSquares += val * val;
        }
        const rms = Math.sqrt(sumSquares / timeData.length);
        const level = Math.round(rms * 100); // 0 a 100+

        const isGateMode = this.noiseSuppressionMode === 'noisegate';
        const isRnnoise = this.noiseSuppressionMode === 'rnnoise';
        const isNone = this.noiseSuppressionMode === 'none';

        // Limiar adaptativo ultra-sensível para vozes baixas e sussurros de RPG
        let activeThreshold = 3;
        if (isRnnoise) {
          // No modo RNNoise, o filtro neural já silencia teclado e ventilador,
          // permitindo alta sensibilidade para vozes baixas e sussurros
          activeThreshold = 2.0;
        } else if (isGateMode) {
          activeThreshold = Math.max(2.5, Math.min(this.noiseGateThreshold, 7));
        } else {
          activeThreshold = 1.5;
        }

        const isSpeaking = level >= activeThreshold;

        if (isSpeaking) {
          lastSpokeTime = Date.now();
        }

        // Hangover de 380ms: mantém o portão e a borda verde ativos durante pausas naturais sem piscar
        const hangoverMs = 380;
        const gateIsOpen = isNone || (Date.now() - lastSpokeTime < hangoverMs);

        // Aplica corte de ruído real na saída do áudio transmitido aos outros jogadores
        if (this.audioContext && this.noiseGateGain) {
          if (isNone) {
            this.noiseGateGain.gain.setTargetAtTime(1.0, this.audioContext.currentTime, 0.01);
          } else if (gateIsOpen) {
            // Ataque ultra-rápido (6ms) para não cortar a primeira letra/sílaba da fala baixa
            this.noiseGateGain.gain.setTargetAtTime(1.0, this.audioContext.currentTime, 0.006);
          } else {
            // Liberação suave para silêncio completo quando parar de falar
            const floorGain = isRnnoise ? 0.0 : 0.005;
            this.noiseGateGain.gain.setTargetAtTime(floorGain, this.audioContext.currentTime, 0.06);
          }
        }

        if (this.processedAudioTrack) {
          this.processedAudioTrack.enabled = !this.userInfo.audioMuted;
        }

        this.onNoiseGateState(gateIsOpen, level, activeThreshold);

        if (gateIsOpen !== wasSpeaking) {
          wasSpeaking = gateIsOpen;
          this.userInfo.isSpeaking = gateIsOpen;
          this.broadcastMetadata();
          this.onSpeakingState('local', gateIsOpen, level);
        }
      }, 50);
    } catch (err) {
      console.warn('[WebRTC] Não foi possível iniciar analisador de áudio:', err);
    }
  }

  /**
   * Altera o modo de supressão de ruído ('noisegate', 'none', 'rnnoise')
   */
  setNoiseSuppressionMode(mode) {
    this.noiseSuppressionMode = mode;
    const isRnnoise = mode === 'rnnoise';
    const isGate = mode === 'noisegate';
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.applyConstraints({
        // RNNoise ativa cancelamento profundo do browser; Noise Gate deixa áudio livre para sussurros e efeitos
        noiseSuppression: isRnnoise,
        echoCancellation: mode !== 'none',
        autoGainControl: mode !== 'none',
        googNoiseSuppression: isRnnoise,
        googHighpassFilter: isRnnoise || isGate
      }).catch(() => {});
      if (!this.userInfo.audioMuted) {
        audioTrack.enabled = true;
      }
    }
    if (this.noiseWorkletNode) {
      try {
        this.noiseWorkletNode.port.postMessage({ mode });
      } catch (e) {}
    }
    return mode;
  }

  /**
   * Define o limiar de sensibilidade do Portão de Ruído (Noise Gate)
   */
  setNoiseGateThreshold(threshold) {
    this.noiseGateThreshold = Math.max(2, Math.min(50, Number(threshold) || 14));
    return this.noiseGateThreshold;
  }

  /**
   * Alterna dispositivo de áudio sem desconectar a chamada
   */
  async switchAudioDevice(deviceId) {
    this.selectedAudioDeviceId = deviceId;
    const useSuppression = this.noiseSuppressionMode !== 'none';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: useSuppression,
          noiseSuppression: this.noiseSuppressionMode === 'rnnoise',
          autoGainControl: useSuppression,
          googEchoCancellation: useSuppression,
          googAutoGainControl: useSuppression,
          googNoiseSuppression: this.noiseSuppressionMode === 'rnnoise',
          googHighpassFilter: useSuppression,
          googTypingNoiseDetection: useSuppression
        }
      });
      const newTrack = newStream.getAudioTracks()[0];
      newTrack.enabled = !this.userInfo.audioMuted;
      this.hasAudioDevice = true;
      this.userInfo.noAudioDevice = false;

      if (!this.localStream) {
        this.localStream = new MediaStream();
      }

      // Substitui na stream local e inicia analisador (que já atualiza os senders com processedAudioTrack)
      const oldTrack = this.localStream.getAudioTracks()[0];
      if (oldTrack) {
        this.localStream.removeTrack(oldTrack);
        try { oldTrack.stop(); } catch (e) {}
      }
      if (this.rawAudioTrack && this.rawAudioTrack !== oldTrack) {
        try { this.rawAudioTrack.stop(); } catch (e) {}
      }
      this.localStream.addTrack(newTrack);
      this.processedAudioTrack = null;
      this.setupAudioAnalyser(this.localStream);

      // Fallback se Web Audio API não criou processedAudioTrack
      if (!this.processedAudioTrack) {
        for (const [, peer] of this.peers.entries()) {
          if (!peer.connection || peer.connection.connectionState === 'closed') continue;
          const senders = peer.connection.getSenders();
          let audioSender = senders.find(s => s.track && s.track.kind === 'audio');
          if (!audioSender) {
            const audioTr = this.findAudioTransceiver(peer.connection);
            if (audioTr) audioSender = audioTr.sender;
          }
          if (audioSender) {
            await audioSender.replaceTrack(newTrack).catch(() => {});
          }
        }
      }
      console.log('[WebRTC] Microfone alterado com sucesso:', deviceId);
      return true;
    } catch (err) {
      console.error('[WebRTC] Erro ao trocar microfone:', err);
      return false;
    }
  }

  /**
   * Alterna dispositivo de vídeo (ex: Webcam normal para Câmera Virtual do OBS)
   */
  async switchVideoDevice(deviceId) {
    this.selectedVideoDeviceId = deviceId;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 24, max: 30 }
        }
      });
      const newTrack = newStream.getVideoTracks()[0];
      newTrack.enabled = !this.userInfo.videoOff;
      this.rawVideoTrack = newTrack;
      this.getRawVideoStream();

      for (const [peerId, peer] of this.peers.entries()) {
        const senders = peer.connection.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newTrack);
        }
      }

      const oldTrack = this.localStream.getVideoTracks()[0];
      if (oldTrack) {
        this.localStream.removeTrack(oldTrack);
        if (oldTrack !== this.rawVideoTrack) oldTrack.stop();
      }
      this.localStream.addTrack(newTrack);
      this.onLocalStreamReady(this.localStream, this.getRawVideoStream());
      console.log('[WebRTC] Câmera alterada com sucesso (suporte OBS):', deviceId);
      return true;
    } catch (err) {
      console.error('[WebRTC] Erro ao trocar câmera:', err);
      return false;
    }
  }

  /**
   * Define explicitamente o estado de áudio (ativado ou desativado)
   */
  setAudioEnabled(enabled) {
    this.userInfo.audioMuted = !enabled;
    if (enabled && this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !!enabled;
    }
    if (this.rawAudioTrack) {
      this.rawAudioTrack.enabled = !!enabled;
    }
    if (this.processedAudioTrack) {
      this.processedAudioTrack.enabled = !!enabled;
    }
    // Se estiver transmitindo tela com mixagem de áudio, controla ganho do microfone no mixer
    if (this.mixerMicGain) {
      this.mixerMicGain.gain.value = enabled ? 1.0 : 0.0;
    }
    this.broadcastMetadata();
    return this.userInfo.audioMuted;
  }

  /**
   * Muta ou desmuta microfone
   */
  toggleAudio(forceState = null) {
    const nextMuted = forceState !== null ? forceState : !this.userInfo.audioMuted;
    return this.setAudioEnabled(!nextMuted);
  }

  /**
   * Modo "PC da Hayfa": reduz resolução e FPS da câmera para economizar CPU
   * em computadores mais antigos.
   */
  setHayfaPcMode(enabled) {
    this.hayfaPcMode = !!enabled;
    if (this.rawVideoTrack && typeof this.rawVideoTrack.applyConstraints === 'function') {
      const isHayfa = this.hayfaPcMode;
      const constraints = isHayfa
        ? { width: { ideal: 480, max: 480 }, height: { ideal: 360, max: 360 }, frameRate: { ideal: 15, max: 20 } }
        : { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
      this.rawVideoTrack.applyConstraints(constraints).catch(() => {});
    }
  }

  /**
   * Liga ou desliga câmera (adquire dispositivo sob demanda se estava desligada ao entrar)
   */
  async toggleVideo(forceState = null) {
    let videoTrack = this.localStream?.getVideoTracks()[0];
    const wantVideoOn = forceState !== null ? !forceState : this.userInfo.videoOff;

    if (wantVideoOn) {
      if (!videoTrack || videoTrack.readyState === 'ended') {
        let camStream = null;
        try {
          const isHayfa = !!this.hayfaPcMode;
          const videoConstraints = this.selectedVideoDeviceId
            ? {
                deviceId: { exact: this.selectedVideoDeviceId },
                width: isHayfa ? { ideal: 480, max: 480 } : { ideal: 640 },
                height: isHayfa ? { ideal: 360, max: 360 } : { ideal: 480 },
                frameRate: isHayfa ? { ideal: 15, max: 20 } : { ideal: 30 }
              }
            : {
                facingMode: 'user',
                width: isHayfa ? { ideal: 480, max: 480 } : { ideal: 640 },
                height: isHayfa ? { ideal: 360, max: 360 } : { ideal: 480 },
                frameRate: isHayfa ? { ideal: 15, max: 20 } : { ideal: 30 }
              };

          camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
        } catch (err) {
          console.warn('[WebRTC] Tentando fallback simples de câmera (video: true):', err);
          try {
            camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          } catch (fallbackErr) {
            console.warn('[WebRTC] Não foi possível ativar câmera sob demanda:', fallbackErr);
            this.userInfo.videoOff = true;
            this.broadcastMetadata();
            this.onLocalStreamReady(this.localStream, this.getRawVideoStream());
            return true;
          }
        }

        if (camStream) {
          videoTrack = camStream.getVideoTracks()[0];
          if (videoTrack) {
            this.rawVideoTrack = videoTrack;
            this.getRawVideoStream();
            if (!this.localStream) this.localStream = new MediaStream();
            const oldV = this.localStream.getVideoTracks()[0];
            if (oldV && oldV !== videoTrack) {
              this.localStream.removeTrack(oldV);
              if (oldV !== this.rawVideoTrack) oldV.stop();
            }
            if (!this.localStream.getVideoTracks().includes(videoTrack)) {
              this.localStream.addTrack(videoTrack);
            }
          }
        }
      }

      if (videoTrack) {
        videoTrack.enabled = true;
        if (this.rawVideoTrack) this.rawVideoTrack.enabled = true;
        this.userInfo.videoOff = false;

        // Anexa ou substitui a faixa de vídeo em todas as conexões P2P e renegocia de forma serializada por peer
        await Promise.all(Array.from(this.peers.keys()).map(peerId =>
          this.enqueuePeerSignaling(peerId, async () => {
            const peer = this.peers.get(peerId);
            if (!peer || !peer.connection || peer.connection.connectionState === 'closed' || this._leftRoom) return;
            const pc = peer.connection;
            const senders = pc.getSenders();
            let videoSender = senders.find(s => s.track && s.track.kind === 'video');

            if (!videoSender) {
              const transceivers = pc.getTransceivers();
              const vt = transceivers.find(t => (t.sender && (!t.sender.track || t.sender.track.kind === 'video')) || (t.receiver && t.receiver.track && t.receiver.track.kind === 'video'));
              if (vt && vt.sender) {
                await vt.sender.replaceTrack(videoTrack);
                vt.direction = 'sendrecv';
                videoSender = vt.sender;
              } else {
                try {
                  videoSender = pc.addTrack(videoTrack, this.localStream);
                } catch (e) {
                  console.warn('[WebRTC] Erro ao adicionar faixa de vídeo à conexão:', e);
                }
              }
            } else {
              await videoSender.replaceTrack(videoTrack);
            }

            if (pc.signalingState !== 'stable') {
              setTimeout(() => this.retryNegotiation(peerId, 'cam-toggle', false), 600);
              return;
            }
            peer.makingOffer = true;
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await this.sendSignal(peerId, {
                type: 'offer',
                isCamToggle: true,
                videoOff: false,
                sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
              });
            } catch (renegErr) {
              console.warn('[WebRTC] Erro ao renegociar offer de vídeo:', renegErr);
            } finally {
              peer.makingOffer = false;
            }
          })
        ));
      }
    } else {
      // Desligar câmera
      this.userInfo.videoOff = true;
      if (videoTrack) {
        videoTrack.enabled = false;
      }
      if (this.rawVideoTrack) {
        this.rawVideoTrack.enabled = false;
      }
      for (const peerId of this.peers.keys()) {
        this.sendSignal(peerId, {
          type: 'cam-state',
          videoOff: true
        });
      }
    }

    this.broadcastMetadata();
    this.onLocalStreamReady(this.localStream, this.getRawVideoStream());
    return this.userInfo.videoOff;
  }

  /**
   * Substitui dinamicamente a faixa de vídeo transmitida aos peers (filtros, desfoque de fundo, cenários de RPG)
   */
  async updateFilteredVideoTrack(newTrack) {
    if (!this.localStream || !newTrack) return;
    const currentVideoTrack = this.localStream.getVideoTracks()[0];
    if (currentVideoTrack === newTrack) return;

    if (currentVideoTrack) {
      this.localStream.removeTrack(currentVideoTrack);
    }
    this.localStream.addTrack(newTrack);

    for (const peer of this.peers.values()) {
      const pc = peer.connection;
      if (!pc) continue;
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) {
        try {
          await videoSender.replaceTrack(newTrack);
        } catch (e) {
          console.warn('[WebRTC] Erro ao substituir track no sender:', e);
        }
      }
    }
  }

  /**
   * Inicia compartilhamento de tela ou janela de aplicativo com opções completas de áudio e resolução
   */
  async startScreenShare(options = {}) {
    const {
      sourceId = null,
      sourceType = 'screen', // 'screen' (tela inteira) ou 'window' (janela de aplicativo)
      includeAudio = true,   // transmitir áudio do sistema/aplicativo
      includeMic = true,     // manter microfone ativo junto com a transmissão
      frameRate = 30,
      width = 1920,
      height = 1080,
      title = ''
    } = options;

    try {
      let stream = null;
      let appAudioOk = false;

      // Se executando no Electron e o usuário escolheu uma fonte específica pelo ID do desktopCapturer
      if (sourceId && window.electronAPI) {
        const isScreen = String(sourceId).startsWith('screen:') || sourceType === 'screen';

        // Comunica ao processo principal do Electron qual fonte foi selecionada no modal
        if (typeof window.electronAPI.setSelectedSourceId === 'function') {
          window.electronAPI.setSelectedSourceId(sourceId);
        }

        // 1. Tenta a API moderna do Electron (getDisplayMedia via setDisplayMediaRequestHandler)
        // Isso resolve completamente NotReadableError no Windows para janelas de aplicativos
        try {
          const displayOpts = {
            video: {
              width: { ideal: width, max: 1920 },
              height: { ideal: height, max: 1080 },
              frameRate: { ideal: frameRate, max: 60 }
            }
          };
          // Janela de aplicativo no Windows: tenta capturar SÓ o áudio daquele app (módulo nativo).
          // Se não der, cai para o áudio do sistema inteiro.
          if (includeAudio && sourceType === 'window') {
            appAudioOk = await this.startAppAudio(sourceId);
          }
          if (includeAudio && !appAudioOk) {
            displayOpts.audio = { suppressLocalAudioPlayback: true };
          }
          stream = await navigator.mediaDevices.getDisplayMedia(displayOpts);
        } catch (displayMediaErr) {
          console.warn('[WebRTC] getDisplayMedia via Electron falhou, tentando método getUserMedia:', displayMediaErr);
        }

        // 2. Se getDisplayMedia não retornou stream, tenta o método getUserMedia clássico do desktopCapturer
        if (!stream) {
          if (includeAudio) {
            try {
              stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  mandatory: {
                    chromeMediaSource: 'desktop'
                  }
                },
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                  },
                  optional: [
                    { maxWidth: width },
                    { maxHeight: height },
                    { maxFrameRate: frameRate }
                  ]
                }
              });
            } catch (audioErr) {
              console.warn('[WebRTC] Captura de áudio no Electron falhou, tentando fallback sem áudio:', audioErr);
            }
          }

          if (!stream) {
            try {
              stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                  }
                }
              });
            } catch (winErr) {
              console.warn('[WebRTC] getUserMedia falhou para janela, tentando seletor do sistema:', winErr);
              // 3. Fallback final resiliente com getDisplayMedia direto do navegador/Electron
              stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false
              });
            }
          }
        }
      } else {
        // Padrão navegador WebRTC (getDisplayMedia)
        const displayMediaConstraints = {
          video: {
            width: { ideal: width, max: 1920 },
            height: { ideal: height, max: 1080 },
            frameRate: { ideal: frameRate, max: 60 }
          },
          audio: includeAudio ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            suppressLocalAudioPlayback: false
          } : false,
          systemAudio: includeAudio ? 'include' : 'exclude',
          selfBrowserSurface: 'include',
          surfaceSwitching: 'include'
        };

        try {
          stream = await navigator.mediaDevices.getDisplayMedia(displayMediaConstraints);
        } catch (firstErr) {
          if (firstErr.name === 'NotAllowedError') {
            throw firstErr;
          }
          console.warn('[WebRTC] Tentando getDisplayMedia com constraints padrão:', firstErr);
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: includeAudio ? true : false
          });
        }
      }

      // Junta a faixa de áudio do aplicativo (se capturamos por app) ao stream de tela
      if (appAudioOk && this.appAudio && this.appAudio.track) {
        try { stream.addTrack(this.appAudio.track); } catch (e) {}
      }

      this.screenStream = stream;
      this.screenStreamId = stream.id;
      const screenVideoTrack = stream.getVideoTracks()[0];
      const screenAudioTrack = stream.getAudioTracks()[0];

      if (!screenVideoTrack) {
        throw new Error('Nenhuma faixa de vídeo encontrada na transmissão de tela.');
      }
      try {
        screenVideoTrack.contentHint = 'detail';
      } catch (e) {}

      this.hasScreenAudio = !!screenAudioTrack;
      if (screenAudioTrack) {
        screenAudioTrack.enabled = true;
        try {
          screenAudioTrack.contentHint = 'music';
        } catch (e) {}
        console.log('[WebRTC] Áudio de tela capturado com sucesso:', screenAudioTrack.label);
      } else {
        console.warn('[WebRTC] Nenhuma faixa de áudio de sistema/guia fornecida pelo navegador.');
      }

      this.isScreenSharing = true;
      this.userInfo.isScreenSharing = true;
      this.userInfo.hasScreenAudio = !!screenAudioTrack;
      this.userInfo.screenStreamId = stream.id;
      this.userInfo.screenShareTitle = title || (sourceType === 'window' ? 'Janela de Aplicativo' : 'Tela Inteira');

      // 1. Notifica todos os participantes imediatamente antes de enviar as ofertas
      this.broadcastMetadata();

      // 2. Adiciona faixas de tela aos peers conectados e renegocia com identificação explícita
      await Promise.all(Array.from(this.peers.keys()).map(peerId =>
        this.enqueuePeerSignaling(peerId, async () => {
          const peer = this.peers.get(peerId);
          if (!peer || !peer.connection || peer.connection.connectionState === 'closed' || this._leftRoom) return;
          const pc = peer.connection;
          try {
            const senders = pc.getSenders();
            if (!senders.some(s => s.track && s.track.id === screenVideoTrack.id)) {
              pc.addTrack(screenVideoTrack, this.screenStream);
            }
            if (screenAudioTrack && !senders.some(s => s.track && s.track.id === screenAudioTrack.id)) {
              pc.addTrack(screenAudioTrack, this.screenStream);
            }
            if (pc.signalingState !== 'stable') {
              setTimeout(() => this.retryNegotiation(peerId, 'screen-start', false), 600);
              return;
            }
            peer.makingOffer = true;
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await this.sendSignal(peerId, {
                type: 'offer',
                isScreenShareOffer: true,
                screenStreamId: stream.id,
                screenTrackId: screenVideoTrack.id,
                hasScreenAudio: !!screenAudioTrack,
                sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
              });
            } finally {
              peer.makingOffer = false;
            }
          } catch (renegErr) {
            console.warn('[WebRTC] Erro ao adicionar faixas/renegociar tela:', renegErr);
          }
        })
      ));

      if (typeof this.onLocalScreenStreamReady === 'function') {
        this.onLocalScreenStreamReady(this.screenStream);
      }

      // Tratamento quando o usuário encerra o compartilhamento pela barra flutuante do sistema/navegador
      screenVideoTrack.onended = () => {
        if (this.isScreenSharing) {
          this.stopScreenShare();
        }
      };

      return true;
    } catch (err) {
      console.error('[WebRTC] Erro ao iniciar compartilhamento de tela:', err);
      this.teardownAppAudio();
      if (typeof showLayoutNotification === 'function') {
        showLayoutNotification('Erro ao iniciar transmissão: ' + (err.message || 'Permissão negada ou não suportada'));
      }
      return false;
    }
  }

  /**
   * Encerra a transmissão de tela e restaura a webcam e o microfone originais
   */
  /**
   * Captura o áudio de UM aplicativo (Windows) via processo principal do Electron e o transforma
   * numa faixa de áudio (MediaStreamTrack) pronta para enviar na chamada.
   */
  async startAppAudio(sourceId) {
    this.teardownAppAudio();
    const api = window.electronAPI;
    if (!api || typeof api.startAppAudio !== 'function' || typeof api.onAppAudioChunk !== 'function') return false;
    try {
      const res = await api.startAppAudio(sourceId);
      if (!res || !res.ok) {
        console.log('[WebRTC] Áudio por aplicativo indisponível, usando áudio do sistema:', res && res.reason);
        return false;
      }
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const workletCode = `
        class AppAudioProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.queue = [];
            this.offset = 0;
            this.queued = 0;
            this.port.onmessage = (e) => {
              this.queue.push(e.data);
              this.queued += e.data.length / 2;
              // Mantém no máximo ~1s de áudio acumulado (descarta o mais antigo)
              while (this.queued > 48000 && this.queue.length > 1) {
                const d = this.queue.shift();
                this.queued -= (d.length / 2) - (this.offset / 2);
                this.offset = 0;
              }
            };
          }
          process(inputs, outputs) {
            const out = outputs[0];
            const L = out[0], R = out[1] || out[0];
            for (let i = 0; i < L.length; i++) {
              if (!this.queue.length) { L[i] = 0; R[i] = 0; continue; }
              const cur = this.queue[0];
              L[i] = cur[this.offset];
              R[i] = cur[this.offset + 1];
              this.offset += 2;
              this.queued -= 1;
              if (this.offset >= cur.length) { this.queue.shift(); this.offset = 0; }
            }
            return true;
          }
        }
        registerProcessor('app-audio-processor', AppAudioProcessor);
      `;
      const url = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'app-audio-processor', { numberOfInputs: 0, outputChannelCount: [2] });
      const dest = ctx.createMediaStreamDestination();
      node.connect(dest);
      const unsubscribe = api.onAppAudioChunk((chunk) => {
        try {
          const bytes = new Uint8Array(chunk);          // cópia alinhada
          const ints = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
          const floats = new Float32Array(ints.length);
          for (let i = 0; i < ints.length; i++) floats[i] = ints[i] / 32768;
          node.port.postMessage(floats, [floats.buffer]);
        } catch (e) {}
      });
      const track = dest.stream.getAudioTracks()[0];
      this.appAudio = { ctx, node, unsubscribe, track };
      console.log('[WebRTC] Áudio por aplicativo ativo (processo ' + res.pid + ')');
      return !!track;
    } catch (err) {
      console.warn('[WebRTC] Falha no áudio por aplicativo, usando áudio do sistema:', err);
      this.teardownAppAudio();
      return false;
    }
  }

  teardownAppAudio() {
    const a = this.appAudio;
    this.appAudio = null;
    try { if (window.electronAPI && window.electronAPI.stopAppAudio) window.electronAPI.stopAppAudio(); } catch (e) {}
    if (!a) return;
    try { a.unsubscribe && a.unsubscribe(); } catch (e) {}
    try { a.track && a.track.stop(); } catch (e) {}
    try { a.node && a.node.disconnect(); } catch (e) {}
    try { a.ctx && a.ctx.close(); } catch (e) {}
  }

  async stopScreenShare() {
    if (!this.isScreenSharing) return false;
    this.teardownAppAudio();

    this.isScreenSharing = false;
    this.hasScreenAudio = false;
    this.userInfo.isScreenSharing = false;
    this.userInfo.hasScreenAudio = false;
    this.userInfo.screenShareTitle = '';
    this.userInfo.screenStreamId = null;

    // 1. Envia sinal explícito para TODOS os peers encerrarem a visualização da tela imediatamente (sem congelar)
    for (const [peerId, peer] of this.peers.entries()) {
      this.sendSignal(peerId, { type: 'screen-share-ended' });
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        try {
          peer.dataChannel.send(JSON.stringify({ type: 'screen-share-ended', fromPeerId: this.myPeerId }));
        } catch (e) {}
      }
    }

    // 2. Encerra faixas da tela local e remove dos RTCPeerConnections
    if (this.screenStream) {
      const screenTracks = this.screenStream.getTracks();
      await Promise.all(Array.from(this.peers.keys()).map(peerId =>
        this.enqueuePeerSignaling(peerId, async () => {
          const peer = this.peers.get(peerId);
          if (!peer || !peer.connection || peer.connection.connectionState === 'closed' || this._leftRoom) return;
          const pc = peer.connection;
          const senders = pc.getSenders();
          let removedAny = false;
          for (const track of screenTracks) {
            const sender = senders.find(s => s.track === track);
            if (sender) {
              try {
                pc.removeTrack(sender);
                removedAny = true;
              } catch (e) {}
            }
          }
          if (removedAny) {
            if (pc.signalingState !== 'stable') {
              setTimeout(() => this.retryNegotiation(peerId, 'screen-stop', false), 600);
              return;
            }
            peer.makingOffer = true;
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await this.sendSignal(peerId, {
                type: 'offer',
                sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
              });
            } catch (renegErr) {
              console.warn('[WebRTC] Erro ao renegociar offer após parar tela:', renegErr);
            } finally {
              peer.makingOffer = false;
            }
          }
        })
      ));
      screenTracks.forEach(t => t.stop());
      this.screenStream = null;
    }

    this.broadcastMetadata();

    if (typeof this.onScreenShareEnded === 'function') {
      this.onScreenShareEnded();
    }
    return true;
  }

  /**
   * Alterna estado de compartilhamento de tela
   */
  async toggleScreenShare(options = null) {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
      return false;
    } else {
      return await this.startScreenShare(options || {});
    }
  }

  /**
   * Conecta a uma sala de RPG (inicia sinalização)
   */
  async joinRoom(roomId, userInfo = {}) {
    this._leftRoom = false;
    this.roomId = roomId.trim().toLowerCase().replace(/[\.#$\[\]\/]/g, '-').replace(/\s+/g, '-');
    this.userInfo = { ...this.userInfo, ...userInfo };

    // Garante captura local antes de conectar (sem câmera por padrão)
    if (!this.localStream) {
      await this.startLocalMedia(null, null, false);
    }

    // Inicia monitoramento adaptativo de rede e hardware em segundo plano
    this.startAdaptiveNetworkMonitor();

    // 1. Tenta Firebase Realtime Database primeiro (ideal para salas na nuvem entre diferentes dispositivos e navegadores)
    try {
      const { db, isConfigured } = await initFirebase();
      if (isConfigured && db !== null) {
        this.isFirebaseMode = true;
        this.firebaseDb = db;
        console.log(`[WebRTC] Entrando na sala '${this.roomId}' via Firebase Realtime Database.`);
        this.onStatusChange({ type: 'signaling', mode: 'firebase', status: 'Firebase Conectado' });
        await this.setupFirebaseSignaling();
        this.setupBroadcastSignaling(true);
        return;
      }
    } catch (err) {
      console.warn('[WebRTC] Falha ao conectar no Firebase, tentando servidor central...', err);
    }

    // 2. Verifica se o Servidor Central de Sinalização está disponível (porta 3000 / mesma origem)
    let isServerAvailable = false;
    if (window.location.protocol !== 'file:') {
      try {
        const resp = await fetch('/api/health');
        if (resp.ok) {
          isServerAvailable = true;
        }
      } catch (e) {
        isServerAvailable = false;
      }
    }

    if (isServerAvailable) {
      this.isServerSignalingMode = true;
      console.log(`[WebRTC] Entrando na sala '${this.roomId}' via Servidor Central de Sinalização.`);
      this.onStatusChange({ 
        type: 'signaling', 
        mode: 'server', 
        status: 'Servidor Conectado' 
      });
      await this.setupServerSignaling();
      // Inicia BroadcastChannel simultaneamente para sincronização ultra-rápida entre abas locais
      this.setupBroadcastSignaling(true);
      return;
    }

    // 3. Fallback para BroadcastChannel local
    console.log(`[WebRTC] Utilizando BroadcastChannel fallback para testes locais.`);
    this.onStatusChange({ 
      type: 'signaling', 
      mode: 'local_broadcast', 
      status: 'Modo Local Mesh' 
    });
    this.setupBroadcastSignaling(false);
  }

  /**
   * Configuração de Sinalização via Servidor Central de Sinalização (Express + SSE)
   */
  async setupServerSignaling() {
    try {
      // 1. Registra entrada na sala e obtém participantes já conectados
      const joinResp = await fetch(`/api/rooms/${this.roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId: this.myPeerId,
          userInfo: this.userInfo
        })
      });

      if (!joinResp.ok) {
        const errData = await joinResp.json().catch(() => ({}));
        if (errData.error === 'VERSION_MISMATCH') {
          console.warn('[WebRTC] Erro de versão incompatível:', errData);
          if (typeof this.onVersionMismatch === 'function') {
            this.onVersionMismatch({
              yourVersion: errData.yourVersion || this.appVersion,
              requiredVersion: errData.requiredVersion || 'Outra Versão'
            });
          }
          throw new Error(`VERSION_MISMATCH:${errData.yourVersion}:${errData.requiredVersion}`);
        }
      }

      if (joinResp.ok) {
        const joinData = await joinResp.json();
        if (joinData.diceBlockedForAll && typeof this.onDiceBlockedStateChange === 'function') {
          this.onDiceBlockedStateChange(true);
        }
        if (Array.isArray(joinData.peers)) {
          for (const peer of joinData.peers) {
            if (peer && peer.peerId && peer.peerId !== this.myPeerId) {
              this.handlePeerDiscovered(peer.peerId, peer.userInfo);
            }
          }
        }
      }

      // 2. Conecta ao fluxo contínuo de eventos Server-Sent Events (SSE)
      const sse = new EventSource(`/api/rooms/${this.roomId}/events?peerId=${this.myPeerId}`);
      this.serverEventSource = sse;

      sse.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (!msg) return;

          switch (msg.type) {
            case 'peer-joined':
              if (msg.peerId !== this.myPeerId) {
                this.handlePeerDiscovered(msg.peerId, msg.userInfo);
              }
              break;

            case 'peer-left':
              if (msg.peerId !== this.myPeerId) {
                this.closePeer(msg.peerId);
              }
              break;

            case 'signal':
              if (msg.from !== this.myPeerId && msg.signal) {
                await this.handleIncomingSignal({ from: msg.from, ...msg.signal });
              }
              break;

            case 'peer-meta':
              if (msg.from !== this.myPeerId && msg.userInfo) {
                this.handlePeerMetaReceived(msg.from, msg.userInfo);
              }
              break;

            case 'rpg-action':
              if (msg.from !== this.myPeerId && msg.data) {
                this.onDataMessage(msg.from, msg.data);
              }
              break;
          }
        } catch (e) {
          console.warn('[WebRTC] Erro ao processar evento SSE:', e);
        }
      };

      sse.onerror = (e) => {
        console.warn('[WebRTC] Canal SSE reconectando...');
      };

      // 3. Fallback Polling a cada 2 segundos para garantir entrega de sinais se SSE sofrer proxy buffering
      const pollInterval = setInterval(async () => {
        if (!this.roomId || !this.isServerSignalingMode) return;
        try {
          const pResp = await fetch(`/api/rooms/${this.roomId}/poll?peerId=${this.myPeerId}`);
          if (pResp.ok) {
            const pData = await pResp.json();
            if (Array.isArray(pData.signals)) {
              for (const sig of pData.signals) {
                if (sig.type === 'signal' && sig.from !== this.myPeerId && sig.signal) {
                  await this.handleIncomingSignal({ from: sig.from, ...sig.signal });
                } else if (sig.type === 'peer-joined' && sig.peerId !== this.myPeerId) {
                  this.handlePeerDiscovered(sig.peerId, sig.userInfo);
                } else if (sig.type === 'peer-left' && sig.peerId !== this.myPeerId) {
                  this.closePeer(sig.peerId);
                } else if (sig.type === 'peer-meta' && sig.from !== this.myPeerId) {
                  this.handlePeerMetaReceived(sig.from, sig.userInfo);
                }
              }
            }
          }
        } catch (err) {}
      }, 2000);

      this.signalingCleanups.push(() => {
        clearInterval(pollInterval);
        if (this.serverEventSource) {
          this.serverEventSource.close();
          this.serverEventSource = null;
        }
        fetch(`/api/rooms/${this.roomId}/leave`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerId: this.myPeerId })
        }).catch(() => {});
      });

    } catch (err) {
      console.error('[WebRTC] Erro na inicialização do servidor de sinalização:', err);
    }
  }

  /**
   * Configuração de Sinalização via Firebase Realtime Database
   */
  async setupFirebaseSignaling() {
    const myPeerRef = ref(this.firebaseDb, `rooms/${this.roomId}/peers/${this.myPeerId}`);

    // Limpa imediatamente registros fantasmas de abas/janelas anteriores deste mesmo dispositivo que travaram/fecharam
    await this.cleanupCrashedLocalTabs();

    // Se a sala está vazia, apaga chat antigo que possa ter sobrado (ex.: último participante caiu sem sair direito)
    try {
      const existing = await get(ref(this.firebaseDb, `rooms/${this.roomId}/peers`));
      if (!existing.exists()) {
        await remove(ref(this.firebaseDb, `rooms/${this.roomId}/chat`));
        await remove(ref(this.firebaseDb, `rooms/${this.roomId}/observerChat`));
      }
    } catch (e) {}

    // Registra presença local
    const now = Date.now();
    this.userInfo.joinedAt = now;
    this._hbSeq = 1;
    await set(myPeerRef, removeUndefined({
      id: this.myPeerId,
      name: this.userInfo.name,
      role: this.userInfo.role,
      audioMuted: this.userInfo.audioMuted,
      videoOff: this.userInfo.videoOff,
      appVersion: this.appVersion,
      observer: !!this.userInfo.observer,
      joinedAt: this.userInfo.joinedAt,
      updatedAt: now,
      hb: this._hbSeq
    }));

    // Remove do banco ao desconectar
    onDisconnect(myPeerRef).remove();
    if (typeof this.onFirebaseRoomReady === 'function') { try { this.onFirebaseRoomReady(this.firebaseDb, this.roomId); } catch (e) {} }
    // Também limpa a caixa de sinais deste peer para não deixar a sala "fantasma" no Firebase
    try { onDisconnect(ref(this.firebaseDb, `rooms/${this.roomId}/signals/${this.myPeerId}`)).remove(); } catch (e) {}

    // Mantém presença local e heartbeat no Firebase para detectar quedas/travamentos rapidamente
    this.startFirebasePresenceMaintenance();

    // Escuta novos peers na sala
    const peersRef = ref(this.firebaseDb, `rooms/${this.roomId}/peers`);
    const unsubscribePeers = onChildAdded(peersRef, (snapshot) => {
      const peerData = snapshot.val();
      if (peerData && peerData.id !== this.myPeerId) {
        this.roomRoster.set(peerData.id, peerData);
        this.peerLocalHeartbeats.set(peerData.id, { hb: peerData.hb, localAt: Date.now() });
        this.scheduleObserverCapacityCheck();
        this.handlePeerDiscovered(peerData.id, peerData);
      }
    });

    const unsubscribePeerChanged = onChildChanged(peersRef, (snapshot) => {
      const peerData = snapshot.val();
      if (peerData && peerData.id !== this.myPeerId) {
        this.roomRoster.set(peerData.id, peerData);
        const prev = this.peerLocalHeartbeats.get(peerData.id);
        if (!prev || peerData.hb !== prev.hb || peerData.updatedAt !== prev.updatedAt) {
          this.peerLocalHeartbeats.set(peerData.id, {
            hb: peerData.hb,
            updatedAt: peerData.updatedAt,
            localAt: Date.now()
          });
        }
        this.handlePeerMetaReceived(peerData.id, peerData);
      }
    });

    const unsubscribePeerRemoved = onChildRemoved(peersRef, (snapshot) => {
      const peerData = snapshot.val();
      const removedId = (peerData && peerData.id) || snapshot.key;
      if (removedId && removedId !== this.myPeerId) {
        this.roomRoster.delete(removedId);
        this.peerLocalHeartbeats.delete(removedId);
        this.closePeer(removedId);
      }
    });

    // Escuta caixa de entrada de sinais destinados a este peer
    const signalsRef = ref(this.firebaseDb, `rooms/${this.roomId}/signals/${this.myPeerId}`);
    const unsubscribeSignals = onChildAdded(signalsRef, async (snapshot) => {
      const signal = snapshot.val();
      const signalKey = snapshot.key;
      if (signal) {
        await this.handleIncomingSignal(signal);
        // Remove sinal processado para não acumular
        const signalItemRef = ref(this.firebaseDb, `rooms/${this.roomId}/signals/${this.myPeerId}/${signalKey}`);
        remove(signalItemRef).catch(() => {});
      }
    });

    const roomIdSnapshot = this.roomId;
    const dbSnapshot = this.firebaseDb;
    const myPeerIdSnapshot = this.myPeerId;

    this.signalingCleanups.push(() => {
      this.stopFirebasePresenceMaintenance();
      this.clearLocalActiveTab();
      unsubscribePeers();
      unsubscribePeerChanged();
      unsubscribePeerRemoved();
      unsubscribeSignals();
      Promise.resolve(remove(myPeerRef))
        .then(() => remove(ref(dbSnapshot, `rooms/${roomIdSnapshot}/signals/${myPeerIdSnapshot}`)))
        .then(() => get(ref(dbSnapshot, `rooms/${roomIdSnapshot}/peers`)))
        .then((snap) => {
          // Se ninguém sobrou, apaga a sala inteira
          if (!snap.exists()) return remove(ref(dbSnapshot, `rooms/${roomIdSnapshot}`));
        })
        .catch(() => {});
    });
  }

  /**
   * Envia sinal para um peer específico via Firebase em ordem monotônica estrita
   */
  async sendFirebaseSignal(toPeerId, data) {
    if (!this.firebaseDb || this._leftRoom || !this.roomId) return;
    try {
      const sanitized = removeUndefined({
        from: this.myPeerId,
        ...data
      });
      const seq = String(++this._signalSeq).padStart(6, '0');
      const sigKey = `${Date.now()}_${seq}_${this.myPeerId}`;
      const newSignalRef = ref(this.firebaseDb, `rooms/${this.roomId}/signals/${toPeerId}/${sigKey}`);
      await set(newSignalRef, sanitized);
    } catch (err) {
      console.warn('[WebRTC] Erro ao gravar sinal no Firebase:', err);
    }
  }

  /**
   * Configuração de Sinalização Fallback via BroadcastChannel (permite testar 2+ abas sem Firebase)
   */
  setupBroadcastSignaling() {
    this.broadcastChannel = new BroadcastChannel(`tavern_mesh_${this.roomId}`);

    this.broadcastChannel.onmessage = async (event) => {
      const message = event.data;
      if (!message || message.from === this.myPeerId) return;

      switch (message.type) {
        case 'peer-announce':
          this.handlePeerDiscovered(message.from, message.userInfo);
          // Responde com anúncio próprio se ainda não for conhecido
          this.broadcastChannel.postMessage({
            type: 'peer-reply',
            from: this.myPeerId,
            to: message.from,
            userInfo: this.userInfo
          });
          break;

        case 'peer-reply':
          if (message.to === this.myPeerId) {
            this.handlePeerDiscovered(message.from, message.userInfo);
          }
          break;

        case 'signal':
          if (message.to === this.myPeerId) {
            await this.handleIncomingSignal(message.signal);
          }
          break;

        case 'peer-leave':
          this.closePeer(message.from);
          break;

        case 'peer-meta':
          this.handlePeerMetaReceived(message.from, message.userInfo);
          break;

        case 'rpg-action':
          if (message.from !== this.myPeerId && message.data) {
            this.onDataMessage(message.from, message.data);
          }
          break;
      }
    };

    // Anuncia entrada na sala
    this.broadcastChannel.postMessage({
      type: 'peer-announce',
      from: this.myPeerId,
      userInfo: this.userInfo
    });

    this.signalingCleanups.push(() => {
      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({
          type: 'peer-leave',
          from: this.myPeerId
        });
        this.broadcastChannel.close();
        this.broadcastChannel = null;
      }
    });
  }

  /**
   * Processa atualizações de metadados de um peer e sincroniza o estado da tela
   */
  handlePeerMetaReceived(fromPeerId, userInfo) {
    if (!userInfo) return;
    if (p) {
      const wasMuted = !!p.peerInfo?.audioMuted;
      p.peerInfo = { ...p.peerInfo, ...userInfo };
      if (wasMuted && userInfo.audioMuted === false && p.health) {
        p.health.gaveUp = false;
        p.health.cycles = 0;
        p.health.lastProgress = Date.now();
      }
      if (userInfo.screenStreamId) p.screenStreamId = userInfo.screenStreamId;
      if (userInfo.isScreenSharing) {
        p.isExpectingScreenShare = true;
      }
    }

    if (typeof this.onPeerInfoUpdated === 'function') {
      this.onPeerInfoUpdated(fromPeerId, userInfo);
    }

    // Se o peer parou de transmitir tela, encerra e remove o tile imediatamente
    if (userInfo.isScreenSharing === false) {
      if (p && p.remoteScreenStream) {
        p.remoteScreenStream.getTracks().forEach(t => t.stop());
        p.remoteScreenStream = new MediaStream();
      }
      if (p) p.isExpectingScreenShare = false;
      if (typeof this.onRemoteScreenStreamEnded === 'function') {
        this.onRemoteScreenStreamEnded(fromPeerId);
      }
    } else if (userInfo.isScreenSharing === true) {
      // Se o peer está transmitindo e o espectador ainda não tem o vídeo de tela, solicita renegociação (com throttle para não repetir a cada heartbeat)
      if (p && (!p.remoteScreenStream || p.remoteScreenStream.getVideoTracks().length === 0)) {
        const now = Date.now();
        if (!p._lastScreenReqAt || now - p._lastScreenReqAt > 6000) {
          p._lastScreenReqAt = now;
          setTimeout(() => {
            if (!this._leftRoom && this.peers.has(fromPeerId)) {
              this.sendSignal(fromPeerId, { type: 'request-screen-renegotiation' });
            }
          }, 300);
        }
      }
    }
  }

  /**
   * Despacha um sinal para outro peer (Servidor Central, Firebase ou BroadcastChannel)
   */
  async sendSignal(toPeerId, signal) {
    const rawSignal = {
      ...signal,
      type: signal.type,
      isScreenShareOffer: !!signal.isScreenShareOffer,
      hasScreenAudio: !!signal.hasScreenAudio,
      ...(signal.screenStreamId ? { screenStreamId: signal.screenStreamId } : {}),
      ...(signal.screenTrackId ? { screenTrackId: signal.screenTrackId } : {}),
      ...(signal.sdp ? { sdp: { type: signal.sdp.type, sdp: signal.sdp.sdp } } : {}),
      ...(signal.candidate ? { candidate: signal.candidate } : {})
    };

    const cleanSignal = removeUndefined(rawSignal);

    if (this.isServerSignalingMode) {
      fetch(`/api/rooms/${this.roomId}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.myPeerId,
          to: toPeerId,
          signal: cleanSignal
        })
      }).catch(err => console.warn('[WebRTC] Erro ao enviar sinal para o servidor:', err));
    } else if (this.isFirebaseMode) {
      await this.sendFirebaseSignal(toPeerId, cleanSignal);
    }
    
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'signal',
        from: this.myPeerId,
        to: toPeerId,
        signal: { from: this.myPeerId, ...cleanSignal }
      });
    }
  }

  /**
   * Chamado quando um novo participante é detectado
   */
  /**
   * Serializa operações de sinalização/SDP por peer para impedir glare e erros de estado concorrentes
   */
  enqueuePeerSignaling(peerId, fn) {
    const prev = this.peerQueues.get(peerId) || Promise.resolve();
    const next = prev.then(() => fn()).catch((err) => {
      console.warn(`[WebRTC][fila ${peerId}] Erro na tarefa de sinalização:`, err);
    });
    this.peerQueues.set(peerId, next);
    return next;
  }

  /**
   * Chamado quando um novo participante é detectado
   */
  async handlePeerDiscovered(peerId, peerInfo) {
    if (!peerId || peerId === this.myPeerId || this._leftRoom) return;

    // Verificação estrita de versão entre peers (mesmo se um sinal chegou antes da presença)
    const peerVersion = peerInfo && peerInfo.appVersion;
    if (this.appVersion && peerVersion !== this.appVersion) {
      console.warn(`[WebRTC] Incompatibilidade de versão detectada para ${peerId}: v${peerVersion} (sua versão: v${this.appVersion})`);
      if (this.peers.has(peerId)) {
        this.closePeer(peerId);
      }
      if (typeof this.onVersionMismatch === 'function') {
        this.onVersionMismatch({
          peerId,
          peerName: peerInfo?.name || 'Aventureiro',
          peerVersion: peerVersion || 'antiga (sem verificação)',
          yourVersion: this.appVersion
        });
      }
      return;
    }

    // Se já criamos uma entrada antecipada (ex.: oferta chegou antes de peersRef), promove os metadados reais
    if (this.peers.has(peerId)) {
      const existing = this.peers.get(peerId);
      const wasObserver = !!existing.peerInfo?.observer;
      const nowObserver = !!(peerInfo && peerInfo.observer);
      existing.peerInfo = { ...existing.peerInfo, ...peerInfo, _isPlaceholder: false };
      if (nowObserver !== wasObserver) {
        // Tipo de participante mudou em relação ao placeholder: recria com trilhas corretas
        this.closePeer(peerId);
      } else {
        if (!nowObserver && existing.remoteStream) {
          this.onPeerStreamAdded(peerId, existing.peerInfo, existing.remoteStream);
        }
        if (typeof this.onPeerInfoUpdated === 'function') {
          this.onPeerInfoUpdated(peerId, existing.peerInfo);
        }
        if (nowObserver) this.notifyObserversChanged();
        return;
      }
    }

    // Se alguém travou/caiu e reentrou rapidamente com o mesmo nome enquanto a conexão antiga já está morta/falhando, remove o fantasma antigo
    const normalizedNewName = (peerInfo?.name || '').trim().toLowerCase();
    const peerIsObserver = !!(peerInfo && peerInfo.observer);
    if (normalizedNewName) {
      for (const [oldId, oldPeer] of Array.from(this.peers.entries())) {
        if (oldId === peerId) continue;
        const oldName = (oldPeer.peerInfo?.name || '').trim().toLowerCase();
        if (oldName === normalizedNewName && !!oldPeer.peerInfo?.observer === peerIsObserver) {
          const pc = oldPeer.connection;
          const hbRec = this.peerLocalHeartbeats.get(oldId);
          const hbSilentMs = hbRec ? (Date.now() - hbRec.localAt) : 0;
          const isOldDead = !pc ||
            pc.connectionState === 'failed' ||
            pc.connectionState === 'disconnected' ||
            pc.connectionState === 'closed' ||
            pc.iceConnectionState === 'failed' ||
            pc.iceConnectionState === 'disconnected' ||
            hbSilentMs > 12000;
          if (isOldDead) {
            console.warn(`[WebRTC] Substituindo sessão fantasma anterior de ${peerInfo.name} (${oldId} -> ${peerId}).`);
            this.removeGhostPeerEverywhere(oldId);
          }
        }
      }
    }

    const playerPeers = [...this.peers.values()].filter(p => !p.peerInfo?.observer).length;
    // Jogadores: até 15 na mesa. Observadores não tiram vaga de jogador (ver scheduleObserverCapacityCheck)
    if ((!peerIsObserver && playerPeers >= (this.isObserver ? 15 : 14)) || this.peers.size >= 20) {
      console.warn(`[WebRTC] Limite da malha de 15 participantes atingido. Ignorando ${peerId}`);
      return;
    }

    console.log(`[WebRTC] Novo peer descoberto: ${peerId} (${peerInfo.name} - v${peerVersion || this.appVersion})`);
    
    // Padrão Perfect Negotiation (RFC): o peer com ID "menor" atua como polite
    const isPolite = this.myPeerId < peerId;
    const peerObj = this.createPeerConnection(peerId, peerInfo, isPolite);
    this.peers.set(peerId, peerObj);
    if (peerIsObserver) this.notifyObserversChanged();

    // Se estivermos transmitindo tela quando o novo participante entrar:
    // Garante que as faixas de tela sejam adicionadas imediatamente à conexão deste novo peer
    if (this.isScreenSharing && this.screenStream) {
      this.broadcastMetadata();
      const senders = peerObj.connection.getSenders();
      this.screenStream.getTracks().forEach(track => {
        if (!senders.some(s => s.track && s.track.id === track.id)) {
          try {
            peerObj.connection.addTrack(track, this.screenStream);
          } catch (e) {}
        }
      });
    }

    // Se formos o peer impolítico (ou quem detectou primeiro), iniciamos a oferta serializada
    if (!isPolite) {
      await this.enqueuePeerSignaling(peerId, async () => {
        const current = this.peers.get(peerId);
        if (!current || current !== peerObj || !peerObj.connection || peerObj.connection.connectionState === 'closed' || this._leftRoom) return;
        if (peerObj.connection.signalingState !== 'stable') return;
        peerObj.makingOffer = true;
        try {
          const offer = await peerObj.connection.createOffer();
          await peerObj.connection.setLocalDescription(offer);
          await this.sendSignal(peerId, {
            type: 'offer',
            isScreenShareOffer: !!this.isScreenSharing,
            screenStreamId: this.screenStream ? this.screenStream.id : null,
            hasScreenAudio: !!this.hasScreenAudio,
            sdp: {
              type: peerObj.connection.localDescription.type,
              sdp: peerObj.connection.localDescription.sdp
            }
          });
        } catch (err) {
          console.error(`[WebRTC] Erro ao criar oferta para ${peerId}:`, err);
        } finally {
          peerObj.makingOffer = false;
        }
      });
    }

    // Se o participante que acabou de ser detectado já estiver transmitindo tela,
    // envia um pedido de renegociação para garantir que receberemos os fluxos de vídeo/áudio de tela
    if (peerInfo && peerInfo.isScreenSharing) {
      setTimeout(() => {
        if (!this._leftRoom && this.peers.has(peerId)) {
          this.sendSignal(peerId, { type: 'request-screen-renegotiation' });
        }
      }, 500);
    }
  }

  /**
   * Cria e configura a RTCPeerConnection para um participante
   */
  createPeerConnection(peerId, peerInfo, isPolite) {
    const iceServers = getSavedIceServers();
    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 8 });

    const peerData = {
      peerId,
      peerInfo,
      connection: pc,
      remoteStream: new MediaStream(),
      remoteScreenStream: new MediaStream(),
      screenStreamId: peerInfo?.screenStreamId || null,
      dataChannel: null,
      pendingCandidates: [],
      isPolite,
      makingOffer: false,
      ignoreOffer: false,
      // Estado do vigia de áudio e das tentativas de reparo (ver checkPeerMedia)
      health: { lastBytes: 0, lastProgress: Date.now(), lastAction: 0, next: 0, cycles: 0, waits: 0, gaveUp: false, checking: false }
    };

    // Adiciona faixas locais de microfone e câmera à conexão.
    // Observador: nada vai para os jogadores; para outros observadores vai só a voz.
    const peerIsObserver = !!(peerInfo && peerInfo.observer);
    if (this.localStream && (!this.isObserver || peerIsObserver)) {
      const tracks = this.isObserver ? this.localStream.getAudioTracks() : this.localStream.getTracks();
      tracks.forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Se estiver transmitindo tela ao conectar novo participante, anexa faixas da tela à conexão
    if (this.isScreenSharing && this.screenStream) {
      this.screenStream.getTracks().forEach(track => {
        try {
          pc.addTrack(track, this.screenStream);
        } catch (screenTrErr) {
          console.warn('[WebRTC] Erro ao anexar faixa de tela para novo peer:', screenTrErr);
        }
      });
    }

    // Garante transceivers sendrecv para áudio e vídeo na negociação SDP para o primeiro e demais participantes
    try {
      const transceivers = pc.getTransceivers();
      const hasAudioTr = transceivers.some(t => t.sender && t.sender.track && t.sender.track.kind === 'audio');
      const hasVideoTr = transceivers.some(t => t.sender && t.sender.track && t.sender.track.kind === 'video');

      if (!hasAudioTr) {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
      }
      if (!hasVideoTr) {
        pc.addTransceiver('video', { direction: 'sendrecv' });
      }
    } catch (e) {}

    // Configura canal de dados para chat e rolagem de dados de RPG
    if (!isPolite) {
      const dc = pc.createDataChannel('tavern-rpg-channel', { ordered: true });
      this.setupDataChannel(dc, peerId);
      peerData.dataChannel = dc;
    } else {
      pc.ondatachannel = (e) => {
        this.setupDataChannel(e.channel, peerId);
        peerData.dataChannel = e.channel;
      };
    }

    // Coleta e envio de ICE Candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, {
          type: 'candidate',
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE com ${peerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        peerData.health.gaveUp = false;
        peerData.health.cycles = 0;
      } else if (pc.iceConnectionState === 'failed') {
        // restartIce() sozinho não renegocia (não há handler de negotiationneeded): renegocia de verdade
        console.warn(`[WebRTC][ICE] Conexão com ${peerId} falhou. Renegociando.`);
        this.retryNegotiation(peerId, 'ice-failed');
      } else if (pc.iceConnectionState === 'disconnected') {
        // Pode ser oscilação temporária: se continuar desconectado, renegocia
        setTimeout(() => {
          const p = this.peers.get(peerId);
          if (p && p.connection === pc && pc.iceConnectionState === 'disconnected') {
            console.warn(`[WebRTC][ICE] ${peerId} continua desconectado. Renegociando.`);
            this.retryNegotiation(peerId, 'ice-disconnected');
          }
        }, 5000);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Estado de conexão com ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        peerData.health.gaveUp = false;
        peerData.health.cycles = 0;
        this.applyQualityProfileToConnection(pc);
      } else if (pc.connectionState === 'failed') {
        console.warn(`[WebRTC][conexão] Conexão com ${peerId} falhou. Renegociando.`);
        this.retryNegotiation(peerId, 'conn-failed');
      }
    };

    // Recebimento de faixas de mídia remotas
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Faixa remota recebida de ${peerId}:`, event.track.kind, event.streams);
      const track = event.track;
      let stream = event.streams && event.streams[0] ? event.streams[0] : null;
      const latestInfo = peerData.peerInfo || peerInfo;

      // Mídia vinda de observador: jogadores ignoram; observadores só recebem a voz (sem tile no grid)
      if (latestInfo?.observer) {
        if (track.kind !== 'audio') return;
        if (!this.isObserver) {
          // Sussurro: o observador manda a voz só para este jogador (sem tile e sem repassar)
          peerData.whisperStream = new MediaStream([track]);
          console.log(`[Sussurro] Voz de observador recebida de ${latestInfo?.name || peerId}.`);
          if (peerData.whisperActive) this.onWhisperState(peerId, latestInfo, true, peerData.whisperStream);
          return;
        }
        replaceStreamTrackByKind(peerData.remoteStream, track);
        this.setupRemoteAudioAnalyser(peerId, peerData.remoteStream);
        track.onunmute = () => this.onObserverVoiceAdded(peerId, latestInfo, peerData.remoteStream);
        track.onended = () => this.cleanupRemoteAudioAnalyser(peerId);
        this.onObserverVoiceAdded(peerId, latestInfo, peerData.remoteStream);
        return;
      }

      if (track.kind === 'video') {
        const matchesScreenStream = (stream && peerData.screenStreamId && stream.id === peerData.screenStreamId);
        const isScreen = matchesScreenStream ||
                         (peerData.isExpectingScreenShare && stream && stream.id !== peerData.cameraStreamId) ||
                         (stream && stream.id.toLowerCase().includes('screen')) ||
                         track.contentHint === 'detail';

        if (isScreen) {
          console.log(`[WebRTC] Renderizando vídeo de tela remota de ${peerId}`);
          if (stream && stream.id) {
            peerData.screenStreamId = stream.id;
          }
          if (!peerData.remoteScreenStream) {
            peerData.remoteScreenStream = new MediaStream();
          }
          replaceStreamTrackByKind(peerData.remoteScreenStream, track);
          if (typeof this.onRemoteScreenStreamAdded === 'function') {
            this.onRemoteScreenStreamAdded(peerId, latestInfo, peerData.remoteScreenStream);
          }
        } else {
          console.log(`[WebRTC] Renderizando câmera remota de ${peerId}`);
          if (stream && stream.id) {
            peerData.cameraStreamId = stream.id;
          }
          if (!peerData.remoteStream) {
            peerData.remoteStream = new MediaStream();
          }
          replaceStreamTrackByKind(peerData.remoteStream, track);
          // Só marca vídeo como ligado se for um stream de câmera real com faixa ativa
          const hasRealVideoStream = !!(stream && stream.getVideoTracks().length > 0);
          if (hasRealVideoStream && track.enabled && track.readyState === 'live' && !latestInfo?.videoOff) {
            if (peerData.peerInfo) {
              peerData.peerInfo.videoOff = false;
            }
          }
          this.onPeerStreamAdded(peerId, peerData.peerInfo || peerInfo, peerData.remoteStream);
          if (typeof this.onPeerInfoUpdated === 'function') {
            this.onPeerInfoUpdated(peerId, peerData.peerInfo || peerInfo);
          }
        }

        const handleTrackEnded = () => {
          console.log(`[WebRTC] Faixa de vídeo encerrada de ${peerId}:`, track.kind);
          if (isScreen) {
            if (peerData.remoteScreenStream) {
              peerData.remoteScreenStream.removeTrack(track);
            }
            if (typeof this.onRemoteScreenStreamEnded === 'function') {
              this.onRemoteScreenStreamEnded(peerId);
            }
          }
        };

        track.onended = handleTrackEnded;

      } else if (track.kind === 'audio') {
        // ÁUDIO: Diferenciar áudio de tela vs áudio de microfone/voz
        const isScreenStream = (stream && peerData.screenStreamId && stream.id === peerData.screenStreamId) ||
                               (peerData.remoteScreenStream && stream && stream.id === peerData.remoteScreenStream.id);
        const hasVoiceAudio = peerData.remoteStream && peerData.remoteStream.getAudioTracks().some(t => t !== track && t.readyState === 'live');
        const isScreenAudio = isScreenStream ||
                              ((latestInfo?.isScreenSharing) && (hasVoiceAudio || latestInfo?.hasScreenAudio)) ||
                              track.contentHint === 'music' ||
                              track.label.toLowerCase().includes('screen') ||
                              track.label.toLowerCase().includes('display') ||
                              track.label.toLowerCase().includes('sistema') ||
                              track.label.toLowerCase().includes('system') ||
                              track.label.toLowerCase().includes('tab') ||
                              track.label.toLowerCase().includes('guia');

        if (isScreenAudio) {
          console.log(`[WebRTC] Faixa de áudio de TELA recebida de ${peerId}:`, track);
          if (!peerData.remoteScreenStream) {
            peerData.remoteScreenStream = new MediaStream();
          }
          replaceStreamTrackByKind(peerData.remoteScreenStream, track);
          if (typeof this.onRemoteScreenStreamAdded === 'function') {
            this.onRemoteScreenStreamAdded(peerId, latestInfo, peerData.remoteScreenStream);
          }

          const handleScreenAudioEnded = () => {
            if (peerData.remoteScreenStream) {
              peerData.remoteScreenStream.removeTrack(track);
            }
          };
          track.onended = handleScreenAudioEnded;
        } else {
          console.log(`[WebRTC] Faixa de áudio de VOZ recebida de ${peerId}:`, track);
          if (!peerData.remoteStream) {
            peerData.remoteStream = new MediaStream();
          }
          const replacedOldAudio = replaceStreamTrackByKind(peerData.remoteStream, track);

          // Inicia analisador em tempo real para detectar quando o participante fala (mesmo baixo)
          this.setupRemoteAudioAnalyser(peerId, peerData.remoteStream);

          // Quando os primeiros pacotes RTP chegam e o track desmuta, re-sincroniza a reprodução do áudio
          track.onunmute = () => {
            console.log(`[WebRTC] Faixa de áudio de ${peerId} desmutada (RTP ativo). Sincronizando saída de áudio...`);
            if (peerData.remoteStream && this.peers.get(peerId) === peerData) {
              this.setupRemoteAudioAnalyser(peerId, peerData.remoteStream);
              this.onPeerStreamAdded(peerId, peerData.peerInfo || peerInfo, peerData.remoteStream);
              this.onPeerMediaStalled(peerId, peerData.peerInfo || peerInfo, peerData.remoteStream, 0);
            }
          };

          track.onended = () => {
            if (peerData.remoteStream) {
              try { peerData.remoteStream.removeTrack(track); } catch (e) {}
            }
            this.cleanupRemoteAudioAnalyser(peerId);
          };

          this.onPeerStreamAdded(peerId, peerData.peerInfo || peerInfo, peerData.remoteStream);
          if (replacedOldAudio) {
            this.onPeerMediaStalled(peerId, peerData.peerInfo || peerInfo, peerData.remoteStream, 0);
          }
        }
      }
    };

    this.startPeerWatchdog(peerId, peerData);
    return peerData;
  }

  /**
   * Configura eventos do DataChannel (mensagens, rolagens de dados de RPG)
   */
  setupDataChannel(channel, peerId) {
    channel.onopen = () => {
      console.log(`[WebRTC] DataChannel aberto com ${peerId}`);
    };
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.type === 'screen-share-ended') {
          console.log(`[WebRTC] Sinal de tela encerrada via DataChannel de ${peerId}`);
          const peerData = this.peers.get(peerId);
          if (peerData) {
            if (peerData.remoteScreenStream) {
              peerData.remoteScreenStream.getTracks().forEach(t => t.stop());
              peerData.remoteScreenStream = new MediaStream();
            }
            peerData.peerInfo.isScreenSharing = false;
          }
          if (typeof this.onRemoteScreenStreamEnded === 'function') {
            this.onRemoteScreenStreamEnded(peerId);
          }
          return;
        }

        if (data && data.type === 'gm-toggle-dice-rolling') {
          if (typeof this.onDiceBlockedStateChange === 'function') {
            this.onDiceBlockedStateChange(!!data.blocked, data.gmName);
          }
        }

        this.onDataMessage(peerId, data);
      } catch (e) {
        this.onDataMessage(peerId, { text: event.data });
      }
    };
  }

  /**
   * Processa sinais recebidos (Offer, Answer, ICE Candidate, Screen Share Events)
   */
  async handleIncomingSignal(signal) {
    const fromPeerId = signal.from;
    if (!fromPeerId || fromPeerId === this.myPeerId || this._leftRoom) return;

    // Tratamento de encerramento imediato de tela remota
    if (signal.type === 'screen-share-ended') {
      console.log(`[WebRTC] Sinal explícito de tela encerrada de ${fromPeerId}`);
      const peerData = this.peers.get(fromPeerId);
      if (peerData) {
        if (peerData.remoteScreenStream) {
          peerData.remoteScreenStream.getTracks().forEach(t => t.stop());
          peerData.remoteScreenStream = new MediaStream();
        }
        if (peerData.peerInfo) {
          peerData.peerInfo.isScreenSharing = false;
          peerData.peerInfo.hasScreenAudio = false;
        }
      }
      if (typeof this.onRemoteScreenStreamEnded === 'function') {
        this.onRemoteScreenStreamEnded(fromPeerId);
      }
      return;
    }

    // Sussurro: o observador avisa que está falando só comigo (não cria peer novo por isso)
    if (signal.type === 'whisper-state') {
      const whisperPeer = this.peers.get(fromPeerId);
      if (whisperPeer && whisperPeer.peerInfo?.observer && !this.isObserver) {
        whisperPeer.whisperActive = !!signal.active;
        this.onWhisperState(fromPeerId, whisperPeer.peerInfo, !!signal.active, whisperPeer.whisperStream || null);
      }
      return;
    }

    if (signal.type === 'cam-state') {
      const peerObj = this.peers.get(fromPeerId);
      if (peerObj && peerObj.peerInfo) {
        peerObj.peerInfo.videoOff = !!signal.videoOff;
        if (typeof this.onPeerInfoUpdated === 'function') {
          this.onPeerInfoUpdated(fromPeerId, peerObj.peerInfo);
        }
      }
      return;
    }

    // Passo 3 do reparo: o outro lado pediu para renegociar/recriar
    if (signal.type === 'renegotiate') {
      const p = this.peers.get(fromPeerId);
      if (p) {
        const pc = p.connection;
        if (!pc || pc.connectionState === 'failed' || pc.iceConnectionState === 'failed' || pc.connectionState === 'new') {
          console.warn(`[WebRTC][negociação] ${fromPeerId} pediu reparo e conexão está ${pc?.connectionState}. Recriando conexão.`);
          await this.rebuildPeerConnection(fromPeerId);
        } else {
          console.warn(`[WebRTC][negociação] ${fromPeerId} pediu renegociação.`);
          await this.retryNegotiation(fromPeerId, 'pedido-do-outro-lado');
        }
      }
      return;
    }

    // Toda operação SDP/ICE para um mesmo peer passa pela fila serializada para eliminar corrida/glare
    await this.enqueuePeerSignaling(fromPeerId, async () => {
      if (this._leftRoom) return;

      // Pedido de renegociação de tela para quem acabou de entrar na sala
      if (signal.type === 'request-screen-renegotiation') {
        if (this.isScreenSharing && this.screenStream) {
          console.log(`[WebRTC] Pedido de renegociação de tela recebido de ${fromPeerId}. Enviando oferta...`);
          const peerObj = this.peers.get(fromPeerId);
          if (peerObj && peerObj.connection && peerObj.connection.connectionState !== 'closed') {
            const pc = peerObj.connection;
            const senders = pc.getSenders();
            this.screenStream.getTracks().forEach(track => {
              if (!senders.some(s => s.track && s.track.id === track.id)) {
                try {
                  pc.addTrack(track, this.screenStream);
                } catch (e) {}
              }
            });
            if (pc.signalingState !== 'stable') {
              setTimeout(() => this.retryNegotiation(fromPeerId, 'screen-req', false), 600);
              return;
            }
            peerObj.makingOffer = true;
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await this.sendSignal(fromPeerId, {
                type: 'offer',
                isScreenShareOffer: true,
                screenStreamId: this.screenStream.id,
                hasScreenAudio: this.hasScreenAudio,
                sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
              });
              console.log(`[WebRTC] Oferta de tela enviada com sucesso para ${fromPeerId}`);
            } catch (err) {
              console.warn('[WebRTC] Erro ao enviar oferta de renegociação:', err);
            } finally {
              peerObj.makingOffer = false;
            }
          }
        }
        return;
      }

      // O outro lado recriou a RTCPeerConnection do zero: recria aqui também sem remover o tile da tela
      if (signal.type === 'peer-rebuild') {
        const old = this.peers.get(fromPeerId);
        if (old) {
          console.warn(`[WebRTC][reparo] Recriando conexão local acompanhando ${fromPeerId}.`);
          if (old.watchdog) clearInterval(old.watchdog);
          this.cleanupRemoteAudioAnalyser(fromPeerId);
          try { old.connection.close(); } catch (e) {}
          const fresh = this.createPeerConnection(fromPeerId, old.peerInfo, old.isPolite);
          fresh.isExpectingScreenShare = old.isExpectingScreenShare;
          fresh.screenStreamId = old.screenStreamId;
          fresh.health = old.health || fresh.health;
          fresh.health.lastAction = Date.now();
          this.peers.set(fromPeerId, fresh);
        }
        return;
      }

      let peerObj = this.peers.get(fromPeerId);
      if (!peerObj) {
        const rosterInfo = this.roomRoster.get(fromPeerId);
        const initialInfo = rosterInfo ? { ...rosterInfo } : { name: 'Aventureiro', role: 'jogador', _isPlaceholder: true };
        const isPolite = this.myPeerId < fromPeerId;
        peerObj = this.createPeerConnection(fromPeerId, initialInfo, isPolite);
        this.peers.set(fromPeerId, peerObj);
      }

      const pc = peerObj.connection;
      if (!pc || pc.connectionState === 'closed') return;

      try {
        if (signal.type === 'offer') {
          if (signal.isScreenShareOffer || signal.screenStreamId) {
            peerObj.isExpectingScreenShare = true;
            peerObj.screenStreamId = signal.screenStreamId || peerObj.screenStreamId;
            if (peerObj.peerInfo) {
              peerObj.peerInfo.isScreenSharing = true;
              peerObj.peerInfo.hasScreenAudio = !!signal.hasScreenAudio;
            }
          } else if (signal.isCamToggle) {
            peerObj.isExpectingScreenShare = false;
          }

          if (signal.videoOff !== undefined && peerObj.peerInfo) {
            peerObj.peerInfo.videoOff = !!signal.videoOff;
            if (typeof this.onPeerInfoUpdated === 'function') {
              this.onPeerInfoUpdated(fromPeerId, peerObj.peerInfo);
            }
          }

          const offerCollision = (peerObj.makingOffer || pc.signalingState !== 'stable');
          peerObj.ignoreOffer = !peerObj.isPolite && offerCollision;

          if (peerObj.ignoreOffer) {
            console.warn(`[WebRTC] Glare detectado. Ignorando oferta do peer ${fromPeerId}`);
            return;
          }

          if (offerCollision) {
            try {
              await pc.setLocalDescription({ type: 'rollback' });
            } catch (e) {}
          }

          const sdpInit = signal.sdp ? { type: signal.sdp.type, sdp: signal.sdp.sdp } : null;
          if (!sdpInit) return;

          await pc.setRemoteDescription(new RTCSessionDescription(sdpInit));

          // Esvazia ICE Candidates pendentes
          while (peerObj.pendingCandidates.length > 0) {
            const candidate = peerObj.pendingCandidates.shift();
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (candErr) {
              console.warn('[WebRTC] Aviso ao aplicar candidate pendente no offer:', candErr);
            }
          }

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          await this.sendSignal(fromPeerId, {
            type: 'answer',
            sdp: {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp
            }
          });

          // Se estamos transmitindo tela, verifica se o recém-chegado já recebeu nossas faixas
          if (this.isScreenSharing && this.screenStream) {
            setTimeout(() => {
              this.enqueuePeerSignaling(fromPeerId, async () => {
                const p = this.peers.get(fromPeerId);
                if (!p || !p.connection || p.connection.connectionState === 'closed' || this._leftRoom) return;
                if (p.connection.signalingState === 'stable' && this.isScreenSharing && this.screenStream) {
                  const senders = p.connection.getSenders();
                  const hasScreenTrack = this.screenStream.getVideoTracks().some(vTrack =>
                    senders.some(s => s.track && s.track.id === vTrack.id)
                  );
                  if (!hasScreenTrack) {
                    console.log(`[WebRTC] Enviando oferta subsequente de tela para ${fromPeerId}...`);
                    this.screenStream.getTracks().forEach(t => {
                      try { p.connection.addTrack(t, this.screenStream); } catch (e) {}
                    });
                    p.makingOffer = true;
                    try {
                      const renegOffer = await p.connection.createOffer();
                      await p.connection.setLocalDescription(renegOffer);
                      await this.sendSignal(fromPeerId, {
                        type: 'offer',
                        isScreenShareOffer: true,
                        screenStreamId: this.screenStream.id,
                        hasScreenAudio: this.hasScreenAudio,
                        sdp: { type: p.connection.localDescription.type, sdp: p.connection.localDescription.sdp }
                      });
                    } catch (e) {} finally {
                      p.makingOffer = false;
                    }
                  }
                }
              });
            }, 600);
          }

        } else if (signal.type === 'answer') {
          const sdpInit = signal.sdp ? { type: signal.sdp.type, sdp: signal.sdp.sdp } : null;
          if (!sdpInit) return;

          if (pc.signalingState !== 'have-local-offer') {
            console.warn(`[WebRTC] Ignorando answer duplicado pois signalingState é ${pc.signalingState}`);
            return;
          }

          await pc.setRemoteDescription(new RTCSessionDescription(sdpInit));

          while (peerObj.pendingCandidates.length > 0) {
            const candidate = peerObj.pendingCandidates.shift();
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (candErr) {
              console.warn('[WebRTC] Aviso ao aplicar candidate pendente no answer:', candErr);
            }
          }

          // Se estamos compartilhando tela e a conexão estabilizou, garante que as faixas de tela sejam negociadas
          if (this.isScreenSharing && this.screenStream) {
            setTimeout(() => {
              this.enqueuePeerSignaling(fromPeerId, async () => {
                const p = this.peers.get(fromPeerId);
                if (!p || !p.connection || p.connection.connectionState === 'closed' || this._leftRoom) return;
                if (p.connection.signalingState === 'stable' && this.isScreenSharing && this.screenStream) {
                  const senders = p.connection.getSenders();
                  const hasScreenTrack = this.screenStream.getVideoTracks().some(vTrack =>
                    senders.some(s => s.track && s.track.id === vTrack.id)
                  );
                  if (!hasScreenTrack) {
                    console.log(`[WebRTC] Renegociando tela pendente com ${fromPeerId}...`);
                    this.screenStream.getTracks().forEach(t => {
                      try { p.connection.addTrack(t, this.screenStream); } catch (e) {}
                    });
                    p.makingOffer = true;
                    try {
                      const offer = await p.connection.createOffer();
                      await p.connection.setLocalDescription(offer);
                      await this.sendSignal(fromPeerId, {
                        type: 'offer',
                        isScreenShareOffer: true,
                        screenStreamId: this.screenStream.id,
                        hasScreenAudio: this.hasScreenAudio,
                        sdp: { type: p.connection.localDescription.type, sdp: p.connection.localDescription.sdp }
                      });
                    } catch (renegErr) {
                      console.warn('[WebRTC] Erro ao renegociar tela após answer:', renegErr);
                    } finally {
                      p.makingOffer = false;
                    }
                  }
                }
              });
            }, 500);
          }

        } else if (signal.type === 'candidate') {
          if (signal.candidate) {
            if (pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
              } catch (candErr) {
                console.warn('[WebRTC] Aviso ao adicionar candidate recebido:', candErr);
              }
            } else {
              peerObj.pendingCandidates.push(signal.candidate);
            }
          }
        }
      } catch (err) {
        // Antes isso era só um console.error e a conversa ficava parada. Agora tenta de novo.
        console.error(`[WebRTC][negociação] Falha ao processar "${signal.type}" de ${fromPeerId}:`, err);
        setTimeout(() => this.retryNegotiation(fromPeerId, 'erro-' + signal.type), 500);
      }
    });
  }

  /**
   * Notifica peers sobre alteração de metadata local (mute, nome, etc)
   */
  broadcastMetadata(isHeartbeat = false) {
    if (this._leftRoom) return;
    const meta = {
      type: 'meta',
      userInfo: this.userInfo
    };

    // Via DataChannel para baixa latência
    if (!isHeartbeat) {
      for (const peer of this.peers.values()) {
        if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
          try { peer.dataChannel.send(JSON.stringify(meta)); } catch (e) {}
        }
      }
    }

    // Se estiver em modo Servidor Central
    if (this.isServerSignalingMode && this.roomId) {
      fetch(`/api/rooms/${this.roomId}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          peerId: this.myPeerId,
          userInfo: this.userInfo
        })
      }).catch(() => {});
    }

    // Se estiver em modo BroadcastChannel
    if (this.broadcastChannel && !isHeartbeat) {
      this.broadcastChannel.postMessage({
        type: 'peer-meta',
        from: this.myPeerId,
        userInfo: this.userInfo
      });
    }

    // Se estiver no Firebase
    if (this.isFirebaseMode && this.firebaseDb && this.roomId && !this._leftRoom) {
      const myPeerRef = ref(this.firebaseDb, `rooms/${this.roomId}/peers/${this.myPeerId}`);
      this._hbSeq = (this._hbSeq || 0) + 1;
      set(myPeerRef, removeUndefined({
        id: this.myPeerId,
        ...this.userInfo,
        hb: this._hbSeq,
        updatedAt: Date.now()
      })).catch(err => console.warn('[WebRTC] Erro ao atualizar status no Firebase:', err));
    }
  }

  /**
   * Envia uma mensagem ou rolagem de dados RPG para todos os participantes
   */
  broadcastRpgAction(actionData) {
    const rawObj = {
      from: this.myPeerId,
      senderName: this.userInfo.name,
      senderRole: this.userInfo.role,
      timestamp: Date.now(),
      ...actionData
    };
    const payload = JSON.stringify(rawObj);

    for (const peer of this.peers.values()) {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        try {
          peer.dataChannel.send(payload);
        } catch (e) {
          console.warn('[WebRTC] Falha ao enviar via DataChannel:', e);
        }
      }
    }

    if (this.isServerSignalingMode && this.roomId) {
      fetch(`/api/rooms/${this.roomId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.myPeerId,
          data: rawObj
        })
      }).catch(() => {});
    }

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: 'rpg-action',
          from: this.myPeerId,
          data: rawObj
        });
      } catch (e) {
        console.warn('[WebRTC] Falha ao enviar via BroadcastChannel:', e);
      }
    }
  }

  /**
   * Lista de observadores conectados (para o aviso "👁 N observando" e o painel dos observadores)
   */
  notifyObserversChanged() {
    const observers = [...this.peers.values()]
      .filter(p => p.peerInfo?.observer)
      .map(p => ({ peerId: p.peerId, name: p.peerInfo.name || 'Observador' }));
    this.onObserversChanged(observers);
  }

  /**
   * Limite de 15 pessoas (jogadores + observadores): se passar, o observador que entrou
   * por último libera a vaga. Cada observador checa só a si mesmo.
   */
  scheduleObserverCapacityCheck() {
    if (!this.isObserver) return;
    if (this.capacityCheckTimer) clearTimeout(this.capacityCheckTimer);
    this.capacityCheckTimer = setTimeout(() => {
      this.capacityCheckTimer = null;
      const everyone = [...this.roomRoster.values(), { id: this.myPeerId, ...this.userInfo }];
      const excess = everyone.length - 15;
      if (excess <= 0) return;
      const newestObservers = everyone
        .filter(p => p.observer)
        .sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0) || String(b.id).localeCompare(String(a.id)))
        .slice(0, excess);
      if (newestObservers.some(p => p.id === this.myPeerId)) {
        this.onObserverCapacityExceeded();
      }
    }, 1200);
  }

  /**
   * Sussurro (só observador): manda a voz para um ou mais jogadores, sem os outros ouvirem.
   * Reaproveita o transceiver de áudio que já existe em cada conexão, então não precisa
   * renegociar: só os jogadores escolhidos recebem a faixa.
   * @param {string[]} ids jogadores escolhidos (lista vazia para parar)
   * @returns {string[]} jogadores que estão recebendo o sussurro agora
   */
  setWhisperTargets(ids) {
    if (!this.isObserver) return [];
    const wanted = new Set((ids || []).filter(id => {
      const p = this.peers.get(id);
      return !!(p && p.connection && !p.peerInfo?.observer);
    }));
    for (const id of [...this.whisperTargets]) {
      if (!wanted.has(id)) this.stopWhisperTo(id);
    }
    for (const id of wanted) {
      if (!this.whisperTargets.has(id)) this.startWhisperTo(id);
    }
    return [...this.whisperTargets];
  }

  startWhisperTo(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connection || peer.peerInfo?.observer) return false;
    const track = this.processedAudioTrack || this.localStream?.getAudioTracks()[0];
    if (!track) return false;
    if (!peer.whisperSender) {
      // Adiciona a faixa na conexão e renegocia (mesmo caminho da câmera e da tela, que já funcionam)
      peer.whisperSender = peer.connection.addTrack(track, this.localStream || new MediaStream([track]));
    }
    this.whisperTargets.add(peerId);
    console.log(`[Sussurro] Enviando voz só para ${peer.peerInfo?.name || peerId}.`);
    this.sendSignal(peerId, { type: 'whisper-state', active: true }).catch(() => {});
    this.retryNegotiation(peerId, 'sussurro', false);
    return true;
  }

  stopWhisperTo(peerId) {
    const peer = this.peers.get(peerId);
    if (peer && peer.whisperSender) {
      try { peer.connection.removeTrack(peer.whisperSender); } catch (e) {}
      peer.whisperSender = null;
      this.retryNegotiation(peerId, 'fim-do-sussurro', false);
    }
    this.whisperTargets.delete(peerId);
    this.sendSignal(peerId, { type: 'whisper-state', active: false }).catch(() => {});
  }

  findAudioTransceiver(pc) {
    return pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio') || null;
  }

  /**
   * Vigia se o áudio de cada peer continua chegando. Se parar (e o outro não estiver mutado),
   * tenta em ordem, cada passo depois de mais 8 s sem progresso:
   * 1) reanexa o áudio na tela; 2) renegocia com ICE restart; 3) recria a conexão
   * (o lado impolite recria; o polite pede para o outro renegociar); 4) renegocia de novo.
   * Depois de 3 ciclos completos desiste até o áudio voltar a chegar.
   */
  startPeerWatchdog(peerId, peerData) {
    peerData.watchdog = setInterval(() => {
      if (this.peers.get(peerId) !== peerData) {
        clearInterval(peerData.watchdog);
        return;
      }
      this.checkPeerMedia(peerId, peerData);
    }, 2000);
  }

  async checkPeerMedia(peerId, peerData) {
    const h = peerData.health;
    const pc = peerData.connection;
    if (!h || !pc || pc.connectionState === 'closed' || h.checking) return;
    h.checking = true;
    try {
      let bytes = 0;
      try {
        const stats = await pc.getStats();
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) bytes += r.bytesReceived || 0;
        });
      } catch (e) {}

      const now = Date.now();
      const name = peerData.peerInfo?.name || peerId;
      const remoteMuted = !!peerData.peerInfo?.audioMuted;
      // Observador não manda áudio para jogador (só quando está sussurrando): não é falha
      const audioExpected = !(peerData.peerInfo?.observer && !this.isObserver && !peerData.whisperActive);

      if (bytes > h.lastBytes || remoteMuted || !audioExpected) {
        h.lastBytes = bytes;
        h.lastProgress = now;
        h.next = 0;
        h.cycles = 0;
        h.gaveUp = false;
        return;
      }

      if (h.gaveUp) return;
      if (now - Math.max(h.lastProgress, h.lastAction || 0) < 8000) return;

      const step = h.next;
      h.lastAction = now;
      h.next++;
      if (h.next > 3) {
        h.next = 0;
        h.cycles++;
      }
      if (h.cycles >= 3) {
        h.gaveUp = true;
        console.warn(`[WebRTC][áudio] Desisti de reconectar o áudio de ${name} (${pc.connectionState}). Vou tentar de novo se o estado mudar.`);
        return;
      }

      if (step === 0) {
        console.warn(`[WebRTC][áudio] Sem áudio chegando de ${name} (conexão ${pc.connectionState}). Passo 1: reanexando o áudio na tela.`);
        this.onPeerMediaStalled(peerId, peerData.peerInfo, peerData.remoteStream, 1);
      } else if (step === 1) {
        console.warn(`[WebRTC][áudio] Continua sem áudio de ${name}. Passo 2: renegociando a conexão (ICE restart).`);
        this.retryNegotiation(peerId, 'sem-audio');
      } else if (step === 2) {
        if (!peerData.isPolite) {
          console.warn(`[WebRTC][áudio] Continua sem áudio de ${name}. Passo 3: recriando a conexão.`);
          await this.rebuildPeerConnection(peerId);
        } else {
          console.warn(`[WebRTC][áudio] Continua sem áudio de ${name}. Passo 3: pedindo para o outro lado recriar/renegociar.`);
          this.sendSignal(peerId, { type: 'renegotiate' }).catch(() => {});
        }
      } else {
        console.warn(`[WebRTC][áudio] Continua sem áudio de ${name}. Passo 4: nova renegociação.`);
        this.retryNegotiation(peerId, 'sem-audio-2');
      }
    } finally {
      h.checking = false;
    }
  }

  /**
   * Cria uma nova RTCPeerConnection com o mesmo jogador, sem tirar o tile da tela
   * (não dispara "saiu da sala"), avisa o outro lado via 'peer-rebuild' e manda nova oferta.
   */
  async rebuildPeerConnection(peerId) {
    return this.enqueuePeerSignaling(peerId, async () => {
      const old = this.peers.get(peerId);
      if (!old || this._leftRoom) return;
      const wasWhisperTarget = this.whisperTargets.has(peerId);
      if (old.watchdog) clearInterval(old.watchdog);
      this.cleanupRemoteAudioAnalyser(peerId);
      try { old.connection.close(); } catch (e) {}
      this.peers.delete(peerId);

      const fresh = this.createPeerConnection(peerId, old.peerInfo, old.isPolite);
      fresh.isExpectingScreenShare = old.isExpectingScreenShare;
      fresh.screenStreamId = old.screenStreamId;
      fresh.health = old.health;
      fresh.health.lastAction = Date.now();
      this.peers.set(peerId, fresh);

      if (!fresh.isPolite) {
        fresh.makingOffer = true;
        try {
          await this.sendSignal(peerId, { type: 'peer-rebuild' });
          const offer = await fresh.connection.createOffer();
          await fresh.connection.setLocalDescription(offer);
          await this.sendSignal(peerId, {
            type: 'offer',
            isScreenShareOffer: !!this.isScreenSharing,
            screenStreamId: this.screenStream ? this.screenStream.id : null,
            hasScreenAudio: !!this.hasScreenAudio,
            sdp: { type: fresh.connection.localDescription.type, sdp: fresh.connection.localDescription.sdp }
          });
        } catch (err) {
          console.warn(`[WebRTC][negociação] Falha ao enviar oferta nova para ${peerId}:`, err);
        } finally {
          fresh.makingOffer = false;
        }
      }
      if (wasWhisperTarget) {
        this.whisperTargets.delete(peerId);
        this.startWhisperTo(peerId);
      }
    });
  }

  /**
   * Renegocia com ICE restart. Se o outro lado está no meio de outra negociação, espera e tenta de novo.
   */
  async retryNegotiation(peerId, reason, iceRestart = true) {
    return this.enqueuePeerSignaling(peerId, async () => {
      const peer = this.peers.get(peerId);
      if (!peer || !peer.connection || peer.connection.connectionState === 'closed' || this._leftRoom) return false;
      const pc = peer.connection;
      if (pc.signalingState !== 'stable') {
        if (peer.health.waits < 10) {
          peer.health.waits++;
          setTimeout(() => this.retryNegotiation(peerId, reason, iceRestart), 1500);
        }
        return false;
      }
      peer.health.waits = 0;
      peer.makingOffer = true;
      try {
        const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
        await pc.setLocalDescription(offer);
        await this.sendSignal(peerId, {
          type: 'offer',
          isScreenShareOffer: !!this.isScreenSharing,
          screenStreamId: this.screenStream ? this.screenStream.id : null,
          hasScreenAudio: !!this.hasScreenAudio,
          sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
        });
        console.log(`[WebRTC][negociação] Nova oferta enviada para ${peerId} (${reason}).`);
        return true;
      } catch (err) {
        console.warn(`[WebRTC][negociação] Falha ao renegociar com ${peerId} (${reason}):`, err);
        return false;
      } finally {
        peer.makingOffer = false;
      }
    });
  }

  closePeer(peerId) {
    this.cleanupRemoteAudioAnalyser(peerId);
    this.peerQueues.delete(peerId);
    const peerObj = this.peers.get(peerId);
    if (peerObj) {
      if (peerObj.watchdog) clearInterval(peerObj.watchdog);
      if (peerObj.connection) {
        try { peerObj.connection.close(); } catch (e) {}
      }
      this.peers.delete(peerId);
      if (this.whisperTargets.delete(peerId)) {
        this.onWhisperTargetChanged([...this.whisperTargets]);
      }
      this.onPeerStreamRemoved(peerId, peerObj.peerInfo);
      if (peerObj.peerInfo?.observer) this.notifyObserversChanged();
      console.log(`[WebRTC] Peer removido: ${peerId}`);
    }
  }

  /**
   * Monitor de Voz Ativa de Participante Remoto (Borda Verde em tempo real)
   * Analisa diretamente o sinal de áudio recebido nos fones/alto-falantes.
   * Detecta com precisão quando o outro participante fala alto, fala baixo ou sussurra.
   */
  setupRemoteAudioAnalyser(peerId, stream) {
    if (!stream || stream.getAudioTracks().length === 0) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!this.remoteAudioContext) {
        this.remoteAudioContext = new AudioCtx();
      }
      if (this.remoteAudioContext.state === 'suspended') {
        this.remoteAudioContext.resume().catch(() => {});
      }

      this.cleanupRemoteAudioAnalyser(peerId);

      const source = this.remoteAudioContext.createMediaStreamSource(stream);
      const analyser = this.remoteAudioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);

      const timeData = new Uint8Array(analyser.fftSize);
      let wasSpeaking = false;
      let lastSpokeTime = 0;

      const interval = setInterval(() => {
        if (!this.peers.has(peerId)) {
          this.cleanupRemoteAudioAnalyser(peerId);
          return;
        }

        analyser.getByteTimeDomainData(timeData);
        let sumSquares = 0;
        for (let i = 0; i < timeData.length; i++) {
          const val = (timeData[i] - 128) / 128;
          sumSquares += val * val;
        }
        const rms = Math.sqrt(sumSquares / timeData.length);
        const level = Math.round(rms * 100);

        // Sensibilidade ultra-alta para vozes baixas e sussurros (rms > 0.015 ou level >= 2)
        const isSpeaking = level >= 2;
        if (isSpeaking) {
          lastSpokeTime = Date.now();
        }

        // Hangover de 380ms para a borda verde dos outros jogadores não ficar piscando entre palavras
        const speakingNow = isSpeaking || (Date.now() - lastSpokeTime < 380);

        if (speakingNow !== wasSpeaking) {
          wasSpeaking = speakingNow;
          this.onSpeakingState(peerId, speakingNow, level);
        }
      }, 50);

      this.remoteAnalysers.set(peerId, { source, analyser, interval });
    } catch (err) {
      console.warn(`[WebRTC] Não foi possível iniciar analisador de áudio para ${peerId}:`, err);
    }
  }

  cleanupRemoteAudioAnalyser(peerId) {
    const data = this.remoteAnalysers.get(peerId);
    if (data) {
      if (data.interval) clearInterval(data.interval);
      try { data.source.disconnect(); } catch (e) {}
      this.remoteAnalysers.delete(peerId);
      this.onSpeakingState(peerId, false, 0);
    }
  }

  /**
   * Gerenciamento de heartbeat no Firebase e limpeza imediata de abas/janelas que travaram
   */
  readActiveTabsRegistry() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(STORAGE_KEY_ACTIVE_TABS);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') return parsed;
        }
      }
    } catch (e) {}
    return {};
  }

  writeActiveTabsRegistry(registry) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY_ACTIVE_TABS, JSON.stringify(registry));
      }
    } catch (e) {}
  }

  touchLocalActiveTab(closed = false) {
    if (!this.roomId || !this.myPeerId) return;
    const reg = this.readActiveTabsRegistry();
    reg[this._tabId] = {
      roomId: this.roomId,
      peerId: this.myPeerId,
      name: this.userInfo?.name || 'Aventureiro',
      updatedAt: Date.now(),
      closed: !!closed
    };
    this.writeActiveTabsRegistry(reg);
  }

  clearLocalActiveTab() {
    const reg = this.readActiveTabsRegistry();
    if (reg[this._tabId]) {
      delete reg[this._tabId];
      this.writeActiveTabsRegistry(reg);
    }
  }

  async cleanupCrashedLocalTabs() {
    if (!this.firebaseDb || !this.roomId) return;
    const reg = this.readActiveTabsRegistry();
    const now = Date.now();
    const staleDeletes = [];
    let changed = false;

    for (const [tid, entry] of Object.entries(reg)) {
      if (tid === this._tabId) continue;
      if (!entry || !entry.peerId) {
        delete reg[tid];
        changed = true;
        continue;
      }
      const isStale = !!entry.closed || (now - (entry.updatedAt || 0) > 6000);
      if (isStale) {
        if (entry.roomId === this.roomId && entry.peerId !== this.myPeerId) {
          console.log(`[WebRTC] Removendo registro fantasma da sessão anterior neste PC (${entry.peerId}).`);
          staleDeletes.push(
            remove(ref(this.firebaseDb, `rooms/${this.roomId}/peers/${entry.peerId}`)).catch(() => {}),
            remove(ref(this.firebaseDb, `rooms/${this.roomId}/signals/${entry.peerId}`)).catch(() => {})
          );
        }
        delete reg[tid];
        changed = true;
      }
    }

    if (changed) this.writeActiveTabsRegistry(reg);
    if (staleDeletes.length > 0) {
      await Promise.allSettled(staleDeletes);
    }
  }

  startFirebasePresenceMaintenance() {
    this.stopFirebasePresenceMaintenance();
    this.touchLocalActiveTab(false);

    this.localTabInterval = setInterval(() => {
      if (this._leftRoom) return;
      this.touchLocalActiveTab(false);
    }, 2000);

    this.heartbeatInterval = setInterval(() => {
      if (this._leftRoom || !this.isFirebaseMode || !this.firebaseDb || !this.roomId) return;
      this.broadcastMetadata(true);
    }, 10000);

    this.pruneInterval = setInterval(() => {
      if (this._leftRoom || !this.isFirebaseMode || !this.firebaseDb || !this.roomId) return;
      this.pruneStalePeers();
    }, 6000);
  }

  stopFirebasePresenceMaintenance() {
    if (this.localTabInterval) {
      clearInterval(this.localTabInterval);
      this.localTabInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
  }

  removeGhostPeerEverywhere(peerId) {
    if (!peerId || peerId === this.myPeerId) return;
    this.roomRoster.delete(peerId);
    this.peerLocalHeartbeats.delete(peerId);
    this.closePeer(peerId);
    if (this.isFirebaseMode && this.firebaseDb && this.roomId) {
      remove(ref(this.firebaseDb, `rooms/${this.roomId}/peers/${peerId}`)).catch(() => {});
      remove(ref(this.firebaseDb, `rooms/${this.roomId}/signals/${peerId}`)).catch(() => {});
    }
  }

  pruneStalePeers() {
    const now = Date.now();
    for (const [peerId, rosterData] of Array.from(this.roomRoster.entries())) {
      if (!peerId || peerId === this.myPeerId) continue;
      // Só aplica expiração rápida a peers que emitem heartbeat (hb numérico)
      if (!rosterData || typeof rosterData.hb !== 'number') continue;

      const rec = this.peerLocalHeartbeats.get(peerId);
      if (!rec) {
        this.peerLocalHeartbeats.set(peerId, { hb: rosterData.hb, localAt: now });
        continue;
      }

      const silentMs = now - rec.localAt;
      const p = this.peers.get(peerId);
      const pc = p && p.connection;
      const connDead = pc && (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected' ||
        pc.iceConnectionState === 'failed' ||
        pc.iceConnectionState === 'disconnected'
      );

      if (silentMs > 32000 || (connDead && silentMs > 18000)) {
        console.warn(`[WebRTC] Participante fantasma detectado sem heartbeat há ${Math.round(silentMs / 1000)}s: ${rosterData.name || peerId}. Removendo da sala.`);
        this.removeGhostPeerEverywhere(peerId);
      }
    }
  }

  /**
   * Limpeza de emergência ao recarregar/fechar janela (pagehide / beforeunload) usando keepalive
   */
  sendUnloadCleanup() {
    const roomId = this.roomId;
    const peerId = this.myPeerId;
    if (!roomId || !peerId || this._leftRoom) return;
    this._leftRoom = true;
    this.stopFirebasePresenceMaintenance();
    this.touchLocalActiveTab(true);

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({ type: 'peer-leave', from: peerId });
      } catch (e) {}
    }

    if (this.isServerSignalingMode && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try {
        const blob = new Blob([JSON.stringify({ peerId })], { type: 'application/json' });
        navigator.sendBeacon(`/api/rooms/${encodeURIComponent(roomId)}/leave`, blob);
      } catch (e) {}
    }

    if (this.isFirebaseMode) {
      try {
        const cfg = getStoredFirebaseConfig();
        const dbUrl = (cfg?.databaseURL || BUILTIN_FIREBASE_CONFIG.databaseURL || '').replace(/\/$/, '');
        if (dbUrl) {
          fetch(`${dbUrl}/rooms/${encodeURIComponent(roomId)}/peers/${encodeURIComponent(peerId)}.json`, {
            method: 'DELETE',
            keepalive: true
          }).catch(() => {});
          fetch(`${dbUrl}/rooms/${encodeURIComponent(roomId)}/signals/${encodeURIComponent(peerId)}.json`, {
            method: 'DELETE',
            keepalive: true
          }).catch(() => {});
        }
      } catch (e) {}
      if (this.firebaseDb) {
        try { remove(ref(this.firebaseDb, `rooms/${roomId}/peers/${peerId}`)).catch(() => {}); } catch (e) {}
      }
    }
  }

  /**
   * Sai da sala e encerra todas as conexões
   */
  leaveRoom() {
    this._leftRoom = true;
    this.stopFirebasePresenceMaintenance();
    this.clearLocalActiveTab();

    // Executa cancelamentos de sinalização
    this.signalingCleanups.forEach(fn => {
      try { fn(); } catch(e) {}
    });
    this.signalingCleanups = [];

    // Limpa todos os analisadores de áudio remotos
    for (const peerId of Array.from(this.remoteAnalysers.keys())) {
      this.cleanupRemoteAudioAnalyser(peerId);
    }
    if (this.remoteAudioContext) {
      try { this.remoteAudioContext.close(); } catch (e) {}
      this.remoteAudioContext = null;
    }

    // Notifica saída no broadcastChannel se ativo
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: 'peer-leave',
          from: this.myPeerId
        });
        this.broadcastChannel.close();
      } catch (e) {}
      this.broadcastChannel = null;
    }

    // Encerra todos os peers e seus watchdogs
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.watchdog) clearInterval(peer.watchdog);
      if (peer.connection) {
        try { peer.connection.close(); } catch (e) {}
      }
      this.onPeerStreamRemoved(peerId, peer.peerInfo);
    }
    this.peers.clear();
    this.peerQueues.clear();
    this.roomRoster.clear();
    this.peerLocalHeartbeats.clear();
    if (this.capacityCheckTimer) {
      clearTimeout(this.capacityCheckTimer);
      this.capacityCheckTimer = null;
    }

    if (this.audioMeterInterval) {
      clearInterval(this.audioMeterInterval);
      this.audioMeterInterval = null;
    }

    this.stopAdaptiveNetworkMonitor();

    if (this.audioContext) {
      try { this.audioContext.close(); } catch(e) {}
      this.audioContext = null;
    }

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
      this.isScreenSharing = false;
    }

    if (this.rawVideoStream) {
      this.rawVideoStream.getTracks().forEach(t => t.stop());
      this.rawVideoStream = null;
    }
    this.rawVideoTrack = null;

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.roomId = null;
    console.log('[WebRTC] Desconectado da sala com sucesso.');
  }

  /**
   * Medidor de Velocidade e Desempenho Embutido e Oculto
   * Mede RTT (latência em ms), perda de pacotes e frames em segundo plano a cada 3.5s.
   * Regula a qualidade automaticamente:
   * - PC fraco / Internet lenta: Reduz resolução (scaleResolutionDownBy: 2.0), 15fps, 180kbps (áudio 100% liso)
   * - Conexão normal / balanceada: 480p, 24fps, 450kbps
   * - PC forte / Internet rápida: 720p HD, 30fps, até 1200kbps (nitidez máxima)
   */
  startAdaptiveNetworkMonitor() {
    this.stopAdaptiveNetworkMonitor();
    this.adaptiveProfile = 'balanced';
    this.adaptiveMetrics = { rtt: 0, packetLoss: 0, profile: 'balanced', lastCheck: Date.now() };

    this.adaptiveInterval = setInterval(async () => {
      if (!this.peers || this.peers.size === 0) return;

      let totalRtt = 0;
      let rttCount = 0;
      let totalPacketsLost = 0;
      let totalPacketsSent = 0;

      for (const peer of this.peers.values()) {
        const pc = peer.connection;
        if (!pc || pc.connectionState !== 'connected') continue;

        try {
          const stats = await pc.getStats();
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
              if (typeof report.currentRoundTripTime === 'number') {
                totalRtt += report.currentRoundTripTime * 1000;
                rttCount++;
              }
            }
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              if (typeof report.packetsSent === 'number') {
                totalPacketsSent += report.packetsSent;
              }
            }
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
              if (typeof report.packetsLost === 'number') {
                totalPacketsLost += report.packetsLost;
              }
            }
          });
        } catch (err) {}
      }

      const avgRtt = rttCount > 0 ? (totalRtt / rttCount) : 0;
      const packetLossRatio = (totalPacketsSent + totalPacketsLost) > 40
        ? (totalPacketsLost / (totalPacketsSent + totalPacketsLost))
        : 0;

      let targetProfile = 'balanced';
      if (avgRtt > 280 || packetLossRatio > 0.05) {
        targetProfile = 'low';
      } else if (avgRtt > 0 && avgRtt < 120 && packetLossRatio < 0.015) {
        targetProfile = 'high';
      }

      this.adaptiveMetrics = {
        rtt: Math.round(avgRtt),
        packetLoss: +(packetLossRatio * 100).toFixed(1),
        profile: targetProfile,
        lastCheck: Date.now()
      };

      if (targetProfile !== this.adaptiveProfile) {
        this.adaptiveProfile = targetProfile;
        this.applyQualityProfileToAllSenders(targetProfile);
      }
    }, 3500);
  }

  stopAdaptiveNetworkMonitor() {
    if (this.adaptiveInterval) {
      clearInterval(this.adaptiveInterval);
      this.adaptiveInterval = null;
    }
  }

  applyQualityProfileToConnection(pc, profile = this.adaptiveProfile || 'balanced') {
    if (!pc) return;
    try {
      const senders = pc.getSenders();
      senders.forEach(sender => {
        this.applySenderQualityParameters(sender, profile);
      });
    } catch (e) {}
  }

  applyQualityProfileToAllSenders(profile = this.adaptiveProfile || 'balanced') {
    if (!this.peers) return;
    for (const peer of this.peers.values()) {
      if (peer.connection) {
        this.applyQualityProfileToConnection(peer.connection, profile);
      }
    }
  }

  async applySenderQualityParameters(sender, profile = 'balanced') {
    if (!sender || !sender.track) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      if (sender.track.kind === 'video') {
        const isScreen = this.screenStream && this.screenStream.getVideoTracks().some(t => t.id === sender.track.id);
        if (isScreen) {
          if (profile === 'low') {
            params.encodings[0].maxBitrate = 450000;
            params.encodings[0].maxFramerate = 15;
            params.encodings[0].scaleResolutionDownBy = 1.33;
          } else if (profile === 'high') {
            params.encodings[0].maxBitrate = 1800000;
            params.encodings[0].maxFramerate = 30;
            params.encodings[0].scaleResolutionDownBy = 1.0;
          } else {
            params.encodings[0].maxBitrate = 850000;
            params.encodings[0].maxFramerate = 24;
            params.encodings[0].scaleResolutionDownBy = 1.0;
          }
        } else {
          if (this.hayfaPcMode) {
            params.encodings[0].maxBitrate = 160000;
            params.encodings[0].maxFramerate = 15;
            params.encodings[0].scaleResolutionDownBy = 1.33;
          } else if (profile === 'low') {
            params.encodings[0].maxBitrate = 180000;
            params.encodings[0].maxFramerate = 15;
            params.encodings[0].scaleResolutionDownBy = 2.0;
          } else if (profile === 'high') {
            params.encodings[0].maxBitrate = 1100000;
            params.encodings[0].maxFramerate = 30;
            params.encodings[0].scaleResolutionDownBy = 1.0;
          } else {
            params.encodings[0].maxBitrate = 450000;
            params.encodings[0].maxFramerate = 24;
            params.encodings[0].scaleResolutionDownBy = 1.0;
          }
        }
        params.degradationPreference = 'balanced';
      } else if (sender.track.kind === 'audio') {
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].maxBitrate = 40000;
      }

      await sender.setParameters(params);
    } catch (err) {}
  }
}
