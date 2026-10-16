// KRISHIV KART — desktop side of the phone-controller link (SPEC §11, §13.8).
//
//   import { PhoneLink } from './net.js';
//   const phone = new PhoneLink();
//   phone.connect().then(({ room, padUrl, qrSvg }) => ...).catch(() => { /* keyboard still works */ });
//   phone.on('join', ...); phone.on('leave', ...); phone.on('menu', (m) => ...); phone.on('info', ...);
//     ('menu' actions: SPEC §11 + the garage's customize / loadout / cycle / name /
//      randomize / reset / done, already validated by server.js)
//   phone.on('lost', ...); phone.on('signal', ...);  // input stream went silent mid-race / came back
//   phone.sendState({ screen: 'race', ... });       // deduped + heartbeat (garage states are ~5–8 KB)
//   phone.sendEvent('vibrate', { pattern: [40] });
//   phone.input  → { steer, gas, brake, drift, itemSeq, pauseSeq, lastUpdate }
//
// `active` is true while input keeps arriving: within 1500 ms normally, but
// within ~400 ms while the pad streams at race rate (60 Hz), so a stalled
// phone stops driving the kart almost at once.
//
// Lost phone: when the pad that was driving (a button held / an item or menu
// press in the last 30 s) goes silent for ~1 s while the last state sent with
// sendState() is a live race, PhoneLink emits 'lost' and then a local
// 'menu' { action: 'pause', reason: 'signal' }, so the game pauses without
// waiting for the socket timeout (a locked phone or dead Wi-Fi keeps its TCP
// socket open for seconds). 'signal' { lost: false } follows when input
// resumes.
//
// Uses the classic Socket.IO browser client (`window.io`, from
// /socket.io/socket.io.js). Importing this module never touches the DOM and
// never throws; connect() rejects with an Error when the server (or the client
// script) is unavailable, so keyboard play keeps working.
//
// The room code + a host key are kept in sessionStorage so a page reload (or a
// socket reconnect, or even a server restart) reclaims the same room and the
// phone stays paired. The room a phone is paired with is also kept in
// localStorage, so closing the tab and opening the game again reclaims it too
// (within the server's grace period) — but only while no other tab hosts it.
//
// Also exports the room-code helpers shared by server.js and pad.js.

import { NET } from './config.js';

// Room codes: 4 letters from an alphabet without look-alikes (no I, L, O).
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;

// Normalizes user/URL input into a valid room code, or returns null.
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (let i = 0; i < code.length; i++) {
    if (ROOM_ALPHABET.indexOf(code[i]) < 0) return null;
  }
  return code;
}

const CONNECT_TIMEOUT_MS = 6000;    // first connection attempt
const ACK_TIMEOUT_MS = 5000;        // host:create acknowledgement
const SCRIPT_TIMEOUT_MS = 4000;     // dynamic load of /socket.io/socket.io.js
const ACTIVE_WINDOW_MS = 1500;      // `active` = input seen within this window…
const STREAM_WINDOW_MS = 400;       // …shrunk toward this while the pad streams fast (6 missed samples' worth)
const LOST_AFTER_MS = 1000;         // a driving pad silent this long mid-race → 'lost' + pause
const IN_USE_MS = 30000;            // "driving" = a button / item / menu press this recently
const MIN_STATE_INTERVAL_MS = 66;   // host:state emits are capped at ~15 Hz
const STORAGE_KEY = 'krishivkart.host.room';
const LEGACY_STORAGE_KEY = 'tootkart.host.room';    // before the KRISHIV KART rename: still read once
const LIVE_RACE_STATES = new Set(['intro', 'countdown', 'racing']);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function clampSteer(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

// This tab's own room (sessionStorage) first, else the room the phone was last
// paired with (localStorage: a closed tab that is opened again).
function readStoredRoom(suffix = "") {
  for (const [name, shared] of [['sessionStorage', false], ['localStorage', true]]) {
    try {
      const store = globalThis[name];
      const raw = store?.getItem(STORAGE_KEY + suffix);
      if (!raw) continue;
      const v = JSON.parse(raw);
      const room = normalizeRoomCode(v?.room);
      if (room) return { room, key: typeof v.key === 'string' ? v.key.slice(0, 64) : '', shared };
    } catch { /* storage blocked / junk */ }
  }
  return null;
}

function writeStoredRoom(room, key, shared = false, suffix = "") {
  const json = JSON.stringify({ room, key });
  try { globalThis.sessionStorage?.setItem(STORAGE_KEY + suffix, json); globalThis.sessionStorage?.removeItem(LEGACY_STORAGE_KEY); } catch { /* storage blocked */ }
  if (shared) {
    try { globalThis.localStorage?.setItem(STORAGE_KEY + suffix, json); globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY); } catch { /* storage blocked */ }
  }
}

