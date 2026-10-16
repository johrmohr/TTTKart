// TOOT KART — desktop game bootstrap + app state machine (SPEC §12).
//
// Layout of this module:
//   1. boot()            renderer (ACES, sRGB, soft PCF shadows), scene, camera, track,
//                        world, effects, chase camera, audio, input, HUD, menus, phone link
//   2. Showroom          parked grid lineup + the character-select turntable + card portraits
//   3. AttractCam        title-screen flyover around the course
//   4. App state machine title → select → race (intro → countdown → racing) → results,
//                        pause overlay; every menu intent (keyboard, mouse, phone `pad:menu`)
//                        goes through action(name, payload)
//   5. Race              startRace() / teardownRace() / step() (one physics substep) /
//                        raceFrame() (once per frame) + bus event → HUD / audio / phone
//   6. Phone sync        host:state mirror + vibrate events
//   7. frame()           the requestAnimationFrame loop
//   8. window.__game     debug handle for automated tests
//
// items.js / ai.js / race.js are loaded with guarded dynamic imports: if one is
// missing or throws, menus and free driving keep working and the failing
// subsystem is switched off for the rest of that race (logged once).

import * as THREE from 'three';
import { RACE, PHYS, DIFFICULTY, GAME_TITLE, NET, ITEM_IDS, HIT } from './config.js';
import { bus } from './bus.js';
import { clamp, damp, lerp } from './utils.js';
import { getTrack, Track } from './track.js';
import { SPEEDWAY_DEF } from './track-def.js';
import { Party, equippedCharacter, viewports } from './party.js';
import { buildWorld, LIGHTHOUSE } from './world.js';
import { Kart, resolveKartCollisions } from './kart.js';
import { CHARACTERS, buildKartModel, disposeKartModel } from './characters.js';
import { KartView } from './kartview.js';
import { Effects } from './effects.js';
import { ChaseCamera } from './camera.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { PhoneLink } from './net.js';
import { HUD } from './hud.js';
import { Menus, showFatal } from './menus.js';

const params = new URLSearchParams(location.search);
const QUALITY = params.get('quality') === 'low' ? 'low' : 'high';

const menusRoot = document.getElementById('menus');
const hudRoot = document.getElementById('hud');
const canvas = document.getElementById('game');

// Phone `host:state.screen` for each app state.
const PHONE_SCREEN = { boot: 'loading', title: 'title', select: 'select', race: 'race', paused: 'paused', results: 'results' };
// Race fields are pushed to the phone the moment one changes, plus a refresh at
// NET.hostStateHz (net.js also dedupes, caps bursts and keeps its own heartbeat).
const PHONE_SYNC_HZ = NET.hostStateHz;
// Phone rumble patterns (ms on/off).
const VIBE = {
  hit: [80, 40, 80],          // player spun / tumbled / zapped
  itemGet: [30],
  lap: [40, 30, 40],
  finish: [100, 50, 100, 50, 200],
  countdown: [25],
  go: [90],
  bump: [20],
};
const RESULTS_AFTER_OVER = 1.1;    // seconds between race:over and the results screen
const RESULTS_FAILSAFE = RACE.resultsDelay + 8;   // show results even if race:over never comes

// Character-select turntable (on the start straight, just past the gantry) and
// its camera: kart framed in the right part of the screen, beside the cards.
const TURNTABLE_S = 11;
const SELECT_FOV = 32;
const SELECT_FRAMING = 0.25;
const RESULTS_FRAMING = -0.2;
// Title attract flyover. minClear = camera height above the road everywhere
// (above the 10.3 m start gantry and every tree); bridgeClear over the arch
// bridge (arches + top bracing reach 14.5 m above the deck).
const ATTRACT = {
  speed: 13, startS: -70, height: 21, heightVar: 7, lateral: 24, lookAhead: 42, rate: 1.4, fov: 56,
  minClear: 14, bridgeClear: 24, groundClear: 14,
};

// --------------------------------------------------------------- optional race modules

const RaceMods = { ItemSystem: null, AIDriver: null, Race: null, createAIDrivers: null, errors: {} };

async function loadRaceModules() {
  const specs = [['items', './items.js', 'ItemSystem'], ['ai', './ai.js', 'AIDriver'], ['race', './race.js', 'Race']];
  await Promise.all(specs.map(async ([key, path, name]) => {
    try {
      const mod = await import(path);
      if (typeof mod[name] !== 'function') throw new Error(`${path} does not export ${name}`);
      RaceMods[name] = mod[name];
      if (key === 'ai' && typeof mod.createAIDrivers === 'function') RaceMods.createAIDrivers = mod.createAIDrivers;
    } catch (err) {
      RaceMods.errors[key] = String(err && err.message || err);
      console.warn(`[main] ${path} unavailable (${RaceMods.errors[key]}) — continuing without it`);
    }
  }));
}

// =============================================================== 1. boot

let renderer, scene, camera, track, world, effects, chase, audio, input, hud, menus, phone;
let showroom, attract, startLights, party;
let links = [], raceSlots = [], chosenMap = "bay", currentMap = "bay";
const homeButton = document.createElement("button");
homeButton.className="race-home";homeButton.textContent="Ⅱ Pause / Menu";homeButton.hidden=true;document.body.append(homeButton);homeButton.onclick=()=>pause();

const app = {
  state: 'boot',          // 'boot' | 'title' | 'select' | 'race' | 'paused' | 'results'
  selected: 0,
  difficulty: 'normal',
  timeScale: 1,
};

function setBootText(text) {
  const t = document.getElementById('tk-boot-text');
  if (t) t.textContent = text;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function boot() {
  // ---- renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    showFatal(menusRoot, 'WebGL is not available',
      'TOOT KART needs a browser with WebGL enabled (Chrome, Edge, Firefox or Safari).\nTry enabling hardware acceleration and reload.');
    throw err;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  // three r186 removed PCFSoftShadowMap (it falls back with a warning); PCFShadowMap
  // is now the soft filtered mode that honours light.shadow.radius.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(ATTRACT.fov, window.innerWidth / window.innerHeight, 0.1, 2000);
  scene.add(camera);

  // ---- systems that need no world (the track itself is cheap, node-safe math)
  track = getTrack();
  audio = new AudioEngine();
  menus = new Menus(menusRoot, { audio, onAction: (a, p) => action(a, p, 'ui'), trackName: track.name || '' });
  menus.setMuted(audio.muted);
  audio.startMusic('menu');          // remembered until the first gesture unlocks audio
  const unlock = () => { audio.unlock(); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('touchstart', unlock, { capture: true, passive: true });

  links = [0,1,2,3].map(i=>new PhoneLink(i));
  phone = links[0];
  input = new Input({ phone });
  party = new Party(links, {launch:(slots,map)=>{raceSlots=slots;chosenMap=map;app.selected=slots[0].character;startRace();},sync:()=>syncPhone(),preview:i=>showroom?.setCharacter(i)});
  wirePhone();
  links.forEach((link,i)=>{
    if(i>0) link.on('menu',m=>{if(!party.menu(i,m)) {if(['pause','resume','quit','menu'].includes(m.action)) action(m.action,m,'phone');}});
    link.on('leave',()=>{if(R?.players.some(p=>p.slot.index===i)&&app.state==='race')pause();});
    if(i>0) link.connect().then(()=>syncPhone()).catch(err=>console.warn('Player '+(i+1)+' phone link: '+err.message));
  });
  phone.connect().then((info) => {
    menus.setPhone({ status: 'online', ...info, connected: phone.connected });
    syncPhone();
  }).catch((err) => {
    console.warn('[main] phone link unavailable — keyboard / gamepad only:', err.message);
    menus.setPhone({ status: 'offline', error: err.message });
  });

  // ---- world (let the boot splash paint first: the build is synchronous)
  setBootText('Paving Breezy Bay…');
  await nextFrame();
  world = buildWorld(scene, track, { renderer, quality: QUALITY });
  effects = new Effects(scene);
  chase = new ChaseCamera(camera);
  hud = new HUD(hudRoot, { audio });
  hud.setTrack(track);
  showroom = new Showroom(scene, track);
  attract = new AttractCam(camera, track, world);
  startLights = new StartLights(scene, track);

  setBootText('Fueling up the racers…');
  await loadRaceModules();
  showroom.setCharacter(app.selected, true);

  // ---- global listeners
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKeyDown);
  // Auto-pause when the tab is hidden, or the window loses focus while the
  // keyboard drives (a phone keeps steering through the socket: no pause then).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.state === 'race') pause();
  });
  window.addEventListener('blur', () => {
    if (app.state === 'race' && !R?.players.some(p=>p.slot.link.connected)) pause();
  });

  // Compile every material once before the first visible frame (avoids a hitch).
  attract.reset();
  try { renderer.compile(scene, camera); } catch { /* optional */ }
  goTitle(true);
  requestAnimationFrame(loop);

  // Card portraits are not needed until the select screen: render them when idle.
  setTimeout(() => {
    try { renderPortraits(); } catch (err) { console.warn('[main] portrait render failed', err); }
  }, 400);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  framing.applied = NaN;           // force the view offset to be recomputed
  applyFraming();
  camera.updateProjectionMatrix();
}

