'use strict';
// BOUNDARY LAYER: the thin layer of air near the surface that is slowed down by friction.
// The ideal flow (panel.js) has no friction and no drag at all; all the drag of a good airfoil lives here.
//
// The layer starts at the STAGNATION POINT near the nose (where the air splits: some goes over, some under)
// and grows along each surface to the tail. It is described by two numbers at every point:
//   θ  - momentum thickness: how much momentum the slowed air has lost (it becomes drag at the tail);
//   H  - shape factor = δ*/θ (δ* - displacement thickness): how "tired" the layer is. A healthy laminar layer has
//        H ≈ 2.6, a turbulent one H ≈ 1.4; when a turbulent H grows to ~2.4 the layer SEPARATES from the surface (stall).
//
// Three classic engineering methods, one after another along the surface:
//   1. LAMINAR - Thwaites (1949): θ² = 0.45 ν / ue⁶ · ∫ ue⁵ ds; λ = θ²/ν · due/ds gives H and friction.
//   2. TRANSITION - Michel (1951): the layer turns turbulent when Re_θ exceeds a limit that depends on Re_x.
//      If the laminar layer separates first (λ < −0.09), it turns turbulent there (a short "laminar bubble").
//   3. TURBULENT - Head (1958): entrainment method, two equations for θ and H; separation at H > 2.4.
// Drag: Squire & Young (1938) from θ and H at the tail. Friction share: ∫ cf ue² ds.
//
// Units: chord = 1, free-stream speed = 1, so the viscosity is 1/Re.

const BL = {
  thwaites: 0.45,
  bubbleLambda: -0.09,       // laminar separation (Thwaites λ) -> transition
  turbulentH: 1.4,           // H of a fresh turbulent layer
  separationH: 2.4,          // turbulent separation
  substeps: 2,               // Runge-Kutta steps between two control points
};

// ---- Correlations ----

// Thwaites: shape factor H and friction l = cf·Re_θ/2 from λ (Cebeci & Bradshaw fits).
function thwaitesH(lambda) {
  const l = Math.max(-0.1, Math.min(0.1, lambda));
  return l >= 0 ? 2.61 - 3.75 * l + 5.24 * l * l : 2.088 + 0.0731 / (l + 0.14);
}
function thwaitesL(lambda) {
  const l = Math.max(-0.1, Math.min(0.1, lambda));
  return l >= 0 ? 0.22 + 1.57 * l - 1.8 * l * l : 0.22 + 1.402 * l + 0.018 * l / (l + 0.107);
}

// Head: H1 = (δ − δ*)/θ - how much outer air the layer swallows.
function headH1(h) {
  return h <= 1.6 ? 3.3 + 0.8234 * (h - 1.1) ** -1.287 : 3.3 + 1.5501 * (h - 0.6778) ** -3.064;
}
function headH(h1) {
  if (h1 <= 3.32) return 3;                     // the layer has no entrainment left: separated
  return h1 < 5.3 ? 0.6778 + 1.1538 * (h1 - 3.3) ** -0.326 : 1.1 + 0.86 * (h1 - 3.3) ** -0.777;
}
// Ludwieg & Tillmann turbulent skin friction.
function turbulentCf(h, reTheta) {
  return 0.246 * 10 ** (-0.678 * h) * Math.max(reTheta, 50) ** -0.268;
}

// Michel's transition criterion.
function michelLimit(reX) {
  return 1.174 * (1 + 22400 / reX) * reX ** 0.46;
}

// ---- Surfaces ----

// Splits the panels at the stagnation point. ue: signed speeds from solveFlow (lower surface negative: the air
// goes against the panel order there). Returns two sides, each from the stagnation point to the tail.
function splitAtStagnation(P, ue) {
  let k = -1;
  for (let i = 0; i < P.n - 1; i++) {
    if (ue[i] < 0 && ue[i + 1] >= 0 && (k < 0 || P.xm[i] < P.xm[k])) k = i;
  }
  if (k < 0) return null;
  const f = -ue[k] / (ue[k + 1] - ue[k]);       // where between the two control points the speed is zero
  const d = Math.hypot(P.xm[k + 1] - P.xm[k], P.ym[k + 1] - P.ym[k]);
  const side = (from, to, step, s0, sign) => {
    const idx = [], s = [], u = [];
    let dist = s0;
    for (let i = from; i !== to; i += step) {
      if (idx.length) dist += Math.hypot(P.xm[i] - P.xm[i - step], P.ym[i] - P.ym[i - step]);
      idx.push(i); s.push(dist); u.push(Math.max(1e-6, sign * ue[i]));
    }
    return { idx, s, u };
  };
  return {
    upper: side(k + 1, P.n, 1, (1 - f) * d, 1),
    lower: side(k, -1, -1, f * d, -1),
  };
}

