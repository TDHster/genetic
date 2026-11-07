'use strict';
// AERODYNAMICS: how hard the fan pushes the air and how much torque it takes.
//
// 1. SECTION (thin airfoil theory + empirical drag for small, slow blades). A thin bent plate of camber f and
//    thickness τ at the angle of attack α (radians, from the chord):
//      lift  CL = 2π·0.9·(α + 2f), capped at the stall angles and at CLmax(Re) (stallAngles);
//      drag  CD = CDmin(Re, f)·(1 + 2τ + 60τ⁴) + 0.5·α² (+ a lot more past the stall). A fan blade works at a small Reynolds
//            number (Re = W·c/ν ≈ 30 000..150 000): the boundary layer is thick and lazy, CDmin grows as Re^−0.4.
//      Past the stall the air leaves the back of the blade: the lift falls, the drag jumps - and the blade roars
//      (acoustics.js).
// 2. BLADE ELEMENT MOMENTUM (BEM) for a fan in still air. The blade is cut into strips. Every strip is a section in
//    the flow: axial - the speed w the fan itself gives the air (induced), around - the blade speed 2πnr minus the swirl.
//    w is found by bisection: the push of the strip must equal the momentum the fan gives the air through the ring of the
//    strip, dT = 4πr·ρ·w·(v + w)·F (v - air speed from outside, 0 in still air). The swirl b follows from w (Glauert:
//    the induced velocity is perpendicular to the flow at the blade). The Prandtl factor F: the air slips round the tips.
// 3. SPEED. The motor sets the turn rate (room.js). In still air every speed scales with it: the push grows as n².
// 4. RESPONSE TO A WAKE STRIP (for the hum). Where the inflow is slower by δv, the air meets the blade at a steeper
//    angle: δα = δv·cos φ / W. The lift jumps by ½ρW²c·CLα·δα, its axial part pushes, its part along the rotation twists.
//    The blade passes a strip in milliseconds - the induced flow has no time to answer, so it is kept frozen.

const AERO = {
  elements: 12,
  liftSlope: 2 * Math.PI * 0.9,
  stallUp: 0.19,            // rad (~11°): the back of the blade stalls (or earlier, see stallAngles)
  stallDown: -0.12,         // rad: the face stalls (a bent plate at a negative angle)
  clMax: [1.0, 1.3],        // the largest lift at Re = 30 000 and from Re = 150 000
  iterations: 34,           // bisection steps for the induction of a strip
};

// Smallest drag of a thin section at the Reynolds number re (+ a bent plate rubs a little more).
function minimumDrag(re, f) {
  return 0.016 * Math.pow(1e5 / Math.max(1e4, re), 0.4) + 1.0 * f * f;
}

// The stall angles of a section of camber f at the Reynolds number re: [face, back] (rad).
// The back stalls at AERO.stallUp - or earlier, when the lift reaches CLmax: a small slow blade has a thick lazy boundary
// layer that cannot follow a strongly bent back (CLmax 1.0 at Re = 30 000, 1.3 from Re = 150 000). So a strong camber
// lifts a lot without an angle of attack, but has little angle left before the stall.
function stallAngles(f, re) {
  const k = Math.max(0, Math.min(1, Math.log10(Math.max(1, re) / 3e4) / 0.7));
  const clMax = AERO.clMax[0] + (AERO.clMax[1] - AERO.clMax[0]) * k;
  return [AERO.stallDown, Math.max(AERO.stallDown + 0.02, Math.min(AERO.stallUp, clMax / AERO.liftSlope - 2 * f))];
}

// Lift and drag of a section. out = { cl, cd, stalled, past (rad beyond the stall) }.
function sectionForces(alpha, f, tau, re, out) {
  const [down, up] = stallAngles(f, re);
  const a = Math.max(down, Math.min(up, alpha));
  const past = alpha > up ? alpha - up : alpha < down ? down - alpha : 0;
  out.cl = AERO.liftSlope * (a + 2 * f) * (past > 0 ? Math.max(0.5, 1 - 2 * past) : 1);
  out.cd = minimumDrag(re, f) * (1 + 2 * tau + 60 * tau ** 4) + 0.5 * a * a + (past > 0 ? 1.8 * Math.sin(past) ** 2 : 0);
  out.stalled = past > 0;
  out.past = past;
  return out;
}

// One strip e of a rotor with Z blades and tip radius R; u - blade speed Ω·r, v - outside axial air speed.
// Returns { w, b, phi, W, alpha, F, cl, cd, stalled, dT, dQ } (dT, dQ - push and torque of all Z blades per metre of span).
function solveStrip(e, u, v, Z, R) {
  const rho = AIR.rho;
  const sec = { cl: 0, cd: 0, stalled: false, past: 0 };
  const st = { w: 0, b: 0, phi: 0, W: 0, alpha: 0, F: 1, cl: 0, cd: 0, stalled: false, past: 0, dT: 0, dQ: 0 };
  // The strip with the induced speed w; returns the momentum balance (> 0: w is too small).
  const balance = (w) => {
    const ax = v + w;
    const b = (1 - Math.sqrt(Math.max(0, 1 - 4 * w * ax / (u * u)))) / 2;
    const tg = u * (1 - b);
    st.w = w; st.b = b;
    st.phi = Math.atan2(ax, tg);
    st.W = Math.hypot(ax, tg);
    st.alpha = e.pitchAngle - st.phi;
    sectionForces(st.alpha, e.f, e.tau, st.W * e.c / AIR.nu, sec);
    st.cl = sec.cl; st.cd = sec.cd; st.stalled = sec.stalled; st.past = sec.past;
    const q = 0.5 * rho * st.W * st.W * e.c * Z;
    st.dT = q * (sec.cl * Math.cos(st.phi) - sec.cd * Math.sin(st.phi));
    st.dQ = q * (sec.cl * Math.sin(st.phi) + sec.cd * Math.cos(st.phi)) * e.r;
    const sinPhi = Math.max(0.02, Math.sin(st.phi));
    st.F = Math.max(0.05, 2 / Math.PI * Math.acos(Math.exp(-Z * (R - e.r) / (2 * e.r * sinPhi))));
    return st.dT - 4 * Math.PI * e.r * rho * w * ax * st.F;
  };
  let lo = 0, hi = 0.9 * u;
  if (balance(lo) <= 0) hi = lo;
  else if (balance(hi) >= 0) lo = hi;
  for (let it = 0; it < AERO.iterations && hi - lo > 1e-7; it++) {
    const mid = (lo + hi) / 2;
    if (balance(mid) > 0) lo = mid; else hi = mid;
  }
  balance((lo + hi) / 2);
  return st;
}