// App-level keys that Input does not map: M = mute, H = controls help
// (action('help') only refuses to OPEN it mid-race; closing always works).
function onKeyDown(e) {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'KeyM') action('mute', {}, 'keyboard');
  else if (e.code === 'KeyH' && app.state !== 'boot') action('help', {}, 'keyboard');
}

// --------------------------------------------------------------- framing
// Horizontal view offset (fraction of the screen width) so the 3D subject sits
// beside the menu panels instead of under them: select → kart on the right,
// results → orbiting kart on the left.
const framing = { x: 0, target: 0, applied: 0 };

function setFraming(x, snap = false) {
  framing.target = x;
  if (snap) framing.x = x;
}

function applyFraming() {
  if (framing.x === framing.applied) return;
  framing.applied = framing.x;
  const w = window.innerWidth, h = window.innerHeight;
  if (Math.abs(framing.x) < 1e-4) camera.clearViewOffset();
  else camera.setViewOffset(w, h, -framing.x * w, 0, w, h);
}

function updateFraming(dt) {
  if (framing.x !== framing.target) {
    framing.x = damp(framing.x, framing.target, 5, dt);
    if (Math.abs(framing.x - framing.target) < 5e-4) framing.x = framing.target;
  }
  applyFraming();
}

function setFov(fov) {
  if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// =============================================================== 2. Showroom

// The 8 racers parked on the starting grid (title / select backdrop) plus the
// character-select turntable with the selected kart, and a matching camera pose.
class Showroom {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.group = new THREE.Group();
    this.group.name = 'Showroom';
    scene.add(this.group);
    this.time = 0;

    // ---- grid lineup (low LOD, static)
    this.lineup = CHARACTERS.map((def, i) => {
      const slot = track.gridSlot(i);
      const m = buildKartModel(def, { lod: 'low' });
      m.position.copy(slot.position);
      m.rotation.y = slot.yaw;
      this.group.add(m);
      return m;
    });

    // ---- turntable
    const f = track.frameAt(TURNTABLE_S);
    this.center = track.pointAt(TURNTABLE_S, 0);
    this.tangent = f.tangent.clone();
    this.right = f.right.clone();
    const table = new THREE.Group();
    table.position.copy(this.center);
    this.table = table;
    this.group.add(table);
    this._mats = [];
    this._geos = [];
    const mat = (o) => { const m = new THREE.MeshStandardMaterial(o); this._mats.push(m); return m; };
    const geo = (g) => { this._geos.push(g); return g; };
    const base = new THREE.Mesh(geo(new THREE.CylinderGeometry(1.6, 1.72, 0.22, 56)), mat({ color: 0x241b4a, roughness: 0.55, metalness: 0.35 }));
    base.position.y = 0.11;
    base.castShadow = true; base.receiveShadow = true;
    table.add(base);
    this.spin = new THREE.Group();
    this.spin.position.y = 0.22;
    table.add(this.spin);
    const top = new THREE.Mesh(geo(new THREE.CylinderGeometry(1.46, 1.46, 0.1, 56)), mat({ color: 0x3b2f78, roughness: 0.42, metalness: 0.2 }));
    top.position.y = 0.05;
    top.receiveShadow = true;
    this.spin.add(top);
    // chevron studs around the rim (show the rotation)
    const studGeo = geo(new THREE.BoxGeometry(0.24, 0.06, 0.11));
    const studMat = mat({ color: 0xffd23a, roughness: 0.4, emissive: 0x8a5a00, emissiveIntensity: 0.4 });
    const studs = new THREE.InstancedMesh(studGeo, studMat, 16);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      p.set(Math.sin(a) * 1.3, 0.11, Math.cos(a) * 1.3);
      q.setFromAxisAngle(up, a);
      studs.setMatrixAt(k, m4.compose(p, q, s));
    }
    studs.receiveShadow = true;
    this.spin.add(studs);
    this._studs = studs;
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xff7a1f, toneMapped: false });
    this._mats.push(this.ringMat);
    const ring = new THREE.Mesh(geo(new THREE.TorusGeometry(1.67, 0.05, 8, 72)), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.2;
    table.add(ring);

    // ---- preview models (built lazily, cached per character)
    this.models = new Map();
    this.current = null;
    this.selected = -1;
    this.pop = 1;
    this.spinRate = 0.55;
    this.spinBoost = 0;
    this.mode = 'title';

    // select camera pose: in front of the kart, looking back toward the gantry
    this.camPos = this.center.clone()
      .addScaledVector(this.tangent, 10.2).addScaledVector(this.right, 1.5).add(new THREE.Vector3(0, 2.45, 0));
    this.camLook = this.center.clone().add(new THREE.Vector3(0, 0.5, 0));
    this.focus = this.center.clone();
    this._tmp = new THREE.Vector3();
    this.setMode('title');
  }

  setMode(mode) {
    this.mode = mode;
    this.group.visible = mode !== 'race';
    this.table.visible = mode === 'select';
    this._syncLineup();
  }

  _syncLineup() {
    for (let i = 0; i < this.lineup.length; i++) this.lineup[i].visible = !(this.mode === 'select' && i === this.selected);
  }

  setCharacter(index, instant = false) {
    if (index === this.selected) return;
    this.selected = index;
    const def = CHARACTERS[index];
    let model = this.models.get(def.id);
    if (!model) {
      model = buildKartModel(def, { lod: 'high' });
      this.models.set(def.id, model);
    }
    if (this.current) this.spin.remove(this.current);
    this.current = model;
    model.rotation.y = 0;
    this.spin.add(model);
    this.ringMat.color.set(def.color);
    this._syncLineup();
    if (!instant) {
      this.pop = 0;
      this.spinBoost = 5;
      if (effects && this.mode === 'select') {
        this._tmp.copy(this.center).y += 1.0;
        effects.burst('sparkle', this._tmp, { count: 26, color: def.color, spread: 3.2 });
      }
    }
  }

  update(dt) {
    this.time += dt;
    if (!this.table.visible) return;
    this.spinBoost *= Math.exp(-3.2 * dt);
    this.spin.rotation.y += (this.spinRate + this.spinBoost) * dt;
    // pop-in: elastic overshoot after a character change
    if (this.pop < 1) this.pop = Math.min(1, this.pop + dt / 0.5);
    const t = this.pop;
    const e = t >= 1 ? 1 : 1 - Math.pow(2, -9 * t) * Math.cos(t * 9.5);
    const sc = 0.45 + 0.55 * e;
    if (this.current) {
      this.current.scale.setScalar(sc * (this.current.userData.kartScale || 1));
      const ud = this.current.userData;
      // idle life: engine rumble + driver glancing around
      if (ud.body) ud.body.position.y = Math.sin(this.time * 23) * 0.006 + Math.max(0, Math.sin(this.time * 2.1)) * 0.012;
      if (ud.head) ud.head.rotation.y = Math.sin(this.time * 0.9) * 0.3;
    }
  }

  // Select-screen camera with a slow "breathing" drift.
  applyCamera(cam) {
    const t = this.time;
    cam.position.copy(this.camPos).addScaledVector(this.right, Math.sin(t * 0.35) * 0.35);
    cam.position.y += Math.sin(t * 0.5) * 0.08;
    cam.lookAt(this.camLook);
    setFov(SELECT_FOV);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const m of this.lineup) disposeKartModel(m);
    for (const m of this.models.values()) disposeKartModel(m);
    this.models.clear();
    this._studs.dispose();
    for (const m of this._mats) m.dispose();
    for (const g of this._geos) g.dispose();
  }
}

