'use strict';
// AERODYNAMICS: the Double-Multiple Streamtube model (DMST, I. Paraschivoiu, 1981) - the classic quick model of a VAWT.
//
// Seen from above, the wind blows along +x, the rotor turns counter-clockwise. A blade at azimuth θ is at
// r·(cos θ, sin θ): θ = 180° is facing the wind, θ = 0° is behind the shaft.
//   1. The rotor is cut into horizontal SLICES; every slice works on its own.
//   2. The wind going through a slice is split into TUBES (strips along the wind). A tube crosses the blade
//      circle twice: on the upwind half and on the downwind half - two "actuator discs" one behind the other.
//   3. In every tube the blades slow the wind down: u = V·(1 − a). The induction a is found by iteration, so that
//      the force of the blades on the air (blade element: lift and drag) equals the loss of momentum of the air.
//   4. The downwind half gets the wind the upwind half left: Ve = V·(1 − 2a).
// Blade element at a point: the blade moves at ω·r, the air at u. Relative wind W: along the path ω·r + u·sin θ,
// across it u·cos θ. Its angle is the angle of attack α. Lift ⊥ W, drag ∥ W -> a driving (tangential) force
// that makes torque, and a force along the wind that slows the air.
//
// The result is a table: the torque coefficient Cq of the whole rotor over the tip speed ratio λ = ω·R/V
// (R - the box radius, the same for every rotor) and over the rotor angle ψ. From the table: power, self-start,
// torque ripple (fitness.js), the start from rest and the colours of the blades on screen (app.js, view3d.js).
//
// Not modelled: dynamic stall, blade tip losses, the wake of the shaft and of the struts, turbulence (see README).

const AIR = { rho: 1.225, nu: 1.5e-5 };
const AERO = {
  slices: 8,           // horizontal slices
  tubes: 18,           // tubes per half -> azimuth step 10°
  lambdaStep: 0.25,
  lambdaMax: 8,
  vRef: 6,             // m/s: the table is computed at this wind (it sets the Reynolds numbers)
  strutDrag: 0.05,     // drag coefficient of a streamlined strut
  minWake: 0.1,        // the wind behind the upwind half is not slower than this share of V
};
const AZIMUTHS = 2 * AERO.tubes;
const AZ_STEP = Math.PI / AERO.tubes;
const LAMBDAS = Array.from({ length: Math.round(AERO.lambdaMax / AERO.lambdaStep) + 1 }, (_, i) => i * AERO.lambdaStep);
// Torque is made dimensionless with the box: Q = Cq · ½ρ · A_box · R · V²; power coefficient Cp_box = λ · Cq.
const BOX_AREA = 2 * BOX.radius * BOX.height;
const TORQUE_UNIT = 0.5 * AIR.rho * BOX_AREA * BOX.radius;   // × V² -> N·m

// Azimuth of tube j (centre of its 10°), and the downwind partner of an upwind tube (same y: θ -> π − θ).
const tubeTheta = (j) => (j + 0.5) * AZ_STEP;
const partner = (j) => (AERO.tubes - 1 - j + AZIMUTHS) % AZIMUTHS;

// Thrust coefficient -> induction. Momentum theory (a < 0.4), then Buhl's empirical line for a heavily loaded disc
// (there momentum theory would give nonsense: wind going backwards).
function induction(ct) {
  if (ct <= 0.96) return (1 - Math.sqrt(1 - ct)) / 2;
  const a = (4 + Math.sqrt(Math.max(0, 16 - 56 * (8 - 9 * ct)))) / 28;
  return Math.min(0.95, a);
}

const foil = { cl: 0, cd: 0 }; // reused output of airfoil()
const element = { alpha: 0, ft: 0, fx: 0 };

// Blade element at azimuth theta, local wind u, blade speed wr. Forces per metre of height (N/m).
function bladeElement(u, theta, wr, slice, pitch, section) {
  const s = Math.sin(theta), c = Math.cos(theta);
  const wc = wr + u * s;                 // head wind along the blade's path
  const wn = u * c * slice.cosDelta;     // wind across the blade (a leaning blade sees less of it)
  const w2 = wc * wc + wn * wn;
  const w = Math.sqrt(w2) || 1e-9;
  let alpha = Math.atan2(wn, wc) + pitch;
  if (alpha > Math.PI) alpha -= 2 * Math.PI;
  if (alpha < -Math.PI) alpha += 2 * Math.PI;
  airfoil(alpha, section, foil);
  const q = 0.5 * AIR.rho * w2 * slice.c;
  const sinF = wn / w, cosF = wc / w;
  const fn = q * (foil.cl * cosF + foil.cd * sinF);                    // across the path (out of the circle)
  const ft = q * (foil.cl * sinF - foil.cd * cosF) / slice.cosDelta;   // along the path: it drives the rotor
  element.alpha = alpha;
  element.ft = ft;
  element.fx = fn * c - ft * s;                                        // along the wind: it slows the air
  return element;
}

