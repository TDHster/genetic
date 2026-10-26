'use strict';
// FITNESS: how good is a rotor? Everything comes from the torque table of aero.js.
//
//   score = 1 + useful energy per year (kWh) / 100,
//   useful energy = AEP × smoothness × material.
//
// AEP (annual energy production) - a windy rooftop: Weibull wind, mean 5 m/s, k = 2, winds 1..20 m/s.
//   At every wind the controller picks the best tip speed ratio λ, but the blade tips may not go faster than
//   TIP_SPEED (noise, strength) - so in a strong wind the rotor cannot run at its best λ.
//   Power = aerodynamic power − friction torque × ω.
// SELF-START. The generator and bearings hold the rotor with the friction torque FRICTION. The rotor starts by
//   itself at the wind V only if the wind beats the friction:
//     - at rest, in the worst position of the rotor (a symmetric rotor at rest has positions with negative torque);
//     - on the whole way from rest to the working λ (the famous "dead band" of Darrieus rotors near λ = 1..2:
//       the blades are stalled, the torque falls, the rotor gets stuck turning slowly).
//   Torque grows as V², so a weak positive torque means "starts only in a strong wind": V_start.
//   Energy is counted only for winds ≥ V_start. If a starter motor gives more (MOTOR_START × the energy of all
//   winds) - the rotor "needs a starter motor": that is counted instead.
// SMOOTHNESS = 1 − RIPPLE_WEIGHT × min(1, ripple / RIPPLE_REF), ripple = (max − min) / mean torque over a turn at
//   the best λ. A shaking torque means vibration and fatigue. A helix makes the torque smooth.
// MATERIAL = min(1, (area of the reference / area)^MATERIAL_POWER): blades + struts, m². The reference sets the budget.
//
// Classes: does not turn / needs a starter motor / starts only in a strong wind (V_start > STRONG_WIND) /
//          works / works better than the reference.

const SITE = { meanWind: 5, k: 2, vMin: 1, vMax: 20, dv: 0.5, hours: 8760 };
const TIP_SPEED = 40;         // m/s
const FRICTION = 0.3;         // N·m: bearings + cogging of a small coreless generator
const MOTOR_START = 0.5;
const RIPPLE_WEIGHT = 0.3;
const RIPPLE_REF = 2;
const MATERIAL_POWER = 1;
const STRONG_WIND = 6;        // m/s

const CLASS_NAMES = ['не крутится', 'нужен пусковой мотор', 'стартует только в сильный ветер', 'работает', 'лучше эталона'];

// Weibull: the share of the year with wind v (per m/s). Scale c from the mean: mean = c·Γ(1 + 1/k), Γ(1.5) = 0.8862.
const WEIBULL_C = SITE.meanWind / 0.886227;
function windShare(v) {
  const x = v / WEIBULL_C;
  return (SITE.k / WEIBULL_C) * Math.pow(x, SITE.k - 1) * Math.exp(-Math.pow(x, SITE.k));
}
const WINDS = [];
for (let v = SITE.vMin; v <= SITE.vMax + 1e-9; v += SITE.dv) WINDS.push(v);

// Everything about one rotor (the table included, for the screen).
function analyzeRotor(g, keepDetails) {
  const table = torqueTable(g, keepDetails);
  const cpBox = table.cqMean.map((cq, i) => LAMBDAS[i] * cq);
  let best = 0;
  for (let i = 1; i < LAMBDAS.length; i++) if (cpBox[i] > cpBox[best]) best = i;
  const cpMax = cpBox[best];
  const lambdaOpt = LAMBDAS[best];
  const swept = sweptArea(g);
  const area = rotorArea(g);
  const tipRadius = Math.max(...Array.from({ length: SHAPE_STATIONS + 1 }, (_, k) => bladePoint(g, k / SHAPE_STATIONS).r));

  // Ripple at the best λ.
  const row = table.cq[best];
  const ripple = cpMax > 0 ? (Math.max(...row) - Math.min(...row)) / table.cqMean[best] : 0;

  // Self-start: the weakest torque on the way from rest to the best λ.
  const staticMin = Math.min(...table.cq[0]);
  let weakest = staticMin, weakestAt = 0;
  for (let i = 1; i <= best; i++) if (table.cqMean[i] < weakest) { weakest = table.cqMean[i]; weakestAt = LAMBDAS[i]; }
  const vStart = weakest > 0 ? Math.sqrt(FRICTION / (TORQUE_UNIT * weakest)) : Infinity;

  // Power curve.
  const power = WINDS.map((v) => {
    const lambdaLimit = TIP_SPEED * BOX.radius / (tipRadius * v);
    let p = 0, at = 0;
    for (let i = 1; i < LAMBDAS.length && LAMBDAS[i] <= lambdaLimit; i++) {
      const omega = LAMBDAS[i] * v / BOX.radius;
      const pi = cpBox[i] * 0.5 * AIR.rho * BOX_AREA * v ** 3 - FRICTION * omega;
      if (pi > p) { p = pi; at = LAMBDAS[i]; }
    }
    return { v, p, lambda: at };
  });
  const kwh = (from) => power.reduce((sum, w) => sum + (w.v >= from ? w.p * windShare(w.v) * SITE.dv : 0), 0) * SITE.hours / 1000;
  const aepAll = kwh(0);
  const aepSelf = vStart < Infinity ? kwh(vStart) : 0;
  const selfStart = aepSelf > 0 && aepSelf >= MOTOR_START * aepAll;
  const aep = selfStart ? aepSelf : MOTOR_START * aepAll;

  const smoothness = 1 - RIPPLE_WEIGHT * Math.min(1, ripple / RIPPLE_REF);
  const material = Math.min(1, Math.pow(REFERENCE_AREA / area.total, MATERIAL_POWER));
  const useful = aep * smoothness * material;

  let cls, score;
  if (aepAll <= 0) {
    cls = 0;
    score = Math.max(0, Math.min(0.99, 1 + 10 * cpMax)); // a hint of a gradient: how far from turning
  } else {
    cls = !selfStart ? 1 : vStart > STRONG_WIND ? 2 : 3;
    score = 1 + useful / 100;
  }
  return {
    table, cpBox, cpMax, cpOwn: cpMax * BOX_AREA / swept, lambdaOpt, swept, area, tipRadius,
    ripple, staticMin, weakest, weakestAt, vStart, power, aepAll, aepSelf, selfStart, aep,
    smoothness, material, useful, cls, score,
  };
}

const REFERENCE_AREA = rotorArea(REFERENCE).total;

// The summary that goes into the pool (small: workers send it back).
function evaluateRotor(g) {
  const a = analyzeRotor(g, false);
  let cls = a.cls;
  if (cls === 3 && REFERENCE_SCORE && a.score > REFERENCE_SCORE) cls = 4;
  return {
    score: a.score, cls, species: g.blades,
    aep: a.aep, aepAll: a.aepAll, useful: a.useful, vStart: a.vStart, selfStart: a.selfStart,
    cpMax: a.cpMax, cpOwn: a.cpOwn, lambdaOpt: a.lambdaOpt, ripple: a.ripple,
    smoothness: a.smoothness, material: a.material, area: a.area.total,
  };
}

let REFERENCE_SCORE = 0; // 0 while the reference itself is scored
REFERENCE_SCORE = evaluateRotor(REFERENCE).score;
