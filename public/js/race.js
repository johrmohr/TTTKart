// Race manager: intro -> countdown -> GO -> racing -> finished. Node-safe (no
// DOM): drives the browser game and the headless simulation (tools/sim.mjs).
//
//   const race = new Race({ track, karts, laps: 3, player });
//   race.startIntro();              // or race.skipIntro() / race.startCountdown()
//   // per physics substep, AFTER karts moved + collisions resolved:
//   race.update(dt);
//
// Responsibilities (SPEC §8): freezes karts during intro/countdown, emits the
// countdown beats, judges start boosts / engine stalls, tracks each kart's
// continuous race distance (negative on the grid), laps + lap times, places,
// wrong-way detection for the player, finishing, and the one-shot race:over.
// It never places karts: main calls kart.placeOnGrid(track.gridSlot(i))
// before the race starts (any time before GO; positions are re-read when the
// intro / countdown begins).

import { RACE, BOOST } from './config.js';
import { bus } from './bus.js';
import { clamp } from './utils.js';

// Private tuning of the race rules (shared numbers live in config.js RACE).
export const RACE_TUNE = {
  stallSeconds: 1.0,       // engine stall length when the throttle was held too early
  throttleOn: 0.5,         // throttle input that counts as "pressed" for the start judge
  wrongWayDot: -0.4,       // forward·tangent below this (and moving) = facing backwards
  wrongWayClearDot: -0.2,  // hysteresis: back above this clears WRONG WAY
  wrongWayMinSpeed: 3,     // m/s
  minEstimateSpeed: 8,     // m/s floor for the finish-time estimate of unfinished karts
  estimateGap: 0.25,       // s: estimated times are kept at least this far apart
};

export class Race {
  constructor({ track, karts, laps = RACE.laps, player = null }) {
    this.track = track;
    this.karts = karts;
    this.laps = Math.max(1, laps | 0);
    this.player = player;
    this.length = track.length;
    this.totalDistance = this.laps * track.length;

    this.state = 'intro';
    this.time = 0;                       // seconds since GO (0 before)
    this.elapsed = 0;                    // seconds since construction, any state
    this.countdown = RACE.countdownSeconds;
    this.standings = karts.slice();      // 1st first, re-sorted every update()
    this.finishOrder = [];
    this.playerFinished = false;
    this.playerFinishTime = null;
    this.over = false;                   // race:over has been emitted

    this._introTimer = -1;               // < 0: intro not running (call startIntro)
    this._lastBeat = 0;                  // last countdown number announced
    this._playerOverTimer = 0;           // time since the player finished
    this._results = null;                // snapshot taken at race:over
    this._crossing = [];                 // karts crossing the finish this update (reused)
    this._byCrossTime = (a, b) => this._st.get(a).crossTime - this._st.get(b).crossTime;

    // per-kart private bookkeeping, parallel to `karts`
    this._st = new Map();
    // standings order: finishers by finish order, then by distance (grid index breaks ties)
    this._compare = (a, b) => {
      const st = this._st;
      if (a.finished || b.finished) {
        if (a.finished && b.finished) return st.get(a).finishIndex - st.get(b).finishIndex;
        return a.finished ? -1 : 1;
      }
      const d = b.distance - a.distance;
      return d !== 0 ? d : st.get(a).index - st.get(b).index;
    };
    karts.forEach((k, i) => this._st.set(k, {
      index: i,
      prevS: 0,
      completed: 0,        // laps completed (max ever reached -> no credit for wiggling)
      startDistance: 0,
      held: false,         // throttle held last countdown step
      holdStart: -1,       // seconds-before-GO when the current throttle hold began
      wrongTimer: 0,
      finishIndex: -1,
      crossTime: 0,        // sub-step finish-line crossing time (photo finishes)
    }));
    this._syncGrid();
  }

  // ------------------------------------------------------------- control

  /** Camera flyover phase: karts frozen for RACE.introSeconds, then countdown. */
  startIntro() {
    this.state = 'intro';
    this._introTimer = RACE.introSeconds;
    this._syncGrid();
    bus.emit('race:intro', {});
  }

  /** Jump straight to the countdown (no-op once the countdown or race runs). */
  skipIntro() {
    if (this.state === 'intro') this.startCountdown();
  }

  /** "3", "2", "1" (RACE.countdownSeconds), then GO. */
  startCountdown() {
    this.state = 'countdown';
    this._introTimer = -1;
    this.countdown = RACE.countdownSeconds;
    this._syncGrid();
    for (const k of this.karts) {
      const st = this._st.get(k);
      // a throttle already held when the countdown starts counts as pressed at its start
      st.held = (+k.input.throttle || 0) > RACE_TUNE.throttleOn;
      st.holdStart = st.held ? this.countdown : -1;
    }
    this._lastBeat = Math.ceil(this.countdown - 1e-6);
    bus.emit('race:countdown', { n: this._lastBeat });
  }

  // ------------------------------------------------------------- queries

  getPlace(kart) {
    if (kart && kart.place > 0) return kart.place;
    const i = this.standings.indexOf(kart);
    return i >= 0 ? i + 1 : this.karts.length;
  }

