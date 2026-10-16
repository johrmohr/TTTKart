// Kart view (browser): renders one Kart with its character model, animates it
// from the physics state every frame and spawns the kart's particle effects
// (SPEC §6).
//
//   const view = new KartView(kart, scene, effects);
//   view.update(dt, camera);        // every frame, after the physics substeps
//   view.dispose();
//
// Scene hierarchy (view.object is what goes into the scene):
//   object   kart position; heading + drift slide + spin-out; pitch to the road
//    └ pivot  at mid-kart height: tumble flip, lift and wobble
//       └ model  buildKartModel() root (high or low LOD), offset back down
//          ├ body     suspension: roll in turns, squat/dive, hop/land squash
//          │   ├ chassis, driver (leans) → head (looks into turns, bobs)
//          │   └ exhaust markers (boost flames)
//          └ steer pivots / wheel bones → one InstancedMesh for all 4 wheels
//
// Particles (all through the shared Effects pools): drift sparks from the rear
// wheels colored by mini-turbo tier, boost flames from the exhausts (tier
// colored for drift boosts, a comedic green "toot" puff for item boosts),
// grass + dirt on the off-road, smoke on spins, dizzy stars on tumbles,
// rainbow sparkles while starred, wall/bump sparks, landing dust, exhaust
// puffs while revving on the grid. Emission fades out with camera distance.

import * as THREE from 'three';
import { buildKartModel, disposeKartModel } from './characters.js';
import { DRIFT, HIT, KART } from './config.js';
import { bus } from './bus.js';
import { clamp, damp, TAU } from './utils.js';

export const VIEW_TUNE = {
  driftYaw: 0.19,            // extra visual yaw while drifting (rad), on top of the physical slip
  driftYawRate: 7,
  steerAngle: 0.42,         // max visual front-wheel angle (rad)
  steerRate: 14,
  rollGain: 0.0017,         // body roll per (yawRate * speed)
  rollMax: 0.085,
  accelPitchGain: 0.0032,   // body squat/dive per m/s^2
  accelPitchMax: 0.055,
  airPitchGain: 0.55,       // nose follows the flight path in the air
  airPitchMax: 0.4,
  pivotHeight: 0.55,        // tumble pivot above the ground (m, model space)
  squashK: 170,             // hop/land squash spring stiffness (1/s^2)
  squashC: 9,               // ... damping (1/s)
  wheelDroop: 0.07,         // wheels hang this far down while airborne (m)
  lodNear: 16,              // switch back to the high-detail model inside this distance
  lodFar: 20,               // switch to the low-detail model beyond this distance
  fxNear: 45,               // full particle emission inside this camera distance
  fxFar: 140,               // no particle emission beyond this distance
  blinkHz: 10,              // invulnerability blink frequency
};

const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const TIER_COLORS = DRIFT.tierColors.map((c) => new THREE.Color(c));
const WHITE = new THREE.Color(0xffffff);
const FLAME_HOT = new THREE.Color(0xff9a2a);
const FLAME_END = new THREE.Color(0x7a1200);

// Emission-rate accumulator channels.
const CH = {
  sparkL: 0, sparkR: 1, glowL: 2, glowR: 3, dustL: 4, dustR: 5, flame0: 6, flame1: 7,
  puff: 8, grass: 9, dirt: 10, smoke: 11, star: 12, zap: 13, count: 14,
};

// Scratch vectors (module level, reused every frame — no per-frame allocations).
const _cam = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();

