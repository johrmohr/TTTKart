// Protocol tests for server.js + public/js/net.js (SPEC §11).
//
//   node tools/test-net.mjs              # spawns the server on PORT=3100 HTTPS_PORT=3543
//   node tools/test-net.mjs --no-spawn   # use an already running server on those ports
//
// Prints PASS/FAIL per case and exits non-zero on any failure.
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 3102);
const HTTPS_PORT = Number(process.env.TEST_HTTPS_PORT || 3542);
const GRACE_MS = 1500;
const HTTP_URL = `http://localhost:${PORT}`;
const HTTPS_URL = `https://localhost:${HTTPS_PORT}`;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
const spawnServer = !process.argv.includes('--no-spawn');

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sockets = new Set();

function getUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

function connect(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { reconnection: false, forceNew: true, rejectUnauthorized: false, timeout: 4000, ...opts });
    sockets.add(s);
    const t = setTimeout(() => reject(new Error(`connect timeout ${url}`)), 5000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

const ack = (s, ev, payload, ms = 3000) => s.timeout(ms).emitWithAck(ev, payload);

// Minimal Web Storage stand-in. Node 26 has a process-wide sessionStorage and a
// localStorage that warns unless --localstorage-file is given: tests install
// their own per simulated browser tab.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function setStorage(name, store) {
  Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true, enumerable: false });
}
setStorage('localStorage', memoryStorage());
setStorage('sessionStorage', memoryStorage());

// A host + pad pair in a fresh room.
async function pairUp(padId) {
  const h = await connect(HTTP_URL, { transports: ['websocket'] });
  const res = await ack(h, 'host:create', {});
  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  const joined = waitFor(h, 'pad:join');
  const hr = await ack(p, 'pad:hello', { room: res.room, id: padId });
  assert(hr.ok, `pad joined (${hr.error})`);
  await joined;
  return { h, p, room: res.room, key: res.key };
}

// Resolves with the next `ev` payload matching `pred` (rejects after ms).
function waitFor(s, ev, ms = 2000, pred = () => true) {
  const promise = new Promise((resolve, reject) => {
    const fn = (p) => { if (pred(p)) { clearTimeout(t); s.off(ev, fn); resolve(p); } };
    const t = setTimeout(() => { s.off(ev, fn); reject(new Error(`timed out waiting for ${ev}`)); }, ms);
    s.on(ev, fn);
  });
  promise.catch(() => {});   // a failing test may never await it; avoid unhandled rejections
  return promise;
}

// Resolves true when no `ev` arrives within ms.
function expectNone(s, ev, ms = 400) {
  return new Promise((resolve) => {
    let got = null;
    const fn = (p) => { got = p; };
    s.on(ev, fn);
    setTimeout(() => { s.off(ev, fn); resolve(got === null ? true : got); }, ms);
  });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: expected ${jb}, got ${ja}`);
}

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} ${dim(`(${Date.now() - t0} ms)`)}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL  ${name}: ${err?.message || err}`);
  }
}
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

// ------------------------------------------------------------------ server

let server = null;
let serverLog = '';
async function startServer() {
  if (!spawnServer) return;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', ROOM_GRACE_MS: String(GRACE_MS), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.on('exit', (code) => { if (code) console.log(`server exited with ${code}\n${serverLog}`); });
}

async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    // Our own server must be the one answering (not a leftover on the same ports).
    if (server && server.exitCode !== null) throw new Error(`spawned server exited (${server.exitCode})\n${serverLog}`);
    if (!server || serverLog.includes('Desktop game')) {
      try {
        const r = await getUrl(`${HTTPS_URL}/api/info`);
        if (r.status === 200) return JSON.parse(r.body);
      } catch { /* not up yet */ }
    }
    await sleep(200);
  }
  throw new Error(`server did not start\n${serverLog}`);
}

// ------------------------------------------------------------------ tests

await startServer();
let info;
try {
  info = await waitForServer();
} catch (err) {
  console.log(`FAIL  server startup: ${err.message}`);
  server?.kill();
  process.exit(1);
}

await test('GET /api/info over http and https', async () => {
  const a = JSON.parse((await getUrl(`${HTTP_URL}/api/info`)).body);
  assertEq(a.httpPort, PORT, 'httpPort');
  assertEq(a.httpsPort, HTTPS_PORT, 'httpsPort');
  assert(Array.isArray(a.lanIps), 'lanIps array');
  assert(a.padBaseUrl.startsWith('https://') && new URL(a.padBaseUrl).port === String(HTTPS_PORT) && new URL(a.padBaseUrl).pathname === '/pad', `padBaseUrl ${a.padBaseUrl}`);
  assertEq(info.padBaseUrl, a.padBaseUrl, 'same info on https');
});

