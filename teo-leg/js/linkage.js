'use strict';
// THE LEG: genome and kinematics of a planar linkage driven by a crank.
//
// Points (y axis points up, units are centimeters):
//   0  O  - crank axle, fixed at (0, 0)
//   1  M  - crank tip, turns around O at radius CRANK
//   2  B  - frame pivot 1, fixed (position is in the genome)
//   3  B2 - frame pivot 2, fixed (position is in the genome)
//   4+ C, D, E, ... - JOINTS
//
// Every joint hangs on two bars attached to two EARLIER points:
//   "I am ra away from point a and rb away from point b".
// So its position is an intersection of two circles - always computable step by step,
// joint after joint. Two circles meet in 0 or 2 points: `side` picks one of the two,
// 0 points means the bars cannot reach and the leg falls apart.
// One joint is the FOOT. Joints the foot does not depend on do nothing (neutral).
//
// Theo Jansen's leg in this language is 5 joints:
//   C on M and B, D on M and B, E on B and C, F on E and D, foot G on F and D.
// Limitation: linkages where several joints must be solved together (not one by one)
// cannot be built this way.
//
// Two modes:
//   'free'   - evolution changes everything: how many joints, what hangs on what, lengths,
//              frame pivots, which joint is the foot. Starts from random junk.
//   'jansen' - the scheme is Jansen's and never changes; only lengths and pivot B evolve.

const CRANK = 15;            // fixed crank radius - sets the scale
const FIXED_POINTS = 4;      // O, M, B, B2
const MAX_JOINTS = 10;
const LENGTH_RANGE = [5, 100];
const FRAME_RANGE = [-80, 80];

function pointName(i) {
  return ['O', 'M', 'B', 'B2'][i] || String.fromCharCode('C'.charCodeAt(0) + i - FIXED_POINTS);
}

// Theo Jansen's "holy numbers" (Strandbeest, 1990s), written as a genome.
// Used for comparison and as the fixed scheme of the 'jansen' mode.
const JANSEN = {
  frame: [{ x: -38, y: -7.8 }, { x: 0, y: -40 }], // B = (-a, -l); B2 is not used
  joints: [
    { a: 1, b: 2, ra: 50, rb: 41.5, side: -1 },   // C: j from M, b from B
    { a: 1, b: 2, ra: 61.9, rb: 39.3, side: 1 },  // D: k from M, c from B
    { a: 2, b: 4, ra: 40.1, rb: 55.8, side: 1 },  // E: d from B, e from C
    { a: 6, b: 5, ra: 39.4, rb: 36.7, side: -1 }, // F: f from E, g from D
    { a: 7, b: 5, ra: 65.7, rb: 49, side: -1 },   // G (foot): h from F, i from D
  ],
  foot: 8,
};

// ---- Which joints matter ----
// The foot and every point it hangs on (directly or through other joints).
function usedPoints(genome) {
  const used = new Set();
  if (genome.foot < 0) return used;
  const stack = [genome.foot];
  while (stack.length) {
    const p = stack.pop();
    if (used.has(p)) continue;
    used.add(p);
    if (p >= FIXED_POINTS) {
      const joint = genome.joints[p - FIXED_POINTS];
      stack.push(joint.a, joint.b);
    } else if (p === 1) {
      stack.push(0); // the crank tip hangs on the crank axle
    }
  }
  return used;
}

// ---- Rigid bodies ("links") ----
// A joint hanging on two points of the SAME rigid body is welded to that body: the two
// new bars and the body form a rigid triangle. Otherwise the two new bars are two new
// moving links. Jansen's leg has 7 moving links (crank, MC, MD, BD, triangle B-C-E, EF,
// triangle D-F-G); a 4-bar linkage has 3. A chain of small rigid triangles adds none.
// Returns: body id for every point that matters (0 = the fixed frame) and the count of
// moving links.
function rigidBodies(genome, used) {
  const bodyOfBar = new Map();            // "p,q" -> body id
  const pointsOfBody = [new Set([0, 2, 3])]; // body 0 = frame: O, B, B2
  const barKey = (p, q) => Math.min(p, q) + ',' + Math.max(p, q);
  // The crank is a body of its own.
  pointsOfBody.push(new Set([0, 1]));
  bodyOfBar.set(barKey(0, 1), 1);
  const sameBody = (a, b) => pointsOfBody.findIndex((pts) => pts.has(a) && pts.has(b));
  genome.joints.forEach((joint, k) => {
    const i = FIXED_POINTS + k;
    if (!used.has(i)) return;
    const body = sameBody(joint.a, joint.b);
    if (body >= 0) {
      pointsOfBody[body].add(i); // welded to an existing body
    } else {
      pointsOfBody.push(new Set([joint.a, i]));
      pointsOfBody.push(new Set([joint.b, i]));
    }
  });
  return { links: pointsOfBody.length - 1, pointsOfBody };
}

