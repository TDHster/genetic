'use strict';
// FAN BLADES: the genome and the rotor it describes.
//
// Genome = {
//   blades:    2..9 - number of blades (Z);
//   diameter:  share of the largest rotor that fits in the guard (FAN.maxDiameter);
//   pitch:     4 numbers - pitch / diameter (P/D) from the hub to the tip: how far a blade section would move
//              the air in one turn if it screwed through it like a bolt through a nut. The blade angle is atan(P / 2πr).
//              These numbers give the SHAPE of the twist: the whole pitch is then trimmed so that the fan gives exactly
//              the wanted breeze (aero.js, pitchTrim) - as the blade angle is set at the factory;
//   chord:     4 numbers - blade width / diameter (c/D) from the hub to the tip;
//   camber:    3 numbers - camber of the section / chord (f/c) at the hub, middle and tip. Fan blades are thin bent
//              plates: a bent plate lifts without an angle of attack and stalls later;
//   thickness: 3 numbers - thickness / chord (t/c) at the hub, middle and tip: thick is strong, thin is light and smooth;
//   sweep:     2 numbers - degrees the blade is swept back against the rotation at the middle of the span and at the tip
//              (the root is at 0°). A swept blade meets a wake strip not all at once but section by section:
//              the jumps of push partly cancel. Quiet fans have sickle-shaped blades because of this;
//   spacing:   9 numbers - the wished shift of every blade from even spacing, as a share of the even gap 360°/Z
//              (only the first Z are used, the rest wait for more blades). Uneven spacing breaks the blade tone into
//              many weaker ones (acoustics.js). The blades are then BALANCED (bladeAngles): the angles are moved
//              as little as possible so that the centre of mass stays on the shaft - every genome is a balanced rotor.
// }
// Smooth curves go through the control points, so any genome is a valid rotor. Few points on purpose: the blade model
// treats the strips as independent and would accept a zigzag twist that a real blade pays for in lost air.

const RANGES = {
  blades: [2, 9],
  diameter: [0.6, 1],
  pitch: [0.2, 2.5],
  chord: [0.03, 0.5],
  camber: [0, 0.12],
  thickness: [0.01, 0.12],
  sweep: [-40, 70],
  spacing: [-0.3, 0.3],
};
const PITCH_POINTS = 4;
const CHORD_POINTS = 4;
const SECTION_POINTS = 3;
const SWEEP_POINTS = 2;
const MAX_BLADES = RANGES.blades[1];

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

function fanDiameter(g) {
  return g.diameter * FAN.maxDiameter;
}

// The blade section at relative radius x = r / R (hub..1): sizes in metres, angles in radians.
//   pd - pitch / diameter; pitchAngle - angle of the section to the plane of rotation, tan = P / (2πr);
//   c - chord; f - camber / chord; tau - thickness / chord; sweep - how far the section is turned back (rad).
function sectionAt(g, x) {
  const D = fanDiameter(g), R = D / 2;
  const s = Math.max(0, Math.min(1, (x - FAN.hubRatio) / (1 - FAN.hubRatio)));
  const pd = clampTo(curve(g.pitch, s), RANGES.pitch);
  const c = clampTo(curve(g.chord, s), RANGES.chord) * D;
  const f = clampTo(curve(g.camber, s), RANGES.camber);
  const tau = clampTo(curve(g.thickness, s), RANGES.thickness);
  const sweep = curve([0, ...g.sweep], s) * Math.PI / 180;
  return { x, r: x * R, pd, pitchAngle: Math.atan(pd / (Math.PI * x)), c, f, tau, sweep };
}