await test('static routes: /pad (https), /socket.io client, /vendor/three, http→https pad redirect', async () => {
  const pad = await getUrl(`${HTTPS_URL}/pad?room=ABCD`);
  assertEq(pad.status, 200, '/pad status');
  assert(/text\/html/.test(pad.headers['content-type']), 'pad content-type');
  assert(pad.body.includes('js/pad.js'), 'pad.html references pad.js');
  const sio = await getUrl(`${HTTPS_URL}/socket.io/socket.io.js`);
  assertEq(sio.status, 200, 'socket.io client');
  const three = await getUrl(`${HTTP_URL}/vendor/three/build/three.module.js`);
  assertEq(three.status, 200, 'three vendor');
  if (info.lanIps.length) {
    const r = await getUrl(`http://${info.lanIps[0]}:${PORT}/pad?room=ABCD`);
    assertEq(r.status, 302, 'LAN http /pad redirects');
    assertEq(r.headers.location, `https://${info.lanIps[0]}:${HTTPS_PORT}/pad?room=ABCD`, 'redirect target');
  }
  const local = await getUrl(`${HTTP_URL}/pad`);
  assertEq(local.status, 200, 'localhost http /pad is served directly');
});

await test('certificate SAN covers localhost, 127.0.0.1 and every LAN IP; validity < 825 days', async () => {
  const cert = await new Promise((resolve, reject) => {
    const sock = tls.connect({ host: 'localhost', port: HTTPS_PORT, rejectUnauthorized: false, servername: 'localhost' }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve(c);
    });
    sock.on('error', reject);
  });
  const san = cert.subjectaltname || '';
  assert(san.includes('DNS:localhost'), `SAN localhost: ${san}`);
  assert(san.includes('IP Address:127.0.0.1'), `SAN 127.0.0.1: ${san}`);
  for (const ip of info.lanIps) assert(san.includes(`IP Address:${ip}`), `SAN ${ip}: ${san}`);
  const days = (Date.parse(cert.valid_to) - Date.parse(cert.valid_from)) / 86400000;
  assert(days > 700 && days < 825, `validity ${days} days`);
  assert(cert.bits === 2048, `RSA bits ${cert.bits}`);
});

let host, pad1, pad2, pad3, room, hostKey;

await test('host:create over http → { room, padUrl, qrSvg, lanIps }', async () => {
  host = await connect(HTTP_URL);
  const res = await ack(host, 'host:create', {});
  assert(CODE_RE.test(res.room), `room code ${res.room}`);
  assertEq(res.padUrl, `${info.padBaseUrl}?room=${res.room}`, 'padUrl');
  assert(typeof res.qrSvg === 'string' && res.qrSvg.startsWith('<svg'), 'qrSvg is an SVG string');
  assert(Array.isArray(res.lanIps), 'lanIps');
  assert(typeof res.key === 'string' && res.key.length >= 8, 'host key');
  assertEq(res.padConnected, false, 'no pad yet');
  room = res.room;
  hostKey = res.key;
  const again = await ack(host, 'host:create', {});
  assertEq(again.room, room, 'repeat host:create on the same socket is idempotent');
});

await test('pad:hello over https (websocket) → ok + host gets pad:join', async () => {
  pad1 = await connect(HTTPS_URL, { transports: ['websocket'] });
  const joined = waitFor(host, 'pad:join');
  const res = await ack(pad1, 'pad:hello', { room: room.toLowerCase(), id: 'phone-one-1234' });
  assertEq(res.ok, true, 'hello ok');
  assertEq(res.hostConnected, true, 'hostConnected');
  assertEq((await joined).padId, 'phone-one-1234', 'padId');
});

await test('pad:input relayed to the host and sanitized', async () => {
  let got = waitFor(host, 'pad:input');
  pad1.emit('pad:input', { s: 0.5, g: 1, b: 0, d: 1, i: 1, p: 0, t: 123 });
  assertEq(await got, { s: 0.5, g: 1, b: 0, d: 1, i: 1, p: 0, t: 123 }, 'clean input');
  got = waitFor(host, 'pad:input');
  pad1.emit('pad:input', { s: 7, g: 'yes', b: true, d: 2, i: -5, p: 1.6, t: 'x', evil: '<script>' });
  assertEq(await got, { s: 1, g: 0, b: 1, d: 1, i: 0, p: 2, t: 0 }, 'clamped input');
  got = waitFor(host, 'pad:input');
  pad1.emit('pad:input', { s: -0.123456, g: 0, b: 0, d: 0, i: 0, p: 2, t: 5 });
  assertEq((await got).s, -0.1235, 'steer rounded to 4 decimals');
  const none = expectNone(host, 'pad:input', 300);
  pad1.emit('pad:input', 'garbage');
  pad1.emit('pad:input', null);
  pad1.emit('pad:input', [1, 2, 3]);
  assertEq(await none, true, 'garbage not relayed');
});