// Card portraits: each kart rendered once by a tiny offscreen renderer (transparent
// background, same tone mapping), handed to the menus as data URLs.
function renderPortraits() {
  const W = 360, H = 260;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.setClearColor(0x000000, 0);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x6b5a9a, 1.7));
  const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
  key.position.set(3, 6, 5);
  const rim = new THREE.DirectionalLight(0xbfe6ff, 1.6);
  rim.position.set(-5, 3, -4);
  sc.add(key, rim);
  const cam = new THREE.PerspectiveCamera(25, W / H, 0.1, 50);
  const a = 0.62;
  cam.position.set(Math.sin(a) * 5.4, 1.75, Math.cos(a) * 5.4);
  cam.lookAt(0, 0.66, 0);
  for (const def of CHARACTERS) {
    const m = buildKartModel(def, { lod: 'high' });
    sc.add(m);
    r.render(sc, cam);
    const thumbnail = cv.toDataURL('image/png');
    menus.setThumbnail(def.id, thumbnail);
    party.thumbnails.set(def.id, thumbnail);
    sc.remove(m);
    disposeKartModel(m);
  }
  r.dispose();
  r.forceContextLoss();
  party.render();
}

// =============================================================== 3. AttractCam

// Title flyover: glides along the course high above the road, swinging from
// side to side, always clear of terrain, the gantry, bridge arches and lighthouse.
class AttractCam {
  constructor(cam, track, world) {
    this.cam = cam;
    this.track = track;
    this.world = world;
    this.s = 0;
    this.t = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._l = new THREE.Vector3();
    this.minClear = this._clearanceProfile();
  }

  // Per-sample minimum height above the road, raised around the bridge and
  // blurred so the camera eases up and down instead of popping.
  _clearanceProfile() {
    const tr = this.track, N = tr.N, sp = tr.spacing;
    const raw = new Float32Array(N).fill(ATTRACT.minClear);
    for (const z of tr.zones) {
      if (z.type !== 'bridge') continue;
      for (let i = 0; i < N; i++) {
        const s = i * sp;
        const inside = tr.deltaS(z.s0 - 12, s) >= 0 && tr.deltaS(s, z.s1 + 12) >= 0;
        if (inside) raw[i] = Math.max(raw[i], ATTRACT.bridgeClear);
      }
    }
    const out = new Float32Array(N), R = Math.round(30 / sp);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let k = -R; k <= R; k++) sum += raw[(i + k + N) % N];
      out[i] = Math.max(ATTRACT.minClear, sum / (2 * R + 1), raw[i] > ATTRACT.minClear ? ATTRACT.bridgeClear * 0.98 : 0);
    }
    return out;
  }

  reset() {
    this.s = this.track.wrapS(ATTRACT.startS);
    this.t = 0;
    this._target(this._p, this._l);
    this.pos.copy(this._p);
    this.look.copy(this._l);
    this._apply();
  }

  _target(outPos, outLook) {
    const tr = this.track, t = this.t;
    const lat = Math.sin(t * 0.083) * ATTRACT.lateral;
    tr.pointAt(this.s, lat, outPos);
    const road = outPos.y;
    const clear = this.minClear[Math.floor(this.s / tr.spacing) % tr.N] || ATTRACT.minClear;
    let y = road + Math.max(clear, ATTRACT.height + Math.sin(t * 0.121 + 1.1) * ATTRACT.heightVar);
    const ground = this.world.getGroundHeight ? this.world.getGroundHeight(outPos.x, outPos.z) : -Infinity;
    if (Number.isFinite(ground)) y = Math.max(y, ground + ATTRACT.groundClear);
    const dl = Math.hypot(outPos.x - LIGHTHOUSE.x, outPos.z - LIGHTHOUSE.z);
    if (dl < 40) y = Math.max(y, lerp(52, y, dl / 40));
    outPos.y = y;
    tr.pointAt(this.s + ATTRACT.lookAhead, -lat * 0.2, outLook);
    outLook.y += 1.5;
  }

  update(dt) {
    this.t += dt;
    this.s = this.track.wrapS(this.s + dt * ATTRACT.speed);
    this._target(this._p, this._l);
    const k = 1 - Math.exp(-ATTRACT.rate * dt);
    this.pos.lerp(this._p, k);
    this.look.lerp(this._l, k * 1.4);
    this._apply();
  }

  _apply() {
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    setFov(ATTRACT.fov);
    this.focus.copy(this.look);
  }
}

// =============================================================== 3b. StartLights

// The start gantry's five lights come alive for each race: dark during the
// intro, filling red on "3" / "2" / "1", all green at GO (and for the rest of
// the race). One instanced draw call, drawn just in front of the lenses that
// world.js bakes into the gantry (those show a static red/green look otherwise).
const LIGHT_RED_COUNT = { 3: 2, 2: 4, 1: 5 };     // lenses lit red per countdown beat
const LIGHT_COLOR = { off: new THREE.Color(0x3a1418), red: new THREE.Color(0xff2a1a), green: new THREE.Color(0x3dff6a) };

class StartLights {
  constructor(scene, track) {
    const f = track.frameAt(0);
    this.geo = new THREE.CylinderGeometry(0.36, 0.36, 0.04, 16);
    this.mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, 5);
    this.mesh.name = 'StartLights';
    // same placement as world.js's gantry lenses (lateral k·1.6 m, 9.7 m up),
    // nudged 0.1 m further toward the grid so they cover the baked ones
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, f.yaw, 0, 'YXZ'));
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    for (let k = 0; k < 5; k++) {
      const lat = (k - 2) * 1.6, along = -0.65;
      p.set(f.x + f.right.x * lat + f.tangent.x * along, f.y + 9.7, f.z + f.right.z * lat + f.tangent.z * along);
      this.mesh.setMatrixAt(k, m4.compose(p, q, s));
      this.mesh.setColorAt(k, LIGHT_COLOR.off);
    }
    this.mesh.computeBoundingSphere();
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** reds = lenses lit red (0..5); green = all green (GO). */
  set(reds, green = false) {
    for (let k = 0; k < 5; k++) this.mesh.setColorAt(k, green ? LIGHT_COLOR.green : k < reds ? LIGHT_COLOR.red : LIGHT_COLOR.off);
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }
}

