/**
 * Chat Geral da tela inicial (lobby).
 *  - Fica no Firebase Realtime Database em lobby/chat, mantendo só as 50 últimas mensagens.
 *  - Aceita texto, links e fotos (fotos são reduzidas e guardadas como imagem compacta).
 *    Outros arquivos NÃO são permitidos aqui.
 *  - Notificações (aviso no ícone do app e som) podem ser desligadas separadamente nas Configurações > Geral.
 */
import { initFirebase, ref, set, get, remove, onChildAdded, onChildRemoved, queryLast } from './firebase-config.js';

const MAX_MESSAGES = 50;
const MAX_TEXT = 1000;
const IMG_MAX_SIDE = 1280;
const IMG_MAX_DATAURL = 350 * 1024; // ~350 KB por foto
const KEY_CLIENT_ID = 'tavern_lobby_client_id';
const KEY_NOTIFY_VISUAL = 'tavern_lobby_notify_visual';
const KEY_NOTIFY_SOUND = 'tavern_lobby_notify_sound';

function lsGet(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : v; } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

const STYLE = `
#lobby-chat { display: flex; flex-direction: column; height: 340px; min-height: 260px; background: #111214;
  border: 1px solid var(--border-subtle, #3f4147); border-radius: var(--radius-md, 10px); overflow: hidden; }
#lobby-chat .lc-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px;
  background: var(--bg-card, #313338); font-size: 13px; font-weight: 700; color: var(--text-bright, #f2f3f5); }
#lobby-chat .lc-head small { font-weight: 500; color: var(--text-muted, #949ba4); font-size: 11px; }
#lobby-chat-list { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
#lobby-chat-list .lc-empty { color: var(--text-muted, #949ba4); font-size: 12px; text-align: center; margin-top: 16px; }
.lc-msg .lc-meta { font-size: 11px; color: var(--text-muted, #949ba4); margin-bottom: 1px; }
.lc-msg .lc-meta b { color: var(--text-bright, #f2f3f5); }
.lc-msg.mine .lc-meta b { color: var(--accent-gold, #f0b232); }
.lc-msg .lc-text { color: var(--text-normal, #dbdee1); white-space: pre-wrap; word-break: break-word; }
.lc-msg .lc-text a { color: var(--accent-blurple, #7289ff); text-decoration: underline; }
.lc-msg img.lc-img { display: block; max-width: 100%; max-height: 200px; border-radius: 6px; margin-top: 4px; cursor: zoom-in; object-fit: contain; }
#lobby-chat-form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border-subtle, #3f4147); align-items: center; }
#lobby-chat-input { flex: 1; min-width: 0; background: var(--bg-input, #1e1f22); color: var(--text-bright, #f2f3f5);
  border: 1px solid var(--border-subtle, #3f4147); border-radius: 8px; padding: 7px 10px; font-size: 13px; outline: none; }
#lobby-chat-input:focus { border-color: var(--border-focus, #5865f2); }
#lobby-chat-form button { background: var(--bg-card, #313338); color: var(--text-bright, #f2f3f5); border: 1px solid var(--border-subtle, #3f4147);
  border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 14px; }
#lobby-chat-send { background: var(--accent-blurple, #5865f2) !important; border-color: transparent !important; }
#lobby-chat.lc-drop { outline: 2px dashed var(--accent-blurple, #5865f2); outline-offset: -6px; }
#lobby-chat .lc-status { font-size: 11px; color: var(--text-muted, #949ba4); padding: 0 12px 6px; min-height: 0; }
/* A prévia da câmera do lobby fica oculta; só aparece se precisar pedir permissão do microfone */
#lobby-preview-box { display: none !important; }
#lobby-preview-box:has(#lobby-permission-prompt:not(.hidden)) { display: flex !important; }
`;

function linkify(container, text) {
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = m[0];
    container.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}

async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  let side = IMG_MAX_SIDE, quality = 0.8, url = '';
  for (let i = 0; i < 5; i++) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * scale));
    cv.height = Math.max(1, Math.round(bmp.height * scale));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    url = cv.toDataURL('image/jpeg', quality);
    if (url.length <= IMG_MAX_DATAURL) break;
    side = Math.round(side * 0.75);
    quality = Math.max(0.5, quality - 0.1);
  }
  if (bmp.close) bmp.close();
  return url.length <= IMG_MAX_DATAURL ? url : null;
}

export class LobbyChat {
  /**
   * @param {object} opts
   *  getName(): nome atual do usuário
   *  isInCall(): true se estiver numa chamada (som de notificação fica mudo durante a sessão)
   *  openLightbox(url, name): abre imagem em tela cheia
   *  notify(text): aviso curto na tela
   */
  constructor(opts) {
    this.opts = opts || {};
    this.db = null;
    this.seen = new Set();
    this.attachedAt = 0;
    this.unread = 0;
    this.clientId = lsGet(KEY_CLIENT_ID, null);
    if (!this.clientId) {
      this.clientId = 'c_' + Math.random().toString(36).slice(2, 12);
      lsSet(KEY_CLIENT_ID, this.clientId);
    }
  }

