// End-to-end tests for the phone controller (public/pad.html + pad.js) in
// headless Chrome with phone emulation, against the real server and a fake
// desktop host (tools/pad-host.mjs).
//
//   node tools/pad-test.mjs [--out <dir>] [--no-spawn] [--only L90,L270,P0,extra]
//
// Per orientation (landscape at screen angle 90 and 270, and a portrait
// layout that pad.js rotates with CSS) it simulates a phone held like a wheel
// (synthetic deviceorientation events), checks the steering sign and size,
// drives every menu through real touch input, presses GAS/DRIFT/ITEM/BRAKE
// with multi-touch and verifies what the host receives, and screenshots every
// screen. Extra scenarios: devicemotion fallback (iOS + Android sign
// conventions), touch-slider fallback, room-code entry, kick/reclaim, desktop
// leaving, and a full server restart.
//
// Prints PASS/FAIL per check; exits non-zero on any failure or page error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { io as ioClient } from 'socket.io-client';
import { startFakeHost } from './pad-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3103;
const HTTPS_PORT = 3544;
const ROOM = 'PADT';
const PAD_URL = `https://localhost:${HTTPS_PORT}/pad?room=${ROOM}`;
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'tootkart-pad-shots')));
const ONLY = opt('only', 'L90,L270,P0,extra').split(',');
const spawnServer = !argv.includes('--no-spawn');
fs.mkdirSync(OUT, { recursive: true });

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let pageErrors = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : JSON.stringify(v));

// Expected steering angle θ (deg) for world-up (ux, uy) in the UI frame
// (mirrors pad.js angleFromScreenUp): the in-plane wheel angle while held
// upright-ish, blending into the flat-phone roll angle asin(−ux) as the
// in-plane gravity m drops from 0.6 to 0.35.
function expectedTheta(ux, uy) {
  const D = Math.PI / 180;
  const flat = Math.asin(Math.max(-1, Math.min(1, -ux))) / D;
  const m = Math.hypot(ux, uy);
  if (m <= 0.35 || uy <= 0) return flat;
  const sm = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
  const w = sm((m - 0.35) / 0.25) * sm(uy / (m * 0.25));
  return w * Math.atan2(-ux, uy) / D + (1 - w) * flat;
}

// Pad steering for an angle (dead zone 3.5°, lock 45°, expo 0.52).
function shapedSteer(theta, lockDeg = 45) {
  const mag = Math.abs(theta);
  if (mag <= 3.5) return 0;
  let x = Math.min(1, (mag - 3.5) / (lockDeg - 3.5));
  x = 0.48 * x + 0.52 * x * x * x;
  return Math.sign(theta) * x;
}

// Expected pad steering for a wheel rotated phiDeg clockwise with the screen
// tilted back tauDeg.
function expectedSteer(phiDeg, tauDeg, calibDeg = 0, lockDeg = 45) {
  const D = Math.PI / 180;
  const c = Math.cos(tauDeg * D);
  return shapedSteer(expectedTheta(-Math.sin(phiDeg * D) * c, Math.cos(phiDeg * D) * c) - calibDeg, lockDeg);
}

async function waitUntil(fn, ms = 3000, every = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(every);
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ------------------------------------------------------------------ server

let server = null;
let serverLog = '';
function startServer() {
  serverLog = '';
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
}
async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (server && server.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
    if (!server || serverLog.includes('Desktop game')) {
      try { return await getJson(`https://localhost:${HTTPS_PORT}/api/info`); } catch { /* not yet */ }
    }
    await sleep(150);
  }
  throw new Error(`server did not start\n${serverLog}`);
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGTERM');
  await new Promise((r) => { if (s.exitCode !== null) r(); else s.once('exit', r); });
}

// ------------------------------------------------------------------ page helpers

// Injected before the page scripts: a simulated phone held like a wheel.
//   __tilt.start(a)   a = how the phone is held: 90 = rotated counter-clockwise
//                     from portrait (top to the left), 270 = clockwise, 0 = portrait
//   __tilt.set(phi, tau)  phi = wheel rotation (clockwise +), tau = screen tilted back
//   __tilt.motion(convention)  'ios' | 'android' → send devicemotion instead
function tiltSim() {
  const D = Math.PI / 180;
  const sim = { a: 90, phi: 0, tau: 15, raw: null, timer: null, mode: 'orientation', convention: 'android', sent: 0 };
  function up() {
    // World up in the held phone's UI frame (x right, y up, z out of the screen)...
    let ux = -Math.sin(sim.phi * D) * Math.cos(sim.tau * D);
    let uy = Math.cos(sim.phi * D) * Math.cos(sim.tau * D);
    let uz = Math.sin(sim.tau * D);
    if (sim.raw) [ux, uy, uz] = sim.raw;
    // ...rotated into device coordinates (natural portrait frame).
    const a = sim.a * D;
    return { x: ux * Math.cos(a) + uy * Math.sin(a), y: -ux * Math.sin(a) + uy * Math.cos(a), z: uz };
  }
  function fire() {
    const u = up();
    sim.sent++;
    if (sim.mode === 'orientation') {
      const beta = Math.asin(u.y) / D;
      const gamma = Math.atan2(-u.x, u.z) / D;
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta, gamma, absolute: false }));
    } else {
      const k = sim.convention === 'ios' ? -9.81 : 9.81;
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: k * u.x, y: k * u.y, z: k * u.z },
        acceleration: { x: 0, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16,
      }));
    }
  }
  window.__tilt = {
    start(a = 90, mode = 'orientation', convention = 'android') {
      sim.a = a; sim.mode = mode; sim.convention = convention;
      clearInterval(sim.timer);
      sim.timer = setInterval(fire, 16);
      fire();
    },
    hold(a) { sim.a = a; },
    set(phi, tau = sim.tau) { sim.phi = phi; sim.tau = tau; sim.raw = null; },
    // Raw world-up vector in the UI frame, e.g. a flat phone rolled right by r:
    // setUp(-sin r, 0, cos r).
    setUp(ux, uy, uz) { const n = Math.hypot(ux, uy, uz); sim.raw = [ux / n, uy / n, uz / n]; },
    stop() { clearInterval(sim.timer); sim.timer = null; },
    get sent() { return sim.sent; },
  };
}

