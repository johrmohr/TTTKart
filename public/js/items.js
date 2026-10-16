// Item system: item boxes + roulette, held items, hazards (banana peels,
// stink clouds) and projectiles (bouncers, homing rockets), plus the instant
// items (toot boosts, rainbow star, zap cloud). SPEC §8.
//
//   const items = new ItemSystem({ track, karts, scene, effects, rng });
//   // per physics substep, after the AI wrote kart inputs, before kart.update():
//   items.update(dt, race);
//
// Node-safe when constructed with `scene: null` (no THREE objects besides
// Vector3s are created, no DOM access): tools/sim.mjs runs the exact same
// rules headless. With a scene, a small set of pooled meshes is built
// (item boxes = 2 instanced draw calls, bananas = 1, stink clouds = 1,
// plus a few pooled bouncer / rocket / lightning meshes that are only
// visible while in use).
//
// Every hit goes through the Kart API (spinOut / tumble / zap / startStar /
// applyBoost), which handles invincibility and invulnerability itself.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEM, ITEM_IDS, ITEM_INFO, ITEM_TABLE, BOOST, KART } from './config.js';
import { bus } from './bus.js';
import { clamp, damp, angleDiff, weightedPick, TAU } from './utils.js';

// Private tuning of the item rules (shared numbers live in config.js ITEM).
export const ITEM_TUNE = {
  boxHover: 1.1,            // box center height above the road (m)
  boxPickupDy: 2.4,         // vertical tolerance for box pickups
  rollShortenTo: 0.3,       // pressing item while rolling cuts the roulette to this
  // hazards
  bananaBack: 2.2,          // dropped this far behind the kart
  bananaLife: 50,           // s before an untouched peel shrivels away
  bananaOwnerGrace: 0.7,    // s the dropper ignores its own peel
  bananaHitDy: 1.4,
  maxBananas: 20,           // oldest peel is recycled beyond this
  stinkBack: 3.0,
  stinkOwnerGrace: 1.0,     // SPEC: owner immune for the first second
  stinkSlowRate: 0.9,       // 1/s extra speed bleed while inside a cloud ("slight slow")
  stinkHitDy: 3.0,
  stinkShrinkTime: 1.2,     // s at the end of life in which the cloud shrinks away
  stinkGrowTime: 0.45,      // s for a fresh cloud to billow out to full radius (45% -> 100%)
  maxStinks: 8,
  // projectiles
  launchAhead: 1.9,         // spawn this far in front of the kart center
  bouncerRadius: 0.55,
  bouncerBoost: 20,         // launched at max(bouncerSpeed, kartSpeed + this)
  rocketHeight: 0.85,       // cruise height above the road
  rocketLateralRate: 1.6,   // 1/s lateral easing toward the target while following the track
  rocketHomeTurn: 7.0,      // rad/s turn rate while homing (at range) ...
  rocketCloseTurn: 2.0,     // ... rising to speed x this / distance up close: turn radius <= half
                            //     the distance, so it reaches a target at any bearing (a rival
                            //     right alongside is hit, not circled)
  rocketLostGap: -12,       // m: target this far behind the rocket -> fly straight
  kartHitDy: 1.8,
  bananaBlockRadius: 0.6,   // projectile vs banana extra radius
  maxProjectiles: 16,
  zapCooldown: 10,          // s after a zap is rolled/used before another can be rolled
};

const T = ITEM_TUNE;
const ZAP_INDEX = ITEM_IDS.indexOf('zap');

export class ItemSystem {
  constructor({ track, karts, scene = null, effects = null, rng = Math.random }) {
    this.track = track;
    this.karts = karts;
    this.scene = scene;
    this.effects = effects;
    this.rng = rng;
    this.time = 0;
    this.race = null;            // last race passed to update() (places, rocket targets)

    // item boxes (center ~1.1 m above the road)
    this.boxes = track.itemBoxes.map((b, i) => {
      const position = b.position.clone();
      position.y += T.boxHover;
      return { index: i, row: b.row, s: b.s, lateral: b.lateral, position, active: true, respawnTimer: 0 };
    });

    this.hazards = [];           // active bananas + stink clouds
    this.projectiles = [];       // active bouncers + rockets
    this._hazardPool = [];
    this._projPool = [];
    this._uid = 0;

    this._weights = new Float64Array(ITEM_IDS.length);
    this._zapBlockedUntil = -Infinity;
    this._threats = [];
    this._threatPool = [];
    this._frame = {};

    // counters (handy for tests / the sim)
    this.used = Object.fromEntries(ITEM_IDS.map((id) => [id, 0]));

    this.vis = scene ? new ItemVisuals(this, scene, effects) : null;
  }

  // ------------------------------------------------------------- roulette

  /** Item id drawn from ITEM_TABLE[place - 1] (place 1..8). */
  rollFor(kart, place) {
    const n = this.karts.length;
    let idx = clamp(Math.round(place) || 1, 1, ITEM_TABLE.length) - 1;
    // fewer racers than table rows: stretch places over the whole table
    if (n > 1 && n < ITEM_TABLE.length) idx = Math.round(((clamp(place, 1, n) - 1) * (ITEM_TABLE.length - 1)) / (n - 1));
    const row = ITEM_TABLE[idx];
    const w = this._weights;
    for (let i = 0; i < w.length; i++) w[i] = row[i] || 0;
    // one zap at a time: no second zap shortly after the last one
    if (this.time < this._zapBlockedUntil) w[ZAP_INDEX] = 0;
    const id = ITEM_IDS[weightedPick(w, this.rng)];
    if (id === 'zap') this._zapBlockedUntil = this.time + T.zapCooldown;
    return id;
  }

  _startRoll(kart) {
    kart.rolling = true;
    kart.rollTimer = kart.isPlayer ? ITEM.rouletteSeconds : ITEM.aiRouletteSeconds;
    kart.rollItem = this.rollFor(kart, this._placeOf(kart));
    bus.emit('item:rollStart', { kart });
  }

  _finishRoll(kart) {
    const id = kart.rollItem || 'banana';
    kart.rolling = false;
    kart.rollTimer = 0;
    kart.rollItem = null;
    kart.item = id;
    kart.itemCount = ITEM_INFO[id].uses;
    bus.emit('item:get', { kart, item: id });
  }

  // ------------------------------------------------------------- use

  /** Activate the held item (no-op without an item or while the roulette spins). */
  useItem(kart) {
    if (!kart || !kart.item || kart.rolling || kart.itemCount <= 0) return false;
    const id = kart.item;
    switch (id) {
      case 'banana': this._dropHazard(kart, 'banana'); break;
      case 'stink': this._dropHazard(kart, 'stink'); break;
      case 'bouncer': this._launch(kart, 'bouncer'); break;
      case 'rocket': this._launch(kart, 'rocket'); break;
      case 'toot':
      case 'triple_toot': kart.applyBoost(BOOST.tootDuration, 'item'); break;
      case 'star': kart.startStar(); break;
      case 'zap': this._zap(kart); break;
      case 'beer':
        for (const other of this.karts) if (other !== kart && !other.finished && !other.isInvincible()) other.drunkTimer = 6;
        break;
      default: return false;
    }
    kart.itemCount--;
    if (kart.itemCount <= 0) { kart.item = null; kart.itemCount = 0; }
    this.used[id] = (this.used[id] || 0) + 1;
    bus.emit('item:use', { kart, item: id });
    return true;
  }

  _dropHazard(kart, type) {
    const tr = this.track;
    const banana = type === 'banana';
    // recycle the oldest of this type when at the cap
    let count = 0, oldest = null;
    for (const h of this.hazards) {
      if (h.type !== type) continue;
      count++;
      if (!oldest || h.age > oldest.age) oldest = h;
    }
    if (count >= (banana ? T.maxBananas : T.maxStinks) && oldest) this._removeHazard(oldest, 'expire');

    const h = this._hazardPool.pop() || makeHazard();
    h.uid = ++this._uid;
    h.type = type;
    h.owner = kart;
    h.radius = banana ? ITEM.hazardRadius : ITEM.stinkRadius;
    h.life = banana ? T.bananaLife : ITEM.stinkLife;
    h.age = 0;
    h.hitMask = 0;
    h.wisp = 0;
    const back = banana ? T.bananaBack : T.stinkBack;
    h.position.set(kart.position.x - Math.sin(kart.yaw) * back, kart.position.y, kart.position.z - Math.cos(kart.yaw) * back);
    tr.project(h.position, kart.hint, h.proj);
    h.hint = h.proj.index;
    // keep it on the drivable surface, inside the walls
    const lim = 0.6;
    const lat = clamp(h.proj.lateral, -(h.proj.wallL - lim), h.proj.wallR - lim);
    if (lat !== h.proj.lateral) {
      tr.pointAt(h.proj.s, lat, h.position);
      tr.project(h.position, h.hint, h.proj);
    }
    h.position.y = h.proj.height;
    h.s = h.proj.s;
    h.lateral = h.proj.lateral;
    h.dropFrom = Math.max(0, kart.position.y + 0.6 - h.position.y);   // visual drop height
    h.active = true;
    this.hazards.push(h);
    if (this.vis) this.vis.onHazardSpawn(h);
  }

