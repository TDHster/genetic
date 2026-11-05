'use strict';
// SCORE of an airfoil. The task: a wing for a glider / small drone at Reynolds number 10⁶
// (for example a 0.4 m chord at 37 m/s, or a 1 m chord at 15 m/s).
//
//   score = L/D at the working angle × thickness penalty × moment penalty (if a moment limit is set)
//
// L/D - lift-to-drag ratio ("glide ratio"): how many metres a glider flies forward per metre of height.
// WORKING ANGLE - the angle of attack with the best L/D, but with a margin: the flow must stay attached
// at this angle AND at every angle up to MARGIN degrees above it. A gust or a pilot pulling the stick
// must not stall the wing. Without the margin the evolution walks right up to the stall.
// THICKNESS: the spar lives inside the airfoil; thinner than setup.tMin is punished as (t / tMin)⁴.
// A thin plate has the best L/D of all, and is useless as a wing.
// PITCHING MOMENT (optional, setup.cmMin): a strongly cambered airfoil wants to dive (Cm < 0); the tail has to push
// down to hold it, which costs lift and drag. A flying wing has no tail at all and needs Cm ≥ 0 (an S-shaped "reflex" airfoil).
// Below cmMin the score falls linearly and reaches zero CM_SPAN lower.
//
// Classes (for the pool chart): not an airfoil (the surfaces cross), stalls (no attached working angle with the margin),
// too thin, dives (Cm below the limit), working.

const SETUP = { re: 1e6, tMin: 0.12, margin: 3, cmMin: -0.1 };  // the page starts with the same values
const THICKNESS_POWER = 4;
const CM_SPAN = 0.05;
const CLASS_NAMES = ['не профиль', 'срывается', 'тоньше нормы', 'пикирует', 'рабочий'];
const CLASS_COLORS = ['#5a5f73', '#ff6b5e', '#ffb547', '#b48cff', '#5fd47d'];

function momentFactor(cm, setup) {
  if (setup.cmMin === null || setup.cmMin === undefined || cm >= setup.cmMin) return 1;
  return Math.max(0, 1 - (setup.cmMin - cm) / CM_SPAN);
}

// The reference: NACA 44xx of the required thickness (NACA 4412 for 12 %) - one of the best-known classic airfoils.
// A flying wing (Cm ≥ 0) cannot use it (Cm ≈ −0.1); the classic choice there is a symmetric NACA 00xx.
function referenceCode(setup) {
  const family = setup.cmMin !== null && setup.cmMin !== undefined && setup.cmMin > -0.09 ? '00' : '44';
  return family + String(Math.round(setup.tMin * 100)).padStart(2, '0');
}

// The working angle of a polar. points - from sweepPolar (step 0.5°, ascending).
function workingPoint(points, setup) {
  const need = Math.round(setup.margin / 0.5);
  let best = null;
  for (let i = 0; i + need < points.length; i++) {
    let ok = true;
    for (let k = i; k <= i + need; k++) if (!points[k].attached) { ok = false; break; }
    if (ok && points[i].cl > 0 && (!best || points[i].ld > best.ld)) best = points[i];
  }
  return best;
}

// Everything about an airfoil: geometry, polar (light points), working point, score.
function analyzeAirfoil(g, setup, fullPolar) {
  const geo = measureAirfoil(g);
  if (!geo.valid) return { geo, points: [], work: null, score: 0, cls: 0 };
  const P = preparePanels(airfoilShape(g));
  const points = sweepPolar(P, setup.re, { stopAfterStall: !fullPolar });
  const work = workingPoint(points, setup);
  const thin = Math.min(1, geo.t / setup.tMin) ** THICKNESS_POWER;
  let score, cls, moment = 1;
  if (work) {
    moment = momentFactor(work.cm, setup);
    score = work.ld * thin * moment;
    cls = thin < 1 ? 2 : moment < 1 ? 3 : 4;
  } else {
    // no working angle: a small score, so that the first pool still has a gradient -
    // by the best attached point, or, if the flow never stays attached (a circle, a brick), by the narrowest wake:
    // 0.5 at the edge of attached flow, less for a wider wake. Streamlining comes before lift.
    const attached = points.filter((p) => p.attached && p.cl > 0);
    const wakes = points.filter((p) => !p.failed).map((p) => p.wake);
    if (attached.length) score = 0.1 * Math.max(...attached.map((p) => p.ld)) * thin;
    else score = wakes.length ? 0.5 * AERO.attachedWake / Math.max(AERO.attachedWake, Math.min(...wakes)) : 0.01;
    cls = 1;
  }
  let clMax = 0, alphaStall = null;
  for (const p of points) {
    if (p.attached && p.cl > clMax) clMax = p.cl;
    if (alphaStall === null && clMax > 0 && !p.attached) alphaStall = p.alpha;
  }
  return { geo, points, work, thin, moment, score, cls, clMax, alphaStall, P };
}

// A compact result for the pool (what a worker sends back).
function evaluateAirfoil(g, setup) {
  const a = analyzeAirfoil(g, setup || SETUP, false);
  const w = a.work;
  return {
    score: a.score, cls: a.cls, thin: a.thin, moment: a.moment,
    t: a.geo.t, tAt: a.geo.tAt, camber: a.geo.camber, camberAt: a.geo.camberAt,
    alpha: w ? w.alpha : null, cl: w ? w.cl : null, cd: w ? w.cd : null, ld: w ? w.ld : null, cm: w ? w.cm : null,
    xtrU: w ? w.xtrU : null, xtrL: w ? w.xtrL : null,
    clMax: a.clMax || 0, alphaStall: a.alphaStall,
  };
}
