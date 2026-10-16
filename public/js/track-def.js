// Layout data for the single race course. Node-safe, pure data.
//
// The centerline is a "turtle" path: starting at `start` (the start/finish
// line) and heading `start.yaw`, each segment is either a straight or a
// circular arc. Total turning is exactly -360° (a clockwise loop when seen
// from above with +X right / +Z down), and the two closing straights were
// solved so the path closes on itself. Any tiny residual closure error is
// distributed along the loop by track.js.
//
// Per-segment attributes (elevation, road half-width, off-road widths) are
// given as keyframes in "u" coordinates: u = segmentIndex + fraction, so
// [6.6, 9] means "60% of the way through segment 6, the value is 9".
// u ranges over [0, segments.length]; u = segments.length is the start line
// again (the loop wraps). Values are linearly interpolated between keyframes
// and then smoothed with a box filter (see `smoothing`).
//
// Heading convention (SPEC.md): forward = (sin yaw, 0, cos yaw); a RIGHT turn
// DEcreases yaw.

export const TRACK_DEF = {
  name: 'Breezy Bay Circuit',
  start: { x: 0, y: 0, z: 0, yaw: 0 },
  sampleSpacing: 1.0,          // meters between centerline samples

  segments: [
    /* 0 */ { type: 'straight', length: 85, name: 'Start Straight' },
    /* 1 */ { type: 'arc', dir: 'right', angle: 90, radius: 42, name: 'Turn 1' },
    /* 2 */ { type: 'straight', length: 45, name: 'Item Straight' },
    /* 3 */ { type: 'arc', dir: 'left', angle: 50, radius: 30, name: 'Esses A' },
    /* 4 */ { type: 'arc', dir: 'right', angle: 100, radius: 30, name: 'Esses B' },
    /* 5 */ { type: 'arc', dir: 'left', angle: 50, radius: 30, name: 'Esses C' },
    /* 6 */ { type: 'straight', length: 95, name: 'Breezy Hill' },
    /* 7 */ { type: 'arc', dir: 'right', angle: 180, radius: 22, name: 'Lighthouse Hairpin' },
    /* 8 */ { type: 'straight', length: 113.92, name: 'Bay Bridge' },
    /* 9 */ { type: 'arc', dir: 'left', angle: 90, radius: 38, name: 'Harbor Kink' },
    /* 10 */ { type: 'straight', length: 105, name: 'Ramp Run' },
    /* 11 */ { type: 'arc', dir: 'right', angle: 90, radius: 46, name: 'Cliff Sweep A' },
    /* 12 */ { type: 'straight', length: 30, name: 'Cliff Top' },
    /* 13 */ { type: 'arc', dir: 'right', angle: 90, radius: 46, name: 'Cliff Sweep B' },
    /* 14 */ { type: 'straight', length: 59.99, name: 'Home Straight' },
  ],

  // Road elevation (m). Crest at u=6.6 is steep enough on the far side to
  // launch fast karts (~0.6 s airtime at top speed). The hairpin exit climbs
  // gently (~6 %) onto the Bay Bridge so the deck clears the water by ~4 m,
  // and the Cliff Sweeps climb to a 5.5 m sea-cliff top. Every other convex
  // crest is split into two half-size grade changes (extra keys) so its
  // vertical curvature stays below ~0.011 1/m: even a boosted kart (~41 m/s)
  // stays glued to the road there; only the hill crest launches.
  elevation: [
    [0, 0], [2, 0], [3, 0.5], [6, 2], [6.6, 9], [7, 1.2], [7.45, 1.3], [8, 3.6],
    [9, 3.6], [9.3, 2.72], [9.8, 0.15], [10, 0], [11, 0], [11.62, 4.13], [12.07, 5.5],
    [13, 5.5], [13.415, 4.06], [14, 0], [15, 0],
  ],
  // Road half-width (m): distance from centerline to the road edge.
  halfWidth: [
    [0, 11], [0.85, 11], [1, 9.5], [2.5, 9], [3, 8.5], [6, 8.5], [7, 9.5],
    [7.9, 9.5], [8, 7.5], [9, 7.5], [9.2, 8.5], [13, 9], [14, 10.5], [14.5, 11], [15, 11],
  ],
  // Off-road (grass) width beyond each road edge before the wall (m).
  // "Left"/"right" are relative to the driving direction.
  offroadLeft: [
    [0, 7], [1, 9], [2, 7], [7, 11], [7.9, 7], [8, 0.8], [9, 0.8], [9.1, 7], [15, 7],
  ],
  offroadRight: [
    [0, 7], [7.9, 7], [8, 0.8], [9, 0.8], [9.1, 7], [10, 6], [15, 7],
  ],
  smoothing: { elevation: 2, halfWidth: 6, offroad: 3 },   // box-filter radius in samples

  // Item box rows (u position); boxes are spread evenly across the road.
  itemRows: [
    { u: 0.70, count: 5 },
    { u: 2.35, count: 5 },
    { u: 6.20, count: 4 },
    { u: 8.55, count: 4 },
    { u: 12.45, count: 5 },
  ],

  // Dash panels. lateral = offset of pad center from the centerline (+ = right).
  boostPads: [
    { u: 2.70, lateral: -4.0, length: 5, width: 3.6 },
    { u: 8.25, lateral: 0.0, length: 5, width: 3.6 },
    { u: 10.40, lateral: 0.0, length: 5, width: 4.0 },
    { u: 12.70, lateral: 3.5, length: 5, width: 3.6 },
  ],

  // Kicker ramps: height rises linearly over `length` meters, then drops to 0.
  // lateral/width define the covered strip (width 0 = full road width).
  ramps: [
    { u: 10.47, length: 7, height: 1.7, lateral: 0, width: 0 },
  ],

  // Visual hints for the world builder (inclusive u ranges).
  zones: [
    { u0: 8.0, u1: 9.0, type: 'bridge' },
    { u0: 6.0, u1: 7.0, type: 'hill' },
    { u0: 7.0, u1: 8.0, type: 'hairpin' },
    { u0: 11.0, u1: 14.0, type: 'cliff' },
  ],
};

// A closed stadium course designed for long, adjustable drift arcs.
export const SPEEDWAY_DEF = {
  ...TRACK_DEF, name: 'Sahur Speedway',
  segments: [
    {type:'straight',length:155,name:'Sahur Straight'},
    {type:'arc',dir:'right',angle:180,radius:58,name:'Moon Bend'},
    {type:'straight',length:155,name:'Boost Alley'},
    {type:'arc',dir:'right',angle:180,radius:58,name:'Forest Bend'},
  ],
  elevation:[[0,0],[4,0]], halfWidth:[[0,13],[4,13]],
  offroadLeft:[[0,8],[4,8]],offroadRight:[[0,8],[4,8]],
  itemRows:[{u:.65,count:5},{u:2.6,count:5}],
  boostPads:[{u:.3,lateral:-5,length:6,width:4},{u:2.3,lateral:5,length:6,width:4}],
  ramps:[], zones:[],
};
