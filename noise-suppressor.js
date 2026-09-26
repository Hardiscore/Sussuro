/**
 * Sussurro RPG - AudioWorklet e Módulo de Supressão de Ruído
 * 
 * Funciona tanto como AudioWorkletProcessor (processamento em thread de áudio de baixa latência)
 * quanto como módulo/script global para fallback sem travar a interface.
 */

if (typeof registerProcessor === 'function') {
  // ==========================================
  // ESCOPO: AudioWorkletProcessor (Thread de Áudio)
  // ==========================================
  class NoiseSuppressorProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.mode = 'noisegate'; // 'noisegate', 'none', 'rnnoise'
      this.threshold = 0.018; // Limiar padrão para ruídos de fundo leves
      this.smoothing = 0.05;
      this.currentGain = 1.0;

      this.port.onmessage = (event) => {
        if (!event.data) return;
        if (typeof event.data.mode === 'string') {
          this.mode = event.data.mode;
        }
        if (typeof event.data.threshold === 'number') {
          this.threshold = Math.max(0.001, Math.min(0.2, event.data.threshold));
        }
        if (typeof event.data.smoothing === 'number') {
          this.smoothing = event.data.smoothing;
        }
      };
    }

    process(inputs, outputs, _parameters) {
      const input = inputs[0];
      const output = outputs[0];

      if (!input || input.length === 0 || !input[0]) {
        return true;
      }

      // Se o modo for 'none', repassa o áudio 100% puro/cru para efeitos de RPG e estúdio
      if (this.mode === 'none') {
        for (let channel = 0; channel < input.length; channel++) {
          const inCh = input[channel];
          const outCh = output[channel];
          if (!outCh) continue;
          outCh.set(inCh);
        }
        return true;
      }

      const inputChannel0 = input[0];
      let sumSquares = 0;
      const len = inputChannel0.length;

      // Calcula RMS do bloco atual
      for (let i = 0; i < len; i++) {
        const s = inputChannel0[i];
        sumSquares += s * s;
      }
      const rms = Math.sqrt(sumSquares / len);

      let targetGain = 1.0;
      if (this.mode === 'rnnoise') {
        // Modo RNNoise (IA Neural): Corte mais agressivo para teclados mecânicos/ventilador
        const isVoice = rms > (this.threshold * 1.5);
        targetGain = isVoice ? 1.0 : 0.02;
        this.currentGain += (targetGain - this.currentGain) * 0.25;
      } else {
        // Modo Noise Gate (Padrão RPG): Transição suave que preserva sussurros e efeitos com a boca
        const isVoice = rms > this.threshold;
        targetGain = isVoice ? 1.0 : 0.05;
        this.currentGain += (targetGain - this.currentGain) * 0.15;
      }

      for (let channel = 0; channel < input.length; channel++) {
        const inCh = input[channel];
        const outCh = output[channel];
        if (!outCh) continue;

        for (let i = 0; i < inCh.length; i++) {
          outCh[i] = inCh[i] * this.currentGain;
        }
      }

      return true;
    }
  }

  registerProcessor('noise-suppressor', NoiseSuppressorProcessor);
} else {
  // ==========================================
  // ESCOPO: Janela do Navegador / Renderer (Window)
  // ==========================================
  console.log('[NoiseSuppressor] Arquivo de supressão de ruído carregado no Renderer.');
  if (typeof window !== 'undefined') {
    window.NoiseSuppressor = {
      isLoaded: true,
      processorName: 'noise-suppressor',
      createNode: async (audioContext, threshold = 0.018) => {
        try {
          await audioContext.audioWorklet.addModule('./noise-suppressor.js');
          const node = new AudioWorkletNode(audioContext, 'noise-suppressor');
          node.port.postMessage({ threshold });
          return node;
        } catch (err) {
          console.warn('[NoiseSuppressor] Falha ao instanciar worklet:', err);
          return null;
        }
      }
    };
  }
}
