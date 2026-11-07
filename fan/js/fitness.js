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
// Classes: does not blow / blows too weakly / cannot be built / stalls (the stall roar is a large part of the noise) / works / better than the reference.

const NOISE_WEIGHT = 2;      // points per dB(A)
const POWER_GAIN = 10;       // points per halving of the power
const POWER_LOSS = 30;       // points per doubling of the power
const BREEZE_PENALTY = 100;   // the breeze is the job: a twice weaker fan is useless
const MOTOR_PENALTY = 30;
const STRENGTH_PENALTY = 30;
const OVERLAP_PENALTY = 60;
const STALL_CLASS = 3;       // dB: the fan "stalls" when its stall roar is no more than this below the rest (A-weighted)
const SCORE_FLOOR = 10;      // below this the score bends smoothly towards 0: 10² / (20 − raw), positive, still ordered

// SPECIES (evolution.js protects every species with places in the pool): the number of blades.
const speciesOf = (g) => g.blades;
const speciesName = (key) => `${key} лоп.`;

const CLASS_NAMES = ['не дует', 'слабо дует', 'не сделать', 'срывается, ревёт', 'работает', 'тише эталона'];
const CLASS_WORKS = 4, CLASS_BETTER = 5;

// Everything about one fan except the score.
function measureFan(genome) {
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
  return {
    blows: true, rotor: g, trim, n, rpm: n * 60, thrust: op.T, op, prep, noise, power: op.power, flow: op.flow, breeze: breezeAt(op, D, 2),
    stress, stressAt, thinnest, overlap, gap, balance, stalledShare: prep.stalledShare,
  };
}

const REFERENCE_MEASURE = measureFan(REFERENCE);

// The score of a measured fan: { score, cls, penalty, ... }.
function scoreOf(m) {
  if (!m.blows) return { score: 1, cls: 0, penalty: 0 };
  const ref = REFERENCE_MEASURE;
  const quieter = ref.noise.rating - m.noise.rating;
  const ratio = m.power / ref.power;
  const powerPoints = ratio <= 1 ? -POWER_GAIN * Math.log2(ratio) : -POWER_LOSS * Math.log2(ratio);
  const over = (x, limit) => Math.log2(Math.max(1, x / limit));
  const weak = BREEZE_PENALTY * over(FAN.thrust, m.thrust);
  const motor = MOTOR_PENALTY * over(m.power, FAN.maxPower);
  const strength = STRENGTH_PENALTY * (over(m.stress, FAN.plastic.stress) + over(FAN.plastic.minThickness, m.thinnest));
  const overlap = OVERLAP_PENALTY * over(m.overlap, 1);
  const penalty = weak + motor + strength + overlap;
  const raw = 100 + NOISE_WEIGHT * quieter + powerPoints - penalty;
  const score = raw >= SCORE_FLOOR ? raw : SCORE_FLOOR * SCORE_FLOOR / (2 * SCORE_FLOOR - raw);
  const cls = motor + strength + overlap > 0 ? 2 : weak > 0.5 ? 1 : m.noise.laStall > m.noise.laRest - STALL_CLASS ? 3 : CLASS_WORKS;
  return { score, cls, penalty, weak, motor, strength, overlapPenalty: overlap, quieter, powerPoints, raw };
}

// Everything about one fan (for the screen).
function analyzeFan(g) {
  const m = measureFan(g);
  return { ...m, ...scoreOf(m) };
}

// The summary that goes into the pool (small: workers send it back).
function evaluateFan(g) {
  const a = analyzeFan(g);
  let cls = a.cls;
  if (cls === CLASS_WORKS && REFERENCE_SCORE && a.score > REFERENCE_SCORE) cls = CLASS_BETTER;
  if (!a.blows) return { score: a.score, cls, species: speciesOf(g) };
  return {
    score: a.score, cls, species: speciesOf(g), trim: a.trim,
    rating: a.noise.rating, la: a.noise.la, kt: a.noise.kt, thrust: a.thrust, power: a.power, stalled: a.stalledShare,
    penalty: a.penalty,
  };
}

let REFERENCE_SCORE = 0; // 0 while the reference itself is scored
REFERENCE_SCORE = evaluateFan(REFERENCE).score;