  _launch(kart, type) {
    const tr = this.track;
    if (this.projectiles.length >= T.maxProjectiles) {
      let oldest = this.projectiles[0];
      for (const p of this.projectiles) if (p.age > oldest.age) oldest = p;
      this._removeProjectile(oldest, 'expire');
    }
    const p = this._projPool.pop() || makeProjectile();
    p.uid = ++this._uid;
    p.type = type;
    p.owner = kart;
    p.age = 0;
    p.bounces = 0;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    p.dir.set(fx, 0, fz);
    p.position.set(kart.position.x + fx * T.launchAhead, kart.position.y, kart.position.z + fz * T.launchAhead);
    tr.project(p.position, kart.hint, p.proj);
    p.hint = p.proj.index;
    const r = type === 'bouncer' ? T.bouncerRadius : 0.5;
    const lat = clamp(p.proj.lateral, -(p.proj.wallL - r - 0.05), p.proj.wallR - r - 0.05);
    if (lat !== p.proj.lateral) {
      p.position.x += p.proj.right.x * (lat - p.proj.lateral);
      p.position.z += p.proj.right.z * (lat - p.proj.lateral);
      tr.project(p.position, p.hint, p.proj);
      p.hint = p.proj.index;
    }
    p.s = p.proj.s;
    p.lateral = p.proj.lateral;
    p.dist = kart.distance + T.launchAhead;
    if (type === 'bouncer') {
      p.speed = Math.max(ITEM.bouncerSpeed, kart.speed + T.bouncerBoost);
      p.life = ITEM.bouncerLife;
      p.mode = 'bounce';
      p.target = null;
      p.position.y = p.proj.height + T.bouncerRadius;
    } else {
      p.speed = Math.max(ITEM.rocketSpeed, kart.speed + 16);
      p.life = ITEM.rocketLife;
      p.target = this._rocketTarget(kart);
      p.mode = p.target ? 'track' : 'straight';
      p.position.y = p.proj.height + T.rocketHeight;
    }
    p.prev.copy(p.position);
    p.active = true;
    this.projectiles.push(p);
    if (this.vis) this.vis.onProjectileSpawn(p);
  }

  // The kart one place ahead (skipping finished karts); null when leading.
  _rocketTarget(kart) {
    const race = this.race;
    const place = this._placeOf(kart);
    if (place <= 1) return null;
    if (race && race.standings) {
      for (let i = place - 2; i >= 0; i--) {
        const k = race.standings[i];
        if (k && k !== kart && !k.finished) return k;
      }
      return null;
    }
    let best = null;
    for (const k of this.karts) {
      if (k === kart || k.finished || !(k.place > 0 && k.place < place)) continue;
      if (!best || k.place > best.place) best = k;
    }
    return best;
  }

  _zap(user) {
    const place = this._placeOf(user);
    this._zapBlockedUntil = this.time + T.zapCooldown;
    const victims = [];          // zaps are rare (cooldown): a fresh list listeners may keep
    for (const k of this.karts) {
      if (k === user || k.finished || k.frozen) continue;
      if (!(this._placeOf(k) < place) || k.isInvincible()) continue;
      if (k.zap()) {
        victims.push(k);
        bus.emit('item:hit', { kart: k, by: user, item: 'zap' });
        if (this.vis) this.vis.onZapVictim(k);
      }
    }
    bus.emit('item:zap', { kart: user, victims, count: victims.length });
    if (this.vis) this.vis.onZapUser(user);
  }

  _placeOf(kart) {
    if (this.race && this.race.getPlace) return this.race.getPlace(kart);
    return kart.place > 0 ? kart.place : this.karts.length;
  }

  // ------------------------------------------------------------- update

  update(dt, race = null) {
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;
    this.time += dt;
    if (race) this.race = race;
    const live = !race || race.state === 'racing' || race.state === 'finished';

    // ---- item button pulses + roulette
    for (const k of this.karts) {
      const inp = k.input;
      if (inp.useItem) {
        inp.useItem = false;
        if (live && !k.frozen && !k.isDisabled() && !k.finished) {
          if (k.rolling) k.rollTimer = Math.min(k.rollTimer, T.rollShortenTo);
          else this.useItem(k);
        }
      }
      if (k.rolling) {
        k.rollTimer -= dt;
        if (k.rollTimer <= 0) this._finishRoll(k);
      }
    }

    this._updateBoxes(dt, live);
    this._updateHazards(dt);
    this._updateProjectiles(dt);
    if (this.vis) this.vis.update(dt);
  }

  _updateBoxes(dt, live) {
    const r2 = ITEM.boxRadius * ITEM.boxRadius;
    for (const b of this.boxes) {
      if (!b.active) {
        b.respawnTimer -= dt;
        if (b.respawnTimer <= 0) {
          b.active = true;
          b.respawnTimer = 0;
          if (this.vis) this.vis.onBoxRespawn(b);
        }
        continue;
      }
      if (!live) continue;
      const bp = b.position;
      for (const k of this.karts) {
        const dx = k.position.x - bp.x, dz = k.position.z - bp.z;
        if (dx * dx + dz * dz > r2) continue;
        if (Math.abs(k.position.y + 0.5 - bp.y) > T.boxPickupDy) continue;
        b.active = false;
        b.respawnTimer = ITEM.boxRespawn;
        bus.emit('item:boxHit', { kart: k, box: b });
        if (this.vis) this.vis.onBoxBreak(b, k);
        if (!k.item && !k.rolling && !k.finished) this._startRoll(k);
        break;
      }
    }
  }

