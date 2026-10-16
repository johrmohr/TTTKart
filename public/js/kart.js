// Kart physics. Node-safe (no DOM): used by the browser game and by the
// headless simulation (tools/sim.mjs).
//
// Model (SPEC §5): each substep the horizontal velocity is split into a
// forward part vF (along the nose) and a lateral part vR. The engine, brakes
// and drag act on vF; lateral grip bleeds vR away and converts most of it
// back into vF (so turning redirects momentum instead of eating it). Steering
// sets a target yaw rate that the kart eases toward. The vertical axis is
// handled separately: grounded karts ride the road height from
// track.project(); they leave the ground when the road curves away faster
// than gravity (hill crest) or drops away (kicker ramp lip).
//
// Conventions: forward = (sin yaw, 0, cos yaw), right = (-cos yaw, 0, sin yaw);
// steer +1 = RIGHT, which DEcreases yaw.

import * as THREE from 'three';
import { KART, DRIFT, HIT, BOOST, STAR } from './config.js';
import { bus } from './bus.js';
import { clamp, lerp, damp, wrapAngle, angleDiff } from './utils.js';
import { statsFromRatings } from './characters.js';

// Feel tuning that is private to the kart model (shared constants live in config.js).
export const KART_TUNE = {
  // steering
  turnRefSpeed: 8,          // m/s at which steering reaches full authority
  highSpeedTurnLoss: 0.30,   // fraction of turn rate lost near top speed
  yawResponse: 9,          // 1/s: how fast the yaw rate follows the stick
  airSteer: 0.45,           // turn authority while airborne (jumps)
  hopSteer: 1.0,            // turn authority during a drift hop
  // drift (yaw-rate multipliers of turnRate: counter-steer .. into the drift)
  driftWide: 0.12,
  driftTight: 0.92,
  driftSpeedMult: 0.985,    // drifting is a hair slower than driving straight
  driftChargeInto: 1.3,
  driftCancelSpeed: 6,
  driftMaxAir: 0.6,
  landDriftGrace: 0.22,     // s after landing in which steering can still start a drift
  // grip (1/s decay of lateral velocity) + fraction of lateral energy kept
  grip: 10,
  driftGrip: 4.4,
  offroadGrip: 7,
  airGrip: 0.8,
  spinGrip: 3,
  gripTransfer: 0.8,
  driftTransfer: 0.985,
  // longitudinal
  accelExp: 2.4,            // accel falls off as 1 - (v/vmax)^accelExp
  accelFloor: 0.06,
  offroadAccelMult: 0.75,
  reverseAccel: 12,
  overspeedMin: 6,          // m/s^2 decel when slightly above max (boost tail)
  overspeedMax: 25,         // m/s^2 cap (entering grass at speed)
  overspeedGain: 1.2,
  slopeAccel: 7,            // m/s^2 per unit slope (uphill slows, downhill helps)
  cornerDrag: 0.07,         // decel per m/s^2 of lateral accel when steering (not drifting)
  airDrag: 0.05,
  // vertical
  hopGravityMult: 1.6,      // snappier drift hops (~0.22 s)
  landEventAir: 0.25,
  tumbleHop: 6,
  // hits
  spinDecay: 1.2,           // -> ~30% speed after a 1 s spin
  tumbleDecay: 1.535,       // -> ~10% after a 1.5 s tumble
  // walls
  wallRadius: KART.radius,
  wallBounce: 0.2,
  wallBounceMax: 4,
  wallScrub: 0.45,
  wallFreshImpact: 4,       // m/s: normal speed that counts as a new impact while touching
  wallFriction: 0.5,
  wallSlideTime: 0.3,
  wallAlign: 9,
  wallAlignTime: 0.3,
  wallEventMin: 1.5,        // m/s of normal impact speed to count as a hit
  wallEventScale: 18,
  wallCooldown: 0.3,
  // bumps
  bumpRestitution: 0.5,
  bumpKick: 3,
  bumpMassExp: 2,           // effective mass = mass^exp (exaggerates weight classes)
  bumpEventScale: 14,
  bumpCooldown: 0.25,
  bumpSlideTime: 0.35,      // s of reduced lateral grip after a hard bump (karts get shoved)
  bumpSlideGrip: 2.5,
  starRamKick: 7,
};