// Resolves window.io, loading the client script on demand if the page did not
// include it. Rejects (never throws) when it cannot be loaded.
function loadSocketIoClient() {
  return new Promise((resolve, reject) => {
    if (typeof globalThis.io === 'function') { resolve(globalThis.io); return; }
    if (typeof document === 'undefined') {
      reject(new Error('Socket.IO client is not available in this environment'));
      return;
    }
    // A <script src=".../socket.io.js"> that already ran without defining io
    // means the server is not there (e.g. a static dev server); do not retry.
    const existing = document.querySelector('script[src*="socket.io.js"]');
    if (existing && existing.dataset.krishivkart !== 'loading') {
      reject(new Error('Socket.IO client failed to load — is the KRISHIV KART server running? (npm start)'));
      return;
    }
    const script = existing || document.createElement('script');
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      delete script.dataset.krishivkart;
      if (err) reject(err);
      else if (typeof globalThis.io === 'function') resolve(globalThis.io);
      else reject(new Error('Socket.IO client loaded but window.io is missing'));
    };
    const onLoad = () => finish(null);
    const onError = () => finish(new Error('Could not load /socket.io/socket.io.js — is the KRISHIV KART server running? (npm start)'));
    const timer = setTimeout(() => finish(new Error('Timed out loading the Socket.IO client')), SCRIPT_TIMEOUT_MS);
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    if (!existing) {
      script.dataset.krishivkart = 'loading';
      script.src = '/socket.io/socket.io.js';
      script.async = true;
      (document.head || document.documentElement).appendChild(script);
    }
  });
}

export class PhoneLink {
  constructor(slot = 0) {
    this.storageSuffix = `.player${slot}`;
    this.room = null;
    this.padUrl = null;
    this.qrSvg = null;
    this.lanIps = [];
    this.connected = false;          // a pad is currently joined to our room
    this.padId = null;
    this.socketConnected = false;    // our own link to the server
    this.input = { steer: 0, gas: 0, brake: 0, drift: 0, itemSeq: 0, pauseSeq: 0, lastUpdate: 0 };

    this._key = '';                  // host key that lets us reclaim our room
    this._vacantOnly = false;        // stored room came from another (closed) tab: reclaim only if no one hosts it
    this._socket = null;
    this._listeners = new Map();
    this._connectPromise = null;
    this._rawSeq = { item: null, pause: null };   // last raw counters from the pad
    this._pendingStateJson = null;   // latest state handed to sendState()
    this._sentStateJson = null;      // last state actually emitted
    this._lastStateSendAt = -1e9;
    this._stateTimer = null;
    this._heartbeat = null;
    this._disposed = false;
    this._rx = { n: 0, t0: 0, rate: 0 };   // pad:input arrivals per second (last full second)
    this._usedAt = -Infinity;        // last button / item / pause / menu press from the pad
    this._raceLive = false;          // last sendState() was a race in intro / countdown / racing
    this._lost = false;              // 'lost' fired; cleared by the next input
  }

  // A pad is joined and has sent input recently. "Recently" follows the pad's
  // own cadence: ~400 ms at the 60 Hz race stream, 1500 ms for the slow
  // keepalive outside races.
  get active() {
    return this.connected && now() - this.input.lastUpdate < this._activeWindow();
  }