  _updateHazards(dt) {
    const karts = this.karts;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.age += dt;
      if (h.age >= h.life) { this._removeHazard(h, 'expire'); continue; }
      const hp = h.position;
      if (h.type === 'banana') {
        const rr = h.radius * h.radius;
        for (const k of karts) {
          if (k === h.owner && h.age < T.bananaOwnerGrace) continue;
          const dx = k.position.x - hp.x, dz = k.position.z - hp.z;
          if (dx * dx + dz * dz > rr || Math.abs(k.position.y - hp.y) > T.bananaHitDy) continue;
          if (k.isInvincible()) { this._removeHazard(h, 'smash'); break; }
          if (k.spinOut('banana')) {
            bus.emit('item:hit', { kart: k, by: h.owner, item: 'banana', hazard: h });
            this._removeHazard(h, 'hit');
            break;
          }
          // invulnerable / already spinning karts drive over it
        }
      } else {
        // stink cloud: billows out over its first moments, shrinks away at the end
        const left = h.life - h.age;
        const grow = h.age < T.stinkGrowTime ? 0.45 + 0.55 * (h.age / T.stinkGrowTime) : 1;
        const rad = h.radius * grow * (left < T.stinkShrinkTime ? left / T.stinkShrinkTime : 1);
        const rr = rad * rad;
        const slow = Math.exp(-T.stinkSlowRate * dt);
        for (let j = 0; j < karts.length; j++) {
          const k = karts[j];
          if (k === h.owner && h.age < T.stinkOwnerGrace) continue;
          const dx = k.position.x - hp.x, dz = k.position.z - hp.z;
          if (dx * dx + dz * dz > rr || Math.abs(k.position.y - hp.y) > T.stinkHitDy) continue;
          if (k.isInvincible()) continue;
          if (!k.frozen) { k.velocity.x *= slow; k.velocity.z *= slow; }
          const bit = 1 << (j & 31);
          if (h.hitMask & bit) continue;
          if (k.spinOut('stink')) {
            h.hitMask |= bit;
            bus.emit('item:hit', { kart: k, by: h.owner, item: 'stink', hazard: h });
          }
        }
      }
    }
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { this._removeProjectile(p, 'expire'); continue; }
      p.prev.copy(p.position);
      if (p.mode === 'track') this._stepRocketTrack(p, dt);
      else if (p.mode === 'home') this._stepRocketHome(p, dt);
      else this._stepStraight(p, dt);
      if (!p.active) continue;
      this._collideProjectile(p);
    }
    // projectile vs projectile (few of them: O(n^2) is fine)
    const ps = this.projectiles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const a = ps[i];
      if (!a || !a.active) continue;
      for (let j = i - 1; j >= 0; j--) {
        const b = ps[j];
        if (!b.active) continue;
        if (a.age < 0.15 && b.age < 0.15 && a.owner === b.owner) continue;
        const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z, dy = a.position.y - b.position.y;
        const r = ITEM.projectileRadius * 2;
        if (dx * dx + dz * dz < r * r && Math.abs(dy) < 1.5) {
          this._removeProjectile(a, 'clash');
          this._removeProjectile(b, 'clash');
          break;
        }
      }
    }
  }

  // Bouncer, or a rocket without a target: straight along its heading, riding
  // the road. Bouncers reflect off walls; straight rockets explode there.
  _stepStraight(p, dt) {
    const tr = this.track, pos = p.position, proj = p.proj;
    const step = p.speed * dt;
    pos.x += p.dir.x * step;
    pos.z += p.dir.z * step;
    tr.project(pos, p.hint, proj);
    p.hint = proj.index;
    p.dist += step * (p.dir.x * proj.tangent.x + p.dir.z * proj.tangent.z);
    const bouncer = p.type === 'bouncer';
    const r = bouncer ? T.bouncerRadius : 0.45;
    const lat = proj.lateral;
    const limR = proj.wallR - r, limL = -(proj.wallL - r);
    if (lat > limR || lat < limL) {
      const side = lat > limR ? 1 : -1;
      const pen = side > 0 ? lat - limR : limL - lat;
      pos.x -= proj.right.x * pen * side;
      pos.z -= proj.right.z * pen * side;
      proj.lateral -= pen * side;
      if (!bouncer) { this._removeProjectile(p, 'wall'); return; }
      // reflect the heading on the (tapered) wall normal, like kart.js walls
      const N = tr.N, ix = proj.index;
      const arr = side > 0 ? tr.wr : tr.wl;
      const dW = (arr[(ix + 1) % N] - arr[(ix - 1 + N) % N]) / (2 * tr.spacing);
      let nx = -side * proj.right.x + proj.tangent.x * dW;
      let nz = -side * proj.right.z + proj.tangent.z * dW;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const dn = p.dir.x * nx + p.dir.z * nz;
      if (dn < 0) {
        p.dir.x -= 2 * dn * nx;
        p.dir.z -= 2 * dn * nz;
        const dl = Math.hypot(p.dir.x, p.dir.z) || 1;
        p.dir.x /= dl; p.dir.z /= dl;
        p.bounces++;
        if (p.bounces > ITEM.bouncerMaxBounces) { this._removeProjectile(p, 'wall'); return; }
        bus.emit('item:bounce', { position: pos, item: p.type, projectile: p });
        if (this.vis) this.vis.onBounce(p);
      }
    }
    pos.y = proj.height + (bouncer ? T.bouncerRadius : T.rocketHeight);
  }

  // Rocket chasing its target along the track: s advances at rocket speed
  // (corrected for the lateral offset in corners), lateral eases toward the
  // target's lateral; switches to direct homing within rocketHomingRange.
  _stepRocketTrack(p, dt) {
    const tr = this.track, tgt = p.target, pos = p.position, proj = p.proj;
    if (!tgt || tgt.finished) { p.mode = 'straight'; this._stepStraight(p, dt); return; }
    const corr = clamp(1 - proj.curvature * p.lateral, 0.55, 1.6);
    const ds = (p.speed * dt) / corr;
    p.s = tr.wrapS(p.s + ds);
    p.dist += ds;
    const gap = tgt.distance - p.dist;
    if (gap < T.rocketLostGap) { p.mode = 'straight'; return; }
    const rate = T.rocketLateralRate * (gap < 70 ? 2.2 : 1);
    const f = tr.frameAt(p.s, this._frame);
    const lim = 0.8;
    p.lateral = clamp(damp(p.lateral, tgt.proj.lateral, rate, dt), -(f.wallL - lim), f.wallR - lim);
    tr.pointAt(p.s, p.lateral, pos);
    pos.y += T.rocketHeight;
    tr.project(pos, p.hint, proj);
    p.hint = proj.index;
    // heading for the visuals / a later straight flight
    const dx = pos.x - p.prev.x, dz = pos.z - p.prev.z;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-4) { p.dir.x = dx / dl; p.dir.z = dz / dl; }
    const tx = tgt.position.x - pos.x, tz = tgt.position.z - pos.z;
    if (tx * tx + tz * tz < ITEM.rocketHomingRange * ITEM.rocketHomingRange && gap > -3) p.mode = 'home';
  }

  _stepRocketHome(p, dt) {
    const tr = this.track, tgt = p.target, pos = p.position, proj = p.proj;
    if (!tgt || tgt.finished) { p.mode = 'straight'; this._stepStraight(p, dt); return; }
    const tx = tgt.position.x - pos.x, tz = tgt.position.z - pos.z;
    const cur = Math.atan2(p.dir.x, p.dir.z);
    const want = Math.atan2(tx, tz);
    // the turn limit tightens with proximity: at point-blank range (a rival
    // right alongside the shooter) the rocket still connects instead of
    // swinging out wide and looping back into the pack
    const d = Math.max(1, Math.hypot(tx, tz));
    const maxTurn = Math.max(T.rocketHomeTurn, (p.speed * T.rocketCloseTurn) / d) * dt;
    const yaw = cur + clamp(angleDiff(cur, want), -maxTurn, maxTurn);
    p.dir.x = Math.sin(yaw); p.dir.z = Math.cos(yaw);
    const step = p.speed * dt;
    pos.x += p.dir.x * step;
    pos.z += p.dir.z * step;
    tr.project(pos, p.hint, proj);
    p.hint = proj.index;
    p.dist += step * (p.dir.x * proj.tangent.x + p.dir.z * proj.tangent.z);
    // slide along walls rather than flying through them
    const r = 0.45;
    const lat = clamp(proj.lateral, -(proj.wallL - r), proj.wallR - r);
    if (lat !== proj.lateral) {
      pos.x += proj.right.x * (lat - proj.lateral);
      pos.z += proj.right.z * (lat - proj.lateral);
      proj.lateral = lat;
    }
    pos.y = damp(pos.y, Math.max(proj.height + 0.45, tgt.position.y + 0.7), 10, dt);
  }

  // The shooter is immune to its own projectile for ITEM.shooterGrace, and to
  // a rocket for as long as it is locked on a target ('track' / 'home').
  _ownerImmune(p) {
    return p.age < ITEM.shooterGrace || p.mode === 'track' || p.mode === 'home';
  }

  _collideProjectile(p) {
    const pos = p.position;
    const rk = ITEM.projectileRadius + KART.radius;
    const ownerImmune = this._ownerImmune(p);
    for (const k of this.karts) {
      if (k === p.owner && ownerImmune) continue;
      const dx = k.position.x - pos.x, dz = k.position.z - pos.z;
      if (dx * dx + dz * dz > rk * rk) continue;
      if (Math.abs(k.position.y + 0.5 - pos.y) > T.kartHitDy) continue;
      if (k.isInvincible() || !k.isHittable()) {
        // stars smash shells; blinking / spinning karts just absorb them
        this._removeProjectile(p, 'smash');
        return;
      }
      if (k.tumble(p.type)) {
        p.victim = k;
        bus.emit('item:hit', { kart: k, by: p.owner, item: p.type, projectile: p });
        this._removeProjectile(p, 'hit');
        return;
      }
    }
    // projectiles clear banana peels
    const rb = ITEM.projectileRadius + T.bananaBlockRadius;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (h.type !== 'banana') continue;
      const dx = h.position.x - pos.x, dz = h.position.z - pos.z;
      if (dx * dx + dz * dz > rb * rb || Math.abs(h.position.y + 0.4 - pos.y) > 1.5) continue;
      this._removeHazard(h, 'blocked');
      bus.emit('item:blocked', { kart: p.owner, item: p.type });
      this._removeProjectile(p, 'blocked');
      return;
    }
  }

  _removeHazard(h, reason) {
    if (!h.active) return;
    h.active = false;
    const i = this.hazards.indexOf(h);
    if (i >= 0) { this.hazards[i] = this.hazards[this.hazards.length - 1]; this.hazards.pop(); }
    if (this.vis) this.vis.onHazardRemove(h, reason);
    h.owner = null;
    this._hazardPool.push(h);
  }

  _removeProjectile(p, reason) {
    if (!p.active) return;
    p.active = false;
    // every rocket detonation is an explosion (hit = it tumbled a kart)
    if (p.type === 'rocket' && reason !== 'clear') bus.emit('item:explode', { position: p.position, hit: reason === 'hit', kart: p.victim });
    const i = this.projectiles.indexOf(p);
    if (i >= 0) { this.projectiles[i] = this.projectiles[this.projectiles.length - 1]; this.projectiles.pop(); }
    if (this.vis) this.vis.onProjectileRemove(p, reason);
    p.owner = null;
    p.target = null;
    p.victim = null;
    this._projPool.push(p);
  }

  // ------------------------------------------------------------- queries

  /**
   * Hazards and projectiles within `radius` (horizontal) of the kart, for AI
   * avoidance. Returns a REUSED array of reused objects (valid until the next
   * call): { type, position, distance, ahead, radius, s, lateral, owner,
   * targeting (a rocket locked on this kart), dirX, dirZ, speed, ref }.
   * The kart's own projectiles are left out while it is immune to them.
   */
  getThreatsNear(kart, radius) {
    const out = this._threats;
    out.length = 0;
    const kp = kart.position;
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      const dx = h.position.x - kp.x, dz = h.position.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d - h.radius > radius) continue;
      this._pushThreat(h, d, dx * fx + dz * fz > 0, h.radius, h.s, h.lateral);
    }
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (p.owner === kart && this._ownerImmune(p)) continue;
      const dx = p.position.x - kp.x, dz = p.position.z - kp.z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const t = this._pushThreat(p, d, dx * fx + dz * fz > 0, ITEM.projectileRadius, p.proj.s, p.proj.lateral);
      t.targeting = p.type === 'rocket' && p.target === kart;
      t.dirX = p.dir.x; t.dirZ = p.dir.z; t.speed = p.speed;
    }
    return out;
  }

  // Fill the next pooled threat record and append it to the result list.
  _pushThreat(ref, distance, ahead, radius, s, lateral) {
    const out = this._threats;
    let t = this._threatPool[out.length];
    if (!t) {
      t = this._threatPool[out.length] = { type: '', position: null, distance: 0, ahead: false, radius: 0, s: 0, lateral: 0, owner: null, targeting: false, dirX: 0, dirZ: 0, speed: 0, ref: null };
    }
    t.type = ref.type; t.ref = ref; t.position = ref.position; t.distance = distance; t.ahead = ahead;
    t.radius = radius; t.s = s; t.lateral = lateral; t.owner = ref.owner;
    t.targeting = false; t.dirX = 0; t.dirZ = 0; t.speed = 0;
    out.push(t);
    return t;
  }

  /** Remove every hazard / projectile and reactivate all boxes. */
  clear() {
    while (this.hazards.length) this._removeHazard(this.hazards[this.hazards.length - 1], 'clear');
    while (this.projectiles.length) this._removeProjectile(this.projectiles[this.projectiles.length - 1], 'clear');
    for (const b of this.boxes) { b.active = true; b.respawnTimer = 0; }
    this._zapBlockedUntil = -Infinity;
    if (this.vis) this.vis.onClear();
  }

  dispose() {
    this.clear();
    if (this.vis) { this.vis.dispose(); this.vis = null; }
  }
}