// =============================================================== 4. App state machine

function setScreen(state) {
  app.state = state;
  homeButton.hidden = state !== 'race' && state !== 'paused';
  // the controls overlay belongs to the screen it was opened on (the phone can
  // start / restart a race while it is up on the desktop)
  menus.toggleHelp(false);
  menus.show(state === 'race' ? 'race' : state);
  syncPhone();
}

function goTitle(first = false) {
  teardownRace();
  showroom.setMode('title');
  attract.reset();
  setFraming(0, true);
  audio.startMusic('menu');
  if (!first) menus.dip();
  setScreen('title');
  menus.show('race');
  party.show('title');
  homeButton.hidden=true;
}

function goSelect() {
  goTitle();
  party.show('lobby');
}

function pause() {
  if (app.state !== 'race' || !R) return;
  app.state = 'paused';
  menus.show('paused');
  audio.setEngineActive(false);
  audio.play('menuBack', { volume: 0.7 });
  input.releaseAll();
  syncPhone();
}

function resume() {
  if (app.state !== 'paused' || !R) return;
  // the Enter that pressed "Resume" is still a confirm edge in this frame's
  // raceFrame: it must not also skip the intro
  R.inputGuard = R.frames + 1;
  audio.setEngineActive(true);
  audio.play('menuSelect', { volume: 0.7 });
  setScreen('race');
  if (R.race && R.race.state === 'intro') menus.setIntroHint(true);
}

/**
 * Every menu intent from keyboard (via Menus.handleNav), mouse and the phone
 * (`pad:menu`, SPEC §11) lands here.
 */
function action(name, payload = {}, source = 'ui') {
  if (party?.visible && ['start','go','select'].includes(name)) {party.menu(0,{...payload,action:name});return;}
  const st = app.state;
  switch (name) {
    case 'start':
      if (st === 'title') { audio.play('menuSelect'); goSelect(); }
      break;
    case 'select': {
      const i = Math.round(Number(payload && payload.index));
      if (st !== 'select' || !Number.isFinite(i) || i < 0 || i >= CHARACTERS.length) break;
      if (i !== app.selected) {
        app.selected = i;
        menus.setSelected(i);
        showroom.setCharacter(i);
        audio.play('menuMove');
        syncPhone();
      }
      break;
    }
    case 'difficulty': {
      const v = payload && payload.value;
      if (st !== 'select' || !DIFFICULTY[v]) break;
      if (v !== app.difficulty) {
        app.difficulty = v;
        menus.setDifficulty(v);
        audio.play('menuMove');
        syncPhone();
      }
      break;
    }
    case 'go':
      if (st === 'select') { audio.play('menuSelect'); startRace(); }
      else if (st === 'title') { audio.play('menuSelect'); goSelect(); }
      break;
    case 'back':
      if (st === 'select') { audio.play('menuBack'); goTitle(); }
      break;
    case 'pause':
      if (st === 'race') pause();
      break;
    case 'resume':
      if (st === 'paused') resume();
      break;
    case 'restart':
      if (st === 'paused' || st === 'results') { audio.play('menuSelect'); startRace(); }
      break;
    case 'quit':
      if (st === 'paused' || st === 'results') { audio.play('menuBack'); goTitle(); }
      break;
    case 'again':
      if (st === 'results') { audio.play('menuSelect'); startRace(); }
      break;
    case 'menu':
      if (st === 'results' || st === 'paused') { audio.play('menuBack'); goSelect(); }
      break;
    case 'mute': {
      const muted = audio.toggleMute();
      menus.setMuted(muted);
      menus.toast(muted ? 'Sound off' : 'Sound on', { icon: muted ? '🔇' : '🔊', duration: 1.4 });
      break;
    }
    case 'help': {
      // closing works on every screen; opening is for menus only (not mid-race)
      const open = payload && payload.close ? false : !menus.helpOpen;
      if (open === menus.helpOpen || (open && (st === 'race' || st === 'boot'))) break;
      menus.toggleHelp(open);
      audio.play(open ? 'menuSelect' : 'menuBack', { volume: 0.7 });
      break;
    }
    default:
      if (source === 'phone') console.warn('[main] unknown phone menu action', name);
  }
}

// Keyboard / gamepad: pause toggles first (Esc is both pause and back), then menus.
function handleInput() {
  const st = app.state;
  if(party?.visible){if(input.menu.back)party.back();return;}
  if (st === 'race') {
    if (input.pausePressed) pause();
    return;
  }
  // the phone's ⏸ only ever pauses (the pad has its own Resume button): a quick
  // double tap must not resume before the pad has seen the paused screen
  if (st === 'paused' && input.pausePressed && !input.phonePausePressed && !menus.helpOpen) { resume(); return; }
  if (st !== 'boot') menus.handleNav(input.menu);
}

// =============================================================== 5. Race

let R = null;       // live race context (null outside races)

const _sfx = { volume: 1, pitch: 1, pan: 0 };
const _camRight = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _confettiPos = new THREE.Vector3();

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Constructs an optional subsystem; logs and returns null on failure.
function tryCreate(key, fn) {
  try { return fn(); } catch (err) {
    console.error(`[main] ${key} failed to start — racing without it`, err);
    return null;
  }
}

