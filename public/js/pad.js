// TOOT KART phone controller (SPEC §11).
//
// Runs on the phone at https://<LAN IP>:3443/pad?room=ABCD. The phone is held
// sideways like a steering wheel: rotating it steers, the on-screen buttons
// are GAS / BRAKE (right thumb) and DRIFT / ITEM (left thumb). Menus mirror
// the desktop's `host:state` so the whole game can be driven from the phone.
//
// Flow: [insecure-context help] → [room code entry] → "tap to start" gate
// (sensor permission, wake lock, fullscreen) → live screens from host:state.
//
// Steering pipeline (see SPEC):
//   deviceorientation β,γ → world-up in device coords → rotate into the
//   visible UI frame (screen orientation angle + our CSS rotation) →
//   θ = in-plane wheel angle atan2(−ux, uy), blended into asin(−ux) as the
//   phone lies flat (see angleFromScreenUp) → minus calibration → invert? →
//   2° dead zone → full lock at the sensitivity angle → mild expo → low-pass →
//   sent as `s` (+1 = right). Falls back to devicemotion gravity, then to a
//   touch slider.
//
// When the page is hidden mid-race (screen lock, app switch, a call) while the
// phone is in use, the pad sends a pause right away and stops streaming.
//
// window.__pad exposes live values for automated tests.

import { ITEM_INFO, ITEM_IDS, DIFFICULTY, NET, RACE } from './config.js';
import { clamp, damp, ordinal, formatTime } from './utils.js';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from './net.js';

// ---------------------------------------------------------------- constants

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const DEAD_ZONE_DEG = 3.5;
const LOCK_MIN_DEG = 18;
const LOCK_MAX_DEG = 65;
const LOCK_DEFAULT_DEG = 45;
const EXPO = 0.52;                 // 0 = linear … 1 = cubic response
const STEER_LPF_RATE = 14;         // 1/s low-pass (~45 ms time constant)
const TOUCH_LPF_RATE = 32;
const SENSOR_TIMEOUT_MS = 1500;    // after the gate: no events → next fallback
const SENSOR_STALE_MS = 600;       // tilt source silent this long → steer returns to 0
const CALIB_LIMIT_DEG = 45;
const AUTO_CENTER_LIMIT_DEG = 30;
const ROT_SWITCH = 0.55;           // in-plane gravity needed to flip the CSS rotation side
const ROT_HOLD_MS = 220;
// Orientation-angle sanity check (see checkAngleSanity). Both holds are longer
// than the OS takes to re-orient the page after a 180° turn, so a normal turn
// never triggers a false correction.
const FLIP_HOLD_FIRST_MS = 900;
const FLIP_HOLD_MS = 1600;
const WHEEL_M0 = 0.35;             // in-plane gravity at/below this: flat phone → roll angle…
const WHEEL_M1 = 0.6;              // …at/above this: wheel grip → true in-plane wheel angle
const KEEPALIVE_MS = 250;          // input heartbeat outside the race screen
const IN_USE_MS = 30000;           // touched this recently = the phone is the controller
const RELOAD_HINT_ERRORS = 4;      // failed reconnects in a row → suggest reloading the page
const HINT_DELAY_MS = 900;         // portrait pose held this long → "turn sideways" hint
const PING_MS = 2000;
const WHEEL_VISUAL_DEG = 110;      // wheel graphic rotation at full lock
const START_PRESS_LEAD = (RACE.startBoostWindow[0] + RACE.startBoostWindow[1]) / 2;
const SETTINGS_KEY = 'tootkart.pad.settings.v1';
const ID_KEY = 'tootkart.pad.id';
const HOST_SCREENS = new Set(['title', 'select', 'race', 'results', 'paused', 'loading']);
// Character art on the pad is just a color swatch + a generic emoji.
const CHAR_EMOJI = { sahur: '🪵',tralalero: '🦈',patapim: '🌳',crocodilo: '🐊',cappuccina: '☕',bananini: '🍌',lirili: '🌵',assassino: '🥷', blaze: '🦊', bolt: '🤖', pip: '🐧', duke: '🐻', nova: '🧑‍🚀', gus: '🐸', mochi: '🐱', ziggy: '👽' };

// ---------------------------------------------------------------- storage

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode / blocked */ }
}

function loadSettings() {
  const s = { lockDeg: LOCK_DEFAULT_DEG, autoGas: false, invert: false, haptics: true, steerMode: 'tilt' };
  try {
    const v = JSON.parse(storageGet(SETTINGS_KEY) || '{}');
    if (Number.isFinite(v.lockDeg)) s.lockDeg = clamp(Math.round(v.lockDeg), LOCK_MIN_DEG, LOCK_MAX_DEG);
    if (typeof v.autoGas === 'boolean') s.autoGas = v.autoGas;
    if (typeof v.invert === 'boolean') s.invert = v.invert;
    if (typeof v.haptics === 'boolean') s.haptics = v.haptics;
    if (v.steerMode === 'touch' || v.steerMode === 'tilt') s.steerMode = v.steerMode;
  } catch { /* defaults */ }
  return s;
}
const settings = loadSettings();
const saveSettings = () => storageSet(SETTINGS_KEY, JSON.stringify(settings));