await test('pad:menu relayed (whitelisted actions only)', async () => {
  let got = waitFor(host, 'pad:menu');
  pad1.emit('pad:menu', { action: 'select', index: 3 });
  assertEq(await got, { action: 'select', index: 3 }, 'select');
  got = waitFor(host, 'pad:menu');
  pad1.emit('pad:menu', { action: 'difficulty', value: 'hard' });
  assertEq(await got, { action: 'difficulty', value: 'hard' }, 'difficulty');
  got = waitFor(host, 'pad:menu');
  pad1.emit('pad:menu', { action: 'start', extra: 'x'.repeat(5000) });
  assertEq(await got, { action: 'start' }, 'extra fields stripped');
  const none = expectNone(host, 'pad:menu', 300);
  pad1.emit('pad:menu', { action: 'difficulty', value: 'insane' });
  pad1.emit('pad:menu', { action: 'hack' });
  pad1.emit('pad:menu', { action: 'select' });
  assertEq(await none, true, 'invalid menu actions dropped');
});

const STATE = {
  screen: 'race',
  characters: [{ id: 'blaze', name: 'Blaze', cssColor: '#ff8a2a' }, { id: 'bolt', name: 'Bolt', cssColor: 'url(javascript:alert(1))' }],
  selected: 1,
  difficulty: 'hard',
  race: { state: 'racing', lap: 2, laps: 3, place: 4, racers: 8, item: 'rocket', itemCount: 1, rolling: false, countdown: 0, finished: false },
  results: null,
};

await test('host:state relayed to the pad and sanitized', async () => {
  const got = waitFor(pad1, 'host:state');
  host.emit('host:state', { ...STATE, characters: [...STATE.characters, ...Array(200).fill({ id: 'x', name: 'y'.repeat(100), cssColor: '#fff' })] });
  const s = await got;
  assertEq(s.screen, 'race', 'screen');
  assertEq(s.race.item, 'rocket', 'race.item');
  assertEq(s.race.place, 4, 'race.place');
  assertEq(s.characters.length, 16, 'characters capped');
  assertEq(s.characters[1].cssColor, '#8890b5', 'unsafe color replaced');
  assertEq(s.characters[2].name.length, 24, 'names truncated');
  host.emit('host:state', STATE);     // leave a clean state in the cache
  await waitFor(pad1, 'host:state');
  const none = expectNone(pad1, 'host:state', 300);
  host.emit('host:state', 'nope');
  host.emit('host:state', null);
  assertEq(await none, true, 'invalid state ignored');
});

await test('late-joining pad gets the cached host:state; old pad is kicked (replacement)', async () => {
  pad2 = await connect(HTTPS_URL);  // polling first (default transports)
  const kicked = waitFor(pad1, 'pad:kicked');
  const left = waitFor(host, 'pad:leave');
  const joined = waitFor(host, 'pad:join');
  const state = waitFor(pad2, 'host:state');
  const res = await ack(pad2, 'pad:hello', { room, id: 'phone-two-5678' });
  assertEq(res.ok, true, `hello ok (${res.error})`);
  assertEq((await kicked).reason, 'replaced', 'old pad kicked');
  assertEq((await left).padId, 'phone-one-1234', 'host pad:leave for the old pad');
  assertEq((await joined).padId, 'phone-two-5678', 'host pad:join for the new pad');
  const s = await state;
  assertEq(s.race.item, 'rocket', 'cached state delivered');
  assertEq(s.characters[1].cssColor, '#8890b5', 'cached state is the sanitized one');
});

await test('kicked pad can no longer send input', async () => {
  const none = expectNone(host, 'pad:input', 300);
  pad1.emit('pad:input', { s: 1, g: 1, b: 0, d: 0, i: 9, p: 0, t: 1 });
  assertEq(await none, true, 'kicked pad input dropped');
});