// Total length of the bars that matter (the crank itself is not counted).
function barMaterial(genome, used) {
  let sum = 0;
  genome.joints.forEach((joint, k) => {
    if (used.has(FIXED_POINTS + k)) sum += joint.ra + joint.rb;
  });
  return sum;
}

// ---- Kinematics ----

// Where can a point be, if it is r1 away from p1 and r2 away from p2?
// side = +1 / -1 picks one of the two answers (left or right of the direction p1 -> p2).
function circleIntersection(p1, r1, p2, r2, side) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || d > r1 + r2 || d < Math.abs(r1 - r2)) return null;
  const along = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const across = Math.sqrt(Math.max(0, r1 * r1 - along * along));
  const bx = p1.x + (along * dx) / d, by = p1.y + (along * dy) / d;
  return { x: bx - (side * across * dy) / d, y: by + (side * across * dx) / d };
}

// Positions of all points for crank angle t (radians).
// Returns null if a point that matters cannot be built; unused joints may be null.
function legPose(genome, t, used) {
  const points = [
    { x: 0, y: 0 },
    { x: CRANK * Math.cos(t), y: CRANK * Math.sin(t) },
    genome.frame[0],
    genome.frame[1],
  ];
  genome.joints.forEach((joint, k) => {
    const pa = points[joint.a], pb = points[joint.b];
    points.push(pa && pb ? circleIntersection(pa, joint.ra, pb, joint.rb, joint.side) : null);
  });
  for (const p of used) if (!points[p]) return null;
  return points;
}

// Turn the crank a full circle and record every pose (null where the leg falls apart).
// 120 steps = one pose every 3 degrees: precise enough and fast.
const STEPS = 120;
function simulateLeg(genome) {
  const used = usedPoints(genome);
  const poses = [];
  let assembled = 0;
  for (let s = 0; s < STEPS; s++) {
    const pose = legPose(genome, (2 * Math.PI * s) / STEPS, used);
    if (pose) assembled++;
    poses.push(pose);
  }
  return { poses, used, complete: assembled === STEPS, assembled };
}

// ---- Creating, mating and mutating genomes ----

const randomLength = (rng) => LENGTH_RANGE[0] + (LENGTH_RANGE[1] - LENGTH_RANGE[0]) * rng.next();
const randomCoord = (rng) => FRAME_RANGE[0] + (FRAME_RANGE[1] - FRAME_RANGE[0]) * rng.next();

// A new joint at point index `index`, hanging on two random earlier points.
function randomJoint(rng, index) {
  const a = rng.int(index);
  let b = rng.int(index - 1);
  if (b >= a) b++;
  return { a, b, ra: randomLength(rng), rb: randomLength(rng), side: rng.chance(0.5) ? 1 : -1 };
}

function randomLeg(rng, mode) {
  const frame = [{ x: randomCoord(rng), y: randomCoord(rng) }, { x: randomCoord(rng), y: randomCoord(rng) }];
  if (mode === 'jansen') {
    // Jansen's scheme, random lengths and pivot.
    const joints = JANSEN.joints.map((j) => ({ ...j, ra: randomLength(rng), rb: randomLength(rng) }));
    return { frame, joints, foot: JANSEN.foot };
  }
  // Free mode: a random chain of 1..5 joints. Each joint hangs on the previous one and on
  // any random earlier point, and the last joint is the foot - so the foot really depends
  // on all of them. Otherwise almost every random leg would be a 1-joint leg (a random
  // foot usually hangs straight on fixed points) and complex species would never start.
  const count = rng.intRange(1, 5);
  const joints = [];
  for (let k = 0; k < count; k++) {
    const index = FIXED_POINTS + k;
    const joint = randomJoint(rng, index);
    if (k > 0 && joint.a !== index - 1 && joint.b !== index - 1) joint.a = index - 1;
    joints.push(joint);
  }
  return { frame, joints, foot: FIXED_POINTS + count - 1 };
}

function copyLeg(g) {
  return { frame: g.frame.map((p) => ({ ...p })), joints: g.joints.map((j) => ({ ...j })), foot: g.foot };
}

