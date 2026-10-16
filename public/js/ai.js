// CPU drivers. Node-safe (no DOM): used by the game and tools/sim.mjs.
//
//   const ai = new AIDriver(kart, { track, difficulty: 'normal', skill: 0.7, rng, personality });
//   // per physics substep, BEFORE items.update() and kart.update():
//   ai.update(dt, { karts, items, race, player });   // writes kart.input
//
// Or build the whole CPU field at once (skills spread around the difficulty's
// aiSkill, personalities per character):
//   const drivers = createAIDrivers(karts, { track, difficulty, rng, player });
//
// Driving model (SPEC §8):
//   * line: track.racingLine blended with a personal offset that wanders
//     slowly, plus a smoothed "avoid" offset (hazards, karts to pass, item
//     boxes, boost pads),
//   * pure-pursuit steering at lookahead 6 m + 0.45 × speed, converted to a
//     steer value with the same speed->turn-rate curve kart.js uses,
//   * speed: lifts / brakes when the planned path ahead is tighter than the
//     kart can turn at its current speed,
//   * hop-drifts long corners (corner map pre-computed per track) for tier
//     1-3 mini-turbos, mapping the required yaw rate onto drift tightness,
//   * items per type, difficulty via kart.speedMult + rubber banding vs the
//     player (vs the pack average when there is no player, e.g. the sim),
//   * stuck recovery: reverse-and-steer after 2 s, respawn after 5 s (or no
//     forward progress for a long time).

import { DIFFICULTY, DRIFT, KART } from './config.js';
import { KART_TUNE } from './kart.js';
import { clamp, damp, angleDiff, smoothstep, randRange, TAU } from './utils.js';

export const AI_TUNE = {
  lookBase: 6,
  lookGain: 0.45,
  edgeMargin: 1.0,          // planned line stays this far inside the road edge
  dodgeMargin: -0.5,        // ... except when dodging (may use the curb)
  dodgeLook: 0.7,           // lookahead scale while dodging a hazard
  // speed control
  turnHeadroom: 0.93,       // use at most this fraction of the kart's turn rate before lifting
  liftSlack: 0.6,           // m/s over the corner speed before lifting
  brakeSlack: 4.5,          // m/s over the corner speed before braking
  // drifting
  driftMaxRadius: 52,       // only corners tighter than this (centerline) are drifted
  cornerCurv: 1 / 75,       // |curvature| that counts as "in a corner" for the corner map
  driftLead: 0.22,          // s: start the hop this long before the corner
  driftMinExtra: 0.35,      // s beyond tier-1 time the corner must last
  driftRelease: 0.12,       // s before the corner ends to release
  driftBiasRate: 1.6,       // 1/s: how fast a wide drift pulls the line to the inside
  // avoidance
  hazardLook: 1.15,         // s of travel scanned for hazards (+ 8 m)
  kartLook: 16,             // m ahead considered for passing
  passGap: 2.9,             // lateral clearance when passing a kart
  sideGap: 2.5,             // lateral spacing kept from a kart alongside
  avoidRateHazard: 5.5,     // 1/s smoothing of the avoid offset when dodging
  avoidRate: 2.4,
  // items
  bouncerMaxTurn: 0.6,      // rad (~35 deg): max road heading change from us to a bouncer target ...
  bouncerClear: 15,         // ... and this many m past it (a miss must not rebound off a corner wall)
  // pace
  rubberNear: 55,           // m: no rubber band inside this gap
  rubberFar: 210,           // m: full rubber band beyond this gap
  paceRate: 0.8,            // 1/s smoothing of kart.speedMult
  // extra CPU pace per difficulty on top of DIFFICULTY.aiSpeedMult (CPUs drift
  // and use boosts well, so their raw pace is trimmed to stay beatable)
  difficultyPace: { easy: 0.965, normal: 0.96, hard: 0.985 },
  finishedPace: 0.86,       // cruise after crossing the line
  // stuck recovery
  stuckSpeed: 2,
  stuckTime: 2,
  reverseTime: 1.1,
  respawnTime: 5,
  noProgressTime: 7,        // s without 4 m of forward progress -> respawn
};

const T = AI_TUNE;

