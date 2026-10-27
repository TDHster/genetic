// "Physics": builds a structure from a genome in a Rapier world and runs the stability tests.
//
// Construction (each placement in genome order):
//   the stone is turned (axis, yaw, tilt) and lowered from above along the vertical
//   (a shape cast) until it touches the ground or an earlier stone; it is put 2 mm above that point.
//   - with scaffolding: the stone first beds down on its supports (a rough stone touches with one
//     corner first and then rocks onto three) - but the scaffolding lets it move at most BED_LIMIT,
//     then holds it fixed. When all stones are placed, the scaffolding is removed: all stones become
//     dynamic at once. A true arch can stand.
//     For 1000+ stones the build must not cost O(N) per stone: placed stones are kept in a grid
//     (GRID cells, by their horizontal extent), the lowering casts only against stones in the cells
//     under the new one, and the bedding runs in a small separate world with just the new stone and
//     its neighbours (a step of the full world costs ~0.6 ms at 1000 stones, even if they are fixed).
//   - without scaffolding: the stone is dynamic at once, and the world runs until things calm down
//     (at most SIM.buildMax) before the next stone. Only what stands at every step survives,
//     so a true arch cannot be built - only corbelled spans.
// Tests (one continuous simulation, step SIM.dt) - a "tilting table": gravity tilted by tiltDeg is
// the same as a steady side load of sin(tilt) * weight. With tiltDeg = 0 only settle remains (and rest).
//   settle  - upright, until calm;
//   tilt    - the tilt grows smoothly from 0 to tiltDeg over SIM.rampTime, towards +x;
//   hold    - in each of SIM.directions directions (every 360 / n degrees) the tilt is held until calm,
//             between them it turns smoothly over SIM.turnTime;
//   untilt  - back to upright over SIM.rampTime;
//   rest    - upright, until calm.
// "Until calm": at least SIM.calmMin, then until the stones in the top SIM.calmTopShare of the height
// move less than SIM.calmShift over SIM.calmWindow; at most SIM.calmMax - a structure still moving
// then is unstable and scores 0.
// Why so (each was found the hard way):
//   - sudden jumps of gravity (+x, -x, +z, -z) rock a column: it tipped over at 80 % of its static angle;
//   - any fixed duration of the load is a loophole: evolution finds "slow falls", a column past its
//     tipping point that simply has no time to fall - first with phases of 1 s, then with a tilt that
//     turned a full circle in 2-4 s. Holding each direction until calm leaves nothing to wait out.
// Bodies never sleep: a sleeping body ignores a change of gravity, and Rapier puts to sleep bodies
// slower than 0.4 m/s - that would freeze a slowly toppling column half-way.
//
// Mirror symmetry (opts.mirror): the genome describes half of the structure. Every placement is followed
// by its mirror image across the plane x = 0 (the axis of the passage in gate mode): x -> -x, the turn
// reflected, and the stone from the second half of the quarry (stone + N/2: a little different, as real
// stones are). Both sides rise together, as masons build an arch. Symmetry is a general principle
// (living things are mostly bilateral), not a shape: but a portal or a vault has two equal sides, and
// without it evolution had to find both independently.
//
// Gate mode (opts.gateWidth > 0): a passage GATE_HEIGHT high and gateWidth wide runs through the site
// along z (|x| < gateWidth / 2). With scaffolding the passage is filled with a wooden centering
// while building - as real arches are built - and the centering goes away with the scaffolding:
// a box GATE_HEIGHT high, or with opts.gateArch a half-cylinder of radius gateWidth / 2 standing on the
// ground (a round arch springs from the ground).
// Without scaffolding there is no centering. Scoring of the gate mode is in fitness.js.
//
// Pedestal mode (opts.pedestal = half-size, m): there is no ground but a square pedestal (top at y = 0)
// in a pit PIT_DEPTH deep. The task is reach (fitness.js): how far from the centre the structure gets.
// A heap is useless here - it pours into the pit; only corbels, counterweights and cantilevers reach out.
//
// The trial is a generator: evolution runs it to the end at once, the 3D view runs it step by step,
// so both see exactly the same simulation (Rapier is deterministic).

import { DENSITY } from './stones.js';
import { measureStructure } from './fitness.js';

