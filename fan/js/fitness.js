'use strict';
// FITNESS: how good is a fan? Quiet first, cheap to run second. Every fan turns at the speed of the motor (FAN.rpm,
// the middle setting) and must give the breeze: push at least FAN.thrust. Its pitch is trimmed for exactly that push
// (aero.js, pitchTrim), so the breeze penalty is paid only by fans that cannot reach it at any blade angle.
//
//   score = 100 + NOISE_WEIGHT × (L_R of the reference − L_R) + power points − penalties;
//   L_R - the rating level at the bed, dB(A) with the tone penalty (acoustics.js);
//   power points: POWER_GAIN per halving of the shaft power against the reference, −POWER_LOSS per doubling.
//   The reference scores exactly 100. Noise comes first: 1 dB is worth 2 points, a twice cheaper motor - 10.
// PENALTIES (the fan must blow, be buildable, and its motor must cope):
//   - BREEZE: a push below FAN.thrust: − BREEZE_PENALTY × log2(FAN.thrust / push). More push is allowed but not rewarded
//     (it costs power and noise).
//   - MOTOR: no more than FAN.maxPower watts at the middle setting: − MOTOR_PENALTY × log2(over).
//   - STRENGTH: at the top setting (FAN.settings[2]: push and centrifugal force grow as rpm²) the stress in every section
//     (bending by the push and twist forces outboard, plus the lever of the sweep; + centrifugal tension) must stay below
//     the fatigue stress of polypropylene; section modulus of a thin plate c·t²/6. Over it: − STRENGTH_PENALTY × log2.
//   - MOULD: no wall thinner than FAN.plastic.minThickness: − STRENGTH_PENALTY × log2(minimum / thinnest).
//   - OVERLAP: seen from the front a blade must fit in the gap to its neighbours (uneven spacing makes some gaps
//     narrower!): c·cos(blade angle)/r < smallest gap. Over it: − OVERLAP_PENALTY × log2(overlap).
//   - WOBBLE: when the head turns, the gyroscopic torque of a rotor with unequal inertia in its plane pulses
//     (fan.js, wobbleOf: 1 for 2 blades, 0 for evenly spaced 3+). Over WOBBLE_TOLERANCE (chosen, not from a standard):
//     − WOBBLE_PENALTY × log2(wobble / tolerance). This is why pedestal fans have no 2-blade rotors.
// Classes: does not blow / blows too weakly / cannot be built / stalls (the stall roar is a large part of the noise) / works / better than the reference.
//
// TWO GOALS (setup.goal, chosen on the page; the default is the first):
//   'loud'   - as above: the quietest fan at the middle setting;
//   'silent' - "inaudible breeze": the motor runs the fan at its NIGHT SPEED, the fastest at which it is not heard against
//              the background setup.ambient (ambient.js; 'none' - below the threshold of hearing): in no critical band of the
//              ear is it louder than the background, no tone sticks out. The faster, the stronger the breeze. The night speed
//              is found on the noise scaled from the middle setting, then the aerodynamics is solved again at that speed
//              (the Reynolds number is lower: the blades lift worse and stall earlier) and the speed is found once more.
//              score = 100 + SILENT_WEIGHT × log2(breeze at 2 m / breeze of the reference) + the same power points
//              (at the middle setting: the fan stays an ordinary fan in the day) − the same penalties.
//              The breeze at 2 m is set by the push (aero.js, breezeAt): a smaller fan does not blow stronger.

const NOISE_WEIGHT = 2;      // points per dB(A)
const POWER_GAIN = 10;       // points per halving of the power
const POWER_LOSS = 30;       // points per doubling of the power
const BREEZE_PENALTY = 100;   // the breeze is the job: a twice weaker fan is useless
const MOTOR_PENALTY = 30;
const STRENGTH_PENALTY = 30;
const OVERLAP_PENALTY = 60;
const WOBBLE_PENALTY = 30;
const WOBBLE_TOLERANCE = 0.05;
const STALL_CLASS = 3;       // dB: the fan "stalls" when its stall roar is no more than this below the rest (A-weighted)
const SILENT_WEIGHT = 60;    // points per doubling of the inaudible breeze
const SCORE_FLOOR = 10;      // below this the score bends smoothly towards 0: 10² / (20 − raw), positive, still ordered