// Per-character driving styles: lateral offset bias + wander amplitude (m),
// racing-line commitment (0 = centerline .. 1 = full racing line),
// aggression (bumping, item eagerness), drift eagerness, item smarts, pace.
export const AI_PERSONALITIES = {
  blaze: { offset: -0.6, wander: 1.5, line: 0.95, aggression: 0.5, drift: 1.0, items: 0.8, pace: 1.0 },
  bolt: { offset: 1.4, wander: 0.9, line: 0.8, aggression: 0.85, drift: 0.65, items: 0.7, pace: 1.0 },
  pip: { offset: -1.8, wander: 1.8, line: 1.0, aggression: 0.3, drift: 0.9, items: 0.75, pace: 1.0 },
  duke: { offset: 0.8, wander: 1.1, line: 0.7, aggression: 0.95, drift: 0.55, items: 0.6, pace: 1.0 },
  nova: { offset: 0.2, wander: 1.3, line: 1.0, aggression: 0.45, drift: 0.9, items: 1.0, pace: 1.0 },
  gus: { offset: -1.1, wander: 1.0, line: 1.0, aggression: 0.35, drift: 0.85, items: 0.7, pace: 1.0 },
  mochi: { offset: 1.8, wander: 1.7, line: 0.85, aggression: 0.55, drift: 0.8, items: 0.8, pace: 1.0 },
  ziggy: { offset: 2.4, wander: 2.2, line: 0.75, aggression: 0.7, drift: 0.75, items: 0.85, pace: 1.0 },
};

const DEFAULT_PERSONALITY = { offset: 0, wander: 1.2, line: 0.9, aggression: 0.5, drift: 0.8, items: 0.8, pace: 1.0 };

// ------------------------------------------------------------ track analysis

// Corner map shared by all drivers on a track: for every sample the signed
// centerline curvature, the remaining length of the corner it belongs to and
// a corner id (index of the corner's first sample).
const _analysis = new WeakMap();

function analyzeTrack(track) {
  let a = _analysis.get(track);
  if (a) return a;
  const N = track.N, sp = track.spacing, curv = track.curv;
  const inCorner = (i) => Math.abs(curv[i]) > T.cornerCurv;
  const run = new Float32Array(N);
  const id = new Int32Array(N).fill(-1);
  // remaining corner length (two passes around the loop for wrap-around)
  for (let pass = 0; pass < 2; pass++) {
    for (let k = N - 1; k >= 0; k--) {
      const i = k, j = (k + 1) % N;
      if (!inCorner(i)) { run[i] = 0; continue; }
      run[i] = inCorner(j) && Math.sign(curv[j]) === Math.sign(curv[i]) ? run[j] + sp : sp;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      if (!inCorner(i)) { id[i] = -1; continue; }
      const p = (i - 1 + N) % N;
      id[i] = inCorner(p) && Math.sign(curv[p]) === Math.sign(curv[i]) && id[p] >= 0 ? id[p] : i;
    }
  }
  a = { run, id };
  _analysis.set(track, a);
  return a;
}

// Curvature (1/m, + = right turn) of the circle through three XZ points.
function curvature3(ax, az, bx, bz, cx, cz) {
  const abx = bx - ax, abz = bz - az, bcx = cx - bx, bcz = cz - bz, cax = ax - cx, caz = az - cz;
  const cross = abx * bcz - abz * bcx;          // > 0: turning left (x right, z forward => sign check below)
  const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(cax, caz);
  if (den < 1e-6) return 0;
  // right = (-cos yaw, 0, sin yaw): a right turn has cross > 0 in (x, z) for this convention
  return (2 * cross) / den;
}

