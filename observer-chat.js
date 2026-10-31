/**
 * Chat dos observadores (modo observador).
 *  - Só texto, guardado no Firebase em rooms/<sala>/observerChat (some junto com a sala).
 *  - Fica como uma segunda aba ("👁 Observadores") dentro da janela do chat da sala (#chat-panel).
 *  - Os jogadores não veem esta aba; ela também lista quem está observando.
 *  - Sussurro: o observador marca um ou mais jogadores para ouvirem só a voz dele.
 */

import { ref, set, onChildAdded } from './firebase-config.js';

const CSS = `
#chat-tabs { display: none; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle, #3f4147); background: var(--bg-sidebar, #2b2d31); }
html.observer-mode #chat-tabs { display: flex; }
#chat-tabs button { flex: 1; background: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 8px;
  color: var(--text-muted, #949ba4); font-size: 12px; font-weight: 600; cursor: pointer; }
#chat-tabs button.active { background: var(--bg-card, #313338); color: var(--text-bright, #fff); border-color: var(--border-subtle, #3f4147); }
#observer-chat-unread { display: inline-block; margin-left: 6px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: #ed4245; color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; box-sizing: border-box; }
#observer-chat-unread.hidden, #observer-chat-dot.hidden { display: none; }
#observer-chat-dot { position: absolute; bottom: -3px; right: -3px; width: 10px; height: 10px; border-radius: 50%;
  background: var(--accent-blurple, #5865f2); border: 2px solid var(--bg-app, #1e1f22); }
#observer-chat-view { display: none; flex: 1; min-height: 0; flex-direction: column; }
#chat-panel.obs-tab #observer-chat-view { display: flex; }
#chat-panel.obs-tab #chat-messages { display: none; }
#observer-whisper-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border-subtle, #3f4147); font-size: 12px; color: var(--text-muted, #949ba4); }
#observer-whisper-list { display: flex; flex-wrap: wrap; gap: 6px; }
#observer-whisper-list label { display: flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 9999px; background: var(--bg-card, #313338); color: var(--text-normal, #dbdee1); cursor: pointer; }
#observer-chat-people { padding: 6px 12px; border-bottom: 1px solid var(--border-subtle, #3f4147); font-size: 12px;
  color: var(--text-muted, #949ba4); display: flex; flex-wrap: wrap; gap: 6px; }
#observer-chat-people .ochat-person { padding: 2px 8px; border-radius: 9999px; background: var(--bg-card, #313338);
  color: var(--text-normal, #dbdee1); border: 1px solid transparent; }
#observer-chat-people .ochat-person.speaking { border-color: var(--accent-green, #23a55a); }
#observer-chat-messages { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
#observer-chat-messages .ochat-empty { color: var(--text-muted, #949ba4); font-size: 12px; text-align: center; margin-top: 12px; }
#observer-chat-messages .ochat-meta { font-size: 11px; color: var(--text-muted, #949ba4); }
#observer-chat-messages .ochat-meta b { color: var(--text-normal, #dbdee1); }
#observer-chat-messages .mine .ochat-meta b { color: var(--accent-gold, #f0b232); }
#observer-chat-messages .ochat-text { color: var(--text-normal, #dbdee1); white-space: pre-wrap; word-break: break-word; }
#observer-chat-form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border-subtle, #3f4147); }
#observer-chat-input { flex: 1; min-width: 0; background: var(--bg-input, #1e1f22); color: var(--text-bright, #fff);
  border: 1px solid var(--border-subtle, #3f4147); border-radius: 8px; padding: 7px 10px; font-size: 13px; outline: none; }
#observer-chat-input:focus { border-color: var(--border-focus, #5865f2); }
#observer-chat-form button { background: var(--accent-blurple, #5865f2); color: #fff; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
`;

const EMPTY_TEXT = 'Só os observadores veem este chat. Os jogadores não ouvem nem leem vocês.';
const NO_PLAYERS_TEXT = 'ninguém na mesa ainda';