await test('same phone reconnecting replaces its stale socket silently (no pad:leave)', async () => {
  pad3 = await connect(HTTPS_URL, { transports: ['websocket'] });
  const kicked = waitFor(pad2, 'pad:kicked');
  const joined = waitFor(host, 'pad:join');
  const noLeave = expectNone(host, 'pad:leave', 400);
  const res = await ack(pad3, 'pad:hello', { room, id: 'phone-two-5678' });
  assertEq(res.ok, true, 'hello ok');
  assertEq((await kicked).reason, 'reconnected', 'stale socket told it was replaced');
  assertEq((await joined).padId, 'phone-two-5678', 'host pad:join');
  assertEq(await noLeave, true, 'no pad:leave for the same phone');
});

await test('host:event relayed and sanitized (vibrate / toast)', async () => {
  let got = waitFor(pad3, 'host:event');
  host.emit('host:event', { type: 'vibrate', pattern: [40, 'x', 5000] });
  assertEq(await got, { type: 'vibrate', pattern: [40, 0, 1000] }, 'vibrate');
  got = waitFor(pad3, 'host:event');
  host.emit('host:event', { type: 'toast', text: 'L'.repeat(200) });
  assertEq((await got).text.length, 80, 'toast truncated');
  const none = expectNone(pad3, 'host:event', 300);
  host.emit('host:event', { type: 'eval', code: 'x' });
  assertEq(await none, true, 'unknown event type dropped');
});

await test('net:ping answers', async () => {
  const r = await ack(pad3, 'net:ping', Date.now());
  assert(typeof r.t === 'number', 'ping reply');
});

await test('bad room codes are rejected', async () => {
  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  let free = 'ZZZZ';
  if (free === room) free = 'YYYY';
  let r = await ack(p, 'pad:hello', { room: free });
  assertEq([r.ok, r.code], [false, 'no_room'], 'unknown room');
  r = await ack(p, 'pad:hello', { room: 'IL0!' });
  assertEq([r.ok, r.code], [false, 'bad_code'], 'invalid characters');
  r = await ack(p, 'pad:hello', {});
  assertEq([r.ok, r.code], [false, 'bad_code'], 'missing code');
  r = await ack(p, 'pad:hello', 'ABCD');
  assertEq([r.ok, r.code], [false, 'bad_code'], 'non-object payload');
  p.emit('pad:hello', { room: free });   // no ack callback must not crash the server
  await sleep(100);
  p.close();
});

await test('a host connection cannot act as a pad', async () => {
  const r = await ack(host, 'pad:hello', { room });
  assertEq([r.ok, r.code], [false, 'role'], 'role guard');
});

await test('host disconnect → pad gets host:leave; reconnect with key reclaims the room', async () => {
  const left = waitFor(pad3, 'host:leave');
  host.close();
  await left;
  await sleep(100);
  host = await connect(HTTP_URL, { transports: ['websocket'] });
  const padJoin = waitFor(host, 'pad:join');
  const hostJoin = waitFor(pad3, 'host:join');
  const res = await ack(host, 'host:create', { room, key: hostKey });
  assertEq(res.room, room, 'same room reclaimed');
  assertEq(res.reclaimed, true, 'reclaimed flag');
  assertEq(res.padConnected, true, 'pad still connected');
  assertEq((await padJoin).padId, 'phone-two-5678', 'host told about the waiting pad');
  await hostJoin;
  const got = waitFor(host, 'pad:input');
  pad3.emit('pad:input', { s: -1, g: 1, b: 0, d: 0, i: 3, p: 0, t: 9 });
  assertEq((await got).s, -1, 'input flows again after reclaim');
});

await test('another desktop cannot steal a live room without the key', async () => {
  const other = await connect(HTTP_URL);
  const res = await ack(other, 'host:create', { room });
  assert(res.room !== room && CODE_RE.test(res.room), 'got a different room');
  other.close();
});

await test('host key lets a duplicate tab take over (old host gets host:replaced)', async () => {
  const tab2 = await connect(HTTP_URL);
  const replaced = waitFor(host, 'host:replaced');
  const res = await ack(tab2, 'host:create', { room, key: hostKey });
  assertEq(res.room, room, 'takeover with key');
  await replaced;
  const got = waitFor(tab2, 'pad:input');
  pad3.emit('pad:input', { s: 0.25, g: 0, b: 1, d: 0, i: 3, p: 0, t: 10 });
  assertEq((await got).s, 0.25, 'input goes to the new tab');
  const fresh = await ack(host, 'host:create', {});
  assert(fresh.room !== room, 'replaced tab can create a fresh room');
  host.close();
  host = tab2;
});