class Phone {
  constructor(page, client, label) { this.page = page; this.client = client; this.label = label; this.touches = new Map(); }

  static async open(browser, { w, h, angle, ua = IPHONE_UA, url = PAD_URL, label, netErrorsOk = false, init = null }) {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // While the server is deliberately down, the browser logs refused connections.
      if (netErrorsOk && /WebSocket connection|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) return;
      pageErrors++;
      console.log(`  [${label} console.error] ${m.text()}`);
    });
    page.on('pageerror', (e) => { pageErrors++; console.log(`  [${label} pageerror] ${e.message}`); });
    page.on('requestfailed', (r) => {
      if (!r.url().includes('fonts.g')) console.log(`  [${label} requestfailed] ${r.url()} ${r.failure()?.errorText}`);
    });
    // All device emulation goes through this one CDP session (the browser is
    // launched with defaultViewport: null) — two sessions overriding device
    // metrics race, and the screen angle must be exact for these tests.
    const client = await page.createCDPSession();
    const type = angle === 0 ? 'portraitPrimary' : angle === 90 ? 'landscapePrimary' : angle === 180 ? 'portraitSecondary' : 'landscapeSecondary';
    await client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenOrientation: { type, angle } });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await client.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: ua.includes('iPhone') ? 'iPhone' : 'Linux armv8l' });
    await page.evaluateOnNewDocument(tiltSim);
    if (init) await page.evaluateOnNewDocument(init);
    await page.goto(url, { waitUntil: 'load' });
    return new Phone(page, client, label);
  }

  eval(fn, ...args) { return this.page.evaluate(fn, ...args); }
  screen() { return this.eval(() => document.getElementById('stage').dataset.screen); }
  pad() {
    return this.eval(() => ({
      steer: window.__pad.steer, raw: window.__pad.rawAngleDeg, ui: window.__pad.uiAngle,
      src: window.__pad.state.steerSource, calib: window.__pad.state.calib, rot: window.__pad.state.cssRot,
      flip: window.__pad.osFlip, joined: window.__pad.state.joined,
    }));
  }
  async waitScreen(name, ms = 4000) { return waitUntil(async () => (await this.screen()) === name, ms); }
  async center(sel) {
    return this.eval((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
  }
  async _touch(type) {
    const touchPoints = [...this.touches.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 }));
    await this.client.send('Input.dispatchTouchEvent', { type, touchPoints });
  }
  async down(id, sel, dx = 0, dy = 0) {
    const c = await this.center(sel);
    if (!c) throw new Error(`${this.label}: ${sel} not visible`);
    this.touches.set(id, { x: c.x + dx, y: c.y + dy });
    await this._touch('touchStart');
    return c;
  }
  async move(id, x, y) { this.touches.set(id, { x, y }); await this._touch('touchMove'); }
  // CDP (Chrome): touchEnd releases exactly the fingers it lists.
  async up(id) {
    const p = this.touches.get(id);
    if (!p) return;
    this.touches.delete(id);
    await this.client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: p.x, y: p.y, id }] });
  }
  async tap(sel) { await this.down(99, sel); await sleep(40); await this.up(99); await sleep(60); }
  // One finger dragged from the center of `sel` by (dx, dy) screen px in small steps.
  async swipe(sel, dx, dy, steps = 12) {
    const c = await this.down(98, sel);
    for (let i = 1; i <= steps; i++) { await this.move(98, c.x + (dx * i) / steps, c.y + (dy * i) / steps); await sleep(16); }
    await this.up(98);
    await sleep(120);
  }
  // Fakes document.visibilityState (screen lock / app switch) and fires visibilitychange.
  setHidden(hidden) {
    return this.eval((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  }
  // Captured through our own CDP session so the emulated size + DPR are used.
  async shot(name) {
    const f = path.join(OUT, `${this.label}-${name}.png`);
    const { data } = await this.client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    return f;
  }
  close() { return this.page.close(); }
}

// ------------------------------------------------------------------ scenarios

async function orientationScenario(browser, host, cfg) {
  const L = cfg.label;
  console.log(`\n=== ${L}: ${cfg.w}x${cfg.h}, screen angle ${cfg.angle}${cfg.angle === 0 ? ' (portrait layout → CSS rotation)' : ''}`);
  host.setScreen({ screen: 'title' });
  host.clear();
  const ph = await Phone.open(browser, { ...cfg });
  try {
    check(`${L} gate screen after load`, await ph.waitScreen('gate'));
    const statusText = () => ph.eval(() => document.getElementById('gate-status-text').textContent);
    await waitUntil(async () => /Connected/.test(await statusText()), 3000);
    const status = await statusText();
    check(`${L} gate shows the connection`, /Connected/.test(status), status);
    const angleSeen = await ph.eval(() => screen.orientation.angle);
    check(`${L} emulated screen angle is ${cfg.angle}`, angleSeen === cfg.angle, String(angleSeen));
    await ph.shot('1-gate');

    // Hold the phone like a wheel, then tap the gate.
    await ph.eval((a) => window.__tilt.start(a), cfg.hold);
    await sleep(350);
    await ph.tap('#btn-gate');
    check(`${L} title screen after the gate`, await ph.waitScreen('title'));
    await sleep(400);
    let p = await ph.pad();
    check(`${L} steering source = orientation`, p.src === 'orientation', p.src);
    check(`${L} effective UI angle = ${cfg.expectUi}`, p.ui === cfg.expectUi, `ui ${p.ui}, css ${p.rot}, flip ${p.flip}`);
    check(`${L} upright wheel → steer ≈ 0`, near(p.steer, 0, 0.02), fmt(p.steer));
    await ph.shot('2-title');

    // Steering sign + magnitude: clockwise = right = positive.
    for (const phi of [20, -20, 35]) {
      await ph.eval((v) => window.__tilt.set(v, 15), phi);
      await sleep(450);
      p = await ph.pad();
      const exp = expectedSteer(phi, 15, p.calib);
      check(`${L} wheel ${phi > 0 ? 'clockwise' : 'counter-clockwise'} ${Math.abs(phi)}° → steer ${exp.toFixed(3)}`, near(p.steer, exp, 0.03),
        `steer ${fmt(p.steer)}, θ ${p.raw.toFixed(2)}°`);
      const last = host.logs.last;
      check(`${L} host receives steer sign ${phi > 0 ? '+' : '−'}`, last && Math.sign(last.s) === Math.sign(phi) && near(last.s, exp, 0.04), last && fmt(last.s));
    }
    // Wheel grip: the steering does not depend on how far the screen is
    // tilted back (phone held low / in the lap), and full lock stays reachable.
    {
      await ph.eval(() => window.__tilt.set(20, 15));
      await sleep(400);
      const upright = (await ph.pad()).steer;
      await ph.eval(() => window.__tilt.set(20, 50));
      await sleep(450);
      p = await ph.pad();
      check(`${L} wheel 20° with the screen tilted back 50° → same steer as at 15°`, near(p.steer, upright, 0.02) && near(p.steer, expectedSteer(20, 50, p.calib), 0.03),
        `${fmt(p.steer)} vs ${fmt(upright)} (old asin math: ${fmt(shapedSteer(Math.asin(Math.cos(50 * Math.PI / 180) * Math.sin(20 * Math.PI / 180)) * 180 / Math.PI))})`);
      await ph.eval(() => window.__tilt.set(50, 56));
      await sleep(450);
      p = await ph.pad();
      check(`${L} wheel 50° tilted back 56° → full lock`, p.steer > 0.97, fmt(p.steer));
    }
    // Flat tilting: phone lying almost flat, right edge dipped 15° → steer right.
    for (const r of [15, -15]) {
      await ph.eval((deg) => { const d = deg * Math.PI / 180; window.__tilt.setUp(-Math.sin(d), 0.12, Math.cos(d)); }, r);
      await sleep(450);
      p = await ph.pad();
      const exp = expectedSteer(Math.asin(Math.sin(r * Math.PI / 180) / Math.hypot(1, 0.12)) * 180 / Math.PI, 0, p.calib);
      check(`${L} flat phone, ${r > 0 ? 'right' : 'left'} edge down 15° → steer ${exp.toFixed(3)}`, near(p.steer, exp, 0.03), fmt(p.steer));
    }
    await ph.eval(() => window.__tilt.set(0, 15));
    await sleep(300);

    // Menus: START → select → pick racer + difficulty → RACE!
    await ph.tap('#btn-start');
    check(`${L} START → select screen`, await ph.waitScreen('select'));
    await sleep(300);
    await ph.tap(".char-card[data-index='2']");
    await ph.tap("#diff-seg button[data-diff='easy']");
    await sleep(350);
    const sel = await ph.eval(() => ({
      selected: [...document.querySelectorAll('.char-card.selected')].map((c) => c.dataset.index),
      diff: document.querySelector('#diff-seg button.on')?.dataset.diff,
    }));
    check(`${L} racer select relayed + highlighted`, host.game.selected === 2 && sel.selected.join() === '2', JSON.stringify(sel));
    check(`${L} difficulty relayed + highlighted`, host.game.difficulty === 'easy' && sel.diff === 'easy');
    await ph.shot('3-select');

    // Hold the wheel slightly turned: auto-center at the countdown absorbs it.
    await ph.eval(() => window.__tilt.set(6, 15));
    await ph.tap('#btn-go');
    check(`${L} RACE! → race screen`, await ph.waitScreen('race'));
    await waitUntil(() => host.game.raceState === 'countdown', 3000);
    await sleep(500);
    p = await ph.pad();
    check(`${L} auto-center at countdown`, near(p.calib, p.raw, 0.6) && Math.abs(p.calib) > 4 && near(p.steer, 0, 0.02),
      `calib ${p.calib.toFixed(2)}°, θ ${p.raw.toFixed(2)}°, steer ${fmt(p.steer)}`);
    const cd = await ph.eval(() => document.getElementById('countdown').textContent);
    check(`${L} countdown number shown`, /^[123]$/.test(cd), cd);
    await ph.shot('4-countdown');
    await waitUntil(() => host.game.raceState === 'racing', 4000);
    await ph.eval(() => window.__tilt.set(0, 15));
    await sleep(350);
    p = await ph.pad();
    check(`${L} after auto-center, level wheel steers left a bit`, p.steer < -0.02, fmt(p.steer));
    await ph.tap('#btn-center');
    await sleep(300);
    p = await ph.pad();
    check(`${L} CENTER button re-centers`, near(p.calib, 0, 0.6) && near(p.steer, 0, 0.02), `calib ${p.calib.toFixed(2)}, steer ${fmt(p.steer)}`);

    // Buttons with multi-touch.
    host.setScreen({ screen: 'race', race: 'racing', item: 'rocket', place: 2, lap: 2 });
    await sleep(250);
    const icon = await ph.eval(() => document.getElementById('item-icon').textContent);
    check(`${L} item icon from host state`, icon === '🚀', icon);
    host.clear();
    await ph.down(1, '#btn-gas');
    await ph.down(2, '#btn-drift');
    await ph.eval(() => window.__tilt.set(20, 15));
    await sleep(400);
    let last = host.logs.last;
    const pressedCls = await ph.eval(() => ['btn-gas', 'btn-drift', 'btn-brake'].map((id) => document.getElementById(id).classList.contains('pressed')));
    check(`${L} GAS + DRIFT held together → host g=1 d=1, steering right`, last && last.g === 1 && last.d === 1 && last.b === 0 && near(last.s, expectedSteer(20, 15), 0.03), JSON.stringify(last));
    check(`${L} pressed visuals on GAS + DRIFT only`, pressedCls.join() === 'true,true,false', pressedCls.join());
    await ph.shot('5-race-pressed');
    const seq0 = last.i;
    await ph.down(3, '#btn-item');
    await sleep(60);
    await ph.up(3);
    await sleep(250);
    last = host.logs.last;
    check(`${L} ITEM tap (third finger) → itemSeq +1, others still held`, last.i === seq0 + 1 && last.g === 1 && last.d === 1, `i ${seq0}→${last.i}`);
    check(`${L} item consumed on the host → slot empties`, await waitUntil(() => ph.eval(() => document.getElementById('btn-item').classList.contains('empty')), 1500));
    await ph.up(1);
    await sleep(150);
    last = host.logs.last;
    check(`${L} release GAS → g=0 while DRIFT stays held`, last.g === 0 && last.d === 1, JSON.stringify(last));
    await ph.up(2);
    await ph.down(4, '#btn-brake');
    await sleep(150);
    last = host.logs.last;
    check(`${L} BRAKE held → b=1, drift released`, last.b === 1 && last.d === 0 && last.g === 0, JSON.stringify(last));
    await ph.up(4);
    await sleep(150);
    check(`${L} all released → zeros`, host.logs.last.b === 0 && host.logs.last.g === 0);
    const edges = host.logs.edges.length;
    check(`${L} button edges were sent immediately (≥ 6 edges)`, edges >= 6, `${edges} edges`);
    // Input rate while racing.
    const n0 = host.logs.counts.input;
    await sleep(1000);
    const rate = host.logs.counts.input - n0;
    check(`${L} pad:input rate ≈ 60 Hz while racing`, rate >= 45 && rate <= 75, `${rate}/s`);
    await ph.eval(() => window.__tilt.set(0, 15));

    // Rolling roulette + triple count visuals.
    host.setScreen({ screen: 'race', race: 'racing', item: 'triple_toot', count: 3, place: 1, lap: 3 });
    await sleep(250);
    const cnt = await ph.eval(() => document.getElementById('item-count').textContent);
    check(`${L} triple item shows its count`, cnt === '3', cnt);
    await ph.shot('6-race-item');
    host.setScreen({ screen: 'race', race: 'racing', item: 'none', rolling: '1' });
    await sleep(300);
    check(`${L} roulette animates while rolling`, await ph.eval(() => document.getElementById('btn-item').classList.contains('rolling')));

    // Pause via the top-bar button (pauseSeq) → paused → RESUME.
    host.setScreen({ screen: 'race', race: 'racing', rolling: '0', item: 'banana' });
    await sleep(200);
    await ph.tap('#btn-pause');
    check(`${L} pause button → host pauses → paused screen`, await ph.waitScreen('paused'));
    await ph.shot('7-paused');
    await ph.tap("[data-menu='resume']");
    check(`${L} RESUME → race screen`, await ph.waitScreen('race'));

    // Finish banner, results, RACE AGAIN.
    host.setScreen({ screen: 'race', race: 'finished', finished: '1', place: 3 });
    await sleep(300);
    check(`${L} finish banner`, await ph.eval(() => document.getElementById('finish-banner').classList.contains('show')));
    await ph.shot('8-finish');
    host.setScreen({ screen: 'results' });
    check(`${L} results screen`, await ph.waitScreen('results'));
    await sleep(300);
    const rows = await ph.eval(() => [...document.querySelectorAll('#standings li')].map((li) => li.textContent));
    check(`${L} standings list (8 rows, player marked)`, rows.length === 8 && rows.some((r) => r.includes('(you)')), `${rows.length} rows`);
    await ph.shot('9-results');
    await ph.tap("[data-menu='again']");
    check(`${L} RACE AGAIN → race`, await ph.waitScreen('race'));
    host.setScreen({ screen: 'results' });
    await ph.waitScreen('results');
    await ph.tap("[data-menu='menu']");
    check(`${L} CHANGE CHARACTER → select`, await ph.waitScreen('select'));

    // Settings sheet: invert steering.
    host.setScreen({ screen: 'race', race: 'racing' });
    await ph.waitScreen('race');
    await ph.tap('#btn-settings');
    await sleep(350);
    check(`${L} settings sheet opens`, await ph.eval(() => document.getElementById('sheet').classList.contains('open')));
    await ph.shot('10-settings');
    await ph.tap('#set-invert');
    await ph.eval(() => window.__tilt.set(20, 15));
    await sleep(400);
    p = await ph.pad();
    check(`${L} invert steering flips the sign`, near(p.steer, -expectedSteer(20, 15, p.calib), 0.03), fmt(p.steer));
    await ph.tap('#set-invert');
    await sleep(400);
    p = await ph.pad();
    check(`${L} invert off again`, near(p.steer, expectedSteer(20, 15, p.calib), 0.03), fmt(p.steer));
    await ph.tap('#btn-sheet-close');
    await sleep(300);
    await ph.eval(() => window.__tilt.set(0, 15));

    // Desktop leaves → waiting overlay → comes back.
    await host.leave();
    check(`${L} desktop leaves → "waiting for the game" overlay`,
      await waitUntil(() => ph.eval(() => document.getElementById('ov-waiting').classList.contains('show')), 3000));
    await sleep(350);
    await ph.shot('11-waiting');
    await host.join();
    check(`${L} desktop back → overlay hidden`,
      await waitUntil(() => ph.eval(() => !document.getElementById('ov-waiting').classList.contains('show')), 3000));

    // Another phone takes over → kicked overlay → take back control.
    const other = ioClient(`https://localhost:${HTTPS_PORT}`, { rejectUnauthorized: false, transports: ['websocket'], forceNew: true });
    await new Promise((r) => other.once('connect', r));
    const hr = await other.timeout(3000).emitWithAck('pad:hello', { room: ROOM, id: 'other-phone-0001' });
    check(`${L} second phone joins`, hr.ok === true);
    check(`${L} first phone shows the kicked overlay`,
      await waitUntil(() => ph.eval(() => document.getElementById('ov-kicked').classList.contains('show')), 3000));
    await sleep(350);
    await ph.shot('12-kicked');
    const kicked = new Promise((r) => other.once('pad:kicked', r));
    await ph.tap('#btn-reclaim');
    check(`${L} TAKE BACK CONTROL → second phone kicked`, !!(await Promise.race([kicked, sleep(3000).then(() => null)])));
    check(`${L} first phone active again`, await waitUntil(async () => (await ph.pad()).joined, 3000));
    other.close();

    // Touch steering mode (settings → TOUCH): drag the knob.
    await ph.tap('#btn-settings');
    await sleep(300);
    await ph.tap("#mode-seg button[data-mode='touch']");
    await ph.tap('#btn-sheet-close');
    await sleep(300);
    p = await ph.pad();
    check(`${L} TOUCH mode → touch source`, p.src === 'touch', p.src);
    const dir = await ph.eval(() => {
      const rot = window.__pad.state.cssRot;
      return rot === 90 ? { x: 0, y: 1 } : rot === -90 ? { x: 0, y: -1 } : { x: 1, y: 0 };
    });
    const c = await ph.down(5, '#ts-track');
    await ph.move(5, c.x + dir.x * 150, c.y + dir.y * 150);
    await sleep(300);
    p = await ph.pad();
    check(`${L} drag knob right → steer right`, p.steer > 0.5 && host.logs.last.s > 0.5, `${fmt(p.steer)} / host ${fmt(host.logs.last.s)}`);
    await ph.shot('13-touch-steer');
    await ph.move(5, c.x - dir.x * 80, c.y - dir.y * 80);
    await sleep(300);
    p = await ph.pad();
    check(`${L} drag knob left → steer left`, p.steer < -0.2, fmt(p.steer));
    await ph.up(5);
    await sleep(300);
    p = await ph.pad();
    check(`${L} release knob → recenters`, near(p.steer, 0, 0.02), fmt(p.steer));
    await ph.tap('#btn-settings');
    await sleep(300);
    await ph.tap("#mode-seg button[data-mode='tilt']");
    await ph.tap('#btn-sheet-close');
    await sleep(500);
    check(`${L} back to TILT mode`, (await ph.pad()).src === 'orientation');

    if (cfg.angle === 0) {
      // Portrait layout: holding the phone the other way flips the CSS rotation.
      await ph.eval(() => window.__tilt.hold(270));
      await sleep(600);
      p = await ph.pad();
      check(`${L} held the other way → stage rotates −90°`, p.rot === -90 && p.ui === 270, `rot ${p.rot}, ui ${p.ui}`);
      await ph.eval(() => window.__tilt.set(20, 15));
      await sleep(450);
      p = await ph.pad();
      check(`${L} (−90°) clockwise → steer right`, near(p.steer, expectedSteer(20, 15, p.calib), 0.03), fmt(p.steer));
      await ph.eval(() => window.__tilt.set(-20, 15));
      await sleep(450);
      p = await ph.pad();
      check(`${L} (−90°) counter-clockwise → steer left`, near(p.steer, expectedSteer(-20, 15, p.calib), 0.03), fmt(p.steer));
      await ph.eval(() => window.__tilt.set(0, 15));
      await ph.shot('14-race-rot-ccw');
      // Hysteresis: leaning 60° toward the other side must not flip it back.
      await ph.eval(() => { window.__tilt.hold(270); window.__tilt.set(60, 15); });
      await sleep(500);
      check(`${L} hysteresis: 60° lean keeps the rotation`, (await ph.pad()).rot === -90);
      await ph.eval(() => { window.__tilt.set(0, 15); window.__tilt.hold(0); });
      await sleep(1400); // pad.js waits HINT_DELAY_MS (900 ms) of upright pose before hinting
      const hint = await ph.eval(() => document.getElementById('hint-rotate').classList.contains('show'));
      check(`${L} phone upright in portrait → "turn sideways" hint`, hint);
      await ph.shot('15-portrait-hint');
    }
    host.setScreen({ screen: 'loading' });
    check(`${L} loading screen`, await ph.waitScreen('loading'));
    await ph.shot('16-loading');
  } finally {
    await ph.close();
  }
}

async function extraScenarios(browser, host, info) {
  console.log('\n=== extra scenarios');
  host.setScreen({ screen: 'race', race: 'racing' });

  // devicemotion fallback, iOS sign convention, iPhone UA.
  for (const [conv, ua, label] of [['ios', IPHONE_UA, 'iOS'], ['android', ANDROID_UA, 'Android']]) {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua, label: `motion-${conv}` });
    await ph.eval((c) => window.__tilt.start(90, 'motion', c), conv);
    await ph.tap('#btn-gate');
    await sleep(500);
    await ph.eval(() => window.__tilt.set(20, 30));
    await sleep(500);
    let p = await ph.pad();
    check(`motion fallback (${label} convention) → source motion`, p.src === 'motion', p.src);
    check(`motion fallback (${label}) clockwise → steer right`, near(p.steer, expectedSteer(20, 30), 0.04), fmt(p.steer));
    await ph.eval(() => window.__tilt.set(-20, 30));
    await sleep(400);
    p = await ph.pad();
    check(`motion fallback (${label}) counter-clockwise → steer left`, near(p.steer, expectedSteer(-20, 30), 0.04), fmt(p.steer));
    await ph.close();
  }
  // Wrong initial sign guess (iPhone UA but W3C-convention data) is corrected.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua: IPHONE_UA, label: 'motion-fix' });
    await ph.eval(() => { window.__tilt.set(0, 30); window.__tilt.start(90, 'motion', 'android'); });
    await ph.tap('#btn-gate');
    await sleep(800);
    await ph.eval(() => window.__tilt.set(20, 30));
    await sleep(400);
    const p = await ph.pad();
    check('motion sign auto-detection fixes an inverted guess', near(p.steer, expectedSteer(20, 30), 0.04), fmt(p.steer));
    await ph.close();
  }
  // A browser reporting the opposite landscape angle (screen says 90, phone is
  // really held the 270 way) is detected from gravity and corrected.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'flip' });
    await ph.eval(() => window.__tilt.start(270));
    await ph.tap('#btn-gate');
    await sleep(1600);
    let p = await ph.pad();
    check('opposite landscape angle → detected and corrected', p.flip === true && p.ui === 270, `flip ${p.flip}, ui ${p.ui}`);
    await ph.eval(() => window.__tilt.set(20, 15));
    await sleep(400);
    p = await ph.pad();
    check('…and clockwise still steers right', near(p.steer, expectedSteer(20, 15, p.calib), 0.03), fmt(p.steer));
    await ph.close();
  }
  // No sensors at all → touch slider after 1.5 s.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'nosensor' });
    await ph.tap('#btn-gate');
    await sleep(1900);
    const p = await ph.pad();
    const toast = await ph.eval(() => document.getElementById('toast').textContent);
    check('no sensor events → touch slider fallback', p.src === 'touch', `${p.src}; toast "${toast}"`);
    await ph.shot('race-touch-fallback');
    await ph.close();
  }
  // Room-code entry (no ?room=): type the code on the keypad → joins → gate.
  for (const [w, h, angle] of [[844, 390, 90], [390, 844, 0]]) {
    const label = `code-${w > h ? 'L' : 'P'}`;
    const ph = await Phone.open(browser, { w, h, angle, url: `https://localhost:${HTTPS_PORT}/pad`, label });
    check(`${label} no room → code entry screen`, await ph.waitScreen('code'));
    await ph.tap(".key[data-k='Z']");
    await ph.tap(".key[data-k='back']");
    for (const k of 'PAD') await ph.tap(`.key[data-k='${k}']`);
    await ph.shot('1-typing');
    await ph.tap(".key[data-k='T']");
    check(`${label} typed code joins → gate`, await ph.waitScreen('gate'));
    const url = await ph.eval(() => location.search);
    check(`${label} URL updated with the room`, url === `?room=${ROOM}`, url);
    await ph.close();
  }
  // Unknown room: error + keeps retrying, joins automatically once it opens.
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, url: `https://localhost:${HTTPS_PORT}/pad?room=WXYZ`, label: 'badroom' });
    check('unknown room → code screen with an error', await ph.waitScreen('code'));
    const err = await ph.eval(() => document.getElementById('code-error').textContent);
    check('error text mentions the room', /WXYZ/.test(err), err);
    await ph.shot('code-error');
    const late = await startFakeHost({ url: `http://localhost:${PORT}`, room: 'WXYZ', quiet: true });
    check('room opens later → phone joins by itself', await ph.waitScreen('gate', 6000));
    await late.close();
    await ph.close();
  }
  // Page hidden mid-race (screen lock / app switch / call) while driving: the
  // pad pauses the game right away and stops streaming; visible again → resumes.
  {
    host.setScreen({ screen: 'race', race: 'racing' });
    host.clear();
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua: ANDROID_UA, label: 'hidden' });
    await ph.eval(() => window.__tilt.start(90));
    await ph.tap('#btn-gate');
    await ph.waitScreen('race');
    await ph.down(1, '#btn-gas');
    await ph.eval(() => window.__tilt.set(25, 15));
    await sleep(400);
    check('hidden: driving before (GAS held, steering)', host.logs.last?.g === 1 && near(host.logs.last.s, expectedSteer(25, 15), 0.03), JSON.stringify(host.logs.last));
    const menus0 = host.logs.menus.length;
    await ph.setHidden(true);
    await sleep(250);
    const pauses = host.logs.menus.slice(menus0).filter((m) => m.action === 'pause');
    check('hidden mid-race → the pad sends pause at once → host paused', pauses.length === 1 && host.game.screen === 'paused', `${pauses.length} pause(s), host ${host.game.screen}`);
    check('hidden → host input released (g=0, s=0)', host.logs.last.g === 0 && host.logs.last.s === 0, JSON.stringify(host.logs.last));
    const n0 = host.logs.counts.input;
    await sleep(700);
    check('hidden → no input stream while away', host.logs.counts.input - n0 <= 1, `${host.logs.counts.input - n0} samples`);
    await ph.up(1);
    await ph.setHidden(false);
    await sleep(700);
    check('visible again → stream resumes, phone shows the pause menu', host.logs.counts.input - n0 >= 2 && (await ph.screen()) === 'paused', `${host.logs.counts.input - n0} samples, ${await ph.screen()}`);
    // After the finish (CPU drives the player's kart) hiding the page must not pause.
    host.setScreen({ screen: 'race', race: 'finished', finished: '1' });
    await ph.waitScreen('race');
    const menus1 = host.logs.menus.length;
    await ph.setHidden(true);
    await sleep(250);
    check('hidden after the player finished → no pause', host.logs.menus.length === menus1 && host.game.screen === 'race');
    await ph.setHidden(false);
    await ph.close();
  }
  // iPhone with motion access denied: a lasting note (race screen + settings)
  // and a button that asks again inside the tap.
  {
    host.setScreen({ screen: 'race', race: 'racing' });
    const ph = await Phone.open(browser, {
      w: 844, h: 390, angle: 90, label: 'perm-denied',
      init: () => {
        window.__permAsks = 0;
        window.__permAnswer = 'denied';
        // iOS asks once for both; (recent desktop Chrome has these too and says 'granted').
        DeviceOrientationEvent.requestPermission = () => { window.__permAsks++; return Promise.resolve(window.__permAnswer); };
        DeviceMotionEvent.requestPermission = () => Promise.resolve(window.__permAnswer);
      },
    });
    await ph.tap('#btn-gate');
    await sleep(1900);
    const st = () => ph.eval(() => ({
      src: window.__pad.state.steerSource, denied: window.__pad.state.permissionDenied, asks: window.__permAsks,
      mode: document.getElementById('steer-mode').textContent, note: !document.getElementById('tilt-note').hidden,
    }));
    let v = await st();
    check('motion access denied → touch steering + lasting "tilt blocked" line on the race screen', v.src === 'touch' && v.denied && /BLOCKED/.test(v.mode) && v.asks === 1, JSON.stringify(v));
    await ph.shot('race');
    await ph.tap('#btn-settings');
    await sleep(350);
    check('settings explain how to get tilt back', v.note);
    await ph.eval(() => document.getElementById('btn-enable-tilt').scrollIntoView({ block: 'center' }));
    await sleep(150);
    await ph.shot('settings-note');
    await ph.eval(() => { window.__permAnswer = 'granted'; window.__tilt.start(90); });
    await ph.tap('#btn-enable-tilt');
    await sleep(700);
    v = await st();
    check('TRY TILT AGAIN asks again inside the tap → tilt steering, note gone', v.asks === 2 && !v.denied && !v.note && v.src === 'orientation', JSON.stringify(v));
    await ph.close();
  }
  // Android: fullscreen (+ landscape lock) is re-entered on the next tap after it was lost.
  {
    host.setScreen({ screen: 'title' });
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua: ANDROID_UA, label: 'fullscreen' });
    await ph.eval(() => window.__tilt.start(90));
    await ph.tap('#btn-gate');
    await sleep(500);
    if (!(await ph.eval(() => !!document.fullscreenElement))) {
      console.log('SKIP  fullscreen re-entry (this Chrome does not enter fullscreen at the gate)');
    } else {
      await ph.eval(() => document.exitFullscreen());
      await sleep(1600);
      check('fullscreen lost (app switch / back gesture)', await ph.eval(() => !document.fullscreenElement));
      await ph.tap('#btn-settings');
      await sleep(400);
      check('next tap re-enters fullscreen', await ph.eval(() => !!document.fullscreenElement));
    }
    await ph.close();
  }
  // No WebSocket (upgrade refused): long-polling still streams, and the
  // settings readout says which link is in use.
  {
    host.setScreen({ screen: 'race', race: 'racing' });
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, ua: ANDROID_UA, label: 'polling', init: () => { window.WebSocket = undefined; } });
    await ph.eval(() => window.__tilt.start(90));
    await ph.tap('#btn-gate');
    await ph.waitScreen('race');
    await sleep(600);
    const n0 = host.logs.counts.input;
    await sleep(1000);
    const rate = host.logs.counts.input - n0;
    await ph.tap('#btn-settings');
    await sleep(400);
    const tr = await ph.eval(() => ({ t: window.__pad.transport, dbg: document.getElementById('dbg').textContent }));
    check('no WebSocket → "polling" shown in the settings readout', tr.t === 'polling' && /polling/.test(tr.dbg), tr.t);
    check('polling still streams steering on a fast link (≥ 30/s)', rate >= 30, `${rate}/s`);
    await ph.close();
  }
  // Small phone, portrait-locked (stage CSS-rotated, 553x375): names fit on the
  // select screen, lists scroll with a swipe along the rotated axis, the
  // sensitivity slider can be dragged.
  {
    host.setScreen({ screen: 'select' });
    const ph = await Phone.open(browser, { w: 375, h: 553, angle: 0, label: 'SE-rot' });
    await ph.eval(() => window.__tilt.start(90));
    await ph.tap('#btn-gate');
    await ph.waitScreen('select');
    await sleep(500);
    const m = await ph.eval(() => {
      const side = document.querySelector('.sel-side'), main = document.querySelector('.sel-main');
      return {
        rot: window.__pad.state.cssRot,
        truncated: [...document.querySelectorAll('.cc-name')].filter((n) => n.scrollWidth > n.clientWidth).map((n) => n.textContent),
        sidePct: Math.round((100 * side.offsetWidth) / (main.offsetWidth + side.offsetWidth)),
      };
    });
    check('SE rotated: select screen keeps every racer name whole', m.rot === 90 && m.truncated.length === 0 && m.sidePct <= 36, JSON.stringify(m));
    await ph.shot('select');
    // cssRot 90: stage +x = screen +y (down), stage "scroll up" = finger to screen +x.
    host.setScreen({ screen: 'results' });
    await ph.waitScreen('results');
    await sleep(400);
    await ph.swipe('#standings', 160, 0);
    const res = await ph.eval(() => { const l = document.getElementById('standings'); return { top: l.scrollTop, over: l.scrollHeight - l.clientHeight }; });
    check('SE rotated: results list scrolls (swipe along the rotated axis)', res.over > 10 && res.top > 10, JSON.stringify(res));
    host.setScreen({ screen: 'race', race: 'racing' });
    await ph.waitScreen('race');
    await ph.tap('#btn-settings');
    await sleep(400);
    const before = await ph.eval(() => window.__pad.settings.lockDeg);
    const len = await ph.eval(() => document.getElementById('sens').offsetWidth);
    await ph.swipe('#sens', 0, len * 0.3, 16);       // stage +x (toward "twitchy") = screen +y
    const after = await ph.eval(() => window.__pad.settings.lockDeg);
    check('SE rotated: sensitivity slider drags along its (rotated) axis', after <= before - 7, `full lock ${before}° → ${after}°`);
    await ph.swipe('.sheet-body .set-row:nth-child(2) .set-label', 160, 0);
    const sb = await ph.eval(() => { const b = document.getElementById('sheet-body'); return { top: b.scrollTop, over: b.scrollHeight - b.clientHeight }; });
    check('SE rotated: settings sheet scrolls (swipe along the rotated axis)', sb.over > 10 && sb.top > 10, JSON.stringify(sb));
    await ph.shot('settings');
    await ph.eval(() => localStorage.removeItem('tootkart.pad.settings.v1'));   // do not leak the new sensitivity
    await ph.close();
  }
  // Insecure-context help screen (forced visually; a real http:// LAN page is redirected).
  {
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'insecure' });
    await ph.eval(() => {
      for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === 'scr-insecure');
      document.getElementById('stage').dataset.screen = 'insecure';
    });
    await sleep(200);
    await ph.shot('screen');
    await ph.close();
  }
  // Full server restart: the phone shows "waiting", then recovers once the
  // desktop (fake host) reclaims its room on the new server.
  if (spawnServer) {
    host.setScreen({ screen: 'title' });
    const ph = await Phone.open(browser, { w: 844, h: 390, angle: 90, label: 'restart', netErrorsOk: true });
    await ph.tap('#btn-gate');
    check('restart: phone on title before restart', await ph.waitScreen('title'));
    await stopServer();
    await sleep(400);
    const banner = await ph.eval(() => document.getElementById('banner-offline').classList.contains('show'));
    check('restart: "Reconnecting…" banner while the server is down', banner);
    await ph.shot('1-offline');
    // Still failing after several attempts (server gone, or a new certificate
    // the phone has not accepted): suggest reloading the page.
    const stuck = await waitUntil(() => ph.eval(() => {
      const b = document.getElementById('banner-offline');
      return b.classList.contains('stuck') && /reload this page/i.test(b.textContent) && document.getElementById('btn-reload').offsetWidth > 0;
    }), 15000, 250);
    check('restart: after repeated failures the banner suggests reloading the page', !!stuck);
    await ph.shot('2-offline-reload-hint');
    startServer();
    await waitForServer();
    const back = await waitUntil(async () => (await ph.pad()).joined && !(await ph.eval(() => document.getElementById('ov-waiting').classList.contains('show'))), 12000, 200);
    check('restart: phone and desktop reconnect to the same room automatically', !!back);
    check('restart: reload hint gone once connected', await ph.eval(() => !document.getElementById('banner-offline').classList.contains('show') && window.__pad.state.connectErrors === 0));
    host.setScreen({ screen: 'select' });
    check('restart: host state flows again', await ph.waitScreen('select', 4000));
    await ph.close();
  }
  void info;
}

