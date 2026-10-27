// Genome: an ordered list of placements - the mason's building plan.
//
// Placement = {stone, x, z, yaw, axis, tiltDir, tilt}
//   stone   - index of the stone in the quarry (each stone used at most once);
//   x, z    - where it is lowered, metres, within +-AREA (room for a base of 2000 stones);
//   axis    - which local axis of the stone points up: 0 = on end (30 cm tall),
//             1 = on edge (15 cm), 2 = flat (10 cm);
//   yaw     - turn around the vertical, degrees 0..360;
//   tiltDir - direction of the tilt, degrees 0..360 (around the vertical);
//   tilt    - tilt from the vertical, degrees 0..90 (wedges of an arch need it).
// The stone is lowered from above until it touches the ground or earlier stones (see physics.js),
// so any genome builds something: the order of the list is the order of construction.
//
// Rules (`rules`, passed to randomGenome and mutate): {noEnd} - the masonry rule "a stone is laid
// on its bed or on its edge, never on its end": axis is 1 or 2 and the tilt at most MAX_TILT_NO_END
// (a flat stone tilted by 90° would be on its end again). Without it evolution always ended up with a
// column of stones on their ends - 30 cm of height per stone.

export const AREA = 3;
export const MAX_TILT = 90;
export const MAX_TILT_NO_END = 30;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function unusedStones(placements, stoneCount) {
  const used = new Set(placements.map((p) => p.stone));
  const free = [];
  for (let i = 0; i < stoneCount; i++) if (!used.has(i)) free.push(i);
  return free;
}

const maxTilt = (rules) => (rules.noEnd ? MAX_TILT_NO_END : MAX_TILT);

function randomPlacement(rng, stone, cx, cz, spread, rules) {
  return {
    stone,
    x: clamp(cx + spread * rng.normal(), -AREA, AREA),
    z: clamp(cz + spread * rng.normal(), -AREA, AREA),
    yaw: 360 * rng.next(),
    axis: rules.noEnd ? 1 + rng.int(2) : rng.int(3),
    tiltDir: 360 * rng.next(),
    tilt: rng.chance(0.8) ? 0 : maxTilt(rules) * rng.next(),
  };
}

// A starting genome: a few stones dropped near the centre.
export function randomGenome(rng, stoneCount, rules = {}) {
  const n = Math.min(stoneCount, rng.intRange(5, 20));
  const free = Array.from({ length: stoneCount }, (_, i) => i);
  const placements = [];
  for (let i = 0; i < n; i++) {
    const stone = free.splice(rng.int(free.length), 1)[0];
    placements.push(randomPlacement(rng, stone, 0, 0, 0.2, rules));
  }
  return { placements };
}

export function cloneGenome(g) {
  return { placements: g.placements.map((p) => ({ ...p })) };
}

// One-point crossover with independent cuts: the start of one plan + the end of the other.
// Stones used twice get a free stone instead, or are dropped if none is left.
export function crossover(rng, a, b, stoneCount) {
  const cutA = rng.intRange(0, a.placements.length);
  const cutB = rng.intRange(0, b.placements.length);
  const raw = [...a.placements.slice(0, cutA), ...b.placements.slice(cutB)].map((p) => ({ ...p }));
  const used = new Set();
  const dup = [];
  const placements = [];
  for (const p of raw) {
    if (used.has(p.stone)) dup.push(p);
    else used.add(p.stone);
    placements.push(p);
  }
  if (dup.length) {
    const free = unusedStones([...used].map((stone) => ({ stone })), stoneCount);
    for (const p of dup) {
      if (free.length) p.stone = free.splice(rng.int(free.length), 1)[0];
      else placements.splice(placements.indexOf(p), 1);
    }
  }
  return { placements };
}

// Mutation probabilities (one mutation per child). Exported so the UI can show them.
export const MUTATIONS = [
  ['move', 0.15],
  ['yaw', 0.10],
  ['axis', 0.05],
  ['tilt', 0.15],
  ['stone', 0.05],
  ['insert', 0.15],
  ['delete', 0.10],
  ['swap', 0.15],
  ['duplicate', 0.10],
];
export const MAX_DUPLICATE = 50;   // placements copied at most by one duplication

