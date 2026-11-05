'use strict';
// HYDRODYNAMICS: how much the propeller pushes and how much torque it takes.
//
// 1. SECTION (thin airfoil theory + empirical drag). A blade section of camber f and thickness τ at the angle of
//    attack α (radians, from the "ideal" angle: for a parabolic camber line the flow meets the nose smoothly at α = 0):
//      lift  CL = 2π·0.9·(α + 2f), capped at the stall angle;
//      drag  CD = 2·Cf·(1 + 2τ + 60τ⁴) + 0.5·α² (+ a lot more past the stall), Cf - turbulent plate (ITTC-57);
//      the lowest pressure on the section (cavitation starts there when it falls below the vapour pressure):
//        −Cp_min = (1 + 1.1τ + 3.6f + 0.67·|α|/τ)² − 1 on the back (suction) side, the same with −f on the face.
//        Thickness and camber make a gentle dip in the middle of the chord; an angle of attack makes a sharp
//        peak at the rounded nose, the sharper the thinner the section. This is the "cavitation bucket":
//        a section is safe in a narrow band of angles around the ideal one.
// 2. BLADE ELEMENT MOMENTUM (BEM). The blade is cut into strips. Every strip is a section in the flow
//    (axial: water speed in the wake, plus what the propeller adds; around: the blade speed 2πnr minus the swirl).
//    The added axial speed (induction a) is found by bisection: the thrust of the strip must equal the momentum
//    the propeller gives the water through the ring of the strip. The swirl b follows from a (Glauert: the induced
//    velocity is perpendicular to the flow at the blade). The Prandtl factor F accounts for
//    the finite number of blades (the water slips round the tips).
// 3. SELF-PROPULSION. Thrust must equal the hull drag / (1 − t). Both grow as V² and the propeller loads stay the
//    same at one advance ratio J = V / (nD): there is one working J for all speeds, found by bisection.

const HYDRO = {
  elements: 12,
  liftSlope: 2 * Math.PI * 0.9,
  stall: 0.16,              // rad (~9°) from the ideal angle
  iterations: 30,           // bisection steps for the induction of a strip
  aMin: -0.2,
  aMax: 3,
  jMin: 0.05,
  jMax: 3.0,
};

// Turbulent skin friction of a plate at the Reynolds number re (ITTC-57).
function skinFriction(re) {
  const l = Math.log10(Math.max(1e5, re)) - 2;
  return 0.075 / (l * l);
}

// The lowest pressure coefficient (as a positive suction, −Cp_min) on a section at the angle of attack alpha.
function suctionPeak(alpha, f, tau) {
  const nose = 0.67 * Math.abs(alpha) / tau;
  const back = 1 + 1.1 * tau + 3.6 * f + (alpha > 0 ? nose : 0);
  const face = 1 + 1.1 * tau - 3.6 * f + (alpha < 0 ? nose : 0);
  return Math.max(back, face) ** 2 - 1;
}

// Lift and drag of a section. out = { cl, cd, stalled }.
function sectionForces(alpha, f, tau, re, out) {
  const s = HYDRO.stall;
  const a = Math.max(-s, Math.min(s, alpha));
  const past = Math.abs(alpha) - s;
  out.cl = HYDRO.liftSlope * (a + 2 * f) * (past > 0 ? Math.max(0.5, 1 - 2 * past) : 1);
  out.cd = 2 * skinFriction(re) * (1 + 2 * tau + 60 * tau ** 4) + 0.5 * a * a + (past > 0 ? 1.8 * Math.sin(past) ** 2 : 0);
  out.stalled = past > 0;
  return out;
}

// One strip e of a propeller with Z blades and tip radius R: the water comes at va (axial) and u (around).
// ducted - inside a pump-jet ring: no tip loss.
// Returns { a, b, phi, w, alpha, F, cl, cd, stalled, dT, dQ } (dT, dQ - thrust and torque of all Z blades per metre of span).
function solveStrip(e, va, u, Z, R, ducted) {
  const rho = WATER.rho;
  const sec = { cl: 0, cd: 0, stalled: false };
  const st = { a: 0, b: 0, phi: 0, w: 0, alpha: 0, F: 1, cl: 0, cd: 0, stalled: false, dT: 0, dQ: 0 };
  // The strip with the axial induction a: everything else follows; returns the momentum balance
  // (thrust of the blades minus thrust from the momentum of the water: > 0 means a is too small).
  const balance = (a) => {
    // swirl: the induced velocity is perpendicular to the water flow at the blade (Glauert):
    // b (1 − b) u² = a (1 + a) va²
    const b = (1 - Math.sqrt(Math.max(0, 1 - 4 * a * (1 + a) * (va / u) ** 2))) / 2;
    const ax = va * (1 + a), tg = u * (1 - b);
    st.a = a; st.b = b;
    st.phi = Math.atan2(ax, tg);
    st.w = Math.hypot(ax, tg);
    st.alpha = e.pitchAngle - st.phi;
    sectionForces(st.alpha, e.f, e.tau, st.w * e.c / WATER.nu, sec);
    st.cl = sec.cl; st.cd = sec.cd; st.stalled = sec.stalled;
    const q = 0.5 * rho * st.w * st.w * e.c * Z;
    st.dT = q * (sec.cl * Math.cos(st.phi) - sec.cd * Math.sin(st.phi));
    st.dQ = q * (sec.cl * Math.sin(st.phi) + sec.cd * Math.cos(st.phi)) * e.r;
    // Prandtl tip loss
    const sinPhi = Math.max(0.02, Math.sin(st.phi));
    st.F = ducted ? 1 : Math.max(0.05, 2 / Math.PI * Math.acos(Math.exp(-Z * (R - e.r) / (2 * e.r * sinPhi))));
    // momentum: dT = 4πr ρ va² (1 + a) a F
    return st.dT - 4 * Math.PI * e.r * rho * va * va * (1 + a) * a * st.F;
  };
  // bisection on a (direct iterations swing back and forth near the tip, where F is small)
  let lo = HYDRO.aMin, hi = HYDRO.aMax;
  if (balance(lo) <= 0) hi = lo;
  else if (balance(hi) >= 0) lo = hi;
  for (let it = 0; it < HYDRO.iterations && hi - lo > 1e-6; it++) {
    const mid = (lo + hi) / 2;
    if (balance(mid) > 0) lo = mid; else hi = mid;
  }
  balance((lo + hi) / 2);
  return st;
}

