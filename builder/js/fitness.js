// Fitness: how tall the structure is after the tests, plus metrics for the UI.
//
// score = height of the highest stone point after the last test (metres).
// "Whole pile" (opts.pile): score = height x share of the quarry's stones in the structure - build the
// whole pile as high as you can, not the tallest column out of 20 stones of 300.
// Fallen stones lie low, so collapse punishes itself; nothing else is rewarded.
// The metrics below do not affect evolution - they only help to see what it invented:
//   fallen   - stones that dropped more than FALL_DROP during the tilt tests (after settling);
//   hanging  - stones with more than HANG_GAP of empty space straight below their centre
//              (a stone bridging a gap: a lintel, a corbel or a wedge of an arch);
//   structure - stones connected to the highest stone through contacts (without the ground):
//              the building itself, without the rubble around it;
//   level    - share of the structure's stones with one of their axes within LEVEL_DEG of the vertical
//              (lying flat, on edge or on end, not tumbled): laid masonry is level, a heap is not;
//   profile  - max horizontal radius of the structure's stone corners in PROFILE_BANDS height bands,
//              from the centre of its base; a cone has radii shrinking upwards.

import { rotatePoint, stoneTop, levelAngle, GATE_HEIGHT, GATE_DEPTH } from './physics.js';


// Pedestal mode (opts.pedestal): score = reach - the largest horizontal distance from the centre of a corner of
// a stone held up by the pedestal: connected to it through contacts of stones that all stay above its top
// (centre higher than -HELD_BELOW). Stones in the pit - even a heap leaning on the pedestal, whose upper stones
// touch neither the floor nor anything but rubble - reach nothing. Every stone pushed a little further out
// counts, so the signal is smooth - unlike "spans or not".
export const HELD_BELOW = 0.1;
function reach(trial, corners) {
  const [pedestal] = trial.grounds;
  const index = new Map(trial.items.map((it, i) => [it.collider.handle, i]));
  const held = new Array(trial.items.length).fill(false);
  const stack = [];
  const visit = (c1, c2) => {
    const i = index.get(c2.handle);
    if (i === undefined || held[i] || trial.items[i].body.translation().y < -HELD_BELOW || moving(trial.items[i])) return;
    let touching = false;
    trial.world.contactPair(c1, c2, (m) => { if (m.numContacts() > 0) touching = true; });
    if (!touching) return;
    held[i] = true;
    stack.push(c2);
  };
  trial.world.contactPairsWith(pedestal, (c) => visit(pedestal, c));
  while (stack.length) {
    const c1 = stack.pop();
    trial.world.contactPairsWith(c1, (c2) => visit(c1, c2));
  }
  let best = 0;
  corners.forEach((cs, i) => {
    if (held[i]) for (const c of cs) best = Math.max(best, Math.hypot(c[0], c[2]));
  });
  return best;
}

// Span cap (opts.spanCap): the height over the passage counts only up to GATE_HEIGHT + SPAN_OVER - the height at which the
// passage widens (GATE_READY in evolution.js). Without it a 1.5 m tower over the passage with two stones inside
// (1.5 x 0.8^2 = 0.96) beat a clean low vault (~0.5): evolution chased height, and of seeds 1-4 only seed 1 got
// past 20 cm. With the cap the only way up is a clean span, then a wider one.
// (GATE_HEIGHT + SPAN_OVER; computed in place: physics.js and this module import each other.)
export const SPAN_OVER = 0.2;
export const GATE_BLOCK_PENALTY = 0.8;   // score factor per stone left inside the passage (0.5 was too harsh:
                                         // one stray stone halved the score and evolution could not feel its way)

