'use strict';
// PANEL METHOD (Hess & Smith, 1967): the ideal-fluid flow around the airfoil.
//
// The airfoil outline is cut into 120 straight panels. Each panel carries a SOURCE of its own strength σ_j
// (it pushes the air away), and all panels share one VORTEX strength γ (it makes the air circulate around
// the airfoil - that circulation is the lift). Unknowns: 120 sources + 1 vortex = 121.
// Conditions:
//   - on every panel the air does not go through the surface: normal velocity = 0
//     (or = the "blowing" of the boundary layer, see boundary.js);
//   - KUTTA condition: the air leaves the sharp tail smoothly, the speeds on both sides of the tail are equal.
//     Without it the vortex strength is arbitrary; this condition is what fixes the lift.
//
// Units: chord = 1, free-stream speed = 1. The free stream blows at angle α to the chord.
// Velocities from a unit source / vortex on a straight panel are exact formulas (log and atan2).

const TWO_PI = 2 * Math.PI;

// Velocity at (px, py) from a unit-strength source spread on panel j. Writes into out = [vx, vy].
function sourceVelocity(P, j, px, py, out) {
  const dx = px - P.x0[j], dy = py - P.y0[j];
  const xi = dx * P.tx[j] + dy * P.ty[j];         // along the panel
  const eta = dx * P.nx[j] + dy * P.ny[j];        // away from the panel (outward normal)
  const l = P.len[j];
  const r1 = xi * xi + eta * eta, r2 = (xi - l) * (xi - l) + eta * eta;
  const along = Math.log(r1 / r2) / (2 * TWO_PI);
  const across = (Math.atan2(eta, xi - l) - Math.atan2(eta, xi)) / TWO_PI;
  out[0] = along * P.tx[j] + across * P.nx[j];
  out[1] = along * P.ty[j] + across * P.ny[j];
}

// Geometry of the panels and the decomposed influence matrix. shape: { x, y } nodes from geometry.js.
function preparePanels(shape) {
  const n = shape.x.length - 1;
  const P = {
    n,
    x0: new Float64Array(n), y0: new Float64Array(n), len: new Float64Array(n),
    tx: new Float64Array(n), ty: new Float64Array(n), nx: new Float64Array(n), ny: new Float64Array(n),
    xm: new Float64Array(n), ym: new Float64Array(n),
  };
  for (let j = 0; j < n; j++) {
    const dx = shape.x[j + 1] - shape.x[j], dy = shape.y[j + 1] - shape.y[j];
    const l = Math.hypot(dx, dy);
    P.x0[j] = shape.x[j]; P.y0[j] = shape.y[j]; P.len[j] = l;
    P.tx[j] = dx / l; P.ty[j] = dy / l;
    P.nx[j] = -dy / l; P.ny[j] = dx / l;          // outward: the airfoil is on the right of the walking direction
    P.xm[j] = shape.x[j] + dx / 2; P.ym[j] = shape.y[j] + dy / 2;
  }
  // Influence of the sources on the normal (an) and tangential (at) velocity at every control point (panel middle);
  // bn, bt - the same for the shared vortex. A clockwise vortex = the source velocity turned by −90°: (vx, vy) -> (vy, −vx).
  const an = new Float64Array(n * n), at = new Float64Array(n * n);
  const bn = new Float64Array(n), bt = new Float64Array(n);
  const v = [0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) { v[0] = 0.5 * P.nx[j]; v[1] = 0.5 * P.ny[j]; }  // own panel, outer side: σ/2 straight out
      else sourceVelocity(P, j, P.xm[i], P.ym[i], v);
      an[i * n + j] = v[0] * P.nx[i] + v[1] * P.ny[i];
      at[i * n + j] = v[0] * P.tx[i] + v[1] * P.ty[i];
      bn[i] += v[1] * P.nx[i] - v[0] * P.ny[i];
      bt[i] += v[1] * P.tx[i] - v[0] * P.ty[i];
    }
  }
  const m = n + 1, a = new Float64Array(m * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) a[i * m + j] = an[i * n + j];
    a[i * m + n] = bn[i];
  }
  // Kutta: tangential speed on the first (lower) and the last (upper) panel cancel - they point opposite ways.
  for (let j = 0; j < n; j++) a[n * m + j] = at[j] + at[(n - 1) * n + j];
  a[n * m + n] = bt[0] + bt[n - 1];
  P.at = at; P.bt = bt;
  P.lu = a; P.piv = luDecompose(a, m);
  return P;
}

// Flow at angle α (radians). blowing[i] - normal velocity the boundary layer demands on panel i (or null).
// Returns { sigma, gamma, ue (signed speed along each panel, + = in the panel direction), cp }.
function solveFlow(P, alpha, blowing) {
  const n = P.n, ca = Math.cos(alpha), sa = Math.sin(alpha);
  const b = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) b[i] = (blowing ? blowing[i] : 0) - (ca * P.nx[i] + sa * P.ny[i]);
  b[n] = -(ca * (P.tx[0] + P.tx[n - 1]) + sa * (P.ty[0] + P.ty[n - 1]));
  const x = luSolve(P.lu, P.piv, n + 1, b);
  const gamma = x[n];
  const ue = new Float64Array(n), cp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let u = ca * P.tx[i] + sa * P.ty[i] + gamma * P.bt[i];
    for (let j = 0; j < n; j++) u += x[j] * P.at[i * n + j];
    ue[i] = u;
    cp[i] = 1 - u * u;                              // Bernoulli: faster air - lower pressure
  }
  return { sigma: x.subarray(0, n), gamma, ue, cp, alpha };
}

// Pressure forces: lift, pressure drag, moment about the quarter chord (positive = nose up).
function pressureForces(P, cp, alpha) {
  let fx = 0, fy = 0, m = 0;
  for (let i = 0; i < P.n; i++) {
    const px = -cp[i] * P.nx[i] * P.len[i], py = -cp[i] * P.ny[i] * P.len[i]; // pressure pushes into the surface
    fx += px; fy += py;
    m += P.ym[i] * px - (P.xm[i] - 0.25) * py;
  }
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  return { cl: fy * ca - fx * sa, cdp: fx * ca + fy * sa, cm: m };
}

// Velocity of the air at any point (for the smoke in the wind tunnel). Same sources and vortex as the solution.
function flowVelocity(P, sol, px, py, out) {
  let vx = Math.cos(sol.alpha), vy = Math.sin(sol.alpha);
  const v = [0, 0];
  for (let j = 0; j < P.n; j++) {
    sourceVelocity(P, j, px, py, v);
    vx += sol.sigma[j] * v[0] + sol.gamma * v[1];
    vy += sol.sigma[j] * v[1] - sol.gamma * v[0];
  }
  out[0] = vx; out[1] = vy;
  return out;
}