// Blade elements for the aerodynamics: N strips from the hub to the tip, narrower near the tip.
function bladeElements(g, count) {
  const R = fanDiameter(g) / 2, h = FAN.hubRatio;
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

// BALANCE. Equal blades at the angles θ_j keep the centre of mass on the shaft when Σ e^(iθ_j) = 0.
// From the wished angles (even + spacing genes) the smallest corrections δ_j are found that make the sum zero:
// linearised, Σ i·e^(iθ_j)·δ_j = −S; the least-squares answer is δ_j = Re(conj(i·e^(iθ_j))·λ) with a complex λ
// from a 2×2 system; repeated a few times. Consequences worth knowing: 2 blades must stand opposite,
// 3 blades must be 120° apart (three equal arrows only add to zero as a triangle), 4 blades - two opposite pairs;
// only from 5 blades on can the spacing be really uneven.
// Returns { angles (rad, blade 0 near the top), wished, imbalance (|Σ e^(iθ)| / Z of the result) }.
const anglesCache = new WeakMap();
function bladeAngles(g) {
  if (anglesCache.has(g) && anglesCache.get(g).key === anglesKey(g)) return anglesCache.get(g).value;
  const Z = g.blades;
  const wished = [];
  for (let j = 0; j < Z; j++) wished.push(2 * Math.PI * (j + clampTo(g.spacing[j], RANGES.spacing)) / Z);
  const th = wished.slice();
  for (let it = 0; it < 8; it++) {
    let sr = 0, si = 0, qr = 0, qi = 0;
    for (const t of th) { sr += Math.cos(t); si += Math.sin(t); qr -= Math.cos(2 * t); qi -= Math.sin(2 * t); }
    if (Math.hypot(sr, si) < 1e-12) break;
    // (Z·λ + q·conj(λ)) / 2 = −S, q = Σ a_j², a_j = i·e^(iθ_j) (so a_j² = −e^(2iθ_j)); unknown λ = x + iy
    // a small ridge keeps the system solvable when the blades can only fix one direction (2 opposite blades)
    const a11 = (Z + qr) / 2 + 1e-3, a12 = qi / 2, a21 = qi / 2, a22 = (Z - qr) / 2 + 1e-3;
    const det = a11 * a22 - a12 * a21;
    const x = (-sr * a22 + si * a12) / det, y = (-si * a11 + sr * a21) / det;
    for (let j = 0; j < Z; j++) {
      // a_j = i·e^(iθ) = (−sin θ, cos θ); Re(conj(a_j)·λ) = −sin θ·x + cos θ·y
      const d = -Math.sin(th[j]) * x + Math.cos(th[j]) * y;
      th[j] += Math.max(-0.5, Math.min(0.5, d));
    }
  }
  // the whole rotor may turn: put blade 0 back where it was wished (nothing physical changes)
  const turn = th[0] - wished[0];
  const angles = th.map((t) => t - turn);
  let sr = 0, si = 0;
  for (const t of angles) { sr += Math.cos(t); si += Math.sin(t); }
  const value = { angles, wished, imbalance: Math.hypot(sr, si) / Z };
  anglesCache.set(g, { key: anglesKey(g), value });
  return value;
}
function anglesKey(g) {
  return g.blades + ':' + g.spacing.slice(0, g.blades).join(',');
}

// The narrowest gap between neighbouring blades (rad) - the blades must not overlap.
function smallestGap(angles) {
  const s = angles.map((a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
  let gap = 2 * Math.PI - s[s.length - 1] + s[0];
  for (let j = 1; j < s.length; j++) gap = Math.min(gap, s[j] - s[j - 1]);
  return gap;
}

function copyFan(g) {
  return {
    blades: g.blades, diameter: g.diameter, pitch: g.pitch.slice(), chord: g.chord.slice(),
    camber: g.camber.slice(), thickness: g.thickness.slice(), sweep: g.sweep.slice(), spacing: g.spacing.slice(),
  };
}

// The same fan with the whole pitch multiplied by k (the factory trim, aero.js pitchTrim).
function trimFan(g, k) {
  return { ...copyFan(g), pitch: g.pitch.map((p) => p * k) };
}

const EVEN = Array.from({ length: MAX_BLADES }, () => 0);

// ---- Classic fans to compare with ----

// The reference: the most common 40 cm pedestal fan - three wide blades in clear blue plastic, evenly spaced,
// moderately bent, nearly constant pitch, the tips slightly swept.
const REFERENCE = {
  blades: 3, diameter: 1,
  pitch: [0.48, 0.52, 0.5, 0.46],
  chord: [0.2, 0.3, 0.33, 0.26],
  camber: [0.035, 0.025, 0.02],
  thickness: [0.05, 0.035, 0.03],
  sweep: [6, 15],
  spacing: EVEN.slice(),
};
// An old metal fan: four flat stamped plates (no camber), constant pitch, straight.
const OLD_METAL = {
  blades: 4, diameter: 0.95,
  pitch: [0.68, 0.68, 0.68, 0.68],
  chord: [0.2, 0.3, 0.32, 0.28],
  camber: [0.0, 0.0, 0.0],
  thickness: [0.025, 0.02, 0.02],
  sweep: [0, 0],
  spacing: EVEN.slice(),
};
// A five-blade fan with sickle-shaped (strongly swept) blades - the "quiet" models.
const FIVE_SICKLE = {
  blades: 5, diameter: 1,
  pitch: [0.46, 0.5, 0.48, 0.44],
  chord: [0.13, 0.19, 0.2, 0.15],
  camber: [0.035, 0.025, 0.02],
  thickness: [0.05, 0.035, 0.03],
  sweep: [20, 45],
  spacing: EVEN.slice(),
};
// The same five blades, unevenly spaced by hand (one blade pair closer, one farther).
const FIVE_UNEVEN = { ...copyFan(FIVE_SICKLE), spacing: [0, 0.12, -0.08, 0.1, -0.14, 0, 0, 0, 0] };

// ---- Random fans, crossover, mutation ----

function randomIn(rng, [lo, hi]) {
  return lo + (hi - lo) * rng.next();
}

// The first pool is crude on purpose: flat plates (no camber), straight blades (no sweep), even spacing,
// bumpy pitch and chord. Evolution has to find the bent sickle-shaped blades and the uneven spacing itself.
function randomFan(rng) {
  return {
    blades: rng.intRange(RANGES.blades[0], RANGES.blades[1]),
    diameter: randomIn(rng, RANGES.diameter),
    pitch: Array.from({ length: PITCH_POINTS }, () => randomIn(rng, RANGES.pitch)),
    chord: Array.from({ length: CHORD_POINTS }, () => rng.logUniform(RANGES.chord[0], RANGES.chord[1])),
    camber: Array.from({ length: SECTION_POINTS }, () => 0),
    thickness: Array.from({ length: SECTION_POINTS }, () => randomIn(rng, RANGES.thickness)),
    sweep: Array.from({ length: SWEEP_POINTS }, () => 0),
    spacing: EVEN.slice(),
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
    sweep: list(mom.sweep, dad.sweep),
    spacing: list(mom.spacing, dad.spacing),
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
  const point = (key, range, name, count) => {
    const i = rng.int(count || g[key].length);
    g[key][i] = nudge(g[key][i], range, rng);
    return `${name} ${i + 1}`;
  };
  if (r < 0.18) return point('pitch', RANGES.pitch, 'шаг');
  if (r < 0.34) return point('chord', RANGES.chord, 'ширина');
  if (r < 0.45) return point('camber', RANGES.camber, 'изгиб');
  if (r < 0.53) return point('thickness', RANGES.thickness, 'толщина');
  if (r < 0.67) return point('sweep', RANGES.sweep, 'саблевидность');
  if (r < 0.85) return point('spacing', RANGES.spacing, 'сдвиг лопасти', g.blades);
  if (r < 0.93) { g.diameter = nudge(g.diameter, RANGES.diameter, rng); return 'диаметр'; }
  const [lo, hi] = RANGES.blades;
  g.blades += g.blades === hi ? -1 : g.blades === lo ? 1 : rng.chance(0.5) ? 1 : -1;
  return 'число лопастей';
}