export class KartView {
  /**
   * @param {Kart} kart
   * @param {THREE.Object3D} scene
   * @param {Effects|null} effects
   * @param {{ lod?: 'auto'|'high'|'low' }} [opts]
   */
  constructor(kart, scene, effects = null, opts = {}) {
    this.kart = kart;
    this.scene = scene;
    this.effects = effects;
    this.lodMode = opts.lod || 'auto';

    this.object = new THREE.Group();
    this.object.name = `kartview:${kart.id}`;
    this.object.rotation.order = 'YXZ';
    this.object.userData.kart = kart;
    this.object.userData.view = this;
    this.pivot = new THREE.Group();
    this.pivot.name = 'pivot';
    this.pivot.position.y = VIEW_TUNE.pivotHeight;
    this.object.add(this.pivot);

    this.models = { high: null, low: null };
    this.model = null;
    this.lod = null;
    this.paint = null;              // the kart's tint material (shared by both LODs)
    this._ownedMaterials = null;
    this._useLod(this.lodMode === 'low' ? 'low' : 'high');

    // animation state
    this.time = Math.random() * 10;
    this.slide = 0;
    this.pitch = 0;
    this.roll = 0;
    this.accel = 0;
    this.steer = 0;
    this.lean = 0;
    this.back = 0;
    this.look = 0;
    this.droop = 0;
    this.sq = 0;
    this.sqV = 0;
    this.spinF = 0;
    this.spinR = 0;
    this._lastSpeed = kart.speed;
    this._wasGrounded = kart.grounded;
    this._lastTier = 0;
    this._tinted = false;
    this._fxNear = 1;               // particle emission scale from camera distance (0..1)
    this._dirtSide = 0;             // alternates dust puffs between the rear wheels
    this._acc = new Float32Array(CH.count);

    // trail emitters remember last frame's world positions
    this._exPrev = [new THREE.Vector3(), new THREE.Vector3()];
    this._exNow = [new THREE.Vector3(), new THREE.Vector3()];
    this._whPrev = [new THREE.Vector3(), new THREE.Vector3()];
    this._whNow = [new THREE.Vector3(), new THREE.Vector3()];
    this._trailsValid = false;
    this._boostColor = FLAME_HOT.clone();
    this._boostColor2 = FLAME_END.clone();
    this._pendingFlameBurst = 0;
    this._pendingToot = false;

    // reusable emit option objects
    this._o = {
      spark: { count: 0, velocity: new THREE.Vector3(), spread: 2, color: new THREE.Color(), size: 0.12, life: 0.3, radius: 0.06, stretch: 0.028, hot: 0.32, from: null },
      glow: { count: 0, velocity: new THREE.Vector3(), spread: 0.5, color: new THREE.Color(), color2: new THREE.Color(), size: 0.34, life: 0.12, radius: 0.07, from: null },
      flame: { count: 0, velocity: new THREE.Vector3(), spread: 0.9, color: new THREE.Color(), color2: new THREE.Color(), size: 0.42, life: 0.2, radius: 0.05, drag: 0, from: null },
      dust: { count: 0, velocity: new THREE.Vector3(), spread: 1.6, color: 0xe2d2ae, size: 0.45, life: 0.7, radius: 0.2, alpha: 0.5, from: null },
      grass: { count: 0, velocity: new THREE.Vector3(), spread: 2.4, radius: 0.18, size: 0.15, from: null },
      puff: { count: 0, velocity: new THREE.Vector3(), spread: 0.5, color: 0xb9bcc4, size: 0.18, life: 0.55, radius: 0.03, alpha: 0.35 },
      smoke: { count: 0, velocity: new THREE.Vector3(), spread: 1.5, size: 0.6, radius: 0.4, alpha: 0.45 },
      sparkle: { count: 0, velocity: new THREE.Vector3(), spread: 1.2, color: 'rainbow', size: 0.22, radius: 0.9, life: 0.6 },
      zap: { count: 0, velocity: new THREE.Vector3(), spread: 3.5, size: 0.3, radius: 0.75, life: 0.24 },
      burst: { count: 0, velocity: new THREE.Vector3(), spread: 4, color: 0xffd36b, size: 0.12, radius: 0.15 },
    };

    this._offs = [
      bus.on('kart:boost', (e) => { if (e.kart === kart) this._onBoost(e); }),
      bus.on('kart:wallHit', (e) => { if (e.kart === kart) this._onWallHit(e); }),
      bus.on('kart:bump', (e) => { if (e.a === kart) this._onBump(e); }),
      bus.on('kart:land', (e) => { if (e.kart === kart) this._onLand(e); }),
      bus.on('kart:spin', (e) => { if (e.kart === kart) this._onSpin(e); }),
      bus.on('kart:tumble', (e) => { if (e.kart === kart) this._onTumble(e); }),
      bus.on('kart:respawn', (e) => { if (e.kart === kart) this._onRespawn(e); }),
      bus.on('kart:starStart', (e) => { if (e.kart === kart) this._onStarStart(e); }),
    ];

    scene.add(this.object);
    this.update(0, null);
  }

  // ------------------------------------------------------------- models

