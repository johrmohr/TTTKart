// Character roster + low-poly kart/driver model builder.
//
// Node-safe: only uses THREE geometry/material classes (no canvas/DOM), so the
// headless simulation can import CHARACTERS / statsFromRatings from here.
//
// Every model is built from primitives and MERGED per moving part to keep the
// draw-call count tiny:
//   chassis mesh (1) + driver torso mesh (1) + head mesh (1) + 4 wheels as one
//   InstancedMesh (1)  =  4 draw calls per kart (+1 for Nova's glass helmet).
// Colors are baked into vertex colors; a per-vertex "surface" attribute
// (glow, roughness, metalness) is injected into MeshStandardMaterial so a
// single material per kart can have glossy paint, matte fur, chrome pipes and
// glowing lights. That one material is the kart's tint material (star rainbow).
//
// Models face +Z with the origin at ground level, centered (see SPEC §2/§4).
// NOTE: the kart's RIGHT side is -X (right = (-cos yaw, 0, sin yaw)).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { KART } from './config.js';

// --------------------------------------------------------------- roster data

export const CHARACTERS = [
  { id: 'sahur', name: 'Tung Tung Tung Sahur', emoji: '🪵', tagline: 'The wooden legend. One bat. Endless mini-turbos.', color: 12089655, accent: 16762443, cssColor: '#b87937', ratings: { speed: 3, accel: 4, handling: 4, weight: 3 } },
  { id: 'tralalero', name: 'Tralalero Tralala', emoji: '🦈', tagline: 'Three sneakers. One very fast shark.', color: 3709402, accent: 16777215, cssColor: '#3899da', ratings: { speed: 4, accel: 3, handling: 3, weight: 3 } },
  { id: 'patapim', name: 'Brr Brr Patapim', emoji: '🌳', tagline: 'A forest giant with roots in every corner.', color: 5544773, accent: 12158539, cssColor: '#549b45', ratings: { speed: 3, accel: 2, handling: 4, weight: 5 } },
  { id: 'crocodilo', name: 'Bombardiro Crocodilo', emoji: '🐊', tagline: 'Crocodile fuselage. Cleared for takeoff.', color: 6588231, accent: 16764745, cssColor: '#648747', ratings: { speed: 5, accel: 2, handling: 2, weight: 4 } },
  { id: 'cappuccina', name: 'Ballerina Cappuccina', emoji: '☕', tagline: 'A cappuccino ballerina with a perfect pirouette.', color: 15961018, accent: 16777215, cssColor: '#f38bba', ratings: { speed: 2, accel: 5, handling: 5, weight: 1 } },
  { id: 'bananini', name: 'Chimpanzini Bananini', emoji: '🍌', tagline: 'Banana peel outside. Monkey business inside.', color: 16045127, accent: 5806657, cssColor: '#f4d447', ratings: { speed: 3, accel: 5, handling: 3, weight: 2 } },
  { id: 'lirili', name: 'Lirili Larila', emoji: '🌵', tagline: 'Elephant meets cactus. Sandals meet asphalt.', color: 8108651, accent: 13077846, cssColor: '#7bba6b', ratings: { speed: 4, accel: 2, handling: 3, weight: 5 } },
  { id: 'assassino', name: 'Cappuccino Assassino', emoji: '🥷', tagline: 'Espresso ninja. Quietly stealing first place.', color: 7033725, accent: 15062707, cssColor: '#6b537d', ratings: { speed: 4, accel: 4, handling: 3, weight: 2 } },
];

// The player's own creation (SPEC §13.2). Only ever the player; never a CPU.
export const CUSTOM_CHARACTER = {
  id: 'custom', name: 'My Racer', isCustom: true, human: true,
  color: 0x8b5cff, accent: 0xffc21f, cssColor: '#8b5cff',
  ratings: { speed: 3, accel: 3, handling: 3, weight: 3 },
  tagline: 'Your racer, your rules.',
  look: { skin: 's3', hair: 'short', hairColor: 'dark', headwear: 'helmet', eyewear: 'none', outfit: 'purple' },
  signature: { body: 'standard', wheels: 'standard', paint: 'purple', trim: 'yellow', rim: 'silver' },
};