  /** The kart one place ahead of `kart` (null when leading). */
  getKartAhead(kart) {
    const p = this.getPlace(kart);
    return p > 1 ? this.standings[p - 2] : null;
  }

  /** Race progress 0..1 (by distance) of a kart. */
  getProgress(kart) {
    return clamp(kart.distance / this.totalDistance, 0, 1);
  }

  /**
   * Final (or live) classification:
   * [{ kart, place, time, finished, bestLap, lapTimes, estimated, isPlayer, name }].
   * Unfinished karts get a time estimated from their remaining distance and
   * their average speed so far (never better than anyone ahead of them).
   * After race:over the same snapshot is returned every call (pass
   * `live = true` to recompute from the current state instead).
   */
  getResults(live = false) {
    if (this._results && !live) return this._results;
    return this._computeResults();
  }

  // -------------------------------------------------------------- update

  /** Call once per physics substep, AFTER the karts moved. */
  update(dt) {
    if (!(dt > 0)) return;
    this.elapsed += dt;
    switch (this.state) {
      case 'intro':
        this._freezeAll();
        if (this._introTimer >= 0) {
          this._introTimer -= dt;
          if (this._introTimer <= 0) this.startCountdown();
        }
        break;
      case 'countdown':
        this._freezeAll();
        this._tickCountdown(dt);
        break;
      default:   // 'racing' | 'finished': karts keep driving after the results are in
        this.time += dt;
        this._tickProgress(dt);
        break;
    }
    this._updatePlaces();
    if (!this.over && this.state === 'racing') this._checkOver(dt);
  }

  dispose() {
    this._st.clear();
    this._results = null;
  }

  // ------------------------------------------------------------ internals

  // (Re)read every kart's grid position: distance = signed offset from the
  // start line (negative behind it), reset race bookkeeping, freeze.
  _syncGrid() {
    const tr = this.track;
    for (const k of this.karts) {
      const st = this._st.get(k);
      if (!k.proj || k.proj.s === undefined) {
        tr.project(k.position, k.hint, k.proj);
        k.hint = k.proj.index;
      }
      const s = k.proj.s;
      st.prevS = s;
      st.completed = 0;
      st.wrongTimer = 0;
      st.finishIndex = -1;
      k.distance = tr.deltaS(0, s);
      st.startDistance = k.distance;
      k.lap = 1;
      k.finished = false;
      k.finishTime = null;
      k.lapTimes = [];
      k.lapStartTime = 0;
      k.wrongWay = false;
      k.frozen = true;
    }
    this.finishOrder.length = 0;
    this.playerFinished = false;
    this.playerFinishTime = null;
    this.time = 0;
    this.over = false;
    this._results = null;
    this._playerOverTimer = 0;
    // grid order: whoever is furthest up the road starts in front
    this._sortStandings();
    for (let i = 0; i < this.standings.length; i++) this.standings[i].place = i + 1;
  }

  _freezeAll() {
    for (const k of this.karts) k.frozen = true;
  }

  _tickCountdown(dt) {
    const before = this.countdown;
    this.countdown = Math.max(0, before - dt);
    // start judge: remember when the current throttle hold began (seconds before GO)
    for (const k of this.karts) {
      const st = this._st.get(k);
      const on = (+k.input.throttle || 0) > RACE_TUNE.throttleOn;
      if (on && !st.held) st.holdStart = before;
      else if (!on) st.holdStart = -1;
      st.held = on;
    }
    if (this.countdown <= 0) { this._go(); return; }
    const beat = Math.ceil(this.countdown - 1e-6);
    if (beat !== this._lastBeat && beat >= 1) {
      this._lastBeat = beat;
      bus.emit('race:countdown', { n: beat });
    }
  }

  // GO: unfreeze, then hand out start boosts / stalls. The throttle hold that
  // is active at GO decides: begun inside RACE.startBoostWindow -> boost;
  // begun earlier than RACE.startStallBefore -> stalled engine.
  _go() {
    this.state = 'racing';
    this.time = 0;
    this.countdown = 0;
    this._lastBeat = 0;
    for (const k of this.karts) { k.frozen = false; k.lapStartTime = 0; }
    bus.emit('race:go', {});
    const [w0, w1] = RACE.startBoostWindow;
    for (const k of this.karts) {
      const st = this._st.get(k);
      if (!st.held || st.holdStart < 0) continue;
      if (st.holdStart > RACE.startStallBefore) {
        k.stallTimer = RACE_TUNE.stallSeconds;
        bus.emit('race:stall', { kart: k });
      } else if (st.holdStart >= w0 && st.holdStart <= w1) {
        k.applyBoost(BOOST.startDuration, 'start');
        bus.emit('race:startBoost', { kart: k });
      }
    }
  }