function startRace() {
  teardownRace();
  party.hide();
  if(!raceSlots.length)raceSlots=[{...party.slots[0],character:app.selected}];
  if(currentMap!==chosenMap){
    showroom.dispose();world.dispose();
    track=chosenMap==='sahur'?new Track(SPEEDWAY_DEF):getTrack();
    world=buildWorld(scene,track,{renderer,quality:QUALITY});
    showroom=new Showroom(scene,track);attract=new AttractCam(camera,track,world);hud.setTrack(track);
    currentMap=chosenMap;
  }
  const diffKey = DIFFICULTY[app.difficulty] ? app.difficulty : 'normal';
  const diff = DIFFICULTY[diffKey];

  const cpuDefs = shuffle(CHARACTERS.slice());
  const karts = new Array(RACE.racers);
  const players=raceSlots.map((slot,i)=>{
    const character=equippedCharacter(slot);
    const kart=new Kart({id:`player${slot.index}`,character,track,isPlayer:true});
    karts[RACE.racers-1-i]=kart;
    const cam=i===0?camera:new THREE.PerspectiveCamera(60,1,.1,2000);
    const controller=i===0?chase:new ChaseCamera(cam);controller.setTarget(kart);controller.snap();
    return {slot,kart,camera:cam,chase:controller,itemSeq:slot.link.input.itemSeq,pauseSeq:slot.link.input.pauseSeq};
  });
  const player=players[0].kart;
  let ci=0;
  for(let slot=0;slot<karts.length;slot++) if(!karts[slot]) {
    const c=cpuDefs[ci++ % cpuDefs.length];
    karts[slot]=new Kart({id:`cpu${slot}`,character:c,track,isPlayer:false});
  }
  karts.forEach((k, slot) => { k.placeOnGrid(track.gridSlot(slot)); k.frozen = true; });

  // ---- race logic (guarded)
  const { ItemSystem, AIDriver, Race } = RaceMods;
  const items = ItemSystem ? tryCreate('items', () => new ItemSystem({ track, karts, scene, effects, rng: Math.random })) : null;
  const race = Race ? tryCreate('race', () => new Race({ track, karts, laps: RACE.laps, player })) : null;
  // CPU drivers: skills spread around the difficulty's aiSkill (shuffled per race);
  // per-character personalities and item aggression are applied inside ai.js.
  const drivers = [];
  if (AIDriver) {
    tryCreate('ai', () => {
      if (RaceMods.createAIDrivers) {
        drivers.push(...RaceMods.createAIDrivers(karts, { track, difficulty: diffKey, rng: Math.random, player }));
      } else {
        const offsets = shuffle([-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12]);
        let oi = 0;
        for (const k of karts) {
          if (k.isPlayer) continue;
          const skill = clamp(diff.aiSkill + offsets[oi++ % offsets.length], 0.15, 1);
          drivers.push(new AIDriver(k, { track, difficulty: diffKey, skill, rng: Math.random }));
        }
      }
      return true;
    }) || (drivers.length = 0);
  }

  // ---- views + camera
  const views = karts.map((k) => new KartView(k, scene, effects));
  effects.clear();
  // Compile every material the race can show now (hidden item visuals included),
  // behind the dip-to-black, instead of hitching the first time a rocket, stink
  // puff or zap bolt appears mid-race. Cached programs make this ~free later.
  try { renderer.compile(scene, camera); } catch { /* optional warm-up */ }
  showroom.setMode('race');
  setFraming(0, true);
  chase.lookBack = false;
  chase.setTarget(player);

  R = {
    karts, player, players, items, race, drivers, views,
    difficulty: diffKey,
    offs: [],
    autopilot: false,
    playerDriver: null,
    finishedAt: -1,
    overAt: -1,
    clock: 0,            // real seconds since the race was set up
    frames: 0,           // frames since setup
    inputGuard: 1,       // no intro skip until frames > this (the Enter that started / resumed the race)
    bannerUntil: 0,      // r.clock until which a big HUD banner owns the flash slot
    phoneTimer: 0,
    phoneKey: -1,        // packed race fields last pushed to the phone (change detection)
    failed: new Set(),
    hudCtx: { player, race, karts, items, phoneConnected: false },
    aiCtx: { karts, items, race, player },
    engine: { speed: 0, maxSpeed: 1, throttle: 0, drifting: false, boosting: false, grounded: true, offroad: false, active: true },
    phoneRace: { state: 'intro', lap: 1, laps: RACE.laps, place: 0, racers: karts.length, item: null, itemCount: 0, rolling: false, countdown: 0, finished: false },
  };
  subscribeRaceEvents();
  startLights.set(0);

  hud.reset();
  audio.stopMusic(0.4);
  audio.setEngineActive(true);
  menus.dip();
  setScreen('race');
  homeButton.hidden=false;
  renderer.setPixelRatio(Math.min(players.length>1?1.25:2,window.devicePixelRatio||1));

  if (race) {
    try {
      race.startIntro();
      chase.startIntro(track, RACE.introSeconds);
      menus.setIntroHint(true);
      audio.playJingle('start');
    } catch (err) {
      subsystemFailed('race', err);
    }
  } else {
    freeDrive();
  }
}

// No race logic: unfreeze everyone and just drive.
function freeDrive() {
  if (!R) return;
  for (const k of R.karts) k.frozen = false;
  startLights.set(5, true);
  chase.snap();
  hud.show();
  audio.startMusic('race');
  menus.setIntroHint(false);
}

function subsystemFailed(key, err) {
  if (!R || R.failed.has(key)) return;
  R.failed.add(key);
  console.error(`[main] ${key} threw — disabled for the rest of this race`, err);
  if (key === 'ai') R.drivers.length = 0;
  else if (key === 'items') { try { R.items.dispose(); } catch { /* ignore */ } R.items = null; R.hudCtx.items = null; R.aiCtx.items = null; }
  else if (key === 'race') { R.race = null; R.hudCtx.race = null; R.aiCtx.race = null; freeDrive(); }
}

function teardownRace() {
  if (!R) return;
  const r = R;
  R = null;
  if(party)party.overlay.hidden=true;
  homeButton.hidden=true;
  for (const off of r.offs) off();
  r.offs.length = 0;
  for (const p of r.players.slice(1))p.chase.dispose();
  for (const v of r.views) v.dispose();
  for (const d of r.drivers) if (d && typeof d.dispose === 'function') { try { d.dispose(); } catch { /* ignore */ } }
  if (r.items) { try { r.items.dispose(); } catch (err) { console.error('[main] items.dispose failed', err); } }
  if (r.race && typeof r.race.dispose === 'function') { try { r.race.dispose(); } catch { /* ignore */ } }
  effects.clear();
  hud.reset();
  hud.hide();
  audio.setEngineActive(false);
  audio.setMusicIntensity(0);
  chase.lookBack = false;
  chase.setTarget(null);
  chase.mode = 'chase';
  startLights.hide();
  menus.setIntroHint(false);
  phoneResults = null;
}

/** One physics substep (SPEC §12 order): AI → items → karts → collisions → race. */
function step(h) {
  const r = R;
  const drivers = r.drivers;
  if (drivers.length) {
    try { for (let i = 0; i < drivers.length; i++) drivers[i].update(h, r.aiCtx); } catch (err) { subsystemFailed('ai', err); }
  }
  if (r.items) {
    try { r.items.update(h, r.race); } catch (err) { subsystemFailed('items', err); }
  }
  const karts = r.karts;
  for (let i = 0; i < karts.length; i++) karts[i].update(h);
  resolveKartCollisions(karts);
  if (r.race) {
    try { r.race.update(h); } catch (err) { subsystemFailed('race', err); }
  }
}

/** Per-frame race update: input → substeps → views → camera → HUD → engine audio. */
function raceFrame(dt) {
  const r = R;
  const P = r.player;
  const live = app.state === 'race' || app.state === 'results';
  r.clock += dt;
  r.frames++;

  // ---- player input (once per frame, before the substeps)
  if (!r.autopilot && app.state === 'race' && r.players.length===1 && r.players[0].slot.index===0) {
    const pi = P.input;
    pi.steer = input.steer;
    pi.throttle = input.throttle;
    pi.brake = input.brake;
    pi.drift = input.drift;
    if (input.itemPressed) pi.useItem = true;
    chase.lookBack = input.lookBack;
  } else {
    chase.lookBack = false;
  }

  if(app.state==='race') for(const p of r.players){
    if(p.kart.finished)continue;
    const link=p.slot.link, src=link.input;
    if(r.players.length>1 || p.slot.index!==0){
      p.kart.input.steer=link.active?src.steer:0;
      p.kart.input.throttle=link.active?src.gas:0;
      p.kart.input.brake=link.active?src.brake:1;
      p.kart.input.drift=link.active&&!!src.drift;
      if(src.itemSeq>p.itemSeq)p.kart.input.useItem=true;
      if(src.pauseSeq>p.pauseSeq)pause();
    }
    p.itemSeq=src.itemSeq;p.pauseSeq=src.pauseSeq;
  }

  // ---- intro skip
  if (r.frames > r.inputGuard && r.race && r.race.state === 'intro' && app.state === 'race' && (input.menu.confirm || input.itemPressed)) skipIntro();

  // ---- simulate
  let simDt = 0;
  if (live) {
    simDt = Math.min(dt * app.timeScale, PHYS.maxFrameDt * Math.max(1, app.timeScale));
    const n = Math.max(1, Math.ceil(simDt / PHYS.maxSubstep - 1e-6));
    const h = simDt / n;
    for (let i = 0; i < n && R === r; i++) step(h);
    if (R !== r) return;          // a handler tore the race down mid-frame
  }

  // ---- views + camera
  for (let i = 0; i < r.views.length; i++) r.views[i].update(simDt, camera);
  chase.update(simDt);
  for(const p of r.players.slice(1))p.chase.update(simDt);

  // ---- HUD + engine audio
  r.hudCtx.phoneConnected = phone.connected;
  hud.update(app.state === 'paused' ? 0 : dt, r.hudCtx);
  if(r.players.length>1)hud.hide();
  party.updateHUD(r.players,r.race,app.state==='paused');
  const e = r.engine;
  e.speed = P.speed; e.maxSpeed = P.maxSpeed; e.throttle = P.input.throttle;
  e.drifting = P.drift.active; e.boosting = P.boostTimer > 0; e.grounded = P.grounded;
  e.offroad = P.surface === 'offroad'; e.active = app.state === 'race';
  audio.updateEngine(dt, e);

  // ---- end of race → results
  if (app.state === 'race') {
    const now = r.clock;
    if ((r.overAt >= 0 && now - r.overAt >= RESULTS_AFTER_OVER) || (r.players.length===1 && r.finishedAt >= 0 && now - r.finishedAt >= RESULTS_FAILSAFE)) showResults();
  }

  // ---- phone mirror (race fields): immediately on change, else at PHONE_SYNC_HZ
  r.phoneTimer -= dt;
  const key = phoneRaceKey(r);
  if (key !== r.phoneKey || r.phoneTimer <= 0) {
    r.phoneKey = key;
    r.phoneTimer = 1 / PHONE_SYNC_HZ;
    syncPhone();
  }
}

