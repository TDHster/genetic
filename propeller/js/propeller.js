'use strict';
// PROPELLER: the genome and the blade it describes.
//
// Genome = {
//   blades:    3..9 - number of blades (Z);
//   diameter:  share of the largest diameter that fits behind the hull (BOAT.maxDiameter);
//   pitch:     5 numbers - pitch / diameter (P/D) from the hub to the tip. Pitch is how far a blade section would
//              go in one turn if it screwed through the water like a bolt through a nut;
//   chord:     5 numbers - blade width / diameter (c/D) from the hub to the tip;
//   camber:    3 numbers - camber of the section / chord (f/c) at the hub, middle and tip: a bent section
//              lifts without an angle of attack, so the pressure peak at its nose stays low (no cavitation);
//   thickness: 3 numbers - thickness / chord (t/c) at the hub, middle and tip: a thick root is strong,
//              a thick section makes a deeper pressure dip (cavitation);
//   skew:      3 numbers - degrees the blade sweeps back against the rotation at 1/3, 2/3 of the span and at the tip
//              (the root is at 0°). A skewed blade meets a fin wake not all at once but section by section:
//              the jumps of load partly cancel. Submarine propellers look like scimitars because of this.
//   duct:      0 - an open propeller, 1 - a pump-jet: a ring round the rotor and stator vanes in front (boat.js, DUCT);
//   ductLength: length of the ring / diameter;
//   slowdown:  how much the ring slows the water at the rotor (1 - not at all, 0.7 - to 70%);
//   stators:   number of stator vanes.
//   The last three genes are inherited and mutate even without a ring - they wait for a mutation that turns it on.
// }
// Smooth curves go through the control points, so any genome is a valid propeller.

const RANGES = {
  blades: [3, 9],
  diameter: [0.5, 1],
  pitch: [0.3, 2.2],
  chord: [0.03, 0.6],
  camber: [-0.01, 0.06],
  thickness: [0.02, 0.25],
  skew: [-30, 70],
  ductLength: [0.2, 0.8],
  slowdown: [0.7, 1],
  stators: [5, 15],
};
const PITCH_POINTS = 5;
const CHORD_POINTS = 5;
const SECTION_POINTS = 3;
const SKEW_POINTS = 3;

