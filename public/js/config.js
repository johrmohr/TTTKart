// Shared tuning constants — the single source of truth for numbers that more
// than one module depends on. Node-safe (no DOM access).

export const GAME_TITLE = 'TTT KART';

export const RACE = {
  laps: 3,
  racers: 8,
  introSeconds: 4.0,          // camera flyover before the countdown starts
  countdownSeconds: 3.0,      // "3", "2", "1" each last 1s, then GO
  playerGridSlot: 7,          // 0 = pole position, 7 = last row
  resultsDelay: 4.0,          // seconds after the player finishes before results show
  startBoostWindow: [0.25, 0.75], // seconds BEFORE "GO" in which first throttle press grants a start boost
  startStallBefore: 1.6,      // pressing throttle earlier than this many seconds before GO stalls the engine
  wrongWayDelay: 1.0,         // seconds facing backwards before WRONG WAY shows
};

export const KART = {
  radius: 1.1,                // collision circle radius (m)
  gravity: 28,                // arcade gravity (m/s^2)
  // stat ratings are 1..5 stars; mapped linearly: base + perStar * rating
  topSpeedBase: 26.0, topSpeedPerStar: 1.0,   // 27..31 m/s
  accelBase: 10.0, accelPerStar: 2.0,         // m/s^2 at low speed (12..20)
  turnBase: 1.55, turnPerStar: 0.12,          // rad/s at reference speed (1.67..2.15)
  massBase: 0.8, massPerStar: 0.1,            // 0.9..1.3
  reverseMax: 9,
  brakeDecel: 32,
  coastDecel: 5,
  offroadSpeedMult: 0.5,      // max-speed multiplier on grass (ignored while boosting / star)
  curbSpeedMult: 0.96,
  boostSpeedMult: 1.32,       // max-speed multiplier while a boost timer is active
  boostAccel: 45,             // m/s^2 toward boosted max speed
  starSpeedMult: 1.15,
};

export const DRIFT = {
  minSpeed: 10,               // m/s needed to start a drift
  hopVelocity: 5,             // upward velocity of the drift hop (m/s)
  tierTimes: [0.85, 1.9, 3.2],          // seconds of drifting to reach tier 1/2/3
  boostDurations: [0, 0.6, 1.1, 1.7],   // mini-turbo length per tier (index = tier)
  tierColors: ['#ffffff', '#38c8ff', '#ff9d2e', '#c45cff'],
};

export const HIT = {
  spinDuration: 1.0,          // banana / stink cloud
  tumbleDuration: 1.5,        // bouncer / rocket / star ram
  zapSpinDuration: 0.8,
  zapSlowDuration: 2.5,
  zapSlowMult: 0.72,          // max-speed multiplier while zapped
  invulnAfterHit: 1.2,        // grace period after recovering
};

export const BOOST = {
  padDuration: 1.0,
  tootDuration: 1.25,
  startDuration: 1.2,
};

export const STAR = { duration: 7.5 };

// Item ids — every module must use exactly these strings.
export const ITEM_IDS = ['banana', 'bouncer', 'rocket', 'toot', 'triple_toot', 'stink', 'star', 'zap', 'beer'];

export const ITEM_INFO = {
  beer: { name: 'Beer Blitz', icon: '🍺', color: '#ffc451', uses: 1 },
  banana:      { name: 'Banana Peel',  icon: '🍌', color: '#ffd93b', uses: 1 },
  bouncer:     { name: 'Bouncer',      icon: '🟢', color: '#3ddc5a', uses: 1 },
  rocket:      { name: 'Homing Rocket', icon: '🚀', color: '#ff4b3e', uses: 1 },
  toot:        { name: 'Toot Boost',   icon: '💨', color: '#b8f0ff', uses: 1 },
  triple_toot: { name: 'Triple Toot',  icon: '💨', color: '#7fe3ff', uses: 3 },
  stink:       { name: 'Stink Bomb',   icon: '🦨', color: '#9be15d', uses: 1 },
  star:        { name: 'Rainbow Star', icon: '⭐', color: '#ffe14d', uses: 1 },
  zap:         { name: 'Zap Cloud',    icon: '⚡', color: '#ffe600', uses: 1 },
};

// Item roulette weights by race place (index 0 = 1st place ... 7 = 8th place).
// Order of columns matches ITEM_IDS.
//                 banana bouncer rocket toot triple stink star zap
export const ITEM_TABLE = [
  /* 1st */      [  35,    25,     5,    10,   0,    25,   0,   0 , 8 ],
  /* 2nd */      [  20,    25,    20,    15,   5,    15,   0,   0 , 8 ],
  /* 3rd */      [  12,    20,    25,    20,  10,    10,   3,   0 , 8 ],
  /* 4th */      [   8,    15,    25,    22,  15,     7,   6,   2 , 8 ],
  /* 5th */      [   5,    10,    22,    22,  22,     5,  10,   4 , 8 ],
  /* 6th */      [   2,     8,    20,    20,  27,     3,  14,   6 , 8 ],
  /* 7th */      [   0,     5,    15,    18,  32,     0,  20,  10 , 8 ],
  /* 8th */      [   0,     3,    10,    15,  35,     0,  25,  12 , 8 ],
];

export const ITEM = {
  rouletteSeconds: 2.0,       // player roulette spin time
  aiRouletteSeconds: 1.2,
  boxRespawn: 2.5,            // seconds until a broken item box reappears
  boxRadius: 1.9,             // pickup distance (kart center to box center, horizontal)
  bouncerSpeed: 48, bouncerLife: 7, bouncerMaxBounces: 6,
  rocketSpeed: 52, rocketLife: 10, rocketHomingRange: 30,
  hazardRadius: 1.4,          // banana hit distance
  stinkRadius: 4.0, stinkLife: 12,
  projectileRadius: 1.0,
  shooterGrace: 0.5,          // seconds a projectile ignores its shooter
};

// aiSpeedMult stays below 1 on every level: the player's kart always runs at
// 1.0, so CPUs with a higher top speed are unbeatable however well you drive.
// Hard comes from better lines, drifting and items (tools/sim.mjs --all checks
// that an AI-quality player still wins some Hard races).
export const DIFFICULTY = {
  easy:   { label: 'Easy',   aiSpeedMult: 0.88,  aiSkill: 0.45, rubberBand: 0.06, itemAggression: 0.4 },
  normal: { label: 'Normal', aiSpeedMult: 0.945, aiSkill: 0.7,  rubberBand: 0.08, itemAggression: 0.7 },
  hard:   { label: 'Hard',   aiSpeedMult: 0.975, aiSkill: 0.92, rubberBand: 0.08, itemAggression: 1.0 },
};

export const NET = {
  padInputHz: 60,             // phone -> desktop input rate while racing
  hostStateHz: 5,             // desktop -> phone heartbeat state rate
  httpPort: 3000,
  httpsPort: 3443,
};

export const PHYS = {
  maxSubstep: 1 / 120,        // physics substep upper bound (s)
  maxFrameDt: 0.05,           // clamp of a single frame's dt (s)
};