// Gate mode (opts.gateWidth): the structure must stand OVER the passage. The height counted is the top
// of the stones that cross its centre line x = 0 (a stone beside the passage does not count), and every
// stone left inside the passage costs 20 % of the score - a heap that fills the passage is no bridge.
// Returns {above, blocked}.
// With a round centering (arch) the passage is the half-disc under it, not a box GATE_HEIGHT high.
// "Inside" is a true intersection of the stone with the passage volume: checking corners only let a 30 cm
// stone jammed across a 30 cm passage count as outside (all its corners were beyond the walls).
function gateMeasure(trial, corners, width, arch) {
  const R = trial.R;
  // Slack: 2 cm at the walls, 3 cm under the roof - a lintel laid on the centering at GATE_HEIGHT sinks
  // a cm or two when the scaffolding goes, and that is no stone in the passage.
  const r = width / 2 - 0.02;
  const index = new Map(trial.items.map((it, i) => [it.collider.handle, i]));
  const top = GATE_HEIGHT - 0.03;
  const [shape, pos, rot] = arch
    ? [new R.Cylinder(GATE_DEPTH / 2, r), { x: 0, y: 0, z: 0 }, { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }]
    : [new R.Cuboid(r, (top - 0.005) / 2, GATE_DEPTH / 2), { x: 0, y: (top + 0.005) / 2, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }];
  let blocked = 0;
  // The world has been stepped since the last change, so its scene queries are up to date.
  trial.world.intersectionsWithShape(pos, rot, shape, (c) => {
    if (index.has(c.handle)) blocked++;   // a stone (not the ground)
    return true;
  });
  let above = 0;
  for (const [i, cs] of corners.entries()) {
    if (moving(trial.items[i])) continue;
    let xmin = Infinity, xmax = -Infinity;
    for (const c of cs) { xmin = Math.min(xmin, c[0]); xmax = Math.max(xmax, c[0]); }
    // Over the passage: across its centre line and within its depth (a stone beyond its end spans nothing).
    if (xmin < 0 && xmax > 0 && cs.some((c) => Math.abs(c[2]) < GATE_DEPTH / 2)) {
      above = Math.max(above, Math.max(...cs.map((c) => c[1])));
    }
  }
  return { above, blocked };
}

// Stacking mode (opts.stack): collapse costs - score x share of the laid stones still within COLLAPSE_SHIFT of
// where they were laid (more than the joints settle when the scaffolding goes). A structure that almost stands
// then ranks above one that fell apart, instead of both just being lower.
export const COLLAPSE_SHIFT = 0.03;
// "Until calm" (physics.js) watches only the top of the structure, so at the moment of measuring lower stones may
// still be falling. A stone faster than MOVING_SPEED counts for nothing: not for reach, not over the passage, and
// in stacking mode as fallen (a chain of stones dropping through the air once scored a 1.8 m reach).
export const MOVING_SPEED = 0.05;
const moving = (it) => {
  const v = it.body.linvel();
  return Math.hypot(v.x, v.y, v.z) > MOVING_SPEED;
};
export const FALL_DROP = 0.05;
export const HANG_GAP = 0.05;
export const PROFILE_BANDS = 5;
export const LEVEL_DEG = 3;
const isLevel = (it) => levelAngle(it.body.rotation()) <= LEVEL_DEG;

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

  const share = structure.length / trial.quarry.length;
  const level = structure.length ? items.filter((it, i) => inStructure[i] && isLevel(it)).length / structure.length : 0;
  let score = height;
  let gate = null;
  if (trial.opts.gateWidth) {
    gate = gateMeasure(trial, corners, trial.opts.gateWidth, trial.opts.gateArch);
    const above = trial.opts.spanCap ? Math.min(gate.above, GATE_HEIGHT + SPAN_OVER) : gate.above;
    score = above * GATE_BLOCK_PENALTY ** gate.blocked;
  }
  if (trial.opts.pile) score *= share;
  const reached = trial.opts.pedestal ? reach(trial, corners) : undefined;
  if (trial.opts.pedestal) score = reached;
  let standing;
  if (trial.opts.stack) {
    const moved = items.filter((it) => {
      const p = it.body.translation(), q = it.placedPos;
      return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > COLLAPSE_SHIFT || moving(it);
    }).length;
    standing = items.length ? 1 - moved / items.length : 0;
    score *= standing;
  }
  return {
    score,
    gateAbove: gate ? gate.above : undefined,
    gateBlocked: gate ? gate.blocked : undefined,
    reach: reached, standing, height, share, level, stones: items.length, structure: structure.length, fallen, hanging, profile,
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
