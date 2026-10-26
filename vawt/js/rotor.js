'use strict';
// ROTOR: the genome and the shape it describes.
//
// A vertical-axis (Darrieus) rotor: B blades go around a vertical shaft. The rotor must fit into a fixed
// cylinder (BOX: 3 m high, radius 1.2 m - a rooftop turbine). Without the box "bigger is better" would win.
//
// Genome = {
//   blades:    2..5 - number of blades (one blade would need a counterweight: it shakes the tower);
//   radius:    5 numbers - distance of the blade from the shaft at heights 0, 1/4, 1/2, 3/4, 1 of the box
//              (fraction of the box radius). All 1 = straight "H-rotor", 0-1-0 = "egg beater" (Φ-Darrieus);
//   chord:     3 numbers - blade width (m) at the bottom, middle and top;
//   twist:     degrees the blade turns around the shaft from bottom to top: 0 = straight, 120° on 3 blades = Gorlov helix;
//   pitch:     degrees the blade is turned around its own axis (toe-in / toe-out);
//   thickness: thickness / chord of the NACA 00xx section (0.18 = NACA0018).
// }
// Smooth curves go through the control points, so any genome is a valid rotor.
//
// Struts: a blade end farther than STRUT_MIN from the shaft has to be held by a strut (an arm).
// Struts cost material and drag. An egg beater whose ends come to the shaft needs none.

const BOX = { height: 3, radius: 1.2 };
const RANGES = {
  blades: [2, 5],
  radius: [0.05, 1],
  chord: [0.03, 0.4],
  twist: [-180, 180],
  pitch: [-10, 10],
  thickness: [0.12, 0.3],
};
const RADIUS_POINTS = 5;
const CHORD_POINTS = 3;
const STRUT_MIN = 0.25;      // m: a blade end farther than this from the shaft needs a strut
const STRUT_CHORD = 0.08;    // m: width of a strut (streamlined)
const SHAPE_STATIONS = 40;   // stations along the height for drawing and for the blade area

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

// One point of the blade at relative height s: radius r (m), chord c (m), turn around the shaft phi (rad),
// slopes dr/dz and r·dphi/dz.
function bladePoint(g, s) {
  const H = BOX.height, R = BOX.radius;
  const rOf = (u) => R * Math.max(RANGES.radius[0], Math.min(1, curve(g.radius, Math.min(1, Math.max(0, u)))));
  const r = rOf(s);
  const ds = 0.01;
  const drdz = (rOf(s + ds) - rOf(s - ds)) / (Math.min(1, s + ds) - Math.max(0, s - ds)) / H;
  const twist = g.twist * Math.PI / 180;
  const c = Math.max(RANGES.chord[0], curve(g.chord, s));
  return { z: s * H, r, c, phi: twist * (s - 0.5), drdz, helix: r * twist / H };
}

// Horizontal slices for the aerodynamics: their middle points and heights.
function rotorSlices(g, count) {
  const list = [];
  for (let k = 0; k < count; k++) {
    const p = bladePoint(g, (k + 0.5) / count);
    p.dz = BOX.height / count;
    p.cosDelta = 1 / Math.sqrt(1 + p.drdz * p.drdz); // the blade leans out of vertical (egg beater)
    list.push(p);
  }
  return list;
}

// Strut radii: one strut per blade end that is far from the shaft.
function strutRadii(g) {
  return [bladePoint(g, 0).r, bladePoint(g, 1).r].filter((r) => r > STRUT_MIN);
}

// Material: blade area (both helix and lean make a blade longer) + strut area, m².
function rotorArea(g) {
  let blade = 0;
  const dz = BOX.height / SHAPE_STATIONS;
  for (let k = 0; k < SHAPE_STATIONS; k++) {
    const p = bladePoint(g, (k + 0.5) / SHAPE_STATIONS);
    blade += p.c * dz * Math.sqrt(1 + p.drdz * p.drdz + p.helix * p.helix);
  }
  const struts = strutRadii(g).reduce((sum, r) => sum + r * STRUT_CHORD, 0);
  return { blades: g.blades * blade, struts: g.blades * struts, total: g.blades * (blade + struts) };
}

