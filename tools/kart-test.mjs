// KARTS physics test-suite (node). Uses the REAL track.
//   node tools/kart-test.mjs            (full suite)
//   node tools/kart-test.mjs --quick    (laps only)
// Exits non-zero when any check fails.

import { Track } from '../public/js/track.js';
import { Kart, resolveKartCollisions, KART_TUNE } from '../public/js/kart.js';
import { CHARACTERS, getCharacter } from '../public/js/characters.js';
import { KART, DRIFT, HIT, BOOST } from '../public/js/config.js';
import { bus } from '../public/js/bus.js';
import { Autopilot } from '../public/dev/karts-autopilot.js';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const DT = 1 / 120;
const track = new Track();
const L = track.length;
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (cond, msg) => { if (!cond) fail(msg); return cond; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

// Event recorder
const events = [];
bus.on('*', (data, type) => { events.push({ type, data, t: simTime }); });
let simTime = 0;

function isBad(k) {
  const p = k.position, v = k.velocity;
  return !(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && Number.isFinite(k.yaw));
}

// Wall clearance: >= 0 means inside the allowed band (center stays radius away from walls).
function wallMargin(k) {
  const pr = k.proj;
  return Math.min(pr.wallR - pr.lateral, pr.wallL + pr.lateral) - KART_TUNE.wallRadius;
}

function makeKart(id, slot = 0) {
  const k = new Kart({ id, character: getCharacter(id), track });
  k.placeOnGrid(track.gridSlot(slot));
  return k;
}

// Drive one kart with the autopilot for `laps` laps; collect stats.
function runLaps(id, { laps = 2, drift = false, maxTime = 200 } = {}) {
  const k = makeKart(id, 0);
  const ap = new Autopilot(k, { drift });
  events.length = 0;
  simTime = 0;
  let prevS = k.proj.s;
  let distance = track.deltaS(0, prevS);
  const lapTimes = [];
  let lapStart = 0, lapIdx = 0;
  let minMargin = Infinity, nan = false, maxSpeed = 0;
  const air = [];   // {s0, s1, t}
  let airStartS = null, airT = 0;
  let offroadT = 0;
  while (simTime < maxTime && lapTimes.length < laps) {
    ap.update(DT);
    k.update(DT);
    simTime += DT;
    if (isBad(k)) { nan = true; break; }
    const s = k.proj.s;
    distance += track.deltaS(prevS, s);
    prevS = s;
    if (Math.floor(distance / L) > lapIdx - 0 && distance >= (lapIdx + 1) * L) {
      lapTimes.push(simTime - lapStart);
      lapStart = simTime;
      lapIdx++;
    }
    minMargin = Math.min(minMargin, wallMargin(k));
    maxSpeed = Math.max(maxSpeed, k.horizontalSpeed);
    if (k.surface === 'offroad') offroadT += DT;
    if (!k.grounded && !k.drift.hopping) {
      if (airStartS === null) { airStartS = s; airT = 0; }
      airT += DT;
    } else if (airStartS !== null) {
      if (airT > 0.05) air.push({ s0: airStartS, s1: s, t: airT });
      airStartS = null;
    }
  }
  const count = (type, pred = () => true) => events.filter((e) => e.type === type && e.data.kart === k && pred(e.data)).length;
  return {
    k, lapTimes, minMargin, nan, maxSpeed, air, offroadT,
    wallHits: count('kart:wallHit'),
    pads: count('kart:boost', (d) => d.source === 'pad'),
    driftBoosts: count('kart:boost', (d) => d.source === 'drift'),
    tiers: events.filter((e) => e.type === 'kart:driftTier' && e.data.kart === k).map((e) => e.data.tier),
    hops: count('kart:hop'),
    lands: events.filter((e) => e.type === 'kart:land' && e.data.kart === k).map((e) => e.data.airTime),
    maxTier: ap.maxTier,
  };
}

const airAt = (air, s) => air.filter((a) => track.deltaS(s - 25, a.s0) >= 0 && track.deltaS(a.s0, s + 25) >= 0).reduce((m, a) => Math.max(m, a.t), 0);

// ------------------------------------------------------------------ 1. laps
console.log(`== Track ${track.name}: length ${f1(L)} m, hill crest ~355, kicker ramp at ${track.ramps.map((r) => f1(r.s0)).join(',')}`);
console.log('\n== 1. Autopilot laps (2 laps each; lap 1 = standing start)');
console.log('char   | stats(top/acc/turn/mass) | no-drift L1 / L2 | drift L1 / L2 | maxV  | wall margin | walls | pads | hill air | ramp air | drift tiers');
const lapResults = {};
for (const c of CHARACTERS) {
  const a = runLaps(c.id, { drift: false });
  const b = runLaps(c.id, { drift: true });
  lapResults[c.id] = { a, b };
  const st = a.k.stats;
  console.log(`${c.id.padEnd(6)} | ${f1(st.topSpeed)}/${f1(st.accel)}/${f2(st.turnRate)}/${f2(st.mass)}`.padEnd(34) +
    ` | ${f2(a.lapTimes[0])} / ${f2(a.lapTimes[1])}`.padEnd(19) +
    ` | ${f2(b.lapTimes[0])} / ${f2(b.lapTimes[1])}`.padEnd(16) +
    ` | ${f1(Math.max(a.maxSpeed, b.maxSpeed))}`.padEnd(8) +
    ` | ${f2(Math.min(a.minMargin, b.minMargin))}`.padEnd(14) +
    ` | ${a.wallHits}/${b.wallHits}`.padEnd(8) +
    ` | ${a.pads}/${b.pads}`.padEnd(7) +
    ` | ${f2(airAt(a.air, 355))}/${f2(airAt(b.air, 355))}`.padEnd(11) +
    ` | ${f2(airAt(a.air, 692))}/${f2(airAt(b.air, 692))}`.padEnd(11) +
    ` | max ${b.maxTier}, boosts ${b.driftBoosts}`);
  for (const r of [a, b]) {
    ok(!r.nan, `${c.id}: NaN during laps`);
    ok(r.lapTimes.length === 2, `${c.id}: did not finish 2 laps (${r.lapTimes.length})`);
    ok(r.minMargin >= -0.02, `${c.id}: exceeded wall band by ${f2(-r.minMargin)} m`);
    // plain driving must land in 30-42 s; the perfect drifting bot may dip just below
    for (const t of r.lapTimes) ok(t >= (r === b ? 27.5 : 30) && t <= 42, `${c.id}: lap time ${f2(t)} outside range`);
  }
  ok(b.driftBoosts > 0, `${c.id}: no drift boosts during drift laps`);
  ok(b.lapTimes[1] < a.lapTimes[1], `${c.id}: drifting lap (${f2(b.lapTimes[1])}) not faster than plain (${f2(a.lapTimes[1])})`);
}
{
  const flying = (id) => lapResults[id].a.lapTimes[1];
  ok(flying('crocodilo') < flying('cappuccina'), 'top-speed Crocodilo should beat Cappuccina on a flying lap');
  ok(flying('tralalero') < flying('patapim'), 'Tralalero should beat Patapim on a flying lap');
}
if (QUICK) { console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`); process.exit(failures ? 1 : 0); }

// --------------------------------------------------------- helper: straight
// Place kart at (s, lateral) heading along the track at speed.
function setAt(k, s, lateral, speed, yawOffset = 0) {
  const f = track.frameAt(s);
  track.pointAt(s, lateral, k.position);
  k.yaw = f.yaw + yawOffset;
  k._resetState();
  k.velocity.set(Math.sin(k.yaw) * speed, 0, Math.cos(k.yaw) * speed);
  k.hint = -1;
  track.project(k.position, -1, k.proj);
  k.hint = k.proj.index;
  k.position.y = k.proj.height;
  k.surface = k.proj.surface;
  k._prevSlope = k.proj.slope;
}

function step(k, n, fn) { for (let i = 0; i < n; i++) { if (fn) fn(i); k.update(DT); simTime += DT; } }

// ------------------------------------------------------- 2. acceleration etc
console.log('\n== 2. Acceleration, turn radius, drift radius');
for (const c of CHARACTERS) {
  const k = makeKart(c.id, 0);
  // 0 -> 90% on the start straight
  setAt(k, 2, 0, 0);
  let t = 0;
  k.input.throttle = 1;
  while (k.speed < 0.9 * k.stats.topSpeed && t < 8) { k.update(DT); t += DT; }
  // full-lock radius at speed on an open area: measure yaw rate
  setAt(k, 5, 0, k.stats.topSpeed);
  k.input.steer = 1; k.input.throttle = 1;
  step(k, 30);
  const radius = k.horizontalSpeed / Math.abs(k.yawRate);
  // tight drift radius
  setAt(k, 5, 0, k.stats.topSpeed);
  k.input.steer = 1; k.input.throttle = 1; k.input.drift = true; k._driftHeld = false;
  step(k, 60);
  const dr = k.drift.active ? k.horizontalSpeed / Math.abs(k.yawRate) : NaN;
  const slip = Math.atan2(k.velocity.x * -Math.cos(k.yaw) + k.velocity.z * Math.sin(k.yaw), k.speed);
  console.log(`${c.id.padEnd(6)} 0-90%: ${f2(t)} s | full-lock radius @top: ${f1(radius)} m | tight drift radius: ${f1(dr)} m (slip ${f1(slip * 57.3)} deg, speed ${f1(k.horizontalSpeed)})`);
  ok(t > 1.4 && t < 4.0, `${c.id}: 0-90% time ${f2(t)} out of range`);
  // Calmer steering: 15–29m full lock; drift arcs open to 13–20m.
  ok(radius > 15 && radius < 29, `${c.id}: full-lock radius ${f1(radius)} out of 15-29`);
  ok(dr > 13 && dr < 20, `${c.id}: tight drift radius ${f1(dr)} out of 13-20`);
}

// ------------------------------------------------------------- 3. airtime
console.log('\n== 3. Airtime at the hill crest and kicker ramp');
for (const [label, sStart, lat, boost] of [['hill @top', 300, 0, false], ['hill boosted', 330, 0, true], ['ramp @top', 640, 0, false], ['ramp via pad', 672, 0, false]]) {
  const k = makeKart('sahur');
  setAt(k, sStart, lat, k.stats.topSpeed);
  k.input.throttle = 1;
  if (boost) k.applyBoost(3, 'item');
  events.length = 0;
  let maxAir = 0, landed = [];
  let maxY = -Infinity;
  for (let i = 0; i < 600; i++) {
    k.input.steer = 0;
    k.update(DT);
    if (!k.grounded) maxAir = Math.max(maxAir, k.airTime);
    maxY = Math.max(maxY, k.position.y - k.proj.height);
    if (isBad(k)) { fail(`${label}: NaN`); break; }
  }
  landed = events.filter((e) => e.type === 'kart:land').map((e) => f2(e.data.airTime));
  console.log(`${label.padEnd(13)} max air ${f2(maxAir)} s, max clearance ${f2(maxY)} m, land events [${landed.join(', ')}]`);
  if (label.startsWith('ramp')) ok(maxAir > 0.45, `${label}: kicker airtime ${f2(maxAir)} too short`);
  if (label === 'hill boosted') ok(maxAir > 0.3, `${label}: boosted hill airtime ${f2(maxAir)} too short`);
}

// --------------------------------------------------------------- 4. drift
console.log('\n== 4. Drift through Turn 1 and the hairpin (auto-drift)');
for (const [label, s0, s1] of [['Turn 1', 60, 160], ['Hairpin', 375, 470]]) {
  for (const id of ['sahur', 'crocodilo', 'patapim']) {
    const k = makeKart(id);
    const ap = new Autopilot(k, { drift: true });
    setAt(k, s0, track.frameAt(s0).racingLine, k.stats.topSpeed);
    events.length = 0;
    let minMargin = Infinity, t = 0;
    while (track.deltaS(k.proj.s, s1) > 0 && t < 10) { ap.update(DT); k.update(DT); t += DT; minMargin = Math.min(minMargin, wallMargin(k)); }
    const tiers = events.filter((e) => e.type === 'kart:driftTier' && e.data.kart === k).map((e) => e.data.tier);
    const boosts = events.filter((e) => e.type === 'kart:boost' && e.data.source === 'drift').map((e) => f2(e.data.duration));
    const starts = events.filter((e) => e.type === 'kart:driftStart').length;
    console.log(`${label.padEnd(8)} ${id.padEnd(6)} time ${f2(t)} s, drift starts ${starts}, tiers [${tiers.join(',')}], drift boosts [${boosts.join(', ')}], min wall margin ${f2(minMargin)}`);
    ok(starts >= 1, `${label}/${id}: drift never started`);
    ok(tiers.length >= 1, `${label}/${id}: no tier reached`);
    ok(boosts.length >= 1, `${label}/${id}: no boost on release`);
    ok(minMargin > -0.02, `${label}/${id}: exceeded walls`);
  }
}
{
  // manual: hop without steering = just a hop, no drift
  const k = makeKart('sahur');
  setAt(k, 5, 0, 25);
  events.length = 0;
  k.input.throttle = 1; k.input.drift = true; k.input.steer = 0; k._driftHeld = false;
  step(k, 90);
  const hop = events.filter((e) => e.type === 'kart:hop').length;
  const ds = events.filter((e) => e.type === 'kart:driftStart').length;
  console.log(`hop-only: hops ${hop}, drift starts ${ds}, lastAir ${f2(k.lastAirTime)}`);
  ok(hop === 1 && ds === 0, 'hop without steering should not start a drift');
  // release, then hop + steer on landing (grace window)
  k.input.drift = false; step(k, 5);
  events.length = 0;
  k.input.drift = true; k.input.steer = 0; step(k, 10);
  k.input.steer = -1; step(k, 40);
  const ds2 = events.filter((e) => e.type === 'kart:driftStart');
  console.log(`steer-on-landing: drift starts ${ds2.length} dir ${ds2[0] && ds2[0].data.dir}`);
  ok(ds2.length === 1 && ds2[0].data.dir === -1, 'steering during hop/landing should start a left drift');
  // slow down below cancel speed
  k.input.throttle = 0; k.input.brake = 1;
  step(k, 120);
  const cancel = events.filter((e) => e.type === 'kart:driftEnd' && e.data.cancelled).length;
  console.log(`brake to stop while drifting: cancelled ${cancel}, drift active ${k.drift.active}`);
  ok(cancel === 1 && !k.drift.active, 'drift should cancel when slow');
}

// ------------------------------------------------------------- 5. offroad
console.log('\n== 5. Offroad slowdown');
{
  const k = makeKart('sahur');
  // start straight: grass from halfWidth+1 to wall; drive parallel on grass
  const f = track.frameAt(20);
  setAt(k, 20, f.halfWidth + 3.5, k.stats.topSpeed);
  k.input.throttle = 1;
  const v0 = k.horizontalSpeed;
  let t05 = 0;
  for (let i = 0; i < 240; i++) {
    k.update(DT);
    if (i === 59) t05 = k.horizontalSpeed;
  }
  console.log(`grass: start ${f1(v0)} m/s -> 0.5 s ${f1(t05)} -> 2 s ${f1(k.horizontalSpeed)} m/s (max ${f1(k.maxSpeed)}), surface ${k.surface}`);
  ok(k.surface === 'offroad', 'kart should be on offroad');
  ok(Math.abs(k.horizontalSpeed - k.stats.topSpeed * KART.offroadSpeedMult) < 1, 'offroad speed should settle at offroad max');
  ok(t05 > k.stats.topSpeed * 0.62, 'offroad slowdown should be smooth, not instant');
  // boost ignores offroad
  k.applyBoost(1.0, 'item');
  step(k, 60);
  console.log(`grass + boost: ${f1(k.horizontalSpeed)} m/s`);
  ok(k.horizontalSpeed > k.stats.topSpeed, 'boost should ignore offroad slowdown');
}

// ----------------------------------------------------------- 6. boost pad
console.log('\n== 6. Boost pads');
for (const pad of track.boostPads) {
  const k = makeKart('cappuccina');
  setAt(k, pad.s0 - 12, pad.lateral, 24);
  k.input.throttle = 1;
  events.length = 0;
  let maxV = 0;
  for (let i = 0; i < 160; i++) { k.input.steer = 0; k.update(DT); maxV = Math.max(maxV, k.horizontalSpeed); }
  const b = events.filter((e) => e.type === 'kart:boost' && e.data.source === 'pad').length;
  console.log(`pad @s ${f1(pad.s0)} lat ${pad.lateral}: triggers ${b}, max speed ${f1(maxV)} (top ${f1(k.stats.topSpeed)})`);
  ok(b === 1, `pad at ${f1(pad.s0)} should trigger exactly once`);
  ok(maxV > k.stats.topSpeed * 1.2, 'pad boost should raise speed above top speed');
}

// ------------------------------------------------------- 7. spin / tumble
console.log('\n== 7. Spin / tumble / zap / star recovery');
{
  const k = makeKart('bananini');
  setAt(k, 10, 0, k.stats.topSpeed);
  k.input.throttle = 1;
  events.length = 0;
  ok(k.spinOut('banana') === true, 'spinOut should succeed');
  ok(k.spinOut('banana') === false, 'second spinOut during spin should fail');
  const v0 = k.horizontalSpeed;
  step(k, Math.round(HIT.spinDuration / DT) - 1);
  const vEnd = k.horizontalSpeed;
  console.log(`spin: speed ${f1(v0)} -> ${f1(vEnd)} (${f1((vEnd / v0) * 100)}%), yaw kept, invuln after ${f2(k.invulnTimer)}`);
  ok(vEnd / v0 > 0.2 && vEnd / v0 < 0.4, 'spin should decay speed to ~30%');
  step(k, 3);
  ok(!k.isDisabled() && k.invulnTimer > 1.0, 'after spin: control back + invuln');
  ok(k.isHittable() === false, 'invulnerable karts are not hittable');
  step(k, Math.round(1.3 / DT));
  ok(k.isHittable(), 'hittable again after invuln');
  ok(k.speed > 15, `kart re-accelerates after spin (speed ${f1(k.speed)})`);

  setAt(k, 30, 0, k.stats.topSpeed);
  k.input.throttle = 1;
  ok(k.tumble('rocket') === true, 'tumble should succeed');
  const tv0 = k.horizontalSpeed;
  let maxH = 0;
  for (let i = 0; i < Math.round(HIT.tumbleDuration / DT) - 1; i++) { k.update(DT); maxH = Math.max(maxH, k.position.y - k.proj.height); }
  console.log(`tumble: speed ${f1(tv0)} -> ${f1(k.horizontalSpeed)} (${f1((k.horizontalSpeed / tv0) * 100)}%), hop height ${f2(maxH)} m`);
  ok(k.horizontalSpeed / tv0 < 0.18, 'tumble should decay speed to ~10%');
  ok(maxH > 0.4, 'tumble should hop');
  step(k, 5);
  ok(!k.isDisabled() && !isBad(k), 'recovered from tumble');

  setAt(k, 50, 0, k.stats.topSpeed);
  ok(k.zap() === true, 'zap works');
  console.log(`zap: spin ${f2(k.spinTimer)} slow ${f2(k.slowTimer)} max ${f1(k.maxSpeed)}`);
  ok(k.slowTimer > 0 && k.maxSpeed < k.stats.topSpeed, 'zap slows');

  setAt(k, 60, 0, 20);
  k.startStar();
  ok(k.isInvincible() && !k.isHittable() && k.spinOut() === false && k.tumble() === false, 'star blocks hits');
  step(k, Math.round(8 / DT));
  ok(!k.isInvincible(), 'star ends');
  const se = events.filter((e) => e.type === 'kart:starStart' || e.type === 'kart:starEnd').map((e) => e.type);
  ok(se.includes('kart:starStart') && se.includes('kart:starEnd'), 'star events');
  // respawn
  k.respawn();
  ok(Math.abs(k.proj.lateral) < 0.5 && !isBad(k), 'respawn on centerline');
}

// ---------------------------------------------------------- 8. collisions
console.log('\n== 8. Kart-kart collisions');
for (const n of [2, 3, 5, 8]) {
  const ks = CHARACTERS.slice(0, n).map((c) => makeKart(c.id, 0));
  for (const k of ks) setAt(k, 40, 0, 0);
  let maxV = 0, nan = false, minMargin = Infinity;
  for (let i = 0; i < 120; i++) {
    for (const k of ks) { k.input.throttle = 0; k.update(DT); }
    resolveKartCollisions(ks);
    for (const k of ks) { maxV = Math.max(maxV, k.horizontalSpeed); if (isBad(k)) nan = true; minMargin = Math.min(minMargin, wallMargin(k)); }
  }
  let minD = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) minD = Math.min(minD, Math.hypot(ks[i].position.x - ks[j].position.x, ks[i].position.z - ks[j].position.z));
  console.log(`${n} stacked karts: min separation after 1 s ${f2(minD)} m (2R=${2 * KART.radius}), max speed ${f1(maxV)}, NaN ${nan}, wall margin ${f2(minMargin)}`);
  ok(!nan, `${n} karts: NaN`);
  ok(minD > 2 * KART.radius - 0.15, `${n} karts: still overlapping (${f2(minD)})`);
  ok(maxV < 12, `${n} karts: explosive separation speed ${f1(maxV)}`);
  ok(minMargin > -0.02, `${n} karts: pushed through a wall`);
}
{
  // heavy vs light, side by side bump at equal speeds (closing at 8 m/s)
  const crocodilo = makeKart('crocodilo'), cappuccina = makeKart('cappuccina');
  setAt(crocodilo, 20, -1.3, 25); setAt(cappuccina, 20, 1.3, 25);
  const r = track.frameAt(20).right;
  crocodilo.velocity.x = Math.sin(crocodilo.yaw) * 25 + r.x * 4; crocodilo.velocity.z = Math.cos(crocodilo.yaw) * 25 + r.z * 4;
  cappuccina.velocity.x = Math.sin(cappuccina.yaw) * 25 - r.x * 4; cappuccina.velocity.z = Math.cos(cappuccina.yaw) * 25 - r.z * 4;
  events.length = 0;
  const latV = (k) => k.velocity.x * r.x + k.velocity.z * r.z;
  let after = null;
  for (let i = 0; i < 90; i++) {
    crocodilo.update(DT); cappuccina.update(DT); resolveKartCollisions([crocodilo, cappuccina]);
    if (!after && events.some((e) => e.type === 'kart:bump')) after = { d: latV(crocodilo), p: latV(cappuccina), ld: crocodilo.proj.lateral, lp: cappuccina.proj.lateral };
  }
  const bumps = events.filter((e) => e.type === 'kart:bump');
  const shoveD = after ? crocodilo.proj.lateral - after.ld : 0, shoveP = after ? cappuccina.proj.lateral - after.lp : 0;
  console.log(`crocodilo vs cappuccina side bump: post-impact lateral vel crocodilo ${f2(after && after.d)}, cappuccina ${f2(after && after.p)} m/s; post-bump lateral travel crocodilo ${f2(shoveD)} m, cappuccina ${f2(shoveP)} m; bump events ${bumps.length} intensity ${bumps[0] ? f2(bumps[0].data.intensity) : '-'}`);
  ok(after && Math.abs(after.p) > Math.abs(after.d) * 1.5, 'heavier kart should push the lighter one more');
  ok(shoveP > 0.6 && shoveP > Math.abs(shoveD) * 2, `lighter kart should get shoved (${f2(shoveP)} m)`);
  ok(bumps.length >= 1, 'bump event emitted');
  // star ram
  const a = makeKart('patapim'), b = makeKart('assassino');
  setAt(a, 60, 0, 20); setAt(b, 60.8, 0.3, 10);
  a.startStar();
  for (let i = 0; i < 10; i++) { a.update(DT); b.update(DT); resolveKartCollisions([a, b]); }
  console.log(`star ram: victim tumbling ${b.tumbleTimer > 0}, star speed ${f1(a.horizontalSpeed)}`);
  ok(b.tumbleTimer > 0, 'star ram should tumble the victim');
}

// ------------------------------------------------------------- 9. walls
console.log('\n== 9. Wall impacts at 30 m/s');
for (const ang of [90, 45, 20, 8]) {
  for (const side of [1, -1]) {
    // Bay Bridge: the rails sit right at the road edge (no grass strip)
    const k = makeKart('tralalero');
    const s = 520;
    const f = track.frameAt(s);
    const gap = 2.5;   // distance from the allowed band edge at start
    const lat = side > 0 ? f.wallR - KART_TUNE.wallRadius - gap : -(f.wallL - KART_TUNE.wallRadius - gap);
    setAt(k, s, lat, 30, -side * ang * Math.PI / 180);
    k.input.throttle = 1;
    events.length = 0;
    let minMargin = Infinity, minSpd = Infinity, maxStep = 0;
    const vtan0 = 30 * Math.cos(ang * Math.PI / 180);
    let prev = k.position.clone();
    for (let i = 0; i < 240; i++) {
      k.input.steer = 0;
      k.update(DT);
      minMargin = Math.min(minMargin, wallMargin(k));
      if (events.some((e) => e.type === 'kart:wallHit')) minSpd = Math.min(minSpd, k.horizontalSpeed);
      maxStep = Math.max(maxStep, prev.distanceTo(k.position));
      prev.copy(k.position);
    }
    const hits = events.filter((e) => e.type === 'kart:wallHit');
    const fw = Math.sin(k.yaw) * f.tangent.x + Math.cos(k.yaw) * f.tangent.z;
    console.log(`${String(ang).padStart(2)}deg ${side > 0 ? 'right' : 'left '} rail: min margin ${f2(minMargin)}, min speed after hit ${f1(minSpd)} (tangential before ${f1(vtan0)}), speed after 2 s ${f1(k.horizontalSpeed)}, heading.tangent ${f2(fw)}, hits ${hits.length} first intensity ${hits[0] ? f2(hits[0].data.intensity) : '-'}, max step ${f2(maxStep)} m`);
    ok(minMargin > -0.02, `wall ${ang}deg: tunneling / penetration ${f2(minMargin)}`);
    ok(hits.length >= 1 && hits.length <= 4, `wall ${ang}deg: unexpected hit count ${hits.length}`);
    if (ang <= 45) ok(minSpd > vtan0 * 0.45, `wall ${ang}deg: kart should slide along (min speed ${f1(minSpd)})`);
    ok(k.horizontalSpeed > (ang >= 90 ? 10 : 20), `wall ${ang}deg: kart should recover speed (speed ${f1(k.horizontalSpeed)})`);
    if (ang >= 45) ok(minSpd < 22, `wall ${ang}deg: speed should be scrubbed`);
    ok(maxStep < 1, 'no teleporting at walls');
  }
}

// ------------------------------------------------------- 10. 8-kart chaos
console.log('\n== 10. 8 autopiloted karts racing with collisions (60 s)');
{
  const ks = CHARACTERS.map((c, i) => makeKart(c.id, i));
  const aps = ks.map((k, i) => new Autopilot(k, { drift: true, offset: ((i % 3) - 1) * 2.5 }));
  let nan = false, minMargin = Infinity, maxV = 0;
  events.length = 0;
  for (let i = 0; i < 60 / DT; i++) {
    for (const ap of aps) ap.update(DT);
    for (const k of ks) k.update(DT);
    resolveKartCollisions(ks);
    for (const k of ks) { if (isBad(k)) nan = true; minMargin = Math.min(minMargin, wallMargin(k)); maxV = Math.max(maxV, k.horizontalSpeed); }
  }
  const bumps = events.filter((e) => e.type === 'kart:bump').length;
  const walls = events.filter((e) => e.type === 'kart:wallHit').length;
  console.log(`NaN ${nan}, min wall margin ${f2(minMargin)}, max speed ${f1(maxV)}, bumps ${bumps}, wall hits ${walls}`);
  ok(!nan && minMargin > -0.02 && maxV < 45, '8-kart run sane');
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