function getClientId() {
  let id = storageGet(ID_KEY);
  if (!id || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
    const rnd = new Uint8Array(9);
    (window.crypto || {}).getRandomValues?.(rnd);
    id = 'pad-' + Array.from(rnd, (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
    storageSet(ID_KEY, id);
  }
  return id;
}
const clientId = getClientId();

// ---------------------------------------------------------------- state

const state = {
  phase: 'boot',            // 'insecure' | 'code' | 'gate' | 'live'
  room: null,
  gatePassed: false,
  socketConnected: false,
  joined: false,            // our pad:hello was accepted and we are the active pad
  everJoined: false,
  hostPresent: false,
  kicked: false,
  serverMissing: false,
  roomError: '',
  host: null,               // last host:state
  steerSource: 'none',      // 'orientation' | 'motion' | 'touch' | 'none'
  forceTouch: false,
  permissionDenied: false,
  connectErrors: 0,         // failed (re)connect attempts in a row
  pageVisible: document.visibilityState !== 'hidden',
  cssRot: 0,                // CSS rotation applied to the stage (0 | 90 | -90)
  calib: 0,                 // steering center θ₀ (degrees)
  buttons: { gas: false, brake: false, drift: false, item: false },
  itemSeq: 0,
  pauseSeq: 0,
  sheetOpen: false,
  rttMs: null,
  sent: 0,
};

// Steering pipeline values
const grav = { x: 0, y: 0, z: 1 };   // world-up in device coordinates (unit)
const scr = { x: 0, y: 0 };          // scratch: up in a screen frame
let gravValid = false;
let gravAt = -1e9;
let rawAngleDeg = 0;                 // θ before calibration
let steerTarget = 0;
let steer = 0;                       // filtered value that is sent
let lastOrientationAt = -1e9;
let lastMotionAt = -1e9;
let orientationEvents = 0;
let motionEvents = 0;
let motionSign = /iPad|iPhone|iPod/.test(navigator.userAgent) ? -1 : 1;   // legacy iOS reports inverted gravity
const motionEvidence = { sum: 0, n: 0 };
const touchSteer = { pointerId: null, value: 0 };

// Layout / orientation
const layout = { w: 0, h: 0, portrait: false };
let rotSide = 90;                    // CSS rotation used while the layout is portrait
let rotPendingSince = 0;
let osFlip = false;                  // corrects a browser reporting the opposite landscape angle
let flipPendingSince = 0;
let flipVerified = false;
let saneSince = 0;
let holdingUpright = false;
let uprightSince = 0;                // when holdingUpright last became true

// ---------------------------------------------------------------- steering math (pure)

// World-up vector in device coordinates from W3C deviceorientation β, γ (deg).
function upFromOrientation(betaDeg, gammaDeg, out) {
  const b = betaDeg * DEG;
  const g = gammaDeg * DEG;
  const cb = Math.cos(b);
  out.x = -Math.sin(g) * cb;
  out.y = Math.sin(b);
  out.z = Math.cos(g) * cb;
  return out;
}

// Rotates the device-frame vector into a screen frame rotated by aDeg.
function toScreen(up, aDeg, out) {
  const a = aDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = up.x * c - up.y * s;
  out.y = up.x * s + up.y * c;
  return out;
}

const smooth01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

// Steering angle θ (degrees, clockwise like a wheel = positive) from world-up
// (ux, uy) in the UI frame. Held like a wheel, θ is the true in-plane wheel
// angle atan2(−ux, uy): it does not depend on how far the screen is tilted
// back, and pitching the phone while holding a turn does not change it. Lying
// (nearly) flat there is hardly any in-plane gravity and that angle means
// nothing, so θ blends into asin(−ux), the roll of a flat phone, as
// m = hypot(ux, uy) falls from WHEEL_M1 to WHEEL_M0. It also fades to asin as
// the wheel nears ±90° (uy → 0), so it can never wrap around.
function angleFromScreenUp(ux, uy) {
  const flat = Math.asin(clamp(-ux, -1, 1));
  const m = Math.hypot(ux, uy);
  if (m <= WHEEL_M0 || uy <= 0) return flat * RAD2DEG;
  const w = smooth01((m - WHEEL_M0) / (WHEEL_M1 - WHEEL_M0)) * smooth01(uy / (m * 0.25));
  return (w * Math.atan2(-ux, uy) + (1 - w) * flat) * RAD2DEG;
}

function rawAngleFromUp(up, aDeg) {
  const a = aDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return angleFromScreenUp(up.x * c - up.y * s, up.x * s + up.y * c);
}

// Dead zone + full lock + mild expo. deg is already calibrated (and inverted).
function shapeSteer(deg, lockDeg) {
  const mag = Math.abs(deg);
  if (mag <= DEAD_ZONE_DEG) return 0;
  let x = Math.min(1, (mag - DEAD_ZONE_DEG) / Math.max(1, lockDeg - DEAD_ZONE_DEG));
  x = (1 - EXPO) * x + EXPO * x * x * x;
  return deg < 0 ? -x : x;
}

function steerFromAngle(thetaDeg) {
  let d = thetaDeg - state.calib;
  if (settings.invert) d = -d;
  return shapeSteer(d, settings.lockDeg);
}

// ---------------------------------------------------------------- orientation angle

function reportedOsAngle() {
  const so = window.screen && window.screen.orientation;
  let a = null;
  if (so && typeof so.angle === 'number') a = so.angle;
  else if (typeof window.orientation === 'number') a = window.orientation;
  return a === null ? null : ((Math.round(a) % 360) + 360) % 360;
}

// Angle of the page layout relative to the device's natural orientation.
function osAngle() {
  let a = reportedOsAngle();
  if (a === null) a = layout.portrait ? 0 : 90;
  if (!layout.portrait && osFlip) a = (a + 180) % 360;
  return a;
}

// Effective rotation of the visible UI relative to the device (SPEC "a").
function uiAngle() {
  return (osAngle() + state.cssRot + 360) % 360;
}

// The OS only lays a page out landscape when gravity says so, so in landscape
// the screen's "up" must point roughly up. If it consistently points down, the
// browser reports the opposite landscape angle (seen on some WebKit builds):
// flip our interpretation. Quick on the first samples, slow afterwards.
function checkAngleSanity(now) {
  if (layout.portrait) { flipPendingSince = 0; return; }
  toScreen(grav, uiAngle(), scr);
  if (Math.hypot(scr.x, scr.y) < 0.6) { flipPendingSince = 0; return; }
  if (scr.y < -0.55) {
    if (!flipPendingSince) flipPendingSince = now;
    else if (now - flipPendingSince > (flipVerified ? FLIP_HOLD_MS : FLIP_HOLD_FIRST_MS)) {
      osFlip = !osFlip;
      flipPendingSince = 0;
      flipVerified = true;
      rawAngleDeg = rawAngleFromUp(grav, uiAngle());
    }
  } else {
    flipPendingSince = 0;
    if (scr.y > 0.4) {
      if (!saneSince) saneSince = now;
      if (!flipVerified && now - saneSince > 1000) flipVerified = true;
    }
  }
}

// Portrait layout: rotate the stage toward the side gravity says is up, with
// hysteresis (must clearly cross to the other side, for ROT_HOLD_MS).
function updateRotation(now) {
  if (!layout.portrait || !gravValid || now - gravAt > 1000) {
    rotPendingSince = 0;
    holdingUpright = false;
    return;
  }
  toScreen(grav, osAngle(), scr);
  const upright = Math.abs(scr.y) > 0.75 && Math.abs(scr.x) < 0.45;
  if (upright && !holdingUpright) uprightSince = now;
  holdingUpright = upright;
  const want = scr.x > ROT_SWITCH ? 90 : scr.x < -ROT_SWITCH ? -90 : 0;
  if (want && want !== rotSide) {
    if (!rotPendingSince) rotPendingSince = now;
    else if (now - rotPendingSince >= ROT_HOLD_MS) {
      rotSide = want;
      rotPendingSince = 0;
      applyLayout(false);
    }
  } else {
    rotPendingSince = 0;
  }
}

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'),
  connDot: $('conn-dot'), roomLabel: $('room-label'), pingLabel: $('ping-label'),
  place: $('place'), placeNum: $('place-num'), placeSuf: $('place-suf'), placeOf: $('place-of'),
  lapNum: $('lap-num'), lapTotal: $('lap-total'),
  insecureLink: $('insecure-link'),
  codeSlots: $('code-slots'), codeError: $('code-error'), keypad: $('keypad'), codeJoin: $('btn-code-join'),
  gatePerm: $('gate-perm'), gateStatus: $('gate-status'), gateStatusText: $('gate-status-text'),
  connectingTitle: $('connecting-title'), connectingSub: $('connecting-sub'),
  charGrid: $('char-grid'), diffSeg: $('diff-seg'),
  btnItem: $('btn-item'), itemIcon: $('item-icon'), itemCount: $('item-count'),
  wheel: $('wheel'), countdown: $('countdown'), finish: $('finish-banner'),
  tmLeft: $('tm-left'), tmRight: $('tm-right'),
  tsTrack: $('ts-track'), tsKnob: $('ts-knob'), steerMode: $('steer-mode'),
  standings: $('standings'), resTitle: $('res-title'),
  ovWaiting: $('ov-waiting'), ovKicked: $('ov-kicked'),
  hintRotate: $('hint-rotate'), bannerOffline: $('banner-offline'), offlineText: $('offline-text'),
  sheet: $('sheet'), sheetBody: $('sheet-body'), sens: $('sens'), sensVal: $('sens-val'), modeSeg: $('mode-seg'),
  tiltNote: $('tilt-note'),
  setAutoGas: $('set-autogas'), setInvert: $('set-invert'), setHaptics: $('set-haptics'), dbg: $('dbg'),
  toast: $('toast'), flash: $('flash'),
};
const screens = {};
for (const sec of document.querySelectorAll('.screen')) screens[sec.id.replace(/^scr-/, '')] = sec;

function setText(node, text) {
  if (node._text !== text) { node._text = text; node.textContent = text; }
}
function toggle(node, cls, on) {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}
// Scrollable lists get .more (bottom fade) while rows are hidden below.
function updateScrollHint(node) {
  toggle(node, 'more', node.scrollTop + node.clientHeight < node.scrollHeight - 2);
}
const scrollLists = () => [el.charGrid, el.standings, el.sheetBody];
function refreshScrollHints() {
  requestAnimationFrame(() => { for (const list of scrollLists()) updateScrollHint(list); });
}

// ---------------------------------------------------------------- layout

let trackHalf = 0;   // touch slider travel (px, unrotated), measured lazily

function applyLayout(instant) {
  const vv = window.visualViewport;
  const W = Math.round(vv && vv.width ? vv.width : window.innerWidth);
  const H = Math.round(vv && vv.height ? vv.height : window.innerHeight);
  layout.w = W;
  layout.h = H;
  layout.portrait = H > W;
  const rot = layout.portrait ? rotSide : 0;
  const sw = rot ? H : W;
  const sh = rot ? W : H;
  const st = el.stage.style;
  if (instant) el.stage.classList.add('no-anim');
  st.setProperty('--sw', `${sw}px`);
  st.setProperty('--sh', `${sh}px`);
  st.setProperty('--vw', `${(sw / 100).toFixed(3)}px`);
  st.setProperty('--vh', `${(sh / 100).toFixed(3)}px`);
  st.setProperty('--rot', `${rot}deg`);
  toggle(el.stage, 'rot-cw', rot === 90);
  toggle(el.stage, 'rot-ccw', rot === -90);
  toggle(el.stage, 'narrow', sw < 600);      // small phone (e.g. portrait-locked SE): compact menus
  state.cssRot = rot;
  trackHalf = 0;
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => el.stage.classList.remove('no-anim')));
  if (gravValid) rawAngleDeg = rawAngleFromUp(grav, uiAngle());
}