await test('a reserved (host-less) room cannot be claimed without its key', async () => {
  const left = waitFor(pad3, 'host:leave');
  host.close();
  await left;
  const stranger = await connect(HTTP_URL);
  const res = await ack(stranger, 'host:create', { room });
  assert(res.room !== room && CODE_RE.test(res.room), 'stranger gets a different room');
  const res2 = await ack(stranger, 'host:create', { room, key: 'wrong-key-123' });
  assert(res2.room !== room, 'wrong key rejected too');
  stranger.close();
  host = await connect(HTTP_URL);
  const hostJoin = waitFor(pad3, 'host:join');
  const res3 = await ack(host, 'host:create', { room, key: hostKey });
  assertEq(res3.room, room, 'owner reclaims with the key');
  await hostJoin;
});

await test(`room expires after the grace period (${GRACE_MS} ms) → pad gets room:closed`, async () => {
  const closed = waitFor(pad3, 'room:closed', GRACE_MS + 3000);
  host.close();
  const c = await closed;
  assertEq(c.reason, 'expired', 'reason');
  const r = await ack(pad3, 'pad:hello', { room });
  assertEq([r.ok, r.code], [false, 'no_room'], 'room gone');
  // A desktop coming back later (or after a server restart) recreates its code.
  host = await connect(HTTP_URL);
  const res = await ack(host, 'host:create', { room, key: hostKey });
  assertEq(res.room, room, 'free code re-created on request');
  const r2 = await ack(pad3, 'pad:hello', { room, id: 'phone-two-5678' });
  assertEq(r2.ok, true, 'pad rejoins the re-created room');
});

await test('server survives garbage on every event', async () => {
  const s = await connect(HTTP_URL);
  const junk = [null, 42, 'x'.repeat(10000), [1, 2], { room: { $gt: '' } }, { action: { toString: 1 } }, true];
  for (const ev of ['host:create', 'host:state', 'host:event', 'pad:hello', 'pad:input', 'pad:menu', 'net:ping', 'unknown']) {
    for (const j of junk) s.emit(ev, j);
  }
  await sleep(300);
  const r = await getUrl(`${HTTP_URL}/api/info`);
  assertEq(r.status, 200, 'still serving');
  s.close();
});

await test('heartbeat: pingInterval + pingTimeout ≤ 6 s (a phone that vanished is dropped quickly)', async () => {
  const r = await getUrl(`${HTTP_URL}/socket.io/?EIO=4&transport=polling`);
  const hs = JSON.parse(r.body.slice(r.body.indexOf('{')));
  assert(hs.pingInterval + hs.pingTimeout <= 6000, `ping ${hs.pingInterval} + ${hs.pingTimeout} ms`);
});

await test('pad:input burst over the rate limit: the final release edge reaches the host at once', async () => {
  const { h, p } = await pairUp('burst-pad-0001');
  const got = [];
  h.on('pad:input', (x) => got.push({ ...x, at: Date.now() }));
  await sleep(1100);                                 // fresh rate window
  const t0 = Date.now();
  // ~3 s of 60 Hz samples queued during a Wi-Fi stall (GAS held, steering
  // right), then the reliable release edge the pad sent last.
  for (let k = 0; k < 179; k++) p.emit('pad:input', { s: 0.8, g: 1, b: 0, d: 0, i: 0, p: 0, t: k + 1 });
  p.emit('pad:input', { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0, t: 999 });
  await sleep(400);
  const last = got[got.length - 1];
  assertEq([last?.g, last?.s, last?.t], [0, 0, 999], 'last packet relayed is the release');
  assert(last.at - t0 < 350, `release relayed promptly (${last.at - t0} ms)`);
  h.close(); p.close();
});

await test('pad:input over the rate limit is coalesced: the newest sample still reaches the host', async () => {
  const { h, p } = await pairUp('burst-pad-0002');
  let last = null;
  h.on('pad:input', (x) => { last = x; });
  await sleep(1100);
  for (let k = 0; k <= 300; k++) p.emit('pad:input', { s: k === 300 ? -0.5 : 0.3, g: 1, b: 0, d: 0, i: 0, p: 0, t: k + 1 });
  await sleep(1300);                                 // the budget resets within 1 s
  assertEq([last?.s, last?.t], [-0.5, 301], 'newest sample relayed when the window resets');
  h.close(); p.close();
});

await test('host:create vacantOnly: a reopened tab reclaims a host-less room, never a live one', async () => {
  const a = await connect(HTTP_URL);
  const ra = await ack(a, 'host:create', {});
  const noReplace = expectNone(a, 'host:replaced', 300);
  const b = await connect(HTTP_URL);
  const rb = await ack(b, 'host:create', { room: ra.room, key: ra.key, vacantOnly: true });
  assert(rb.room !== ra.room && CODE_RE.test(rb.room), 'live room not taken over');
  assertEq(await noReplace, true, 'live host keeps its room');
  a.close();
  await sleep(150);
  const c = await connect(HTTP_URL);
  const rc = await ack(c, 'host:create', { room: ra.room, key: ra.key, vacantOnly: true });
  assertEq([rc.room, rc.reclaimed], [ra.room, true], 'room held for the closed tab is reclaimed');
  b.close(); c.close();
});