  get notifyVisual() { return lsGet(KEY_NOTIFY_VISUAL, 'true') !== 'false'; }
  get notifySound() { return lsGet(KEY_NOTIFY_SOUND, 'true') !== 'false'; }

  async init() {
    this.buildUI();
    this.setupSettingsToggles();
    this.setupAttentionReset();
    try {
      const { db } = await initFirebase();
      if (!db) throw new Error('sem Firebase');
      this.db = db;
    } catch (e) {
      this.setStatus('Chat geral indisponível (Firebase não conectado).');
      return;
    }
    this.attachedAt = Date.now();
    const q = queryLast(ref(this.db, 'lobby/chat'), MAX_MESSAGES);
    onChildAdded(q, (snap) => {
      if (this.seen.has(snap.key)) return;
      this.seen.add(snap.key);
      this.render(snap.key, snap.val());
    });
    setTimeout(() => {
      const list = document.getElementById('lobby-chat-list');
      const empty = list && list.querySelector('.lc-empty');
      if (empty) empty.textContent = 'Nenhuma mensagem ainda. Diga olá!';
    }, 3000);
    onChildRemoved(q, (snap) => {
      document.querySelector(`.lc-msg[data-key="${CSS.escape(snap.key)}"]`)?.remove();
    });
  }

  // ---------- UI ----------
  buildUI() {
    if (document.getElementById('lobby-chat')) return;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const container = document.querySelector('.preview-container');
    if (!container) return;
    const box = document.createElement('div');
    box.id = 'lobby-chat';
    box.innerHTML = `
      <div class="lc-head"><span>💬 Chat Geral</span><small>últimas ${MAX_MESSAGES} mensagens</small></div>
      <div id="lobby-chat-list"><div class="lc-empty">Carregando mensagens...</div></div>
      <div class="lc-status" id="lobby-chat-status"></div>
      <form id="lobby-chat-form" autocomplete="off">
        <button type="button" id="lobby-chat-photo" title="Enviar foto">📷</button>
        <input id="lobby-chat-input" type="text" maxlength="${MAX_TEXT}" placeholder="Mensagem para todos..." />
        <button type="submit" id="lobby-chat-send" title="Enviar">➤</button>
        <input type="file" id="lobby-chat-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
      </form>`;
    container.insertBefore(box, container.firstChild);

    const input = box.querySelector('#lobby-chat-input');
    box.querySelector('#lobby-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendText(input.value);
      input.value = '';
    });
    const fileInput = box.querySelector('#lobby-chat-file');
    box.querySelector('#lobby-chat-photo').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) this.sendImage(fileInput.files[0]);
      fileInput.value = '';
    });
    // Colar imagem (Ctrl+V)
    input.addEventListener('paste', (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); const f = item.getAsFile(); if (f) this.sendImage(f); }
    });
    // Arrastar foto para o chat geral
    box.addEventListener('dragover', (e) => {
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
      e.preventDefault();
      box.classList.add('lc-drop');
    });
    box.addEventListener('dragleave', () => box.classList.remove('lc-drop'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove('lc-drop');
      const f = Array.from(e.dataTransfer?.files || [])[0];
      if (f) this.sendImage(f);
    });
    // Atalhos do app (mute etc.) não disparam enquanto digita
    box.addEventListener('keydown', (e) => e.stopPropagation());
    box.addEventListener('keyup', (e) => e.stopPropagation());

    // Evita que o Electron "abra" um arquivo solto fora das áreas de chat (trocaria a página)
    document.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
    });
  }

  setStatus(text) {
    const list = document.getElementById('lobby-chat-list');
    const empty = list && list.querySelector('.lc-empty');
    if (empty) { empty.textContent = text || ''; return; }
    const el = document.getElementById('lobby-chat-status');
    if (el) el.textContent = text || '';
  }

  render(key, e) {
    const list = document.getElementById('lobby-chat-list');
    if (!list || !e) return;
    list.querySelector('.lc-empty')?.remove();
    const mine = e.cid === this.clientId;
    const wrap = document.createElement('div');
    wrap.className = 'lc-msg' + (mine ? ' mine' : '');
    wrap.dataset.key = key;
    const meta = document.createElement('div');
    meta.className = 'lc-meta';
    const b = document.createElement('b');
    b.textContent = mine ? 'Você' : String(e.name || 'Aventureiro').slice(0, 40);
    meta.appendChild(b);
    const d = new Date(Number(e.ts) || Date.now());
    const sameDay = d.toDateString() === new Date().toDateString();
    meta.appendChild(document.createTextNode(' · ' + (sameDay ? '' : d.toLocaleDateString() + ' ') +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    wrap.appendChild(meta);

    if (e.kind === 'image' && typeof e.img === 'string' && e.img.startsWith('data:image/')) {
      const img = document.createElement('img');
      img.className = 'lc-img';
      img.src = e.img;
      img.alt = 'Foto';
      img.addEventListener('click', () => this.opts.openLightbox && this.opts.openLightbox(e.img, 'foto.jpg'));
      img.addEventListener('load', () => this.scrollToEnd());
      wrap.appendChild(img);
    } else if (typeof e.text === 'string') {
      const t = document.createElement('div');
      t.className = 'lc-text';
      linkify(t, e.text.slice(0, MAX_TEXT));
      wrap.appendChild(t);
    } else {
      return;
    }

    // Mantém a ordem pela chave (chaves começam com timestamp)
    const after = Array.from(list.querySelectorAll('.lc-msg')).find((el) => el.dataset.key > key);
    if (after) list.insertBefore(wrap, after); else list.appendChild(wrap);
    this.scrollToEnd();

    const isNew = (Number(e.ts) || 0) > this.attachedAt - 2000;
    if (!mine && isNew) this.onIncoming();
  }

  scrollToEnd() {
    const list = document.getElementById('lobby-chat-list');
    if (list) list.scrollTop = list.scrollHeight;
  }

  // ---------- Envio ----------
  async push(entry) {
    if (!this.db) { this.opts.notify && this.opts.notify('Chat geral indisponível no momento.'); return; }
    const key = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      await set(ref(this.db, `lobby/chat/${key}`), { ...entry, cid: this.clientId, name: (this.opts.getName && this.opts.getName()) || 'Aventureiro', ts: Date.now() });
      this.trim();
    } catch (err) {
      console.warn('[ChatGeral] Falha ao enviar:', err);
      this.opts.notify && this.opts.notify('Não foi possível enviar a mensagem (verifique as regras do Firebase para "lobby").');
    }
  }

  sendText(raw) {
    const text = String(raw || '').trim().slice(0, MAX_TEXT);
    if (text) this.push({ kind: 'text', text });
  }

  async sendImage(file) {
    if (!file || !/^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type || '')) {
      this.opts.notify && this.opts.notify('No chat geral só é possível enviar fotos, texto e links.');
      return;
    }
    try {
      const img = await compressImage(file);
      if (!img) { this.opts.notify && this.opts.notify('Foto muito grande para o chat geral.'); return; }
      this.push({ kind: 'image', img });
    } catch (e) {
      this.opts.notify && this.opts.notify('Não foi possível ler essa imagem.');
    }
  }

  // Remove mensagens além das 50 mais recentes
  async trim() {
    try {
      const snap = await get(ref(this.db, 'lobby/chat'));
      const val = snap && snap.val ? snap.val() : null;
      if (!val) return;
      const keys = Object.keys(val).sort();
      const extra = keys.length - MAX_MESSAGES;
      for (let i = 0; i < extra; i++) remove(ref(this.db, `lobby/chat/${keys[i]}`));
    } catch (e) {}
  }

  // ---------- Notificações ----------
  isChatVisible() {
    const lobby = document.getElementById('lobby-chat');
    const callScreen = document.getElementById('call-screen');
    const inCall = callScreen && !callScreen.classList.contains('hidden');
    return !!lobby && !inCall && document.visibilityState === 'visible' && document.hasFocus();
  }

  onIncoming() {
    if (this.isChatVisible()) return;
    this.unread++;
    if (this.notifyVisual) this.updateBadge();
    if (this.notifySound && !(this.opts.isInCall && this.opts.isInCall())) this.playSound();
  }

  setupAttentionReset() {
    const reset = () => {
      if (this.unread && this.isChatVisible()) {
        this.unread = 0;
        this.updateBadge();
      }
    };
    window.addEventListener('focus', reset);
    document.addEventListener('visibilitychange', reset);
    setInterval(reset, 2000); // cobre a volta da tela de chamada para o lobby
  }

  makeBadgeImage(count) {
    try {
      const cv = document.createElement('canvas');
      cv.width = 32; cv.height = 32;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ed4245';
      ctx.beginPath(); ctx.arc(16, 16, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(count > 9 ? '9+' : String(count), 16, 17);
      return cv.toDataURL('image/png');
    } catch (e) { return null; }
  }

  updateBadge() {
    const count = this.notifyVisual ? this.unread : 0;
    // Título da janela/aba
    const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = count ? `(${count > 99 ? '99+' : count}) ${base}` : base;
    // Ícone na barra de tarefas (Electron)
    const api = window.electronAPI;
    if (api && typeof api.setUnreadBadge === 'function') {
      api.setUnreadBadge({ count, image: count ? this.makeBadgeImage(count) : null });
    }
  }

  playSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      [[880, 0], [1318.5, 0.12]].forEach(([freq, delay]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + delay);
        g.gain.exponentialRampToValueAtTime(0.12, now + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(now + delay);
        o.stop(now + delay + 0.4);
      });
    } catch (e) {}
  }

  setupSettingsToggles() {
    const v = document.getElementById('toggle-lobby-notify-visual');
    const s = document.getElementById('toggle-lobby-notify-sound');
    if (v) {
      v.checked = this.notifyVisual;
      v.addEventListener('change', () => { lsSet(KEY_NOTIFY_VISUAL, v.checked ? 'true' : 'false'); this.updateBadge(); });
    }
    if (s) {
      s.checked = this.notifySound;
      s.addEventListener('change', () => lsSet(KEY_NOTIFY_SOUND, s.checked ? 'true' : 'false'));
    }
  }
}
