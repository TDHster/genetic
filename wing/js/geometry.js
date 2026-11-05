'use strict';
// AIRFOIL GEOMETRY: the genome, how it becomes a shape, the classic NACA airfoils.
//
// GENOME = CST parameterisation (Kulfan, 2008): 6 numbers per surface.
//   y(x) = C(x) · S(x)
//   C(x) = √x · (1 − x)            "class function": a round nose (√x) and a sharp tail (1 − x)
//   S(x) = Σ A_i · B_i(x)          a sum of 6 smooth bumps (Bernstein polynomials of degree 5)
// Upper surface: weights u[0..5] (positive = above the chord), lower: l[0..5] (negative = below).
// Any weights give a smooth airfoil; u[0] and l[0] set the nose radius (R = A0²/2), the last weights the tail angle.
// The chord is 1: x from 0 (nose) to 1 (tail).

const CST_ORDER = 5;             // degree of the Bernstein polynomials -> 6 weights per surface
const SIDE_POINTS = 61;          // points per surface from nose to tail (cosine spacing) -> 120 panels
const WEIGHTS = {
  u: [-0.15, 0.7],               // limits of the upper weights
  l: [-0.7, 0.3],                // limits of the lower weights
  nose: 0.05,                    // |u[0]|, |l[0]| at least this: a round nose, not a knife
};

const BINOM = (() => {
  const row = [1];
  for (let k = 1; k <= CST_ORDER; k++) row.push(row[k - 1] * (CST_ORDER - k + 1) / k);
  return row;
})();

// Cosine spacing: points crowd at the nose and the tail, where the flow changes fastest.
const STATIONS = Array.from({ length: SIDE_POINTS }, (_, k) => (1 - Math.cos(Math.PI * k / (SIDE_POINTS - 1))) / 2);

function bernstein(i, x) {
  return BINOM[i] * x ** i * (1 - x) ** (CST_ORDER - i);
}

function classFunction(x) {
  return Math.sqrt(x) * (1 - x);
}

// y of one surface at x from its weights.
function cstY(w, x) {
  let s = 0;
  for (let i = 0; i <= CST_ORDER; i++) s += w[i] * bernstein(i, x);
  return classFunction(x) * s;
}

// ---- Shape for the solver ----

// Nodes in panel order: from the tail along the LOWER surface to the nose, then along the UPPER surface back to the tail.
// The first and the last node are the same point (sharp tail). Walking this way the airfoil is on the right.
// upper/lower: [[x, y], ...] from the nose to the tail (for drawing).
function shapeFromSides(upper, lower) {
  const x = [], y = [];
  for (let k = lower.length - 1; k >= 0; k--) { x.push(lower[k][0]); y.push(lower[k][1]); }
  for (let k = 1; k < upper.length; k++) { x.push(upper[k][0]); y.push(upper[k][1]); }
  return { x: Float64Array.from(x), y: Float64Array.from(y), upper, lower };
}

function airfoilShape(g) {
  const upper = STATIONS.map((x) => [x, cstY(g.u, x)]);
  const lower = STATIONS.map((x) => [x, cstY(g.l, x)]);
  return shapeFromSides(upper, lower);
}

// Thickness and camber of a CST genome (both surfaces at the same x, so it is exact).
function measureAirfoil(g) {
  let t = 0, tAt = 0, camber = 0, camberAt = 0, area = 0, valid = true;
  for (let k = 1; k < SIDE_POINTS - 1; k++) {
    const x = STATIONS[k], yu = cstY(g.u, x), yl = cstY(g.l, x);
    const th = yu - yl, c = (yu + yl) / 2;
    if (th <= 1e-5) valid = false;              // the surfaces cross: not an airfoil
    if (th > t) { t = th; tAt = x; }
    if (Math.abs(c) > Math.abs(camber)) { camber = c; camberAt = x; }
    area += th * (STATIONS[k + 1] - STATIONS[k - 1]) / 2;
  }
  // thickness at 80 % of the chord - the rear spar and the aileron live there
  const tRear = cstY(g.u, 0.8) - cstY(g.l, 0.8);
  return { valid, t, tAt, camber, camberAt, area, tRear, noseRadius: (g.u[0] ** 2 + g.l[0] ** 2) / 4 };
}

// ---- NACA 4-digit airfoils (reference designs) ----