// ---- PhoneLink (net.js) against the live server ----

await test('PhoneLink: connect, join, input (monotonic seqs), menu, state, event, reconnect', async () => {
  // net.js expects the browser global `io` (no URL = page origin).
  globalThis.io = (opts) => ioClient(HTTP_URL, { ...opts, forceNew: true });
  const { PhoneLink } = await import('../public/js/net.js');
  const link = new PhoneLink();
  const infoRes = await link.connect();
  assert(CODE_RE.test(infoRes.room) && infoRes.qrSvg.startsWith('<svg'), 'connect() resolves room info');
  assertEq(link.room, infoRes.room, 'link.room');
  assertEq(link.connected, false, 'no pad yet');

  const events = [];
  link.on('join', (p) => events.push(['join', p.padId]));
  link.on('leave', (p) => events.push(['leave', p.reason]));
  const menus = [];
  const offMenu = link.on('menu', (m) => menus.push(m));

  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  const firstState = waitFor(p, 'host:state');
  link.sendState({ screen: 'title', characters: [], selected: 0, difficulty: 'normal', race: null, results: null });
  const hr = await ack(p, 'pad:hello', { room: link.room, id: 'phonelink-pad-1' });
  assertEq(hr.ok, true, 'pad joined the PhoneLink room');
  assertEq((await firstState).screen, 'title', 'pad got the state cached via sendState');
  await sleep(150);
  assertEq(link.connected, true, 'link.connected after pad:join');

  const send = async (i, pz, s = 0.3) => { p.emit('pad:input', { s, g: 1, b: 0, d: 1, i, p: pz, t: Date.now() }); await sleep(60); };
  await send(5, 2);                         // baseline adopted, no press
  assertEq([link.input.itemSeq, link.input.pauseSeq], [0, 0], 'baseline does not fire presses');
  await send(6, 2);
  await send(8, 3);
  assertEq([link.input.itemSeq, link.input.pauseSeq], [3, 1], 'deltas accumulate');
  assertEq([link.input.steer, link.input.gas, link.input.drift], [0.3, 1, 1], 'analog/buttons');
  assert(link.active, 'active while input flows');

  p.emit('pad:menu', { action: 'go' });
  await sleep(100);
  assertEq(menus, [{ action: 'go' }], 'menu event');
  offMenu();

  const st = waitFor(p, 'host:state', 1000, (s) => s.screen === 'select');
  link.sendState({ screen: 'select', characters: [{ id: 'pip', name: 'Pip', cssColor: '#3a7bd5' }], selected: 0, difficulty: 'easy', race: null, results: null });
  assertEq((await st).difficulty, 'easy', 'sendState relayed');
  const ev = waitFor(p, 'host:event');
  link.sendEvent('vibrate', { pattern: [30, 20, 30] });
  assertEq(await ev, { type: 'vibrate', pattern: [30, 20, 30] }, 'sendEvent relayed');

  // Heartbeat: unchanged state is re-sent at NET.hostStateHz while a pad is connected.
  let beats = 0;
  const onBeat = () => { beats++; };
  p.on('host:state', onBeat);
  await sleep(700);
  p.off('host:state', onBeat);
  assert(beats >= 2, `heartbeat re-sends (${beats} in 700 ms)`);

  // Simulated host network drop: the link reconnects and reclaims its room.
  const oldRoom = link.room;
  link._socket.io.engine.close();
  await sleep(1800);
  assertEq(link.room, oldRoom, 'same room after reconnect');
  assert(link.socketConnected, 'socket reconnected');
  await send(0, 0);                          // new baseline after pad:join
  await send(1, 0);
  assertEq(link.input.itemSeq, 4, 'seq stays monotonic across rejoin');
  assert(events.some((e) => e[0] === 'leave') && events.filter((e) => e[0] === 'join').length >= 2, `join/leave events ${JSON.stringify(events)}`);

  const left = new Promise((r) => link.on('leave', r));
  p.close();
  await left;
  assertEq([link.connected, link.input.gas, link.input.steer], [false, 0, 0], 'inputs zeroed on pad leave');
  link.dispose();
  delete globalThis.io;
});