const T = KART_TUNE;

export class Kart {
  constructor({ id, character, track, isPlayer = false }) {
    this.id = id ?? (character && character.id);
    this.character = character;
    this.isPlayer = isPlayer;
    this.track = track;
    this.stats = statsFromRatings(character && character.ratings);

    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.velocity = new THREE.Vector3();
    this.grounded = true;
    this.airTime = 0;
    this.lastAirTime = 0;

    this.input = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false };
    this.proj = {};
    this.hint = -1;

    this.drift = { active: false, dir: 0, charge: 0, tier: 0, hopping: false };
    this.boostTimer = 0;
    this.boostSource = null;
    this.starTimer = 0;
    this.spinTimer = 0;
    this.spinDuration = HIT.spinDuration;   // length of the current spin (for views)
    this.tumbleTimer = 0;
    this.slowTimer = 0;
    this.invulnTimer = 0;
    this.stallTimer = 0;
    this.frozen = false;
    this.speedMult = 1;
    this.surface = 'road';
    this.steerVisual = 0; this.drunkTimer = 0; this._driveClock = 0;
    this.yawRate = 0;
    this.wallContact = 0;                   // > 0 for a moment after touching a wall

    // race bookkeeping (race.js)
    this.distance = 0; this.lap = 0; this.place = 0; this.finished = false;
    this.finishTime = null; this.lapTimes = []; this.lapStartTime = 0; this.wrongWay = false;
    // item bookkeeping (items.js)
    this.item = null; this.itemCount = 0; this.rolling = false; this.rollTimer = 0; this.rollItem = null;