  _buildModel(lod) {
    const m = buildKartModel(this.kart.character, { lod });
    m.position.y = -VIEW_TUNE.pivotHeight;
    const ud = m.userData;
    if (!this.paint) {
      // the view takes ownership of the first model's materials (freed in dispose)
      this.paint = ud.tintMaterials[0];
      this._ownedMaterials = ud.ownedMaterials.slice();
      ud.ownedMaterials = [];
    } else {
      // Share the first model's materials so tinting covers every LOD.
      const map = new Map();
      ud.ownedMaterials.forEach((mat, i) => map.set(mat, this._ownedMaterials[i] || this.paint));
      m.traverse((o) => { if (o.isMesh && map.has(o.material)) o.material = map.get(o.material); });
      for (const mat of ud.ownedMaterials) mat.dispose();
      ud.ownedMaterials = [];
      ud.tintMaterials = [this.paint];
    }
    ud.rest = {
      headY: ud.head.position.y,
      rl: ud.wheels.rl.position.y,
      rr: ud.wheels.rr.position.y,
      fl: ud.steerPivots.fl.position.y,
      fr: ud.steerPivots.fr.position.y,
    };
    this.pivot.add(m);
    return m;
  }

  _useLod(lod) {
    if (!this.models[lod]) this.models[lod] = this._buildModel(lod);
    for (const key of ['high', 'low']) if (this.models[key]) this.models[key].visible = key === lod;
    this.model = this.models[lod];
    this.lod = lod;
  }

  // Root userData of the active model (body, driver, head, wheels, exhausts, ...).
  get parts() { return this.model.userData; }

  // ------------------------------------------------------------- events

  _onBoost(e) {
    if (e.source === 'drift') {
      const tier = clamp(DRIFT.boostDurations.indexOf(e.duration), 1, 3);
      const c = TIER_COLORS[tier] || TIER_COLORS[1];
      this._boostColor.copy(c).lerp(WHITE, 0.3);
      this._boostColor2.copy(c).multiplyScalar(0.25);
      this._pendingFlameBurst = 4 + tier * 3;
    } else {
      this._boostColor.copy(FLAME_HOT);
      this._boostColor2.copy(FLAME_END);
      this._pendingFlameBurst = 8;
      if (e.source === 'item') this._pendingToot = true;
    }
  }

  _onWallHit(e) {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const n = e.normal || { x: 0, z: 0 };
    const o = this._o.burst;
    // contact point on the wall side of the kart
    _p.set(k.position.x - n.x * KART.radius * 0.95, k.position.y + 0.35, k.position.z - n.z * KART.radius * 0.95);
    o.velocity.set(k.velocity.x * 0.45 + n.x * 3, 3.2, k.velocity.z * 0.45 + n.z * 3);
    o.count = Math.round((6 + 22 * (e.intensity || 0.5)) * this._fxNear);
    o.spread = 5; o.color = 0xffd36b; o.size = 0.13;
    fx.emit('spark', _p, o);
    if ((e.intensity || 0) > 0.4) {
      const s = this._o.smoke;
      s.count = 3; s.velocity.set(n.x * 1.5, 0.8, n.z * 1.5); s.size = 0.55; s.color = 0x9a9aa2; s.alpha = 0.4;
      fx.emit('smoke', _p, s);
    }
  }