// SPECIES (evolution.js protects every species with places in the pool): the number of blades.
const speciesOf = (g) => g.blades;
const speciesName = (key) => `${key} лоп.`;

const CLASS_NAMES = ['не дует', 'слабо дует', 'не сделать', 'срывается, ревёт', 'работает', 'лучше эталона'];
const CLASS_WORKS = 4, CLASS_BETTER = 5;

const DEFAULT_GOAL = { goal: 'loud', ambient: 'night' };
const isSilent = (setup) => !!setup && setup.goal === 'silent';

// The night speed of a measured fan against the background `key`:
// { rpm, breeze (m/s at 2 m), cond (noiseAt there), op, prep (aerodynamics solved at a speed near it), scale (of prep) }.
function nightSpeed(m, key) {
  const D = fanDiameter(m.rotor);
  const first = quietestScale(m.prep, key);
  const n = Math.max(0.05, m.n * first);
  const op = fanForces(m.rotor, n, true);
  if (!(op.T > 0)) return { rpm: n * 60, breeze: 0, cond: noiseAt(m.prep, first), op: m.op, prep: m.prep, scale: first };
  const prep = prepareNoise(m.rotor, op);
  const scale = quietestScale(prep, key);
  return { rpm: n * 60 * scale, breeze: breezeAt(op, D, 2).at * scale, cond: noiseAt(prep, scale), op, prep, scale };
}

// Everything about one fan except the score. setup: the goal (DEFAULT_GOAL if omitted).
function measureFan(genome, setup) {
  const trim = pitchTrim(genome);
  const g = trimFan(genome, trim);   // the rotor as built: pitch trimmed for the wanted breeze
  const n = FAN.rpm / 60;
  const op = fanForces(g, n, true);
  if (!(op.T > 0)) return { blows: false };
  const prep = prepareNoise(g, op);
  const noise = noiseAt(prep, 1);
  const D = fanDiameter(g), R = D / 2, Z = g.blades;
  const balance = bladeAngles(g);

  // Strength at the top setting: loads × top, centrifugal × top (n² ∝ push).
  const top = (FAN.settings[2] / FAN.rpm) ** 2;
  const omega2 = (2 * Math.PI * n) ** 2 * top;
  const loads = op.elements.map((e) => ({ r: e.r, sweep: e.sweep, thrust: e.dT * e.dr / Z * top, side: e.dQ / e.r * e.dr / Z * top,
    mass: FAN.plastic.density * 0.7 * e.c * e.tau * e.c * e.dr }));
  let stress = 0, stressAt = FAN.hubRatio, thinnest = Infinity;
  for (const cut of [sectionAt(g, FAN.hubRatio), ...op.elements]) {
    let mT = 0, mQ = 0, mSweep = 0, pull = 0;
    for (const f of loads) {
      if (f.r <= cut.r) continue;
      mT += f.thrust * (f.r - cut.r);
      mQ += f.side * (f.r - cut.r);
      mSweep += f.thrust * f.r * Math.sin(f.sweep - cut.sweep);
      pull += f.mass * omega2 * f.r;
    }
    const t = cut.tau * cut.c;
    thinnest = Math.min(thinnest, t);
    const sigma = Math.sqrt(mT * mT + mQ * mQ + mSweep * mSweep) / (cut.c * t * t / 6) + pull / (0.7 * cut.c * t);
    if (sigma > stress) { stress = sigma; stressAt = cut.x; }
  }
  const gap = smallestGap(balance.angles);
  let overlap = 0;
  for (const e of op.elements) overlap = Math.max(overlap, e.c * Math.cos(e.pitchAngle) / e.r / gap);
  const m = {
    blows: true, rotor: g, trim, n, rpm: n * 60, thrust: op.T, op, prep, noise, power: op.power, flow: op.flow, breeze: breezeAt(op, D, 2),
    stress, stressAt, thinnest, overlap, gap, balance, wobble: wobbleOf(balance.angles), stalledShare: prep.stalledShare,
  };
  if (isSilent(setup)) m.night = nightSpeed(m, setup.ambient);
  return m;
}