// ---------------------------------------------------------------- sensors

function onGravitySample(now) {
  gravValid = true;
  gravAt = now;
  checkAngleSanity(now);
  rawAngleDeg = rawAngleFromUp(grav, uiAngle());
}

function onDeviceOrientation(e) {
  const b = e.beta;
  const g = e.gamma;
  if (b == null || g == null || !Number.isFinite(b) || !Number.isFinite(g)) return;
  const now = performance.now();
  lastOrientationAt = now;
  orientationEvents++;
  upFromOrientation(b, g, grav);
  onGravitySample(now);
  if (state.gatePassed && tiltWanted() && state.steerSource !== 'orientation') setSource('orientation');
}

function onDeviceMotion(e) {
  const acc = e.accelerationIncludingGravity;
  if (!acc || acc.x == null || acc.y == null || acc.z == null) return;
  const x = Number(acc.x), y = Number(acc.y), z = Number(acc.z);
  const len = Math.hypot(x, y, z);
  if (!Number.isFinite(len) || len < 4 || len > 20) return;   // free fall / hard shake / junk
  const now = performance.now();
  lastMotionAt = now;
  motionEvents++;
  if (now - lastOrientationAt < 400) return;                 // orientation events win
  // Spec: the vector points UP (+9.8 z when lying face up). Legacy iOS reports
  // it inverted. Evidence: the screen faces the player, so up·z should be > 0.
  const nz = z / len;
  if (motionEvidence.n < 20 && Math.abs(nz) > 0.3) {
    motionEvidence.sum += nz * motionSign;
    motionEvidence.n++;
    if (motionEvidence.n === 20 && motionEvidence.sum / 20 < -0.25) motionSign = -motionSign;
  }
  const k = 0.45;   // light smoothing: this signal includes hand jerks
  grav.x += (motionSign * x / len - grav.x) * k;
  grav.y += (motionSign * y / len - grav.y) * k;
  grav.z += (motionSign * z / len - grav.z) * k;
  onGravitySample(now);
  if (state.gatePassed && tiltWanted() && state.steerSource !== 'orientation' && state.steerSource !== 'motion') setSource('motion');
}

const tiltWanted = () => settings.steerMode === 'tilt' && !state.forceTouch;

function setSource(src) {
  if (state.steerSource === src) return;
  state.steerSource = src;
  el.stage.dataset.steer = src;
  renderSteerMode();
  touchSteer.value = 0;
  touchSteer.pointerId = null;
  trackHalf = 0;
}

function renderSteerMode() {
  const src = state.steerSource;
  const blocked = state.permissionDenied && settings.steerMode === 'tilt';
  toggle(el.stage, 'tilt-blocked', blocked);
  setText(el.steerMode, src === 'touch' ? (blocked ? 'TILT BLOCKED (SEE ⚙) · DRAG TO STEER' : 'DRAG THE KNOB TO STEER') : src === 'none' ? '' : 'TILT TO STEER');
}

// iOS remembers a denied motion permission for this address until Safari is
// relaunched, so say how to get tilt back — on the race screen and in settings.
function setPermissionDenied(denied) {
  state.permissionDenied = denied;
  el.tiltNote.hidden = !denied;
  renderSteerMode();
}

// Asks for motion access (iOS 13+). Must run synchronously inside a user
// gesture. Resolves 'granted' | 'denied' | 'unsupported'.
function askMotionPermission() {
  const asks = [];
  for (const C of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
    if (C && typeof C.requestPermission === 'function') {
      try { asks.push(C.requestPermission().catch(() => 'denied')); } catch { asks.push(Promise.resolve('denied')); }
    }
  }
  if (!asks.length) return Promise.resolve('unsupported');
  return Promise.all(asks).then((res) => (res.includes('granted') ? 'granted' : 'denied'));
}

// TILT mode / "Enable tilt" button: ask again (inside the tap), then re-pick the source.
function enableTilt() {
  settings.steerMode = 'tilt';
  state.forceTouch = false;
  saveSettings();
  syncSettingsUI();
  const ask = needsMotionPermission() ? askMotionPermission() : Promise.resolve('unsupported');
  ask.then((r) => {
    if (r !== 'unsupported') setPermissionDenied(r === 'denied');
    if (state.gatePassed) armSensorCheck();
  });
}

let sensorTimer = null;
// Picks the steering source shortly after the gate (or a settings change).
function armSensorCheck() {
  clearTimeout(sensorTimer);
  if (!tiltWanted()) { setSource('touch'); return; }
  const now = performance.now();
  if (now - lastOrientationAt < 300) setSource('orientation');
  sensorTimer = setTimeout(() => {
    const t = performance.now();
    if (!tiltWanted()) return;
    if (t - lastOrientationAt < SENSOR_TIMEOUT_MS) setSource('orientation');
    else if (t - lastMotionAt < SENSOR_TIMEOUT_MS) setSource('motion');
    else {
      setSource('touch');
      toast(state.permissionDenied ? 'Motion access blocked — drag to steer (⚙ explains how to fix it)' : 'No tilt sensor found — drag to steer', 3200);
    }
  }, SENSOR_TIMEOUT_MS);
}

function center(silent = false) {
  if (gravValid && performance.now() - gravAt < 1500) {
    state.calib = clamp(rawAngleDeg, -CALIB_LIMIT_DEG, CALIB_LIMIT_DEG);
  }
  if (!silent) { toast('Steering centered'); haptic(25); }
}

// At the start of each countdown: re-center if the phone is held roughly level.
function autoCenter() {
  if (state.steerSource !== 'orientation' && state.steerSource !== 'motion') return;
  if (!gravValid || performance.now() - gravAt > 1000) return;
  if (Math.abs(rawAngleDeg) > AUTO_CENTER_LIMIT_DEG) return;
  state.calib = rawAngleDeg;
  toast('Wheel centered — get ready!', 1400);
}

// ---------------------------------------------------------------- touch slider

// Pointer offset from the center of `node` along the stage's x axis, which
// the CSS rotation turns sideways on screen.
function stageAxisOffset(e, node) {
  const r = node.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (state.cssRot === 90) return e.clientY - cy;
  if (state.cssRot === -90) return cy - e.clientY;
  return e.clientX - cx;
}
const touchLocalOffset = (e) => stageAxisOffset(e, el.tsTrack);

function measureTrack() {
  if (!trackHalf) trackHalf = Math.max(20, (el.tsTrack.offsetWidth - el.tsKnob.offsetWidth) / 2);
  return trackHalf;
}

function onTrackPointer(e) {
  switch (e.type) {
    case 'pointerdown':
      if (state.steerSource !== 'touch' || touchSteer.pointerId !== null) return;
      e.preventDefault();
      try { el.tsTrack.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      touchSteer.pointerId = e.pointerId;
      touchSteer.value = clamp(touchLocalOffset(e) / measureTrack(), -1, 1);
      break;
    case 'pointermove':
      if (e.pointerId !== touchSteer.pointerId) return;
      touchSteer.value = clamp(touchLocalOffset(e) / measureTrack(), -1, 1);
      break;
    default:   // pointerup / pointercancel / lostpointercapture
      if (e.pointerId !== touchSteer.pointerId) return;
      touchSteer.pointerId = null;
      touchSteer.value = 0;
  }
}

// ---------------------------------------------------------------- buttons

function haptic(pattern) {
  if (!settings.haptics || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch { /* not allowed yet */ }
}

// A press-and-hold button driven by Pointer Events. Tracks its own pointer
// ids so several fingers on different buttons never interfere.
class HoldButton {
  constructor(node, { onPress = null, onRelease = null, buzz = 10 } = {}) {
    this.node = node;
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.buzz = buzz;
    this.pointers = new Set();
    this.down = false;
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'contextmenu']) {
      node.addEventListener(t, this, { passive: false });
    }
  }

  handleEvent(e) {
    switch (e.type) {
      case 'pointerdown':
        if (e.button > 0) return;
        e.preventDefault();
        try { this.node.setPointerCapture(e.pointerId); } catch { /* implicit capture on touch */ }
        this.pointers.add(e.pointerId);
        if (!this.down) this._press();
        break;
      case 'pointerup':
      case 'pointercancel':
      case 'lostpointercapture':
        if (this.pointers.delete(e.pointerId) && this.pointers.size === 0 && this.down) this._release();
        break;
      case 'contextmenu':
        e.preventDefault();
        break;
    }
  }

  _press() {
    this.down = true;
    this.node.classList.add('pressed');
    if (this.buzz) haptic(this.buzz);
    this.onPress?.();
  }

  _release() {
    this.down = false;
    this.node.classList.remove('pressed');
    this.onRelease?.();
  }

  reset() {
    this.pointers.clear();
    if (this.down) this._release();
  }
}

