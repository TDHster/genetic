// Fitness: how tall the structure is after the tests, plus metrics for the UI.
//
// score = height of the highest stone point after the last test (metres).
// Fallen stones lie low, so collapse punishes itself; nothing else is rewarded.
// The metrics below do not affect evolution - they only help to see what it invented:
//   fallen   - stones that dropped more than FALL_DROP during the tilt tests (after settling);
//   hanging  - stones with more than HANG_GAP of empty space straight below their centre
//              (a stone bridging a gap: a lintel, a corbel or a wedge of an arch);
//   structure - stones connected to the highest stone through contacts (without the ground):
//              the building itself, without the rubble around it;
//   profile  - max horizontal radius of the structure's stone corners in PROFILE_BANDS height bands,
//              from the centre of its base; a cone has radii shrinking upwards.

import { rotatePoint, stoneTop } from './physics.js';

export const FALL_DROP = 0.05;
export const HANG_GAP = 0.05;
export const PROFILE_BANDS = 5;

function worldCorners(it) {
  const pos = it.body.translation();
  const rot = it.body.rotation();
  const pts = it.stone.points;
  const out = [];
  for (let i = 0; i < 8; i++) {
    const v = rotatePoint(rot, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    out.push([pos.x + v[0], pos.y + v[1], pos.z + v[2]]);
  }
  return out;
}

export function measureStructure(trial) {
  const R = trial.R;
  const items = trial.items;
  let height = 0;
  let fallen = 0;
  let hanging = 0;
  const corners = items.map(worldCorners);

  items.forEach((it, i) => {
    const pos = it.body.translation();
    height = Math.max(height, stoneTop(it.stone, pos, it.body.rotation()));
    if (it.settledY - pos.y > FALL_DROP) fallen++;
    const bottom = Math.min(...corners[i].map((c) => c[1]));
    if (bottom > HANG_GAP) {
      const ray = new R.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: -1, z: 0 });
      // Nearest surface straight below the centre: the ground or another stone. The world has been
      // stepped since the last change, so its scene queries are up to date (and O(log N), not O(N)).
      const hit = trial.world.castRay(ray, pos.y + 1, true, undefined, undefined, undefined, it.body);
      const below = hit ? pos.y - hit.timeOfImpact : 0;
      if (bottom - below > HANG_GAP) hanging++;
    }
  });

  const inStructure = connectedToTop(trial, corners);
  const structure = corners.filter((_, i) => inStructure[i]);

  // Base centre: average of the structure's stones touching the ground.
  let cx = 0, cz = 0, n = 0;
  structure.forEach((cs) => {
    if (Math.min(...cs.map((c) => c[1])) < 0.02) {
      for (const c of cs) { cx += c[0]; cz += c[2]; n++; }
    }
  });
  if (n) { cx /= n; cz /= n; }
  const profile = new Array(PROFILE_BANDS).fill(0);
  if (height > 0) {
    for (const cs of structure) {
      for (const c of cs) {
        const band = Math.min(PROFILE_BANDS - 1, Math.max(0, Math.floor(c[1] / height * PROFILE_BANDS)));
        profile[band] = Math.max(profile[band], Math.hypot(c[0] - cx, c[2] - cz));
      }
    }
  }

  return {
    score: height, height, stones: items.length, structure: structure.length, fallen, hanging, profile,
  };
}

// Flood fill over touching stones, starting from the one with the highest corner.
function connectedToTop(trial, corners) {
  const items = trial.items;
  const seen = new Array(items.length).fill(false);
  if (!items.length) return seen;
  const index = new Map(items.map((it, i) => [it.collider.handle, i]));
  let top = 0;
  corners.forEach((cs, i) => {
    if (Math.max(...cs.map((c) => c[1])) > Math.max(...corners[top].map((c) => c[1]))) top = i;
  });
  const stack = [top];
  seen[top] = true;
  while (stack.length) {
    const c1 = items[stack.pop()].collider;
    trial.world.contactPairsWith(c1, (c2) => {
      const j = index.get(c2.handle);
      if (j === undefined || seen[j]) return;   // the ground or already visited
      let touching = false;
      trial.world.contactPair(c1, c2, (m) => { if (m.numContacts() > 0) touching = true; });
      if (touching) { seen[j] = true; stack.push(j); }
    });
  }
  return seen;
}
