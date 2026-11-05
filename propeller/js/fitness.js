'use strict';
// FITNESS: how good is a propeller? Noise first, speed second.
//
//   score = 100 + NOISE_WEIGHT × (noise of the reference − noise) + speed points + cavitation margin points − penalties;
//   noise in dB (source level at the quiet patrol: SETUP.patrolSpeed knots, the shaft at SETUP.depth m);
//   speed points = SPEED_WEIGHT × knots of top speed above the reference, SLOWER_WEIGHT × knots below it (negative):
//   the boat should not be slower than with the reference, and a little faster is a small bonus.
//   cavitation margin points: cavitation at the patrol depth must not start at a lower speed than with the reference,
//   −SLOWER_WEIGHT per knot earlier (no bonus for later). Without it the evolution put the start of cavitation exactly
//   at the patrol speed, and one knot faster the propeller was louder than the reference.
//   The reference scores exactly 100. Noise comes first: 1 dB is worth 2 knots above the reference.
//
// The working point (hydro.js): the propeller turns as fast as needed to push the boat at the patrol speed.
//   Top speed (deep - no cavitation limit): at the same J the torque grows as V², the power as V³;
//   V_max = V_patrol · min((BOAT.power / P_patrol)^(1/3), (BOAT.maxTorque / Q_patrol)^(1/2)).
//   The torque limit stops the "slower and slower propeller": a slow propeller is quiet (the broadband noise
//   grows as W⁵) but needs a huge motor.
// PENALTIES (the propeller must be buildable):
//   - STRENGTH: in every section of the blade (root and every strip) the bending moment of everything outboard at
//     full power (thrust and torque forces × arm, plus the arm of the skew: a section swept back pulls sideways)
//     / section modulus 0.09·c·t² must stay below
//     STRESS_LIMIT (nickel-aluminium bronze with a fatigue margin). Over it: − STRESS_PENALTY × log2(σ / limit).
//   - OVERLAP: the blades must not overlap seen from behind: Z·c·cos(pitch angle) < 2πr at every radius.
//     Over it: − OVERLAP_PENALTY × log2(overlap).
// Classes: does not push the boat / would break (strength or overlap) / cavitates at the patrol /
//          quiet (no cavitation) / better than the reference.
//
// TWO GOALS (setup.goal, chosen on the page; the default is the first):
//   'reference' - the noise is the total source level, dB (as above);
//   'sea'       - the noise is how far above the sea the propeller is heard (sea.js: excess E in its most audible band
//                 or tone line, dB; heard from 10^(E/20) m) in the sea state setup.sea. The score is the same formula with
//                 E_reference − E instead of the difference of the totals; speed, margin and penalties are the same.

const NOISE_WEIGHT = 2;      // points per dB
const SPEED_WEIGHT = 1;      // points per knot faster than the reference
const SLOWER_WEIGHT = 5;     // points per knot slower than the reference
const STRESS_LIMIT = 60e6;   // Pa
const STRESS_PENALTY = 30;
const OVERLAP_PENALTY = 60;
const SCORE_FLOOR = 10;      // below this the score bends smoothly towards 0: 10² / (20 − raw), positive, still ordered

// SPECIES (evolution.js protects every species with places in the pool): the number of blades × open or pump-jet.
// A fresh pump-jet with a rotor tuned for open water is bad until the rotor is tuned again - without its own species
// it dies in the first tournament. Key: blades, + DUCT_SPECIES for a pump-jet (7 and 107).
const DUCT_SPECIES = 100;
const speciesOf = (g) => g.blades + (g.duct ? DUCT_SPECIES : 0);
const speciesName = (key) => `${key % DUCT_SPECIES} лоп.${key >= DUCT_SPECIES ? ' в насадке' : ''}`;

const CLASS_NAMES = ['не толкает лодку', 'сломается', 'кавитирует на патруле', 'тихий', 'лучше эталона'];