const REFERENCE_MEASURE = measureFan(REFERENCE);

// The reference at its night speed, per background (computed once).
const REFERENCE_NIGHT = {};
function referenceNight(key) {
  if (!REFERENCE_NIGHT[key]) REFERENCE_NIGHT[key] = nightSpeed(REFERENCE_MEASURE, key);
  return REFERENCE_NIGHT[key];
}

// The score of a measured fan: { score, cls, penalty, ... }.
function scoreOf(m, setup) {
  if (!m.blows) return { score: 1, cls: 0, penalty: 0 };
  const ref = REFERENCE_MEASURE;
  const quieter = ref.noise.rating - m.noise.rating;
  const ratio = m.power / ref.power;
  let powerPoints = ratio <= 1 ? -POWER_GAIN * Math.log2(ratio) : -POWER_LOSS * Math.log2(ratio);
  let gain = NOISE_WEIGHT * quieter, stronger = 0;
  if (isSilent(setup)) {
    stronger = Math.log2(Math.max(1e-3, m.night.breeze) / referenceNight(setup.ambient).breeze);
    gain = SILENT_WEIGHT * stronger;
  }
  const over = (x, limit) => Math.log2(Math.max(1, x / limit));
  const weak = BREEZE_PENALTY * over(FAN.thrust, m.thrust);
  const motor = MOTOR_PENALTY * over(m.power, FAN.maxPower);
  const strength = STRENGTH_PENALTY * (over(m.stress, FAN.plastic.stress) + over(FAN.plastic.minThickness, m.thinnest));
  const overlap = OVERLAP_PENALTY * over(m.overlap, 1);
  const wobble = WOBBLE_PENALTY * over(m.wobble, WOBBLE_TOLERANCE);
  const penalty = weak + motor + strength + overlap + wobble;
  const raw = 100 + gain + powerPoints - penalty;
  const score = raw >= SCORE_FLOOR ? raw : SCORE_FLOOR * SCORE_FLOOR / (2 * SCORE_FLOOR - raw);
  const cls = motor + strength + overlap + wobble > 0 ? 2 : weak > 0.5 ? 1 : m.noise.laStall > m.noise.laRest - STALL_CLASS ? 3 : CLASS_WORKS;
  return { score, cls, penalty, weak, motor, strength, overlapPenalty: overlap, wobblePenalty: wobble, quieter, stronger, powerPoints, raw };
}

// Everything about one fan (for the screen). setup - the goal (DEFAULT_GOAL if omitted).
function analyzeFan(g, setup) {
  const m = measureFan(g, setup || DEFAULT_GOAL);
  return { ...m, ...scoreOf(m, setup || DEFAULT_GOAL) };
}

// The summary that goes into the pool (small: workers send it back).
function evaluateFan(g, setup) {
  const a = analyzeFan(g, setup);
  let cls = a.cls;
  if (cls === CLASS_WORKS && REFERENCE_SCORE && a.score > REFERENCE_SCORE) cls = CLASS_BETTER;
  if (!a.blows) return { score: a.score, cls, species: speciesOf(g) };
  return {
    score: a.score, cls, species: speciesOf(g), trim: a.trim,
    rating: a.noise.rating, la: a.noise.la, kt: a.noise.kt, thrust: a.thrust, power: a.power, stalled: a.stalledShare,
    penalty: a.penalty,
    ...(a.night ? { nightRpm: a.night.rpm, quietBreeze: a.night.breeze } : {}),
  };
}

let REFERENCE_SCORE = 0; // 0 while the reference itself is scored
REFERENCE_SCORE = evaluateFan(REFERENCE).score;