// Everything shown on the select screen: the 12-racer roster + the custom slot.
export const SELECTABLE = [...CHARACTERS];

const BY_ID = new Map(SELECTABLE.map((c) => [c.id, c]));

export function getCharacter(id) {
  return BY_ID.get(id) || CHARACTERS[0];
}

// Map 1..5 star ratings to physical stats (config KART.*Base/PerStar).
export function statsFromRatings(ratings = {}) {
  const r = (k) => Math.min(5, Math.max(1, Number(ratings[k]) || 3));
  return {
    topSpeed: KART.topSpeedBase + KART.topSpeedPerStar * r('speed'),
    accel: KART.accelBase + KART.accelPerStar * r('accel'),
    turnRate: KART.turnBase + KART.turnPerStar * r('handling'),
    mass: KART.massBase + KART.massPerStar * r('weight'),
  };
}

// ------------------------------------------------------------ layout consts

// Wheel layout (model space). +X is the kart's LEFT side.
export const WHEEL_RADIUS_REAR = 0.34;
export const FRONT_WHEEL_SCALE = 0.82;
export const WHEEL_RADIUS_FRONT = WHEEL_RADIUS_REAR * FRONT_WHEEL_SCALE;
const WHEEL_POS = {
  fl: [0.57, WHEEL_RADIUS_FRONT, 0.68],
  fr: [-0.57, WHEEL_RADIUS_FRONT, 0.68],
  rl: [0.6, WHEEL_RADIUS_REAR, -0.6],
  rr: [-0.6, WHEEL_RADIUS_REAR, -0.6],
};
const SEAT = [0, 0.44, -0.3];          // driver group origin (hips)
const NECK = [0, 0.86, -0.28];         // head pivot (kart space, before driver scale)
const WHEEL_CENTER = [0, 0.76, 0.16];  // steering wheel
const EXHAUST_TIPS = [[0.2, 0.585, -1.2], [-0.2, 0.585, -1.2]];

// Surface presets: [roughness, metalness, glow]
const S = {
  paint: [0.3, 0.06, 0],
  plastic: [0.55, 0, 0],
  rubber: [0.92, 0, 0],
  metal: [0.28, 0.5, 0],
  fur: [0.82, 0, 0],
  skin: [0.62, 0, 0],
  cloth: [0.88, 0, 0],
  gloss: [0.12, 0, 0],
  glow: [0.5, 0, 1],
  softGlow: [0.4, 0, 0.45],
};

const DARK = 0x33353f;
const SEAT_COL = 0x3b3e4a;
const CHROME = 0xc3ccd6;

// --------------------------------------------------------- material shader

// Inject the per-vertex surface attribute (roughness, metalness, glow) into the
// standard material. One shared program for every kart (same cache key).
function surfaceOnBeforeCompile(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aSurf;\nvarying vec3 vSurf;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vSurf;')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(vSurf.x * (roughness / 0.5), 0.04, 1.0);')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vSurf.y;')
    .replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * vSurf.z * 1.4;\n#endif');
}

function makeSurfaceMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  m.onBeforeCompile = surfaceOnBeforeCompile;
  m.customProgramCacheKey = () => 'tootkart-surface-v1';
  return m;
}

let _wheelMaterial = null;
function wheelMaterial() {
  return _wheelMaterial || (_wheelMaterial = makeSurfaceMaterial());
}

// -------------------------------------------------------- geometry builder

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sv = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

// Collects transformed, colored primitives and merges them into one geometry.
class Parts {
  constructor(seg = 1) {
    this.geos = [];
    this.seg = seg;                       // LOD multiplier for segment counts
    this.stack = [new THREE.Matrix4()];   // parent transform stack
  }

  n(base, min = 3) { return Math.max(min, Math.round(base * this.seg)); }