const holdButtons = [];
function holdButton(id, opts) {
  const b = new HoldButton($(id), opts);
  holdButtons.push(b);
  return b;
}

function setButton(name, on) {
  if (state.buttons[name] === on) return;
  state.buttons[name] = on;
  sendInput(false);
}

function releaseAll() {
  for (const b of holdButtons) b.reset();
  touchSteer.pointerId = null;
  touchSteer.value = 0;
}

// Is the phone the controller right now (rather than lying next to a keyboard)?
let lastTouchAt = -1e9;
function padInUse(now) {
  return settings.autoGas || touchSteer.pointerId !== null || holdButtons.some((b) => b.down) || now - lastTouchAt < IN_USE_MS;
}

function raceInProgress() {
  const r = isRaceScreen() && state.host.race;
  return !!r && !r.finished && (r.state === 'intro' || r.state === 'countdown' || r.state === 'racing');
}

// Page hidden (screen lock, app switch, incoming call, tab closed): pause the
// race right away instead of letting it run on until the socket times out.
// pad:menu 'pause' only ever pauses (a pauseSeq press would toggle).
function onPageHidden() {
  if (!state.pageVisible) return;
  state.pageVisible = false;
  if (raceInProgress() && padInUse(performance.now()) && socket && socket.connected && state.joined) {
    socket.emit('pad:menu', { action: 'pause' });
  }
  releaseAll();
  sendInput(false);                  // zeros: nothing stays held while we are away
}

function onPageVisible() {
  if (state.pageVisible) return;
  state.pageVisible = true;
  nextSendAt = 0;
  if (state.gatePassed) requestWakeLock();
  if (socket && !socket.connected) socket.connect();
}

// ---------------------------------------------------------------- input sending

const volatileInput = { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0, t: 0 };
const SEND_SLACK_MS = 4;             // a tick this early still sends (timer jitter)
let nextSendAt = 0;                  // next steady-state (volatile) sample
let sendOnDrain = false;             // a sample was due while the transport was busy
let watchedEngine = null;
let sendWindowStart = 0;
let sendsInWindow = 0;
let sendRate = 0;

const isRaceScreen = () => !!state.host && state.host.screen === 'race';

function countdownRemaining(now) {
  if (!(countdownBase.value > 0) || !countdownBase.at) return Infinity;
  return countdownBase.value - (now - countdownBase.at) / 1000;
}

// Auto-gas: hold the throttle unless braking. During the countdown it waits
// until the middle of the start-boost window, so it never stalls the engine.
function autoGasActive(now) {
  if (!settings.autoGas || state.buttons.brake || !state.pageVisible) return false;
  const rs = state.host?.race?.state;
  if (rs === 'intro') return false;
  if (rs === 'countdown') return countdownRemaining(now) <= START_PRESS_LEAD;
  return true;
}

function fillInput(out) {
  const now = performance.now();
  const active = isRaceScreen() && !state.sheetOpen && state.hostPresent && state.pageVisible;
  const b = state.buttons;
  out.s = state.pageVisible ? Math.round(steer * 1000) / 1000 : 0;
  out.g = active && (b.gas || autoGasActive(now)) ? 1 : 0;
  out.b = active && b.brake ? 1 : 0;
  out.d = active && b.drift ? 1 : 0;
  out.i = state.itemSeq;
  out.p = state.pauseSeq;
  out.t = Date.now();
  return out;
}

// volatile = steady-state sample (may be dropped); otherwise a reliable edge.
function sendInput(volatile) {
  if (!socket || !socket.connected || !state.joined) return;
  if (volatile) {
    const tr = socket.io.engine && socket.io.engine.transport;
    // A stalled WebSocket queues samples in the browser; they would only
    // arrive late, in one burst. Skip until it has drained.
    if (tr && tr.ws && tr.ws.bufferedAmount > 0) return;
    // Busy transport (HTTP long-polling has one POST in flight at a time):
    // Socket.IO would drop a volatile sample, so send a fresh one the moment
    // it is writable again (engine 'drain', see watchEngine).
    if (tr && !tr.writable) { sendOnDrain = true; return; }
    socket.volatile.emit('pad:input', fillInput(volatileInput));
  } else {
    socket.emit('pad:input', fillInput({}));
  }
  const now = performance.now();
  state.sent++;
  sendsInWindow++;
  if (now - sendWindowStart >= 1000) {
    sendRate = Math.round((sendsInWindow * 1000) / (now - sendWindowStart));
    sendWindowStart = now;
    sendsInWindow = 0;
  }
}

// ---------------------------------------------------------------- main tick (60 Hz)

let lastTickAt = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0, (now - lastTickAt) / 1000));
  lastTickAt = now;

  const src = state.steerSource;
  let rate = STEER_LPF_RATE;
  if (src === 'orientation' || src === 'motion') {
    const last = src === 'orientation' ? lastOrientationAt : lastMotionAt;
    steerTarget = now - last < SENSOR_STALE_MS ? steerFromAngle(rawAngleDeg) : 0;
  } else if (src === 'touch') {
    const v = touchSteer.value;
    steerTarget = Math.sign(v) * ((1 - EXPO * 0.6) * Math.abs(v) + EXPO * 0.6 * Math.abs(v) ** 3);
    rate = TOUCH_LPF_RATE;
  } else {
    steerTarget = 0;
  }
  steer = damp(steer, steerTarget, rate, dt);
  if (Math.abs(steer) < 0.0005) steer = 0;

  updateRotation(now);

  if (state.pageVisible && state.joined && socket && socket.connected) {
    const interval = isRaceScreen() ? 1000 / NET.padInputHz : KEEPALIVE_MS;
    if (now >= nextSendAt - SEND_SLACK_MS) {
      sendInput(true);
      // Steady cadence despite timer jitter; no catch-up burst after a stall.
      nextSendAt = Math.max(nextSendAt + interval, now - interval / 2);
    }
  }
}

// ---------------------------------------------------------------- visuals (rAF)

let shownScreen = null;
let lastWheelDeg = NaN;
let lastMeterL = -1;
let lastMeterR = -1;
let lastKnobPx = NaN;
let cdText = null;
let lastDbgAt = 0;
let lastHintOn = null;

function frame(now) {
  requestAnimationFrame(frame);
  if (shownScreen === 'race') {
    const deg = Math.round(steer * WHEEL_VISUAL_DEG * 10) / 10;
    if (deg !== lastWheelDeg) { el.wheel.style.transform = `rotate(${deg}deg)`; lastWheelDeg = deg; }
    const l = Math.round(Math.max(0, -steer) * 500) / 500;
    const r = Math.round(Math.max(0, steer) * 500) / 500;
    if (l !== lastMeterL) { el.tmLeft.style.transform = `scaleX(${l})`; lastMeterL = l; }
    if (r !== lastMeterR) { el.tmRight.style.transform = `scaleX(${r})`; lastMeterR = r; }
    if (state.steerSource === 'touch') {
      const px = Math.round(steer * measureTrack() * 10) / 10;
      if (px !== lastKnobPx) { el.tsKnob.style.transform = `translateX(${px}px)`; lastKnobPx = px; }
    }
    updateCountdown(now);
  }
  if (state.sheetOpen && now - lastDbgAt > 125) { lastDbgAt = now; updateDebug(now); }
  // Held upright in portrait for a moment (not just a hard over-steer).
  const hint = layout.portrait && holdingUpright && now - uprightSince > HINT_DELAY_MS && state.phase !== 'boot';
  if (hint !== lastHintOn) { lastHintOn = hint; toggle(el.hintRotate, 'show', hint); }
}

// Countdown overlay: extrapolates the host's countdown between updates.
const countdownBase = { value: 0, at: 0 };
let goShownAt = -1e9;
let prevRaceState = null;