const RACE_STATE_INDEX = { intro: 0, countdown: 1, racing: 2, finished: 3 };

// All phone-visible race fields packed into one number (no allocation): a
// change in any of them triggers an immediate host:state push.
function phoneRaceKey(r) {
  const P = r.player, rc = r.race;
  const st = rc ? (RACE_STATE_INDEX[rc.state] ?? 2) : 2;
  const cd = rc && rc.state === 'countdown' ? Math.ceil(rc.countdown || 0) : 0;
  const item = P.item ? ITEM_IDS.indexOf(P.item) + 1 : 0;
  let k = st;
  k = k * 32 + clamp(P.lap | 0, 0, 31);
  k = k * 32 + clamp(P.place | 0, 0, 31);
  k = k * 16 + item;
  k = k * 8 + clamp(P.itemCount | 0, 0, 7);
  k = k * 2 + (P.rolling ? 1 : 0);
  k = k * 8 + clamp(cd, 0, 7);
  k = k * 2 + (P.finished ? 1 : 0);
  k = k * 4 + (app.state === 'paused' ? 1 : 0);
  return k;
}

function skipIntro() {
  if (!R || !R.race) return;
  try { R.race.skipIntro(); } catch (err) { subsystemFailed('race', err); }
  chase.snap();
  menus.setIntroHint(false);
}

function onPlayerFinish(place) {
  const r = R;
  if (!r || r.finishedAt >= 0) return;
  r.autopilot = true;
  r.finishedAt = r.clock;
  const P = r.player;
  P.input.useItem = false;
  if (RaceMods.AIDriver && !r.playerDriver) {
    const d = tryCreate('ai', () => new RaceMods.AIDriver(P, { track, difficulty: r.difficulty, skill: 0.8, rng: Math.random, personality: { aggression: 0 } }));
    if (d) { r.playerDriver = d; r.drivers.push(d); }
  }
  if (!r.playerDriver) { P.input.throttle = 0.5; P.input.steer = 0; P.input.drift = false; P.input.brake = 0; }
  chase.startOrbit();
  hud.showFinish(place);
  audio.playJingle(place <= 3 ? 'finish' : 'lose');
  vibrate(VIBE.finish);
  if (place <= 3) {
    _confettiPos.copy(P.position).y += 2.2;
    effects.burst('confetti', _confettiPos, { count: 110 });
  }
}

function showResults() {
  const r = R;
  if (!r || app.state === 'results') return;
  let res = null;
  if (r.race) { try { res = r.race.getResults(); } catch (err) { console.error('[main] getResults failed', err); } }
  if (!Array.isArray(res) || !res.length) {
    res = r.karts.slice().sort((a, b) => (a.place || 99) - (b.place || 99))
      .map((k, i) => ({ kart: k, place: k.place || i + 1, time: k.finishTime, finished: !!k.finished, bestLap: k.lapTimes && k.lapTimes.length ? Math.min(...k.lapTimes) : null }));
  }
  const rows = res.map((x) => ({
    place: x.place,
    name: x.kart.character.name,
    cssColor: x.kart.character.cssColor,
    time: x.time,
    finished: x.finished !== false,
    bestLap: x.bestLap,
    isPlayer: x.kart.isPlayer,
  }));
  presentResults(rows, `${track.name} · ${DIFFICULTY[r.difficulty].label} · ${r.race ? r.race.laps : RACE.laps} laps`);
  if (chase.mode !== 'orbit') chase.startOrbit();
}

let phoneResults = null;
function presentResults(rows, subtitle) {
  const me = rows.find((x) => x.isPlayer);
  menus.setResults({ rows, playerPlace: me ? me.place : null, subtitle });
  phoneResults = rows.map((x) => ({ name: x.name, cssColor: x.cssColor, place: x.place, time: Number.isFinite(x.time) ? x.time : null, isPlayer: !!x.isPlayer, finished: x.finished }));
  hud.hide();
  setFraming(RESULTS_FRAMING);
  // the race keeps running behind the results (autopiloted player, orbit cam)
  // but goes silent: no engine loops, one-shots (sfx) or phone rumble
  audio.setEngineActive(false);
  audio.startMusic('menu');
  setScreen('results');
}

// ---- event wiring (per race; unsubscribed in teardownRace)

function sfx(name, kart, base = 1) {
  const r = R;
  if (!r || base <= 0 || app.state === 'results') return;
  if (kart === r.player) {
    _sfx.volume = base; _sfx.pan = 0;
  } else {
    const pos = kart && kart.position ? kart.position : kart;
    if (!pos) return;
    _rel.subVectors(pos, camera.position);
    const d = _rel.length();
    if (d > 75) return;
    const fall = 1 - d / 75;
    _sfx.volume = base * fall * fall * 0.85;
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    _sfx.pan = d > 0.01 ? clamp(_rel.dot(_camRight) / d, -1, 1) * 0.7 : 0;
  }
  _sfx.pitch = 1;
  audio.play(name, _sfx);
}

function vibrate(pattern) { if (phone && phone.connected && app.state !== 'results') phone.sendEvent('vibrate', { pattern }); }

// item:use one-shots (toot / triple toot sound through kart:boost 'item', star through kart:starStart)
const ITEM_USE_SOUND = { banana: 'throw', bouncer: 'bouncer', rocket: 'rocket', stink: 'stink', zap: 'zap' };
// Short center banners when the player's item lands on someone (medium size, quick).
const HIT_CALLOUT = { bouncer: 'BONK!', rocket: 'KABOOM!', banana: 'SLIPPED!', stink: 'PEE-YEW!', star: 'STAR SMASH!' };
const FLASH_HOLD = 1.6;    // s: big banners (LAP / FINAL LAP / start) are not cut short by callouts

