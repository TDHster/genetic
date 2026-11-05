'use strict';
// AIRFOIL GEOMETRY: the genome, how it becomes a shape, the classic NACA airfoils.
//
// GENOME = CST parameterisation (Kulfan, 2008): 6 numbers per surface + 2 exponents of the "class function".
//   y(x) = C(x) · S(x)
//   C(x) = x^n1 · (1 − x)^n2        "class function": the overall type of the body
//   S(x) = Σ A_i · B_i(x)          a sum of 6 smooth bumps (Bernstein polynomials of degree 5)
// Upper surface: weights u[0..5] (positive = above the chord), lower: l[0..5] (negative = below).
// The exponents n1 (nose) and n2 (tail) are shared by both surfaces:
//   n1 = n2 = 0.5  - a circle / an ellipse (all weights equal);
//   n1 = n2 ≈ 0    - a brick (flat front and back);
//   n1 = 0.5, n2 = 1 - an airfoil: a round nose and a sharp tail (all classic airfoils).
// The evolution can start from a circle or a brick and has to find n1 = 0.5, n2 = 1 itself.
// The chord is 1: x from 0 (nose) to 1 (tail).

const CST_ORDER = 5;             // degree of the Bernstein polynomials -> 6 weights per surface
const SIDE_POINTS = 61;          // points per surface from nose to tail (cosine spacing) -> 120 panels
const WEIGHTS = {
  u: [-0.15, 1],                 // limits of the upper weights (1 with n1 = n2 = 0.5 is a circle)
  l: [-1, 0.3],                  // limits of the lower weights
  nose: 0.05,                    // |u[0]|, |l[0]| at least this: a round nose, not a knife
  n1: [0.05, 0.6],               // nose exponent: from a flat front to a round nose (a sharper, wedge nose would
                                 // stall by its leading-edge bubble, which this model does not see - a loophole)
  n2: [0.05, 1.5],               // tail exponent: from a flat back to a thin cusp
};
const AIRFOIL_CLASS = { n1: 0.5, n2: 1 };   // the classic airfoil class (NACA genomes, old saved genomes)

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

// g - the genome (only its exponents are used); without them - the airfoil class.
function classFunction(x, g) {
  const n1 = g && g.n1 !== undefined ? g.n1 : AIRFOIL_CLASS.n1;
  const n2 = g && g.n2 !== undefined ? g.n2 : AIRFOIL_CLASS.n2;
  return x ** n1 * (1 - x) ** n2;
}