  _activeWindow() {
    const rate = this._rx.rate;
    if (!(rate > 0)) return ACTIVE_WINDOW_MS;
    const w = 6000 / rate;             // six samples' worth
    return w < STREAM_WINDOW_MS ? STREAM_WINDOW_MS : w > ACTIVE_WINDOW_MS ? ACTIVE_WINDOW_MS : w;
  }

  // True after 'lost' until input arrives again.
  get signalLost() {
    return this._lost;
  }

  // Subscribe to 'join' | 'leave' | 'menu' | 'info' (also 'status', 'input').
  // Returns an unsubscribe function.
  on(event, fn) {
    let set = this._listeners.get(event);
    if (!set) { set = new Set(); this._listeners.set(event, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[net] '${event}' listener threw`, err); }
    }
  }

  // Connects to the server and creates (or reclaims) a room.
  // Resolves { room, padUrl, qrSvg, lanIps }; rejects with an Error.
  connect() {
    if (this._disposed) return Promise.reject(new Error('PhoneLink was disposed'));
    if (!this._connectPromise) {
      this._connectPromise = this._connect().catch((err) => {
        this._connectPromise = null;
        throw err;
      });
    }
    return this._connectPromise;
  }

  async _connect() {
    const ioFn = await loadSocketIoClient();
    const stored = readStoredRoom(this.storageSuffix);
    if (stored && !this.room) { this.room = stored.room; this._key = stored.key; this._vacantOnly = stored.shared; }

    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = ioFn({ reconnectionDelay: 400, reconnectionDelayMax: 2500, timeout: CONNECT_TIMEOUT_MS });
      } catch (err) {
        reject(new Error(`Could not start the Socket.IO client (${err?.message || err})`));
        return;
      }
      this._socket = socket;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._closeSocket();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('Timed out connecting to the KRISHIV KART server')), CONNECT_TIMEOUT_MS + 500);

      socket.on('connect_error', (err) => {
        if (!settled) fail(new Error(`Cannot reach the KRISHIV KART server (${err?.message || 'connect error'})`));
      });

      socket.on('connect', () => {
        this.socketConnected = true;
        this._emit('status', { socketConnected: true });
        if (settled) { this._claimRoom(null); return; }     // reconnect: reclaim quietly
        this._claimRoom((info, err) => {
          if (settled) return;
          if (err) { fail(err); return; }
          settled = true;
          clearTimeout(timer);
          resolve(info);
        });
      });

      socket.on('disconnect', (reason) => {
        this.socketConnected = false;
        this._emit('status', { socketConnected: false, reason });
        if (this.connected) this._padGone('server');
        // Socket.IO does not auto-reconnect after a server-initiated disconnect
        // (e.g. the server restarting); retry ourselves so the room is reclaimed.
        if (reason === 'io server disconnect') {
          setTimeout(() => { if (socket === this._socket && !socket.connected) socket.connect(); }, 1000);
        }
      });

      socket.on('pad:join', (p) => {
        const padId = typeof p?.padId === 'string' ? p.padId : null;
        if (padId !== this.padId) this._usedAt = -Infinity;   // another phone: not "driving" yet
        this.padId = padId;
        this._rawSeq.item = null;        // adopt the new pad's counters as baseline
        this._rawSeq.pause = null;
        this._zeroInput();
        this._resetSignal();
        const wasConnected = this.connected;
        this.connected = true;
        if (this.room) writeStoredRoom(this.room, this._key, true, this.storageSuffix);   // the phone's room: reopen-able
        this._emit('join', { padId: this.padId, rejoin: wasConnected });
        this._flushState(true);          // give the pad our current screen right away
      });

      socket.on('pad:leave', (p) => {
        if (!this.connected) return;
        this._padGone('left', p?.padId);
      });

      socket.on('pad:input', (p) => this._onPadInput(p));

      socket.on('pad:menu', (p) => {
        if (!p || typeof p.action !== 'string') return;
        this._usedAt = now();
        this._emit('menu', p);
      });

      socket.on('host:info', (p) => this._applyInfo(p, true));

      // Another tab took over our room with the same host key (duplicated tab):
      // start over with a brand-new room so both tabs keep working.
      socket.on('host:replaced', () => {
        if (this.connected) this._padGone('replaced');
        this.room = null;
        this._key = '';
        this._vacantOnly = false;
        this._claimRoom(null);
      });
    });
  }

  // Emits host:create (reclaiming our previous room when we have one).
  _claimRoom(cb) {
    const socket = this._socket;
    if (!socket) return;
    const payload = this.room ? { room: this.room, key: this._key, ...(this._vacantOnly ? { vacantOnly: true } : {}) } : {};
    socket.timeout(ACK_TIMEOUT_MS).emit('host:create', payload, (err, res) => {
      if (socket !== this._socket) return;
      if (res && res.room) this._vacantOnly = false;   // from now on it is our own room
      if (err || !res || !res.room) {
        const e = new Error(err ? 'The server did not answer host:create' : (res?.error || 'Room creation failed'));
        if (cb) { cb(null, e); return; }
        // Reconnect path: retry shortly while the socket is up.
        setTimeout(() => { if (socket.connected && socket === this._socket) this._claimRoom(null); }, 1000);
        return;
      }
      const info = this._applyInfo(res, !cb);
      if (cb) {
        cb(info, null);
        this._emit('info', info);
      }
      this._startHeartbeat();
      this._flushState(true);            // refresh the server's cached state
    });
  }

  _applyInfo(res, notify) {
    if (!res || typeof res !== 'object') return this._info();
    const changed = res.room !== this.room || res.padUrl !== this.padUrl || res.qrSvg !== this.qrSvg;
    if (typeof res.room === 'string') this.room = res.room;
    if (typeof res.key === 'string' && res.key) this._key = res.key;
    if (typeof res.padUrl === 'string') this.padUrl = res.padUrl;
    if (typeof res.qrSvg === 'string') this.qrSvg = res.qrSvg;
    if (Array.isArray(res.lanIps)) this.lanIps = res.lanIps.filter((ip) => typeof ip === 'string');
    if (this.room) writeStoredRoom(this.room, this._key, !!res.padConnected, this.storageSuffix);
    const info = this._info();
    if (notify && changed) this._emit('info', info);
    return info;
  }

  _info() {
    return { room: this.room, padUrl: this.padUrl, qrSvg: this.qrSvg, lanIps: this.lanIps.slice() };
  }

  _padGone(reason, padId = this.padId) {
    this.connected = false;
    this._zeroInput();
    this._resetSignal();
    this._emit('leave', { padId, reason });
  }

  _zeroInput() {
    const inp = this.input;
    inp.steer = 0; inp.gas = 0; inp.brake = 0; inp.drift = 0;
  }

  _resetSignal() {
    this._rx.n = 0; this._rx.t0 = 0; this._rx.rate = 0;
    this._lost = false;
  }

  // Heartbeat tick: has the pad that was driving gone silent mid-race?
  _checkSignal() {
    if (!this.connected || this._lost || !this._raceLive) return;
    const last = this.input.lastUpdate;
    if (!last || now() - last < LOST_AFTER_MS) return;
    if (last - this._usedAt > IN_USE_MS) return;    // phone lying idle: someone else is driving
    this._lost = true;
    this._zeroInput();
    this._emit('lost', { padId: this.padId, silentMs: Math.round(now() - last) });
    this._emit('menu', { action: 'pause', reason: 'signal' });
  }

  // Raw pad counters may restart (new phone, page reload); our exposed
  // itemSeq/pauseSeq only ever move forward, by the pad's positive deltas.
  _advanceSeq(kind, raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    const last = this._rawSeq[kind];
    this._rawSeq[kind] = n;
    if (last === null) return;
    const d = n - last;
    if (d > 0 && d < 1000) {
      if (kind === 'item') this.input.itemSeq += d;
      else this.input.pauseSeq += d;
    }
  }

  _onPadInput(p) {
    if (!p || typeof p !== 'object') return;
    const inp = this.input;
    const t = now();
    const rx = this._rx;
    rx.n++;
    if (!rx.t0) rx.t0 = t;
    else if (t - rx.t0 >= 1000) { rx.rate = (rx.n * 1000) / (t - rx.t0); rx.n = 0; rx.t0 = t; }
    inp.steer = clampSteer(p.s);
    inp.gas = p.g ? 1 : 0;
    inp.brake = p.b ? 1 : 0;
    inp.drift = p.d ? 1 : 0;
    const seqs = inp.itemSeq + inp.pauseSeq;
    this._advanceSeq('item', p.i);
    this._advanceSeq('pause', p.p);
    if (inp.gas || inp.brake || inp.drift || inp.itemSeq + inp.pauseSeq !== seqs) this._usedAt = t;
    inp.lastUpdate = t;
    if (this._lost) {
      this._lost = false;
      this._emit('signal', { lost: false, padId: this.padId });
    }
    if (!this.connected) {               // missed pad:join (should not happen) — recover
      this.connected = true;
      this._emit('join', { padId: this.padId, rejoin: false });
    }
    this._emit('input', inp);
  }

  // Sends the phone's mirror state. Unchanged states are skipped; changes are
  // rate-limited to ~15 Hz (the latest always wins) and a heartbeat re-sends
  // the last state at NET.hostStateHz while a pad is connected.
  sendState(state) {
    if (!state || typeof state !== 'object') return;
    const r = state.race;
    this._raceLive = state.screen === 'race' && !!r && typeof r === 'object' && !r.finished && LIVE_RACE_STATES.has(r.state);
    let json;
    try { json = JSON.stringify(state); } catch { return; }
    this._pendingStateJson = json;
    if (json === this._sentStateJson) return;
    const wait = this._lastStateSendAt + MIN_STATE_INTERVAL_MS - now();
    if (wait <= 0) this._flushState(false);
    else if (!this._stateTimer) {
      this._stateTimer = setTimeout(() => { this._stateTimer = null; this._flushState(false); }, wait);
    }
  }

  _flushState(force, volatile = false) {
    const json = this._pendingStateJson;
    const socket = this._socket;
    if (!json || !socket || !socket.connected || !this.room) return;
    if (!force && json === this._sentStateJson) return;
    const payload = JSON.parse(json);
    if (volatile) socket.volatile.emit('host:state', payload);
    else socket.emit('host:state', payload);
    this._sentStateJson = json;
    this._lastStateSendAt = now();
  }

  _startHeartbeat() {
    if (this._heartbeat) return;
    const period = 1000 / Math.max(0.5, NET.hostStateHz || 5);
    this._heartbeat = setInterval(() => {
      if (!this.connected) return;
      this._checkSignal();
      if (now() - this._lastStateSendAt >= period * 0.9) this._flushState(true, true);
    }, period);
  }

  // Sends a host:event to the pad, e.g. sendEvent('vibrate', { pattern: [40] })
  // or sendEvent('toast', { text: 'Lap 2!' }). No-op without a pad.
  sendEvent(type, data = {}) {
    const socket = this._socket;
    if (!socket || !socket.connected || !this.connected || typeof type !== 'string') return;
    socket.emit('host:event', { ...(data && typeof data === 'object' ? data : {}), type });
  }

  _closeSocket() {
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try { socket.removeAllListeners(); socket.close(); } catch { /* ignore */ }
    }
    this.socketConnected = false;
  }

  // Closes the connection and stops all timers. The instance cannot reconnect.
  dispose() {
    this._disposed = true;
    clearInterval(this._heartbeat);
    clearTimeout(this._stateTimer);
    this._heartbeat = null;
    this._stateTimer = null;
    this._closeSocket();
    if (this.connected) this._padGone('disposed');
    this._listeners.clear();
  }
}