function makeHazard() {
  return {
    uid: 0, type: 'banana', active: false, owner: null, position: new THREE.Vector3(),
    radius: 0, life: 0, age: 0, hitMask: 0, s: 0, lateral: 0, proj: {}, hint: -1,
    dropFrom: 0, seed: 0, visYaw: 0, wisp: 0,     // visual state (ItemVisuals)
  };
}

function makeProjectile() {
  return {
    uid: 0, type: 'bouncer', active: false, owner: null, target: null,
    position: new THREE.Vector3(), prev: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
    speed: 0, life: 0, age: 0, bounces: 0, proj: {}, hint: -1, mode: 'bounce',
    s: 0, lateral: 0, dist: 0, vis: null, victim: null,
  };
}

// ===================================================================== visuals
//
// Only constructed when a scene is given (browser). Everything is pooled and
// built once; per-frame work is matrix writes and a few particle emits.

const BOX_SIZE = 1.3;
const PUFFS = 9;                 // body spheres per stink cloud
const BUBBLES = 3;               // small puffs bubbling up out of each cloud
const BOUNCER_POOL = 12;
const ROCKET_POOL = 8;
const BOLT_POOL = 8;
const BOLT_SEGMENTS = 11;
const BOLT_TIME = 0.45;
const SHARD_POOL = 72;           // flying glass shards from broken item boxes
const SHARDS_PER_BOX = 12;
const SHARD_LIFE = 0.8;

// Display-referred rainbow glass with bright edges and a fresnel rim.
const BOX_VERT = /* glsl */`
attribute float aPhase;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
varying float vPhase;
#include <fog_pars_vertex>
void main() {
  vLocal = position;
  vPhase = aPhase;
  mat4 mw = modelMatrix * instanceMatrix;
  vec4 mvPosition = viewMatrix * mw * vec4(position, 1.0);
  vN = normalize(mat3(viewMatrix) * mat3(mw) * normal);
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BOX_FRAG = /* glsl */`
uniform float uTime;
uniform float uHalf;
varying vec3 vN;
varying vec3 vV;
varying vec3 vLocal;
varying float vPhase;
#include <common>
#include <fog_pars_fragment>
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float facing = abs(dot(n, v));
  float fres = pow(1.0 - facing, 2.0);
  float hue = fract(vPhase + uTime * 0.16 + vLocal.y * 0.32 + (vLocal.x + vLocal.z) * 0.18);
  vec3 rain = hsv2rgb(vec3(hue, 0.88, 1.0));
  // bright frame where two face coordinates are both near the surface
  vec3 a = smoothstep(0.74, 0.93, abs(vLocal) / uHalf);
  float edge = clamp(a.x * a.y + a.y * a.z + a.z * a.x, 0.0, 1.0);
  // soft diagonal glints sweeping across the faces
  float glint = smoothstep(0.92, 1.0, sin((vLocal.x + vLocal.y * 0.7 - vLocal.z * 0.4) * 3.2 - uTime * 2.6 + vPhase * 6.28));
  vec3 col = mix(rain * 0.92, vec3(1.0), 0.1 + 0.38 * fres);
  col += edge * mix(rain, vec3(1.0), 0.55) * 0.9 + glint * 0.35;
  float alpha = clamp(0.3 + 0.5 * fres + 0.6 * edge + glint * 0.2, 0.0, 0.94);
  // display-referred colours -> linear working space; output conversion below
  col = pow(col, vec3(2.2));
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// Camera-facing "?" inside each box (billboarded in view space).
const Q_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sc = length(instanceMatrix[0].xyz);
  float w = sin(uTime * 2.3 + aPhase * 6.2831) * 0.16;
  float c = cos(w), s = sin(w);
  vec2 p = mat2(c, s, -s, c) * position.xy * sc;
  vec4 mvPosition = center + vec4(p, 0.0, 0.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const Q_FRAG = /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < 0.45) discard;
  gl_FragColor = vec4(t.rgb, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// Cartoon stink puffs: crisp silhouettes, top-lit shading, darker blotches,
// a light rim on the upper edge and a soft (not fuzzy) translucent body.
const PUFF_VERT = /* glsl */`
attribute float aAlpha;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObjN;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha;
  vSeed = float(gl_InstanceID) * 1.618;
  mat4 mw = modelMatrix * instanceMatrix;
  vec4 mvPosition = viewMatrix * mw * vec4(position, 1.0);
  vN = normalize(mat3(viewMatrix) * mat3(mw) * normal);
  vObjN = normal;
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const PUFF_FRAG = /* glsl */`
uniform vec3 uLight;
uniform vec3 uDark;
uniform vec3 uRim;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObjN;
varying float vAlpha;
varying float vSeed;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  vec3 o = normalize(vObjN);
  float facing = clamp(dot(n, v), 0.0, 1.0);
  // top-lit with a little wrap from the sun side
  float shade = smoothstep(-0.75, 0.95, o.y * 0.85 + o.x * 0.15);
  vec3 col = mix(uDark, uLight, shade);
  // slowly churning darker blotches
  float b = sin(o.x * 6.0 + vSeed + uTime * 0.7) * sin(o.z * 5.0 - vSeed * 1.3 + uTime * 0.5) * sin(o.y * 4.0 + vSeed * 0.7);
  col *= 1.0 - 0.16 * smoothstep(0.15, 0.75, b);
  // darker edges separate the puffs (cartoon ink), bright rim on the upper silhouette
  float up = smoothstep(-0.2, 0.6, o.y);
  col *= mix(0.62, 1.0, smoothstep(0.05, 0.5, facing) * (1.0 - up * 0.5) + up * 0.5);
  col = mix(col, uRim, pow(1.0 - facing, 2.0) * 0.6 * up);
  float a = vAlpha * mix(0.8, 1.0, facing);
  // crisp silhouette (depth is written, so no soft fringes that would cut into puffs behind)
  if (facing < 0.06 || a < 0.02) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function makeQuestionTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 112px "Arial Black", "Arial Rounded MT Bold", Impact, sans-serif';
  g.lineJoin = 'round';
  // dark outline + drop shadow, then a warm white-to-yellow fill
  g.lineWidth = 18;
  g.strokeStyle = 'rgba(40, 14, 70, 0.95)';
  g.strokeText('?', S / 2 + 3, S / 2 + 8);
  g.strokeText('?', S / 2, S / 2 + 4);
  const grd = g.createLinearGradient(0, 18, 0, S - 14);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.55, '#fff6c4');
  grd.addColorStop(1, '#ffc93b');
  g.fillStyle = grd;
  g.fillText('?', S / 2, S / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Primitive -> non-indexed, vertex-coloured, uv-less part for merging.
function part(geo, color, { scale, rot, pos } = {}) {
  if (scale) geo.scale(scale[0], scale[1], scale[2]);
  if (rot) geo.applyQuaternion(rot);
  if (pos) geo.translate(pos[0], pos[1], pos[2]);
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  const col = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function merge(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

const _up = new THREE.Vector3(0, 1, 0);
// Capsule from point a to point b (local Y axis -> a->b), flattened across.
function segment(a, b, radius, color, flatten = 1, widen = 1) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, len - radius), 4, 10);
  geo.scale(flatten, 1, widen);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  return part(geo, color, { rot: q, pos: [mid.x, mid.y, mid.z] });
}