function subscribeRaceEvents() {
  const r = R;
  const on = (type, fn) => r.offs.push(bus.on(type, fn));
  const isP = (k) => k === r.player;
  // banner with priority: lap / final-lap / start banners hold the slot for FLASH_HOLD
  const banner = (text, opts, hold = 0) => {
    if (hold <= 0 && r.clock < r.bannerUntil) return;
    hud.flash(text, opts);
    if (hold > 0) r.bannerUntil = r.clock + hold;
  };

  // ---- race flow → HUD / audio / phone
  on('race:countdown', (e) => {
    if (app.state === 'results') return;     // debug results over a fresh grid
    menus.setIntroHint(false);
    hud.show();
    hud.countdown(e.n);
    startLights.set(LIGHT_RED_COUNT[e.n] || 0);
    audio.play('countdown');
    vibrate(VIBE.countdown);
  });
  on('race:go', () => {
    if (app.state === 'results') return;
    hud.countdown(0);
    startLights.set(5, true);
    audio.play('go');
    audio.startMusic('race');
    vibrate(VIBE.go);
  });
  on('race:startBoost', (e) => {
    if (!isP(e.kart)) return;            // CPUs: their kart:boost 'start' whoosh below
    audio.play('startBoost');
    banner('ROCKET START!', { color: '#38c8ff', size: 'medium', duration: 1.3 }, 1.3);
  });
  on('race:stall', (e) => {
    if (!isP(e.kart)) return;
    audio.play('stall');
    banner('STALLED!', { color: '#ff9d2e', size: 'medium', duration: 1.2 }, 1.2);
  });
  on('race:lap', (e) => {
    if (!isP(e.kart)) return;
    const laps = r.race ? r.race.laps : RACE.laps;
    if (e.lap > laps) return;
    vibrate(VIBE.lap);
    // the final lap gets its own fanfare + banner (race:finalLap)
    if (e.lap < laps) {
      audio.play('lap');
      banner(`LAP ${e.lap}`, { color: '#ffd23a' }, FLASH_HOLD);
    }
  });
  on('race:finalLap', (e) => {
    if (!isP(e.kart)) return;
    audio.play('finalLap');
    audio.setMusicIntensity(1);
    banner('FINAL LAP!', { color: '#ff5a3c', duration: 2 }, 2);
  });
  on('race:finish', (e) => {
    if(isP(e.kart))onPlayerFinish(e.place);
    else if(e.kart.isPlayer && RaceMods.AIDriver)r.drivers.push(new RaceMods.AIDriver(e.kart,{track,difficulty:r.difficulty,skill:.8}));
  });
  on('race:wrongWay', (e) => { if (isP(e.kart)) hud.setWrongWay(e.on); });
  on('race:over', () => { if (r.overAt < 0) r.overAt = r.clock; });

  // ---- kart one-shots (player at full volume, CPUs distance-attenuated + quieter)
  on('kart:hop', (e) => sfx('hop', e.kart, isP(e.kart) ? 0.5 : 0.3));
  on('kart:land', (e) => sfx('land', e.kart, clamp(e.airTime || 0.3, 0.3, 1)));
  on('kart:driftTier', (e) => sfx(`drift${clamp(e.tier | 0, 1, 3)}`, e.kart, isP(e.kart) ? 0.9 : 0.4));
  on('kart:boost', (e) => {
    if (e.source === 'item') sfx('toot', e.kart, 1);                 // toot boost = the signature fart
    else if (e.source === 'start') { if (!isP(e.kart)) sfx('boost', e.kart, 0.4); }   // player: startBoost above
    else sfx('boost', e.kart, e.source === 'pad' ? 0.8 : 0.9);
  });
  on('kart:spin', (e) => {
    sfx('spin', e.kart, 1);
    if (isP(e.kart)) { vibrate(VIBE.hit); if (e.cause !== 'zap') menus.screenFlash('hit'); }
  });
  on('kart:tumble', (e) => {
    sfx('hit', e.kart, 1);
    if (isP(e.kart)) { vibrate(VIBE.hit); menus.screenFlash('hit'); }
  });
  on('kart:wallHit', (e) => {
    const it = clamp(e.intensity || 0.5, 0, 1);
    sfx('wall', e.kart, 0.35 + 0.65 * it);
    if (isP(e.kart) && it > 0.45) vibrate([Math.round(20 + 40 * it)]);
  });
  on('kart:bump', (e) => {
    const it = clamp(e.intensity || 0.5, 0, 1);
    const k = isP(e.b) ? e.b : e.a;
    sfx('bump', k, 0.35 + 0.65 * it);
    if (isP(e.a) || isP(e.b)) vibrate(VIBE.bump);
    // star ram (kart.js: a = the starred kart, b = the one it sent flying)
    if (isP(e.a) && e.a.starTimer > 0 && e.b && e.b.tumbleTimer > HIT.tumbleDuration - 0.1) {
      banner(HIT_CALLOUT.star, { color: '#ffe14d', size: 'medium', duration: 0.9 });
    }
  });
  on('kart:starStart', (e) => {
    sfx('star', e.kart, 1);
    if (isP(e.kart)) menus.screenFlash('star');
  });
  on('kart:respawn', (e) => sfx('respawn', e.kart, 0.9));

  // ---- items
  on('item:boxHit', (e) => sfx('itemBox', e.kart, isP(e.kart) ? 0.8 : 0.6));
  on('item:get', (e) => { if (isP(e.kart)) { audio.play('itemGet'); vibrate(VIBE.itemGet); } });
  on('item:use', (e) => {
    const s = ITEM_USE_SOUND[e.item];
    // the zap is heard by everyone it strikes, so it plays at full volume
    if (s) sfx(s, e.item === 'zap' ? r.player : e.kart, e.item === 'zap' ? 1.1 : 1);
  });
  on('item:zap', (e) => {
    const victims = e.victims;
    const hitMe = Array.isArray(victims) ? victims.indexOf(r.player) >= 0 : false;
    if (hitMe) {
      menus.screenFlash('zap');
      banner('ZAPPED!', { color: '#ffe600', size: 'medium', duration: 1.1 });
    } else if (isP(e.kart)) {
      menus.screenFlash('zap');
    }
  });
  on('item:hit', (e) => {
    if (e.item === 'banana') sfx('banana', e.kart, 1);
    else if (e.item === 'stink') sfx('stink', e.kart, 0.6);
    // the player's item landed on a rival → a quick callout
    if (isP(e.by) && !isP(e.kart) && HIT_CALLOUT[e.item]) {
      banner(HIT_CALLOUT[e.item], { color: '#7dff6a', size: 'medium', duration: 0.9 });
    }
  });
  on('item:explode', (e) => { if (e.position) sfx('explode', e.position, 1); });
  on('item:blocked', (e) => sfx('bump', e.kart, 0.6));
}

// =============================================================== 6. Phone link + sync

const phoneChars = CHARACTERS.map((c) => ({ id: c.id, name: c.name, cssColor: c.cssColor }));

function wirePhone() {
  phone.on('join', (e) => {
    menus.setPhone({ connected: true });
    if (!e || !e.rejoin) {
      audio.play('join');
      if (app.state !== 'race') menus.toast('Phone connected! Turn it like a steering wheel.', { icon: '📱', tone: 'good', duration: 3 });
      phone.sendEvent('vibrate', { pattern: [30, 40, 30] });
    }
    syncPhone();
  });
  phone.on('leave', () => {
    menus.setPhone({ connected: false });
    audio.play('leave');
    if (app.state === 'race' && input.lastSource === 'phone') pause();
    if (app.state !== 'race') menus.toast('Phone disconnected', { icon: '📵', tone: 'warn' });
  });
  phone.on('menu', (m) => {if(!party.menu(0,m))action(m.action,m,'phone');});
  phone.on('info', (info) => { menus.setPhone({ status: 'online', ...info }); syncPhone(); });
  phone.on('status', (s) => { if (s && s.socketConnected === false) menus.setPhone({ status: 'connecting' }); else if (phone.room) menus.setPhone({ status: 'online' }); });
}