export class ObserverChat {
  /**
   * @param {() => object|null} getWebrtc  retorna a instância TavernWebRTC atual (ou null)
   */
  constructor(getWebrtc) {
    this.getWebrtc = getWebrtc;
    this.built = false;
    this.db = null;
    this.roomId = null;
    this.unsub = null;
    this.seen = new Set();
    this.unread = 0;
    this.attachedAt = 0;
    this.whisperKey = null;
    this.whisperTimer = null;
    // Sussurro: app.js preenche estes
    this.getPlayers = null;       // () => [{ peerId, name }] jogadores na mesa
    this.getActiveWhisper = null; // () => [peerId] quem está recebendo o sussurro agora
    this.onWhisperChange = null;  // ([peerId]) => void, quando o observador marca/desmarca
  }

  /**
   * Monta a aba "Observadores" dentro da janela do chat da sala (#chat-panel, criada pelo RoomChat).
   * As abas só aparecem no modo observador.
   */
  build() {
    if (this.built) return;
    const chatPanel = document.getElementById('chat-panel');
    const chatHead = chatPanel && chatPanel.querySelector('.chat-head');
    if (!chatPanel || !chatHead) return;
    this.built = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const tabs = document.createElement('div');
    tabs.id = 'chat-tabs';
    tabs.innerHTML = `
      <button type="button" data-chat-tab="mesa" class="active">💬 Mesa</button>
      <button type="button" data-chat-tab="obs">👁 Observadores<span id="observer-chat-unread" class="hidden">0</span></button>`;
    chatHead.after(tabs);
    tabs.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => this.selectTab(b.getAttribute('data-chat-tab')));
    });

    const view = document.createElement('div');
    view.id = 'observer-chat-view';
    view.innerHTML = `
      <div id="observer-whisper-row">
        <span>🎙 Sussurrar para:</span>
        <div id="observer-whisper-list"><span class="ochat-empty">${NO_PLAYERS_TEXT}</span></div>
      </div>
      <div id="observer-chat-people"></div>
      <div id="observer-chat-messages"><div class="ochat-empty">${EMPTY_TEXT}</div></div>
      <form id="observer-chat-form" autocomplete="off">
        <input id="observer-chat-input" type="text" maxlength="1000" placeholder="Mensagem para os observadores..." />
        <button type="submit">➤</button>
      </form>`;
    chatPanel.appendChild(view);

    view.querySelector('#observer-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = view.querySelector('#observer-chat-input');
      this.send(input.value);
      input.value = '';
    });

    // Lista de jogadores para sussurrar: atualiza quando alguém entra ou sai
    this.whisperTimer = setInterval(() => this.refreshWhisperOptions(), 2000);

    // Bolinha no botão do chat quando chega mensagem dos observadores
    const chatBtn = document.getElementById('chat-toggle-btn');
    if (chatBtn) {
      const dot = document.createElement('span');
      dot.id = 'observer-chat-dot';
      dot.className = 'hidden';
      chatBtn.appendChild(dot);
      chatBtn.addEventListener('click', () => { if (this.isVisible()) this.clearUnread(); });
    }
  }

  get panel() { return document.getElementById('chat-panel'); }
  get list() { return document.getElementById('observer-chat-messages'); }

  selectTab(tab) {
    const p = this.panel;
    if (!p) return;
    const obs = tab === 'obs';
    p.classList.toggle('obs-tab', obs);
    document.querySelectorAll('#chat-tabs button').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-chat-tab') === tab);
    });
    if (obs) {
      this.clearUnread();
      document.getElementById('observer-chat-input')?.focus();
      const l = this.list;
      if (l) l.scrollTop = l.scrollHeight;
    }
  }

  /** A aba dos observadores está aberta e visível? */
  isVisible() {
    const p = this.panel;
    return !!p && !p.classList.contains('hidden') && p.classList.contains('obs-tab');
  }

  clearUnread() {
    this.unread = 0;
    this.updateBadge();
  }

  updateBadge() {
    const b = document.getElementById('observer-chat-unread');
    if (b) {
      b.textContent = this.unread > 99 ? '99+' : String(this.unread);
      b.classList.toggle('hidden', this.unread === 0);
    }
    document.getElementById('observer-chat-dot')?.classList.toggle('hidden', this.unread === 0);
  }

  /**
   * Reconstrói a lista de jogadores (caixas de seleção) só quando algo mudou,
   * para não atrapalhar o clique do observador.
   */
  refreshWhisperOptions() {
    const box = document.getElementById('observer-whisper-list');
    if (!box) return;
    if (!document.documentElement.classList.contains('observer-mode')) return;

    const players = typeof this.getPlayers === 'function' ? this.getPlayers() : [];
    const active = new Set(typeof this.getActiveWhisper === 'function' ? this.getActiveWhisper() : []);
    const key = players.map(p => `${p.peerId}:${p.name}`).join('|') + '#' + [...active].sort().join(',');
    if (key === this.whisperKey) return;
    this.whisperKey = key;

    box.innerHTML = '';
    if (players.length === 0) {
      box.innerHTML = `<span class="ochat-empty">${NO_PLAYERS_TEXT}</span>`;
      return;
    }
    players.forEach(p => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.peerId;
      cb.checked = active.has(p.peerId);
      cb.addEventListener('change', () => this.emitWhisper());
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + p.name));
      box.appendChild(label);
    });
  }

  emitWhisper() {
    const ids = [...document.querySelectorAll('#observer-whisper-list input[type="checkbox"]:checked')].map(i => i.value);
    if (typeof this.onWhisperChange === 'function') this.onWhisperChange(ids);
  }

  /** Lista de observadores conectados (você incluso). */
  setPeople(people) {
    const box = document.getElementById('observer-chat-people');
    if (!box) return;
    box.innerHTML = '';
    people.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'ochat-person';
      chip.id = `ochat-person-${p.peerId}`;
      chip.textContent = p.name;
      box.appendChild(chip);
    });
  }

  setSpeaking(peerId, isSpeaking) {
    document.getElementById(`ochat-person-${peerId}`)?.classList.toggle('speaking', !!isSpeaking);
  }

  attach(db, roomId) {
    this.detach();
    this.db = db;
    this.roomId = roomId;
    this.attachedAt = Date.now();
    this.seen.clear();
    this.unsub = onChildAdded(ref(db, `rooms/${roomId}/observerChat`), (snap) => {
      const e = snap.val();
      if (!e || this.seen.has(snap.key) || typeof e.text !== 'string') return;
      this.seen.add(snap.key);
      const rtc = this.getWebrtc();
      const mine = !!rtc && e.from === rtc.myPeerId;
      this.addEntry(e.name, e.text.slice(0, 1000), mine, (e.ts || 0) < this.attachedAt - 1000);
    });
  }

  detach() {
    if (typeof this.unsub === 'function') { try { this.unsub(); } catch (e) {} }
    this.unsub = null;
    this.db = null;
    this.roomId = null;
  }

  send(raw) {
    const text = (raw || '').trim().slice(0, 1000);
    const rtc = this.getWebrtc();
    if (!text || !rtc || !this.db || !this.roomId) return;
    const key = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set(ref(this.db, `rooms/${this.roomId}/observerChat/${key}`), {
      from: rtc.myPeerId, name: rtc.userInfo.name, text, ts: Date.now()
    }).catch(() => {});
  }

  addEntry(name, text, mine, quiet) {
    const l = this.list;
    if (!l) return;
    l.querySelector('.ochat-empty')?.remove();
    const wrap = document.createElement('div');
    if (mine) wrap.className = 'mine';
    const meta = document.createElement('div');
    meta.className = 'ochat-meta';
    const b = document.createElement('b');
    b.textContent = mine ? 'Você' : (name || 'Observador');
    meta.appendChild(b);
    meta.appendChild(document.createTextNode(' · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    const t = document.createElement('div');
    t.className = 'ochat-text';
    t.textContent = text;
    wrap.appendChild(meta);
    wrap.appendChild(t);
    l.appendChild(wrap);
    l.scrollTop = l.scrollHeight;
    if (!mine && !quiet && !this.isVisible()) {
      this.unread++;
      this.updateBadge();
    }
  }

  /** Limpa tudo ao sair da sala. */
  reset() {
    this.detach();
    this.seen.clear();
    this.unread = 0;
    this.updateBadge();
    const l = this.list;
    if (l) l.innerHTML = `<div class="ochat-empty">${EMPTY_TEXT}</div>`;
    this.setPeople([]);
    this.whisperKey = null;
    const box = document.getElementById('observer-whisper-list');
    if (box) box.innerHTML = `<span class="ochat-empty">${NO_PLAYERS_TEXT}</span>`;
    this.selectTab('mesa');
  }
}