// Banana peel lying on the road: cream fruit stub, brown stem, three yellow
// peel petals flopping outward with brown tips. ~1.4 m across.
function buildBananaGeometry() {
  const parts = [];
  const YEL = 0xffcc12, YEL2 = 0xf0a80c, TIP = 0x5e3a0e, CREAM = 0xfff1b0;
  parts.push(part(new THREE.CapsuleGeometry(0.13, 0.2, 4, 10), CREAM, { rot: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0, 0.1)), pos: [0, 0.33, 0] }));
  parts.push(part(new THREE.CylinderGeometry(0.045, 0.065, 0.14, 8), TIP, { pos: [0.02, 0.56, 0.02] }));
  parts.push(part(new THREE.SphereGeometry(0.2, 12, 8), YEL2, { scale: [1, 0.55, 1], pos: [0, 0.16, 0] }));
  for (let i = 0; i < 3; i++) {
    const th = (i / 3) * TAU + 0.35;
    const c = Math.cos(th), s = Math.sin(th);
    const p0 = new THREE.Vector3(0.06 * c, 0.24, 0.06 * s);
    const p1 = new THREE.Vector3(0.34 * c, 0.2, 0.34 * s);
    const p2 = new THREE.Vector3(0.64 * c, 0.06, 0.64 * s);
    parts.push(segment(p0, p1, 0.1, YEL, 0.5, 1.5));
    parts.push(segment(p1, p2, 0.095, i === 1 ? YEL2 : YEL, 0.5, 1.45));
    parts.push(part(new THREE.SphereGeometry(0.07, 8, 6), TIP, { scale: [1, 0.6, 1], pos: [0.7 * c, 0.05, 0.7 * s] }));
  }
  return merge(parts);
}

// Bouncer: glossy green ball with a white stripe (shows the roll) and two
// white "eye" spots. Radius ITEM_TUNE.bouncerRadius, centered at the origin.
function buildBouncerGeometry() {
  const r = T.bouncerRadius;
  const parts = [];
  const alongX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  parts.push(part(new THREE.SphereGeometry(r, 28, 18), 0x1fc84a));
  parts.push(part(new THREE.TorusGeometry(r * 1.0, r * 0.12, 8, 40), 0xffffff, { rot: alongX }));
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.CylinderGeometry(r * 0.36, r * 0.36, r * 0.08, 20), 0xffffff, {
      rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), pos: [sx * r * 0.955, 0, 0],
    }));
    parts.push(part(new THREE.CylinderGeometry(r * 0.2, r * 0.2, r * 0.1, 16), 0x0e7a2c, {
      rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), pos: [sx * r * 0.975, 0, 0],
    }));
  }
  return merge(parts);
}

// Homing rocket pointing +Z: red body, white nose, yellow band + fins, dark
// nozzle and a pair of determined cartoon eyes. ~1.7 m long.
function buildRocketGeometry() {
  const parts = [];
  const RED = 0xe62a2a, WHITE = 0xf6f6f6, YEL = 0xffc21f, DARK = 0x2e2e36;
  const toZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  parts.push(part(new THREE.CylinderGeometry(0.25, 0.28, 1.0, 18), RED, { rot: toZ, pos: [0, 0, 0] }));
  parts.push(part(new THREE.ConeGeometry(0.25, 0.55, 18), WHITE, { rot: toZ, pos: [0, 0, 0.775] }));
  parts.push(part(new THREE.SphereGeometry(0.06, 8, 6), RED, { pos: [0, 0, 1.04] }));
  parts.push(part(new THREE.CylinderGeometry(0.262, 0.262, 0.12, 18), YEL, { rot: toZ, pos: [0, 0, 0.32] }));
  parts.push(part(new THREE.CylinderGeometry(0.17, 0.23, 0.2, 14), DARK, { rot: toZ, pos: [0, 0, -0.6] }));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
    const off = new THREE.Vector3(0, 0.36, 0).applyQuaternion(q);
    parts.push(part(new THREE.BoxGeometry(0.05, 0.3, 0.38), YEL, { rot: q, pos: [off.x, off.y, -0.36] }));
  }
  // eyes on the nose, looking ahead
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.SphereGeometry(0.085, 10, 8), WHITE, { scale: [1, 1.25, 0.6], pos: [sx * 0.105, 0.13, 0.57] }));
    parts.push(part(new THREE.SphereGeometry(0.042, 8, 6), 0x111111, { pos: [sx * 0.1, 0.12, 0.625] }));
    parts.push(part(new THREE.BoxGeometry(0.12, 0.028, 0.03), 0x111111, {
      rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sx * 0.45), pos: [sx * 0.1, 0.25, 0.6],
    }));
  }
  return merge(parts);
}

// Two crossed ribbons along a jagged path: reads as a bolt from any angle.
function writeBolt(geo, height, rnd) {
  const pos = geo.attributes.position.array;
  const pts = [];
  let x = 0, z = 0;
  for (let i = 0; i <= BOLT_SEGMENTS; i++) {
    const t = i / BOLT_SEGMENTS;
    const y = height * (1 - t);
    if (i > 0 && i < BOLT_SEGMENTS) { x += (rnd() - 0.5) * 2.2; z += (rnd() - 0.5) * 2.2; x *= 0.75; z *= 0.75; }
    else if (i === BOLT_SEGMENTS) { x = 0; z = 0; }
    pts.push(x, y, z);
  }
  let o = 0;
  for (let plane = 0; plane < 2; plane++) {
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      const w0 = 0.55 * (1 - (i / BOLT_SEGMENTS) * 0.5), w1 = 0.55 * (1 - ((i + 1) / BOLT_SEGMENTS) * 0.5);
      const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2];
      const bx = pts[i * 3 + 3], by = pts[i * 3 + 4], bz = pts[i * 3 + 5];
      const ox = plane === 0 ? 1 : 0, oz = plane === 0 ? 0 : 1;
      const quad = [
        ax - ox * w0, ay, az - oz * w0, ax + ox * w0, ay, az + oz * w0, bx + ox * w1, by, bz + oz * w1,
        ax - ox * w0, ay, az - oz * w0, bx + ox * w1, by, bz + oz * w1, bx - ox * w1, by, bz - oz * w1,
      ];
      for (let k = 0; k < 18; k++) pos[o++] = quad[k];
    }
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeBoundingSphere();
}

function freeSlot(pool) {
  for (let i = 0; i < pool.length; i++) if (!pool[i].used) return pool[i];
  return null;
}

const easeOutBack = (t) => { const c1 = 1.9, c3 = c1 + 1; const u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };

class ItemVisuals {
  constructor(sys, scene, effects) {
    this.sys = sys;
    this.scene = scene;
    this.fx = effects;
    this.time = 0;
    this.root = new THREE.Group();
    this.root.name = 'items';
    scene.add(this.root);
    this._geos = [];
    this._mats = [];
    this._texs = [];

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    // reused particle option objects
    this._o = {
      shard: { count: 34, spread: 7.5, size: 0.24, life: 1.1, radius: 0.55, color: 'rainbow' },
      sparkle: { count: 10, spread: 2.2, size: 0.3, radius: 0.5, color: 0xffffff },
      spawnSparkle: { count: 6, spread: 1.2, size: 0.22, radius: 0.55, color: 0xfff3a0 },
      flame: { count: 0, velocity: new THREE.Vector3(), spread: 1.2, size: 0.42, life: 0.2, radius: 0.06, from: new THREE.Vector3() },
      smoke: { count: 0, velocity: new THREE.Vector3(), spread: 0.5, size: 0.42, life: 0.85, radius: 0.08, alpha: 0.42, color: 0xb4b4bc, from: new THREE.Vector3() },
      glowGreen: { count: 0, velocity: new THREE.Vector3(), spread: 0.3, size: 0.42, life: 0.16, radius: 0.12, color: 0x4dff6e, from: new THREE.Vector3() },
      bounceSpark: { count: 10, spread: 5, size: 0.14, color: 0xb8ffb0 },
      pop: { count: 14, spread: 5, size: 0.16, color: 0x7dff8f },
      popSmoke: { count: 6, spread: 1.6, size: 0.6, alpha: 0.45, color: 0xcfd6cf },
      banana: { count: 10, spread: 4.5, size: 0.16, color: 0xffe14d },
      stink: { count: 1, velocity: new THREE.Vector3(0, 0.6, 0), spread: 1.4, size: 1.0, radius: 2.2, alpha: 0.42, life: 1.6 },
      zap: { count: 30, spread: 9, size: 0.34, radius: 0.9 },
      zapGlow: { count: 4, spread: 1, size: 1.6, life: 0.25, color: 0xfff6a0, radius: 0.3 },
      explosion: { count: 28, spread: 8, size: 0.95, alpha: 0.75, velocity: new THREE.Vector3() },
      fizzle: { count: 14, spread: 5, size: 0.7, alpha: 0.75, velocity: new THREE.Vector3() },
      blastSmoke: { count: 10, spread: 3, size: 1.1, alpha: 0.55, life: 1.4, color: 0x9a9aa2, velocity: new THREE.Vector3() },
    };

    this._buildBoxes();
    this._buildBananas();
    this._buildBouncers();
    this._buildRockets();
    this._buildStink();
    this._buildBolts();
    this._buildShards();
    this.update(0);
  }