    // internals
    this._driftHeld = false;
    this._driftAir = 0;
    this._landGrace = 0;
    this._padCooldown = 0;
    this._wallCooldown = 0;
    this._bumpCooldown = 0;
    this._bumpSlide = 0;
    this._wallAlignYaw = 0;
    this._wallAlignTimer = 0;
    this._prevSlope = 0;      // road slope (incl. ramp) under the kart last step
    this._moved = false;
  }

  // ------------------------------------------------------------- queries

  get speed() {
    return this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw);
  }

  get horizontalSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  // Road slope dy/ds (along the track tangent) under the kart, including
  // kicker ramps. Used by views to pitch the model.
  get roadSlope() { return this._prevSlope; }

  get maxSpeed() {
    let m = this.stats.topSpeed * this.speedMult;
    const star = this.starTimer > 0, boost = this.boostTimer > 0;
    if (!star && !boost) {
      if (this.surface === 'offroad') m *= KART.offroadSpeedMult + (this.character?.wheelType === 'offroad' ? .12 : 0);
      else if (this.surface === 'curb') m *= KART.curbSpeedMult;
    }
    if (boost) m *= KART.boostSpeedMult;
    if (star) m *= KART.starSpeedMult;
    if (this.slowTimer > 0) m *= HIT.zapSlowMult;
    return m;
  }

  isInvincible() { return this.starTimer > 0; }
  isHittable() { return this.starTimer <= 0 && this.invulnTimer <= 0 && this.spinTimer <= 0 && this.tumbleTimer <= 0; }
  isDisabled() { return this.spinTimer > 0 || this.tumbleTimer > 0; }

  // ------------------------------------------------------------- control

  placeOnGrid(slot) {
    this.position.copy(slot.position);
    this.yaw = slot.yaw;
    this._resetState();
    this.hint = -1;
    this.track.project(this.position, -1, this.proj);
    this.hint = this.proj.index;
    this.position.y = this.proj.height;
    this.surface = this.proj.surface;
  }

  _resetState() {
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.grounded = true;
    this.airTime = 0;
    this.lastAirTime = 0;
    const d = this.drift;
    d.active = false; d.dir = 0; d.charge = 0; d.tier = 0; d.hopping = false;
    this.boostTimer = 0; this.starTimer = 0; this.spinTimer = 0; this.tumbleTimer = 0;
    this.slowTimer = 0; this.invulnTimer = 0; this.stallTimer = 0;
    this.steerVisual = 0; this.drunkTimer = 0; this._driveClock = 0;
    this.wallContact = 0;
    this._driftAir = 0; this._landGrace = 0; this._padCooldown = 0;
    this._wallCooldown = 0; this._bumpCooldown = 0; this._bumpSlide = 0; this._prevSlope = 0;
    this._wallAlignTimer = 0;
    this._driftHeld = !!this.input.drift;
  }

  applyBoost(duration, source = 'item') {
    if (!(duration > 0)) return;
    this.boostTimer = Math.max(this.boostTimer, duration);
    this.boostSource = source;
    bus.emit('kart:boost', { kart: this, source, duration });
  }

  spinOut(cause = 'banana') {
    if (!this.isHittable()) return false;
    this._beginSpin(HIT.spinDuration, cause);
    return true;
  }

  tumble(cause = 'rocket') {
    if (!this.isHittable()) return false;
    this.tumbleTimer = HIT.tumbleDuration;
    this._cancelDrift();
    this.boostTimer = 0;
    if (!this.frozen) {
      this.velocity.y = Math.max(this.velocity.y, T.tumbleHop);
      this.grounded = false;
      this.airTime = 0;
    }
    bus.emit('kart:tumble', { kart: this, cause });
    return true;
  }

  zap() {
    if (this.isInvincible()) return false;
    this.slowTimer = Math.max(this.slowTimer, HIT.zapSlowDuration);
    if (!this.isDisabled()) this._beginSpin(HIT.zapSpinDuration, 'zap');
    return true;
  }

  _beginSpin(duration, cause) {
    this.spinTimer = duration;
    this.spinDuration = duration;
    this._cancelDrift();
    this.boostTimer = 0;
    bus.emit('kart:spin', { kart: this, cause });
  }

  startStar(duration = STAR.duration) {
    this.drunkTimer = 0;
    const was = this.starTimer > 0;
    this.starTimer = Math.max(this.starTimer, duration);
    this.spinTimer = 0;
    this.tumbleTimer = 0;
    this.slowTimer = 0;
    if (!was) bus.emit('kart:starStart', { kart: this });
  }

  respawn() {
    const tr = this.track;
    let s = this.proj && isFinite(this.proj.s) ? this.proj.s : 0;
    if (!isFinite(s)) s = 0;
    const f = tr.frameAt(s);
    tr.pointAt(s, 0, this.position);
    this.yaw = f.yaw;
    this._resetState();
    this.invulnTimer = Math.max(this.invulnTimer, 1.5);
    this.hint = -1;
    tr.project(this.position, -1, this.proj);
    this.hint = this.proj.index;
    this.position.y = this.proj.height;
    this.surface = this.proj.surface;
    bus.emit('kart:respawn', { kart: this });
  }

  _startDrift(dir) {
    const d = this.drift;
    d.active = true;
    d.dir = dir;
    d.charge = 0;
    d.tier = 0;
    this._driftAir = 0;
    this._landGrace = 0;
    bus.emit('kart:driftStart', { kart: this, dir });
  }

  // Release: mini-turbo for tier >= 1.
  _endDrift() {
    const d = this.drift;
    if (!d.active) return;
    const tier = d.tier;
    d.active = false; d.dir = 0; d.charge = 0; d.tier = 0;
    if (tier >= 1) this.applyBoost(DRIFT.boostDurations[tier], 'drift');
    bus.emit('kart:driftEnd', { kart: this, tier });
  }

  // Abort without reward (spin, too slow, too long airborne).
  _cancelDrift() {
    const d = this.drift;
    d.hopping = false;
    this._landGrace = 0;
    if (!d.active) return;
    d.active = false; d.dir = 0; d.charge = 0; d.tier = 0;
    bus.emit('kart:driftEnd', { kart: this, tier: 0, cancelled: true });
  }

  _tickTimers(dt) {
    this._driveClock += dt;
    this.drunkTimer = Math.max(0, this.drunkTimer - dt);
    if (this.boostTimer > 0) this.boostTimer = Math.max(0, this.boostTimer - dt);
    if (this.starTimer > 0) {
      this.starTimer -= dt;
      if (this.starTimer <= 0) { this.starTimer = 0; bus.emit('kart:starEnd', { kart: this }); }
    }
    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      if (this.spinTimer <= 0) {
        this.spinTimer = 0;
        if (this.tumbleTimer <= 0) this.invulnTimer = Math.max(this.invulnTimer, HIT.invulnAfterHit);
      }
    }
    if (this.tumbleTimer > 0) {
      this.tumbleTimer -= dt;
      if (this.tumbleTimer <= 0) {
        this.tumbleTimer = 0;
        if (this.spinTimer <= 0) this.invulnTimer = Math.max(this.invulnTimer, HIT.invulnAfterHit);
      }
    }
    if (this.slowTimer > 0) this.slowTimer = Math.max(0, this.slowTimer - dt);
    if (this.invulnTimer > 0 && !this.isDisabled()) this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    if (this.stallTimer > 0) this.stallTimer = Math.max(0, this.stallTimer - dt);
    if (this._padCooldown > 0) this._padCooldown -= dt;
    if (this._wallCooldown > 0) this._wallCooldown -= dt;
    if (this._bumpCooldown > 0) this._bumpCooldown -= dt;
    if (this._bumpSlide > 0) this._bumpSlide -= dt;
    if (this._wallAlignTimer > 0) this._wallAlignTimer -= dt;
    if (this._landGrace > 0) this._landGrace -= dt;
    if (this.wallContact > 0) this.wallContact -= dt;
  }

  // Slope contribution of kicker ramps at the projected point (matches track.rampHeight).
  _rampSlope(proj) {
    if (!proj.onRamp) return 0;
    const ramps = this.track.ramps;
    let best = 0, bestH = 0;
    for (let i = 0; i < ramps.length; i++) {
      const r = ramps[i];
      const d = this.track.deltaS(r.s0, proj.s);
      if (d < 0 || d > r.length) continue;
      const inside = r.fullWidth ? Math.abs(proj.lateral) <= proj.halfWidth : proj.lateral >= r.lat0 && proj.lateral <= r.lat1;
      if (!inside) continue;
      const h = (r.height * d) / r.length;
      if (h >= bestH) { bestH = h; best = r.height / r.length; }
    }
    return best;
  }

  // ---------------------------------------------------------------- step

  update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;
    const tr = this.track, p = this.position, v = this.velocity, inp = this.input, d = this.drift, proj = this.proj;
    this._tickTimers(dt);

    if (this.frozen) {
      v.set(0, 0, 0);
      this.yawRate = 0;
      tr.project(p, this.hint, proj);
      this.hint = proj.index;
      p.y = proj.height;
      this.grounded = true;
      this.airTime = 0;
      this.surface = proj.surface;
      this._prevSlope = proj.slope;
      if (d.active || d.hopping) this._cancelDrift();
      this._driftHeld = !!inp.drift;
      this.steerVisual = damp(this.steerVisual, clamp(+inp.steer || 0, -1, 1), 12, dt);
      return;
    }

    const disabled = this.isDisabled();
    const wobble = this.drunkTimer > 0 ? Math.min(1,this.drunkTimer) * (Math.sin(this._driveClock*3.2 + this.position.z*.008)*.28 + Math.sin(this._driveClock*5.7)*.09) : 0;
    const steer = disabled ? 0 : clamp((+inp.steer || 0) + wobble, -1, 1);
    const throttle = disabled || this.stallTimer > 0 ? 0 : clamp(+inp.throttle || 0, 0, 1);
    const brake = disabled ? 0 : clamp(+inp.brake || 0, 0, 1);
    const driftBtn = !disabled && !!inp.drift;
    const st = this.stats;

    // ---- drift button: hop / start / release
    const pressed = driftBtn && !this._driftHeld;
    this._driftHeld = driftBtn;
    if (pressed && this.grounded && !d.active && this.speed >= DRIFT.minSpeed) {
      v.y = DRIFT.hopVelocity;
      this.grounded = false;
      this.airTime = 0;
      d.hopping = true;
      bus.emit('kart:hop', { kart: this });
      if (Math.abs(steer) > 0.2) this._startDrift(Math.sign(steer));
    }
    if (d.active && !driftBtn) this._endDrift();
    if (!driftBtn) this._landGrace = 0;

    // ---- steering -> yaw
    let vF0 = this.speed;
    const aF = Math.abs(vF0);
    let target;
    if (d.active) {
      const t = clamp((steer * d.dir + 1) * 0.5, 0, 1);
      target = -d.dir * st.turnRate * lerp(T.driftWide, T.driftTight, t) * Math.min(1, aF / 10);
    } else {
      let f = Math.min(1, aF / T.turnRefSpeed);
      f *= 1 - T.highSpeedTurnLoss * clamp((aF - 12) / 18, 0, 1);
      target = -steer * st.turnRate * f * (vF0 < -0.5 ? -1 : 1);
    }
    if (!this.grounded) target *= d.hopping ? T.hopSteer : T.airSteer;
    if (disabled) target = 0;
    this.yawRate = damp(this.yawRate, target, T.yawResponse, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    if (this._wallAlignTimer > 0 && !d.active) {
      this.yaw = wrapAngle(this.yaw + angleDiff(this.yaw, this._wallAlignYaw) * (1 - Math.exp(-T.wallAlign * dt)));
    }

    // ---- decompose horizontal velocity on the new heading
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = -fz, rz = fx;
    let vF = v.x * fx + v.z * fz;
    let vR = v.x * rx + v.z * rz;

    // ---- longitudinal
    let maxS = this.maxSpeed;
    if (d.active) maxS *= T.driftSpeedMult;
    if (disabled) {
      const k = Math.exp(-(this.tumbleTimer > 0 ? T.tumbleDecay : T.spinDecay) * dt);
      vF *= k; vR *= k;
    } else if (this.grounded) {
      const boosting = this.boostTimer > 0;
      const hs = Math.hypot(vF, vR);
      if (brake > 0 && vF > 0.5 && !boosting) {
        vF = Math.max(0, vF - KART.brakeDecel * brake * dt);
      } else if (brake > 0 && throttle <= 0 && !boosting) {
        // reverse
        if (vF > -KART.reverseMax) vF = Math.max(-KART.reverseMax, vF - T.reverseAccel * brake * dt);
      } else if (throttle > 0 || boosting) {
        if (vF < -0.5) {
          vF = Math.min(0, vF + KART.brakeDecel * dt);
        } else if (hs < maxS) {
          const x = hs / maxS;
          let a = st.accel * Math.max(T.accelFloor, 1 - Math.pow(x, T.accelExp)) * throttle;
          if (this.surface === 'offroad' && !boosting && this.starTimer <= 0) a *= T.offroadAccelMult;
          if (boosting) a = Math.max(a, KART.boostAccel);
          const nv = vF + a * dt;
          // never exceed max with the total horizontal speed
          const lim = Math.sqrt(Math.max(0, maxS * maxS - vR * vR));
          vF = Math.max(vF, Math.min(nv, lim));
        }
      } else if (vF > 0) {
        vF = Math.max(0, vF - KART.coastDecel * dt);
      } else if (vF < 0) {
        vF = Math.min(0, vF + KART.coastDecel * dt);
      }
      // overspeed: ease back down (boost tail, entering grass)
      const hs2 = Math.hypot(vF, vR);
      if (hs2 > maxS + 1e-3) {
        const over = hs2 - maxS;
        const dec = clamp(T.overspeedMin + over * T.overspeedGain, T.overspeedMin, T.overspeedMax);
        const nh = Math.max(maxS, hs2 - dec * dt);
        const k = nh / hs2;
        vF *= k; vR *= k;
      }
      // steering scrubs a little speed (drifting doesn't: that's the reward)
      if (!d.active && !boosting) {
        const lat = Math.abs(this.yawRate * vF);
        vF -= Math.sign(vF) * Math.min(Math.abs(vF), T.cornerDrag * lat * dt);
      }
      // gravity along the slope
      const tdot = fx * proj.tangent.x + fz * proj.tangent.z;
      if (isFinite(proj.slope)) vF -= T.slopeAccel * proj.slope * tdot * dt;
    } else {
      const k = Math.exp(-T.airDrag * dt);
      vF *= k;
    }

    // ---- lateral grip (redirect most of the sideways momentum forward)
    let grip, transfer;
    if (disabled) { grip = T.spinGrip; transfer = 0.3; }
    else if (!this.grounded) { grip = T.airGrip; transfer = 1; }
    else if (d.active) { grip = T.driftGrip; transfer = T.driftTransfer; }
    else if (this.surface === 'offroad') { grip = T.offroadGrip; transfer = T.gripTransfer; }
    else { grip = T.grip; transfer = T.gripTransfer; }
    if (this._bumpSlide > 0 && this.grounded) { grip = Math.min(grip, T.bumpSlideGrip); transfer = 0.2; }
    const vR2 = vR * Math.exp(-grip * dt);
    const dE = vR * vR - vR2 * vR2;
    const tr2 = transfer * clamp(Math.abs(vF) / 6, 0, 1);
    if (tr2 > 0 && dE > 0) vF = (vF >= 0 ? 1 : -1) * Math.sqrt(vF * vF + tr2 * dE);
    vR = vR2;

    v.x = fx * vF + rx * vR;
    v.z = fz * vF + rz * vR;

    // ---- integrate + project
    p.x += v.x * dt;
    p.z += v.z * dt;
    tr.project(p, this.hint, proj);
    this.hint = proj.index;

    // ---- walls
    this._collideWalls(dt, true);

    // ---- vertical
    const h = proj.height;
    const roadSlope = proj.slope + this._rampSlope(proj);
    const tAlong = v.x * proj.tangent.x + v.z * proj.tangent.z;
    const vyRoad = roadSlope * tAlong;
    if (this.grounded) {
      const vyFree = this._prevSlope * tAlong - KART.gravity * dt;
      const yFree = p.y + vyFree * dt;
      if (vyRoad < vyFree - 1e-3 || yFree > h + 0.06) {
        // the road falls away faster than gravity: launch
        this.grounded = false;
        this.airTime = 0;
        v.y = vyFree;
        p.y = Math.max(yFree, h);
      } else {
        p.y = h;
        v.y = vyRoad;
      }
    } else {
      const g = KART.gravity * (d.hopping ? T.hopGravityMult : 1);
      v.y -= g * dt;
      p.y += v.y * dt;
      this.airTime += dt;
      if (p.y <= h) this._land(h, vyRoad, driftBtn, steer);
    }
    this._prevSlope = roadSlope;
    this.surface = proj.surface;

    // ---- drift bookkeeping
    if (this.grounded && !d.active && driftBtn && this._landGrace > 0 && Math.abs(steer) > 0.2 && this.speed >= DRIFT.minSpeed * 0.8) {
      this._startDrift(Math.sign(steer));
    }
    if (d.active) {
      if (this.grounded) {
        this._driftAir = 0;
        d.charge += dt * (steer * d.dir > 0.3 ? T.driftChargeInto : 1);
        while (d.tier < 3 && d.charge >= DRIFT.tierTimes[d.tier]) {
          d.tier++;
          bus.emit('kart:driftTier', { kart: this, tier: d.tier });
        }
      } else {
        this._driftAir += dt;
      }
      if (this.speed < T.driftCancelSpeed || this._driftAir > T.driftMaxAir || disabled) this._cancelDrift();
    }

    // ---- boost pads
    if (this.grounded && proj.surface === 'boost' && this._padCooldown <= 0) {
      this._padCooldown = 0.5;
      this.applyBoost(BOOST.padDuration, 'pad');
    }

    this.steerVisual = damp(this.steerVisual, steer, 12, dt);

    // ---- safety net
    if (!(isFinite(p.x) && isFinite(p.y) && isFinite(p.z) && isFinite(v.x) && isFinite(v.y) && isFinite(v.z) && isFinite(this.yaw))) {
      this.respawn();
    } else if (p.y < h - 8) {
      this.respawn();
    }
  }

  _land(h, vyRoad, driftBtn, steer) {
    const d = this.drift;
    const air = this.airTime;
    this.position.y = h;
    this.velocity.y = vyRoad;
    this.grounded = true;
    this.lastAirTime = air;
    this.airTime = 0;
    const wasHop = d.hopping;
    d.hopping = false;
    if (air > T.landEventAir) bus.emit('kart:land', { kart: this, airTime: air });
    if (!d.active && driftBtn && !this.isDisabled()) {
      if (Math.abs(steer) > 0.2 && this.speed >= DRIFT.minSpeed * 0.8) this._startDrift(Math.sign(steer));
      else if (wasHop || air > 0.15) this._landGrace = T.landDriftGrace;
    }
  }

  // Keep the kart between the walls. Removes velocity into the wall, scrubs
  // speed by impact angle, adds a small bounce and steers the nose along the
  // wall so the kart slides instead of sticking.
  _collideWalls(dt, full) {
    const proj = this.proj, p = this.position, v = this.velocity, tr = this.track;
    const r = T.wallRadius;
    const lat = proj.lateral;
    const limR = proj.wallR - r, limL = -(proj.wallL - r);
    if (lat <= limR && lat >= limL) return false;
    const side = lat > limR ? 1 : -1;
    const pen = side > 0 ? lat - limR : limL - lat;
    const rxv = proj.right.x, rzv = proj.right.z;
    p.x -= rxv * pen * side;
    p.z -= rzv * pen * side;
    proj.lateral -= pen * side;

    // inward wall normal including the wall's taper along s
    const N = tr.N, i = proj.index;
    const arr = side > 0 ? tr.wr : tr.wl;
    const dW = (arr[(i + 1) % N] - arr[(i - 1 + N) % N]) / (2 * tr.spacing);
    let nx = -side * rxv + proj.tangent.x * dW;
    let nz = -side * rzv + proj.tangent.z * dW;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;

    const vn = v.x * nx + v.z * nz;
    const touching = this.wallContact > 0;          // already in contact last step
    this.wallContact = 0.15;
    if (vn >= 0) return true;
    const impact = -vn;
    let tx = v.x - nx * vn, tz = v.z - nz * vn;      // tangential part
    let bounce = 0;
    if (full && (!touching || impact > T.wallFreshImpact)) {
      // fresh impact: scrub by impact angle + small bounce
      const hs = Math.hypot(v.x, v.z) || 1;
      const scrub = 1 - T.wallScrub * clamp(impact / hs, 0, 1);
      tx *= scrub; tz *= scrub;
      bounce = Math.min(impact * T.wallBounce, T.wallBounceMax);
      // let the kart skate along the wall while its nose swings round
      this._bumpSlide = Math.max(this._bumpSlide, T.wallSlideTime * clamp(impact / 10, 0.3, 1));
    } else if (full) {
      // sustained sliding contact: Coulomb-style friction from the normal push
      const tl = Math.hypot(tx, tz);
      if (tl > 1e-6) {
        const k = Math.max(0, tl - T.wallFriction * impact) / tl;
        tx *= k; tz *= k;
      }
    }
    v.x = tx + nx * bounce;
    v.z = tz + nz * bounce;
    if (!full) return true;

    // ease the nose along the wall when it points into it (keeps easing for a
    // moment after a bounce so the kart doesn't drive straight back in)
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const into = fx * nx + fz * nz;
    if (into < -0.02 && !this.drift.active) {
      // wall tangent closest to the current heading (fall back to track direction)
      let wx = nz, wz = -nx;
      let dot = wx * fx + wz * fz;
      if (Math.abs(dot) < 0.2) dot = wx * proj.tangent.x + wz * proj.tangent.z;
      if (dot < 0) { wx = -wx; wz = -wz; }
      this._wallAlignYaw = Math.atan2(wx, wz);
      this._wallAlignTimer = T.wallAlignTime;
    }
    if (impact > T.wallEventMin && this._wallCooldown <= 0) {
      this._wallCooldown = T.wallCooldown;
      bus.emit('kart:wallHit', { kart: this, intensity: clamp(impact / T.wallEventScale, 0, 1), side, normal: { x: nx, z: nz } });
    }
    return true;
  }

  // Re-clamp to the walls after an external push (kart collisions).
  constrainToTrack() {
    this.track.project(this.position, this.hint, this.proj);
    this.hint = this.proj.index;
    this._collideWalls(0, false);
  }
}