// ------------------------------------------------------------------ main

if (spawnServer) startServer();
let info;
try {
  info = await waitForServer();
} catch (err) {
  console.log(`FAIL  server startup: ${err.message}`);
  await stopServer();
  process.exit(1);
}
const host = await startFakeHost({ url: `http://localhost:${PORT}`, room: ROOM, quiet: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  acceptInsecureCerts: true,
  defaultViewport: null,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--ignore-certificate-errors'],
});

const CONFIGS = [
  { label: 'L90', w: 844, h: 390, angle: 90, hold: 90, expectUi: 90 },
  { label: 'L270', w: 844, h: 390, angle: 270, hold: 270, expectUi: 270 },
  { label: 'P0', w: 390, h: 844, angle: 0, hold: 90, expectUi: 90 },
];
try {
  for (const cfg of CONFIGS) {
    if (!ONLY.includes(cfg.label)) continue;
    try { await orientationScenario(browser, host, cfg); } catch (err) { check(`${cfg.label} scenario crashed`, false, err.stack); }
  }
  if (ONLY.includes('extra')) {
    try { await extraScenarios(browser, host, info); } catch (err) { check('extra scenarios crashed', false, err.stack); }
  }
} finally {
  await browser.close();
  await host.close();
  await stopServer();
}

check('no page errors / console errors', pageErrors === 0, `${pageErrors}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