// NACA MPTT: M - max camber (% chord), P - its position (tenths), TT - thickness (%). Closed (sharp) tail.
function nacaSides(code) {
  const m = Number(code[0]) / 100, p = Number(code[1]) / 10, t = Number(code.slice(2)) / 100;
  const upper = [], lower = [];
  for (const x of STATIONS) {
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    let yc = 0, dyc = 0;
    if (m > 0) {
      if (x < p) { yc = m / (p * p) * (2 * p * x - x * x); dyc = 2 * m / (p * p) * (p - x); }
      else { yc = m / ((1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x); dyc = 2 * m / ((1 - p) ** 2) * (p - x); }
    }
    const th = Math.atan(dyc);
    upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  return { upper, lower };
}

// Least-squares CST weights for one surface: minimise Σ (y − C(x)·Σ A_i B_i(x))². It is linear in A, so 6 equations.
function fitSide(points) {
  const n = CST_ORDER + 1;
  const rows = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const [x, y] of points) {
    if (x <= 0 || x >= 1) continue;
    const c = classFunction(x);
    const basis = [];
    for (let i = 0; i < n; i++) basis.push(c * bernstein(i, x));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) rows[i][j] += basis[i] * basis[j];
      rows[i][n] += basis[i] * y;
    }
  }
  return solveDense(rows);
}

// A NACA airfoil as a CST genome. The fit is within ~0.002 chord (the NACA camber line has a kink in curvature
// at the max camber point, CST is smoother there).
function nacaGenome(code) {
  const { upper, lower } = nacaSides(code);
  return { u: fitSide(upper), l: fitSide(lower) };
}

// ---- Evolution operators ----

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fixWeights(g) {
  for (let i = 0; i <= CST_ORDER; i++) {
    g.u[i] = clamp(g.u[i], WEIGHTS.u[0], WEIGHTS.u[1]);
    g.l[i] = clamp(g.l[i], WEIGHTS.l[0], WEIGHTS.l[1]);
  }
  g.u[0] = Math.max(WEIGHTS.nose, g.u[0]);
  g.l[0] = Math.min(-WEIGHTS.nose, g.l[0]);
  return g;
}

function copyAirfoil(g) {
  return { u: g.u.slice(), l: g.l.slice() };
}

// A random CRUDE body for the first pool: thick, lumpy and exactly SYMMETRIC (the lower surface mirrors the upper one),
// so there is no camber at all. Nothing of a good airfoil is put in by hand: the camber, the thin tail, the flat laminar
// lower surface must be invented by mutations. (With independent random surfaces chance alone gives camber,
// and the first pool already beats the reference.)
function randomAirfoil(rng) {
  for (;;) {
    const thick = 0.15 + 0.15 * rng.next();
    const g = { u: [], l: [] };
    for (let i = 0; i <= CST_ORDER; i++) {
      const w = thick + 0.12 * rng.normal();
      g.u.push(w);
      g.l.push(-w);
    }
    fixWeights(g);
    if (measureAirfoil(g).valid) return g;
  }
}

// Uniform crossover: every bump comes from one parent, the upper and the lower weight of a bump together
// (they make the local thickness and camber; mixing them separately would break both).
function crossover(mom, dad, rng) {
  const child = { u: [], l: [] };
  for (let i = 0; i <= CST_ORDER; i++) {
    const from = rng.chance(0.5) ? mom : dad;
    child.u.push(from.u[i]);
    child.l.push(from.l[i]);
  }
  return child;
}

// One mutation, changes the genome in place. Returns a description for the step log.
//   bump      - one weight of one surface (a local dent or bulge);
//   thickness - the whole airfoil thicker or thinner (upper up, lower down);
//   camber    - the whole airfoil bent up or down (both surfaces the same way).
// Step sizes are spread on a log scale: big jumps early, fine tuning late.
function mutate(g, rng) {
  const step = rng.logUniform(0.002, 0.08) * (rng.chance(0.5) ? 1 : -1);
  const r = rng.next();
  let text;
  if (r < 0.6) {
    const side = rng.chance(0.5) ? 'u' : 'l', i = rng.int(CST_ORDER + 1);
    g[side][i] += step;
    text = `${side === 'u' ? 'верх' : 'низ'}, бугор ${i + 1}: ${step > 0 ? '+' : ''}${step.toFixed(3)}`;
  } else if (r < 0.8) {
    for (let i = 0; i <= CST_ORDER; i++) { g.u[i] += step / 2; g.l[i] -= step / 2; }
    text = `${step > 0 ? 'толще' : 'тоньше'} на ${Math.abs(step).toFixed(3)}`;
  } else {
    for (let i = 0; i <= CST_ORDER; i++) { g.u[i] += step / 2; g.l[i] += step / 2; }
    text = `кривизна ${step > 0 ? 'больше' : 'меньше'} на ${Math.abs(step / 2).toFixed(3)}`;
  }
  fixWeights(g);
  return text;
}