// Crossover: the child takes the number of joints of a random parent; every joint position
// comes from a random parent that has a joint there. A joint only refers to EARLIER points,
// and all earlier points exist in the child, so the child is always valid.
// Frame pivots and the foot come from a random parent each.
function crossover(mom, dad, rng) {
  const lengthDonor = rng.chance(0.5) ? mom : dad;
  const joints = lengthDonor.joints.map((joint, k) => {
    const other = lengthDonor === mom ? dad : mom;
    const from = k < other.joints.length && rng.chance(0.5) ? other.joints[k] : joint;
    return { ...from };
  });
  const total = FIXED_POINTS + joints.length;
  let foot = (rng.chance(0.5) ? mom : dad).foot;
  if (foot >= total || foot < 0) foot = lengthDonor.foot;
  return {
    frame: [0, 1].map((i) => ({ ...(rng.chance(0.5) ? mom : dad).frame[i] })),
    joints,
    foot: joints.length ? foot : -1,
  };
}

// One random mutation, in place. Returns a description for the UI.
function mutate(genome, rng, mode) {
  const n = genome.joints.length;
  const r = rng.next();

  // Both modes: change one bar length (usually a small nudge, sometimes a new value).
  if (n > 0 && (r < 0.35 || mode === 'jansen' && r < 0.85)) {
    const k = rng.int(n), joint = genome.joints[k];
    const key = rng.chance(0.5) ? 'ra' : 'rb';
    const before = joint[key];
    const span = LENGTH_RANGE[1] - LENGTH_RANGE[0];
    let after = rng.chance(0.8)
      ? before + span * Math.pow(10, -3 + 2 * rng.next()) * rng.normal()
      : randomLength(rng);
    after = Math.max(LENGTH_RANGE[0], Math.min(LENGTH_RANGE[1], after));
    joint[key] = after;
    const to = pointName(key === 'ra' ? joint.a : joint.b);
    return `стержень ${pointName(FIXED_POINTS + k)}–${to}: ${before.toFixed(2)} → ${after.toFixed(2)} см`;
  }

  // Both modes: move a frame pivot (Jansen mode: only B).
  if (r < 0.45 || mode === 'jansen') {
    const i = mode === 'jansen' ? 0 : rng.int(2);
    const p = genome.frame[i], axis = rng.chance(0.5) ? 'x' : 'y';
    const before = p[axis];
    p[axis] = Math.max(FRAME_RANGE[0], Math.min(FRAME_RANGE[1], before + 10 * Math.pow(10, -2 + 2 * rng.next()) * rng.normal()));
    return `точка рамы ${pointName(2 + i)}.${axis}: ${before.toFixed(2)} → ${p[axis].toFixed(2)}`;
  }

  // Free mode only - changes of the scheme.
  if (r < 0.55 && n > 0) {
    const k = rng.int(n);
    genome.joints[k].side *= -1;
    return `шарнир ${pointName(FIXED_POINTS + k)} перевёрнут на другую сторону`;
  }
  if (r < 0.7 && n > 0) {
    const k = rng.int(n), joint = genome.joints[k], index = FIXED_POINTS + k;
    const key = rng.chance(0.5) ? 'a' : 'b', other = key === 'a' ? joint.b : joint.a;
    const before = joint[key];
    let after = rng.int(index - 1);
    if (after >= other) after++;
    joint[key] = after;
    return `шарнир ${pointName(index)} перецеплен: ${pointName(before)} → ${pointName(after)}`;
  }
  if (r < 0.8 && n < MAX_JOINTS) {
    genome.joints.push(randomJoint(rng, FIXED_POINTS + n));
    const j = genome.joints[n];
    return `новый шарнир ${pointName(FIXED_POINTS + n)} на ${pointName(j.a)} и ${pointName(j.b)}`;
  }
  if (r < 0.9 && n > 0) {
    const k = rng.int(n), removed = FIXED_POINTS + k;
    genome.joints.splice(k, 1);
    // Points after the removed one shift down by one; links to the removed one go elsewhere.
    genome.joints.forEach((joint, m) => {
      const index = FIXED_POINTS + m;
      for (const key of ['a', 'b']) {
        if (joint[key] > removed) joint[key]--;
        else if (joint[key] === removed) {
          const other = key === 'a' ? joint.b : joint.a;
          let p = rng.int(index - 1);
          if (p >= other) p++;
          joint[key] = p;
        }
      }
    });
    if (genome.joints.length === 0) genome.foot = -1;
    else if (genome.foot === removed) genome.foot = FIXED_POINTS + rng.int(genome.joints.length);
    else if (genome.foot > removed) genome.foot--;
    return `шарнир ${pointName(removed)} удалён`;
  }
  if (n > 0) {
    const before = genome.foot;
    genome.foot = FIXED_POINTS + rng.int(n);
    return `стопа: ${pointName(before)} → ${pointName(genome.foot)}`;
  }
  return 'мутация не нашла, что менять';
}