// Forces of the propeller g at the boat speed V (m/s) and n turns per second. With keep - the state of every strip,
// plus how it answers a slower water (for the wake harmonics, noise.js):
//   thrustPerSlow - extra thrust (N per metre of span, all blades) per 1 m/s of slower water,
//   alphaPerSlow  - extra angle of attack (rad) per 1 m/s of slower water,
//   sidePerSlow   - extra force along the rotation (N per metre, all blades) per 1 m/s of slower water.
// The induction answers too and takes part of the jump away (quasi-steady: the slow limit).
// A pump-jet (g.duct): the ring slows the water at the rotor to g.slowdown, pulls back DUCT.backThrust × (1 − slowdown)
// of the rotor thrust and adds its friction; T is the thrust of the whole unit, rotorThrust - of the blades.
// Returns { T (N), Q (N·m), KT, KQ, J, elements }.
function propellerForces(g, V, n, keep) {
  const Z = g.blades, D = propDiameter(g), R = D / 2;
  const rho = WATER.rho, omega = 2 * Math.PI * n;
  let T = 0, Q = 0;
  const kept = keep ? [] : null;
  const ducted = !!g.duct, slow = ducted ? g.slowdown : 1;
  for (const e of bladeElements(g, HYDRO.elements)) {
    const free = V * (1 - wakeMean(e.x));
    const va = free * slow;
    const u = omega * e.r;
    const st = solveStrip(e, va, u, Z, R, ducted);
    T += st.dT * e.dr;
    Q += st.dQ * e.dr;
    if (keep) {
      const dv = 0.02 * va;
      const slower = solveStrip(e, va - dv, u, Z, R, ducted);
      kept.push({
        ...e, va, u, ...st, re: st.w * e.c / WATER.nu, suction: suctionPeak(st.alpha, e.f, e.tau),
        thrustPerSlow: (slower.dT - st.dT) / dv, alphaPerSlow: (slower.alpha - st.alpha) / dv,
        sidePerSlow: (slower.dQ - st.dQ) / e.r / dv,
        pressureGain: 0.5 * rho * free * free * (1 - slow * slow),  // the ring raises the pressure at the rotor (Pa)
      });
    }
  }
  const rotorThrust = T;
  if (ducted) {
    const ring = 2 * Math.PI * D * g.ductLength * D;  // both surfaces, m²
    T = T * (1 - DUCT.backThrust * (1 - slow)) - 0.5 * rho * V * V * DUCT.friction * ring;
  }
  const KT = T / (rho * n * n * D ** 4), KQ = Q / (rho * n * n * D ** 5);
  return { T, Q, KT, KQ, J: V / (n * D), V, n, rotorThrust, elements: kept };
}

// Forces at the advance ratio J for the boat speed V.
function forcesAtJ(g, J, V, keep) {
  return propellerForces(g, V, V / (J * propDiameter(g)), keep);
}

// What the hull needs: KT / J² = resistance / ((1 − t) ρ D²).
function requiredLoad(g) {
  return BOAT.resistance / ((1 - BOAT.thrustDeduction) * WATER.rho * propDiameter(g) ** 2);
}

// The working advance ratio (self-propulsion) at the boat speed V: KT(J) / J² = requiredLoad.
// Returns null if the propeller cannot push the boat at all.
function selfPropulsion(g, V) {
  const need = requiredLoad(g);
  const excess = (J) => forcesAtJ(g, J, V, false).KT / (J * J) - need;
  let lo = HYDRO.jMin, hi = HYDRO.jMax;
  if (excess(lo) <= 0) return null;
  if (excess(hi) > 0) return hi;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (excess(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// KT, KQ and the propulsive efficiency over J (for the chart).
function performanceCurves(g, V, count) {
  const list = [];
  for (let k = 0; k <= count; k++) {
    const J = 0.1 + (HYDRO.jMax - 0.1) * k / count;
    const f = forcesAtJ(g, J, V, false);
    const eta = f.Q > 0 ? (f.T * (1 - BOAT.thrustDeduction) * V) / (2 * Math.PI * f.n * f.Q) : 0;
    list.push({ J, KT: f.KT, KQ: f.KQ, eta });
  }
  return list;
}