// Swept area (the rotor seen from the wind), m².
function sweptArea(g) {
  let a = 0;
  const dz = BOX.height / SHAPE_STATIONS;
  for (let k = 0; k < SHAPE_STATIONS; k++) a += 2 * bladePoint(g, (k + 0.5) / SHAPE_STATIONS).r * dz;
  return a;
}

function copyRotor(g) {
  return { blades: g.blades, radius: g.radius.slice(), chord: g.chord.slice(), twist: g.twist, pitch: g.pitch, thickness: g.thickness };
}

// ---- Classic rotors to compare with ----

// The reference: the most common small VAWT - 3 straight NACA0018 blades on struts.
const REFERENCE = { blades: 3, radius: [1, 1, 1, 1, 1], chord: [0.15, 0.15, 0.15], twist: 0, pitch: 0, thickness: 0.18 };
// Gorlov / Quietrevolution style: the same, but every blade turns 120° - one blade always faces the wind.
const GORLOV = { ...REFERENCE, radius: REFERENCE.radius.slice(), chord: REFERENCE.chord.slice(), twist: 120 };
// Darrieus' original "egg beater": 2 curved blades whose ends meet the shaft, no struts.
const EGG_BEATER = { blades: 2, radius: [0.05, 0.78, 1, 0.78, 0.05], chord: [0.2, 0.2, 0.2], twist: 0, pitch: 0, thickness: 0.18 };

// ---- Random rotors, crossover, mutation ----

function randomIn(rng, [lo, hi]) {
  return lo + (hi - lo) * rng.next();
}

function randomRotor(rng) {
  return {
    blades: rng.intRange(RANGES.blades[0], RANGES.blades[1]),
    radius: Array.from({ length: RADIUS_POINTS }, () => randomIn(rng, RANGES.radius)),
    chord: Array.from({ length: CHORD_POINTS }, () => rng.logUniform(RANGES.chord[0], RANGES.chord[1])),
    twist: randomIn(rng, RANGES.twist),
    pitch: randomIn(rng, RANGES.pitch),
    thickness: randomIn(rng, RANGES.thickness),
  };
}

// Every gene (every control point) from a random parent.
function crossover(mom, dad, rng) {
  const pick = (a, b) => (rng.chance(0.5) ? a : b);
  return {
    blades: pick(mom.blades, dad.blades),
    radius: mom.radius.map((v, i) => pick(v, dad.radius[i])),
    chord: mom.chord.map((v, i) => pick(v, dad.chord[i])),
    twist: pick(mom.twist, dad.twist),
    pitch: pick(mom.pitch, dad.pitch),
    thickness: pick(mom.thickness, dad.thickness),
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
  if (r < 0.35) {
    const i = rng.int(RADIUS_POINTS);
    g.radius[i] = nudge(g.radius[i], RANGES.radius, rng);
    return `радиус ${i + 1}`;
  }
  if (r < 0.55) {
    const i = rng.int(CHORD_POINTS);
    g.chord[i] = nudge(g.chord[i], RANGES.chord, rng);
    return `хорда ${i + 1}`;
  }
  if (r < 0.7) { g.twist = nudge(g.twist, RANGES.twist, rng); return 'закрутка'; }
  if (r < 0.8) {
    const [lo, hi] = RANGES.blades;
    g.blades += g.blades === hi ? -1 : g.blades === lo ? 1 : rng.chance(0.5) ? 1 : -1;
    return 'число лопастей';
  }
  if (r < 0.9) { g.pitch = nudge(g.pitch, RANGES.pitch, rng); return 'установочный угол'; }
  g.thickness = nudge(g.thickness, RANGES.thickness, rng);
  return 'толщина профиля';
}