function updateCountdown(now) {
  const r = state.host && state.host.race;
  let text = '';
  let cls = '';
  if (r) {
    if (r.state === 'intro') { text = 'GET READY'; cls = 'small'; }
    else if (r.state === 'countdown') {
      const rem = countdownRemaining(now);
      if (rem !== Infinity) text = String(clamp(Math.ceil(rem), 1, 3));
    } else if (r.state === 'racing' && now - goShownAt < 900) { text = 'GO!'; cls = 'go'; }
  }
  const key = text + '|' + cls;
  if (key === cdText) return;
  cdText = key;
  el.countdown.textContent = text;
  el.countdown.className = 'countdown';
  if (text) {
    void el.countdown.offsetWidth;   // restart the pop animation
    el.countdown.className = `countdown show${cls ? ' ' + cls : ''}`;
    if (cls !== 'small') haptic(text === 'GO!' ? 70 : 30);
  }
}

// ---------------------------------------------------------------- feedback

let toastTimer = null;
function toast(text, ms = 1800) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function flash() {
  el.flash.classList.remove('on');
  void el.flash.offsetWidth;
  el.flash.classList.add('on');
}

// ---------------------------------------------------------------- networking

let socket = null;
let helloTimer = null;
let helloInFlight = false;
let retryUntil = 0;

function connectSocket() {
  if (typeof window.io !== 'function') {
    state.serverMissing = true;
    render();
    return;
  }
  socket = window.io({ reconnectionDelay: 500, reconnectionDelayMax: 2000, timeout: 6000 });
  socket.io.on('open', watchEngine);
  socket.on('connect', () => {
    state.socketConnected = true;
    state.connectErrors = 0;
    watchEngine();
    if (state.room) hello();
    render();
  });
  socket.on('disconnect', (reason) => {
    state.socketConnected = false;
    state.joined = false;
    helloInFlight = false;
    releaseAll();
    render();
    // Socket.IO only auto-reconnects after network-level drops; a disconnect
    // initiated by the server (e.g. it is restarting) needs a manual retry.
    if (reason === 'io server disconnect') setTimeout(() => { if (!socket.connected) socket.connect(); }, 1000);
  });
  // Repeated failures while this page is loaded: the server is gone, or it made
  // a new certificate the phone has not accepted yet (render() then suggests a reload).
  socket.on('connect_error', () => { state.socketConnected = false; state.connectErrors++; render(); });
  socket.on('host:state', onHostState);
  socket.on('host:event', onHostEvent);
  socket.on('host:leave', () => { state.hostPresent = false; releaseAll(); render(); });
  socket.on('host:join', () => { state.hostPresent = true; render(); });
  socket.on('pad:kicked', () => {
    state.kicked = true;
    state.joined = false;
    releaseAll();
    render();
  });
  socket.on('room:closed', () => {
    state.joined = false;
    state.everJoined = false;
    state.host = null;
    releaseAll();
    state.roomError = 'That game room closed. Scan the new QR code or type its room code.';
    retryUntil = Date.now() + 120000;
    scheduleHello(3000);
    enterCode(state.room || '');
  });
}

// Each (re)connect gets a new engine: send the pending sample when its
// transport finishes a write.
function watchEngine() {
  const eng = socket && socket.io && socket.io.engine;
  if (!eng || eng === watchedEngine) return;
  watchedEngine = eng;
  eng.on('drain', () => {
    if (!sendOnDrain || eng !== watchedEngine) return;
    sendOnDrain = false;
    if (state.pageVisible && isRaceScreen()) sendInput(true);
  });
}

const transportName = () => (socket && socket.io && socket.io.engine && socket.io.engine.transport ? socket.io.engine.transport.name : 'none');

function scheduleHello(ms) {
  clearTimeout(helloTimer);
  helloTimer = setTimeout(hello, ms);
}

function hello() {
  clearTimeout(helloTimer);
  if (!socket || !socket.connected || !state.room || helloInFlight) return;
  helloInFlight = true;
  const room = state.room;
  socket.timeout(4000).emit('pad:hello', { room, id: clientId }, (err, res) => {
    helloInFlight = false;
    if (room !== state.room) { hello(); return; }       // code changed meanwhile
    if (err) { scheduleHello(1500); render(); return; }
    if (res && res.ok) onJoined(res);
    else onHelloError(res || {});
  });
}

function onJoined(res) {
  state.joined = true;
  state.everJoined = true;
  state.kicked = false;
  state.roomError = '';
  state.hostPresent = !!res.hostConnected;
  retryUntil = 0;
  if (state.phase === 'code') state.phase = state.gatePassed ? 'live' : 'gate';
  sendInput(false);
  render();
}

function onHelloError(res) {
  state.joined = false;
  if (res.code === 'rate') { scheduleHello(1200); return; }
  if (res.code === 'no_room' && state.everJoined) {
    // The game is restarting (server or desktop reload): keep waiting quietly.
    state.hostPresent = false;
    scheduleHello(2000);
    render();
    return;
  }
  state.roomError = res.code === 'no_room'
    ? `Room ${state.room} isn't open. Check the code on the big screen.`
    : res.error || 'Could not join that room.';
  if (res.code === 'no_room') {
    if (!retryUntil) retryUntil = Date.now() + 120000;
    if (Date.now() < retryUntil) scheduleHello(3000);
  }
  enterCode(state.room || '');
}

function onHostState(s) {
  if (!s || typeof s !== 'object') return;
  state.host = s;
  state.hostPresent = true;
  const r = (s.screen === 'race' || s.screen === 'paused') && s.race ? s.race : null;
  const rs = r ? r.state : null;
  const now = performance.now();
  if (rs === 'countdown') {
    const v = Number(r.countdown) || 0;
    if (v !== countdownBase.value || prevRaceState !== 'countdown') { countdownBase.value = v; countdownBase.at = now; }
  }
  if (s.screen === 'race' && rs === 'countdown' && prevRaceState !== 'countdown') autoCenter();
  if (rs === 'racing' && prevRaceState === 'countdown') goShownAt = now;
  prevRaceState = rs;
  render();
}

function onHostEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'vibrate' && Array.isArray(ev.pattern)) { haptic(ev.pattern); flash(); }
  else if (ev.type === 'toast' && typeof ev.text === 'string') toast(ev.text);
}

function sendMenu(action, extra = null) {
  if (!socket || !socket.connected || !state.joined) { toast('Not connected to the game'); return false; }
  socket.emit('pad:menu', extra ? { action, ...extra } : { action });
  haptic(12);
  return true;
}

function startPing() {
  setInterval(() => {
    if (!socket || !socket.connected) { state.rttMs = null; return; }
    const t0 = performance.now();
    socket.timeout(1500).emit('net:ping', 0, (err) => {
      state.rttMs = err ? null : Math.round(performance.now() - t0);
      renderConn();
    });
  }, PING_MS);
}

// ---------------------------------------------------------------- rendering

function currentScreen() {
  if (state.phase === 'insecure' || state.phase === 'code' || state.phase === 'gate') return state.phase;
  if (state.phase !== 'live') return 'connecting';
  if (!state.host || (!state.joined && !state.everJoined)) return 'connecting';
  return HOST_SCREENS.has(state.host.screen) ? state.host.screen : 'loading';
}

function showScreen(name) {
  if (name === shownScreen) return;
  const prev = shownScreen;
  shownScreen = name;
  for (const [key, sec] of Object.entries(screens)) toggle(sec, 'active', key === name);
  el.stage.dataset.screen = name;
  if (prev === 'race') { releaseAll(); cdText = null; }
  if (name === 'race') { lastWheelDeg = NaN; lastMeterL = -1; lastMeterR = -1; lastKnobPx = NaN; trackHalf = 0; }
  if (name === 'select' || name === 'results') refreshScrollHints();
}

function render() {
  const name = currentScreen();
  showScreen(name);
  renderConn();
  const live = state.phase === 'live';
  // "Waiting for the game": the desktop left, or our room vanished (server
  // restart) and we keep re-joining until the desktop re-creates it.
  const waiting = live && state.everJoined && state.socketConnected && !state.kicked &&
    (state.joined ? !state.hostPresent : !helloInFlight);
  toggle(el.ovWaiting, 'show', waiting);
  toggle(el.ovKicked, 'show', state.kicked && state.phase !== 'code');
  toggle(el.bannerOffline, 'show', live && state.everJoined && !state.socketConnected);
  const stuck = reconnectStuck();
  toggle(el.bannerOffline, 'stuck', stuck);
  setText(el.offlineText, stuck ? "Can't reconnect. If the game is still running, reload this page (accept the certificate warning again)." : 'Reconnecting…');
  toggle(el.stage, 'auto-gas', settings.autoGas);
  if (name === 'connecting') renderConnecting();
  else if (name === 'select') renderSelect();
  else if (name === 'race' || name === 'paused') renderRace();
  else if (name === 'results') renderResults();
}

