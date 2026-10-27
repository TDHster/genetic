// Tree genome: every stone is laid RELATIVE TO AN EARLIER STONE (its parent), as a mason lays a course
// against the stone before it - in the spirit of the evolved Lego bridges of Funes & Pollack (1998).
//
// Gene = {parent, du, dv, turn, axis} (or a root: {parent: -1, x, z, yaw, axis})
//   parent - index of an earlier gene (-1: a root, placed at x, z with yaw);
//   du     - shift along the parent's length, in quarters of a stone length (-4..4: -4 = end to end,
//            -2 = half bond, -1 = a corbel of a quarter stone, 0 = right above or beside it);
//   dv     - shift across it, in halves of a stone width (-2..2: +-2 = side by side);
//   turn   - 0 or 1: turned by 90° to the parent (a header across a stretcher);
//   axis   - 1 = on edge, 2 = flat (never on end).
// The position is computed from the parent's PLANNED place, not from where physics put it, so a mutation
// of one gene moves its whole branch along. Stone i of the quarry goes to gene i. The stone is then lowered
// from above as usual (physics.js): "on top" or "beside" follows from where it lands.
// The genome keeps {genes, placements}: placements are decoded from the genes after every change, so the
// physics, the workers, export and replay need not know about trees.
//
// The key mutation is REPEAT: a run of genes is copied to the end, its first gene attached to the last stone
// of the run. One mutation turns "one stone a quarter out on top of the last" into a corbelled stair, a
// spiral or a course - the regularity the stone-by-stone genome could not express (see CLAUDE.md).

import { BASE_SIZE } from './stones.js';

// Pitch: a little above the largest stone (sizes are +-10 %), so neighbours do not land on each other;
// with perfect bricks (rules.regular) 1 % - courses close up.
const pitch = (rules) => (rules.regular ? 1.01 : 1.1);
export const MAX_REPEAT = 12;   // genes copied at most by one repeat

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function randomChild(rng, parent) {
  return {
    parent,
    du: rng.intRange(-4, 4),
    dv: rng.intRange(-2, 2),
    turn: rng.int(2),
    axis: 1 + rng.int(2),
  };
}

// Planned placements from the genes (see the header).
export function decode(genes, rules = {}) {
  const k = pitch(rules);
  const length = BASE_SIZE[0] * k;
  const width = { 1: BASE_SIZE[2] * k, 2: BASE_SIZE[1] * k };   // across: on edge the stone is 10 cm wide
  const placed = [];
  for (let i = 0; i < genes.length; i++) {
    const g = genes[i];
    if (g.parent < 0) {
      placed.push({ stone: i, x: g.x, z: g.z, yaw: g.yaw, axis: g.axis, tiltDir: 0, tilt: 0 });
      continue;
    }
    const p = placed[g.parent];
    const a = p.yaw * Math.PI / 180;
    // The stone's length runs along (cos a, -sin a) in (x, z) for yaw a (a turn around +y), its width across.
    const u = g.du * length / 4;
    const v = g.dv * width[p.axis] / 2;
    placed.push({
      stone: i,
      x: p.x + u * Math.cos(a) + v * Math.sin(a),
      z: p.z - u * Math.sin(a) + v * Math.cos(a),
      yaw: (p.yaw + 90 * g.turn) % 360,
      axis: g.axis,
      tiltDir: 0,
      tilt: 0,
    });
  }
  return placed;
}

const make = (genes, rules) => ({ genes, placements: decode(genes, rules) });

export function randomGenome(rng, stoneCount, rules = {}) {
  const genes = [{ parent: -1, x: 0.1 * rng.normal(), z: 0.1 * rng.normal(), yaw: 90 * rng.int(4), axis: 1 + rng.int(2) }];
  const n = Math.min(stoneCount, rng.intRange(4, 12));
  while (genes.length < n) genes.push(randomChild(rng, rng.int(genes.length)));
  return make(genes, rules);
}

export function cloneGenome(g) {
  return { genes: g.genes.map((x) => ({ ...x })), placements: g.placements.map((p) => ({ ...p })) };
}

// One-point crossover at the same index in both parents: parents always point backwards, so every
// gene of the tail still points at a gene that exists.
export function crossover(rng, a, b, stoneCount, rules = {}) {
  const cut = rng.intRange(1, Math.min(a.genes.length, b.genes.length));
  const genes = [...a.genes.slice(0, cut), ...b.genes.slice(cut)].slice(0, stoneCount).map((x) => ({ ...x }));
  return make(genes, rules);
}

export const MUTATIONS = [
  ['shift', 0.25],     // du or dv of one gene by one step: its branch moves along
  ['turn', 0.08],
  ['axis', 0.07],
  ['parent', 0.10],    // hang a gene (and its branch) on another earlier stone
  ['add', 0.20],       // a new stone on a random stone
  ['delete', 0.10],    // its children go to its parent
  ['repeat', 0.15],    // the motif repeat (see the header)
  ['root', 0.05],      // move the whole structure
];

function pick(rng) {
  let r = rng.next();
  for (const [name, p] of MUTATIONS) {
    if (r < p) return name;
    r -= p;
  }
  return MUTATIONS[0][0];
}

// Changes the genome in place (genes and placements). Returns the mutation name.
export function mutate(rng, g, stoneCount, rules = {}) {
  const genes = g.genes;
  let kind = pick(rng);
  if ((kind === 'add' || kind === 'repeat') && genes.length >= stoneCount) kind = 'shift';
  if (genes.length < 2 && kind !== 'add' && kind !== 'root') kind = 'add';
  const i = 1 + rng.int(Math.max(1, genes.length - 1));   // a non-root gene (if any)
  const x = genes[i];
  switch (kind) {
    case 'shift':
      if (rng.chance(0.6)) x.du = clamp(x.du + (rng.chance(0.5) ? 1 : -1), -4, 4);
      else x.dv = clamp(x.dv + (rng.chance(0.5) ? 1 : -1), -2, 2);
      break;
    case 'turn': x.turn = 1 - x.turn; break;
    case 'axis': x.axis = x.axis === 1 ? 2 : 1; break;
    case 'parent': x.parent = rng.int(i); break;
    case 'add':
      // Newer stones are more often built upon: the structure grows from its working edge.
      genes.push(randomChild(rng, Math.max(0, genes.length - 1 - Math.floor(Math.abs(rng.normal()) * 4))));
      break;
    case 'delete':
      for (const y of genes) if (y.parent === i) y.parent = x.parent;
      genes.splice(i, 1);
      for (const y of genes) if (y.parent > i) y.parent--;
      if (genes[0].parent !== -1) throw new Error('tree genome lost its root');
      break;
    case 'repeat': {
      const len = Math.min(stoneCount - genes.length, 1 + rng.int(Math.min(MAX_REPEAT, genes.length - 1)));
      const start = 1 + rng.int(genes.length - len);
      const end = start + len - 1;           // the run is genes[start..end]
      const base = genes.length;
      for (let k = 0; k < len; k++) {
        const y = { ...genes[start + k] };
        // Inside the run: point at the copy. The run's own anchor: the last stone of the run (or of the
        // previous copy) - so copies chain up into a stair, a spiral, a course.
        if (y.parent >= start && y.parent <= end) y.parent = base + (y.parent - start);
        else if (k === 0) y.parent = end;
        genes.push(y);
      }
      break;
    }
    case 'root':
      genes[0].x += 0.05 * rng.normal();
      genes[0].z += 0.05 * rng.normal();
      if (rng.chance(0.3)) genes[0].yaw = 90 * rng.int(4);
      break;
  }
  g.placements = decode(genes, rules);
  return kind;
}