// Simulation settings; times are in seconds, so the step `dt` can change without changing the test.
// A mutable object (not constants) so that tools can try other values.
export const SIM = {
  dt: 1 / 60,
  solverIterations: 4,
  pgsIterations: 4,       // Rapier's internal PGS iterations (default 1): with 1 a stack of 20 perfect
                          // stones kept bouncing by 5 cm after the scaffolding went and never calmed
  contactFrequency: 60,   // Hz: contact stiffness. With Rapier's default 30 Hz a column of 10 perfect
                          // stones sank 4 mm per joint, bent and tipped over at 70 % of its static angle
  allowedError: 0.001,    // m: allowed penetration (Rapier default 0.001)
  rampTime: 0.5,          // tilting up and back down
  directions: 8,          // directions of the tilt held in turn
  turnTime: 1,            // turning the tilt to the next direction (0.25 s excited rocking that
                          // outlasted calmMax: a stable column scored as unstable)
  calmMin: 0.25,          // "until calm" phases last at least this long...
  calmMax: 10,            // ...and at most this long (3 s was too short for big structures: a stepped
                          // pyramid of 300 stones stood 20 s without a fallen stone but scored 0; 10 s
                          // cost no speed with 100 stones)
  fixedPhase: 0,          // s: if set, every "until calm" phase lasts exactly this long, nothing is
                          // called unstable (experiment: is "until calm" needed at all?)
  calmWindow: 0.25,       // calm = over this window...
  calmShift: 0.002,       // ...no stone moved further than this (m). Strict on purpose: stones of a
                          // stable tall tower jitter by a few mm and some honest towers score 0, but every
                          // milder rule tried let evolution grow towers that fell later (see CLAUDE.md)
  calmTopShare: 0.25,     // only stones in the top quarter of the structure must be calm: a falling
                          // structure moves its top, while stones dropping off its lower parts (and rubble)
                          // kept a tall tower "not calm" for the whole calmMax
  buildMax: 0.5,          // the longest wait after placing a stone
  buildCalmTime: 1 / 12,  // calm this long while building = the next stone can go
};
const steps = (t) => Math.max(1, Math.round(t / SIM.dt));
export const BED_LIMIT = 0.015;
export const FRICTION = 0.7;
export const GAP = 0.002;
export const G = 9.81;
export const GATE_HEIGHT = 0.3;
export const GATE_DEPTH = 4;      // along z: through the whole building site
export const PIT_DEPTH = 1.5;     // pedestal mode: depth of the pit around the pedestal
const ABORT_MARGIN = 0.01;
const ABORT_EVERY = 10;
const GRID = 0.5;           // m: cell of the grid of placed stones
const CALM_SPEED = 0.02;   // m/s: below this the structure counts as calm while building

// Quaternion helpers ({x, y, z, w}, the format Rapier uses).
function quatAxisAngle(ax, ay, az, deg) {
  const h = deg * Math.PI / 360;
  const s = Math.sin(h);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) };
}
function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
export function rotatePoint(q, x, y, z) {
  // v' = v + 2w(u x v) + 2 u x (u x v), u = (q.x, q.y, q.z)
  const cx = q.y * z - q.z * y, cy = q.z * x - q.x * z, cz = q.x * y - q.y * x;
  return [
    x + 2 * (q.w * cx + q.y * cz - q.z * cy),
    y + 2 * (q.w * cy + q.z * cx - q.x * cz),
    z + 2 * (q.w * cz + q.x * cy - q.y * cx),
  ];
}

// Orientation of a placed stone: base (which axis is up), then yaw, then tilt.
const BASE = [
  quatAxisAngle(0, 0, 1, 90),   // axis 0: local x up - stone on its end
  { x: 0, y: 0, z: 0, w: 1 },   // axis 1: local y up - on its edge
  quatAxisAngle(1, 0, 0, -90),  // axis 2: local z up - flat
];
// The turn of a planned stone, reflected across x = 0 for a mirror copy (see the header):
// conjugating by the reflection diag(-1, 1, 1) turns (x, y, z, w) into (x, -y, -z, w).
function planRotation(p) {
  const q = placementRotation(p);
  return p.mirror ? { x: q.x, y: -q.y, z: -q.z, w: q.w } : q;
}