  _onBump(e) {
    const fx = this.effects;
    if (!fx || this._fxNear <= 0) return;
    const a = e.a.position, b = e.b.position;
    _p.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + 0.45, (a.z + b.z) * 0.5);
    const o = this._o.burst;
    o.velocity.set((e.a.velocity.x + e.b.velocity.x) * 0.4, 2.5, (e.a.velocity.z + e.b.velocity.z) * 0.4);
    o.count = Math.round((5 + 16 * (e.intensity || 0.3)) * this._fxNear);
    o.spread = 5; o.color = 0xfff0b8; o.size = 0.12;
    fx.emit('spark', _p, o);
  }

  _onLand(e) {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const air = clamp(e.airTime || 0, 0, 1.2);
    const o = this._o.dust;
    _p.set(k.position.x, k.position.y + 0.15, k.position.z);
    o.velocity.set(k.velocity.x * 0.35, 0.6, k.velocity.z * 0.35);
    o.count = Math.round((5 + 12 * air) * this._fxNear);
    o.spread = 2.5 + 2 * air; o.size = 0.5; o.radius = 0.85; o.from = null;
    o.color = k.surface === 'offroad' ? 0xb79a6a : 0xe2d2ae;
    fx.emit('dust', _p, o);
    o.radius = 0.2; o.spread = 1.6;
  }

  _onSpin() {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const s = this._o.smoke;
    _p.set(k.position.x, k.position.y + 0.3, k.position.z);
    s.count = 8; s.velocity.set(k.velocity.x * 0.3, 1.0, k.velocity.z * 0.3); s.size = 0.7; s.color = 0xc8c8ce; s.alpha = 0.45;
    fx.emit('smoke', _p, s);
  }

  _onTumble() {
    const fx = this.effects, k = this.kart;
    if (!fx || this._fxNear <= 0) return;
    const o = this._o.sparkle;
    _p.set(k.position.x, k.position.y + 1.3, k.position.z);
    o.count = 14; o.velocity.set(k.velocity.x * 0.5, 2, k.velocity.z * 0.5); o.color = 0xffe14d; o.radius = 0.6; o.size = 0.3; o.life = 0.9;
    fx.emit('sparkle', _p, o);
    const s = this._o.smoke;
    s.count = 10; s.velocity.set(k.velocity.x * 0.3, 1.2, k.velocity.z * 0.3); s.size = 0.8; s.color = 0xb4b4ba; s.alpha = 0.5;
    _p.y = k.position.y + 0.4;
    fx.emit('smoke', _p, s);
  }

  _onRespawn() {
    this._trailsValid = false;
    const fx = this.effects, k = this.kart;
    if (!fx) return;
    const o = this._o.sparkle;
    _p.set(k.position.x, k.position.y + 0.7, k.position.z);
    o.count = 26; o.velocity.set(0, 1.5, 0); o.color = 0xffffff; o.radius = 1.0; o.size = 0.28; o.life = 0.8;
    fx.emit('sparkle', _p, o);
  }

  _onStarStart() {
    const fx = this.effects, k = this.kart;
    if (!fx) return;
    const o = this._o.sparkle;
    _p.set(k.position.x, k.position.y + 0.7, k.position.z);
    o.count = 40; o.velocity.set(k.velocity.x * 0.6, 2, k.velocity.z * 0.6); o.color = 'rainbow'; o.radius = 1.1; o.size = 0.3; o.life = 0.8;
    fx.emit('sparkle', _p, o);
  }

  // Integer number of particles to emit this frame for a continuous rate.
  _count(ch, rate, dt) {
    const a = this._acc[ch] + rate * dt;
    const n = Math.floor(a);
    this._acc[ch] = a - n;
    return n;
  }

  // ------------------------------------------------------------- frame update

  update(dt, camera) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const k = this.kart, T = VIEW_TUNE, d = k.drift, v = k.velocity;
    this.time += dt;
    const speed = k.speed;
    const grounded = k.grounded;
    const disabled = k.isDisabled();

    // ---- camera distance: level of detail + particle budget
    let camDist = 0;
    if (camera) {
      camera.getWorldPosition(_cam);
      camDist = _cam.distanceTo(k.position);
      if (this.lodMode === 'auto') {
        const want = this.lod === 'high' ? (camDist > T.lodFar ? 'low' : 'high') : (camDist < T.lodNear ? 'high' : 'low');
        if (want !== this.lod) this._useLod(want);
      }
    }
    this._fxNear = camera ? clamp(1 - (camDist - T.fxNear) / (T.fxFar - T.fxNear), 0, 1) : 1;
    const ud = this.model.userData, rest = ud.rest;

    // ---- root: position, heading + drift slide + spin-out, pitch to the road
    const o = this.object;
    o.position.copy(k.position);
    this.slide = damp(this.slide, d.active ? -d.dir * T.driftYaw : 0, T.driftYawRate, dt);
    let spin = 0;
    if (k.spinTimer > 0) {
      const dur = k.spinDuration || HIT.spinDuration;
      spin = 2 * TAU * easeOutCubic(clamp(1 - k.spinTimer / dur, 0, 1));   // two full turns
    }
    const fx = Math.sin(k.yaw), fz = Math.cos(k.yaw);
    const hs = Math.hypot(v.x, v.z);
    let wantPitch;
    if (grounded) {
      const t = k.proj && k.proj.tangent;
      const tdot = t ? fx * t.x + fz * t.z : 1;
      wantPitch = -Math.atan((k.roadSlope || 0) * tdot);
    } else {
      wantPitch = -clamp(Math.atan2(v.y, Math.max(hs, 4)) * T.airPitchGain, -T.airPitchMax, T.airPitchMax);
    }
    this.pitch = damp(this.pitch, wantPitch, grounded ? 16 : 5, dt);
    o.rotation.set(this.pitch, k.yaw + this.slide + spin, 0);

    // ---- tumble: one forward flip around the kart's middle, then a wobble
    let flip = 0, lift = 0, wobble = 0;
    if (k.tumbleTimer > 0) {
      const p = clamp(1 - k.tumbleTimer / HIT.tumbleDuration, 0, 1);
      const fp = clamp(p / 0.6, 0, 1);
      flip = TAU * easeInOut(fp);
      lift = Math.sin(fp * Math.PI) * 0.75;
      if (fp >= 1) wobble = Math.sin((p - 0.6) * 32) * 0.14 * (1 - p) / 0.4;
    }
    this.pivot.rotation.set(flip, 0, wobble);
    this.pivot.position.y = T.pivotHeight + lift;

    // ---- body suspension: squat/dive, roll, hop/land squash, road rumble
    if (dt > 0) this.accel = damp(this.accel, clamp((speed - this._lastSpeed) / dt, -60, 60), 8, dt);
    this._lastSpeed = speed;
    const bodyPitch = clamp(-this.accel * T.accelPitchGain, -T.accelPitchMax, T.accelPitchMax);
    const wantRoll = grounded && !disabled ? clamp(k.yawRate * speed * T.rollGain, -T.rollMax, T.rollMax) : 0;
    this.roll = damp(this.roll, wantRoll, 8, dt);
    if (this._wasGrounded && !grounded && v.y > 1) this.sqV += d.hopping ? 2.4 : 1.2;
    if (!this._wasGrounded && grounded) this.sqV -= 1.2 + 2.6 * clamp(k.lastAirTime || 0, 0, 1);
    this._wasGrounded = grounded;
    for (let rem = dt; rem > 1e-6; rem -= 1 / 120) {
      const h = Math.min(rem, 1 / 120);
      this.sqV += (-T.squashK * this.sq - T.squashC * this.sqV) * h;
      this.sq += this.sqV * h;
    }
    this.sq = clamp(this.sq, -0.28, 0.28);
    let rumble = 0;
    if (grounded) {
      const sf = clamp(Math.abs(speed) / 20, 0, 1);
      if (k.surface === 'offroad') rumble = (Math.sin(this.time * 47) + Math.sin(this.time * 31.7)) * 0.011 * sf;
      else if (k.surface === 'curb') rumble = Math.sin(this.time * 70) * 0.014 * sf;
      else if (k.frozen && k.input.throttle > 0) rumble = Math.sin(this.time * 63) * 0.012;   // revving
      else rumble = Math.sin(this.time * 55) * 0.0035 * (k.input.throttle > 0 ? 1 : 0.4);
    }
    const body = ud.body;
    body.position.y = rumble;
    body.rotation.set(bodyPitch, 0, this.roll);
    body.scale.set(1 - this.sq * 0.5, 1 + this.sq, 1 - this.sq * 0.5);

    // ---- wheels: roll with speed, steer (counter-steer while drifting), droop in the air
    const scale = ud.kartScale || 1;
    const rr = ud.wheelRadius.rear * scale, rf = ud.wheelRadius.front * scale;
    this.spinR = (this.spinR + (speed / rr) * dt) % TAU;
    this.spinF = (this.spinF + (speed / rf) * dt) % TAU;
    ud.wheels.rl.rotation.x = ud.wheels.rr.rotation.x = this.spinR;
    ud.wheels.fl.rotation.x = ud.wheels.fr.rotation.x = this.spinF;
    let wantSteer;
    if (d.active && hs > 3) {
      // front wheels point along the direction of travel (relative to the model)
      const vF = v.x * fx + v.z * fz, vR = -v.x * fz + v.z * fx;
      const travel = Math.atan2(-vR, Math.max(1, vF)) - this.slide;
      wantSteer = clamp(travel - k.steerVisual * 0.12, -0.6, 0.6);
    } else {
      wantSteer = -k.steerVisual * T.steerAngle;
    }
    this.steer = damp(this.steer, wantSteer, T.steerRate, dt);
    ud.steerPivots.fl.rotation.y = ud.steerPivots.fr.rotation.y = this.steer;
    this.droop = damp(this.droop, grounded ? 0 : 1, grounded ? 22 : 6, dt);
    const dy = -T.wheelDroop * this.droop;
    ud.wheels.rl.position.y = rest.rl + dy;
    ud.wheels.rr.position.y = rest.rr + dy;
    ud.steerPivots.fl.position.y = rest.fl + dy;
    ud.steerPivots.fr.position.y = rest.fr + dy;
    ud.syncWheels();

    // ---- driver: lean into turns, lean back on boosts, look into the corner, bob
    const wantLean = clamp(k.steerVisual * 0.14 + (d.active ? d.dir * 0.08 : 0), -0.22, 0.22) * (grounded || d.hopping ? 1 : 0.5);
    this.lean = damp(this.lean, disabled ? 0 : wantLean, 8, dt);
    this.back = damp(this.back, (k.boostTimer > 0 ? -0.13 : 0) + clamp(-this.accel * 0.003, -0.06, 0.06), 6, dt);
    ud.driver.rotation.set(this.back, 0, this.lean);
    const wantLook = clamp(-k.steerVisual * 0.32 - (d.active ? d.dir * 0.22 : 0), -0.5, 0.5);
    this.look = damp(this.look, disabled ? 0 : wantLook, 6, dt);
    const sp01 = clamp(Math.abs(speed) / 25, 0, 1);
    const bob = Math.sin(this.time * (5 + Math.abs(speed) * 0.35)) * 0.011 * (0.4 + sp01) - this.sq * 0.06;
    let headYaw = this.look, headRoll = Math.sin(this.time * 2.1) * 0.035;
    if (disabled) {                                                   // dizzy
      headYaw += Math.sin(this.time * 11) * 0.35;
      headRoll += Math.sin(this.time * 15) * 0.28;
    }
    ud.head.position.y = rest.headY + bob;
    ud.head.rotation.set(Math.sin(this.time * 1.7) * 0.03, headYaw, headRoll);

    // ---- star: rainbow hue cycling (flickers off during the last second)
    const paint = this.paint;
    if (k.starTimer > 0) {
      const ending = k.starTimer < 1.2 && Math.floor(this.time * 12) % 2 === 0;
      if (ending) {
        paint.color.set(0xffffff);
        paint.emissive.set(0x000000);
      } else {
        const hue = (this.time * 2.2) % 1;
        paint.color.setHSL(hue, 0.9, 0.72);
        paint.emissive.setHSL((hue + 0.5) % 1, 1, 0.5).multiplyScalar(0.28);
      }
      this._tinted = true;
    } else if (this._tinted) {
      paint.color.set(0xffffff);
      paint.emissive.set(0x000000);
      this._tinted = false;
    }

    // ---- invulnerability blink (~10 Hz)
    const blink = k.invulnTimer > 0 && !disabled && k.starTimer <= 0;
    this.model.visible = !blink || (this.time * T.blinkHz) % 1 < 0.55;

    // ---- particles
    o.updateMatrixWorld(true);
    if (this.effects && dt > 0 && this._fxNear > 0) this._emitEffects(dt, ud);
    else this._trailsValid = false;
    if (d.active) this._lastTier = d.tier; else this._lastTier = 0;
  }

  _emitEffects(dt, ud) {
    const fxs = this.effects, k = this.kart, d = k.drift, v = k.velocity, O = this._o;
    const near = this._fxNear;
    const grounded = k.grounded;
    const yaw = k.yaw + this.slide;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);         // visual forward
    const lx = fz, lz = -fx;                                // visual LEFT (+X in model space)
    const scale = ud.kartScale || 1;
    const rr = ud.wheelRadius.rear * scale;

    // world positions of the rear-wheel contact patches and exhaust tips
    const wn = this._whNow, wp = this._whPrev, en = this._exNow, ep = this._exPrev;
    wn[0].setFromMatrixPosition(ud.wheels.rl.matrixWorld); wn[0].y -= rr * 0.85;
    wn[1].setFromMatrixPosition(ud.wheels.rr.matrixWorld); wn[1].y -= rr * 0.85;
    const ex = ud.exhausts;
    en[0].setFromMatrixPosition(ex[0].matrixWorld);
    en[1].setFromMatrixPosition(ex[ex.length > 1 ? 1 : 0].matrixWorld);
    if (!this._trailsValid || wn[0].distanceToSquared(wp[0]) > 9) {
      for (let i = 0; i < 2; i++) { wp[i].copy(wn[i]); ep[i].copy(en[i]); }
    }

    // ---- drift sparks (rear wheels, tier colored; tier 0 = small white bits)
    if (d.active && grounded && !k.isDisabled()) {
      const tier = d.tier;
      if (tier > this._lastTier && tier > 0) {
        // tier-up pop
        const o = O.burst;
        o.color = TIER_COLORS[tier]; o.count = Math.round(14 * near); o.spread = 6; o.size = 0.14;
        for (let i = 0; i < 2; i++) {
          o.velocity.set(v.x * 0.7, 3, v.z * 0.7);
          fxs.emit('spark', wn[i], o);
        }
        const s = O.sparkle;
        s.color = TIER_COLORS[tier]; s.count = Math.round(8 * near); s.radius = 0.5; s.size = 0.3; s.life = 0.45;
        s.velocity.set(v.x * 0.8, 1.5, v.z * 0.8);
        fxs.emit('sparkle', wn[d.dir > 0 ? 0 : 1], s);
      }
      const o = O.spark;
      const g = O.glow;
      const rate = tier === 0 ? 24 : 55 + 20 * tier;
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;                     // +1 = left wheel
        const n = this._count(i === 0 ? CH.sparkL : CH.sparkR, rate * near, dt);
        if (n > 0) {
          // short hot streaks spraying up/out/back, staying close to the wheel
          o.count = n;
          o.from = wp[i];
          o.velocity.set(v.x * 0.87 - fx * 1.6 + lx * side * 1.6, 2.4, v.z * 0.87 - fz * 1.6 + lz * side * 1.6);
          if (tier === 0) { o.color.set(0xfff8e8); o.size = 0.07; o.life = 0.16; o.spread = 2.2; }
          else { o.color.copy(TIER_COLORS[tier]); o.size = 0.09 + 0.012 * tier; o.life = 0.2 + 0.025 * tier; o.spread = 3.2; }
          fxs.emit('spark', wn[i], o);
        }
        if (tier > 0) {
          // flickering tier-colored plume at the back of the tire (lifted off
          // the road so the camera-facing sprite isn't half buried in it)
          const ng = this._count(i === 0 ? CH.glowL : CH.glowR, 70 * near, dt);
          if (ng > 0) {
            g.count = ng;
            _p.set(wn[i].x - fx * 0.42, wn[i].y + 0.16, wn[i].z - fz * 0.42);
            _q.set(wp[i].x - fx * 0.42, wp[i].y + 0.16, wp[i].z - fz * 0.42);
            g.from = _q;
            g.color.copy(TIER_COLORS[tier]);
            g.color2.copy(TIER_COLORS[tier]).multiplyScalar(0.75);
            g.size = 0.44 + 0.07 * tier;
            g.velocity.set(v.x * 0.97 - fx * 0.6, 0.5, v.z * 0.97 - fz * 0.6);
            fxs.emit('glow', _p, g);
          }
        } else {
          const nd = this._count(i === 0 ? CH.dustL : CH.dustR, 10 * near, dt);
          if (nd > 0) {
            const u = O.dust;
            u.count = nd; u.from = wp[i]; u.color = 0xe9e3d6; u.size = 0.3; u.alpha = 0.35; u.spread = 1;
            u.velocity.set(v.x * 0.6, 0.4, v.z * 0.6);
            fxs.emit('dust', wn[i], u);
            u.from = null; u.alpha = 0.5; u.spread = 1.6;
          }
        }
      }
    }

    // ---- boost flames from the exhausts
    if (this._pendingToot) {
      // comedic "toot": a green puff cloud out of the pipes
      this._pendingToot = false;
      // (inherits most of the kart's velocity so the cloud hangs behind the kart
      // in front of the chase camera for a moment instead of vanishing)
      const s = O.smoke;
      s.count = Math.round(14 * near); s.color = 0xa8e05a; s.size = 0.7; s.alpha = 0.6; s.spread = 2.2;
      s.velocity.set(v.x * 0.82 - fx * 2, 1.0, v.z * 0.82 - fz * 2);
      _p.copy(en[0]).add(en[1]).multiplyScalar(0.5);
      fxs.emit('stink', _p, s);
    }
    if (k.boostTimer > 0) {
      const f = O.flame;
      f.color.copy(this._boostColor);
      f.color2.copy(this._boostColor2);
      const burst = this._pendingFlameBurst;
      this._pendingFlameBurst = 0;
      for (let i = 0; i < 2; i++) {
        // drag-free and fully inherited: the flame jets stay attached to the pipes
        const n = this._count(i === 0 ? CH.flame0 : CH.flame1, 75 * near, dt) + Math.round(burst * near);
        if (n <= 0) continue;
        f.count = n;
        f.from = ep[i];
        f.size = burst > 0 ? 0.58 : 0.46;
        f.life = burst > 0 ? 0.24 : 0.19;
        f.velocity.set(v.x - fx * 7.5, v.y * 0.5 + 0.35, v.z - fz * 7.5);
        fxs.emit('flame', en[i], f);
      }
    } else {
      this._pendingFlameBurst = 0;
      // exhaust puffs: revving on the grid / pulling away slowly
      const thr = k.input.throttle || 0;
      const slow = Math.abs(k.speed) < 12;
      if (thr > 0.1 && (k.frozen || (slow && grounded))) {
        const n = this._count(CH.puff, (k.frozen ? 16 : 9) * near * thr, dt);
        if (n > 0) {
          const pf = O.puff;
          pf.count = 1;
          pf.color = k.frozen ? 0x9a9da6 : 0xc4c7ce;
          for (let j = 0; j < n; j++) {
            const e = en[j % 2];
            pf.velocity.set(v.x * 0.5 - fx * 1.4, 0.9, v.z * 0.5 - fz * 1.4);
            fxs.emit('smoke', e, pf);
          }
        }
      }
    }

    // ---- off-road: grass clippings + dirt from the rear wheels
    if (grounded && k.surface === 'offroad' && Math.abs(k.speed) > 3) {
      const sp = Math.abs(k.speed);
      const n = this._count(CH.grass, sp * 3.2 * near, dt);
      if (n > 0) {
        // clippings + dirt clods kicked up and back from both rear wheels
        const gr = O.grass;
        for (let i = 0; i < 2; i++) {
          gr.count = i === 0 ? Math.ceil(n / 2) : Math.floor(n / 2);
          if (!gr.count) continue;
          gr.from = wp[i];
          const side = i === 0 ? 1 : -1;
          gr.velocity.set(v.x * 0.45 - fx * 2.5 + lx * side * 1.2, 3.6, v.z * 0.45 - fz * 2.5 + lz * side * 1.2);
          fxs.emit('grass', wn[i], gr);
        }
      }
      const nd = this._count(CH.dirt, (4 + sp * 1.3) * near, dt);
      for (let j = 0; j < nd; j++) {
        // tan dust clouds rolling off the tires
        const u = O.dust;
        const w = (this._dirtSide = 1 - (this._dirtSide || 0));
        u.count = 1; u.from = wp[w]; u.color = 0xc9a86f; u.size = 0.62; u.alpha = 0.6; u.spread = 1.3;
        u.velocity.set(v.x * 0.4, 0.9, v.z * 0.4);
        fxs.emit('dust', wn[w], u);
        u.from = null; u.alpha = 0.5; u.spread = 1.6;
      }
    }

    // ---- spin-out tire smoke
    if (k.spinTimer > 0 && grounded) {
      const n = this._count(CH.smoke, 26 * near, dt);
      if (n > 0) {
        const s = O.smoke;
        s.count = n; s.color = 0xd0d0d6; s.size = 0.55; s.alpha = 0.4; s.spread = 1.2;
        s.velocity.set(v.x * 0.25, 0.9, v.z * 0.25);
        _p.copy(wn[0]).add(wn[1]).multiplyScalar(0.5);
        fxs.emit('smoke', _p, s);
      }
    }

    // ---- star: rainbow sparkles trailing the kart
    if (k.starTimer > 0) {
      const n = this._count(CH.star, 70 * near, dt);
      if (n > 0) {
        const s = O.sparkle;
        s.count = n; s.color = 'rainbow'; s.radius = 1.0; s.size = 0.3; s.life = 0.6;
        s.velocity.set(v.x * 0.55, 0.8, v.z * 0.55);
        _p.set(k.position.x, k.position.y + 0.65, k.position.z);
        fxs.emit('sparkle', _p, s);
      }
    }

    // ---- zapped: electric crackle
    if (k.slowTimer > 0) {
      const n = this._count(CH.zap, 26 * near, dt);
      if (n > 0) {
        const z = O.zap;
        z.count = n; z.color = (this.time * 7) % 1 < 0.5 ? 0xfff36b : 0xbfefff;
        z.velocity.set(v.x * 0.8, 0.5, v.z * 0.8);
        _p.set(k.position.x, k.position.y + 0.7, k.position.z);
        fxs.emit('zap', _p, z);
      }
    }

    for (let i = 0; i < 2; i++) { wp[i].copy(wn[i]); ep[i].copy(en[i]); }
    this._trailsValid = true;
  }

  // ------------------------------------------------------------- teardown

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
    if (this.object.parent) this.object.parent.remove(this.object);
    for (const key of ['high', 'low']) {
      const m = this.models[key];
      if (m) disposeKartModel(m);
      this.models[key] = null;
    }
    if (this._ownedMaterials) for (const mat of this._ownedMaterials) mat.dispose();
    this._ownedMaterials = null;
    this.model = null;
  }
}