const reconnectStuck = () => !state.socketConnected && state.connectErrors >= RELOAD_HINT_ERRORS;

function renderConn() {
  const ok = state.socketConnected && state.joined && state.hostPresent;
  const cls = ok ? 'dot ok' : state.socketConnected ? 'dot wait' : 'dot';
  if (el.connDot.className !== cls) el.connDot.className = cls;
  setText(el.roomLabel, state.room || '----');
  setText(el.pingLabel, ok && state.rttMs != null ? `${state.rttMs}ms` : '');

  let text;
  if (state.serverMissing) text = "Can't reach the game server";
  else if (reconnectStuck()) text = "Can't reach the game — reload this page";
  else if (!state.socketConnected) text = 'Connecting to the game…';
  else if (state.joined && state.hostPresent) text = `Connected · room ${state.room}`;
  else if (state.joined) text = `Room ${state.room} · waiting for the game`;
  else text = `Joining room ${state.room || '…'}…`;
  setText(el.gateStatusText, text);
  const gdot = el.gateStatus.firstElementChild;
  if (gdot.className !== cls) gdot.className = cls;
}

function renderConnecting() {
  if (state.serverMissing) {
    setText(el.connectingTitle, "Can't reach the game");
    setText(el.connectingSub, 'Make sure TOOT KART is running on the computer, then reload this page.');
  } else if (reconnectStuck()) {
    setText(el.connectingTitle, "Can't reach the game");
    setText(el.connectingSub, 'If it is still running on the computer, reload this page and accept the certificate warning again.');
  } else if (!state.socketConnected) {
    setText(el.connectingTitle, 'Connecting…');
    setText(el.connectingSub, 'Looking for the game on your Wi-Fi');
  } else if (!state.joined) {
    setText(el.connectingTitle, 'Joining…');
    setText(el.connectingSub, `Room ${state.room || ''}`);
  } else {
    setText(el.connectingTitle, 'Connected!');
    setText(el.connectingSub, 'Waiting for the game screen…');
  }
}

// ---- character select

let selectKey = '';
let pendingSelect = null;
let pendingSelectAt = 0;
let pendingDiff = null;
let pendingDiffAt = 0;

function buildCharacterCards(chars) {
  const frag = document.createDocumentFragment();
  chars.forEach((ch, i) => {
    const card = document.createElement('button');
    card.className = 'char-card';
    card.dataset.index = String(i);
    card.style.setProperty('--c', typeof ch.cssColor === 'string' ? ch.cssColor : '#8890b5');
    const sw = document.createElement('span');
    sw.className = 'cc-swatch';
    const emoji = CHAR_EMOJI[ch.id];
    const inner = document.createElement('span');
    inner.className = emoji ? 'cc-emoji' : 'cc-letter';
    inner.textContent = emoji || String(ch.name || '?').slice(0, 1).toUpperCase();
    sw.appendChild(inner);
    const name = document.createElement('span');
    name.className = 'cc-name';
    name.textContent = String(ch.name || ch.id || `Racer ${i + 1}`);
    card.append(sw, name);
    frag.appendChild(card);
  });
  el.charGrid.replaceChildren(frag);
  refreshScrollHints();
}

function renderSelect() {
  const s = state.host;
  const title = document.querySelector('#scr-select .screen-title');
  if(title) title.textContent = s.setupTitle || 'Choose your racer';
  const go = document.querySelector('#btn-go');
  if(go) go.textContent = s.setupReady ? 'Ready ✓' : 'Confirm →';
  el.diffSeg.hidden = !!s.setupTitle;
  document.getElementById('btn-customize').hidden = true;
  const chars = Array.isArray(s.characters) ? s.characters : [];
  const key = JSON.stringify(chars);
  if (key !== selectKey) { selectKey = key; buildCharacterCards(chars); }
  const now = performance.now();
  if (pendingSelect !== null && (s.selected === pendingSelect || now - pendingSelectAt > 1500)) pendingSelect = null;
  if (pendingDiff !== null && (s.difficulty === pendingDiff || now - pendingDiffAt > 1500)) pendingDiff = null;
  const sel = pendingSelect ?? s.selected;
  for (const card of el.charGrid.children) {
    const i = Number(card.dataset.index);
    toggle(card, 'selected', i === sel);
    toggle(card, 'pending', pendingSelect !== null && i === pendingSelect);
  }
  const diff = pendingDiff ?? s.difficulty;
  for (const b of el.diffSeg.children) toggle(b, 'on', b.dataset.diff === diff);
}

// ---- race

let rollTimer = null;
let rollIndex = 0;

function startRoll() {
  if (rollTimer) return;
  rollTimer = setInterval(() => {
    rollIndex = (rollIndex + 1) % ITEM_IDS.length;
    el.itemIcon.textContent = ITEM_INFO[ITEM_IDS[rollIndex]].icon;
    el.itemIcon._text = null;
  }, 85);
}
function stopRoll() {
  clearInterval(rollTimer);
  rollTimer = null;
}

function renderRace() {
  const r = state.host.race || {};
  let beerStatus=document.getElementById('beer-status');
  if(!beerStatus){beerStatus=document.createElement('div');beerStatus.id='beer-status';beerStatus.className='beer-status';document.getElementById('scr-race').append(beerStatus);}
  beerStatus.hidden=!(r.drunkSeconds>0);
  beerStatus.textContent=`🍺 Wobbly steering · ${Math.ceil(r.drunkSeconds||0)}s`;

  const place = Number(r.place) || 0;
  const racers = Number(r.racers) || 0;
  if (place > 0) {
    const ord = ordinal(place);
    setText(el.placeNum, String(place));
    setText(el.placeSuf, ord.slice(String(place).length));
    setText(el.placeOf, racers ? `/${racers}` : '');
  } else {
    setText(el.placeNum, '–');
    setText(el.placeSuf, '');
    setText(el.placeOf, '');
  }
  toggle(el.place, 'p1', place === 1);
  toggle(el.place, 'p2', place === 2);
  toggle(el.place, 'p3', place === 3);
  const laps = Math.max(1, Number(r.laps) || RACE.laps);
  setText(el.lapNum, String(clamp(Number(r.lap) || 1, 1, laps)));
  setText(el.lapTotal, String(laps));

  const item = r.item && ITEM_INFO[r.item] ? r.item : null;
  const rolling = !!r.rolling;
  const count = item ? Math.max(1, Number(r.itemCount) || 1) : 0;
  toggle(el.btnItem, 'rolling', rolling);
  toggle(el.btnItem, 'empty', !rolling && !item);
  toggle(el.btnItem, 'ready', !!item && !rolling);
  toggle(el.btnItem, 'has-count', count > 1 && !rolling);
  if (rolling) startRoll();
  else { stopRoll(); setText(el.itemIcon, item ? ITEM_INFO[item].icon : ''); }
  setText(el.itemCount, count > 1 ? String(count) : '');

  const finished = !!r.finished;
  if (finished !== el.finish.classList.contains('show') || (finished && el.finish._place !== place)) {
    el.finish._place = place;
    el.finish.replaceChildren();
    if (finished) {
      const t = document.createElement('div');
      t.className = 'fb-title';
      t.textContent = 'FINISH!';
      const p = document.createElement('div');
      p.className = 'fb-place';
      p.textContent = place > 0 ? ordinal(place) : '';
      el.finish.append(t, p);
    }
    toggle(el.finish, 'show', finished);
  }
}

// ---- results

let resultsKey = '';
function renderResults() {
  const list = Array.isArray(state.host.results) ? state.host.results.slice() : [];
  const key = JSON.stringify(list);
  if (key === resultsKey) return;
  resultsKey = key;
  list.sort((a, b) => (a.place || 99) - (b.place || 99));
  const frag = document.createDocumentFragment();
  let me = null;
  for (const r of list) {
    const li = document.createElement('li');
    if (r.isPlayer) { li.className = 'me'; me = r; }
    const place = document.createElement('span');
    place.className = `st-place${r.place >= 1 && r.place <= 3 ? ` p${r.place}` : ''}`;
    place.textContent = r.place ? ordinal(r.place) : '–';
    const sw = document.createElement('span');
    sw.className = 'st-swatch';
    sw.style.background = typeof r.cssColor === 'string' ? r.cssColor : '#8890b5';
    const name = document.createElement('span');
    name.className = 'st-name';
    name.textContent = `${r.name || '???'}${r.isPlayer ? ' (you)' : ''}`;
    const time = document.createElement('span');
    time.className = 'st-time';
    // Racers still on track when the results appear get an estimated time.
    const estimated = r.finished === false;
    time.textContent = Number.isFinite(r.time) ? `${estimated ? '~' : ''}${formatTime(r.time)}` : estimated ? 'DNF' : '--:--.---';
    if (estimated) time.classList.add('est');
    li.append(place, sw, name, time);
    frag.appendChild(li);
  }
  el.standings.replaceChildren(frag);
  refreshScrollHints();
  setText(el.resTitle, me && me.place ? `YOU FINISHED ${ordinal(me.place).toUpperCase()}!` : 'RESULTS');
}