// ------------------------------------------------------------ collisions

const R2 = KART.radius * 2;

/**
 * Pairwise circle push-apart + bump impulses. Heavier karts push lighter ones
 * further. A starred kart tumbles anyone hittable it touches and is never
 * pushed itself. Frozen karts are immovable.
 */
export function resolveKartCollisions(karts) {
  const n = karts.length;
  for (let i = 0; i < n; i++) {
    const a = karts[i];
    for (let j = i + 1; j < n; j++) {
      const b = karts[j];
      const pa = a.position, pb = b.position;
      if (Math.abs(pa.y - pb.y) >= 1.5) continue;
      let nx = pb.x - pa.x, nz = pb.z - pa.z;
      const d2 = nx * nx + nz * nz;
      if (d2 >= R2 * R2) continue;
      let dist = Math.sqrt(d2);
      if (dist < 1e-4) {
        // perfectly stacked: separate along a deterministic direction
        const ang = i * 2.39996 + j * 1.13;
        nx = Math.cos(ang); nz = Math.sin(ang); dist = 0;
      } else {
        nx /= dist; nz /= dist;
      }
      const pen = R2 - dist;
      const starA = a.isInvincible(), starB = b.isInvincible();

      if (starA !== starB) {
        const star = starA ? a : b, other = starA ? b : a;
        const sg = starA ? 1 : -1;            // normal points star -> other
        if (other.isHittable()) other.tumble('star');
        if (!other.frozen) {
          other.position.x += nx * sg * pen;
          other.position.z += nz * sg * pen;
          const vrel = (other.velocity.x - star.velocity.x) * nx * sg + (other.velocity.z - star.velocity.z) * nz * sg;
          if (vrel < T.starRamKick) {
            const add = T.starRamKick - vrel;
            other.velocity.x += nx * sg * add;
            other.velocity.z += nz * sg * add;
          }
          other._moved = true;
        }
        if (star._bumpCooldown <= 0 || other._bumpCooldown <= 0) {
          star._bumpCooldown = T.bumpCooldown; other._bumpCooldown = T.bumpCooldown;
          bus.emit('kart:bump', { a: star, b: other, intensity: 1 });
        }
        continue;
      }

      const ima = a.frozen ? 0 : 1 / Math.pow(a.stats.mass, T.bumpMassExp);
      const imb = b.frozen ? 0 : 1 / Math.pow(b.stats.mass, T.bumpMassExp);
      const sum = ima + imb;
      if (sum <= 0) continue;
      pa.x -= nx * pen * (ima / sum); pa.z -= nz * pen * (ima / sum);
      pb.x += nx * pen * (imb / sum); pb.z += nz * pen * (imb / sum);
      if (ima > 0) a._moved = true;
      if (imb > 0) b._moved = true;

      const vrel = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
      if (vrel < 0) {
        const kick = T.bumpKick * clamp(-vrel / 3, 0, 1);
        const jn = (-(1 + T.bumpRestitution) * vrel + kick) / sum;
        a.velocity.x -= nx * jn * ima; a.velocity.z -= nz * jn * ima;
        b.velocity.x += nx * jn * imb; b.velocity.z += nz * jn * imb;
        const intensity = clamp(-vrel / T.bumpEventScale, 0, 1);
        if (-vrel > 2) {
          // let the shove carry: lateral grip is reduced briefly (scaled by how hard)
          const slide = T.bumpSlideTime * clamp(-vrel / 8, 0.3, 1);
          if (ima > 0) a._bumpSlide = Math.max(a._bumpSlide, slide * clamp(ima / imb, 0.4, 1));
          if (imb > 0) b._bumpSlide = Math.max(b._bumpSlide, slide * clamp(imb / ima, 0.4, 1));
        }
        if (intensity > 0.1 && a._bumpCooldown <= 0 && b._bumpCooldown <= 0) {
          a._bumpCooldown = T.bumpCooldown; b._bumpCooldown = T.bumpCooldown;
          bus.emit('kart:bump', { a, b, intensity });
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const k = karts[i];
    if (k._moved) { k._moved = false; if (!k.frozen) k.constrainToTrack(); }
  }
}