await test('PhoneLink: a driving phone that goes silent mid-race → inactive fast, then lost + pause; an idle one never pauses', async () => {
  globalThis.io = (opts) => ioClient(HTTP_URL, { ...opts, forceNew: true });
  setStorage('sessionStorage', memoryStorage());
  const { PhoneLink } = await import('../public/js/net.js');
  const RACE = { screen: 'race', characters: [], selected: 0, difficulty: 'normal', race: { state: 'racing', lap: 1, laps: 3, finished: false }, results: null };

  async function linkWithPad(padId) {
    const link = new PhoneLink();
    await link.connect();
    const ev = [];
    link.on('menu', (m) => { if (m.action === 'pause') ev.push(['pause', m.reason]); });
    link.on('lost', () => ev.push(['lost']));
    link.on('signal', (x) => ev.push(['signal', x.lost]));
    const p = await connect(HTTPS_URL, { transports: ['websocket'] });
    assertEq((await ack(p, 'pad:hello', { room: link.room, id: padId })).ok, true, 'pad joined');
    await sleep(150);
    link.sendState(RACE);
    const stream = (g) => setInterval(() => p.emit('pad:input', { s: 0.9, g, b: 0, d: 0, i: 0, p: 0, t: Date.now() }), 1000 / 60);
    return { link, p, ev, stream };
  }

  // Driving (GAS held), then silence: a locked phone / dead Wi-Fi keeps its socket open.
  const A = await linkWithPad('silent-pad-0001');
  let iv = A.stream(1);
  await sleep(1300);
  assert(A.link.active && A.link.input.gas === 1, 'driving');
  clearInterval(iv);
  await sleep(500);
  assert(!A.link.active, 'inactive 500 ms after a 60 Hz stream stopped');
  await sleep(900);
  assertEq(A.ev, [['lost'], ['pause', 'signal']], 'lost + local pause after ~1 s of silence');
  assertEq([A.link.input.gas, A.link.input.steer, A.link.signalLost, A.link.connected], [0, 0, true, true], 'inputs zeroed, pad still joined');
  iv = A.stream(1);
  await sleep(200);
  clearInterval(iv);
  assertEq(A.ev[A.ev.length - 1], ['signal', false], "'signal' when input resumes");
  A.link.dispose(); A.p.close();

  // A phone lying idle (no buttons, no menu taps) while someone else drives: no pause.
  const B = await linkWithPad('idle-pad-0001');
  iv = B.stream(0);
  await sleep(1100);
  clearInterval(iv);
  await sleep(1500);
  assertEq(B.ev, [], 'idle phone going silent does not pause');
  // …but one that just started the race from its menu counts as driving.
  B.p.emit('pad:menu', { action: 'go' });
  iv = B.stream(0);
  await sleep(600);
  clearInterval(iv);
  await sleep(1500);
  assertEq(B.ev, [['lost'], ['pause', 'signal']], 'phone used for the menu → pause');
  // Not in a live race (results / menus): no pause.
  B.link.sendState({ ...RACE, screen: 'results', race: null });
  B.p.emit('pad:menu', { action: 'again' });
  iv = B.stream(1);
  await sleep(400);
  clearInterval(iv);
  await sleep(1500);
  assertEq(B.ev.filter((e) => e[0] === 'pause').length, 1, 'no pause outside a live race');
  B.link.dispose(); B.p.close();
  delete globalThis.io;
});

await test('PhoneLink: closing the game tab and opening it again reclaims the paired room (localStorage)', async () => {
  globalThis.io = (opts) => ioClient(HTTP_URL, { ...opts, forceNew: true });
  setStorage('localStorage', memoryStorage());       // one browser profile…
  setStorage('sessionStorage', memoryStorage());     // …tab A
  const { PhoneLink } = await import('../public/js/net.js');
  const a = new PhoneLink();
  const ia = await a.connect();
  const p = await connect(HTTPS_URL, { transports: ['websocket'] });
  assertEq((await ack(p, 'pad:hello', { room: ia.room, id: 'reopen-pad-0001' })).ok, true, 'pad joined');
  await sleep(150);
  assert(a.connected, 'tab A paired');

  setStorage('sessionStorage', memoryStorage());     // tab B, opened while A is still open
  const b = new PhoneLink();
  const ib = await b.connect();
  await sleep(150);
  assert(ib.room !== ia.room, 'a second live tab gets its own room');
  assert(a.connected && !b.connected, 'the phone stays with tab A');
  b.dispose();

  const left = waitFor(p, 'host:leave', 3000);
  a.dispose();                                       // tab A closed
  await left;
  setStorage('sessionStorage', memoryStorage());     // tab C: the game opened again
  const back = waitFor(p, 'host:join', 3000);
  const c = new PhoneLink();
  const ic = await c.connect();
  assertEq(ic.room, ia.room, 'reopened tab reclaims the room');
  await back;
  await sleep(150);
  assert(c.connected, 'phone paired with the reopened tab, no rescan');
  c.dispose();
  p.close();
  delete globalThis.io;
});