// Deterministic 0..1 hash of two integers (hazard noticing, per-encounter dice).
function hash01(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ driver

export class AIDriver {
  constructor(kart, { track, difficulty = 'normal', skill = 0.7, rng = Math.random, personality = {} } = {}) {
    this.kart = kart;
    this.track = track || kart.track;
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
    this.diff = DIFFICULTY[this.difficulty];
    this.skill = clamp(skill, 0.05, 1);
    this.rng = rng;
    const base = (kart.character && AI_PERSONALITIES[kart.character.id]) || DEFAULT_PERSONALITY;
    this.personality = { ...DEFAULT_PERSONALITY, ...base, ...personality };
    this.analysis = analyzeTrack(this.track);
    this.seed = (rng() * 0x7fffffff) | 0;

    const P = this.personality;
    // slow lateral wander (two incommensurate sines) + skill-dependent sloppiness
    this.wanderW1 = randRange(rng, 0.35, 0.6);
    this.wanderW2 = randRange(rng, 0.9, 1.4);
    this.wanderP1 = rng() * TAU;
    this.wanderP2 = rng() * TAU;
    this.noiseAmp = (1 - this.skill) * 1.3;
    this.noiseW = randRange(rng, 0.5, 0.9);
    this.noiseP = rng() * TAU;
    this.pace = (P.pace || 1) * (0.99 + 0.02 * this.skill) * (T.difficultyPace[this.difficulty] || 1);

    this.time = 0;
    this.offset = 0;          // personal line offset this step (m, + right)
    this.avoid = 0;           // smoothed extra offset (m)
    this.avoidUrgent = false;
    // drift state machine: 'drive' | 'hop' | 'drift'
    this.driftState = 'drive';
    this.driftDir = 0;
    this.hopTime = 0;
    this.driftCooldown = 0;
    this._cornerId = -2;
    this._cornerDrift = false;
    this.driftEntered = false;
    this.driftTime = 0;
    this.wideTime = 0;
    this.driftBias = 0;
    // items
    this.itemHold = 0;
    this.itemReaction = -1;
    this.itemGap = 0;
    // start
    this.startPressAt = null;
    // stuck
    this.stuckTime = 0;
    this.maxStuck = 0;
    this.recoverTimer = 0;
    this.recoverSteer = 0;
    this.recoverCooldown = 0;
    this.progressMark = -Infinity;
    this.noProgress = 0;
    this.respawns = 0;
    this._hasRace = false;
    // stats (sim)
    this.drifts = 0;

    // scratch (no per-step allocations)
    this._f = {};
    this._f2 = {};
    this._pt = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
    this._pts = new Float32Array(10);
    this._yawReq = 0;
    this._alpha = 0;
    this._cWant = 0;
    this._cUrgency = 0;
    this._cHazard = false;
  }

  // ------------------------------------------------------------- update

  update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    const k = this.kart, tr = this.track, inp = k.input;
    const race = ctx.race || null;
    this._hasRace = !!race;
    this.time += dt;
    if (!k.proj || k.proj.s === undefined) { tr.project(k.position, k.hint, k.proj); k.hint = k.proj.index; }
    inp.useItem = false;

    const state = race ? race.state : 'racing';
    if (k.frozen || state === 'intro' || state === 'countdown') { this._prestart(race); return; }

    this._updatePace(dt, ctx);
    if (this.driftCooldown > 0) this.driftCooldown -= dt;
    if (this.recoverCooldown > 0) this.recoverCooldown -= dt;

    if (k.isDisabled()) {
      // nothing to steer; keep the foot down so it recovers quickly
      inp.steer = 0; inp.throttle = 1; inp.brake = 0; inp.drift = false;
      this.driftState = 'drive';
      this.stuckTime = 0;
      this._trackProgress(dt, true);
      return;
    }
    if (this._handleStuck(dt)) return;

    // ---- plan
    const v = Math.max(0, k.speed);
    const s = k.proj.s;
    this._updateOffset();
    this._updateAvoid(dt, ctx, s, v);

    // ---- pure-pursuit steering
    // shorter lookahead while dodging = sharper lateral response
    const Ld = (T.lookBase + T.lookGain * v) * (this.avoidUrgent ? T.dodgeLook : 1);
    const sT = s + Ld;
    let latT = this._plannedLat(sT, this.avoidUrgent ? T.dodgeMargin : T.edgeMargin);
    if (this.driftState === 'drift' && this.driftBias > 0) {
      // drifting a wide corner: pull the line toward the inside so the drift has work to do
      const f = tr.frameAt(sT, this._f);
      latT += (this.driftDir * Math.max(0, f.halfWidth - T.edgeMargin) - latT) * this.driftBias;
    }
    const pt = tr.pointAt(sT, latT, this._pt);
    const dx = pt.x - k.position.x, dz = pt.z - k.position.z;
    const dist = Math.max(1, Math.hypot(dx, dz));
    // aim from the direction of travel while sliding (the nose points inside it)
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    const heading = (this.driftState === 'drift' || k.drift.active) && hs > 5 ? Math.atan2(k.velocity.x, k.velocity.z) : k.yaw;
    const alpha = angleDiff(heading, Math.atan2(dx, dz));        // + = target to the LEFT
    let yawReq = ((2 * Math.sin(alpha)) / dist) * Math.max(v, 4);  // + = turn left
    if (Math.abs(alpha) > 1.3) yawReq = Math.sign(alpha) * 10;     // way off: full lock toward the line
    this._yawReq = yawReq;
    this._alpha = alpha;
    const st = k.stats;
    const fs = this._turnFactor(v);
    let steer = clamp(-yawReq / (st.turnRate * fs), -1, 1);

    // ---- speed control from the curvature of the planned path ahead
    let throttle = 1, brake = 0;
    if (this.driftState !== 'drift' && v > 8) {
      const kap = this._pathCurvatureAhead(s, v, Ld);
      if (kap > 1e-4) {
        const vAllowed = (T.turnHeadroom * st.turnRate * fs) / kap;
        if (v > vAllowed + T.liftSlack) throttle = 0;
        if (v > vAllowed + T.brakeSlack) brake = clamp((v - vAllowed - T.brakeSlack) / 6, 0, 1);
      }
    }
    if (Math.abs(alpha) > 0.75) throttle = Math.min(throttle, 0.55);
    if (Math.abs(alpha) > 1.5 && v > 9) brake = Math.max(brake, 0.5);

    // ---- drifting
    const drift = this._drift(dt, s, v, steer);
    if (drift.active) {
      steer = drift.steer;
      throttle = drift.throttle;
      brake = 0;
    }

    inp.steer = steer;
    inp.throttle = throttle;
    inp.brake = brake;
    inp.drift = drift.button;
    this._trackProgress(dt, false);

    // ---- items
    this._items(dt, ctx, s, v);
  }

  // ------------------------------------------------------------ helpers

  _turnFactor(v) {
    let f = Math.min(1, Math.max(v, 1) / KART_TUNE.turnRefSpeed);
    f *= 1 - KART_TUNE.highSpeedTurnLoss * clamp((v - 12) / 18, 0, 1);
    return f;
  }

  // personal offset: bias + slow wander + sloppiness (low skill)
  _updateOffset() {
    const P = this.personality, t = this.time;
    const wander = P.wander * (0.7 * Math.sin(t * this.wanderW1 + this.wanderP1) + 0.3 * Math.sin(t * this.wanderW2 + this.wanderP2));
    const noise = this.noiseAmp * Math.sin(t * this.noiseW + this.noiseP) * Math.sin(t * 0.37 + this.noiseP * 2);
    this.offset = P.offset + wander + noise;
  }

  // Lateral the driver wants at arc length s, before avoidance.
  _baseLat(s, frame) {
    const f = frame || this.track.frameAt(s, this._f2);
    const lim = Math.max(0, f.halfWidth - T.edgeMargin);
    return clamp(this.personality.line * f.racingLine + this.offset, -lim, lim);
  }

  _plannedLat(s, margin) {
    const f = this.track.frameAt(s, this._f2);
    const lim = Math.max(0, f.halfWidth - margin);
    return clamp(this._baseLat(s, f) + this.avoid, -lim, lim);
  }

  // Max |curvature| of the planned path between ~0.5 lookahead and ~1 s beyond it.
  _pathCurvatureAhead(s, v, Ld) {
    const tr = this.track, P = this._pts;
    const a = s + Ld * 0.5;
    const span = Math.max(6, (Ld * 0.5 + v * 0.9) / 4);
    for (let i = 0; i < 5; i++) {
      const si = a + span * i;
      const p = tr.pointAt(si, this._plannedLat(si, T.edgeMargin), this._pt);
      P[i * 2] = p.x; P[i * 2 + 1] = p.z;
    }
    let kmax = 0;
    for (let i = 0; i < 3; i++) {
      const c = Math.abs(curvature3(P[i * 2], P[i * 2 + 1], P[i * 2 + 2], P[i * 2 + 3], P[i * 2 + 4], P[i * 2 + 5]));
      if (c > kmax) kmax = c;
    }
    return kmax;
  }

  // Whether this driver spots a given hazard (fixed per hazard: no flicker).
  // Big green clouds are hard to miss; peels and balls depend on skill.
  _notices(uid, type) {
    const p = type === 'stink' ? 0.9 + 0.1 * this.skill : 0.5 + 0.48 * this.skill * (0.6 + 0.4 * this.personality.items);
    return hash01(uid, this.seed) < p;
  }

  // ------------------------------------------------------------ avoidance

  // Pick the most urgent reason to shift off the base line and ease the avoid
  // offset toward it: hazards > karts to pass / alongside > boost pads > item boxes.
  _updateAvoid(dt, ctx, s, v) {
    const k = this.kart, tr = this.track;
    this._cWant = 0; this._cUrgency = 0; this._cHazard = false;

    // ---- hazards (bananas, stink clouds, bouncers coming at us)
    const items = ctx.items;
    if (items) {
      const look = 8 + v * T.hazardLook;
      const threats = items.getThreatsNear(k, look + 6);
      for (let i = 0; i < threats.length; i++) {
        const t = threats[i];
        if (!t.ahead) continue;
        // hazards hit when the kart CENTER enters their radius
        let clear;
        if (t.type === 'banana') clear = t.radius + 0.95;
        else if (t.type === 'stink') clear = t.radius + 1.0;
        else if (t.type === 'bouncer') {
          // only dodge balls rolling toward us
          if (t.dirX * Math.sin(k.yaw) + t.dirZ * Math.cos(k.yaw) > -0.2) continue;
          clear = 2.8;
        } else continue;
        const ds = tr.deltaS(s, t.s);
        if (ds < 0.5 || ds > look) continue;
        if (!this._notices(t.ref.uid, t.type)) continue;
        const f = tr.frameAt(t.s, this._f);
        const base = this._baseLat(t.s, f);
        const pl = clamp(base + this.avoid, -f.halfWidth, f.halfWidth);
        // needed while either the base line or the current plan would hit
        // (judging the plan alone would drop the dodge the moment it clears)
        if (Math.abs(base - t.lateral) >= clear && Math.abs(pl - t.lateral) >= clear) continue;
        const lim = f.halfWidth - T.dodgeMargin;
        let side = pl - t.lateral >= 0 ? 1 : -1;     // keep to the side we're already on
        let target = t.lateral + side * clear;
        if (Math.abs(target) > lim) {
          const alt = t.lateral - side * clear;
          target = Math.abs(alt) <= lim ? alt : clamp(target, -lim, lim);
        }
        this._consider(target - base, 2 - ds / look, true);   // always outranks karts
      }
    }

    // ---- other karts: pass the ones we're catching, give room alongside
    const karts = ctx.karts;
    if (karts) {
      const myLat = k.proj.lateral, P = this.personality;
      for (let i = 0; i < karts.length; i++) {
        const o = karts[i];
        if (o === k || !o.proj || o.proj.s === undefined) continue;
        const ds = tr.deltaS(s, o.proj.s);
        if (ds < -3 || ds > T.kartLook) continue;
        const oLat = o.proj.lateral;
        const f = tr.frameAt(o.proj.s, this._f);
        const lim = f.halfWidth - T.edgeMargin;
        if (ds > 1.8) {
          const closing = v - o.speed;
          if (closing < 0.4 && ds > 6) continue;
          const pl = this._baseLat(o.proj.s, f) + this.avoid;
          const dl = pl - oLat;
          if (Math.abs(dl) >= T.passGap) continue;
          // pass on the side we already favour; flip if the road runs out
          let side = Math.abs(dl) > 0.35 ? Math.sign(dl) : (P.offset >= 0 ? 1 : -1);
          let target = oLat + side * T.passGap;
          if (Math.abs(target) > lim) { side = -side; target = clamp(oLat + side * T.passGap, -lim, lim); }
          this._consider(target - this._baseLat(o.proj.s, f), 0.85 * (1 - ds / T.kartLook) + 0.1, false);
        } else {
          const dl = myLat - oLat;
          if (Math.abs(dl) >= T.sideGap + 0.8) continue;
          // heavy, aggressive drivers lean into lighter karts; others keep a gap
          const bully = P.aggression > 0.65 && k.stats.mass > o.stats.mass + 0.15 &&
            hash01(this.seed, (this.time * 0.5) | 0) < (P.aggression - 0.5) * this.diff.itemAggression;
          const target = bully ? oLat + Math.sign(dl || 1) * 1.6 : oLat + Math.sign(dl || 1) * T.sideGap;
          if (!bully && Math.abs(dl) >= T.sideGap) continue;
          this._consider(clamp(target, -lim, lim) - this._baseLat(s), 0.6, false);
        }
      }
    }

    // ---- boost pads and (when empty-handed) item boxes, skill-weighted
    if (this._cUrgency < 0.5) {
      const plNow = this._baseLat(s) + this.avoid;
      const pads = tr.boostPads;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        const ds = tr.deltaS(s, pad.s0);
        if (ds < 4 || ds > 45) continue;
        if (Math.abs(pad.lateral - plNow) > 4.5) continue;
        const f = tr.frameAt(pad.s0 + pad.length * 0.5, this._f);
        this._consider(pad.lateral - this._baseLat(f.s, f), 0.35 * this.skill, false);
      }
      if (items && !k.item && !k.rolling) {
        const rows = tr.itemRows;
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r];
          const ds = tr.deltaS(s, row.s);
          if (ds < 6 || ds > 42) continue;
          let best = null, bd = Infinity;
          for (const b of items.boxes) {
            if (b.row !== r || !b.active) continue;
            const d = Math.abs(b.lateral - plNow);
            if (d < bd) { bd = d; best = b; }
          }
          if (best && bd > 0.6) {
            const f = tr.frameAt(row.s, this._f);
            this._consider(best.lateral - this._baseLat(row.s, f), 0.3 * this.skill * this.personality.items, false);
          }
        }
      }
    }

    this.avoidUrgent = this._cHazard;
    this.avoid = damp(this.avoid, this._cWant, this._cHazard ? T.avoidRateHazard : T.avoidRate, dt);
  }

  // Keep the most urgent avoidance candidate of this step.
  _consider(want, urgency, hazard) {
    if (urgency > this._cUrgency) { this._cUrgency = urgency; this._cWant = want; this._cHazard = hazard; }
  }

  // ------------------------------------------------------------- drifting

  // Returns { active, button, steer, throttle } (reused object).
  _drift(dt, s, v, steer) {
    const k = this.kart, d = k.drift, tr = this.track, A = this.analysis;
    const out = this._driftOut || (this._driftOut = { active: false, button: false, steer: 0, throttle: 1 });
    out.active = false; out.button = false; out.steer = steer; out.throttle = 1;

    if (this.driftState === 'drive') {
      if (this.driftCooldown <= 0 && k.grounded && v > DRIFT.minSpeed + 3 && Math.abs(this._alpha) < 0.6) {
        const i = tr.indexAt(s + v * T.driftLead + 3);
        const c = tr.curv[i];
        if (Math.abs(c) > 1 / T.driftMaxRadius && A.run[i] >= v * (DRIFT.tierTimes[0] + T.driftMinExtra)) {
          const id = A.id[i];
          if (id !== this._cornerId) {
            this._cornerId = id;
            const p = clamp(0.2 + 0.8 * this.skill * this.personality.drift, 0.05, 0.97);
            this._cornerDrift = this.rng() < p;
            if (this._cornerDrift) {
              this.driftState = 'hop';
              this.driftDir = Math.sign(c);
              this.hopTime = 0;
            }
          }
        }
      }
    }

    if (this.driftState === 'hop') {
      this.hopTime += dt;
      if (d.active) {
        this.driftState = 'drift';
        this.driftEntered = false;
        this.driftTime = 0;
        this.wideTime = 0;
        this.driftBias = 0;
        this.drifts++;
      } else if (this.hopTime > 0.45 || (k.grounded && this.hopTime > 0.1)) {
        // hop never turned into a drift (too slow / landed straight): give up on this corner
        this.driftState = 'drive';
        this.driftCooldown = 0.8;
        return out;
      } else {
        out.active = true;
        out.button = true;
        out.steer = this.driftDir * Math.max(0.65, Math.abs(steer));
        return out;
      }
    }

    if (this.driftState === 'drift') {
      if (!d.active) {
        // cancelled by the kart (hit, too slow, airborne too long)
        this.driftState = 'drive';
        this.driftCooldown = 0.4;
        return out;
      }
      const st = k.stats;
      const base = st.turnRate * Math.min(1, v / 10);
      const mag = (-d.dir * this._yawReq) / Math.max(0.2, base);       // yaw multiplier wanted
      const t = (mag - KART_TUNE.driftWide) / (KART_TUNE.driftTight - KART_TUNE.driftWide);
      out.steer = d.dir * clamp(2 * t - 1, -1, 1);
      out.throttle = mag > KART_TUNE.driftTight + 0.25 ? 0.4 : 1;    // too tight even fully in: scrub speed
      // the hop comes slightly before the corner: only judge its end once inside
      this.driftTime += dt;
      const i0 = tr.indexAt(s);
      if (!this.driftEntered && A.run[i0] > 0 && Math.sign(tr.curv[i0]) === d.dir) this.driftEntered = true;
      const i = tr.indexAt(s + v * T.driftRelease);
      const ending = this.driftEntered
        ? A.run[i] < v * T.driftRelease || Math.sign(tr.curv[i]) !== d.dir || A.run[i] === 0
        : this.driftTime > 0.9;
      // needing barely more turn than the widest drift gives: tighten the line
      // toward the inside; still too wide with the line at the inside edge
      // (sustained) -> straighten out
      if (mag < KART_TUNE.driftWide + 0.15) this.driftBias = Math.min(1, this.driftBias + dt * T.driftBiasRate);
      else if (mag > KART_TUNE.driftTight - 0.1) this.driftBias = Math.max(0, this.driftBias - dt * T.driftBiasRate);
      if (mag < KART_TUNE.driftWide - 0.3 && this.driftTime > 0.3 && this.driftBias > 0.9) this.wideTime += dt;
      else this.wideTime = 0;
      // ...but hang on for the last moments before a mini-turbo tier
      const almost = d.tier < 3 && d.charge > DRIFT.tierTimes[d.tier] - 0.3;
      const tooWide = this.wideTime > (almost ? 0.6 : 0.2);
      if (ending || tooWide || Math.abs(this._alpha) > 1.0) {
        this.lastDriftEnd = ending ? 'end' : tooWide ? 'wide' : 'alpha';
        this.driftState = 'drive';
        this.driftCooldown = 0.35;
        return out;          // button released -> mini-turbo if charged
      }
      out.active = true;
      out.button = true;
    }
    return out;
  }

  // --------------------------------------------------------------- pace

  _updatePace(dt, ctx) {
    const k = this.kart, player = ctx.player || null, karts = ctx.karts;
    let target;
    if (k.finished) target = T.finishedPace;
    else if (k === player) target = 1;
    else {
      target = this.diff.aiSpeedMult * this.pace;
      let ref = null;
      if (player) {
        if (!player.finished) ref = player.distance;
      } else if (karts && karts.length > 1) {
        let sum = 0, n = 0;
        for (let i = 0; i < karts.length; i++) if (!karts[i].finished) { sum += karts[i].distance; n++; }
        if (n > 1) ref = sum / n;
      }
      if (ref !== null) {
        const gap = ref - k.distance;      // + = we are behind
        const span = T.rubberFar - T.rubberNear;
        let rb = 0;
        if (gap > T.rubberNear) rb = this.diff.rubberBand * smoothstep((gap - T.rubberNear) / span);
        else if (gap < -T.rubberNear) rb = -this.diff.rubberBand * smoothstep((-gap - T.rubberNear) / span);
        target *= 1 + rb;
      }
    }
    k.speedMult = damp(k.speedMult, target, T.paceRate, dt);
  }

  // -------------------------------------------------------------- start

  // Intro / countdown: sit still, then press the throttle at a planned moment
  // (inside the start-boost window for skilled drivers; a few jump the gun).
  _prestart(race) {
    const inp = this.kart.input;
    inp.steer = 0; inp.brake = 0; inp.drift = false; inp.useItem = false;
    if (!race || race.state !== 'countdown') { inp.throttle = 0; this.startPressAt = null; return; }
    if (this.startPressAt === null) {
      const r = this.rng();
      const pBoost = clamp(0.2 + 0.75 * this.skill, 0, 0.95);
      const pStall = clamp(0.14 - 0.14 * this.skill, 0, 0.14);
      if (r < pBoost) this.startPressAt = randRange(this.rng, 0.3, 0.7);
      else if (r < pBoost + pStall) this.startPressAt = randRange(this.rng, 1.75, 2.6);
      else this.startPressAt = this.rng() < 0.5 ? randRange(this.rng, 0.0, 0.2) : randRange(this.rng, 0.8, 1.4);
    }
    inp.throttle = race.countdown <= this.startPressAt ? 1 : 0;
  }

  // -------------------------------------------------------------- stuck

  // Forward progress watchdog (needs a Race writing kart.distance).
  _trackProgress(dt, disabled) {
    const k = this.kart;
    if (!this._hasRace || k.distance > this.progressMark + 4 || k.finished) { this.progressMark = k.distance; this.noProgress = 0; }
    else if (!disabled) this.noProgress += dt;
  }

  _handleStuck(dt) {
    const k = this.kart, inp = k.input, tr = this.track;
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    if (hs < T.stuckSpeed) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (this.stuckTime > this.maxStuck) this.maxStuck = this.stuckTime;

    if (this.stuckTime > T.respawnTime || this.noProgress > T.noProgressTime) {
      k.respawn();
      this.respawns++;
      this.stuckTime = 0;
      this.noProgress = 0;
      this.progressMark = k.distance;
      this.recoverTimer = 0;
      this.driftState = 'drive';
      return true;
    }
    if (this.recoverTimer > 0) {
      this.recoverTimer -= dt;
      inp.throttle = 0; inp.brake = 1; inp.drift = false; inp.steer = this.recoverSteer;
      if (this.recoverTimer <= 0) this.recoverCooldown = 1.2;
      this._trackProgress(dt, false);
      return true;
    }
    if (this.stuckTime > T.stuckTime && this.recoverCooldown <= 0) {
      // reverse while turning the nose toward the road ahead (reversing
      // inverts steering in kart.js, so steer toward the target's side)
      const f = tr.frameAt(k.proj.s + 8, this._f);
      const pt = tr.pointAt(f.s, 0, this._pt);
      const a = angleDiff(k.yaw, Math.atan2(pt.x - k.position.x, pt.z - k.position.z));
      this.recoverSteer = a >= 0 ? 1 : -1;
      this.recoverTimer = T.reverseTime;
      this.driftState = 'drive';
      inp.throttle = 0; inp.brake = 1; inp.drift = false; inp.steer = this.recoverSteer;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- items

  _items(dt, ctx, s, v) {
    const k = this.kart, items = ctx.items;
    if (!items || k.finished || !k.item || k.rolling) {
      this.itemHold = 0;
      this.itemReaction = -1;
      return;
    }
    const P = this.personality, aggr = this.diff.itemAggression;
    if (this.itemReaction < 0) {
      // reaction time: skilled, eager drivers decide faster
      const base = 1.9 - 1.4 * this.skill * P.items;
      this.itemReaction = Math.max(0.25, base * (1.35 - 0.6 * aggr) * randRange(this.rng, 0.7, 1.35));
    }
    this.itemHold += dt;
    if (this.itemHold < this.itemReaction + this.itemGap) return;
    if (this._shouldUse(k.item, ctx, s, v)) {
      k.input.useItem = true;
      // triple toot: space the next one out
      this.itemGap = k.item === 'triple_toot' && k.itemCount > 1 ? this.itemHold - this.itemReaction + randRange(this.rng, 0.7, 1.4) : 0;
      if (k.itemCount <= 1) this.itemGap = 0;
    }
  }

  _shouldUse(item, ctx, s, v) {
    const k = this.kart, tr = this.track, race = ctx.race, karts = ctx.karts || [];
    const P = this.personality, aggr = this.diff.itemAggression;
    const hold = this.itemHold;
    const holdMax = (16 - 8 * aggr * P.aggression) * (1.2 - 0.4 * P.items);
    const place = race ? race.getPlace(k) : k.place || 1;
    switch (item) {
      case 'star':
        return true;
      case 'beer':
      case 'zap':
        if (place >= 3) return true;
        return place === 2 && hold > 3.5;
      case 'rocket': {
        const tgt = race ? race.getKartAhead(k) : null;
        if (tgt && !tgt.finished) return true;
        return hold > 25 && this._straightAhead(s, 40);
      }
      case 'bouncer':
        if (this._kartInSights(karts, s, 38, 1.5)) return true;
        return hold > holdMax && this._straightAhead(s, 50);
      case 'banana':
      case 'stink': {
        // drop when someone follows on our line (a stink cloud is big, so it
        // goes down a little earlier, which also gives the follower a chance)
        const w = item === 'stink' ? 4.5 : 2.4;
        const near = item === 'stink' ? 7 : 2;
        const far = (item === 'stink' ? 26 : 16) + 6 * aggr;
        for (const o of karts) {
          if (o === k || o.finished) continue;
          const ds = tr.deltaS(o.proj.s, s);         // + = o is behind us
          if (ds > near && ds < far && Math.abs(o.proj.lateral - k.proj.lateral) < w) return true;
        }
        if (hold > holdMax) return true;
        // free the slot right before an item row
        if (hold > 3) {
          for (const row of tr.itemRows) {
            const ds = tr.deltaS(s, row.s);
            if (ds > 4 && ds < 22) return true;
          }
        }
        return false;
      }
      case 'toot':
      case 'triple_toot':
        if (k.boostTimer > 0.15) return false;
        if (k.surface === 'offroad' && v < k.maxSpeed * 0.85) return true;
        if (v > 12 && this._straightAhead(s, 40)) return true;
        return hold > holdMax * 0.8 && v > 10 && this._straightAhead(s, 22);
      default:
        return hold > holdMax;
    }
  }

  // No corner (|curvature| <= 1/110) along the next `len` meters.
  _straightAhead(s, len) {
    const tr = this.track;
    for (let d = 0; d <= len; d += 4) if (Math.abs(tr.curv[tr.indexAt(s + d)]) > 1 / 110) return false;
    return true;
  }

  // Largest heading change (rad) of the road between s and s + len.
  _roadTurn(s, len) {
    const tr = this.track, y0 = tr.yawArr[tr.indexAt(s)];
    let max = 0;
    for (let d = 4; d < len + 4; d += 4) {
      const a = Math.abs(angleDiff(y0, tr.yawArr[tr.indexAt(s + Math.min(d, len))]));
      if (a > max) max = a;
    }
    return max;
  }

  // A kart roughly on our heading line within `range` m (bouncer aim), ahead
  // along the road, with the road running straight to it and a little past
  // it: a ball fired across a corner (the lighthouse hairpin) hits the outer
  // wall and rebounds into the shooter and the karts behind.
  _kartInSights(karts, s, range, width) {
    const k = this.kart, tr = this.track;
    const fx = Math.sin(k.yaw), fz = Math.cos(k.yaw);
    for (const o of karts) {
      if (o === k || o.finished) continue;
      const dx = o.position.x - k.position.x, dz = o.position.z - k.position.z;
      const fwd = dx * fx + dz * fz;
      if (fwd < 4 || fwd > range) continue;
      const perp = Math.abs(dx * fz - dz * fx);
      if (perp >= width + fwd * 0.02) continue;
      const ds = tr.deltaS(s, o.proj.s);
      if (ds < 2 || ds > range + 6) continue;
      if (this._roadTurn(s, ds + T.bouncerClear) > T.bouncerMaxTurn) continue;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Build an AIDriver for every kart except `player`, with skills spread
 * around the difficulty's aiSkill (shuffled) and per-character personalities.
 */
export function createAIDrivers(karts, { track, difficulty = 'normal', rng = Math.random, player = null, skillSpread = 0.12 } = {}) {
  const diff = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const cpus = karts.filter((k) => k !== player && !k.isPlayer);
  const n = cpus.length;
  const offsets = [];
  for (let i = 0; i < n; i++) offsets.push(n > 1 ? -skillSpread + (2 * skillSpread * i) / (n - 1) : 0);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = offsets[i]; offsets[i] = offsets[j]; offsets[j] = t; }
  return cpus.map((k, i) => new AIDriver(k, { track: track || k.track, difficulty, skill: clamp(diff.aiSkill + offsets[i], 0.15, 1), rng }));
}