  _own(x, list) { list.push(x); return x; }

  // ---------------------------------------------------------------- build

  _buildBoxes() {
    const boxes = this.sys.boxes;
    const n = Math.max(1, boxes.length);
    const geo = this._own(new RoundedBoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE, 3, 0.2), this._geos);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) phase[i] = (i * 0.618034) % 1;
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    const mat = this._own(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uHalf: { value: BOX_SIZE / 2 } }]),
      vertexShader: BOX_VERT, fragmentShader: BOX_FRAG,
      transparent: true, depthWrite: false, fog: true, toneMapped: false,
    }), this._mats);
    this.boxUniforms = mat.uniforms;
    this.boxMesh = new THREE.InstancedMesh(geo, mat, n);
    this.boxMesh.name = 'item-boxes';
    this.boxMesh.frustumCulled = false;
    this.boxMesh.renderOrder = 3;
    this.boxMesh.castShadow = true;
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.boxMesh);

    const qgeo = this._own(new THREE.PlaneGeometry(0.98, 0.98), this._geos);
    qgeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase.slice(), 1));
    const tex = this._own(makeQuestionTexture(), this._texs);
    const qmat = this._own(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, map: { value: null } }]),
      vertexShader: Q_VERT, fragmentShader: Q_FRAG, fog: true, toneMapped: false,
    }), this._mats);
    qmat.uniforms.map.value = tex;
    this.qUniforms = qmat.uniforms;
    this.qMesh = new THREE.InstancedMesh(qgeo, qmat, n);
    this.qMesh.name = 'item-box-marks';
    this.qMesh.frustumCulled = false;
    this.qMesh.renderOrder = 2;
    this.qMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.qMesh);

    // per-box animation state (pop-in after respawn)
    this.boxAnim = boxes.map((b, i) => ({ pop: 1, phase: phase[i] * TAU }));
  }

  _buildBananas() {
    const geo = this._own(buildBananaGeometry(), this._geos);
    const mat = this._own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.0 }), this._mats);
    this.bananaMesh = new THREE.InstancedMesh(geo, mat, T.maxBananas);
    this.bananaMesh.name = 'bananas';
    this.bananaMesh.castShadow = true;
    this.bananaMesh.receiveShadow = true;
    this.bananaMesh.frustumCulled = false;
    this.bananaMesh.count = 0;
    this.bananaMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.bananaMesh);
  }

  _buildBouncers() {
    const geo = this._own(buildBouncerGeometry(), this._geos);
    const mat = this._own(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.16, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.06 }), this._mats);
    this.bouncerPool = [];
    for (let i = 0; i < BOUNCER_POOL; i++) {
      const g = new THREE.Group();
      g.name = 'bouncer';
      const ball = new THREE.Mesh(geo, mat);
      ball.castShadow = true;
      g.add(ball);
      g.visible = false;
      this.root.add(g);
      this.bouncerPool.push({ group: g, ball, used: false, roll: 0 });
    }
  }

  _buildRockets() {
    const geo = this._own(buildRocketGeometry(), this._geos);
    const mat = this._own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.08 }), this._mats);
    const glowGeo = this._own(new THREE.SphereGeometry(0.17, 12, 8), this._geos);
    const glowMat = this._own(new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), this._mats);
    const ringGeo = this._own(new THREE.RingGeometry(1.35, 1.65, 40, 1).rotateX(-Math.PI / 2), this._geos);
    const ringMat = this._own(new THREE.MeshBasicMaterial({ color: 0xff2424, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }), this._mats);
    const tickGeo = this._own(new THREE.BoxGeometry(0.16, 0.02, 0.7), this._geos);
    this.rocketPool = [];
    for (let i = 0; i < ROCKET_POOL; i++) {
      const g = new THREE.Group();
      g.name = 'rocket';
      g.rotation.order = 'YXZ';
      const body = new THREE.Mesh(geo, mat);
      body.castShadow = true;
      g.add(body);
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.z = -0.78;
      g.add(glow);
      g.visible = false;
      this.root.add(g);
      // lock-on reticle under the target kart: ring + 4 ticks, spins
      const ring = new THREE.Group();
      ring.name = 'rocket-lock';
      ring.add(new THREE.Mesh(ringGeo, ringMat));
      for (let t = 0; t < 4; t++) {
        const tick = new THREE.Mesh(tickGeo, ringMat);
        const a = (t / 4) * TAU;
        tick.position.set(Math.sin(a) * 1.95, 0, Math.cos(a) * 1.95);
        tick.rotation.y = a;
        ring.add(tick);
      }
      ring.visible = false;
      this.root.add(ring);
      this.rocketPool.push({ group: g, body, glow, ring, used: false, tail: new THREE.Vector3(), tailValid: false, acc: 0, smokeAcc: 0 });
    }
  }

  _buildStink() {
    const geo = this._own(new THREE.IcosahedronGeometry(1, 3), this._geos);
    const cap = T.maxStinks * (PUFFS + BUBBLES);
    const alpha = new Float32Array(cap);
    this.puffAlpha = new THREE.InstancedBufferAttribute(alpha, 1);
    this.puffAlpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.puffAlpha);
    const mat = this._own(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uLight: { value: new THREE.Color(0xd2f45e) },
        uDark: { value: new THREE.Color(0x3f6c12) },
        uRim: { value: new THREE.Color(0xf4ffc2) },
        uTime: { value: 0 },
      }]),
      vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG,
      transparent: true, depthWrite: true, fog: true,
    }), this._mats);
    this.puffUniforms = mat.uniforms;
    this.puffMesh = new THREE.InstancedMesh(geo, mat, cap);
    this.puffMesh.name = 'stink-clouds';
    this.puffMesh.frustumCulled = false;
    this.puffMesh.count = 0;
    this.puffMesh.renderOrder = 4;
    this.puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.puffMesh);
    // fixed puff layout (unit cloud): a ring of puffs + a taller crown
    this.puffLayout = [];
    for (let i = 0; i < PUFFS; i++) {
      if (i < 6) {
        const a = (i / 6) * TAU;
        this.puffLayout.push({ x: Math.cos(a) * 0.55, y: 0.38 + (i % 2) * 0.12, z: Math.sin(a) * 0.55, r: 0.5 + (i % 3) * 0.07, ph: i * 1.7 });
      } else {
        const a = ((i - 6) / 3) * TAU + 0.5;
        this.puffLayout.push({ x: Math.cos(a) * 0.22, y: 0.85 + (i - 6) * 0.08, z: Math.sin(a) * 0.22, r: 0.48, ph: i * 2.3 });
      }
    }
  }

  _buildBolts() {
    const mat = this._own(new THREE.MeshBasicMaterial({ color: 0xffd81f, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }), this._mats);
    const coreMat = this._own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }), this._mats);
    this.boltPool = [];
    for (let i = 0; i < BOLT_POOL; i++) {
      const geo = this._own(new THREE.BufferGeometry(), this._geos);
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * BOLT_SEGMENTS * 18), 3));
      geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 12;
      const core = new THREE.Mesh(geo, coreMat);
      core.scale.set(0.42, 1, 0.42);
      core.renderOrder = 13;
      core.frustumCulled = false;
      mesh.add(core);
      this.root.add(mesh);
      this.boltPool.push({ mesh, geo, kart: null, t: 0, reshape: 0 });
    }
    this._rnd = Math.random;
  }

  _buildShards() {
    const geo = this._own(new THREE.TetrahedronGeometry(0.36, 0), this._geos);
    geo.scale(1, 0.4, 1.25);
    const mat = this._own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0.0, transparent: true, opacity: 0.9, emissive: 0x6a6a6a }), this._mats);
    this.shardMesh = new THREE.InstancedMesh(geo, mat, SHARD_POOL);
    this.shardMesh.name = 'box-shards';
    this.shardMesh.frustumCulled = false;
    this.shardMesh.count = 0;
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shardMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.shardMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // remember the viewing camera: shards right in front of the lens are shrunk
    // away (the chase camera flies through the debris of a box the kart just broke)
    this._shardCam = new THREE.Vector3(0, -1e6, 0);
    this.shardMesh.onBeforeRender = (renderer, scene, camera) => { this._shardCam.copy(camera.position); };
    this.root.add(this.shardMesh);
    // struct-of-arrays state, alive shards dense in [0, shardCount)
    const n = SHARD_POOL;
    this.sh = {
      p: new Float32Array(n * 3), v: new Float32Array(n * 3), axis: new Float32Array(n * 3),
      c: new Float32Array(n * 3), ang: new Float32Array(n), spin: new Float32Array(n), age: new Float32Array(n),
    };
    this.shardCount = 0;
    this._col = new THREE.Color();
  }

  _spawnShards(pos, kart) {
    const S = this.sh, col = this._col;
    const kvx = kart ? kart.velocity.x * 0.45 : 0, kvz = kart ? kart.velocity.z * 0.45 : 0;
    const hue0 = Math.random();
    for (let i = 0; i < SHARDS_PER_BOX; i++) {
      let j = this.shardCount;
      if (j >= SHARD_POOL) j = (Math.random() * SHARD_POOL) | 0;     // full: recycle a random one
      else this.shardCount++;
      // random outward direction, biased upward
      let dx = Math.random() * 2 - 1, dy = Math.random() * 0.8 + 0.3, dz = Math.random() * 2 - 1;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const sp = 3 + Math.random() * 4;
      dx /= dl; dy /= dl; dz /= dl;
      S.p[j * 3] = pos.x + dx * 0.4; S.p[j * 3 + 1] = pos.y + dy * 0.4; S.p[j * 3 + 2] = pos.z + dz * 0.4;
      S.v[j * 3] = dx * sp + kvx; S.v[j * 3 + 1] = dy * sp + 2.5; S.v[j * 3 + 2] = dz * sp + kvz;
      let ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5;
      const al = Math.hypot(ax, ay, az) || 1;
      S.axis[j * 3] = ax / al; S.axis[j * 3 + 1] = ay / al; S.axis[j * 3 + 2] = az / al;
      S.ang[j] = Math.random() * TAU;
      S.spin[j] = (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 10);
      S.age[j] = 0;
      col.setHSL((hue0 + i / SHARDS_PER_BOX) % 1, 0.9, 0.62);
      S.c[j * 3] = col.r; S.c[j * 3 + 1] = col.g; S.c[j * 3 + 2] = col.b;
    }
  }

  _syncShards(dt) {
    const S = this.sh, m = this._m, q = this._q, p = this._p, sc = this._s, ax = this._axis;
    const mesh = this.shardMesh, colors = mesh.instanceColor.array;
    let i = 0;
    while (i < this.shardCount) {
      const age = S.age[i] + dt;
      if (age >= SHARD_LIFE) {
        // swap-remove
        const last = --this.shardCount;
        if (i !== last) {
          for (let k = 0; k < 3; k++) {
            S.p[i * 3 + k] = S.p[last * 3 + k]; S.v[i * 3 + k] = S.v[last * 3 + k];
            S.axis[i * 3 + k] = S.axis[last * 3 + k]; S.c[i * 3 + k] = S.c[last * 3 + k];
          }
          S.ang[i] = S.ang[last]; S.spin[i] = S.spin[last]; S.age[i] = S.age[last];
        }
        continue;
      }
      S.age[i] = age;
      const k = Math.exp(-1.2 * dt);
      S.v[i * 3] *= k; S.v[i * 3 + 2] *= k;
      S.v[i * 3 + 1] -= 16 * dt;
      S.p[i * 3] += S.v[i * 3] * dt; S.p[i * 3 + 1] += S.v[i * 3 + 1] * dt; S.p[i * 3 + 2] += S.v[i * 3 + 2] * dt;
      S.ang[i] += S.spin[i] * dt;
      ax.set(S.axis[i * 3], S.axis[i * 3 + 1], S.axis[i * 3 + 2]);
      q.setFromAxisAngle(ax, S.ang[i]);
      const u = age / SHARD_LIFE;
      p.set(S.p[i * 3], S.p[i * 3 + 1], S.p[i * 3 + 2]);
      const near = Math.min(1, Math.max(0, (p.distanceTo(this._shardCam) - 0.7) / 1.8));
      sc.setScalar(Math.max(0.001, (1 - u * u) * near * near * (3 - 2 * near)));
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      colors[i * 3] = S.c[i * 3]; colors[i * 3 + 1] = S.c[i * 3 + 1]; colors[i * 3 + 2] = S.c[i * 3 + 2];
      i++;
    }
    mesh.count = this.shardCount;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- hooks

  onBoxBreak(b, kart) {
    const fx = this.fx;
    const a = this.boxAnim[b.index];
    a.pop = 0;
    this._spawnShards(b.position, kart);
    if (fx) {
      fx.emit('confetti', b.position, this._o.shard);
      fx.emit('sparkle', b.position, this._o.sparkle);
      fx.emit('glow', b.position, this._o.zapGlow);
    }
  }

  onBoxRespawn(b) {
    this.boxAnim[b.index].pop = 0.0001;
    if (this.fx) this.fx.emit('sparkle', b.position, this._o.spawnSparkle);
  }

  onHazardSpawn(h) {
    h.seed = Math.random();
    h.visYaw = Math.random() * TAU;
  }

  onHazardRemove(h, reason) {
    const fx = this.fx;
    if (!fx || reason === 'clear') return;
    if (h.type === 'banana') {
      if (reason !== 'expire') fx.emit('spark', h.position, this._o.banana);
      fx.emit('smoke', h.position, this._o.popSmoke);
    }
  }

  onProjectileSpawn(p) {
    if (p.type === 'bouncer') {
      const slot = freeSlot(this.bouncerPool);
      if (!slot) return;
      slot.used = true;
      slot.roll = 0;
      slot.group.visible = true;
      p.vis = slot;
    } else {
      const slot = freeSlot(this.rocketPool);
      if (!slot) return;
      slot.used = true;
      slot.tailValid = false;
      slot.acc = 0;
      slot.smokeAcc = 0;
      slot.group.visible = true;
      p.vis = slot;
    }
    this._syncProjectile(p, 0);
  }

  onProjectileRemove(p, reason) {
    const slot = p.vis;
    if (slot) {
      slot.used = false;
      slot.group.visible = false;
      if (slot.ring) slot.ring.visible = false;
      p.vis = null;
    }
    const fx = this.fx;
    if (!fx || reason === 'clear') return;
    if (p.type === 'rocket') {
      // centre the blast between the rocket and the kart it hit
      const at = this._v2.copy(p.position);
      const o = reason === 'hit' ? this._o.explosion : this._o.fizzle;
      o.velocity.set(0, 0, 0);
      if (p.victim) {
        at.lerp(p.victim.position, 0.85);
        at.y = Math.max(at.y, p.victim.position.y + 0.9);
        o.velocity.copy(p.victim.velocity).multiplyScalar(0.7);   // the fireball rides along with the kart
      }
      fx.emit('explosion', at, o);
      this._o.blastSmoke.velocity.copy(o.velocity).multiplyScalar(0.5);
      fx.emit('smoke', at, this._o.blastSmoke);
    } else {
      fx.emit('spark', p.position, this._o.pop);
      fx.emit('smoke', p.position, this._o.popSmoke);
    }
  }

  onBounce(p) {
    if (this.fx) this.fx.emit('spark', p.position, this._o.bounceSpark);
  }

  onZapVictim(k) {
    let slot = this.boltPool[0];
    for (const b of this.boltPool) if (!b.kart) { slot = b; break; }
    slot.kart = k;
    slot.t = 0;
    slot.reshape = 0;
    slot.mesh.visible = true;
    writeBolt(slot.geo, 16, this._rnd);
    if (this.fx) {
      this._p.copy(k.position); this._p.y += 0.8;
      this.fx.emit('zap', this._p, this._o.zap);
      this.fx.emit('glow', this._p, this._o.zapGlow);
    }
  }

  onZapUser(k) {
    if (!this.fx) return;
    this._p.copy(k.position); this._p.y += 1.2;
    this.fx.emit('zap', this._p, this._o.zap);
    this.fx.emit('sparkle', this._p, this._o.spawnSparkle);
  }

  onClear() {
    for (const s of this.bouncerPool) { s.used = false; s.group.visible = false; }
    for (const s of this.rocketPool) { s.used = false; s.group.visible = false; s.ring.visible = false; }
    for (const b of this.boltPool) { b.kart = null; b.mesh.visible = false; }
    for (const a of this.boxAnim) a.pop = 1;
    this.bananaMesh.count = 0;
    this.puffMesh.count = 0;
    this.shardCount = 0;
    this.shardMesh.count = 0;
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    this.time += dt;
    const t = this.time;
    this.boxUniforms.uTime.value = t;
    this.qUniforms.uTime.value = t;
    this.puffUniforms.uTime.value = t;
    this._syncBoxes(dt, t);
    this._syncHazards(dt, t);
    for (const p of this.sys.projectiles) this._syncProjectile(p, dt);
    this._syncBolts(dt);
    this._syncShards(dt);
  }

  _syncBoxes(dt, t) {
    const boxes = this.sys.boxes, m = this._m, q = this._q, p = this._p, s = this._s;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i], a = this.boxAnim[i];
      if (!b.active) {
        this.boxMesh.setMatrixAt(i, this._zero);
        this.qMesh.setMatrixAt(i, this._zero);
        continue;
      }
      if (a.pop < 1) a.pop = Math.min(1, a.pop + dt / 0.38);
      const sc = a.pop < 1 ? Math.max(0, easeOutBack(a.pop)) : 1;
      p.copy(b.position);
      p.y += Math.sin(t * 2.1 + a.phase) * 0.12;
      this._e.set(0.42, t * 1.25 + a.phase, 0.42, 'YXZ');
      q.setFromEuler(this._e);
      s.setScalar(sc);
      m.compose(p, q, s);
      this.boxMesh.setMatrixAt(i, m);
      q.identity();
      m.compose(p, q, s);
      this.qMesh.setMatrixAt(i, m);
    }
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.qMesh.instanceMatrix.needsUpdate = true;
  }

  _syncHazards(dt, t) {
    const m = this._m, q = this._q, p = this._p, s = this._s;
    let nb = 0, np = 0;
    const alpha = this.puffAlpha.array;
    const lay = this.puffLayout;
    for (const h of this.sys.hazards) {
      if (h.type === 'banana') {
        if (nb >= T.maxBananas) continue;
        // little drop from the kart's tail, then a squash on landing
        const drop = clamp(h.age / 0.28, 0, 1);
        p.copy(h.position);
        p.y += h.dropFrom * (1 - drop * drop);
        const land = h.age > 0.28 ? Math.max(0, 1 - (h.age - 0.28) / 0.25) : 0;
        const squash = 1 - 0.22 * Math.sin(land * Math.PI);
        const grow = 0.55 + 0.45 * drop;
        const fade = h.life - h.age < 1 ? Math.max(0.01, h.life - h.age) : 1;
        s.set(grow * fade * (2 - squash), grow * fade * squash, grow * fade * (2 - squash));
        q.setFromAxisAngle(_up, h.visYaw + (1 - drop) * 3);
        m.compose(p, q, s);
        this.bananaMesh.setMatrixAt(nb++, m);
      } else {
        // puffy cloud: puffs breathe out of phase; grows in, shrinks out
        const left = h.life - h.age;
        const grow = h.age < 0.45 ? easeOutBack(h.age / 0.45) : 1;
        const shrink = left < T.stinkShrinkTime ? left / T.stinkShrinkTime : 1;
        const R = h.radius * 0.82 * grow * shrink;
        const a = 0.9 * Math.min(1, h.age / 0.25) * Math.min(1, left / 0.6);
        for (let i = 0; i < PUFFS && np < this.puffMesh.instanceMatrix.count; i++) {
          const L = lay[i];
          const br = 1 + 0.09 * Math.sin(t * 3.1 + L.ph + h.seed * 10);
          const sway = Math.sin(t * 1.3 + L.ph) * 0.06;
          p.set(h.position.x + (L.x + sway) * R, h.position.y + L.y * R, h.position.z + (L.z - sway) * R);
          s.setScalar(L.r * R * br);
          q.identity();
          m.compose(p, q, s);
          this.puffMesh.setMatrixAt(np, m);
          alpha[np] = a;
          np++;
        }
        // small puffs bubbling up from the crown, growing and fading on a loop
        for (let i = 0; i < BUBBLES && np < this.puffMesh.instanceMatrix.count; i++) {
          const ph = (t * 0.55 + i / BUBBLES + h.seed) % 1;
          const ang = h.seed * 20 + i * 2.1;
          const rr = R * (0.25 + 0.2 * Math.sin(ph * 3 + i));
          p.set(h.position.x + Math.cos(ang) * rr, h.position.y + R * (0.95 + ph * 0.9), h.position.z + Math.sin(ang) * rr);
          s.setScalar(R * (0.12 + 0.18 * ph));
          q.identity();
          m.compose(p, q, s);
          this.puffMesh.setMatrixAt(np, m);
          alpha[np] = a * Math.min(1, ph * 5) * (1 - ph);
          np++;
        }
        // rising wisps (rate-based, so substep count doesn't matter)
        if (this.fx && dt > 0) {
          h.wisp = (h.wisp || 0) + dt * 7 * shrink;
          if (h.wisp >= 1) {
            h.wisp -= 1;
            this._v.copy(h.position); this._v.y += R * 0.6;
            this._o.stink.radius = R * 0.7;
            this.fx.emit('stink', this._v, this._o.stink);
          }
        }
      }
    }
    this.bananaMesh.count = nb;
    this.bananaMesh.instanceMatrix.needsUpdate = true;
    this.puffMesh.count = np;
    this.puffMesh.instanceMatrix.needsUpdate = true;
    this.puffAlpha.needsUpdate = true;
  }

  _syncProjectile(p, dt) {
    const slot = p.vis;
    if (!slot) return;
    const g = slot.group;
    g.position.copy(p.position);
    const yaw = Math.atan2(p.dir.x, p.dir.z);
    if (p.type === 'bouncer') {
      g.rotation.y = yaw;
      slot.roll += (p.speed * dt) / T.bouncerRadius;
      slot.ball.rotation.x = slot.roll;
      if (this.fx && dt > 0) {
        // faint green glow trail
        slot.acc = (slot.acc || 0) + dt * 70;
        const n = Math.floor(slot.acc);
        if (n > 0) {
          slot.acc -= n;
          const o = this._o.glowGreen;
          o.count = n;
          o.from.copy(p.prev);
          this.fx.emit('glow', p.position, o);
        }
      }
      return;
    }
    // rocket: point along travel (incl. climb), wobble roll, flicker glow
    const dy = p.position.y - p.prev.y;
    const hd = Math.hypot(p.position.x - p.prev.x, p.position.z - p.prev.z);
    g.rotation.set(hd > 1e-4 ? -Math.atan2(dy, hd) : 0, yaw, Math.sin(this.time * 9 + p.uid) * 0.25);
    const fl = 0.8 + 0.3 * Math.sin(this.time * 60 + p.uid * 3) + 0.15 * Math.random();
    slot.glow.scale.set(fl, fl, 1.8 * fl);
    // lock-on reticle under the target
    const tgt = p.target;
    if (tgt && (p.mode === 'home' || p.mode === 'track')) {
      slot.ring.visible = true;
      slot.ring.position.set(tgt.position.x, tgt.position.y + 0.06, tgt.position.z);
      slot.ring.rotation.y = this.time * 3;
      const pulse = p.mode === 'home' ? 0.85 + 0.15 * Math.sin(this.time * 22) : 1.15;
      slot.ring.scale.setScalar(pulse);
    } else {
      slot.ring.visible = false;
    }
    if (!this.fx || !(dt > 0)) return;
    // flame + smoke trail from the nozzle, spread along last frame's path
    const tail = this._v.set(0, 0, -0.85).applyEuler(g.rotation).add(p.position);
    if (!slot.tailValid) { slot.tail.copy(tail); slot.tailValid = true; }
    slot.acc += dt * 220;
    let n = Math.floor(slot.acc);
    if (n > 0) {
      slot.acc -= n;
      const o = this._o.flame;
      o.count = n;
      o.from.copy(slot.tail);
      o.velocity.set(-p.dir.x * 7, 0.5, -p.dir.z * 7);
      this.fx.emit('flame', tail, o);
    }
    slot.smokeAcc += dt * 70;
    n = Math.floor(slot.smokeAcc);
    if (n > 0) {
      slot.smokeAcc -= n;
      const o = this._o.smoke;
      o.count = n;
      o.from.copy(slot.tail);
      o.velocity.set(-p.dir.x * 2, 0.8, -p.dir.z * 2);
      this.fx.emit('smoke', tail, o);
    }
    slot.tail.copy(tail);
  }

  _syncBolts(dt) {
    for (const b of this.boltPool) {
      if (!b.kart) continue;
      b.t += dt;
      if (b.t >= BOLT_TIME) { b.kart = null; b.mesh.visible = false; continue; }
      b.reshape -= dt;
      if (b.reshape <= 0) { b.reshape = 0.06; writeBolt(b.geo, 16, this._rnd); }
      b.mesh.position.copy(b.kart.position);
      b.mesh.position.y += 0.7;
      // flicker: strike, dim, re-strike, fade
      const u = b.t / BOLT_TIME;
      const on = u < 0.18 || (u > 0.3 && u < 0.62) || (u > 0.72 && Math.random() < 0.5);
      b.mesh.visible = on;
      const w = 1 + (1 - u) * 0.5;
      b.mesh.scale.set(w, 1, w);
    }
  }

  dispose() {
    this.scene.remove(this.root);
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
    for (const t of this._texs) t.dispose();
    this.boxMesh.dispose();
    this.qMesh.dispose();
    this.bananaMesh.dispose();
    this.puffMesh.dispose();
    this.shardMesh.dispose();
    this._geos.length = this._mats.length = this._texs.length = 0;
  }
}