await test('PhoneLink.connect() rejects cleanly when the server is unreachable', async () => {
  globalThis.io = (opts) => ioClient('http://localhost:1', { ...opts, forceNew: true });
  const { PhoneLink } = await import('../public/js/net.js');
  const link = new PhoneLink();
  let err = null;
  try { await link.connect(); } catch (e) { err = e; }
  assert(err instanceof Error, 'rejected with an Error');
  link.dispose();
  delete globalThis.io;
});

// ------------------------------------------------------------------ server restarts

for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
if (server) {
  server.kill('SIGTERM');
  await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
}

// The rest starts its own short-lived servers on the same ports, with a
// scratch certificate directory (the real .certs/ is never touched).
if (spawnServer) {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tootkart-certs-'));
  const temps = [];
  const startTemp = (env = {}) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1', NO_COLOR: '1', PAD_HOST: '', TOOTKART_CERT_DIR: certDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t = { proc, log: '' };
    temps.push(t);
    proc.stdout.on('data', (d) => { t.log += d; });
    proc.stderr.on('data', (d) => { t.log += d; });
    t.exited = new Promise((r) => proc.once('exit', (code) => r(code)));
    t.ready = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode})\n${t.log}`);
        if (t.log.includes('Desktop game')) return;
        await sleep(100);
      }
      throw new Error(`server did not start\n${t.log}`);
    })();
    t.ready.catch(() => {});                         // awaited where it matters
    return t;
  };
  const stopTemp = async (t) => { if (t.proc.exitCode === null && t.proc.signalCode === null) { t.proc.kill('SIGTERM'); await t.exited; } };
  const stopAll = async () => { for (const t of temps) await stopTemp(t); };
  const peerCert = () => new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port: HTTPS_PORT, rejectUnauthorized: false, servername: 'localhost' }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve({ fp: c.fingerprint256, san: c.subjectaltname || '' });
    });
    sock.on('error', reject);
  });

  await test('certificate kept across restarts while it covers the phone URL host; a new one keeps the old addresses', async () => {
    try { await certCase(); } finally { await stopAll(); }
  });
  async function certCase() {
    let t = startTemp({ PAD_HOST: '10.9.8.7' });
    await t.ready;
    const c1 = await peerCert();
    assert(c1.san.includes('IP Address:10.9.8.7'), `SAN has PAD_HOST: ${c1.san}`);
    await stopTemp(t);
    // PAD_HOST gone (like a VPN / bridge interface going away): the primary
    // address is still covered, so phones keep their certificate exception.
    t = startTemp();
    await t.ready;
    const c2 = await peerCert();
    assertEq(c2.fp, c1.fp, 'same certificate reused');
    assert(!/generated a new HTTPS certificate/.test(t.log), 'no regeneration logged');
    await stopTemp(t);
    t = startTemp({ PAD_HOST: '10.9.8.6' });          // a host the cached one does not cover
    await t.ready;
    const c3 = await peerCert();
    assert(c3.fp !== c1.fp, 'regenerated for an uncovered host');
    assert(c3.san.includes('IP Address:10.9.8.6') && c3.san.includes('IP Address:10.9.8.7'), `new SAN keeps the old addresses: ${c3.san}`);
    await stopTemp(t);
  }

  await test('port held by another program on 127.0.0.1 only → the server refuses to start', async () => {
    const other = http.createServer((req, res) => res.end('OTHER'));
    await new Promise((resolve, reject) => { other.once('error', reject); other.listen(PORT, '127.0.0.1', resolve); });
    const t = startTemp();
    const code = await Promise.race([t.exited, t.ready.then(() => 'started', () => null), sleep(15000).then(() => 'timeout')])
      .then((v) => (v === null ? t.exited : v));
    other.close();
    await stopAll();
    assertEq(code, 1, `exit code (${code === 'started' ? 'it started and served localhost behind the other program' : code})`);
    assert(/already in use/.test(t.log), `explains the clash: ${t.log.trim().split('\n').slice(-6).join(' | ')}`);
  });
  fs.rmSync(certDir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ done

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length && serverLog) console.log(`--- server log ---\n${serverLog}`);
process.exit(failed.length ? 1 : 0);