// One tube on one half: the induction a such that blade force = momentum loss. Returns a.
function solveTube(vIn, j, wr, slice, blades, pitch, section) {
  const theta = tubeTheta(j);
  const cosT = Math.abs(Math.cos(theta));
  const k = blades / (4 * Math.PI * AIR.rho * slice.r * cosT * vIn * vIn); // a(1 − a) = k · Fx
  let a = 0;
  for (let it = 0; it < 40; it++) {
    const e = bladeElement(vIn * (1 - a), theta, wr, slice, pitch, section);
    const target = induction(4 * k * e.fx);
    const next = a + 0.5 * (Math.max(-0.5, target) - a);
    if (Math.abs(next - a) < 1e-4) { a = next; break; }
    a = next;
  }
  return a;
}

// One slice at one λ: for every azimuth j - the induction, the local wind, the angle of attack and the torque of
// one blade (N·m per this slice). Everything at the wind v.
function solveSlice(slice, g, lambda, v) {
  const omega = lambda * v / BOX.radius;
  const wr = omega * slice.r;
  const pitch = g.pitch * Math.PI / 180;
  // Reynolds number at the typical relative wind of this slice
  const section = airfoilSection(g.thickness, Math.max(3e4, Math.hypot(wr, v) * slice.c / AIR.nu));
  const out = {
    a: new Float64Array(AZIMUTHS), u: new Float64Array(AZIMUTHS),
    alpha: new Float64Array(AZIMUTHS), torque: new Float64Array(AZIMUTHS),
    stall: section.stall,
  };
  for (let j = 0; j < AZIMUTHS; j++) {
    if (Math.cos(tubeTheta(j)) >= 0) continue; // upwind half first
    const a = solveTube(v, j, wr, slice, g.blades, pitch, section);
    const ve = v * Math.max(AERO.minWake, 1 - 2 * a);
    const d = partner(j);
    const ad = solveTube(ve, d, wr, slice, g.blades, pitch, section);
    for (const [k, vin, ak] of [[j, v, a], [d, ve, ad]]) {
      const e = bladeElement(vin * (1 - ak), tubeTheta(k), wr, slice, pitch, section);
      out.a[k] = ak;
      out.u[k] = vin * (1 - ak);
      out.alpha[k] = e.alpha;
      out.torque[k] = e.ft * slice.r * slice.dz;
    }
  }
  return out;
}

// Periodic linear interpolation of an azimuth array at angle x (radians).
function atAzimuth(values, x) {
  let f = x / AZ_STEP - 0.5;
  f -= AZIMUTHS * Math.floor(f / AZIMUTHS);
  const i = Math.floor(f), t = f - i;
  return values[i] * (1 - t) + values[(i + 1) % AZIMUTHS] * t;
}

// Torque of the struts (drag of arms turning in air), N·m - always against the rotation.
function strutTorque(g, omega) {
  let q = 0;
  for (const r of strutRadii(g)) q += 0.5 * AIR.rho * AERO.strutDrag * STRUT_CHORD * omega * omega * r ** 4 / 4;
  return -g.blades * q;
}

// The whole table. cq[li][m]: rotor torque coefficient at LAMBDAS[li] and rotor angle ψ = tubeTheta(m)
// (the angle of blade 0 at mid-height). cqMean[li] - averaged over a turn. slices[li] - details for the screen.
function torqueTable(g, keepDetails) {
  const slices = rotorSlices(g, AERO.slices);
  const v = AERO.vRef;
  const unit = TORQUE_UNIT * v * v;
  const cq = [], cqMean = [], details = [];
  for (const lambda of LAMBDAS) {
    const solved = slices.map((s) => solveSlice(s, g, lambda, v));
    const struts = strutTorque(g, lambda * v / BOX.radius);
    const row = new Float64Array(AZIMUTHS);
    let mean = 0;
    for (let m = 0; m < AZIMUTHS; m++) {
      let q = struts;
      for (let k = 0; k < g.blades; k++) {
        const psi = tubeTheta(m) + 2 * Math.PI * k / g.blades;
        for (let s = 0; s < slices.length; s++) q += atAzimuth(solved[s].torque, psi + slices[s].phi);
      }
      row[m] = q / unit;
      mean += row[m] / AZIMUTHS;
    }
    cq.push(row);
    cqMean.push(mean);
    if (keepDetails) details.push(solved);
  }
  return { cq, cqMean, slices, details: keepDetails ? details : null };
}
