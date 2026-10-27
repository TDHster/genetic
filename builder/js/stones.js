// The quarry: a fixed pile of imperfect brick-like stones.
// Generated once per run from the seed, so every structure in the pool is built from the same stones.
//
// A stone starts as a box BASE_SIZE (length x width x height, metres), each size is scaled by
// a random factor within +-SIZE_ERROR, then each of the 8 corners is shifted by up to +-CORNER_ERROR
// along every axis. The stone is the convex hull of these 8 points: faces are no longer flat
// or parallel, so stones do not stack perfectly.
//
// WEDGE_SHARE of the stones are wedges (voussoirs), as a mason cuts them for an arch: the width along
// local y grows from (1 - taper) at the bottom face (local -z) to (1 + taper) at the top face, taper in
// WEDGE_TAPER. Without wedges a dry arch cannot stand: rectangular stones on a curve touch only with their
// inner edges, every joint is a hinge (tested, see CLAUDE.md). Wedges are picked by a separate generator,
// so the rectangular stones of a seed are the same as before wedges existed.

import { makeRng } from './rng.js';

export const BASE_SIZE = [0.30, 0.15, 0.10];
export const SIZE_ERROR = 0.10;      // +-10 % of each size
export const CORNER_ERROR = 0.004;   // +-4 mm per corner coordinate
export const DENSITY = 2400;         // kg/m^3, sandstone
export const WEDGE_SHARE = 0.25;
export const WEDGE_TAPER = [0.05, 0.2];

// Returns [{id, size: [sx, sy, sz], points: Float32Array(24), color, wedge}]
// points are the 8 corners in the stone's local frame, centred on their average; wedge is the taper
// (0 for a rectangular stone).
export function makeQuarry(count, seed) {
  // A separate generator so the quarry does not depend on how evolution uses the main rng.
  const rng = makeRng(seed * 7919 + 17);
  const wedgeRng = makeRng(seed * 104729 + 3);
  const stones = [];
  for (let id = 0; id < count; id++) {
    const size = BASE_SIZE.map((s) => s * (1 + SIZE_ERROR * (2 * rng.next() - 1)));
    const pts = [];
    const wedge = wedgeRng.chance(WEDGE_SHARE)
      ? WEDGE_TAPER[0] + (WEDGE_TAPER[1] - WEDGE_TAPER[0]) * wedgeRng.next() : 0;
    for (let i = 0; i < 8; i++) {
      const sign = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
      for (let a = 0; a < 3; a++) {
        const half = a === 1 ? size[a] / 2 * (1 + wedge * sign[2]) : size[a] / 2;
        pts.push(sign[a] * half + CORNER_ERROR * (2 * rng.next() - 1));
      }
    }
    // Centre the corners so the body origin is close to the centre of mass.
    for (let a = 0; a < 3; a++) {
      let mean = 0;
      for (let i = 0; i < 8; i++) mean += pts[i * 3 + a] / 8;
      for (let i = 0; i < 8; i++) pts[i * 3 + a] -= mean;
    }
    // Sandstone tint: a little variation per stone, used only for drawing.
    const shade = 0.85 + 0.15 * rng.next();
    // Wedges are a little redder, to tell them apart in the 3D view.
    const color = wedge ? [0.82 * shade, 0.52 * shade, 0.38 * shade] : [0.78 * shade, 0.62 * shade, 0.45 * shade];
    stones.push({ id, size, points: new Float32Array(pts), color, wedge });
  }
  return stones;
}