// ---- room code entry

let codeBuf = '';

function buildKeypad() {
  const frag = document.createDocumentFragment();
  for (const ch of ROOM_ALPHABET) {
    const k = document.createElement('button');
    k.className = 'key';
    k.dataset.k = ch;
    k.textContent = ch;
    frag.appendChild(k);
  }
  const back = document.createElement('button');
  back.className = 'key back';
  back.dataset.k = 'back';
  back.setAttribute('aria-label', 'Delete');
  back.textContent = '⌫';
  frag.appendChild(back);
  el.keypad.replaceChildren(frag);
  el.keypad.addEventListener('click', (e) => {
    const k = e.target.closest('.key');
    if (k) typeKey(k.dataset.k);
  });
}

function typeKey(k) {
  if (k === 'back') codeBuf = codeBuf.slice(0, -1);
  else if (codeBuf.length < ROOM_CODE_LENGTH && ROOM_ALPHABET.includes(k)) codeBuf += k;
  else return;
  haptic(8);
  state.roomError = '';
  renderCode();
  if (codeBuf.length === ROOM_CODE_LENGTH) submitCode();
}

function renderCode() {
  const slots = el.codeSlots.children;
  for (let i = 0; i < slots.length; i++) {
    setText(slots[i], codeBuf[i] || '');
    toggle(slots[i], 'filled', i < codeBuf.length);
    toggle(slots[i], 'cursor', i === codeBuf.length);
  }
  el.codeJoin.disabled = codeBuf.length !== ROOM_CODE_LENGTH;
  setText(el.codeError, state.roomError);
}

function submitCode() {
  const code = normalizeRoomCode(codeBuf);
  if (!code) { state.roomError = 'Room codes are 4 letters.'; renderCode(); return; }
  state.room = code;
  state.roomError = '';
  retryUntil = 0;
  try { history.replaceState(null, '', `${location.pathname}?room=${code}`); } catch { /* ignore */ }
  setText(el.codeError, socket && socket.connected ? 'Joining…' : 'Connecting…');
  hello();
  renderConn();
}

function enterCode(prefill) {
  state.phase = 'code';
  codeBuf = normalizeRoomCode(prefill || '') || '';
  renderCode();
  render();
}

// ---- settings sheet

// Sensitivity slider: a pointer-driven control instead of <input type=range>,
// which cannot be dragged once the stage is CSS-rotated (the native control
// only follows the unrotated screen axis). Left = calm (full lock at 50°),
// right = twitchy (18°).
const sensSlider = { pointerId: null };

function renderSens() {
  const pos = (LOCK_MAX_DEG - settings.lockDeg) / (LOCK_MAX_DEG - LOCK_MIN_DEG);
  el.sens.style.setProperty('--pos', pos.toFixed(4));
  el.sens.setAttribute('aria-valuenow', String(LOCK_MIN_DEG + LOCK_MAX_DEG - settings.lockDeg));
  el.sens.setAttribute('aria-valuetext', `full lock at ${settings.lockDeg}°`);
  setText(el.sensVal, `full lock at ${settings.lockDeg}°`);
}

function setLockDeg(deg) {
  const v = clamp(Math.round(deg), LOCK_MIN_DEG, LOCK_MAX_DEG);
  if (v === settings.lockDeg) return;
  settings.lockDeg = v;
  renderSens();
  saveSettings();
}

function onSensPointer(e) {
  switch (e.type) {
    case 'pointerdown':
      if (e.button > 0 || sensSlider.pointerId !== null) return;
      e.preventDefault();
      try { el.sens.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      sensSlider.pointerId = e.pointerId;
      toggle(el.sens, 'active', true);
      break;
    case 'pointermove':
      if (e.pointerId !== sensSlider.pointerId) return;
      break;
    default:   // pointerup / pointercancel / lostpointercapture
      if (e.pointerId === sensSlider.pointerId) { sensSlider.pointerId = null; toggle(el.sens, 'active', false); }
      return;
  }
  const len = Math.max(1, el.sens.offsetWidth);       // unrotated length
  const pos = clamp(0.5 + stageAxisOffset(e, el.sens) / len, 0, 1);
  setLockDeg(LOCK_MAX_DEG - pos * (LOCK_MAX_DEG - LOCK_MIN_DEG));
}

function onSensKey(e) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? 1 : 0;
  if (!step) return;
  e.preventDefault();
  setLockDeg(settings.lockDeg + step);
}

function syncSettingsUI() {
  renderSens();
  el.setAutoGas.checked = settings.autoGas;
  el.setInvert.checked = settings.invert;
  el.setHaptics.checked = settings.haptics;
  const mode = tiltWanted() ? 'tilt' : 'touch';
  for (const b of el.modeSeg.children) toggle(b, 'on', b.dataset.mode === mode);
  toggle(el.stage, 'auto-gas', settings.autoGas);
}

function openSheet() {
  releaseAll();
  state.sheetOpen = true;
  syncSettingsUI();
  el.sheet.classList.add('open');
  el.sheet.setAttribute('aria-hidden', 'false');
  refreshScrollHints();
}

function closeSheet() {
  state.sheetOpen = false;
  el.sheet.classList.remove('open');
  el.sheet.setAttribute('aria-hidden', 'true');
}

// Events-per-second meters for the debug readout.
const rateMeters = { orientation: { n: 0, t: 0, rate: 0 }, motion: { n: 0, t: 0, rate: 0 } };
function eventRate(meter, count, now) {
  if (now - meter.t >= 1000) {
    meter.rate = meter.t ? Math.round(((count - meter.n) * 1000) / (now - meter.t)) : 0;
    meter.n = count;
    meter.t = now;
  }
  return meter.rate;
}

function updateDebug(now) {
  const src = state.steerSource;
  const oRate = eventRate(rateMeters.orientation, orientationEvents, now);
  const mRate = eventRate(rateMeters.motion, motionEvents, now);
  const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
  el.dbg.textContent =
    `source   ${src}${src === 'orientation' ? ` (${oRate}/s)` : src === 'motion' ? ` (${mRate}/s)` : ''}\n` +
    `tilt     ${rawAngleDeg.toFixed(1)}°   center ${state.calib.toFixed(1)}°\n` +
    `steer    ${f(steer)}\n` +
    `screen   ${uiAngle()}° (os ${osAngle()}°${osFlip ? ' flipped' : ''}, css ${state.cssRot}°)\n` +
    `gravity  ${gravValid ? `${grav.x.toFixed(2)} ${grav.y.toFixed(2)} ${grav.z.toFixed(2)}` : 'n/a'}\n` +
    `network  ${state.socketConnected ? (state.rttMs != null ? `${state.rttMs} ms` : 'up') : 'down'} · ${sendRate} msg/s · ${linkLabel()}`;
}

// Socket.IO starts on HTTP long-polling and upgrades to a WebSocket. Staying on
// polling (upgrade refused) caps steering at about one sample per round trip.
function linkLabel() {
  const t = transportName();
  return t === 'polling' ? 'polling (slow: no WebSocket)' : t;
}

// ---------------------------------------------------------------- gate (permissions etc.)

const needsMotionPermission = () =>
  (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') ||
  (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function');

let wakeLock = null;
async function requestWakeLock() {
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not supported / not allowed */ }
}

function lockLandscape() {
  try {
    const p = window.screen.orientation && window.screen.orientation.lock && window.screen.orientation.lock('landscape');
    if (p && p.catch) p.catch(() => {});
  } catch { /* unsupported */ }
}

function requestFullscreenAndLock() {
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || document.webkitFullscreenElement) { lockLandscape(); return; }
  try {
    const p = req.call(root, { navigationUI: 'hide' });
    if (p && p.then) p.then(lockLandscape, () => {});
    else lockLandscape();
  } catch { /* iPhone Safari has no element fullscreen */ }
}

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const canFullscreen = () => {
  const root = document.documentElement;
  return !!(root.requestFullscreen || root.webkitRequestFullscreen) && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? true) !== false;
};
let fullscreenWanted = false;        // we went fullscreen at the gate (Android): keep it that way
let lastFullscreenTry = -1e9;