// y of one surface at x from its weights (w = g.u or g.l).
function cstY(w, x, g) {
  let s = 0;
  for (let i = 0; i <= CST_ORDER; i++) s += w[i] * bernstein(i, x);
  return classFunction(x, g) * s;
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

// A dense set of x for measuring a surface: cosine spacing plus points ever closer to the ends (10⁻³ … 10⁻¹²),
// where a blunt body (a brick, a circle) turns its flat front or back face.
const DENSE_X = (() => {
  const xs = [];
  for (let k = 0; k <= 600; k++) xs.push((1 - Math.cos(Math.PI * k / 600)) / 2);
  for (let p = 3; p <= 12; p += 0.25) xs.push(10 ** -p, 1 - 10 ** -p);
  return xs.sort((a, b) => a - b);
})();

// SIDE_POINTS points of one surface spread along its LENGTH (cosine spacing in arc length: dense at the nose and the tail).
// Spacing by x would put a single panel on the flat back face of a brick, and the boundary layer would not "see" its corners.
// For a normal airfoil the arc length is almost x, and the points are almost STATIONS.
function sidePoints(w, g) {
  const dense = DENSE_X.map((x) => [x, cstY(w, x, g)]);
  const s = [0];
  for (let k = 1; k < dense.length; k++) s.push(s[k - 1] + Math.hypot(dense[k][0] - dense[k - 1][0], dense[k][1] - dense[k - 1][1]));
  const total = s[s.length - 1], out = [];
  let j = 1;
  for (const f of STATIONS) {
    const target = f * total;
    while (j < dense.length - 1 && s[j] < target) j++;
    const t = s[j] > s[j - 1] ? (target - s[j - 1]) / (s[j] - s[j - 1]) : 0;
    out.push([dense[j - 1][0] + t * (dense[j][0] - dense[j - 1][0]), dense[j - 1][1] + t * (dense[j][1] - dense[j - 1][1])]);
  }
  out[0] = dense[0];
  out[out.length - 1] = dense[dense.length - 1];
  return out;
}

function airfoilShape(g) {
  return shapeFromSides(sidePoints(g.u, g), sidePoints(g.l, g));
}

// Thickness and camber of a CST genome (both surfaces at the same x, so it is exact).
function measureAirfoil(g) {
  let t = 0, tAt = 0, camber = 0, camberAt = 0, area = 0, valid = true;
  for (let k = 1; k < SIDE_POINTS - 1; k++) {
    const x = STATIONS[k], yu = cstY(g.u, x, g), yl = cstY(g.l, x, g);
    const th = yu - yl, c = (yu + yl) / 2;
    if (th <= 1e-5) valid = false;              // the surfaces cross: not an airfoil
    if (th > t) { t = th; tAt = x; }
    if (Math.abs(c) > Math.abs(camber)) { camber = c; camberAt = x; }
    area += th * (STATIONS[k + 1] - STATIONS[k - 1]) / 2;
  }
  // thickness at 80 % of the chord - the rear spar and the aileron live there
  const tRear = cstY(g.u, 0.8, g) - cstY(g.l, 0.8, g);
  // R = A0²/2 holds for the airfoil class (n1 = 0.5) only; a flat front (n1 < 0.5) has a sharp corner instead
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
  return { u: fitSide(upper), l: fitSide(lower), ...AIRFOIL_CLASS };
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
  g.n1 = clamp(g.n1 !== undefined ? g.n1 : AIRFOIL_CLASS.n1, WEIGHTS.n1[0], WEIGHTS.n1[1]);
  g.n2 = clamp(g.n2 !== undefined ? g.n2 : AIRFOIL_CLASS.n2, WEIGHTS.n2[0], WEIGHTS.n2[1]);
  return g;
}

function copyAirfoil(g) {
  return { u: g.u.slice(), l: g.l.slice(), n1: g.n1, n2: g.n2 };
}

// The first pool. Nothing of a good airfoil is put in by hand: the camber, the round nose with the sharp tail,
// the flat laminar lower surface must be invented by mutations. All starts are exactly SYMMETRIC (the lower surface
// mirrors the upper one): with independent random surfaces chance alone gives camber, and the first pool already
// beats the reference.
//   circle - a circle of diameter = chord (n1 = n2 = 0.5, all weights 1) with small dents;
//   brick  - a flat-ended block 25-35 % thick (n1 = n2 ≈ 0.05);
//   lumps  - thick lumpy bodies of the airfoil class (round nose, sharp tail).
const START_SHAPES = ['circle', 'brick', 'lumps'];

function randomAirfoil(rng, start = 'circle') {
  for (;;) {
    let thick, noise, n1, n2;
    if (start === 'brick') {
      thick = 0.13 + 0.04 * rng.next(); noise = 0.01; n1 = n2 = WEIGHTS.n1[0];
    } else if (start === 'lumps') {
      thick = 0.15 + 0.15 * rng.next(); noise = 0.12; n1 = AIRFOIL_CLASS.n1; n2 = AIRFOIL_CLASS.n2;
    } else {
      thick = 1; noise = 0.03; n1 = n2 = 0.5;
    }
    const g = { u: [], l: [], n1, n2 };
    for (let i = 0; i <= CST_ORDER; i++) {
      const w = thick + noise * rng.normal();
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
  const from = rng.chance(0.5) ? mom : dad;    // the body class (nose and tail exponents) - from one parent
  child.n1 = from.n1;
  child.n2 = from.n2;
  return child;
}

// One mutation, changes the genome in place. Returns a description for the step log.
//   bump      - one weight of one surface (a local dent or bulge);
//   thickness - the whole airfoil thicker or thinner (upper up, lower down);
//   camber    - the whole airfoil bent up or down (both surfaces the same way);
//   nose/tail - the exponent n1 or n2: the front or the back becomes blunter or sharper.
// Step sizes are spread on a log scale: big jumps early, fine tuning late.
function mutate(g, rng) {
  const step = rng.logUniform(0.002, 0.08) * (rng.chance(0.5) ? 1 : -1);
  const r = rng.next();
  let text;
  if (r < 0.15) {
    const key = rng.chance(0.5) ? 'n1' : 'n2';
    const d = 2.5 * step;                      // exponents live on a wider scale than the weights
    g[key] += d;
    text = `${key === 'n1' ? 'носок' : 'хвост'} ${d > 0 ? 'острее' : 'тупее'}: ${key} ${d > 0 ? '+' : ''}${d.toFixed(3)}`;
  } else if (r < 0.6) {
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
