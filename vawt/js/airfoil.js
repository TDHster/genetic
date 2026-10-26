'use strict';
// AIRFOIL: lift and drag of a symmetric NACA 00xx blade section at any angle of attack.
//
// A Darrieus blade sees every angle: about ±10° when the rotor runs fast, the full circle when it stands still.
// So two simple models are blended:
//   - attached flow (small angles): lift grows linearly, Cl = 2π·0.9·sin α, drag is small (Cd0);
//   - stalled flow (big angles): the section is a flat plate, Cl = sin 2α, Cd = 1.9·sin²α + Cd0.
// The switch happens at the stall angle, smoothed over a couple of degrees.
//
// Thickness t/c and the Reynolds number Re = W·c/ν matter:
//   - a thicker section stalls later (good for self-starting; up to t/c ~ 0.25) but has more drag and less lift slope;
//   - a small chord or a slow blade means a low Re: earlier stall and more drag. This closes the "needle blade":
//     without it evolution would make the blades as thin as thread to save material.
// Dynamic stall (the stall angle rises when α changes fast) is left out on purpose: see README.

const DEG = Math.PI / 180;
const LIFT_SLOPE = 2 * Math.PI * 0.9;   // per radian at t/c = 0.12, a little under thin-airfoil theory
const STALL_BLEND = 1 * DEG;            // width of the attached -> stalled transition

// Stall angle (radians) and the drag at zero lift; depend only on the section and Re.
function stallAngle(tc, re) {
  const reFactor = Math.min(1.15, Math.max(0.6, 0.8 + 0.2 * Math.log10(re / 1e5)));
  // Thicker sections stall later, but only up to t/c ~ 0.25 (NACA0018 at Re 3e5: ~11°).
  const t = tc - 0.12;
  return (10 + 40 * t - 150 * t * t) * reFactor * DEG;
}

function zeroLiftDrag(tc, re) {
  return (0.0045 + 0.04 * tc) * Math.pow(re / 1e6, -0.25); // NACA0018 at Re 3e5: ~0.016, NACA0030: ~0.022
}

// What does not depend on the angle: computed once per slice and λ (Re is taken at the typical blade speed).
function airfoilSection(tc, re) {
  // thick sections lose some lift slope
  return { stall: stallAngle(tc, re), cd0: zeroLiftDrag(tc, re), slope: LIFT_SLOPE * (1 - 0.6 * (tc - 0.12)) };
}

// alpha in (-π, π], section from airfoilSection; writes { cl, cd } into out (no allocation in the hot loop).
function airfoil(alpha, section, out) {
  const s = Math.sin(alpha), c = Math.cos(alpha);
  const { stall, cd0 } = section;
  // How much of the flow is attached: 1 well below stall, 0 above it.
  // Measured from the nearest edge: a blade going backwards (|α| near 180°) works as a (poor) airfoil too.
  const a = Math.abs(alpha);
  const fromEdge = Math.min(a, Math.PI - a);
  const attached = 1 / (1 + Math.exp((fromEdge - stall) / STALL_BLEND));
  // Backwards the trailing edge leads: lift changes sign and is weaker (a sharp leading edge).
  const clAttached = section.slope * s * (a < Math.PI / 2 ? 1 : -0.6);
  const clPlate = 2 * s * c;
  out.cl = attached * clAttached + (1 - attached) * clPlate;
  out.cd = cd0 + attached * 0.1 * fromEdge * fromEdge + (1 - attached) * 1.9 * s * s;
  return out;
}