// Android drops fullscreen and the landscape lock after an app switch or the
// back gesture, which leaves a phone with auto-rotate off in the CSS-rotated
// portrait layout. Re-enter on the next tap: it needs a user gesture, and for
// touch that is pointerup, not pointerdown.
function restoreFullscreen() {
  if (!fullscreenWanted || fullscreenElement() || !state.pageVisible) return;
  const t = performance.now();
  if (t - lastFullscreenTry < 1500) return;
  lastFullscreenTry = t;
  requestFullscreenAndLock();
}

function onGateTap() {
  // iOS: requestPermission() must be called synchronously inside the gesture.
  const ask = askMotionPermission();
  fullscreenWanted = canFullscreen();
  lastFullscreenTry = performance.now();
  requestFullscreenAndLock();
  requestWakeLock();
  haptic(20);
  state.gatePassed = true;
  state.phase = 'live';
  render();
  ask.then((r) => {
    setPermissionDenied(r === 'denied');
    armSensorCheck();
  });
}

// ---------------------------------------------------------------- wiring

function wireUi() {
  // Race controls
  holdButton('btn-gas', { onPress: () => setButton('gas', true), onRelease: () => setButton('gas', false) });
  holdButton('btn-brake', { onPress: () => setButton('brake', true), onRelease: () => setButton('brake', false) });
  holdButton('btn-drift', { onPress: () => setButton('drift', true), onRelease: () => setButton('drift', false) });
  holdButton('btn-item', {
    buzz: 18,
    onPress: () => { state.itemSeq++; state.buttons.item = true; sendInput(false); },
    onRelease: () => { state.buttons.item = false; },
  });
  holdButton('btn-pause', {
    onPress: () => {
      if (!isRaceScreen()) return;
      state.pauseSeq++;
      sendInput(false);
    },
  });
  holdButton('btn-center', { buzz: 0, onPress: () => center(false) });

  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    el.tsTrack.addEventListener(t, onTrackPointer, { passive: false });
  }

  // Menus
  document.addEventListener('click', (e) => {
    const m = e.target.closest('[data-menu]');
    if (m) { sendMenu(m.dataset.menu); return; }
    const card = e.target.closest('.char-card');
    if (card) {
      const index = Number(card.dataset.index);
      if (sendMenu('select', { index })) { pendingSelect = index; pendingSelectAt = performance.now(); renderSelect(); }
      return;
    }
    const d = e.target.closest('#diff-seg button');
    if (d) {
      if (sendMenu('difficulty', { value: d.dataset.diff })) { pendingDiff = d.dataset.diff; pendingDiffAt = performance.now(); renderSelect(); }
    }
  });

  // Difficulty segmented control (labels from config)
  const frag = document.createDocumentFragment();
  for (const [key, def] of Object.entries(DIFFICULTY)) {
    const b = document.createElement('button');
    b.dataset.diff = key;
    b.textContent = String(def.label || key).toUpperCase();
    frag.appendChild(b);
  }
  el.diffSeg.replaceChildren(frag);

  // Gate / code / insecure / kicked
  $('btn-gate').addEventListener('click', onGateTap);
  el.codeJoin.addEventListener('click', submitCode);
  $('btn-insecure-touch').addEventListener('click', () => {
    state.forceTouch = true;
    proceedFromBoot();
  });
  $('btn-reclaim').addEventListener('click', () => {
    state.kicked = false;
    render();
    hello();
  });

  // Settings
  $('btn-settings').addEventListener('click', openSheet);
  $('btn-sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('btn-sheet-center').addEventListener('click', () => center(false));
  $('btn-enable-tilt').addEventListener('click', enableTilt);
  $('btn-reload').addEventListener('click', () => location.reload());
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    el.sens.addEventListener(t, onSensPointer, { passive: false });
  }
  el.sens.addEventListener('keydown', onSensKey);
  el.setAutoGas.addEventListener('change', () => { settings.autoGas = el.setAutoGas.checked; saveSettings(); syncSettingsUI(); });
  el.setInvert.addEventListener('change', () => { settings.invert = el.setInvert.checked; saveSettings(); });
  el.setHaptics.addEventListener('change', () => { settings.haptics = el.setHaptics.checked; saveSettings(); haptic(30); });
  el.modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    if (b.dataset.mode === 'tilt') { enableTilt(); return; }   // asks for motion access again (iOS)
    settings.steerMode = b.dataset.mode;
    saveSettings();
    syncSettingsUI();
    renderSteerMode();
    if (state.gatePassed) armSensorCheck();
  });

  // Physical keyboard on the code screen (handy on tablets / desktop tests)
  window.addEventListener('keydown', (e) => {
    if (state.phase !== 'code') return;
    if (e.key === 'Backspace') typeKey('back');
    else if (e.key === 'Enter') submitCode();
    else if (/^[a-z]$/i.test(e.key)) typeKey(e.key.toUpperCase());
  });

  // No scrolling, zooming, selection or callouts anywhere except lists.
  document.addEventListener('touchmove', (e) => {
    if (!e.target.closest || !e.target.closest('.scroll')) e.preventDefault();
  }, { passive: false });
  for (const t of ['gesturestart', 'gesturechange', 'dblclick', 'contextmenu', 'selectstart']) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  for (const list of scrollLists()) {
    list.addEventListener('scroll', () => updateScrollHint(list), { passive: true });
  }

  // Layout + orientation changes
  const relayout = () => { applyLayout(true); refreshScrollHints(); };
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', () => setTimeout(relayout, 60));
  window.screen.orientation?.addEventListener?.('change', relayout);
  window.visualViewport?.addEventListener('resize', relayout);

  // Sensors are always listened to (gravity also picks the CSS rotation side).
  window.addEventListener('deviceorientation', onDeviceOrientation);
  window.addEventListener('devicemotion', onDeviceMotion);

  // Hidden mid-race → pause the game; never leave a button stuck down.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onPageHidden();
    else onPageVisible();
  });
  window.addEventListener('pagehide', onPageHidden);
  window.addEventListener('pageshow', () => { if (document.visibilityState !== 'hidden') onPageVisible(); });
  window.addEventListener('blur', releaseAll);

  // "Is the phone in use?" (see padInUse) + fullscreen recovery on the next tap.
  const touched = () => { lastTouchAt = performance.now(); };
  document.addEventListener('pointerdown', touched, true);
  document.addEventListener('pointerup', () => { touched(); restoreFullscreen(); }, true);
  for (const t of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(t, relayout);
}

function proceedFromBoot() {
  if (state.room) {
    state.phase = 'gate';
    render();
  } else {
    enterCode('');
  }
}

function boot() {
  buildKeypad();
  wireUi();
  applyLayout(true);
  setSource('none');
  toggle(el.gatePerm, 'show', needsMotionPermission());
  syncSettingsUI();

  state.room = normalizeRoomCode(new URLSearchParams(location.search).get('room') || '');
  connectSocket();

  if (window.isSecureContext === false) {
    state.phase = 'insecure';
    const fallback = location.href.replace(/^http:/, 'https:');
    el.insecureLink.href = fallback;
    fetch('/api/info').then((r) => r.json()).then((info) => {
      if (info && Number.isInteger(info.httpsPort)) {
        el.insecureLink.href = `https://${location.hostname}:${info.httpsPort}${location.pathname}${location.search}`;
      }
    }).catch(() => {});
    render();
  } else {
    proceedFromBoot();
  }

  setInterval(tick, 1000 / 60);
  requestAnimationFrame(frame);
  startPing();
}

// ---------------------------------------------------------------- test hook

window.__pad = {
  get steer() { return steer; },
  get rawAngleDeg() { return rawAngleDeg; },
  get uiAngle() { return uiAngle(); },
  get steerTarget() { return steerTarget; },
  get osFlip() { return osFlip; },
  get transport() { return transportName(); },
  get sendRate() { return sendRate; },
  state,
  settings,
  center,
  setSource,
  math: { upFromOrientation, toScreen, rawAngleFromUp, angleFromScreenUp, shapeSteer, DEAD_ZONE_DEG, EXPO, WHEEL_M0, WHEEL_M1 },
};

boot();