// Catmull-Rom curve through evenly spaced points; s in [0, 1].
function curve(points, s) {
  const n = points.length - 1;
  const x = Math.min(n, Math.max(0, s * n));
  const i = Math.min(n - 1, Math.floor(x));
  const t = x - i;
  const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(n, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

function propDiameter(g) {
  return g.diameter * BOAT.maxDiameter;
}

// The blade section at relative radius x = r / R (hub..1): sizes in metres, angles in radians.
//   pd - pitch / diameter; pitchAngle - angle of the section to the plane of rotation, tan = P / (2πr);
//   c - chord; f - camber / chord; tau - thickness / chord; skew - how far the section is turned back (rad).
function sectionAt(g, x) {
  const D = propDiameter(g), R = D / 2;
  const s = Math.max(0, Math.min(1, (x - BOAT.hubRatio) / (1 - BOAT.hubRatio)));
  const pd = clampTo(curve(g.pitch, s), RANGES.pitch);
  const c = clampTo(curve(g.chord, s), RANGES.chord) * D;
  const f = clampTo(curve(g.camber, s), RANGES.camber);
  const tau = clampTo(curve(g.thickness, s), RANGES.thickness);
  const skew = curve([0, ...g.skew], s) * Math.PI / 180;
  return { x, r: x * R, pd, pitchAngle: Math.atan(pd / (Math.PI * x)), c, f, tau, skew };
}

// Blade elements for the hydrodynamics: N strips from the hub to the tip, narrower near the tip
// (the load changes fast there).
function bladeElements(g, count) {
  const R = propDiameter(g) / 2, h = BOAT.hubRatio;
  const edge = (k) => h + (1 - h) * Math.sin(Math.PI / 2 * k / count);
  const list = [];
  for (let k = 0; k < count; k++) {
    const x0 = edge(k), x1 = edge(k + 1);
    const e = sectionAt(g, (x0 + x1) / 2);
    e.dr = (x1 - x0) * R;
    list.push(e);
  }
  return list;
}

// Expanded area ratio: blade area of all blades / disc area. Ordinary ships 0.5..0.8, submarines up to 1.
function areaRatio(g) {
  const els = bladeElements(g, 24);
  const R = propDiameter(g) / 2;
  return g.blades * els.reduce((sum, e) => sum + e.c * e.dr, 0) / (Math.PI * R * R);
}

// The pump-jet genes of a propeller without them (an open propeller).
const NO_DUCT = { duct: 0, ductLength: 0.5, slowdown: 1, stators: 9 };

function copyPropeller(g) {
  return {
    blades: g.blades, diameter: g.diameter, pitch: g.pitch.slice(), chord: g.chord.slice(),
    camber: g.camber.slice(), thickness: g.thickness.slice(), skew: g.skew.slice(),
    duct: g.duct, ductLength: g.ductLength, slowdown: g.slowdown, stators: g.stators,
  };
}

// ---- Classic propellers to compare with ----

// The reference: the classic submarine propeller of the 1970s-80s - seven blades shaped like scimitars
// (strong skew), moderate pitch, thick root, thin tip.
const REFERENCE = {
  blades: 7, diameter: 1,
  pitch: [1.05, 1.15, 1.18, 1.1, 0.9],
  chord: [0.17, 0.22, 0.25, 0.24, 0.1],
  camber: [0.025, 0.025, 0.012],
  thickness: [0.18, 0.07, 0.045],
  skew: [8, 25, 45],
  ...NO_DUCT,
};
// An ordinary ship propeller (like the Wageningen B4-70 series) put on the submarine:
// 4 blades, constant pitch P/D = 1, wide oval blades, no skew. Four blades behind four fins - every blade
// hits a fin wake at the same moment: the whole propeller shakes four times per turn.
const SHIP_FOUR = {
  blades: 4, diameter: 0.9,
  pitch: [1, 1, 1, 1, 1],
  chord: [0.30, 0.36, 0.38, 0.34, 0.12],
  camber: [0.02, 0.02, 0.015],
  thickness: [0.13, 0.06, 0.05],
  skew: [0, 0, 0],
  ...NO_DUCT,
};
// A five-blade moderately skewed propeller (a modern merchant ship).
const FIVE_SKEWED = {
  blades: 5, diameter: 0.95,
  pitch: [0.95, 1.05, 1.08, 1.04, 0.9],
  chord: [0.22, 0.28, 0.31, 0.29, 0.12],
  camber: [0.025, 0.022, 0.012],
  thickness: [0.15, 0.06, 0.04],
  skew: [3, 12, 25],
  ...NO_DUCT,
};
// A pump-jet: the reference rotor, smaller and with more pitch, in a ring that slows the water to 85%, 11 stator vanes.
const PUMP_JET = {
  blades: 7, diameter: 0.9,
  pitch: [1.3, 1.4, 1.4, 1.3, 1.2],
  chord: [0.2, 0.24, 0.26, 0.25, 0.2],
  camber: [0.025, 0.025, 0.015],
  thickness: [0.18, 0.08, 0.05],
  skew: [5, 15, 25],
  duct: 1, ductLength: 0.5, slowdown: 0.85, stators: 11,
};

// ---- Random propellers, crossover, mutation ----

function randomIn(rng, [lo, hi]) {
  return lo + (hi - lo) * rng.next();
}

// The first pool is crude on purpose: no skew and no camber (flat sections), bumpy pitch and chord, no ring.
// Evolution has to find the scimitar shape, the bent sections and the pump-jet itself.
function randomPropeller(rng) {
  return {
    blades: rng.intRange(RANGES.blades[0], RANGES.blades[1]),
    diameter: randomIn(rng, RANGES.diameter),
    pitch: Array.from({ length: PITCH_POINTS }, () => randomIn(rng, RANGES.pitch)),
    chord: Array.from({ length: CHORD_POINTS }, () => rng.logUniform(RANGES.chord[0], RANGES.chord[1])),
    camber: Array.from({ length: SECTION_POINTS }, () => 0),
    thickness: Array.from({ length: SECTION_POINTS }, () => randomIn(rng, RANGES.thickness)),
    skew: Array.from({ length: SKEW_POINTS }, () => 0),
    duct: 0,
    ductLength: randomIn(rng, RANGES.ductLength),
    slowdown: randomIn(rng, RANGES.slowdown),
    stators: rng.intRange(RANGES.stators[0], RANGES.stators[1]),
  };
}

// Every gene (every control point) from a random parent.
function crossover(mom, dad, rng) {
  const pick = (a, b) => (rng.chance(0.5) ? a : b);
  const list = (a, b) => a.map((v, i) => pick(v, b[i]));
  return {
    blades: pick(mom.blades, dad.blades),
    diameter: pick(mom.diameter, dad.diameter),
    pitch: list(mom.pitch, dad.pitch),
    chord: list(mom.chord, dad.chord),
    camber: list(mom.camber, dad.camber),
    thickness: list(mom.thickness, dad.thickness),
    skew: list(mom.skew, dad.skew),
    duct: pick(mom.duct, dad.duct),
    ductLength: pick(mom.ductLength, dad.ductLength),
    slowdown: pick(mom.slowdown, dad.slowdown),
    stators: pick(mom.stators, dad.stators),
  };
}

// A new value for one number: 80% - a small step (0.1..10% of the range), 20% - anything in the range.
function nudge(value, [lo, hi], rng) {
  if (rng.chance(0.2)) return randomIn(rng, [lo, hi]);
  const step = (hi - lo) * rng.logUniform(0.001, 0.1) * (rng.chance(0.5) ? 1 : -1);
  return Math.min(hi, Math.max(lo, value + step));
}

// One mutation, in place. Returns what was changed (for the UI).
function mutate(g, rng) {
  const r = rng.next();
  const point = (key, range, name) => {
    const i = rng.int(g[key].length);
    g[key][i] = nudge(g[key][i], range, rng);
    return `${name} ${i + 1}`;
  };
  if (r < 0.20) return point('pitch', RANGES.pitch, 'шаг');
  if (r < 0.38) return point('chord', RANGES.chord, 'ширина');
  if (r < 0.49) return point('camber', RANGES.camber, 'изгиб профиля');
  if (r < 0.60) return point('thickness', RANGES.thickness, 'толщина');
  if (r < 0.75) return point('skew', RANGES.skew, 'откос');
  if (r < 0.84) { g.diameter = nudge(g.diameter, RANGES.diameter, rng); return 'диаметр'; }
  if (r < 0.91) {
    const [lo, hi] = RANGES.blades;
    g.blades += g.blades === hi ? -1 : g.blades === lo ? 1 : rng.chance(0.5) ? 1 : -1;
    return 'число лопастей';
  }
  if (r < 0.94) { g.duct = 1 - g.duct; return g.duct ? 'насадка появилась' : 'насадка исчезла'; }
  if (r < 0.96) { g.ductLength = nudge(g.ductLength, RANGES.ductLength, rng); return 'длина насадки'; }
  if (r < 0.98) { g.slowdown = nudge(g.slowdown, RANGES.slowdown, rng); return 'торможение в насадке'; }
  const [lo, hi] = RANGES.stators;
  g.stators += g.stators === hi ? -1 : g.stators === lo ? 1 : rng.chance(0.5) ? 1 : -1;
  return 'лопатки статора';
}
