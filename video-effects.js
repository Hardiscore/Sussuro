/**
 * Sussurro RPG - Processador de Efeitos de Vídeo, Cenários Virtuais e Rastreamento Facial
 * Suporta:
 *  - Desfoque de Fundo Real (Selfie Segmentation)
 *  - Cenários de RPG Virtuais (Taberna, Masmorra, Floresta, Biblioteca, Customizado)
 *  - Rastreamento Facial em Tempo Real para Acessórios (Face Detection)
 *  - Filtros Atmosféricos de Iluminação sem descolorir a pele
 */

export class VideoEffectsProcessor {
  constructor() {
    this.selfieSegmentation = null;
    this.faceDetection = null;
    this.isSegmentationReady = false;
    this.isFaceDetectionReady = false;
    this.isLoadingModels = false;

    // Estado de configuração atual
    this.config = {
      bgPreset: 'none', // 'none' | 'blur' | 'tavern' | 'dungeon' | 'forest' | 'library' | 'custom'
      customBg: null,
      selectedAccessory: 'none',
      accessoryConfig: { scale: 100, x: 0, y: -35, anchor: 'head' },
      colorFilter: 'none', // 'none' | 'campfire' | 'dungeon-shadow' | 'parchment' | 'arcane-night'
      isVideoOff: true,
      rpgGestureMode: true // Preserva braços, mãos e gestos para RPG de mesa sem borrar
    };

    // Imagens e canvas em cache para renderização ultra-rápida (60 FPS)
    this.bgCache = {};
    this.customBgImage = null;
    this.loadedBgImages = new Map(); // id -> HTMLImageElement
    this.accessoryImages = new Map(); // id/url -> HTMLImageElement

    // Rastreamento facial suavizado (interpolação exponencial para evitar tremores)
    this.faceTracker = {
      detected: false,
      x: 50,
      y: 40,
      width: 30,
      height: 35,
      angle: 0,
      lastSeen: 0,
      targetX: 50,
      targetY: 40,
      targetScale: 1,
      targetAngle: 0
    };

    // Loops ativos
    this.activePipelines = new Map(); // id -> { videoEl, canvasEl, overlayEl, atmoEl, animFrameId, isProcessing }
    this.customAccImage = null;
    this.latestMask = null;
    this.personCanvas = null;

    this.initBackgrounds();

    // Pré-carrega os modelos da MediaPipe no início para estarem prontos imediatamente
    if (typeof window !== 'undefined') {
      const preload = () => this.loadModels().catch(() => {});
      if (document.readyState === 'complete') {
        setTimeout(preload, 100);
      } else {
        window.addEventListener('load', () => setTimeout(preload, 100));
      }
    }
  }