function pickMutation(rng) {
  let r = rng.next();
  for (const [name, p] of MUTATIONS) {
    if (r < p) return name;
    r -= p;
  }
  return MUTATIONS[0][0];
}

// Changes the genome in place. Returns the mutation name (for statistics).
export function mutate(rng, g, stoneCount, rules = {}) {
  const list = g.placements;
  let kind = pickMutation(rng);
  // Mutations that need a stone in the plan turn into an insert when the plan is empty.
  if (list.length === 0) kind = 'insert';
  if (kind === 'swap' && list.length < 2) kind = 'move';
  if ((kind === 'insert' || kind === 'duplicate') && list.length >= stoneCount) kind = 'move';
  const p = list.length ? list[rng.int(list.length)] : null;

  switch (kind) {
    case 'move':
      if (rng.chance(0.8)) {
        p.x = clamp(p.x + 0.03 * rng.normal(), -AREA, AREA);
        p.z = clamp(p.z + 0.03 * rng.normal(), -AREA, AREA);
      } else {
        p.x = clamp(0.3 * rng.normal(), -AREA, AREA);
        p.z = clamp(0.3 * rng.normal(), -AREA, AREA);
      }
      break;
    case 'yaw':
      p.yaw = rng.chance(0.5) ? (p.yaw + 15 * rng.normal() + 360) % 360 : 360 * rng.next();
      break;
    case 'axis':
      p.axis = rules.noEnd ? (p.axis === 1 ? 2 : 1) : (p.axis + 1 + rng.int(2)) % 3;   // noEnd: 1 <-> 2
      break;
    case 'tilt': {
      const r = rng.next();
      const max = maxTilt(rules);
      if (r < 0.5) p.tilt = clamp(p.tilt + 10 * rng.normal(), 0, max);
      else if (r < 0.8) p.tilt = 0;
      else { p.tilt = max * rng.next(); p.tiltDir = 360 * rng.next(); }
      if (rng.chance(0.3)) p.tiltDir = (p.tiltDir + 30 * rng.normal() + 360) % 360;
      break;
    }
    case 'stone': {
      const free = unusedStones(list, stoneCount);
      if (free.length && rng.chance(0.5)) p.stone = free[rng.int(free.length)];
      else if (list.length > 1) {
        const q = list[rng.int(list.length)];
        [p.stone, q.stone] = [q.stone, p.stone];
      }
      break;
    }
    case 'insert': {
      const free = unusedStones(list, stoneCount);
      const stone = free[rng.int(free.length)];
      // New stones go next to an existing one: that is how a structure grows upwards.
      const near = p || { x: 0, z: 0 };
      list.splice(rng.intRange(0, list.length), 0, randomPlacement(rng, stone, near.x, near.z, 0.1, rules));
      break;
    }
    case 'duplicate': {
      // Gene duplication: a run of placements (say, a course) is copied to the end of the plan with
      // free stones, all shifted by the same few cm. Lowered last, the copy lands on top of the
      // original, so a structure can grow by whole courses, not stone by stone - with 2000 stones
      // one-stone mutations alone would need far too many generations.
      const free = unusedStones(list, stoneCount);
      const len = Math.min(free.length, 1 + rng.int(Math.min(MAX_DUPLICATE, list.length)));
      const start = rng.int(list.length - len + 1);
      const dx = 0.03 * rng.normal(), dz = 0.03 * rng.normal();
      for (let k = 0; k < len; k++) {
        const q = list[start + k];
        list.push({
          ...q,
          stone: free.splice(rng.int(free.length), 1)[0],
          x: clamp(q.x + dx, -AREA, AREA),
          z: clamp(q.z + dz, -AREA, AREA),
        });
      }
      break;
    }
    case 'delete':
      list.splice(list.indexOf(p), 1);
      break;
    case 'swap': {
      const i = rng.int(list.length - 1);
      [list[i], list[i + 1]] = [list[i + 1], list[i]];
      break;
    }
  }
  return kind;
}