  // Push a parent transform (pos, rot euler, uniform/vec scale).
  push(pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
    _m.compose(_pv.fromArray(pos), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _sv.fromArray(sc));
    const top = this.stack[this.stack.length - 1];
    this.stack.push(new THREE.Matrix4().multiplyMatrices(top, _m));
    return this;
  }

  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }

  // Add a primitive geometry with color + surface preset.
  add(geo, color, surf = S.plastic, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
    _m.compose(_pv.fromArray(pos), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _sv.fromArray(sc));
    _m2.multiplyMatrices(this.stack[this.stack.length - 1], _m);
    g.applyMatrix4(_m2);
    const count = g.attributes.position.count;
    const col = new Float32Array(count * 3);
    const srf = new Float32Array(count * 3);
    _c.set(color);
    for (let i = 0; i < count; i++) {
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      srf[i * 3] = surf[0]; srf[i * 3 + 1] = surf[1]; srf[i * 3 + 2] = surf[2];
    }
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (g.attributes.uv1) g.deleteAttribute('uv1');
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(srf, 3));
    this.geos.push(g);
    return this;
  }

  // Mirror helper: adds the part at +x and -x (rotation y/z mirrored).
  sym(geoFn, color, surf, pos, rot = [0, 0, 0], scale = 1) {
    this.add(geoFn(), color, surf, pos, rot, scale);
    this.add(geoFn(), color, surf, [-pos[0], pos[1], pos[2]], [rot[0], -rot[1], -rot[2]], scale);
    return this;
  }

  // Capsule/limb between two points.
  limb(a, b, radius, color, surf = S.cloth) {
    _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _dir.length();
    _dir.normalize();
    _q.setFromUnitVectors(_up, _dir);
    _e.setFromQuaternion(_q);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    this.add(new THREE.CapsuleGeometry(radius, Math.max(0.001, len), this.n(3, 2), this.n(8, 5)), color, surf, mid, [_e.x, _e.y, _e.z]);
    return this;
  }

  merge() {
    const g = mergeGeometries(this.geos, false);
    for (const p of this.geos) p.dispose();
    this.geos = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Primitive factories (fresh geometry each call; Parts.add consumes them).
const sphere = (P, r, w = 14, h = 10) => new THREE.SphereGeometry(r, P.n(w, 6), P.n(h, 4));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (P, w, h, d, r = 0.06, segs = 1) => new RoundedBoxGeometry(w, h, d, P.seg < 0.8 ? 1 : segs, r);
const cyl = (P, rt, rb, h, seg = 14, open = false, t0 = 0, tl = Math.PI * 2) =>
  new THREE.CylinderGeometry(rt, rb, h, P.n(seg, 5), 1, open, t0, tl);
const cone = (P, r, h, seg = 10) => new THREE.ConeGeometry(r, h, P.n(seg, 4));
const torus = (P, R, t, rs = 6, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(R, t, P.n(rs, 3), P.n(ts, 6), arc);

// Cartoon eye facing +Z (head space): sclera, iris, pupil, two glints.
function eye(P, x, y, z, r, { iris = 0x3a2a1e, pupil = 0x0d0d12, sclera = 0xffffff, yaw = 0, pitch = 0, squash = 1.15, irisScale = 0.62 } = {}) {
  P.push([x, y, z], [pitch, yaw, 0]);
  P.add(sphere(P, r, 12, 8), sclera, S.gloss, [0, 0, 0], [0, 0, 0], [1, squash, 0.6]);
  P.add(sphere(P, r * irisScale, 10, 6), iris, S.gloss, [0, -r * 0.05, r * 0.36], [0, 0, 0], [1, 1.08, 0.5]);
  P.add(sphere(P, r * irisScale * 0.55, 8, 5), pupil, S.gloss, [0, -r * 0.05, r * 0.5], [0, 0, 0], [1, 1.1, 0.4]);
  P.add(sphere(P, r * 0.17, 5, 3), 0xffffff, S.softGlow, [-r * 0.22, r * 0.24, r * 0.58]);
  P.add(sphere(P, r * 0.08, 4, 3), 0xffffff, S.softGlow, [r * 0.2, -r * 0.22, r * 0.56]);
  P.pop();
}

// ------------------------------------------------------------ the chassis

function buildChassis(P, def) {
  const C = def.color, A = def.accent;
  // floor pan + axles
  P.add(rbox(P, 0.84, 0.12, 1.9, 0.05), DARK, S.plastic, [0, 0.18, -0.02]);
  P.add(cyl(P, 0.045, 0.045, 1.14, 8), 0x55585f, S.metal, [0, WHEEL_RADIUS_REAR, -0.6], [0, 0, Math.PI / 2]);
  P.add(cyl(P, 0.04, 0.04, 1.06, 8), 0x55585f, S.metal, [0, WHEEL_RADIUS_FRONT, 0.68], [0, 0, Math.PI / 2]);
  // main tub
  P.add(rbox(P, 0.86, 0.32, 1.16, 0.12, 2), C, S.paint, [0, 0.38, -0.12]);
  // cockpit rim (dark lip around the driver)
  P.add(torus(P, 0.3, 0.045, 5, 18), DARK, S.plastic, [0, 0.545, -0.22], [Math.PI / 2, 0, 0], [1.15, 1.25, 1]);
  // nose + hood stripe + emblem
  P.push([0, 0.35, 0.64], [0.1, 0, 0]);
  P.add(rbox(P, 0.74, 0.25, 0.68, 0.11, 2), C, S.paint);
  P.add(box(0.18, 0.03, 0.6), A, S.paint, [0, 0.125, -0.02]);
  P.add(cyl(P, 0.1, 0.1, 0.02, 16), 0xffffff, S.paint, [0, 0.02, 0.341], [Math.PI / 2, 0, 0]);
  P.add(cyl(P, 0.06, 0.06, 0.025, 12), A, S.paint, [0, 0.02, 0.345], [Math.PI / 2, 0, 0]);
  // headlights
  P.add(cyl(P, 0.05, 0.05, 0.03, 10), 0xfff4c8, S.glow, [0.23, 0.03, 0.335], [Math.PI / 2, 0, 0]);
  P.add(cyl(P, 0.05, 0.05, 0.03, 10), 0xfff4c8, S.glow, [-0.23, 0.03, 0.335], [Math.PI / 2, 0, 0]);
  P.pop();
  // dashboard
  P.add(rbox(P, 0.6, 0.12, 0.2, 0.05), DARK, S.plastic, [0, 0.55, 0.3], [-0.3, 0, 0]);
  // front bumper
  P.add(rbox(P, 1.16, 0.15, 0.18, 0.07), DARK, S.plastic, [0, 0.23, 1.04]);
  P.sym(() => box(0.12, 0.17, 0.2), A, S.paint, [0.54, 0.24, 1.04]);
  // side pods
  P.sym(() => rbox(P, 0.26, 0.24, 0.56, 0.09), A, S.paint, [0.5, 0.33, 0.05]);
  P.sym(() => box(0.16, 0.05, 0.4), C, S.paint, [0.58, 0.39, 0.05]);
  // rear fenders over the chunky rear wheels
  P.sym(() => torus(P, 0.4, 0.07, 6, 14, Math.PI * 0.86), C, S.paint, [0.6, WHEEL_RADIUS_REAR, -0.6], [0, Math.PI / 2, 0.22], [1, 1, 2.7]);
  // seat
  P.add(rbox(P, 0.5, 0.08, 0.42, 0.04), SEAT_COL, S.cloth, [0, 0.44, -0.3]);
  P.add(rbox(P, 0.52, 0.5, 0.1, 0.05), SEAT_COL, S.cloth, [0, 0.7, -0.53], [-0.22, 0, 0]);
  // engine block, cylinder heads
  P.add(rbox(P, 0.6, 0.28, 0.36, 0.06), DARK, S.plastic, [0, 0.44, -0.8]);
  P.sym(() => box(0.18, 0.1, 0.28), CHROME, S.metal, [0.13, 0.62, -0.8]);
  // rear cowl in body color (what the chase camera sees most): taillights,
  // a white plate with the emblem, diffuser
  P.add(rbox(P, 0.82, 0.24, 0.12, 0.05, 2), C, S.paint, [0, 0.42, -1.0]);
  P.sym(() => rbox(P, 0.12, 0.07, 0.03, 0.015), 0xff2a2a, S.glow, [0.31, 0.47, -1.065]);
  P.add(rbox(P, 0.2, 0.09, 0.02, 0.02), 0xffffff, S.paint, [0, 0.37, -1.064]);
  P.add(cyl(P, 0.03, 0.03, 0.02, 10), A, S.paint, [0, 0.37, -1.075], [Math.PI / 2, 0, 0]);
  P.add(box(0.7, 0.06, 0.1), DARK, S.plastic, [0, 0.28, -1.0]);
  // exhaust pipes (angled up and back) with dark mouths
  for (const sx of [1, -1]) {
    P.push([0.2 * sx, 0.52, -1.02], [-Math.PI / 2 + 0.35, 0, 0]);
    P.add(cyl(P, 0.07, 0.08, 0.38, 12), CHROME, S.metal);
    P.add(torus(P, 0.07, 0.022, 5, 12), CHROME, S.metal, [0, 0.19, 0], [Math.PI / 2, 0, 0]);
    P.add(cyl(P, 0.052, 0.052, 0.02, 10), 0x111114, S.rubber, [0, 0.192, 0]);
    P.pop();
  }
  // rear bumper (accent) + side taillights
  P.add(rbox(P, 1.34, 0.13, 0.13, 0.06), A, S.paint, [0, 0.25, -1.06]);
  P.sym(() => box(0.12, 0.06, 0.03), 0xff2a2a, S.glow, [0.34, 0.46, -0.71]);
  // spoiler
  P.sym(() => box(0.05, 0.36, 0.08), DARK, S.plastic, [0.28, 0.72, -0.97], [-0.15, 0, 0]);
  P.add(rbox(P, 1.22, 0.06, 0.32, 0.03), C, S.paint, [0, 0.91, -1.02], [0.1, 0, 0]);
  P.add(box(1.0, 0.02, 0.1), A, S.paint, [0, 0.945, -0.96], [0.1, 0, 0]);
  P.sym(() => box(0.04, 0.2, 0.36), A, S.paint, [0.62, 0.9, -1.02]);
  // steering column + wheel
  P.limb([0, 0.5, 0.38], WHEEL_CENTER, 0.025, DARK, S.plastic);
  P.push(WHEEL_CENTER, [0.69, 0, 0]);
  P.add(torus(P, 0.14, 0.028, 6, 18), DARK, S.rubber);
  P.add(box(0.26, 0.03, 0.02), DARK, S.plastic);
  P.add(cyl(P, 0.045, 0.045, 0.04, 10), A, S.paint, [0, 0, 0.01], [Math.PI / 2, 0, 0]);
  P.pop();
}

// One wheel (rear size, axis = X). Front wheels are scaled instances.
function buildWheel(P, def) {
  const r = WHEEL_RADIUS_REAR;
  const rot = [0, 0, Math.PI / 2];
  P.add(cyl(P, r, r, 0.26, 18), 0x24242b, S.rubber, [0, 0, 0], rot);
  P.add(cyl(P, r * 0.9, r * 0.9, 0.34, 18), 0x2c2c34, S.rubber, [0, 0, 0], rot);
  // tread blocks so spinning reads
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    P.add(box(0.27, 0.05, 0.07), 0x1c1c22, S.rubber, [0, Math.cos(a) * r, Math.sin(a) * r], [a, 0, 0]);
  }
  P.add(cyl(P, r * 0.55, r * 0.55, 0.355, 16), def.accent === 0xffffff ? 0xe9edf2 : def.accent, S.paint, [0, 0, 0], rot);
  for (let k = 0; k < 3; k++) {
    P.add(box(0.365, 0.05, r * 1.0), def.color, S.paint, [0, 0, 0], [(k * Math.PI) / 3, 0, 0]);
  }
  P.add(cyl(P, r * 0.18, r * 0.18, 0.375, 10), CHROME, S.metal, [0, 0, 0], rot);
}

// ------------------------------------------------------------ the drivers
//
// Torso parts are built in kart space and later re-centered on SEAT; head
// parts are built relative to the head pivot (NECK) — +Z is the face.

function arms(T, sleeve, glove, r = 0.068, gloveR = 0.078) {
  for (const sx of [1, -1]) {
    const sh = [0.2 * sx, 0.79, -0.27];
    const el = [0.27 * sx, 0.67, -0.07];
    const ha = [0.14 * sx, 0.76, 0.15];
    T.limb(sh, el, r, sleeve);
    T.limb(el, ha, r * 0.92, sleeve);
    T.add(sphere(T, gloveR, 10, 8), glove, S.cloth, ha);
  }
}

function torsoBlob(T, color, { belly = null, surf = S.cloth, w = 1, h = 1 } = {}) {
  T.add(sphere(T, 0.25, 16, 12), color, surf, [0, 0.66, -0.31], [0, 0, 0], [1.05 * w, 1.0 * h, 0.85]);
  if (belly !== null) T.add(sphere(T, 0.2, 14, 10), belly, surf, [0, 0.64, -0.17], [0, 0, 0], [0.95 * w, 0.95 * h, 0.5]);
}

// Original procedural interpretations; no downloaded character assets.
function brainrotDriver(T,H,def) {
  const id=def.id, wood=0x9b602f, cream=0xffefd5;
  torsoBlob(T,def.color,{surf:S.fur}); arms(T,def.color,def.color);
  if(id==='sahur') {
    H.add(cyl(H,.25,.25,.82),wood,S.fur,[0,.25,0]);
    for(let x=-.17;x<=.18;x+=.085) H.add(box(.012,.7,.012),0x663e21,S.fur,[x,.25,.237]);
    T.limb([.35,.58,-.15],[.55,1.44,-.15],.055,0xc9964b,S.fur);
    T.add(cyl(T,.09,.065,.48),0xc9964b,S.fur,[.51,1.18,-.15],[0,0,-.2]);
  } else if(id==='tralalero') {
    H.add(sphere(H,.32),0x5099bf,S.skin,[0,.2,0],[0,0,0],[1,1,1.5]);
    H.add(cone(H,.18,.4),0x5099bf,S.skin,[0,.52,-.15]);
    H.add(box(.35,.05,.15),cream,S.skin,[0,.1,.4]);
    for(const x of [-.32,0,.32]) T.add(box(.18,.15,.35),0x2866f2,S.paint,[x,.5,.28]);
  } else if(id==='patapim') {
    H.add(sphere(H,.3),0xa07c50,S.fur,[0,.2,0]);
    H.add(sphere(H,.11),0xc1976a,S.skin,[0,.18,.3],[0,0,0],[.8,1.7,1]);
    for(const x of [-.24,0,.24]) H.add(sphere(H,.2),0x46853c,S.fur,[x,.48,-.1]);
    T.limb([-.32,.5,-.3],[-.55,1.4,-.5],.04,wood,S.fur);
    T.limb([.32,.5,-.3],[.55,1.4,-.5],.04,wood,S.fur);
  } else if(id==='crocodilo') {
    H.add(box(.5,.27,.68),def.color,S.skin,[0,.16,.18]);
    H.add(box(.47,.045,.5),cream,S.plastic,[0,.08,.32]);
    T.add(box(1.6,.06,.28),0x788777,S.metal,[0,.76,-.4]);
    T.add(cone(T,.19,.5),0x788777,S.metal,[0,.75,-.77],[Math.PI/2,0,0]);
  } else if(id==='cappuccina'||id==='assassino') {
    H.add(cyl(H,.3,.22,.48),cream,S.plastic,[0,.22,0]);
    H.add(cyl(H,.27,.27,.02),0x603b25,S.gloss,[0,.47,0]);
    H.add(torus(H,.14,.045),cream,S.plastic,[.32,.22,0],[0,Math.PI/2,0]);
    if(id==='cappuccina') {
      T.add(cone(T,.46,.2),0xffa8cf,S.cloth,[0,.56,-.3]);
      H.add(torus(H,.11,.022),cream,S.plastic,[0,.49,0],[Math.PI/2,0,0]);
    } else {
      H.add(box(.57,.12,.08),0x232334,S.cloth,[0,.3,.25]);
      T.limb([-.35,.6,-.5],[.35,1.4,-.5],.025,0xc7d4dd,S.metal);
    }
  } else if(id==='bananini') {
    H.add(sphere(H,.28),0x709344,S.fur,[0,.2,0]);
    H.add(sphere(H,.22),0xd6b57f,S.skin,[0,.17,.16],[0,0,0],[1,1,.6]);
    H.sym(()=>sphere(H,.13),0x709344,S.fur,[.28,.24,0]);
    for(const x of [-.3,.3]) T.add(cone(T,.15,.7),0xffdf42,S.plastic,[x,.85,-.3],[0,0,x]);
  } else {
    H.add(sphere(H,.3),0x89a98a,S.skin,[0,.2,0]);
    H.sym(()=>sphere(H,.2),0x9dbb9c,S.skin,[.29,.23,0],[0,0,0],[.6,1,1]);
    H.limb([0,.18,.25],[0,-.12,.47],.075,0x89a98a,S.skin);
    T.add(cyl(T,.23,.23,.53),0x4c9348,S.skin,[0,.71,-.3]);
    for(const x of [-.34,.34]) T.add(box(.23,.08,.36),0x8c5738,S.fur,[x,.42,.1]);
  }
  const z=id==='crocodilo'?.36:id==='tralalero'?.37:.24;
  eye(H,-.11,.32,z,.075); eye(H,.11,.32,z,.075);
}

// --------------------------------------------------------------- the model

// Per-character visual scale tweaks.
const DRIVER_SCALE = {};

const _geoCache = new Map();

function buildGeometries(def, lod) {
  const key = `${def.id}|${def.body || "standard"}|${def.wheelType || "standard"}|${lod}`;
  const hit = _geoCache.get(key);
  if (hit) return hit;
  const seg = lod === 'low' ? 0.55 : 1;
  const chassis = new Parts(seg);
  buildChassis(chassis, def);
  if (def.body === "speedster") {
    chassis.add(box(1.65, .09, .34), def.accent, S.paint, [0,.9,-.92]);
    chassis.add(box(.9,.14,.9),def.color,S.paint,[0,.34,.62]);
  }
  if (def.body === "buggy") chassis.add(torus(chassis,.58,.045),def.accent,S.metal,[0,.79,-.45]);
  const wheel = new Parts(seg);
  buildWheel(wheel, def);

  const T = new Parts(seg);
  const H = new Parts(seg);
  const G = new Parts(seg);
  const fn = brainrotDriver;
  // Head parts are authored relative to the neck pivot; torso in kart space.
  fn(T, H, def, G);
  if (def.wheelType === "offroad") { for(let i=0;i<12;i++) { const a=i*Math.PI/6; wheel.add(box(.36,.09,.13),0x27252a,S.rubber,[0,Math.cos(a)*.34,Math.sin(a)*.34],[a,0,0]); } }
  if (def.wheelType === "roller") { for (const g of wheel.geos) g.scale(.62,1,1); }
  const torso = T.merge();
  torso.translate(-SEAT[0], -SEAT[1], -SEAT[2]);
  const out = {
    chassis: chassis.merge(),
    wheel: wheel.merge(),
    torso,
    head: H.merge(),
    glass: G.geos.length ? G.merge() : null,
  };
  _geoCache.set(key, out);
  return out;
}

const _wm = new THREE.Matrix4();

/**
 * Build a kart + driver model for a character definition.
 * Faces +Z, origin at ground center. See SPEC §4 for userData fields.
 */
export function buildKartModel(def, { lod = 'high' } = {}) {
  def = def && def.id ? def : getCharacter(def);
  const geos = buildGeometries(def, lod);
  const paint = makeSurfaceMaterial();
  paint.name = `kart-${def.id}`;

  const root = new THREE.Group();
  root.name = `kart:${def.id}`;
  const kartScale = 0.95 + 0.025 * ((def.ratings && def.ratings.weight) || 3);
  root.scale.setScalar(kartScale);

  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);
  const chassis = new THREE.Mesh(geos.chassis, paint);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  body.add(chassis);

  const driver = new THREE.Group();
  driver.name = 'driver';
  driver.position.fromArray(SEAT);
  driver.scale.setScalar(DRIVER_SCALE[def.id] || 1);
  body.add(driver);
  const torso = new THREE.Mesh(geos.torso, paint);
  torso.castShadow = true;
  torso.receiveShadow = true;
  driver.add(torso);

  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(NECK[0] - SEAT[0], NECK[1] - SEAT[1], NECK[2] - SEAT[2]);
  driver.add(head);
  const headMesh = new THREE.Mesh(geos.head, paint);
  headMesh.castShadow = true;
  headMesh.receiveShadow = true;
  head.add(headMesh);

  let glassMat = null;
  if (geos.glass) {
    glassMat = new THREE.MeshStandardMaterial({
      color: 0xdcefff, transparent: true, opacity: 0.2, roughness: 0.04, metalness: 0.1, depthWrite: false,
    });
    const glass = new THREE.Mesh(geos.glass, glassMat);
    glass.castShadow = true;
    glass.renderOrder = 2;
    head.add(glass);
  }

  // Exhaust tip markers (for boost flames).
  const exhausts = EXHAUST_TIPS.map((p, i) => {
    const o = new THREE.Object3D();
    o.name = `exhaust${i}`;
    o.position.fromArray(p);
    body.add(o);
    return o;
  });

  // Wheel "bones" (empty transforms) + one InstancedMesh drawing all 4 wheels.
  const steerPivots = {};
  const wheels = {};
  for (const k of ['fl', 'fr', 'rl', 'rr']) {
    const bone = new THREE.Object3D();
    bone.name = `wheel_${k}`;
    if (k[0] === 'f') {
      const pivot = new THREE.Object3D();
      pivot.name = `steer_${k}`;
      pivot.position.fromArray(WHEEL_POS[k]);
      bone.scale.setScalar(FRONT_WHEEL_SCALE);
      pivot.add(bone);
      root.add(pivot);
      steerPivots[k] = pivot;
    } else {
      bone.position.fromArray(WHEEL_POS[k]);
      root.add(bone);
    }
    wheels[k] = bone;
  }
  const wheelMesh = new THREE.InstancedMesh(geos.wheel, wheelMaterial(), 4);
  wheelMesh.name = 'wheels';
  wheelMesh.castShadow = true;
  wheelMesh.receiveShadow = true;
  root.add(wheelMesh);
  const order = ['fl', 'fr', 'rl', 'rr'];
  const syncWheels = () => {
    for (let i = 0; i < 4; i++) {
      const k = order[i];
      const bone = wheels[k];
      bone.updateMatrix();
      if (k[0] === 'f') {
        const pivot = steerPivots[k];
        pivot.updateMatrix();
        _wm.multiplyMatrices(pivot.matrix, bone.matrix);
      } else {
        _wm.copy(bone.matrix);
      }
      wheelMesh.setMatrixAt(i, _wm);
    }
    wheelMesh.instanceMatrix.needsUpdate = true;
  };
  syncWheels();
  wheelMesh.computeBoundingSphere();
  // a little slack so steering/spin never culls a wheel
  if (wheelMesh.boundingSphere) wheelMesh.boundingSphere.radius += 0.2;

  root.userData = {
    character: def,
    body,
    driver,
    head,
    wheels,
    steerPivots,
    exhausts,
    rearWheelL: wheels.rl,
    rearWheelR: wheels.rr,
    tintMaterials: [paint],
    wheelMesh,
    syncWheels,
    wheelRadius: { front: WHEEL_RADIUS_FRONT, rear: WHEEL_RADIUS_REAR },
    kartScale,
    ownedMaterials: glassMat ? [paint, glassMat] : [paint],
  };
  return root;
}

// Free the per-kart GPU resources of a model built by buildKartModel (its
// materials and the wheel instance buffer). Geometries are cached and shared
// between models of the same character, so they stay.
export function disposeKartModel(model) {
  const ud = model && model.userData;
  if (!ud) return;
  if (ud.ownedMaterials) for (const m of ud.ownedMaterials) m.dispose();
  ud.ownedMaterials = [];
  if (ud.wheelMesh && ud.wheelMesh.dispose) ud.wheelMesh.dispose();
  ud.wheelMesh = null;
}