// The layer along one side. Returns arrays per point plus transition / separation positions (x of the chord).
function marchSide(P, side, re) {
  const { idx, s, u } = side, m = idx.length;
  const theta = new Float64Array(m), H = new Float64Array(m), cf = new Float64Array(m);
  const turbulent = new Uint8Array(m);
  const dudx = (k) => {
    if (k === 0) return u[0] / s[0];
    if (k === m - 1) return (u[k] - u[k - 1]) / (s[k] - s[k - 1]);
    return (u[k + 1] - u[k - 1]) / (s[k + 1] - s[k - 1]);
  };
  let transitionX = null, separationX = null, bubble = false;

  // 1. Laminar: Thwaites' integral, trapezoids; the first piece from the stagnation point has ue growing linearly from 0.
  let integral = 0, k = 0;
  for (; k < m; k++) {
    integral += k === 0 ? u[0] ** 5 * s[0] / 6 : (s[k] - s[k - 1]) * (u[k] ** 5 + u[k - 1] ** 5) / 2;
    const t2 = BL.thwaites * integral / (re * u[k] ** 6);
    const lambda = t2 * re * dudx(k);
    theta[k] = Math.sqrt(t2);
    H[k] = thwaitesH(lambda);
    const reTheta = re * u[k] * theta[k];
    cf[k] = 2 * thwaitesL(lambda) / reTheta;
    if (lambda < BL.bubbleLambda) { bubble = true; break; }
    if (reTheta > michelLimit(Math.max(1, re * u[k] * s[k]))) break;
  }
  if (k < m) transitionX = P.xm[idx[k]];

  // 2. Turbulent: Head's equations from the transition point, Runge-Kutta 2 between control points.
  if (k < m) {
    let th = theta[k], h = BL.turbulentH, y = u[k] * th * headH1(h), separated = false;
    H[k] = h; turbulent[k] = 1; cf[k] = turbulentCf(h, re * u[k] * th);
    const rhs = (t, yy, ue, due) => {
      if (separated) return [-(BL.separationH + 2) * t / ue * due, 0];
      const h1 = yy / (ue * t), hh = headH(h1);
      const c = turbulentCf(hh, re * ue * t);
      return [c / 2 - (hh + 2) * t / ue * due, ue * 0.0306 * Math.max(h1 - 3, 1e-3) ** -0.6169];
    };
    for (let j = k + 1; j < m; j++) {
      const ds = (s[j] - s[j - 1]) / BL.substeps, due = (u[j] - u[j - 1]) / (s[j] - s[j - 1]);
      for (let q = 0; q < BL.substeps; q++) {
        const ua = u[j - 1] + due * ds * q, ub = ua + due * ds;
        const a = rhs(th, y, ua, due);
        const b = rhs(th + ds * a[0], y + ds * a[1], ub, due);
        th = Math.max(1e-7, th + ds * (a[0] + b[0]) / 2);
        y = y + ds * (a[1] + b[1]) / 2;
        if (!separated && headH(y / (ub * th)) >= BL.separationH) {
          separated = true;
          separationX = P.xm[idx[j]];
        }
      }
      if (!separated) y = Math.max(y, u[j] * th * 3.33);   // keep H1 in the range of the correlation
      h = separated ? BL.separationH : headH(y / (u[j] * th));
      theta[j] = th; H[j] = h; turbulent[j] = 1;
      cf[j] = separated ? 0 : turbulentCf(h, re * u[j] * th);
    }
  }

  // Squire-Young: the momentum the layer lost by the tail, carried far downstream.
  const last = m - 1;
  const cd = 2 * theta[last] * u[last] ** ((Math.min(H[last], 2.5) + 5) / 2);
  let cdf = 0;
  for (let j = 1; j < m; j++) cdf += (s[j] - s[j - 1]) * (cf[j] * u[j] ** 2 + cf[j - 1] * u[j - 1] ** 2) / 2;
  cdf += s[0] * cf[0] * u[0] ** 2 / 2;
  return { idx, s, u, theta, H, cf, turbulent, transitionX, separationX, bubble, cd, cdf };
}

// The whole boundary layer. Also the "blowing": the slowed air pushes the outer flow away from the surface
// by d(ue·δ*)/ds - this is how the layer acts back on the ideal flow (fed to solveFlow on the next pass).
function boundaryLayer(P, ue, re) {
  const sides = splitAtStagnation(P, ue);
  if (!sides || sides.upper.idx.length < 3 || sides.lower.idx.length < 3) return null;
  const upper = marchSide(P, sides.upper, re), lower = marchSide(P, sides.lower, re);
  const blowing = new Float64Array(P.n), dstar = new Float64Array(P.n);
  for (const side of [upper, lower]) {
    let prevM = 0, prevS = 0;
    for (let j = 0; j < side.idx.length; j++) {
      const ds = side.theta[j] * side.H[j], mass = side.u[j] * ds;
      dstar[side.idx[j]] = ds;
      blowing[side.idx[j]] = (mass - prevM) / Math.max(1e-6, side.s[j] - prevS);
      prevM = mass; prevS = side.s[j];
    }
  }
  return { upper, lower, blowing, dstar, cd: upper.cd + lower.cd, cdf: upper.cdf + lower.cdf };
}