/** host:state mirror for the phone (net.js dedupes unchanged states). */
function syncPhone() {
  if (!phone || !party) return;
  for(let i=0;i<links.length;i++) {
    const link=links[i];
    if(party.visible){link.sendState({...party.phoneState(i),difficulty:app.difficulty});continue;}
    const p=R?.players.find(p=>p.slot.index===i);
    if(!p){link.sendState({screen:'loading'});continue;}
    const k=p.kart,rc=R.race;
    link.sendState({screen:PHONE_SCREEN[app.state]||'loading',characters:phoneChars,selected:p.slot.character,difficulty:app.difficulty,
      race:{state:rc?.state||'racing',laps:rc?.laps||3,lap:clamp(k.lap||1,1,3),place:k.place||0,racers:R.karts.length,item:k.item||null,itemCount:k.itemCount||0,rolling:!!k.rolling,countdown:rc?.state==='countdown'?Math.ceil(rc.countdown):0,finished:!!k.finished,drunkSeconds:k.drunkTimer},
      results:app.state==='results'?phoneResults:null});
  }
}

// =============================================================== 7. main loop

const focus = new THREE.Vector3();
let lastT = -1;
let hintTimer = 0;

function loop(t) {
  requestAnimationFrame(loop);
  let dt = lastT < 0 ? 0 : (t - lastT) / 1000;
  lastT = t;
  if (!(dt > 0)) dt = 0;
  if (dt > PHYS.maxFrameDt) dt = PHYS.maxFrameDt;
  frame(dt);
}

// CPU time of frame() (simulation + scene update + render submission), smoothed;
// GPU time is not included (it runs asynchronously). Shown by __game.stats().
const frameCost = { ms: 0, max: 0 };

function frame(dt) {
  const t0 = performance.now();
  input.update(dt);
  handleInput();

  const st = app.state;
  if (st === 'title') {
    attract.update(dt);
    focus.copy(attract.focus);
  } else if (st === 'select') {
    showroom.applyCamera(camera);
    focus.copy(showroom.focus);
  }
  showroom.update(dt);
  if (R) {
    raceFrame(dt);
    if (R) focus.copy(R.player.position);
  }
  updateFraming(dt);
  effects.update(app.state === 'paused' ? 0 : dt, camera);
  world.update(dt, focus, camera);

  hintTimer -= dt;
  if (hintTimer <= 0) {
    hintTimer = 0.4;
    menus.setSoundHint(!audio.ready && app.state !== 'boot');
  }
  if(R && R.players.length>1 && ['race','paused','results'].includes(app.state)) {
    const w=window.innerWidth,h=window.innerHeight,rects=viewports(R.players.length,w,h);
    renderer.setScissorTest(false);renderer.setViewport(0,0,w,h);renderer.clear();renderer.setScissorTest(true);
    R.players.forEach((p,i)=>{const v=rects[i];p.camera.clearViewOffset();p.camera.aspect=v.w/v.h;p.camera.updateProjectionMatrix();renderer.setViewport(v.x,v.y,v.w,v.h);renderer.setScissor(v.x,v.y,v.w,v.h);renderer.render(scene,p.camera);});
    renderer.setScissorTest(false);renderer.setViewport(0,0,w,h);
  } else {camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.render(scene,camera);}

  const cost = performance.now() - t0;
  frameCost.ms += (cost - frameCost.ms) * 0.05;
  frameCost.max = Math.max(frameCost.max * 0.995, cost);
}

// =============================================================== 8. debug handle

const FAKE_RESULTS = () => {
  const order = shuffle(CHARACTERS.slice());
  const me = CHARACTERS[app.selected];
  return order.map((c, i) => ({
    place: i + 1,
    name: c.name,
    cssColor: c.cssColor,
    time: 101.234 + i * 2.71 + (i > 5 ? 3 : 0),
    finished: i < 6,
    bestLap: 32.5 + i * 0.6,
    isPlayer: c === me,
  }));
};

window.__game = {
  get party() {return party;},
  get players(){return R?.players||[];},
  get state() { return app.state; },
  get track() { return track; },
  get race() { return R ? R.race : null; },
  get karts() { return R ? R.karts : []; },
  get player() { return R ? R.player : null; },
  get items() { return R ? R.items : null; },
  get selected() { return app.selected; },
  get difficulty() { return app.difficulty; },
  get timeScale() { return app.timeScale; },
  quickRace(charId = 'sahur', difficulty = 'normal') {
    const i = CHARACTERS.findIndex((c) => c.id === charId);
    app.selected = i >= 0 ? i : 0;
    app.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
    menus.setSelected(app.selected);
    menus.setDifficulty(app.difficulty);
    showroom.setCharacter(app.selected, true);
    raceSlots=[{...party.slots[0],character:app.selected}];chosenMap='bay';
    startRace();
    return true;
  },
  setTimeScale(x) { app.timeScale = clamp(Number(x) || 1, 0, 16); return app.timeScale; },
  skipIntro,
  /** Tests: let an AIDriver drive the player kart (as after the finish). */
  autopilot(on = true) {
    if (!R) return false;
    if (on && !R.playerDriver && RaceMods.AIDriver) {
      const d = tryCreate('ai', () => new RaceMods.AIDriver(R.player, { track, difficulty: R.difficulty, skill: 0.85, rng: Math.random, personality: { aggression: 0.5 } }));
      if (d) { R.playerDriver = d; R.drivers.push(d); }
    } else if (!on && R.playerDriver) {
      R.drivers.splice(R.drivers.indexOf(R.playerDriver), 1);
      R.playerDriver = null;
    }
    R.autopilot = !!(on && R.playerDriver);
    return R.autopilot;
  },
  // extras for tests / debugging
  action: (name, payload = {}) => action(name, payload, 'debug'),
  goto(screen) {
    if (screen === 'title') goTitle();
    else if (screen === 'select') goSelect();
    else if (screen === 'race') startRace();
    else if (screen === 'paused') { if (!R) startRace(); if (app.state === 'race') pause(); }
    else if (screen === 'results') this.debugResults();
    return app.state;
  },
  /** Results screen with fake standings (no race needed); rows optional. */
  debugResults(rows = null) {
    if (!R) {
      // a parked race behind the results so the orbit camera has a subject
      startRace();
      if (R && R.race) skipIntro();
    }
    presentResults(rows || FAKE_RESULTS(), `${track.name} · ${DIFFICULTY[app.difficulty].label} · ${RACE.laps} laps`);
    chase.startOrbit();
    return app.state;
  },
  phoneState() {
    const screen = PHONE_SCREEN[app.state];
    return { screen, selected: app.selected, difficulty: app.difficulty, phoneConnected: phone.connected, room: phone.room };
  },
  stats() {
    const i = renderer.info;
    return {
      calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures,
      programs: i.programs ? i.programs.length : 0, frameCpuMs: +frameCost.ms.toFixed(2), frameCpuMaxMs: +frameCost.max.toFixed(2),
    };
  },
  modules: RaceMods,
  bus,
  get menus() { return menus; },
  get phone() { return phone; },
  get audio() { return audio; },
  get renderer() { return renderer; },
  get scene() { return scene; },
  get camera() { return camera; },
  get chase() { return chase; },
  get input() { return input; },
  get hud() { return hud; },
  get effects() { return effects; },
  get attract() { return attract; },
  title: GAME_TITLE,
};

boot().catch((err) => {
  console.error('[main] boot failed', err);
  if (!document.querySelector('.tk-fatal')) {
    showFatal(menusRoot, 'TOOT KART failed to start', String(err && err.message || err));
  }
});