// Everything about one propeller except the score (for the screen and for the score).
function measurePropeller(g) {
  const V = SETUP.patrolSpeed * KNOT;
  const J = selfPropulsion(g, V);
  if (J === null) return { pushes: false };
  const op = forcesAtJ(g, J, V, true);
  const prep = prepareNoise(g, op);
  const noise = noiseAt(prep, V, SETUP.depth);
  const power = 2 * Math.PI * op.n * op.Q;
  const eta = op.T * (1 - BOAT.thrustDeduction) * V / power;
  // Top speed: the loads grow as V², the power as V³ - until the power or the torque of the motor runs out.
  const vPower = V * Math.cbrt(BOAT.power / power), vTorque = V * Math.sqrt(BOAT.maxTorque / op.Q);
  const vMax = Math.min(vPower, vTorque);

  // Blade stress at full power (the loads grow as V²): at the root and at every strip, the bending moment of
  // everything outboard / section modulus 0.09·c·t². The skew adds a lever sideways.
  const Z = g.blades, scale = (vMax / V) ** 2;
  const loads = op.elements.map((e) => ({ r: e.r, skew: e.skew, thrust: e.dT * e.dr / Z * scale, side: e.dQ / e.r * e.dr / Z * scale }));
  let stress = 0, stressAt = BOAT.hubRatio;
  for (const cut of [sectionAt(g, BOAT.hubRatio), ...op.elements]) {
    let mT = 0, mQ = 0, mSkew = 0;
    for (const f of loads) {
      if (f.r <= cut.r) continue;
      mT += f.thrust * (f.r - cut.r);
      mQ += f.side * (f.r - cut.r);
      mSkew += f.thrust * f.r * Math.sin(f.skew - cut.skew);
    }
    const sigma = Math.sqrt(mT * mT + mQ * mQ + mSkew * mSkew) / (0.09 * cut.c * (cut.tau * cut.c) ** 2);
    if (sigma > stress) { stress = sigma; stressAt = cut.x; }
  }
  let overlap = 0;
  for (const e of op.elements) overlap = Math.max(overlap, Z * e.c * Math.cos(e.pitchAngle) / (2 * Math.PI * e.r));

  return {
    pushes: true, J, op, prep, noise, power, eta, vMax, torqueLimited: vTorque < vPower, rpm: op.n * 60, rpmMax: op.n * 60 * vMax / V,
    stress, stressAt, overlap, area: areaRatio(g),
  };
}

const REFERENCE_MEASURE = measurePropeller(REFERENCE);
const DEFAULT_GOAL = { goal: 'reference' };
const isSea = (setup) => !!setup && setup.goal === 'sea';

// How the reference is heard against the sea, per sea state (computed once).
const REFERENCE_SEA = {};
function referenceSea(state) {
  if (!REFERENCE_SEA[state]) REFERENCE_SEA[state] = seaDetection(REFERENCE_MEASURE.prep, REFERENCE_MEASURE.noise, state);
  return REFERENCE_SEA[state];
}

// The score of a measured propeller: { score, cls, penalty, ... } (+ sea: seaDetection(...) in the sea mode).
function scoreOf(m, setup) {
  if (!m.pushes) return { score: 1, cls: 0, penalty: 0 };
  const ref = REFERENCE_MEASURE;
  let quieter, sea = null;
  if (isSea(setup)) {
    sea = seaDetection(m.prep, m.noise, setup.sea);
    quieter = referenceSea(setup.sea).excess - sea.excess;
  } else {
    quieter = ref.noise.total - m.noise.total;
  }
  const faster = (m.vMax - ref.vMax) / KNOT;
  const speedPoints = faster >= 0 ? SPEED_WEIGHT * faster : SLOWER_WEIGHT * faster;
  const later = (m.noise.inception - ref.noise.inception) / KNOT;
  const marginPoints = later >= 0 ? 0 : SLOWER_WEIGHT * later;
  const penalty = STRESS_PENALTY * Math.log2(Math.max(1, m.stress / STRESS_LIMIT)) + OVERLAP_PENALTY * Math.log2(Math.max(1, m.overlap));
  const raw = 100 + NOISE_WEIGHT * quieter + speedPoints + marginPoints - penalty;
  const score = raw >= SCORE_FLOOR ? raw : SCORE_FLOOR * SCORE_FLOOR / (2 * SCORE_FLOOR - raw);
  const cls = penalty > 0 ? 1 : m.noise.extent > 0 ? 2 : 3;
  return { score, cls, penalty, quieter, faster, speedPoints, later, marginPoints, raw, sea };
}

// Everything about one propeller (for the screen). setup - the goal (DEFAULT_GOAL if omitted).
function analyzePropeller(g, setup) {
  const m = measurePropeller(g);
  return { ...m, ...scoreOf(m, setup || DEFAULT_GOAL) };
}

// The summary that goes into the pool (small: workers send it back).
function evaluatePropeller(g, setup) {
  const a = analyzePropeller(g, setup);
  let cls = a.cls;
  if (cls === 3 && REFERENCE_SCORE && a.score > REFERENCE_SCORE) cls = 4;
  if (!a.pushes) return { score: a.score, cls, species: speciesOf(g), duct: g.duct };
  return {
    score: a.score, cls, species: speciesOf(g), duct: g.duct,
    noise: a.noise.total, tonal: a.noise.tonal, broadband: a.noise.broadband, cavitation: a.noise.cavitation,
    inception: a.noise.inception, vMax: a.vMax, eta: a.eta, rpm: a.rpm, stress: a.stress, overlap: a.overlap,
    penalty: a.penalty,
    ...(a.sea ? { range: a.sea.range, excess: a.sea.excess, worstKind: a.sea.worst.kind, worstF: a.sea.worst.f } : {}),
  };
}

let REFERENCE_SCORE = 0; // 0 while the reference itself is scored
REFERENCE_SCORE = evaluatePropeller(REFERENCE).score;