  _tickProgress(dt) {
    const tr = this.track, L = this.length;
    const crossing = this._crossing;
    crossing.length = 0;
    for (const k of this.karts) {
      const st = this._st.get(k);
      const p = k.proj;
      if (!p || p.s === undefined) continue;
      const s = p.s;
      k.distance += tr.deltaS(st.prevS, s);
      st.prevS = s;
      if (k.finished) continue;

      // ---- lap credit: only when floor(distance / L) exceeds the best so far
      const li = Math.floor(k.distance / L);
      while (li > st.completed && !k.finished) {
        st.completed++;
        // sub-step accurate crossing time from the overshoot past the line
        const over = k.distance - st.completed * L;
        const hs = Math.hypot(k.velocity.x, k.velocity.z);
        const tCross = this.time - clamp(hs > 0.5 ? over / hs : 0, 0, dt);
        const lapTime = tCross - k.lapStartTime;
        k.lapTimes.push(lapTime);
        k.lapStartTime = tCross;
        if (st.completed >= this.laps) {
          // finish after the loop, in crossing-time order (not kart-array order)
          st.crossTime = tCross;
          crossing.push(k);
          break;
        } else {
          const lap = st.completed + 1;
          k.lap = lap;
          bus.emit('race:lap', { kart: k, lap, lapTime });
          if (lap === this.laps) bus.emit('race:finalLap', { kart: k });
        }
      }
      if (!k.finished) k.lap = clamp(st.completed + 1, 1, this.laps);

      // ---- wrong way (flag on every kart, events for the player only)
      this._wrongWay(k, st, dt);
    }
    // photo finish: several karts over the line in the same substep are
    // ranked by their sub-step crossing times
    if (crossing.length > 1) crossing.sort(this._byCrossTime);
    for (let i = 0; i < crossing.length; i++) {
      const k = crossing[i];
      const st = this._st.get(k);
      this._finish(k, st, st.crossTime);
    }
    crossing.length = 0;
  }

  _finish(k, st, time) {
    k.finished = true;
    k.finishTime = time;
    k.lap = this.laps;
    st.finishIndex = this.finishOrder.length;
    this.finishOrder.push(k);
    const place = this.finishOrder.length;
    k.place = place;
    if (k.wrongWay) {
      k.wrongWay = false;
      if (k === this.player) bus.emit('race:wrongWay', { kart: k, on: false });
    }
    if (k === this.player) {
      this.playerFinished = true;
      this.playerFinishTime = time;
      this._playerOverTimer = 0;
    }
    bus.emit('race:finish', { kart: k, place, time });
  }

  _wrongWay(k, st, dt) {
    const p = k.proj;
    const dot = Math.sin(k.yaw) * p.tangent.x + Math.cos(k.yaw) * p.tangent.z;
    const hs = Math.hypot(k.velocity.x, k.velocity.z);
    if (dot < RACE_TUNE.wrongWayDot && hs > RACE_TUNE.wrongWayMinSpeed) st.wrongTimer += dt;
    else if (dot > RACE_TUNE.wrongWayClearDot) st.wrongTimer = 0;
    const on = st.wrongTimer >= RACE.wrongWayDelay;
    if (on !== k.wrongWay) {
      k.wrongWay = on;
      if (k === this.player) bus.emit('race:wrongWay', { kart: k, on });
    }
  }

  _sortStandings() {
    this.standings.sort(this._compare);
  }

  _updatePlaces() {
    this._sortStandings();
    const player = this.player;
    const before = player ? player.place : 0;
    for (let i = 0; i < this.standings.length; i++) this.standings[i].place = i + 1;
    if (player && this.state === 'racing' && before > 0 && player.place !== before) {
      bus.emit('race:positionChange', { kart: player, from: before, to: player.place });
    }
  }

  _checkOver(dt) {
    let all = true;
    for (const k of this.karts) if (!k.finished) { all = false; break; }
    let done = all;
    if (!done && this.playerFinished && this.karts.filter(k=>k.isPlayer).every(k=>k.finished)) {
      this._playerOverTimer += dt;
      done = this._playerOverTimer >= RACE.resultsDelay;
    }
    if (!done) return;
    this.over = true;
    this._results = this._computeResults();
    this.state = 'finished';
    bus.emit('race:over', {});
  }

  _computeResults() {
    const out = [];
    let last = 0;
    for (let i = 0; i < this.standings.length; i++) {
      const k = this.standings[i];
      const st = this._st.get(k);
      let time;
      if (k.finished) {
        time = k.finishTime;
      } else {
        const travelled = k.distance - st.startDistance;
        const avg = Math.max(RACE_TUNE.minEstimateSpeed, this.time > 0.5 ? travelled / this.time : 0);
        const remaining = Math.max(0, this.totalDistance - k.distance);
        time = this.time + remaining / avg;
        time = Math.max(time, last + RACE_TUNE.estimateGap);
      }
      last = Math.max(last, time);
      const laps = k.lapTimes;
      let best = null;
      for (const t of laps) if (best === null || t < best) best = t;
      out.push({
        kart: k,
        place: i + 1,
        time,
        finished: !!k.finished,
        estimated: !k.finished,
        bestLap: best,
        lapTimes: laps.slice(),
        isPlayer: k === this.player,
        name: k.character ? k.character.name : String(k.id),
      });
    }
    return out;
  }
}
