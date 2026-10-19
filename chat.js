/**
 * Chat da sala.
 *  - Texto e "avisos de arquivo" (com miniatura) ficam no Firebase Realtime Database em rooms/<sala>/chat,
 *    então quem entra depois vê o histórico. Tudo some junto com a sala quando o último participante sai.
 *  - O conteúdo dos arquivos NÃO vai para o Firebase: é enviado direto de pessoa para pessoa (WebRTC).
 *  - Sem Firebase (modo servidor), o texto cai para o DataChannel e não há histórico.
 *
 * Arquivos: o remetente anuncia o arquivo e só envia os dados quando alguém clica em "Baixar"
 * (assim ninguém recebe arquivo pesado sem querer, e o remetente precisa continuar na sala).
 */

import { ref, set, remove, onChildAdded } from './firebase-config.js';

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB por arquivo (limite prático: memória de quem baixa)
const CHUNK_BYTES = 12 * 1024;           // tamanho de cada pedaço (antes do base64)
const BUFFER_HIGH = 1024 * 1024;         // pausa o envio se o canal tiver >1MB pendente

const CSS = `
#chat-toggle-btn { position: relative; }
#chat-unread-badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 8px; background: #ed4245; color: #fff; font-size: 10px; font-weight: 700; line-height: 16px;
  text-align: center; box-sizing: border-box; }
#chat-unread-badge.hidden { display: none; }
#chat-panel { position: fixed; right: 12px; bottom: 84px; width: min(340px, calc(100vw - 24px)); height: min(460px, 60vh);
  background: var(--bg-sidebar, #2b2d31); border: 1px solid var(--border-subtle, #3f4147); border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.45); display: flex; flex-direction: column; z-index: 900; overflow: hidden; }
#chat-panel.hidden { display: none; }
#chat-panel .chat-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;
  background: var(--bg-card, #313338); font-size: 13px; font-weight: 600; color: var(--text-primary, #f2f3f5); }
#chat-panel .chat-head button { background: none; border: 0; color: inherit; cursor: pointer; font-size: 16px; padding: 2px 6px; }
#chat-messages { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
#chat-messages .chat-empty { color: var(--text-muted, #949ba4); font-size: 12px; text-align: center; margin-top: 12px; }
.chat-msg .chat-meta { font-size: 11px; color: var(--text-muted, #949ba4); margin-bottom: 1px; }
.chat-msg .chat-meta b { color: var(--text-primary, #f2f3f5); }
.chat-msg.mine .chat-meta b { color: var(--accent-gold, #f0b232); }
.chat-msg .chat-text { color: var(--text-primary, #dbdee1); white-space: pre-wrap; word-break: break-word; }
.chat-msg.system .chat-text { color: var(--text-muted, #949ba4); font-style: italic; font-size: 12px; }
.chat-file { margin-top: 2px; padding: 8px; border-radius: 8px; background: var(--bg-card, #313338);
  border: 1px solid var(--border-subtle, #3f4147); display: flex; flex-direction: column; gap: 6px; }
.chat-file .chat-file-name { font-weight: 600; word-break: break-all; }
.chat-file .chat-file-size { font-size: 11px; color: var(--text-muted, #949ba4); }
.chat-file button, .chat-file a.chat-dl { align-self: flex-start; background: var(--accent-blurple, #5865f2); color: #fff; border: 0;
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; text-decoration: none; }
.chat-file button:disabled { opacity: .6; cursor: default; }
.chat-file img { max-width: 100%; max-height: 180px; border-radius: 6px; object-fit: contain; }
.chat-file .chat-bar { height: 4px; border-radius: 2px; background: var(--bg-input, #1e1f22); overflow: hidden; }
.chat-file .chat-bar > i { display: block; height: 100%; width: 0; background: var(--accent-green, #23a55a); }
#chat-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 2000; display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
#chat-lightbox img { max-width: 94vw; max-height: 90vh; object-fit: contain; border-radius: 6px; }
#chat-lightbox .lb-actions { position: fixed; top: 12px; right: 16px; display: flex; gap: 8px; }
#chat-lightbox .lb-actions a, #chat-lightbox .lb-actions button { background: rgba(0,0,0,.6); color: #fff; border: 1px solid #fff3; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; text-decoration: none; }
.chat-file img.chat-thumb { cursor: zoom-in; }
.chat-text a { color: var(--accent-blurple, #7289ff); text-decoration: underline; }
#chat-panel.chat-drop-active { outline: 2px dashed var(--accent-blurple, #5865f2); outline-offset: -6px; }
#chat-panel.chat-drop-active #chat-messages::after { content: 'Solte o arquivo para compartilhar'; position: sticky; bottom: 0; align-self: center;
  background: var(--accent-blurple, #5865f2); color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 12px; }
#chat-form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border-subtle, #3f4147); align-items: center; }
#chat-input { flex: 1; min-width: 0; background: var(--bg-input, #1e1f22); color: var(--text-primary, #f2f3f5);
  border: 1px solid var(--border-subtle, #3f4147); border-radius: 8px; padding: 7px 10px; font-size: 13px; outline: none; }
#chat-input:focus { border-color: var(--border-focus, #5865f2); }
#chat-form button { background: var(--bg-card, #313338); color: var(--text-primary, #f2f3f5); border: 1px solid var(--border-subtle, #3f4147);
  border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 14px; }
#chat-send-btn { background: var(--accent-blurple, #5865f2) !important; border-color: transparent !important; }
`;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class RoomChat {
  /**
   * @param {() => object|null} getWebrtc  retorna a instância TavernWebRTC atual (ou null)
   */
  constructor(getWebrtc) {
    this.getWebrtc = getWebrtc;
    this.sentFiles = new Map();     // fileId -> File
    this.incoming = new Map();      // `${peerId}:${fileId}` -> { parts, got, total, ui }
    this.unread = 0;
    this.built = false;
    this.db = null;
    this.roomId = null;
    this.unsub = null;
    this.seen = new Set();
    this.attachedAt = 0;
  }

  // ---------- UI ----------
  build() {
    if (this.built) return;
    const controls = document.getElementById('btn-toggle-dice-panel');
    if (!controls) return;
    this.built = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.className = 'control-btn';
    btn.id = 'chat-toggle-btn';
    btn.type = 'button';
    btn.setAttribute('data-tooltip', 'Chat da sala');
    btn.innerHTML = '<span style="font-size:15px;line-height:1;">💬</span><span id="chat-unread-badge" class="hidden">0</span>';
    controls.parentNode.insertBefore(btn, controls);
    btn.addEventListener('click', () => this.toggle());

    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.className = 'hidden';
    panel.innerHTML = `
      <div class="chat-head"><span>💬 Chat da sala</span><button type="button" id="chat-min-btn" title="Minimizar">—</button></div>
      <div id="chat-messages"><div class="chat-empty">Mensagens e arquivos só existem enquanto a sala está aberta. Arraste um arquivo para cá para compartilhar.</div></div>
      <form id="chat-form" autocomplete="off">
        <button type="button" id="chat-attach-btn" title="Enviar arquivo (até 200 MB)">📎</button>
        <input id="chat-input" type="text" maxlength="1000" placeholder="Mensagem..." />
        <button type="submit" id="chat-send-btn">➤</button>
        <input type="file" id="chat-file-input" hidden />
      </form>`;
    document.body.appendChild(panel);

    panel.querySelector('#chat-min-btn').addEventListener('click', () => this.toggle(false));
    panel.querySelector('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = panel.querySelector('#chat-input');
      this.sendText(input.value);
      input.value = '';
    });
    const fileInput = panel.querySelector('#chat-file-input');
    panel.querySelector('#chat-attach-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) this.offerFile(fileInput.files[0]);
      fileInput.value = '';
    });
    // Atalhos do app (PTT etc.) não devem disparar enquanto digita
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());

    // Arrastar e soltar arquivos: no painel do chat ou em qualquer lugar da tela da chamada
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const inCall = () => {
      const cs = document.getElementById('call-screen');
      return !!this.getWebrtc() && cs && !cs.classList.contains('hidden');
    };
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || !inCall()) return;
      dragDepth++;
      this.toggle(true);
      panel.classList.add('chat-drop-active');
    });
    document.addEventListener('dragleave', (e) => {
      if (!hasFiles(e) || !inCall()) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) panel.classList.remove('chat-drop-active');
    });
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || !inCall()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e) || !inCall()) return;
      e.preventDefault();
      dragDepth = 0;
      panel.classList.remove('chat-drop-active');
      const files = Array.from(e.dataTransfer.files || []);
      files.slice(0, 5).forEach((f) => this.offerFile(f));
    });
  }

  get panel() { return document.getElementById('chat-panel'); }
  get list() { return document.getElementById('chat-messages'); }

  toggle(force) {
    const p = this.panel;
    if (!p) return;
    const open = typeof force === 'boolean' ? force : p.classList.contains('hidden');
    p.classList.toggle('hidden', !open);
    if (open) {
      this.unread = 0;
      this.updateBadge();
      const input = document.getElementById('chat-input');
      if (input) input.focus();
      this.scroll();
    }
  }

  isOpen() { const p = this.panel; return !!p && !p.classList.contains('hidden'); }

  updateBadge() {
    const b = document.getElementById('chat-unread-badge');
    if (!b) return;
    b.textContent = this.unread > 99 ? '99+' : String(this.unread);
    b.classList.toggle('hidden', this.unread === 0);
  }

  scroll() { const l = this.list; if (l) l.scrollTop = l.scrollHeight; }

  addEntry({ name, mine, text, system, node, quiet }) {
    const l = this.list;
    if (!l) return null;
    l.querySelector('.chat-empty')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg' + (mine ? ' mine' : '') + (system ? ' system' : '');
    if (!system) {
      const meta = document.createElement('div');
      meta.className = 'chat-meta';
      const b = document.createElement('b');
      b.textContent = mine ? 'Você' : (name || 'Aventureiro');
      meta.appendChild(b);
      meta.appendChild(document.createTextNode(' · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      wrap.appendChild(meta);
    }
    if (text) {
      const t = document.createElement('div');
      t.className = 'chat-text';
      // Links http(s) viram clicáveis (abrem no navegador do sistema)
      const re = /https?:\/\/[^\s<>"']+/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) t.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement('a');
        a.href = m[0];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[0];
        t.appendChild(a);
        last = m.index + m[0].length;
      }
      if (last < text.length) t.appendChild(document.createTextNode(text.slice(last)));
      wrap.appendChild(t);
    }
    if (node) wrap.appendChild(node);
    l.appendChild(wrap);
    this.scroll();
    if (!mine && !system && !quiet && !this.isOpen()) {
      this.unread++;
      this.updateBadge();
    }
    return wrap;
  }

  // ---------- Firebase (histórico) ----------
  attach(db, roomId) {
    this.detach();
    this.db = db;
    this.roomId = roomId;
    this.attachedAt = Date.now();
    this.seen.clear();
    const chatRef = ref(db, `rooms/${roomId}/chat`);
    this.unsub = onChildAdded(chatRef, (snap) => {
      const e = snap.val();
      if (!e || this.seen.has(snap.key)) return;
      this.seen.add(snap.key);
      this.onEntry(e);
    });
  }

  detach() {
    if (typeof this.unsub === 'function') { try { this.unsub(); } catch (e) {} }
    this.unsub = null;
    this.db = null;
    this.roomId = null;
  }

  get myId() { const r = this.getWebrtc(); return r ? r.myPeerId : null; }

  pushEntry(entry) {
    if (!this.db || !this.roomId) return false;
    const key = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set(ref(this.db, `rooms/${this.roomId}/chat/${key}`), entry).catch(() => {});
    return true;
  }

  onEntry(e) {
    const mine = e.from === this.myId;
    const quiet = (e.ts || 0) < this.attachedAt - 1000; // histórico antigo não conta como "não lida"
    if (e.kind === 'file') {
      this.showOffer(e.from, { fileId: e.fileId, name: e.fname, size: e.size, mime: e.mime, thumb: e.thumb, senderName: e.name }, mine, quiet);
    } else if (typeof e.text === 'string') {
      this.addEntry({ name: e.name, mine, text: e.text.slice(0, 1000), quiet });
    }
  }

  // ---------- Envio ----------
  sendText(raw) {
    const text = (raw || '').trim().slice(0, 1000);
    const rtc = this.getWebrtc();
    if (!text || !rtc) return;
    if (this.pushEntry({ kind: 'text', from: rtc.myPeerId, name: rtc.userInfo.name, text, ts: Date.now() })) return;
    // Fallback sem Firebase: DataChannel (sem histórico)
    rtc.broadcastRpgAction({ type: 'chat-msg', text });
    this.addEntry({ mine: true, text });
  }

  async makeThumb(file) {
    if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type || '')) return null;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * scale));
      cv.height = Math.max(1, Math.round(bmp.height * scale));
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      if (bmp.close) bmp.close();
      return cv.toDataURL('image/jpeg', 0.7);
    } catch (e) {
      return null;
    }
  }

  async offerFile(file) {
    const rtc = this.getWebrtc();
    if (!rtc) return;
    if (file.size > MAX_FILE_BYTES) {
      this.addEntry({ system: true, text: `Arquivo "${file.name}" é maior que ${fmtSize(MAX_FILE_BYTES)} e não foi enviado.` });
      return;
    }
    const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this.sentFiles.set(fileId, file);
    const thumb = await this.makeThumb(file);
    const ok = this.pushEntry({
      kind: 'file', from: rtc.myPeerId, name: rtc.userInfo.name, fileId,
      fname: file.name, size: file.size, mime: file.type || '', thumb: thumb || null, ts: Date.now()
    });
    if (!ok) {
      rtc.broadcastRpgAction({ type: 'chat-file-offer', fileId, name: file.name, size: file.size, mime: file.type || '', thumb: thumb || null });
      this.showOffer(rtc.myPeerId, { fileId, name: file.name, size: file.size, mime: file.type || '', thumb, senderName: rtc.userInfo.name }, true, false);
    }
  }

  openLightbox(url, name) {
    document.getElementById('chat-lightbox')?.remove();
    const lb = document.createElement('div');
    lb.id = 'chat-lightbox';
    const img = document.createElement('img');
    img.src = url;
    img.alt = name || '';
    const actions = document.createElement('div');
    actions.className = 'lb-actions';
    const dl = document.createElement('a');
    dl.href = url;
    dl.download = String(name || 'imagem').replace(/[\\/:*?"<>|]/g, '_');
    dl.textContent = 'Salvar';
    dl.addEventListener('click', (e) => e.stopPropagation());
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Fechar ✕';
    actions.append(dl, close);
    lb.append(img, actions);
    const closeIt = () => { lb.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeIt(); } };
    lb.addEventListener('click', closeIt);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(lb);
  }

  // ---------- Recebimento (chamado pelo onDataMessage do app) ----------
  handle(peerId, data) {
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('chat-')) return false;
    switch (data.type) {
      case 'chat-msg':
        if (typeof data.text === 'string') {
          this.addEntry({ name: data.senderName, text: data.text.slice(0, 1000) });
        }
        break;
      case 'chat-file-offer':
        this.showOffer(peerId, data, false, false);
        break;
      case 'chat-file-request':
        this.streamFile(peerId, data.fileId);
        break;
      case 'chat-file-chunk':
        this.receiveChunk(peerId, data);
        break;
      case 'chat-file-error':
        this.failIncoming(peerId, data.fileId, data.reason || 'O remetente não tem mais o arquivo.');
        break;
    }
    return true;
  }

  sendTo(peerId, obj) {
    const rtc = this.getWebrtc();
    const peer = rtc && rtc.peers && rtc.peers.get(peerId);
    const dc = peer && peer.dataChannel;
    if (!dc || dc.readyState !== 'open') return null;
    try { dc.send(JSON.stringify(obj)); } catch (e) { return null; }
    return dc;
  }

  showOffer(peerId, data, mine, quiet) {
    const key = `${peerId}:${data.fileId}`;
    const isImage = /^image\/(png|jpe?g|gif|webp|bmp)$/.test(data.mime || '');
    const box = document.createElement('div');
    box.className = 'chat-file';
    const name = document.createElement('div');
    name.className = 'chat-file-name';
    name.textContent = (isImage ? '🖼️ ' : '📎 ') + String(data.name || 'arquivo').slice(0, 200);
    const size = document.createElement('div');
    size.className = 'chat-file-size';
    size.textContent = fmtSize(Number(data.size) || 0) + (mine ? ' · disponível enquanto você estiver na sala' : '');
    box.append(name, size);

    const ui = { box, meta: data, url: null, thumb: null };
    // Miniatura (vem junto do aviso, sem precisar baixar o arquivo)
    if (isImage && typeof data.thumb === 'string' && data.thumb.startsWith('data:image/')) {
      const th = document.createElement('img');
      th.className = 'chat-thumb';
      th.src = data.thumb;
      th.alt = String(data.name || '');
      th.title = 'Clique para abrir';
      box.appendChild(th);
      ui.thumb = th;
    }
    const bar = document.createElement('div');
    bar.className = 'chat-bar';
    bar.innerHTML = '<i></i>';
    bar.style.display = 'none';
    const btn = document.createElement('button');
    btn.type = 'button';
    ui.bar = bar;
    ui.btn = btn;
    box.appendChild(bar);

    if (mine) {
      // Quem enviou abre o próprio arquivo localmente
      if (ui.thumb) {
        ui.thumb.addEventListener('click', () => {
          const f = this.sentFiles.get(data.fileId);
          if (f) this.openLightbox(URL.createObjectURL(f), data.name);
        });
      }
    } else {
      btn.textContent = isImage ? 'Baixar imagem' : 'Baixar';
      const start = (openAfter) => {
        if (ui.url) { if (openAfter) this.openLightbox(ui.url, data.name); return; }
        if (this.incoming.has(key)) { ui.openAfter = ui.openAfter || openAfter; return; }
        btn.disabled = true;
        btn.textContent = 'Baixando...';
        bar.style.display = 'block';
        ui.openAfter = !!openAfter;
        this.incoming.set(key, { parts: [], got: 0, total: null, ui });
        if (!this.sendTo(peerId, { type: 'chat-file-request', fileId: data.fileId })) {
          this.failIncoming(peerId, data.fileId, 'Não foi possível falar com o remetente (ele saiu da sala?).');
        }
      };
      btn.addEventListener('click', () => start(isImage));
      if (ui.thumb) ui.thumb.addEventListener('click', () => start(true));
      box.appendChild(btn);
    }
    this.addEntry({ name: data.senderName, mine, node: box, quiet });
  }

  async streamFile(peerId, fileId) {
    const file = this.sentFiles.get(fileId);
    if (!file) {
      this.sendTo(peerId, { type: 'chat-file-error', fileId, reason: 'O arquivo não está mais disponível.' });
      return;
    }
    const total = Math.ceil(file.size / CHUNK_BYTES) || 1;
    for (let seq = 0; seq < total; seq++) {
      const rtc = this.getWebrtc();
      const peer = rtc && rtc.peers && rtc.peers.get(peerId);
      const dc = peer && peer.dataChannel;
      if (!dc || dc.readyState !== 'open') return; // destinatário saiu
      if (dc.bufferedAmount > BUFFER_HIGH) {
        await new Promise((resolve) => {
          dc.bufferedAmountLowThreshold = BUFFER_HIGH / 2;
          const done = () => { dc.removeEventListener('bufferedamountlow', done); resolve(); };
          dc.addEventListener('bufferedamountlow', done);
          setTimeout(done, 2000);
        });
      }
      const buf = await file.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES).arrayBuffer();
      try {
        dc.send(JSON.stringify({ type: 'chat-file-chunk', fileId, seq, total, d: b64FromBytes(new Uint8Array(buf)) }));
      } catch (e) { return; }
    }
  }

  receiveChunk(peerId, data) {
    const key = `${peerId}:${data.fileId}`;
    const st = this.incoming.get(key);
    if (!st) return; // ninguém pediu esse arquivo
    st.total = data.total;
    st.parts[data.seq] = bytesFromB64(data.d);
    st.got++;
    const pct = Math.min(100, Math.round((st.got / st.total) * 100));
    const fill = st.ui.bar.querySelector('i');
    if (fill) fill.style.width = pct + '%';
    st.ui.btn.textContent = `Baixando... ${pct}%`;
    if (st.got >= st.total) this.finishIncoming(key, st);
  }

  finishIncoming(key, st) {
    this.incoming.delete(key);
    const meta = st.ui.meta;
    const blob = new Blob(st.parts, { type: meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    st.ui.url = url;
    st.ui.bar.style.display = 'none';
    st.ui.btn.remove();
    const isImage = /^image\/(png|jpe?g|gif|webp|bmp)$/.test(meta.mime || '');
    if (isImage && !st.ui.thumb) {
      const img = document.createElement('img');
      img.className = 'chat-thumb';
      img.src = url;
      img.addEventListener('click', () => this.openLightbox(url, meta.name));
      st.ui.box.appendChild(img);
    } else if (st.ui.thumb) {
      st.ui.thumb.src = url; // troca a miniatura pela imagem completa
      st.ui.thumb.addEventListener('click', () => this.openLightbox(url, meta.name));
    }
    const a = document.createElement('a');
    a.className = 'chat-dl';
    a.href = url;
    a.download = String(meta.name || 'arquivo').replace(/[\\/:*?"<>|]/g, '_');
    a.textContent = 'Salvar arquivo';
    st.ui.box.appendChild(a);
    if (isImage && st.ui.openAfter) this.openLightbox(url, meta.name);
    this.scroll();
  }

  failIncoming(peerId, fileId, reason) {
    const key = `${peerId}:${fileId}`;
    const st = this.incoming.get(key);
    this.incoming.delete(key);
    if (st) {
      st.ui.bar.style.display = 'none';
      st.ui.btn.disabled = false;
      st.ui.btn.textContent = 'Tentar de novo';
    }
    this.addEntry({ system: true, text: reason });
  }

  /** Quando um participante sai, cancela downloads em andamento dele. */
  peerLeft(peerId) {
    for (const key of Array.from(this.incoming.keys())) {
      if (key.startsWith(peerId + ':')) this.failIncoming(peerId, key.slice(peerId.length + 1), 'O remetente saiu da sala durante o download.');
    }
  }

  /** Limpa tudo ao sair da sala. */
  reset() {
    this.detach();
    this.seen.clear();
    this.sentFiles.clear();
    this.incoming.clear();
    this.unread = 0;
    this.updateBadge();
    const l = this.list;
    if (l) l.innerHTML = '<div class="chat-empty">Mensagens e arquivos só existem enquanto a sala está aberta. Arraste um arquivo para cá para compartilhar.</div>';
    this.toggle(false);
  }
}