  /**
   * Pré-renderiza cenários de RPG de alta qualidade em canvas offscreen
   */
  initBackgrounds() {
    const W = 640;
    const H = 480;

    // 1. Taberna RPG (Madeira rústica, lareira de pedra e lareira quente)
    const tavernCanvas = document.createElement('canvas');
    tavernCanvas.width = W;
    tavernCanvas.height = H;
    const tCtx = tavernCanvas.getContext('2d');
    if (tCtx) {
      // Parede de tábuas de carvalho escuro
      const wallGrad = tCtx.createLinearGradient(0, 0, 0, H);
      wallGrad.addColorStop(0, '#1c1007');
      wallGrad.addColorStop(1, '#2d180a');
      tCtx.fillStyle = wallGrad;
      tCtx.fillRect(0, 0, W, H);

      // Vigas de madeira horizontais e verticais
      tCtx.strokeStyle = 'rgba(15, 8, 3, 0.7)';
      tCtx.lineWidth = 4;
      for (let y = 60; y < H; y += 70) {
        tCtx.beginPath();
        tCtx.moveTo(0, y);
        tCtx.lineTo(W, y);
        tCtx.stroke();
      }
      for (let x = 120; x < W; x += 160) {
        tCtx.fillStyle = 'rgba(25, 12, 5, 0.5)';
        tCtx.fillRect(x - 12, 0, 24, H);
      }

      // Lareira à esquerda com arco de pedra
      tCtx.fillStyle = '#18181b';
      tCtx.beginPath();
      tCtx.arc(100, 380, 70, Math.PI, 0);
      tCtx.fill();
      tCtx.strokeStyle = '#3f3f46';
      tCtx.lineWidth = 8;
      tCtx.stroke();

      // Fogo da lareira com brilho radial
      const fireGlow = tCtx.createRadialGradient(100, 380, 10, 100, 380, 140);
      fireGlow.addColorStop(0, 'rgba(251, 146, 60, 0.9)');
      fireGlow.addColorStop(0.3, 'rgba(234, 88, 12, 0.6)');
      fireGlow.addColorStop(0.7, 'rgba(180, 83, 9, 0.25)');
      fireGlow.addColorStop(1, 'transparent');
      tCtx.fillStyle = fireGlow;
      tCtx.beginPath();
      tCtx.arc(100, 380, 140, 0, Math.PI * 2);
      tCtx.fill();

      // Lanterna pendurada à direita
      tCtx.strokeStyle = '#78350f';
      tCtx.lineWidth = 3;
      tCtx.beginPath();
      tCtx.moveTo(W - 90, 0);
      tCtx.lineTo(W - 90, 90);
      tCtx.stroke();
      const lanternGlow = tCtx.createRadialGradient(W - 90, 100, 5, W - 90, 100, 90);
      lanternGlow.addColorStop(0, 'rgba(254, 240, 138, 0.85)');
      lanternGlow.addColorStop(0.4, 'rgba(245, 158, 11, 0.4)');
      lanternGlow.addColorStop(1, 'transparent');
      tCtx.fillStyle = lanternGlow;
      tCtx.beginPath();
      tCtx.arc(W - 90, 100, 90, 0, Math.PI * 2);
      tCtx.fill();

      // Vinheta de aconchego
      const vig = tCtx.createRadialGradient(W / 2, H / 2, 160, W / 2, H / 2, 360);
      vig.addColorStop(0, 'transparent');
      vig.addColorStop(1, 'rgba(10, 5, 2, 0.7)');
      tCtx.fillStyle = vig;
      tCtx.fillRect(0, 0, W, H);

      this.bgCache.tavern = tavernCanvas;
    }

    // 2. Masmorra Medieval (Blocos de pedra maciça, tocha de ferro e névoa)
    const dungeonCanvas = document.createElement('canvas');
    dungeonCanvas.width = W;
    dungeonCanvas.height = H;
    const dCtx = dungeonCanvas.getContext('2d');
    if (dCtx) {
      // Fundo escuro de pedra
      dCtx.fillStyle = '#0f172a';
      dCtx.fillRect(0, 0, W, H);

      // Tijolos de pedra lavrada
      dCtx.strokeStyle = 'rgba(30, 41, 59, 0.8)';
      dCtx.lineWidth = 2.5;
      const bH = 45;
      const bW = 90;
      for (let r = 0; r < H / bH; r++) {
        const offset = (r % 2) * (bW / 2);
        dCtx.beginPath();
        dCtx.moveTo(0, r * bH);
        dCtx.lineTo(W, r * bH);
        dCtx.stroke();
        for (let c = -offset; c < W; c += bW) {
          dCtx.beginPath();
          dCtx.moveTo(c, r * bH);
          dCtx.lineTo(c, (r + 1) * bH);
          dCtx.stroke();
        }
      }

      // Arco gótico de pedra ao fundo
      dCtx.strokeStyle = '#334155';
      dCtx.lineWidth = 14;
      dCtx.beginPath();
      dCtx.arc(W / 2, 280, 190, Math.PI, 0);
      dCtx.stroke();

      // Tocha de ferro na parede à direita
      dCtx.fillStyle = '#1e293b';
      dCtx.fillRect(W - 85, 170, 14, 50);
      const torchGlow = dCtx.createRadialGradient(W - 78, 160, 5, W - 78, 160, 140);
      torchGlow.addColorStop(0, 'rgba(251, 191, 36, 0.9)');
      torchGlow.addColorStop(0.3, 'rgba(249, 115, 22, 0.55)');
      torchGlow.addColorStop(0.7, 'rgba(185, 28, 28, 0.2)');
      torchGlow.addColorStop(1, 'transparent');
      dCtx.fillStyle = torchGlow;
      dCtx.beginPath();
      dCtx.arc(W - 78, 160, 140, 0, Math.PI * 2);
      dCtx.fill();

      // Vinheta de masmorra sombria
      const dVig = dCtx.createRadialGradient(W / 2, H / 2, 140, W / 2, H / 2, 360);
      dVig.addColorStop(0, 'transparent');
      dVig.addColorStop(1, 'rgba(2, 6, 23, 0.85)');
      dCtx.fillStyle = dVig;
      dCtx.fillRect(0, 0, W, H);

      this.bgCache.dungeon = dungeonCanvas;
    }

    // 3. Floresta Élfica Encantada (Crepúsculo, árvores místicas e vaga-lumes)
    const forestCanvas = document.createElement('canvas');
    forestCanvas.width = W;
    forestCanvas.height = H;
    const fCtx = forestCanvas.getContext('2d');
    if (fCtx) {
      // Céu noturno crepuscular esmeralda/índigo
      const skyGrad = fCtx.createLinearGradient(0, 0, 0, H);
      skyGrad.addColorStop(0, '#042f2e');
      skyGrad.addColorStop(0.6, '#064e3b');
      skyGrad.addColorStop(1, '#022c22');
      fCtx.fillStyle = skyGrad;
      fCtx.fillRect(0, 0, W, H);

      // Silhuetas de troncos de árvores ancestrais
      fCtx.fillStyle = 'rgba(2, 44, 34, 0.85)';
      fCtx.beginPath();
      fCtx.moveTo(40, H);
      fCtx.lineTo(60, 100);
      fCtx.lineTo(95, 0);
      fCtx.lineTo(130, 110);
      fCtx.lineTo(110, H);
      fCtx.fill();

      fCtx.beginPath();
      fCtx.moveTo(W - 50, H);
      fCtx.lineTo(W - 80, 80);
      fCtx.lineTo(W - 120, 0);
      fCtx.lineTo(W - 145, 90);
      fCtx.lineTo(W - 120, H);
      fCtx.fill();

      // Folhagem densa no topo
      fCtx.fillStyle = 'rgba(6, 78, 59, 0.6)';
      for (let x = 0; x < W; x += 60) {
        fCtx.beginPath();
        fCtx.arc(x + 30, 20, 70, 0, Math.PI * 2);
        fCtx.fill();
      }

      // Vaga-lumes mágicos cintilantes
      const fireflies = [
        [180, 140, 25, 'rgba(52, 211, 153, 0.9)'],
        [240, 260, 18, 'rgba(110, 231, 183, 0.9)'],
        [420, 160, 22, 'rgba(52, 211, 153, 0.9)'],
        [480, 300, 16, 'rgba(167, 243, 208, 0.9)'],
        [320, 90, 20, 'rgba(253, 224, 71, 0.85)']
      ];
      fireflies.forEach(([fx, fy, fr, color]) => {
        const rad = fCtx.createRadialGradient(fx, fy, 2, fx, fy, fr);
        rad.addColorStop(0, '#fff');
        rad.addColorStop(0.2, color);
        rad.addColorStop(1, 'transparent');
        fCtx.fillStyle = rad;
        fCtx.beginPath();
        fCtx.arc(fx, fy, fr, 0, Math.PI * 2);
        fCtx.fill();
      });

      this.bgCache.forest = forestCanvas;
    }

    // 4. Biblioteca Arcana (Prateleiras imensas de tomos arcanos e runas)
    const libCanvas = document.createElement('canvas');
    libCanvas.width = W;
    libCanvas.height = H;
    const lCtx = libCanvas.getContext('2d');
    if (lCtx) {
      lCtx.fillStyle = '#1e112a';
      lCtx.fillRect(0, 0, W, H);

      // Estantes com livros
      const shelfHeight = 80;
      for (let s = 40; s < H; s += shelfHeight) {
        lCtx.fillStyle = '#3b1d11';
        lCtx.fillRect(0, s, W, 10);
        const colors = ['#991b1b', '#1e3a8a', '#065f46', '#854d0e', '#581c87', '#374151'];
        for (let b = 15; b < W - 20; b += Math.floor(Math.random() * 12) + 14) {
          lCtx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
          const bH = shelfHeight - 16 - Math.floor(Math.random() * 12);
          lCtx.fillRect(b, s - bH, 12, bH);
          lCtx.strokeStyle = 'rgba(255,255,255,0.15)';
          lCtx.strokeRect(b, s - bH, 12, bH);
        }
      }

      // Brilho arcano central
      const arcGlow = lCtx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, 280);
      arcGlow.addColorStop(0, 'rgba(168, 85, 247, 0.25)');
      arcGlow.addColorStop(0.6, 'rgba(59, 130, 246, 0.15)');
      arcGlow.addColorStop(1, 'rgba(10, 5, 20, 0.85)');
      lCtx.fillStyle = arcGlow;
      lCtx.fillRect(0, 0, W, H);

      this.bgCache.library = libCanvas;
    }
  }

  /**
   * Carrega os modelos de IA da MediaPipe sob demanda (Selfie Segmentation e Face Detection)
   */
  async loadModels() {
    if (this.isLoadingModels || (this.isSegmentationReady && this.isFaceDetectionReady)) return;
    this.isLoadingModels = true;

    try {
      // 1. Inicializa MediaPipe Selfie Segmentation
      if (typeof window.SelfieSegmentation === 'function' && !this.selfieSegmentation) {
        this.selfieSegmentation = new window.SelfieSegmentation({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
        });
        this.selfieSegmentation.setOptions({
          modelSelection: 0 // 0 = Modo Geral (Segmenta corpo inteiro, tronco, braços e mãos para gestos e dados de RPG)
        });
        this.selfieSegmentation.onResults((results) => {
          if (results && results.segmentationMask) {
            this.latestMask = results.segmentationMask;
            for (const p of this.activePipelines.values()) {
              p.currentMask = results.segmentationMask;
            }
          }
        });
        await this.selfieSegmentation.initialize();
        this.isSegmentationReady = true;
      }

      // 2. Inicializa MediaPipe Face Detection
      if (typeof window.FaceDetection === 'function' && !this.faceDetection) {
        this.faceDetection = new window.FaceDetection({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`
        });
        this.faceDetection.setOptions({
          model: 'short', // Modelo de alcance curto perfeito para webcam de computador/celular
          minDetectionConfidence: 0.45
        });
        this.faceDetection.onResults((results) => {
          if (results && results.detections && results.detections.length > 0) {
            this.updateFaceTracking(results.detections[0]);
          } else {
            this.faceTracker.detected = false;
          }
        });
        await this.faceDetection.initialize();
        this.isFaceDetectionReady = true;
      }
    } catch (err) {
      console.warn('[VideoEffects] Falha ao inicializar modelos MediaPipe:', err);
    } finally {
      this.isLoadingModels = false;
    }
  }

  /**
   * Atualiza a imagem customizada de fundo
   */
  setCustomBackground(dataUrl) {
    if (!dataUrl) {
      this.customBgImage = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.customBgImage = img;
    };
    img.src = dataUrl;
  }

  /**
   * Atualiza imagem de acessório customizado
   */
  setCustomAccessory(dataUrl) {
    if (!dataUrl) {
      this.customAccImage = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.customAccImage = img;
    };
    img.src = dataUrl;
  }

  /**
   * Atualiza a configuração global de filtros
   */
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);

    if (this.config.customBg && (!this.customBgImage || this.customBgImage.src !== this.config.customBg)) {
      this.setCustomBackground(this.config.customBg);
    }
    if (this.config.customAccessory && (!this.customAccImage || this.customAccImage.src !== this.config.customAccessory)) {
      this.setCustomAccessory(this.config.customAccessory);
    }
    // Se ligou desfoque, cenário ou acessório, carrega os modelos se ainda não estiverem prontos
    const needsSegmentation = this.config.bgPreset !== 'none';
    const needsFaceTracking = this.config.selectedAccessory && this.config.selectedAccessory !== 'none';

    if ((needsSegmentation || needsFaceTracking) && !this.isSegmentationReady) {
      this.loadModels().catch(() => {});
    }

    // Pré-carrega o acessório selecionado se for imagem
    if (this.config.selectedAccessory && this.config.selectedAccessory !== 'none') {
      this.getAccessoryImage(this.config.selectedAccessory);
    }

    // Atualiza classes CSS atmosféricas nas sobreposições
    this.activePipelines.forEach(p => {
      if (p.atmoEl) {
        p.atmoEl.className = 'atmosphere-overlay';
        if (this.config.colorFilter && this.config.colorFilter !== 'none') {
          p.atmoEl.classList.add(`filter-${this.config.colorFilter}`);
          p.atmoEl.classList.remove('hidden');
        } else {
          p.atmoEl.classList.add('hidden');
        }
      }
    });
  }

  /**
   * Registra um cenário de fundo da pasta pública ou de upload
   */
  registerBackground(id, url) {
    if (!id || !url) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.loadedBgImages.set(id, img);
    };
    img.src = url;
    this.loadedBgImages.set(id, img);
  }

  /**
   * Registra um acessório PNG da pasta pública ou de upload
   */
  registerAccessory(id, url) {
    if (!id || !url) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.accessoryImages.set(id, img);
    };
    img.src = url;
    this.accessoryImages.set(id, img);
  }

  /**
   * Retorna a imagem HTML do acessório (carregando sob demanda)
   */
  getAccessoryImage(accessoryKey) {
    if (!accessoryKey || accessoryKey === 'none') return null;

    if (this.accessoryImages.has(accessoryKey)) {
      return this.accessoryImages.get(accessoryKey);
    }

    let src = '';
    if (accessoryKey === 'custom' && this.config.customAccessory) {
      src = this.config.customAccessory;
    } else if (accessoryKey.startsWith('/') || accessoryKey.startsWith('data:') || accessoryKey.startsWith('http')) {
      src = accessoryKey;
    } else {
      const fileMap = {
        crown: '/accessories/coroa_dourada.png',
        wizard: '/accessories/chapeu_mago.png',
        helm: '/accessories/elmo_cavaleiro.png',
        horns: '/accessories/chifres_demonio.png',
        eyepatch: '/accessories/tapa_olho_pirata.png',
        mask: '/accessories/mascara_ladino.png',
        beard: '/accessories/barba_ruiva_anao.png',
        pet: '/accessories/mini_dragao_ombro.png'
      };
      if (fileMap[accessoryKey]) {
        src = fileMap[accessoryKey];
      }
    }

    if (!src) return null;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    this.accessoryImages.set(accessoryKey, img);
    return img;
  }

  /**
   * Desenha o acessório com rotação, escala e posicionamento fiéis no Canvas do vídeo
   */
  drawAccessoryOnCanvas(ctx, img, canvasW, canvasH) {
    if (!img || !img.complete || img.naturalWidth === 0) return;

    // A visualização do canvas tem CSS transform: scaleX(-1) para a prévia local.
    // No contexto 2D original (não espelhado), a coordenada X é (100 - faceTracker.x)%
    const rawX = ((100 - this.faceTracker.x) / 100) * canvasW;
    const rawY = (this.faceTracker.y / 100) * canvasH;

    const scale = (this.faceTracker.targetScale || 1.0);
    const faceW = (this.faceTracker.boxWidth || 0.28) * canvasW;
    const drawW = faceW * 1.85 * scale;
    const aspect = (img.naturalWidth && img.naturalHeight) ? (img.naturalWidth / img.naturalHeight) : 1;
    const drawH = drawW / aspect;

    // O ângulo na imagem original não espelhada é invertido (-angle)
    const angleRad = (-this.faceTracker.angle * Math.PI) / 180;

    ctx.save();
    ctx.translate(rawX, rawY);
    ctx.rotate(angleRad);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }

  /**
   * Registra e inicia o pipeline de processamento de vídeo para um elemento de vídeo
   */
  startPipeline(id, videoEl, canvasEl, overlayEl, atmoEl) {
    if (!videoEl || !canvasEl) return;
    this.stopPipeline(id);

    const pipeline = {
      id,
      videoEl,
      canvasEl,
      overlayEl,
      atmoEl,
      ctx: canvasEl.getContext('2d'),
      animFrameId: null,
      isProcessing: false,
      lastProcessTime: 0,
      currentMask: this.latestMask || null,
      detections: []
    };

    this.activePipelines.set(id, pipeline);

    if (!this.isSegmentationReady || !this.isFaceDetectionReady) {
      this.loadModels().catch(() => {});
    }

    this.runLoop(pipeline);
  }

  /**
   * Retorna a trilha de vídeo processada (com fundo borrado ou cenário) para envio WebRTC
   */
  getProcessedTrack(pipelineId = 'local') {
    const p = this.activePipelines.get(pipelineId);
    if (p && p.canvasEl && typeof p.canvasEl.captureStream === 'function') {
      try {
        if (!p.capturedTrack || p.capturedTrack.readyState === 'ended') {
          const stream = p.canvasEl.captureStream(30);
          p.capturedTrack = stream?.getVideoTracks()[0] || null;
        }
        return p.capturedTrack;
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  /**
   * Encerra um pipeline ativo
   */
  stopPipeline(id) {
    const p = this.activePipelines.get(id);
    if (p) {
      if (p.animFrameId) cancelAnimationFrame(p.animFrameId);
      if (p.capturedTrack) {
        try { p.capturedTrack.stop(); } catch (e) {}
        p.capturedTrack = null;
      }
      p.canvasEl?.classList.add('hidden');
      this.activePipelines.delete(id);
    }
  }

  /**
   * Atualiza a posição suavizada da face
   */
  updateFaceTracking(detection, canvasW, canvasH) {
    const box = detection.boundingBox;
    const landmarks = detection.landmarks || [];

    if (!box) return;

    this.faceTracker.detected = true;
    this.faceTracker.lastSeen = performance.now();

    // Na visualização espelhada local da câmera (scaleX(-1)):
    // A coordenada x da tela é (1 - sensorX)
    const rightEye = landmarks[0];
    const leftEye = landmarks[1];
    const nose = landmarks[2];
    const mouth = landmarks[3];
    const rightEar = landmarks[4];
    const leftEar = landmarks[5];

    let midEyeX = 1 - box.xCenter;
    let midEyeY = box.yCenter;
    let rollAngle = 0;

    if (rightEye && leftEye) {
      const screenRightX = 1 - rightEye.x;
      const screenLeftX = 1 - leftEye.x;
      midEyeX = (screenRightX + screenLeftX) / 2;
      midEyeY = (rightEye.y + leftEye.y) / 2;

      const dx = screenRightX - screenLeftX;
      const dy = rightEye.y - leftEye.y;
      rollAngle = Math.atan2(dy, dx) * (180 / Math.PI);
    }

    const anchor = this.config.accessoryConfig?.anchor || 'head';
    let targetX = midEyeX;
    let targetY = midEyeY;
    let baseScaleFactor = 1.0;

    if (anchor === 'head') {
      // Topo da cabeça / chapéus e coroas: acima dos olhos
      targetY = midEyeY - (box.height * 0.42);
      baseScaleFactor = 1.35;
    } else if (anchor === 'eyes') {
      // Óculos e tapa-olhos: exatamente nos olhos
      targetY = midEyeY;
      baseScaleFactor = 1.05;
    } else if (anchor === 'mouth') {
      // Máscaras e barbas: na altura da boca / queixo
      if (mouth) {
        targetX = 1 - mouth.x;
        targetY = mouth.y;
      } else {
        targetY = midEyeY + (box.height * 0.38);
      }
      baseScaleFactor = 1.0;
    } else if (anchor === 'chest') {
      // Peito e ombros
      targetY = box.yCenter + (box.height * 0.58);
      baseScaleFactor = 1.35;
    } else if (anchor === 'side') {
      // Mascote e asas laterais
      targetX = midEyeX + (box.width * 0.75);
      targetY = midEyeY + (box.height * 0.15);
      baseScaleFactor = 0.95;
    }

    // Aplica ajustes finos dos sliders (offset percentual relativo ao tamanho do rosto)
    const userScale = (this.config.accessoryConfig?.scale || 100) / 100;
    const userOffX = ((this.config.accessoryConfig?.x || 0) / 100) * box.width;
    const userOffY = (((this.config.accessoryConfig?.y || 0) + 35) / 100) * box.height;

    const finalTargetX = (targetX + userOffX) * 100;
    const finalTargetY = (targetY + userOffY) * 100;
    const finalScale = baseScaleFactor * userScale;

    // Salva dimensões relativas da face para cálculo exato de proporção
    this.faceTracker.boxWidth = box.width;
    this.faceTracker.boxHeight = box.height;

    // Suavização exponencial suave (sem atraso perceptível e sem tremedeira)
    const smooth = 0.45;
    this.faceTracker.x = this.faceTracker.x * (1 - smooth) + finalTargetX * smooth;
    this.faceTracker.y = this.faceTracker.y * (1 - smooth) + finalTargetY * smooth;
    this.faceTracker.angle = this.faceTracker.angle * (1 - smooth) + rollAngle * smooth;
    this.faceTracker.targetScale = (this.faceTracker.targetScale || finalScale) * (1 - smooth) + finalScale * smooth;
  }

  /**
   * Loop principal de renderização e processamento
   */
  runLoop(pipeline) {
    const loop = async () => {
      if (!this.activePipelines.has(pipeline.id)) return;

      const { videoEl, canvasEl, ctx, overlayEl, atmoEl } = pipeline;

      // Se o vídeo não está pronto ou está pausado, aguarda próximo quadro
      if (videoEl.readyState >= 2 && !videoEl.paused && videoEl.videoWidth > 0) {
        if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
          canvasEl.width = videoEl.videoWidth;
          canvasEl.height = videoEl.videoHeight;
        }

        const now = performance.now();
        const hasBgEffect = this.config.bgPreset !== 'none';
        const hasAccessory = this.config.selectedAccessory && this.config.selectedAccessory !== 'none';
        const hasColorFilter = this.config.colorFilter && this.config.colorFilter !== 'none';

        // Se NÃO há nenhum efeito ativado (vídeo puro):
        if (!hasBgEffect && !hasAccessory && !hasColorFilter) {
          canvasEl.classList.add('hidden');
          videoEl.style.display = 'block';
          if (overlayEl) overlayEl.classList.add('hidden');
          if (atmoEl) atmoEl.classList.add('hidden');
        } else {
          // Há efeitos ativos: exibe o canvas e oculta a tag <video> crua
          canvasEl.classList.remove('hidden');
          videoEl.style.display = 'none';

          // 1. Processamento de IA a cada ~33ms (30 FPS)
          if (!pipeline.isProcessing && (now - pipeline.lastProcessTime > 32)) {
            pipeline.isProcessing = true;
            pipeline.lastProcessTime = now;

            try {
              if (hasBgEffect && this.selfieSegmentation && this.isSegmentationReady) {
                await this.selfieSegmentation.send({ image: videoEl });
                if (this.latestMask) {
                  pipeline.currentMask = this.latestMask;
                }
              }
              if (hasAccessory && this.faceDetection && this.isFaceDetectionReady) {
                await this.faceDetection.send({ image: videoEl });
              }
            } catch (err) {
              // Não bloqueia o loop caso um frame falhe
            } finally {
              pipeline.isProcessing = false;
            }
          }

          // 2. Renderização composta do quadro no Canvas com separação precisa de camadas
          ctx.save();
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

          if (hasBgEffect && pipeline.currentMask) {
            const w = canvasEl.width;
            const h = canvasEl.height;

            // 1. Isola com nitidez total o rosto e o corpo detectados em canvas offscreen
            if (!this.personCanvas) {
              this.personCanvas = document.createElement('canvas');
            }
            if (this.personCanvas.width !== w || this.personCanvas.height !== h) {
              this.personCanvas.width = w;
              this.personCanvas.height = h;
            }

            const pCtx = this.personCanvas.getContext('2d');
            pCtx.save();
            pCtx.clearRect(0, 0, w, h);

            // A) Desenha a máscara da pessoa detectada pela IA
            pCtx.drawImage(pipeline.currentMask, 0, 0, w, h);

            // B) Operação 'source-in': recorta a pessoa sem qualquer perda de nitidez
            pCtx.globalCompositeOperation = 'source-in';
            this.applyAtmosphericGrading(pCtx);
            pCtx.drawImage(videoEl, 0, 0, w, h);
            pCtx.restore();

            // 2. No canvas principal, renderiza EXCLUSIVAMENTE o fundo (background)
            ctx.save();
            this.drawBackground(ctx, videoEl, w, h);
            ctx.restore(); // Restaura ctx.filter para 'none' garantindo que o sujeito permaneça perfeitamente nítido

            // 3. Sobrepõe a pessoa (rosto e corpo detectados) 100% nítidos por cima do fundo borrado
            ctx.drawImage(this.personCanvas, 0, 0, w, h);
          } else {
            // Sem recorte de fundo ou aguardando primeiro quadro da IA:
            // Câmera normal nítida sem qualquer borrão sobre o usuário
            this.applyAtmosphericGrading(ctx);
            ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
            ctx.filter = 'none';
          }

          // 4. Se houver acessório selecionado e rosto detectado, desenha diretamente no canvas
          let drawnOnCanvas = false;
          if (hasAccessory && this.faceTracker.detected && (now - this.faceTracker.lastSeen < 1200)) {
            const accImg = this.getAccessoryImage(this.config.selectedAccessory);
            if (accImg && accImg.complete && accImg.naturalWidth > 0) {
              this.drawAccessoryOnCanvas(ctx, accImg, canvasEl.width, canvasEl.height);
              drawnOnCanvas = true;
            }
          }
          ctx.restore();

          // 5. Atualização da sobreposição DOM de acessório (ativa apenas como fallback quando não desenhado no canvas)
          if (overlayEl) {
            if (hasAccessory && !drawnOnCanvas) {
              overlayEl.classList.remove('hidden');
              if (this.faceTracker.detected && (now - this.faceTracker.lastSeen < 800)) {
                overlayEl.style.left = `${this.faceTracker.x}%`;
                overlayEl.style.top = `${this.faceTracker.y}%`;
                overlayEl.style.transform = `translate(-50%, -50%) rotate(${this.faceTracker.angle}deg) scale(${this.faceTracker.targetScale})`;
              } else {
                const cfg = this.config.accessoryConfig || { scale: 100, x: 0, y: -35 };
                overlayEl.style.left = `calc(50% + ${cfg.x}%)`;
                overlayEl.style.top = `calc(50% + ${cfg.y}%)`;
                overlayEl.style.transform = `translate(-50%, -50%) scale(${cfg.scale / 100})`;
              }
            } else {
              overlayEl.classList.add('hidden');
            }
          }
        }
      }

      pipeline.animFrameId = requestAnimationFrame(loop);
    };

    pipeline.animFrameId = requestAnimationFrame(loop);
  }

  /**
   * Retorna os filtros CSS de iluminação atmosférica para composição cinematográfica
   */
  getAtmosphericFilter() {
    const filter = this.config.colorFilter;
    if (filter === 'campfire') {
      return 'contrast(1.08) brightness(1.03) saturate(1.15) sepia(0.12)';
    } else if (filter === 'dungeon-shadow') {
      return 'contrast(1.24) brightness(0.86) saturate(0.92)';
    } else if (filter === 'parchment') {
      return 'sepia(0.3) contrast(1.1) brightness(0.96) saturate(0.95)';
    } else if (filter === 'arcane-night') {
      return 'contrast(1.16) brightness(0.9) saturate(0.9)';
    }
    return '';
  }

  /**
   * Aplica correção de cor atmosférica cinematográfica sem azular ou deformar tons de pele humana
   */
  applyAtmosphericGrading(ctx) {
    const filterStr = this.getAtmosphericFilter();
    ctx.filter = filterStr || 'none';
  }

  /**
   * Renderiza o fundo atrás da pessoa recortada (com desfoque pronunciado ou cenários temáticos)
   */
  drawBackground(ctx, videoEl, width, height) {
    const preset = this.config.bgPreset;

    if (preset === 'blur') {
      // Desfoque cremoso e rico de profundidade de campo
      ctx.save();
      const atmo = this.getAtmosphericFilter();
      ctx.filter = atmo ? `blur(20px) ${atmo}` : 'blur(20px)';
      // Desenha com margem expandida para evitar bordas transparentes na tela
      const margin = 24;
      ctx.drawImage(videoEl, -margin, -margin, width + margin * 2, height + margin * 2);
      ctx.restore();
    } else if (preset === 'custom' && this.customBgImage) {
      // Imagem personalizada do usuário
      this.drawCover(ctx, this.customBgImage, width, height);
    } else if (this.bgCache[preset]) {
      // Cenários de RPG pré-renderizados (Taberna, Masmorra, Floresta, Biblioteca)
      ctx.drawImage(this.bgCache[preset], 0, 0, width, height);
    } else if (this.loadedBgImages && this.loadedBgImages.has(preset)) {
      // Cenários carregados dinamicamente das pastas do computador
      this.drawCover(ctx, this.loadedBgImages.get(preset), width, height);
    } else {
      ctx.fillStyle = '#1e1f22';
      ctx.fillRect(0, 0, width, height);
    }
  }

  /**
   * Desenha imagem em modo cover mantendo proporção de aspecto
   */
  drawCover(ctx, img, targetW, targetH) {
    const imgRatio = img.width / img.height;
    const targetRatio = targetW / targetH;
    let sW, sH, sX, sY;

    if (imgRatio > targetRatio) {
      sH = img.height;
      sW = img.height * targetRatio;
      sX = (img.width - sW) / 2;
      sY = 0;
    } else {
      sW = img.width;
      sH = img.width / targetRatio;
      sX = 0;
      sY = (img.height - sH) / 2;
    }

    ctx.drawImage(img, sX, sY, sW, sH, 0, 0, targetW, targetH);
  }
}

// Instância singleton global do processador de efeitos
export const videoEffects = new VideoEffectsProcessor();