// The list of stones to build: the genome's placements, each followed by its mirror copy if opts.mirror.
export function buildPlan(genome, quarryLength, mirror) {
  if (!mirror) return genome.placements;
  const half = Math.floor(quarryLength / 2);
  const plan = [];
  for (const p of genome.placements) {
    if (p.stone >= half) continue;
    plan.push(p, { ...p, x: -p.x, stone: p.stone + half, mirror: true });
  }
  return plan;
}

export function placementRotation(p) {
  const yaw = quatAxisAngle(0, 1, 0, p.yaw);
  const d = p.tiltDir * Math.PI / 180;
  const tilt = quatAxisAngle(Math.cos(d), 0, Math.sin(d), p.tilt);
  return quatMul(tilt, quatMul(yaw, BASE[p.axis]));
}

// Angle (degrees) between the vertical and the closest of the stone's axes: 0 for a stone lying flat,
// on edge or on end, larger for a tumbled one.
export function levelAngle(rot) {
  const up = Math.max(...[[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((a) => Math.abs(rotatePoint(rot, ...a)[1])));
  return Math.acos(Math.min(1, up)) * 180 / Math.PI;
}

// Highest point of a stone's corners in world space.
export function stoneTop(stone, pos, rot) {
  let top = -Infinity;
  const pts = stone.points;
  for (let i = 0; i < 8; i++) {
    const v = rotatePoint(rot, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    top = Math.max(top, pos.y + v[1]);
  }
  return top;
}

export class Trial {
  // opts: {scaffold: bool, tiltDeg: number, pile?: bool (score - see fitness.js), gateWidth?: number (m, 0 = no gate),
  //        gateArch?: bool (round centering), mirror?: bool (symmetry, see the header),
  //        pedestal?: number (half-size of the pedestal, m; 0 = ground everywhere, see the header),
  //        calmMin?: number (s, defaults to SIM.calmMin; longer = stricter, for checks),
  //        abortBelow?: number - stop as soon as the top is clearly below this score (see below)}
  constructor(R, quarry, genome, opts) {
    this.R = R;
    this.quarry = quarry;
    this.genome = genome;
    this.opts = opts;
    [this.world, this.grounds] = this.makeWorld();
    this.centering = opts.gateWidth && opts.scaffold ? this.addCentering(this.world) : null;
    this.plan = buildPlan(genome, quarry.length, opts.mirror);
    this.items = [];   // [{stone, placement, body, collider, placedY, settledY}] in construction order
    this.grid = new Map();   // "i,j" -> items whose horizontal extent touches the cell (scaffold mode)
    this.builtTop = 0;       // the highest point placed so far
    this.stepCount = 0;
    this.result = null;
  }

  // A world with the simulation settings and the ground: a large fixed slab with its top at y = 0
  // (pedestal mode: the pedestal, top at y = 0, and the floor of the pit). Returns [world, ground colliders].
  makeWorld() {
    const R = this.R;
    const w = new R.World({ x: 0, y: -G, z: 0 });
    w.timestep = SIM.dt;
    w.numSolverIterations = SIM.solverIterations;
    w.integrationParameters.numInternalPgsIterations = SIM.pgsIterations;
    w.integrationParameters.contact_natural_frequency = SIM.contactFrequency;
    w.integrationParameters.normalizedAllowedLinearError = SIM.allowedError;
    const slab = (x, y, z, hx, hy, hz) => w.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setFriction(FRICTION),
      w.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y, z)));
    const p = this.opts.pedestal;
    if (!p) return [w, [slab(0, -0.5, 0, 50, 0.5, 50)]];
    return [w, [slab(0, -PIT_DEPTH / 2, 0, p, PIT_DEPTH / 2, p), slab(0, -PIT_DEPTH - 0.5, 0, 50, 0.5, 50)]];
  }

  // The centering of the gate (see the header) in world w. Returns its collider.
  addCentering(w) {
    const R = this.R;
    const half = this.opts.gateWidth / 2;
    if (this.opts.gateArch) {
      // A cylinder lying along z, its axis on the ground: the half above the ground is the centering.
      const body = w.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 0, 0)
        .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }));
      return w.createCollider(R.ColliderDesc.cylinder(GATE_DEPTH / 2, half).setFriction(FRICTION), body);
    }
    const body = w.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, GATE_HEIGHT / 2, 0));
    return w.createCollider(R.ColliderDesc.cuboid(half, GATE_HEIGHT / 2, GATE_DEPTH / 2).setFriction(FRICTION), body);
  }

  stoneCollider(stone) {
    return this.R.ColliderDesc.convexHull(stone.points).setDensity(DENSITY).setFriction(FRICTION).setRestitution(0);
  }

  // Horizontal extent of a stone at a pose: [xmin, xmax, zmin, zmax, ymax].
  extent(stone, pos, rot) {
    const e = [Infinity, -Infinity, Infinity, -Infinity, -Infinity];
    const pts = stone.points;
    for (let i = 0; i < 8; i++) {
      const v = rotatePoint(rot, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      e[0] = Math.min(e[0], pos.x + v[0]); e[1] = Math.max(e[1], pos.x + v[0]);
      e[2] = Math.min(e[2], pos.z + v[2]); e[3] = Math.max(e[3], pos.z + v[2]);
      e[4] = Math.max(e[4], pos.y + v[1]);
    }
    return e;
  }

  gridAdd(item, e) {
    for (let i = Math.floor(e[0] / GRID); i <= Math.floor(e[1] / GRID); i++) {
      for (let j = Math.floor(e[2] / GRID); j <= Math.floor(e[3] / GRID); j++) {
        const key = `${i},${j}`;
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(item);
      }
    }
  }

  // Placed stones whose cells overlap the horizontal box [x0, x1] x [z0, z1].
  gridQuery(x0, x1, z0, z1) {
    const found = new Set();
    for (let i = Math.floor(x0 / GRID); i <= Math.floor(x1 / GRID); i++) {
      for (let j = Math.floor(z0 / GRID); j <= Math.floor(z1 / GRID); j++) {
        for (const it of this.grid.get(`${i},${j}`) || []) found.add(it);
      }
    }
    return [...found];
  }

  free() {
    if (this.world) { this.world.free(); this.world = null; }
  }

  currentTop() {
    let top = 0;
    for (const it of this.items) top = Math.max(top, stoneTop(it.stone, it.body.translation(), it.body.rotation()));
    return top;
  }

  // Distance a stone at `from` can move along the unit vector `dir` before it touches something
  // (at most maxDist). Casts against colliders directly: the world's own scene queries are refreshed
  // only by a physics step, so they would not see a stone placed a moment ago. With scaffolding only the
  // stones in the grid cells it can reach are tried; without it stones move, so all of them.
  castDistance(stone, shape, from, rot, dir, maxDist) {
    let near = this.items;
    if (this.opts.scaffold) {
      const e = this.extent(stone, from, rot);
      const m = maxDist * Math.hypot(dir.x, dir.z);
      near = this.gridQuery(e[0] - m, e[1] + m, e[2] - m, e[3] + m);
    }
    const obstacles = [...this.grounds, ...near.map((it) => it.collider)];
    if (this.centering) obstacles.push(this.centering);
    const still = { x: 0, y: 0, z: 0 };
    let dist = maxDist;
    for (const c of obstacles) {
      const hit = c.castShape(still, shape, from, rot, dir, 0, dist, true);
      if (hit) dist = Math.min(dist, hit.time_of_impact);
    }
    return dist;
  }

  // Lowers a stone: returns the position of its centre, 2 mm above the first touch.
  lower(stone, p, rot) {
    const shape = new this.R.ConvexPolyhedron(stone.points, null);
    const startY = (this.opts.scaffold ? this.builtTop : this.currentTop()) + 1;
    const pos = { x: p.x, y: startY, z: p.z };
    const depth = startY + 1 + (this.opts.pedestal ? PIT_DEPTH : 0);
    pos.y -= this.castDistance(stone, shape, pos, rot, { x: 0, y: -1, z: 0 }, depth) - GAP;
    return pos;
  }

  // Creates the stone's body in the main world. Returns the item.
  addStone(stone, p, pos, rot, fixed) {
    const R = this.R;
    const desc = (fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
      .setTranslation(pos.x, pos.y, pos.z).setRotation(rot).setCanSleep(false);
    const body = this.world.createRigidBody(desc);
    const collider = this.world.createCollider(this.stoneCollider(stone), body);
    const item = { stone, placement: p, body, collider, placedY: pos.y };
    this.items.push(item);
    const e = this.extent(stone, pos, rot);
    this.builtTop = Math.max(this.builtTop, e[4]);
    if (fixed) this.gridAdd(item, e);
    return item;
  }

  // Bedding under scaffolding, in a small world: the new stone and the placed stones around it.
  // Returns its final pose {pos, rot}. Yields 'build' after every step.
  *bed(stone, at, rot) {
    const R = this.R;
    const [w] = this.makeWorld();
    const e = this.extent(stone, at, rot);
    const m = BED_LIMIT + 0.05;
    for (const it of this.gridQuery(e[0] - m, e[1] + m, e[2] - m, e[3] + m)) {
      const b = w.createRigidBody(R.RigidBodyDesc.fixed()
        .setTranslation(it.body.translation().x, it.body.translation().y, it.body.translation().z)
        .setRotation(it.body.rotation()));
      w.createCollider(this.stoneCollider(it.stone), b);
    }
    if (this.centering) this.addCentering(w);
    const body = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(rot)
      .setCanSleep(false));
    w.createCollider(this.stoneCollider(stone), body);
    const moving = [{ body }];
    let calm = 0;
    for (let s = 0; s < steps(SIM.buildMax); s++) {
      w.step();
      yield { phase: 'build' };
      // Calm for several steps in a row: a rocking stone is slow only for a moment at each turn.
      calm = this.isCalm(moving) ? calm + 1 : 0;
      if (calm >= steps(SIM.buildCalmTime)) break;
      const t = body.translation();
      if (Math.hypot(t.x - at.x, t.y - at.y, t.z - at.z) > BED_LIMIT) break;
    }
    const pose = { pos: body.translation(), rot: body.rotation() };
    w.free();
    return pose;
  }

  // Linear speed below `speed` m/s and angular below 10 * speed rad/s for every stone.
  isCalm(items, speed = CALM_SPEED, ignoreBelow = 0) {
    for (const it of items) {
      if (ignoreBelow && it.body.translation().y < ignoreBelow) continue;
      const v = it.body.linvel();
      const w = it.body.angvel();
      if (Math.hypot(v.x, v.y, v.z) > speed || Math.hypot(w.x, w.y, w.z) > 10 * speed) return false;
    }
    return true;
  }

  step() {
    this.world.step();
    this.stepCount++;
  }

  // Gravity tilted by `deg` from the vertical towards the horizontal direction `dir` (radians from +x).
  setTilt(deg, dir) {
    const s = Math.sin(deg * Math.PI / 180);
    const c = Math.cos(deg * Math.PI / 180);
    this.world.gravity = { x: G * s * Math.cos(dir), y: -G * c, z: G * s * Math.sin(dir) };
  }

  // Early stop for evolution. After the scaffolding is removed the top of a stone structure only
  // goes down, so once it is ABORT_MARGIN below the score to beat, the child cannot win any more.
  // Checked every ABORT_EVERY steps (finding the top costs a pass over all stones).
  shouldAbort() {
    const limit = this.opts.abortBelow;
    if (limit === undefined || this.stepCount % ABORT_EVERY) return false;
    return this.currentTop() < limit - ABORT_MARGIN;
  }

  abortResult() {
    return { score: this.currentTop(), height: this.currentTop(), aborted: true };
  }

  // A structure that is still moving at the end of a "until calm" phase is unstable: score 0.
  // Measuring it as it is would reward slow falls (a 5 m tower, still standing at 3 s, lay at 0.4 m at 10 s).
  unstableResult() {
    return { ...measureStructure(this), score: 0, unstable: true };
  }

  endResult(end) {
    return end === 'aborted' ? this.abortResult() : this.unstableResult();
  }

  // Runs until calm (see the header). A generator, like run();
  // returns 'aborted' (see shouldAbort), 'unstable' (not calm by SIM.calmMax) or null.
  *untilCalm(name) {
    if (SIM.fixedPhase) {
      for (let s = 0; s < steps(SIM.fixedPhase); s++) {
        this.step();
        yield { phase: name };
        if (this.shouldAbort()) return 'aborted';
      }
      return null;
    }
    const min = steps(this.opts.calmMin || SIM.calmMin), max = steps(SIM.calmMax), window = steps(SIM.calmWindow);
    let before = this.items.map((it) => it.body.translation());
    for (let s = 1; s <= max; s++) {
      this.step();
      yield { phase: name };
      if (this.shouldAbort()) return 'aborted';
      if (s % window) continue;
      const now = this.items.map((it) => it.body.translation());
      const low = (1 - SIM.calmTopShare) * this.currentTop();
      let shift = 0;
      now.forEach((p, i) => {
        if (p.y >= low) shift = Math.max(shift, Math.hypot(p.x - before[i].x, p.y - before[i].y, p.z - before[i].z));
      });
      if (s >= min && shift < SIM.calmShift) return null;
      before = now;
    }
    return 'unstable';
  }

  // Yields {phase, ...} after every placement and every physics step; returns the result.
  *run() {
    const seen = new Set();
    for (const p of this.plan) {
      if (seen.has(p.stone) || p.stone >= this.quarry.length) continue;
      seen.add(p.stone);
      const stone = this.quarry[p.stone];
      const rot = planRotation(p);
      const at = this.lower(stone, p, rot);
      if (this.opts.scaffold) {
        const pose = yield* this.bed(stone, at, rot);
        this.addStone(stone, p, pose.pos, pose.rot, true);
        yield { phase: 'place', index: this.items.length - 1 };
        continue;
      }
      // Without scaffolding the whole structure must calm down before the next stone.
      this.addStone(stone, p, at, rot, false);
      yield { phase: 'place', index: this.items.length - 1 };
      let calm = 0;
      for (let s = 0; s < steps(SIM.buildMax); s++) {
        this.step();
        yield { phase: 'build' };
        // Calm for several steps in a row: a rocking stone is slow only for a moment at each turn.
        calm = this.isCalm(this.items) ? calm + 1 : 0;
        if (calm >= steps(SIM.buildCalmTime)) break;
      }
    }
    if (this.opts.scaffold) {
      for (const it of this.items) it.body.setBodyType(this.R.RigidBodyType.Dynamic, true);
      if (this.centering) {
        this.world.removeRigidBody(this.centering.parent());
        this.centering = null;
      }
      yield { phase: 'release' };
    }
    if (this.opts.abortBelow !== undefined && this.currentTop() < this.opts.abortBelow - ABORT_MARGIN) {
      return this.abortResult();
    }
    this.setTilt(0, 0);
    const settleEnd = yield* this.untilCalm('settle');
    if (settleEnd) return this.endResult(settleEnd);
    // Falls are counted against the settled structure, not the construction:
    // a tall stack legitimately sinks a few mm per joint when the scaffolding goes.
    for (const it of this.items) it.settledY = it.body.translation().y;
    const alpha = this.opts.tiltDeg;
    // tiltDeg = 0: no tilt test, the structure only has to stand after the scaffolding is gone.
    if (alpha > 0) {
      const ramp = steps(SIM.rampTime);
      const turn = steps(SIM.turnTime);
      const n = SIM.directions;
      for (let s = 1; s <= ramp; s++) {
        this.setTilt(alpha * s / ramp, 0);
        this.step();
        yield { phase: 'tilt' };
        if (this.shouldAbort()) return this.abortResult();
      }
      for (let k = 0; k < n; k++) {
        const dir = 2 * Math.PI * k / n;
        if (k > 0) {
          for (let s = 1; s <= turn; s++) {
            this.setTilt(alpha, dir - 2 * Math.PI / n * (1 - s / turn));
            this.step();
            yield { phase: 'turn' };
            if (this.shouldAbort()) return this.abortResult();
          }
        }
        const holdEnd = yield* this.untilCalm('hold');
        if (holdEnd) return this.endResult(holdEnd);
      }
      const last = 2 * Math.PI * (n - 1) / n;
      for (let s = ramp - 1; s >= 0; s--) {
        this.setTilt(alpha * s / ramp, last);
        this.step();
        yield { phase: 'untilt' };
        if (this.shouldAbort()) return this.abortResult();
      }
      this.setTilt(0, 0);
      const restEnd = yield* this.untilCalm('rest');
      if (restEnd) return this.endResult(restEnd);
    }
    this.result = measureStructure(this);
    return this.result;
  }
}

// Builds and tests a genome to the end. Returns the result of measureStructure.
export function evaluateGenome(R, quarry, genome, opts) {
  const trial = new Trial(R, quarry, genome, opts);
  try {
    const it = trial.run();
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  } finally {
    trial.free();
  }
}
