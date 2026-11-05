'use strict';
// AERODYNAMICS of one airfoil: the ideal flow (panel.js) and the boundary layer (boundary.js) together.
//
// VISCOUS-INVISCID COUPLING, simplified XFOIL idea: the boundary layer thickens toward the tail, mostly on the upper
// surface, so the outer air sees a slightly thicker and less cambered airfoil. We solve the ideal flow, grow the layer,
// "blow" the outer flow away from the surface by the layer's displacement, solve again - a few passes.
// This takes away ~5-10 % of the ideal lift, as on real airfoils, and punishes shapes whose lift lives only in the ideal flow.
//
// POLAR: the airfoil at every angle of attack from −4° to 20°: lift Cl, drag Cd, moment Cm, where the layer turns
// turbulent and where it separates. "Attached" = no separation before 90 % of the chord on either surface
// and a narrow wake (see wakeWidth: a brick separates at its back corners, x = 1, but leaves a wide wake).

const AERO = {
  passes: 4,                 // ideal flow <-> boundary layer passes
  relax: 0.6,                // share of the new blowing taken on each pass (more oscillates near stall)
  maxBlowing: 0.08,          // blowing limit: past separation the simple model is not valid anyway
  attachedTo: 0.9,           // separation further back than this (x/c) is still "attached flow"...
  attachedWake: 0.04,        // ...and the wake not wider than this (NACA airfoils stall at ~0.04; a circle has ~0.4)
  baseDrag: 0.5,             // wake drag = this × wake width (−Cp of the "dead air" behind a blunt body, Hoerner)
  wakeFree: 0.01,            // a wake this narrow is free: a tiny separation at the tail of a normal airfoil
};

const ALPHAS = [];
for (let a = -4; a <= 20 + 1e-9; a += 0.5) ALPHAS.push(a);

const DEG = Math.PI / 180;

// One angle of attack (degrees). Always from scratch (no start from a nearby angle): then the result at an angle
// does not depend on where we came from, and the slider on the page shows exactly the numbers of the score.
function analyzeAt(P, alphaDeg, re) {
  const alpha = alphaDeg * DEG;
  let blowing = null, sol = null, bl = null;
  for (let pass = 0; pass <= AERO.passes; pass++) {
    sol = solveFlow(P, alpha, blowing);
    bl = boundaryLayer(P, sol.ue, re);
    if (!bl) return null;
    if (pass === AERO.passes) break;
    if (!blowing) blowing = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      const target = Math.max(-AERO.maxBlowing, Math.min(AERO.maxBlowing, bl.blowing[i]));
      blowing[i] += AERO.relax * (target - blowing[i]);
    }
  }
  const f = pressureForces(P, sol.cp, alpha);
  const sepU = bl.upper.separationX, sepL = bl.lower.separationX;
  const wake = wakeWidth(P, bl, alpha);
  const attached = (sepU === null || sepU >= AERO.attachedTo) && (sepL === null || sepL >= AERO.attachedTo) &&
    wake <= AERO.attachedWake;
  const cd = bl.cd + AERO.baseDrag * Math.max(0, wake - AERO.wakeFree);
  return {
    alpha: alphaDeg, cl: f.cl, cd, cdf: bl.cdf, cdw: cd - bl.cd, cm: f.cm, ld: f.cl / cd, attached, wake,
    upper: bl.upper, lower: bl.lower, sol, P, blowing: blowing || new Float64Array(P.n), dstar: bl.dstar,
  };
}

// WAKE WIDTH across the stream: between the points where the layers leave the body (the separation point,
// or the tail if a side does not separate). Behind a sharp tail with attached flow it is ~0. Behind a blunt body
// (a circle, a brick, a stalled wing) it is wide, and the "dead air" there has low pressure that pulls the body back.
// Squire-Young does not see this drag at all: without it a circle would fly better than a real wing.
function wakeWidth(P, bl, alpha) {
  const point = (side) => side.separationIdx === null
    ? [P.x0[0], P.y0[0]] : [P.xm[side.separationIdx], P.ym[side.separationIdx]];
  const [xu, yu] = point(bl.upper), [xl, yl] = point(bl.lower);
  return Math.abs((yu - yl) * Math.cos(alpha) - (xu - xl) * Math.sin(alpha));
}

// Sweep of angles. opts.stopAfterStall: stop when two angles in a row are separated (enough for the score).
// Returns points without the heavy arrays unless opts.keep.
function sweepPolar(P, re, opts = {}) {
  const points = [];
  let stalledInRow = 0, seenAttached = false;
  for (const a of ALPHAS) {
    const r = analyzeAt(P, a, re);
    if (!r) { points.push({ alpha: a, failed: true, attached: false }); continue; }
    points.push(opts.keep ? r : lightPoint(r));
    if (r.attached) { seenAttached = true; stalledInRow = 0; } else if (seenAttached) stalledInRow++;
    if (opts.stopAfterStall && stalledInRow >= 2) break;
  }
  return points;
}

function lightPoint(r) {
  return {
    alpha: r.alpha, cl: r.cl, cd: r.cd, cdf: r.cdf, cdw: r.cdw, cm: r.cm, ld: r.ld, attached: r.attached, wake: r.wake,
    xtrU: r.upper.transitionX, xtrL: r.lower.transitionX, sepU: r.upper.separationX, sepL: r.lower.separationX,
    bubbleU: r.upper.bubble, bubbleL: r.lower.bubble,
  };
}
