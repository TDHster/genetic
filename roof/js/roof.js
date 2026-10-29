'use strict';
// THE ROOF: what evolves and what a genome turns into.
//
// We look at a cross-section of one half of a symmetric roof: from the ridge (x = 0, y = H)
// down to the eave (x = W, y = 0). The other half is a mirror copy.
// The roof is a broken line of N pieces of equal width W / N.
// GENOME = the heights of the N - 1 break points between the ridge and the eave.
// The ridge and the eave are fixed: they are the task, not the answer.
//
// Any genome is a valid roof: zigzags, pits and humps are allowed. Whether water
// gets off such a roof (and how fast) is decided in fitness.js.

const G = 9.81; // m/s²

// The task, shared by the genome, the fitness and the drawing. Changed with setTask() (fitness.js).
//   width    - W, horizontal distance from the ridge to the eave, m
//   height   - H, how much higher the ridge is than the eave, m
//   segments - N, pieces in the broken line (the genome has N - 1 numbers)
//   rain     - false: one drop from the ridge; true: drops start everywhere on the roof
//   floor    - true: no point of the roof may go below the eave
const TASK = { width: 4, height: 3, segments: 16, rain: false, floor: false };

// Allowed heights of a break point. Higher than the ridge makes no sense: a drop from the ridge
// can never climb there. Below the eave only when the floor rule is off (down to -H).
function lowY() { return TASK.floor ? 0 : -TASK.height; }
function highY() { return TASK.height; }
function clampY(y) { return Math.min(highY(), Math.max(lowY(), y)); }

// Genome -> list of points from the ridge to the eave.
function roofPoints(genome) {
  const n = TASK.segments, w = TASK.width;
  const pts = [{ x: 0, y: TASK.height }];
  genome.ys.forEach((y, k) => pts.push({ x: (k + 1) * w / n, y }));
  pts.push({ x: w, y: 0 });
  return pts;
}

// The starting pool: every break point at a random height. Mostly ugly zigzags.
function randomRoof(rng) {
  const ys = [];
  for (let k = 0; k < TASK.segments - 1; k++) ys.push(lowY() + rng.next() * (highY() - lowY()));
  return { ys };
}

function copyRoof(genome) {
  return { ys: genome.ys.slice() };
}

// CROSSOVER: one cut. The upper part of the roof (near the ridge) comes from mom, the lower part from dad.
function crossover(mom, dad, rng) {
  const cut = rng.intRange(0, mom.ys.length);
  return { ys: mom.ys.slice(0, cut).concat(dad.ys.slice(cut)) };
}

// MUTATION: one random change, returns its description for the log.
//   50% - move one point up or down: a small step mostly (0.1% .. 10% of the allowed range);
//   25% - a "bump": move a whole neighbourhood smoothly (the further from the centre, the less);
//   15% - smooth: put a point exactly between its neighbours;
//   10% - a brand new random height for one point.
function mutate(genome, rng) {
  const ys = genome.ys, n = ys.length;
  const i = rng.int(n);
  const span = highY() - lowY();
  const at = (k) => (k < 0 ? TASK.height : k >= n ? 0 : ys[k]); // neighbours of the end points are the ridge and the eave
  const cm = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} см`;
  const r = rng.next();
  if (r < 0.5) {
    const d = rng.normal() * rng.logUniform(0.001, 0.1) * span;
    ys[i] = clampY(ys[i] + d);
    return `точка ${i + 1}: сдвиг ${cm(d)}`;
  }
  if (r < 0.75) {
    const width = rng.logUniform(0.5, Math.max(1, n / 3));
    const d = rng.normal() * rng.logUniform(0.001, 0.1) * span;
    for (let k = 0; k < n; k++) ys[k] = clampY(ys[k] + d * Math.exp(-(((k - i) / width) ** 2)));
    return `горб вокруг точки ${i + 1}: ${cm(d)}, ширина ±${width.toFixed(1)} точки`;
  }
  if (r < 0.9) {
    ys[i] = clampY((at(i - 1) + at(i + 1)) / 2);
    return `точка ${i + 1}: посередине между соседями`;
  }
  ys[i] = lowY() + rng.next() * span;
  return `точка ${i + 1}: новая случайная высота ${(ys[i] * 100).toFixed(0)} см`;
}

// ---- Reference roofs (not evolved; for comparison) ----
// Each is sampled at m + 1 points with the same equal-width step in x as the genome,
// m = N * k, so the break points of the genome are also points of the reference.

// 1. A plain straight slope.
function linePoints(m) {
  const pts = [];
  for (let k = 0; k <= m; k++) pts.push({ x: TASK.width * k / m, y: TASK.height * (1 - k / m) });
  return pts;
}

// 2. Galileo's arc. In 1638 Galileo showed that a circular arc is faster than the chord and
//    guessed (wrongly) that it is the fastest curve. Here: the circle through the ridge and the eave
//    whose centre is right above the eave, so the arc meets the eave horizontally.
function arcPoints(m) {
  const w = TASK.width, h = TASK.height;
  const r = (w * w + h * h) / (2 * h);
  const pts = [];
  for (let k = 0; k <= m; k++) {
    const x = w * k / m;
    pts.push({ x, y: r - Math.sqrt(Math.max(0, r * r - (w - x) ** 2)) });
  }
  return pts;
}

// 3. The cycloid: the curve drawn by a point on the rim of a wheel rolling under a ceiling.
//    Johann Bernoulli (1696) proved it is the BRACHISTOCHRONE - the curve of fastest descent.
//    x = R (t - sin t), y = H - R (1 - cos t), t from 0 to T. T and R are chosen so that
//    the curve ends at the eave: (T - sin T) / (1 - cos T) = W / H.
//    If W / H > π/2, the cycloid goes below the eave and climbs back up to it (T > π).
//    With the floor rule it cannot: then the fastest roof is half a cycloid that touches
//    the eave level at its bottom (2R = H) and a flat piece after it.
function cycloidShape() {
  const w = TASK.width, h = TASK.height;
  const f = (t) => (t - Math.sin(t)) / (1 - Math.cos(t));
  let lo = 1e-9, hi = 2 * Math.PI - 1e-9; // f grows from 0 to infinity on (0, 2π)
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < w / h) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  if (TASK.floor && t > Math.PI) {
    const r = h / 2;
    return { r, tEnd: Math.PI, flat: w - Math.PI * r, dips: true, depth: 0,
      exactTime: Math.PI * Math.sqrt(r / G) + (w - Math.PI * r) / Math.sqrt(2 * G * h) };
  }
  const r = h / (1 - Math.cos(t));
  return { r, tEnd: t, flat: 0, dips: t > Math.PI, depth: Math.max(0, 2 * r - h),
    exactTime: t * Math.sqrt(r / G) };
}

function cycloidPoints(m) {
  const c = cycloidShape();
  const pts = [];
  for (let k = 0; k <= m; k++) {
    const x = TASK.width * k / m;
    if (x >= c.r * (c.tEnd - Math.sin(c.tEnd))) { pts.push({ x, y: TASK.height - c.r * (1 - Math.cos(c.tEnd)) }); continue; }
    // Find t with R (t - sin t) = x: x(t) grows, so bisection works.
    let lo = 0, hi = c.tEnd;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (c.r * (mid - Math.sin(mid)) < x) lo = mid; else hi = mid;
    }
    const t = (lo + hi) / 2;
    pts.push({ x, y: TASK.height - c.r * (1 - Math.cos(t)) });
  }
  pts[m].y = 0; // exactly at the eave despite rounding
  return pts;
}
