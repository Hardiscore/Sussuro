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
  onDisconnect 
} from './firebase-config.js';

const STORAGE_KEY_ICE = 'tavern_rtc_ice_servers';

// Configuração padrão de ICE Servers (STUN gratuito do Google)
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

/**
 * Obtém os servidores ICE configurados no localStorage ou os padrões
 */
export function getSavedIceServers() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_ICE);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
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
    localStorage.setItem(STORAGE_KEY_ICE, JSON.stringify(servers));
    return true;
  } catch (err) {
    console.error('[WebRTC] Erro ao salvar ICE servers:', err);
    return false;
  }
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
      audioMuted: false,
      videoOff: false,
      isScreenSharing: false,
      hasScreenAudio: false
    };

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

    // Sinalização
    this.firebaseDb = null;
    this.isFirebaseMode = false;
    this.isServerSignalingMode = false;
    this.serverEventSource = null;
    this.broadcastChannel = null;
    this.signalingCleanups = [];
    this.hasAudioDevice = true;

    // Supressão de ruído (RNNoise / Noise Gate / Nenhum)
    this.noiseSuppressionMode = options.noiseSuppressionMode || 'rnnoise';
    this.noiseGateThreshold = options.noiseGateThreshold !== undefined ? options.noiseGateThreshold : 14;
    this.highpassFilter = null;

    // Versão do Cliente e Compatibilidade Estrita
    this.appVersion = options.appVersion || '1.0.6';
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
    this.onVersionMismatch = options.onVersionMismatch || (() => {});
    this.onDiceBlockedStateChange = options.onDiceBlockedStateChange || (() => {});
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
      } catch (audioFallbackErr) {
        console.warn('[WebRTC] Microfone não detectado ou permissão negada:', audioFallbackErr);
        this.hasAudioDevice = false;
        this.userInfo.audioMuted = true;
        this.userInfo.noAudioDevice = true;
        if (typeof this.onNoAudioWarning === 'function') {
          this.onNoAudioWarning('Aviso: Nenhum microfone detectado. Você entrou na conversa em modo ouvinte.');
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
      try {
        const videoConstraints = {
          ...(this.selectedVideoDeviceId ? { deviceId: { exact: this.selectedVideoDeviceId } } : {}),
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 24, max: 30 }
        };

        const camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const camTrack = camStream.getVideoTracks()[0];
        if (camTrack) {
          this.localStream.addTrack(camTrack);
          camTrack.enabled = !this.userInfo.videoOff;
        }
      } catch (camErr) {
        console.warn('[WebRTC] Câmera não encontrada ou acesso recusado:', camErr);
        this.userInfo.videoOff = true;
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
    this.onLocalStreamReady(this.localStream);

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
        for (const [peerId, peer] of this.peers.entries()) {
          if (peer.connection) {
            const senders = peer.connection.getSenders();
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
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
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: this.noiseSuppressionEnabled,
          noiseSuppression: this.noiseSuppressionEnabled,
          autoGainControl: this.noiseSuppressionEnabled,
          googEchoCancellation: this.noiseSuppressionEnabled,
          googAutoGainControl: this.noiseSuppressionEnabled,
          googNoiseSuppression: this.noiseSuppressionEnabled,
          googHighpassFilter: this.noiseSuppressionEnabled,
          googTypingNoiseDetection: this.noiseSuppressionEnabled
        }
      });
      const newTrack = newStream.getAudioTracks()[0];
      newTrack.enabled = !this.userInfo.audioMuted;

      // Substitui a faixa nos peer senders
      for (const [peerId, peer] of this.peers.entries()) {
        const senders = peer.connection.getSenders();
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender) {
          await audioSender.replaceTrack(newTrack);
        }
      }

      // Substitui na stream local
      const oldTrack = this.localStream.getAudioTracks()[0];
      if (oldTrack) {
        this.localStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      this.localStream.addTrack(newTrack);
      this.setupAudioAnalyser(this.localStream);
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
        oldTrack.stop();
      }
      this.localStream.addTrack(newTrack);
      this.onLocalStreamReady(this.localStream);
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
   * Liga ou desliga câmera (adquire dispositivo sob demanda se estava desligada ao entrar)
   */
  async toggleVideo(forceState = null) {
    let videoTrack = this.localStream?.getVideoTracks()[0];
    const wantVideoOn = forceState !== null ? !forceState : this.userInfo.videoOff;

    if (wantVideoOn) {
      if (!videoTrack || videoTrack.readyState === 'ended') {
        try {
          const videoConstraints = {
            ...(this.selectedVideoDeviceId ? { deviceId: { exact: this.selectedVideoDeviceId } } : {}),
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 24, max: 30 }
          };

          const camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
          videoTrack = camStream.getVideoTracks()[0];
          if (videoTrack) {
            if (!this.localStream) this.localStream = new MediaStream();
            const oldV = this.localStream.getVideoTracks()[0];
            if (oldV) {
              this.localStream.removeTrack(oldV);
              oldV.stop();
            }
            this.localStream.addTrack(videoTrack);
          }
        } catch (err) {
          console.warn('[WebRTC] Não foi possível ativar câmera sob demanda:', err);
          this.userInfo.videoOff = true;
          this.broadcastMetadata();
          this.onLocalStreamReady(this.localStream);
          return true;
        }
      }

      if (videoTrack) {
        videoTrack.enabled = true;
        this.userInfo.videoOff = false;

        // Anexa ou substitui a faixa de vídeo em todas as conexões P2P e renegocia
        for (const [peerId, peer] of this.peers.entries()) {
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
          }
        }
      }
    } else {
      // Desligar câmera
      this.userInfo.videoOff = true;
      if (videoTrack) {
        videoTrack.enabled = false;
      }
      for (const peerId of this.peers.keys()) {
        this.sendSignal(peerId, {
          type: 'cam-state',
          videoOff: true
        });
      }
    }

    this.broadcastMetadata();
    this.onLocalStreamReady(this.localStream);
    return this.userInfo.videoOff;
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
          if (includeAudio && isScreen) {
            displayOpts.audio = true;
          }
          stream = await navigator.mediaDevices.getDisplayMedia(displayOpts);
        } catch (displayMediaErr) {
          console.warn('[WebRTC] getDisplayMedia via Electron falhou, tentando método getUserMedia:', displayMediaErr);
        }

        // 2. Se getDisplayMedia não retornou stream, tenta o método getUserMedia clássico do desktopCapturer
        if (!stream) {
          if (includeAudio && isScreen) {
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
      for (const [peerId, peer] of this.peers.entries()) {
        if (peer.connection) {
          try {
            const senders = peer.connection.getSenders();
            if (!senders.some(s => s.track && s.track.id === screenVideoTrack.id)) {
              peer.connection.addTrack(screenVideoTrack, this.screenStream);
            }
            if (screenAudioTrack && !senders.some(s => s.track && s.track.id === screenAudioTrack.id)) {
              peer.connection.addTrack(screenAudioTrack, this.screenStream);
            }
            const offer = await peer.connection.createOffer();
            await peer.connection.setLocalDescription(offer);
            await this.sendSignal(peerId, {
              type: 'offer',
              isScreenShareOffer: true,
              screenStreamId: stream.id,
              screenTrackId: screenVideoTrack.id,
              hasScreenAudio: !!screenAudioTrack,
              sdp: { type: peer.connection.localDescription.type, sdp: peer.connection.localDescription.sdp }
            });
          } catch (renegErr) {
            console.warn('[WebRTC] Erro ao adicionar faixas/renegociar tela:', renegErr);
          }
        }
      }

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
      if (typeof showLayoutNotification === 'function') {
        showLayoutNotification('Erro ao iniciar transmissão: ' + (err.message || 'Permissão negada ou não suportada'));
      }
      return false;
    }
  }

  /**
   * Encerra a transmissão de tela e restaura a webcam e o microfone originais
   */
  async stopScreenShare() {
    if (!this.isScreenSharing) return false;

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
      for (const [peerId, peer] of this.peers.entries()) {
        if (peer.connection) {
          const senders = peer.connection.getSenders();
          let removedAny = false;
          for (const track of screenTracks) {
            const sender = senders.find(s => s.track === track);
            if (sender) {
              try {
                peer.connection.removeTrack(sender);
                removedAny = true;
              } catch (e) {}
            }
          }
          if (removedAny) {
            try {
              const offer = await peer.connection.createOffer();
              await peer.connection.setLocalDescription(offer);
              await this.sendSignal(peerId, {
                type: 'offer',
                sdp: { type: peer.connection.localDescription.type, sdp: peer.connection.localDescription.sdp }
              });
            } catch (renegErr) {
              console.warn('[WebRTC] Erro ao renegociar offer após parar tela:', renegErr);
            }
          }
        }
      }
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
    const roomRef = ref(this.firebaseDb, `rooms/${this.roomId}`);
    const myPeerRef = ref(this.firebaseDb, `rooms/${this.roomId}/peers/${this.myPeerId}`);

    // Registra presença local
    await set(myPeerRef, {
      id: this.myPeerId,
      name: this.userInfo.name,
      role: this.userInfo.role,
      audioMuted: this.userInfo.audioMuted,
      videoOff: this.userInfo.videoOff,
      joinedAt: Date.now()
    });

    // Remove do banco ao desconectar
    onDisconnect(myPeerRef).remove();

    // Escuta novos peers na sala
    const peersRef = ref(this.firebaseDb, `rooms/${this.roomId}/peers`);
    const unsubscribePeers = onChildAdded(peersRef, (snapshot) => {
      const peerData = snapshot.val();
      if (peerData && peerData.id !== this.myPeerId) {
        this.handlePeerDiscovered(peerData.id, peerData);
      }
    });

    const unsubscribePeerChanged = onChildChanged(peersRef, (snapshot) => {
      const peerData = snapshot.val();
      if (peerData && peerData.id !== this.myPeerId) {
        this.handlePeerMetaReceived(peerData.id, peerData);
      }
    });

    const unsubscribePeerRemoved = onChildRemoved(peersRef, (snapshot) => {
      const peerData = snapshot.val();
      if (peerData && peerData.id !== this.myPeerId) {
        this.closePeer(peerData.id);
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
        remove(signalItemRef);
      }
    });

    this.signalingCleanups.push(() => {
      unsubscribePeers();
      unsubscribePeerChanged();
      unsubscribePeerRemoved();
      unsubscribeSignals();
      remove(myPeerRef);
    });
  }

  /**
   * Envia sinal para um peer específico via Firebase
   */
  async sendFirebaseSignal(toPeerId, data) {
    if (!this.firebaseDb) return;
    try {
      const sanitized = removeUndefined({
        from: this.myPeerId,
        ...data
      });
      const newSignalRef = ref(this.firebaseDb, `rooms/${this.roomId}/signals/${toPeerId}/${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
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
    const p = this.peers.get(fromPeerId);
    if (p) {
      p.peerInfo = { ...p.peerInfo, ...userInfo };
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
      // Se o peer está transmitindo e o espectador ainda não tem o vídeo de tela, solicita renegociação
      if (p && (!p.remoteScreenStream || p.remoteScreenStream.getVideoTracks().length === 0)) {
        setTimeout(() => {
          this.sendSignal(fromPeerId, { type: 'request-screen-renegotiation' });
        }, 300);
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
  async handlePeerDiscovered(peerId, peerInfo) {
    if (this.peers.has(peerId)) return;
    if (this.peers.size >= 14) {
      console.warn(`[WebRTC] Limite da malha de 15 participantes atingido. Ignorando ${peerId}`);
      return;
    }

    // Verificação estrita de versão entre peers
    const peerVersion = peerInfo && peerInfo.appVersion;
    if (peerVersion && this.appVersion && peerVersion !== this.appVersion) {
      console.warn(`[WebRTC] Incompatibilidade de versão detectada para ${peerId}: v${peerVersion} (sua versão: v${this.appVersion})`);
      if (typeof this.onVersionMismatch === 'function') {
        this.onVersionMismatch({
          peerId,
          peerName: peerInfo.name || 'Aventureiro',
          peerVersion,
          yourVersion: this.appVersion
        });
      }
      return;
    }

    console.log(`[WebRTC] Novo peer descoberto: ${peerId} (${peerInfo.name} - v${peerVersion || this.appVersion})`);
    
    // Padrão Perfect Negotiation (RFC): o peer com ID "menor" atua como polite
    const isPolite = this.myPeerId < peerId;
    const peerObj = this.createPeerConnection(peerId, peerInfo, isPolite);
    this.peers.set(peerId, peerObj);

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

    // Se formos o peer impolítico (ou quem detectou primeiro), iniciamos a oferta
    if (!isPolite) {
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
      }
    }

    // Se o participante que acabou de ser detectado já estiver transmitindo tela,
    // envia um pedido de renegociação para garantir que receberemos os fluxos de vídeo/áudio de tela
    if (peerInfo && peerInfo.isScreenSharing) {
      setTimeout(() => {
        this.sendSignal(peerId, { type: 'request-screen-renegotiation' });
      }, 500);
    }
  }

  /**
   * Cria e configura a RTCPeerConnection para um participante
   */
  createPeerConnection(peerId, peerInfo, isPolite) {
    const iceServers = getSavedIceServers();
    const pc = new RTCPeerConnection({ iceServers });

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
      ignoreOffer: false
    };

    // Adiciona faixas locais de microfone e câmera à conexão
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
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
      if (pc.iceConnectionState === 'failed') {
        pc.restartIce();
      } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
        // Pode ser desconexão temporária ou saída
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Estado de conexão com ${peerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        this.applyQualityProfileToConnection(pc);
      }
    };

    // Recebimento de faixas de mídia remotas
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Faixa remota recebida de ${peerId}:`, event.track.kind, event.streams);
      const track = event.track;
      let stream = event.streams && event.streams[0] ? event.streams[0] : null;

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
            peerData.remoteScreenStream = stream || new MediaStream();
          }
          if (!peerData.remoteScreenStream.getTracks().includes(track)) {
            peerData.remoteScreenStream.addTrack(track);
          }
          if (typeof this.onRemoteScreenStreamAdded === 'function') {
            this.onRemoteScreenStreamAdded(peerId, peerInfo, peerData.remoteScreenStream);
          }
        } else {
          console.log(`[WebRTC] Renderizando câmera remota de ${peerId}`);
          if (stream && stream.id) {
            peerData.cameraStreamId = stream.id;
          }
          if (!peerData.remoteStream) {
            peerData.remoteStream = new MediaStream();
          }
          if (!peerData.remoteStream.getTracks().includes(track)) {
            peerData.remoteStream.addTrack(track);
          }
          // Só marca vídeo como ligado se for um stream de câmera real com faixa ativa
          const hasRealVideoStream = !!(stream && stream.getVideoTracks().length > 0);
          if (hasRealVideoStream && track.enabled && track.readyState === 'live' && !peerInfo?.videoOff) {
            if (peerData.peerInfo) {
              peerData.peerInfo.videoOff = false;
            }
            if (peerInfo) {
              peerInfo.videoOff = false;
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
        const hasVoiceAudio = peerData.remoteStream && peerData.remoteStream.getAudioTracks().length > 0;
        const isScreenAudio = isScreenStream || 
                              ((peerData.peerInfo?.isScreenSharing || peerInfo?.isScreenSharing) && (hasVoiceAudio || peerInfo?.hasScreenAudio)) ||
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
            peerData.remoteScreenStream = stream || new MediaStream();
          }
          if (!peerData.remoteScreenStream.getTracks().includes(track)) {
            peerData.remoteScreenStream.addTrack(track);
          }
          if (typeof this.onRemoteScreenStreamAdded === 'function') {
            this.onRemoteScreenStreamAdded(peerId, peerInfo, peerData.remoteScreenStream);
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
          if (!peerData.remoteStream.getTracks().includes(track)) {
            peerData.remoteStream.addTrack(track);
          }

          // Inicia analisador em tempo real para detectar quando o participante fala (mesmo baixo)
          this.setupRemoteAudioAnalyser(peerId, peerData.remoteStream);

          // Quando os primeiros pacotes RTP chegam e o track desmuta, re-sincroniza a reprodução do áudio
          track.onunmute = () => {
            console.log(`[WebRTC] Faixa de áudio de ${peerId} desmutada (RTP ativo). Sincronizando saída de áudio...`);
            if (peerData.remoteStream) {
              this.setupRemoteAudioAnalyser(peerId, peerData.remoteStream);
              this.onPeerStreamAdded(peerId, peerData.peerInfo || peerInfo, peerData.remoteStream);
            }
          };

          track.onended = () => {
            this.cleanupRemoteAudioAnalyser(peerId);
          };

          this.onPeerStreamAdded(peerId, peerData.peerInfo || peerInfo, peerData.remoteStream);
        }
      }
    };

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
    if (!fromPeerId || fromPeerId === this.myPeerId) return;

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

    // Tratamento de pedido de renegociação para quem acabou de entrar na sala
    if (signal.type === 'request-screen-renegotiation') {
      if (this.isScreenSharing && this.screenStream) {
        console.log(`[WebRTC] Pedido de renegociação de tela recebido de ${fromPeerId}. Enviando oferta...`);
        const peerObj = this.peers.get(fromPeerId);
        if (peerObj && peerObj.connection) {
          const pc = peerObj.connection;
          const senders = pc.getSenders();
          this.screenStream.getTracks().forEach(track => {
            if (!senders.some(s => s.track && s.track.id === track.id)) {
              try {
                pc.addTrack(track, this.screenStream);
              } catch (e) {}
            }
          });
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
          }
        }
      }
      return;
    }

    let peerObj = this.peers.get(fromPeerId);
    if (!peerObj) {
      const isPolite = this.myPeerId < fromPeerId;
      peerObj = this.createPeerConnection(fromPeerId, { name: 'Aventureiro', role: 'jogador' }, isPolite);
      this.peers.set(fromPeerId, peerObj);
    }

    const pc = peerObj.connection;

    if (signal.type === 'cam-state') {
      if (peerObj && peerObj.peerInfo) {
        peerObj.peerInfo.videoOff = !!signal.videoOff;
        if (typeof this.onPeerInfoUpdated === 'function') {
          this.onPeerInfoUpdated(fromPeerId, peerObj.peerInfo);
        }
      }
      return;
    }

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

        const offerCollision = (pc.signalingState !== 'stable');
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
          setTimeout(async () => {
            if (pc.signalingState === 'stable' && this.isScreenSharing && this.screenStream) {
              const senders = pc.getSenders();
              const hasScreenTrack = this.screenStream.getVideoTracks().some(vTrack =>
                senders.some(s => s.track && s.track.id === vTrack.id)
              );
              if (!hasScreenTrack) {
                console.log(`[WebRTC] Enviando oferta subsequente de tela para ${fromPeerId}...`);
                this.screenStream.getTracks().forEach(t => {
                  try { pc.addTrack(t, this.screenStream); } catch (e) {}
                });
                try {
                  const renegOffer = await pc.createOffer();
                  await pc.setLocalDescription(renegOffer);
                  await this.sendSignal(fromPeerId, {
                    type: 'offer',
                    isScreenShareOffer: true,
                    screenStreamId: this.screenStream.id,
                    hasScreenAudio: this.hasScreenAudio,
                    sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
                  });
                } catch (e) {}
              }
            }
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
          setTimeout(async () => {
            if (pc.signalingState === 'stable' && this.isScreenSharing && this.screenStream) {
              const senders = pc.getSenders();
              const hasScreenTrack = this.screenStream.getVideoTracks().some(vTrack =>
                senders.some(s => s.track && s.track.id === vTrack.id)
              );
              if (!hasScreenTrack) {
                console.log(`[WebRTC] Renegociando tela pendente com ${fromPeerId}...`);
                this.screenStream.getTracks().forEach(t => {
                  try { pc.addTrack(t, this.screenStream); } catch (e) {}
                });
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
                } catch (renegErr) {
                  console.warn('[WebRTC] Erro ao renegociar tela após answer:', renegErr);
                }
              }
            }
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
      console.error(`[WebRTC] Falha ao processar sinal de ${fromPeerId}:`, err);
    }
  }

  /**
   * Notifica peers sobre alteração de metadata local (mute, nome, etc)
   */
  broadcastMetadata() {
    const meta = {
      type: 'meta',
      userInfo: this.userInfo
    };

    // Via DataChannel para baixa latência
    for (const peer of this.peers.values()) {
      if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        peer.dataChannel.send(JSON.stringify(meta));
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
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'peer-meta',
        from: this.myPeerId,
        userInfo: this.userInfo
      });
    }

    // Se estiver no Firebase
    if (this.isFirebaseMode && this.firebaseDb) {
      const myPeerRef = ref(this.firebaseDb, `rooms/${this.roomId}/peers/${this.myPeerId}`);
      set(myPeerRef, removeUndefined({
        id: this.myPeerId,
        ...this.userInfo,
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
   * Encerra conexão com um peer específico
   */
  closePeer(peerId) {
    this.cleanupRemoteAudioAnalyser(peerId);
    const peerObj = this.peers.get(peerId);
    if (peerObj) {
      if (peerObj.connection) {
        peerObj.connection.close();
      }
      this.peers.delete(peerId);
      this.onPeerStreamRemoved(peerId);
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
   * Sai da sala e encerra todas as conexões
   */
  leaveRoom() {
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

    // Encerra todos os peers
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.connection) peer.connection.close();
      this.onPeerStreamRemoved(peerId);
    }
    this.peers.clear();

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
          if (profile === 'low') {
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