// Forces of the rotor g at n turns per second in still air. With keep - the state of every strip and how it answers
// a slower inflow (for the hum, acoustics.js; all Z blades together, per metre of span, per 1 m/s of slower air):
//   thrustPerSlow - extra push, sidePerSlow - extra force along the rotation, alphaPerSlow - extra angle of attack (rad).
// Returns { T (N), Q (N·m), power (W), flow (m³/s), n, elements }.
function fanForces(g, n, keep) {
  const Z = g.blades, R = fanDiameter(g) / 2, rho = AIR.rho, omega = 2 * Math.PI * n;
  let T = 0, Q = 0, flow = 0;
  const kept = keep ? [] : null;
  for (const e of bladeElements(g, AERO.elements)) {
    const u = omega * e.r;
    const st = solveStrip(e, u, 0, Z, R);
    T += st.dT * e.dr;
    Q += st.dQ * e.dr;
    flow += 2 * Math.PI * e.r * e.dr * st.w;
    if (keep) {
      const slope = AERO.liftSlope * (st.stalled ? 0.3 : 1);
      const lift = 0.5 * rho * st.W * e.c * Z * slope * Math.cos(st.phi);  // ½ρW²c·CLα·cosφ/W, all blades
      kept.push({
        ...e, u, ...st, re: st.W * e.c / AIR.nu,
        thrustPerSlow: lift * Math.cos(st.phi), sidePerSlow: lift * Math.sin(st.phi), alphaPerSlow: Math.cos(st.phi) / st.W,
      });
    }
  }
  return { T, Q, power: omega * Q, flow, n, elements: kept };
}

// PITCH TRIM (as at the factory: the blade angle is set so that the fan gives exactly the wanted breeze).
// The pitch genes give the SHAPE of the twist; the whole pitch is multiplied by k so that the push at FAN.rpm is FAN.thrust.
// Without it every good fan sat on a knife edge: a little less push - the weak breeze penalty, a little more - louder,
// and one mutation could not move along the edge.
// Returns k in TRIM[0]..TRIM[1] (a fan that cannot reach the push at any k gets its strongest k and the weak breeze penalty).
const TRIM = [0.25, 4];
const trimCache = new WeakMap();
function pitchTrim(g) {
  const key = JSON.stringify(g);
  const hit = trimCache.get(g);
  if (hit && hit.key === key) return hit.k;
  const n = FAN.rpm / 60;
  const push = (k) => fanForces(trimFan(g, k), n, false).T;
  // The push is not monotonic in k: it grows, the blades stall, it falls - and far in the stall can creep back up.
  // So the SMALLEST k that gives the push is wanted (the branch without stall): step up on a log grid, then bisect (12 steps of ×1.26 from 0.25 to 4).
  const steps = 12, ratio = Math.pow(TRIM[1] / TRIM[0], 1 / steps);
  let k = TRIM[0], prev = TRIM[0], bestK = TRIM[0], bestT = -Infinity, found = false;
  for (let i = 0; i <= steps; i++, prev = k, k *= ratio) {
    const T = push(k);
    if (T > bestT) { bestT = T; bestK = k; }
    if (T >= FAN.thrust) { found = true; break; }
  }
  if (!found) k = bestK;                     // cannot reach the push: the strongest setting, the weak breeze penalty
  else if (k > TRIM[0]) {
    let lo = Math.log(prev), hi = Math.log(k);
    for (let i = 0; i < 12; i++) {           // the bracket is a step of 26%: 12 halvings leave 0.006%
      const mid = (lo + hi) / 2;
      if (push(Math.exp(mid)) < FAN.thrust) lo = mid; else hi = mid;
    }
    k = Math.exp(hi);                        // the upper end: never a hair below the wanted push
  }
  trimCache.set(g, { key, k });
  return k;
}

// The air: mean speed through the disc (m/s) and how fast the breeze reaches the person. A free round jet keeps its
// momentum flux - the push T: past its core (~6 jet diameters) the speed on its axis is u = 6.2·√(4T / πρ) / distance,
// whatever the diameter of the fan; closer, no more than the core speed 2·w. So the breeze at 2 m is set by the push:
// a small fan with the same push gives a narrower jet, not a stronger breeze.
function breezeAt(op, D, distance) {
  const area = Math.PI * (D / 2) ** 2 * (1 - FAN.hubRatio ** 2);
  const disc = op.flow / area;
  const far = 6.2 * Math.sqrt(4 * Math.max(0, op.T) / (Math.PI * AIR.rho)) / distance;
  return { disc, at: Math.min(2 * disc, far) };
}
