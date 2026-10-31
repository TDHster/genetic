'use strict';
// FITNESS: does the bridge stand, and how much steel does it take?
//
// LOADS (kN):
//   - the weight of the road itself: ROAD_LOAD per metre, on the road nodes;
//   - the weight of the steel: every bar hangs half its weight on each end;
//   - a TRUCK of TRUCK_LOAD standing on one road node. It drives across, so we try it on every road node
//     in turn and keep the worst case for every bar (the "envelope").
// CHECKS (all of them for every position of the truck):
//   - a bar in tension holds while its stress N/A is below STEEL_STRESS;
//   - a bar in compression also must not BUCKLE: a long thin bar bows sideways and folds long before
//     the steel itself gives way. Euler's buckling force: π²·E·I / L². Twice longer - four times weaker;
//   - the road must not sag more than span / SAG_LIMIT.
// utilisation u = the worst ratio "load / what it can take" over all bars, positions and the sag. u ≤ 1 - it stands.
//
// What counts: only the part joined to the road. A bar through the ground cannot be built: it is ignored
// (but its steel is counted - it was paid for). Pieces not joined to the road carry nothing and are counted too.
//
// SCORE:
//   - a mechanism (folds up, truss.js): score = 0.5 / (1 + number of free modes): every fixed mode is progress;
//   - stands but breaks (u > 1): score = 0.5 + 0.5 / u;
//   - holds: score = 1 + C_warren / C, where C is the COST of the bridge and C_warren the cost of the reference
//     Warren truss for the same valley. 2 = as good as the reference, above 2 - better. The cost depends on
//     the goal (TASK.mode):
//       'light'    - C = M, the mass of the steel: the lightest bridge that holds the truck;
//       'strength' - C = u·M, steel per unit of strength: the mass the bridge would have if all its sections
//                    were thinned until it is loaded to 100% (roughly). A bridge loaded to 60% wastes 40% of its
//                    steel, so here a small bar that unloads the weakest place pays off at once - in the 'light'
//                    mode it pays off only after other bars get thinner, too.
//   'budget' mode - the STRONGEST bridge from a given amount of steel B (TASK.budget, t). Strength S = 1 / u:
//     how many times all the loads could grow before something breaks (the checks are linear in the loads).
//     - over the budget (M > B): score = 0.5 + 0.5 · x / (1 + x), x = S / S_warren · (B / M)^BUDGET_PENALTY. Such
//       bridges always lose to the ones within the budget, but compete among themselves: the stronger and the less
//       over the budget, the better (thinning all sections by k makes S up to k² times smaller - buckling -
//       while (B/M)^4 grows k⁴ times, so the way into the budget pays off; with the power 2 evolution never got
//       into a budget of 0.5 Warren). A hard wall at the budget (score by B/M only)
//       left evolution stuck far below the reference on tight budgets - the way to a better bridge often
//       goes through "a bit too expensive";
//     - within the budget: score = 1 + S / S_warren, the reference is the Warren truss made as strong as
//       possible from the same steel. Here the bridge does not have to hold the truck: with a small budget
//       nothing may hold it, and still one bridge is stronger than another.

const ROAD_LOAD = 20;      // kN per metre of road
const TRUCK_LOAD = 300;    // kN (a 30 t truck)
const STEEL_STRESS = 2e5;  // kN/m², allowed stress of steel (200 MPa)
const STEEL_WEIGHT = 78.5; // kN/m³
const STEEL_DENSITY = 7.85; // t/m³
const SAG_LIMIT = 250;

const CLASS_NAMES = ['складывается (механизм)', '', '', '', ''];
// The names of classes 1..4 depend on the goal: setTask puts them into CLASS_NAMES.
const MODE_CLASS_NAMES = {
  light: ['стоит, но ломается', 'держит, не легче эталона', 'держит, легче эталона', 'легче эталона в полтора раза'],
  strength: ['стоит, но ломается', 'держит, не эффективнее эталона', 'держит, эффективнее эталона', 'эффективнее эталона в полтора раза'],
  budget: ['стоит, но дороже бюджета', 'в бюджете, не прочнее эталона', 'прочнее эталона', 'прочнее эталона в полтора раза'],
};
const BUDGET_PENALTY = 4; // the power of B / M for bridges over the budget
const BUDGET_STEPS = 400; // limit of the loop that thickens the reference within the budget
const CLASS_COLORS = ['#3a2a5a', '#b3412f', '#d08a2c', '#3fbf5f', '#f0c040'];
const LIGHT_FACTOR = 1.5;

const REFS = {};

// Turn a genome into the truss and test it. detail = true also keeps the forces of every truck position
// (for the picture of the shown bridge).
function evaluateBridge(genome, detail) {
  const D = deckCount();
  // Nodes: the road, then the free ones. Keys -> indices.
  const pts = [], index = new Map();
  for (let i = 0; i < D; i++) { index.set(i, pts.length); pts.push({ key: i, x: i * DECK_STEP, y: 0, fixed: i === 0 || i === D - 1 }); }
  for (const q of genome.nodes) { index.set(q.id, pts.length); pts.push({ key: q.id, x: q.x, y: q.y, fixed: isSupport(q) }); }

  let mass = 0;
  const all = genome.bars.map(([a, b, s]) => {
    const p = pts[index.get(a)], q = pts[index.get(b)];
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    mass += STEEL_DENSITY * SECTIONS[s].A * L;
    const buried = barInGround(p, q);
    return { a: index.get(a), b: index.get(b), s, L, buried, used: false, u: 0 };
  });

  // Joined to the road: walk from the road nodes along the bars that can be built. Supports are walls:
  // we do not walk through the ground to another piece (it would not help the road anyway).
  const reached = new Uint8Array(pts.length);
  const adj = pts.map(() => []);
  all.forEach((bar, e) => { if (!bar.buried && bar.L > 1e-6) { adj[bar.a].push(e); adj[bar.b].push(e); } });
  const stack = [];
  for (let i = 0; i < D; i++) { reached[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    if (pts[i].fixed && i >= D) continue;
    for (const e of adj[i]) {
      const j = all[e].a === i ? all[e].b : all[e].a;
      if (!reached[j]) { reached[j] = 1; stack.push(j); }
    }
  }
  // The truss: reached nodes and the bars between them.
  const tIndex = new Int32Array(pts.length).fill(-1);
  const tNodes = [];
  pts.forEach((p, i) => { if (reached[i]) { tIndex[i] = tNodes.length; tNodes.push(p); } });
  const tBars = [];
  all.forEach((bar, e) => {
    if (bar.buried || bar.L <= 1e-6 || !reached[bar.a] || !reached[bar.b]) return;
    bar.used = true;
    tBars.push({ a: tIndex[bar.a], b: tIndex[bar.b], A: SECTIONS[bar.s].A, e });
  });
  const supports = tNodes.filter((p) => p.fixed).length;
  const truss = makeTruss(tNodes, tBars);
  const base = { pts, bars: all, mass, supports, reached };
  if (truss.mechanism) return { ...base, ...classify({ mechanism: truss.mechanism, mass }) };

  // Load case "dead": the road and the steel.
  const dead = tNodes.map(() => ({ fx: 0, fy: 0 }));
  for (let i = 1; i < D - 1; i++) dead[i].fy -= ROAD_LOAD * DECK_STEP;
  for (const tb of tBars) {
    const w = STEEL_WEIGHT * tb.A * all[tb.e].L / 2;
    dead[tb.a].fy -= w; dead[tb.b].fy -= w;
  }
  const d0 = truss.solve(dead);
  // The truck on every inner road node (on the end nodes it stands on the bank).
  const cases = [];
  for (let i = 1; i < D - 1; i++) {
    const load = tNodes.map(() => null);
    load[i] = { fx: 0, fy: -TRUCK_LOAD };
    cases.push(truss.solve(load));
  }
  // Envelope: the worst tension and the worst compression of every bar over the truck positions.
  let u = 0, worst = null;
  tBars.forEach((tb, k) => {
    const bar = all[tb.e], sec = SECTIONS[bar.s];
    let hi = 0, lo = 0;
    for (const c of cases) { hi = Math.max(hi, c.forces[k]); lo = Math.min(lo, c.forces[k]); }
    const nMax = d0.forces[k] + hi, nMin = d0.forces[k] + lo;
    const strength = sec.A * STEEL_STRESS;
    const buckle = Math.PI * Math.PI * STEEL_E * sec.I / (bar.L * bar.L);
    const ut = Math.max(0, nMax) / strength;
    const uc = Math.max(0, -nMin) / Math.min(strength, buckle);
    bar.nMax = nMax; bar.nMin = nMin;
    bar.u = Math.max(ut, uc);
    bar.why = ut >= uc ? 'растяжение' : buckle < strength ? 'выпучивание' : 'сжатие';
    if (bar.u > u) { u = bar.u; worst = { bar: tb.e, why: bar.why }; }
  });
  let sag = 0;
  for (let i = 1; i < D - 1; i++) {
    for (const c of cases) sag = Math.max(sag, -(d0.disp[i].v + c.disp[i].v));
  }
  const sagU = sag / (TERRAIN.span / SAG_LIMIT);
  if (sagU > u) { u = sagU; worst = { bar: -1, why: 'прогиб' }; }

  const result = { ...base, u, sag, worst, ...classify({ mechanism: 0, u, mass }) };
  if (detail) {
    // Forces and displacements for a truck at road node i (i = 0: no truck), indexed like `pts`.
    result.state = (i) => {
      const forces = all.map(() => 0), disp = pts.map(() => ({ u: 0, v: 0 }));
      const c = i >= 1 && i <= D - 2 ? cases[i - 1] : null;
      tBars.forEach((tb, k) => { forces[tb.e] = d0.forces[k] + (c ? c.forces[k] : 0); });
      tNodes.forEach((p, k) => {
        const j = pts.indexOf(p);
        disp[j] = { u: d0.disp[k].u + (c ? c.disp[k].u : 0), v: d0.disp[k].v + (c ? c.disp[k].v : 0) };
      });
      return { forces, disp };
    };
  }
  return result;
}

const bridgeCost = (u, mass) => (TASK.mode === 'strength' ? u * mass : mass);

function classify(m) {
  if (m.mechanism) return { cls: 0, score: 0.5 / (1 + m.mechanism), mechanism: m.mechanism };
  if (TASK.mode === 'budget') {
    if (m.mass > TASK.budget) {
      // Over the budget: below every bridge within it, but a strong one is still better than a weak one.
      const ref = REFS.warren ? REFS.warren.strength : 1 / m.u;
      const x = (1 / m.u / ref) * Math.pow(TASK.budget / m.mass, BUDGET_PENALTY);
      return { cls: 1, score: 0.5 + 0.5 * x / (1 + x), mechanism: 0 };
    }
    const strength = 1 / m.u;
    const ref = REFS.warren ? REFS.warren.strength : strength;
    const cls = strength <= ref ? 2 : strength < ref * LIGHT_FACTOR ? 3 : 4;
    return { cls, score: 1 + strength / ref, strength, mechanism: 0 };
  }
  if (m.u > 1) return { cls: 1, score: 0.5 + 0.5 / m.u, mechanism: 0 };
  const cost = bridgeCost(m.u, m.mass);
  const ref = REFS.warren ? REFS.warren.cost : cost;
  const cls = cost >= ref ? 2 : cost * LIGHT_FACTOR > ref ? 3 : 4;
  return { cls, score: 1 + ref / cost, cost, mechanism: 0 };
}

// THE REFERENCE: a Warren truss - the classic railway bridge. Triangles over the road, a top chord
// at height h, no supports but the two banks. Its sections are picked by the usual engineer's loop:
// start thin, make every overloaded bar one size thicker, test again. We try a few heights and keep the best
// one for the goal (the lightest, or the one with the least steel per unit of strength).
// For the 'budget' goal the loop is different (fillBudget): start thin, make the most loaded bar one size
// thicker while the steel stays within the budget, keep the strongest height.
function warrenGenome(h) {
  const D = deckCount();
  const genome = { nodes: [], bars: [] };
  for (let i = 0; i < D - 1; i++) genome.bars.push([i, i + 1, 0]);
  const top = [];
  for (let i = 0; i < D - 1; i++) {
    const id = nextNodeId++;
    top.push(id);
    genome.nodes.push({ id, x: (i + 0.5) * DECK_STEP, y: h });
    genome.bars.push([i, id, 0], [i + 1, id, 0]);
    if (i) genome.bars.push([top[i - 1], id, 0]);
  }
  return genome;
}

function sizeUp(genome) {
  for (let pass = 0; pass < 30; pass++) {
    const r = evaluateBridge(genome);
    if (r.mechanism) return null;
    if (r.u <= 1) return { genome, ...r };
    let changed = false;
    r.bars.forEach((bar, e) => {
      // Overloaded bars one size up; if only the sag fails, all bars that are not yet the thickest.
      if ((bar.u > 1 || r.worst.why === 'прогиб') && bar.s < SECTIONS.length - 1) {
        genome.bars[e][2]++;
        changed = true;
      }
    });
    if (!changed) return null;
  }
  return null;
}

function fillBudget(genome) {
  let r = null;
  for (let step = 0; step < BUDGET_STEPS; step++) {
    r = evaluateBridge(genome);
    if (r.mechanism) return null;
    // The most loaded bar that can still grow (the sag counts too: then the most loaded bar helps most).
    let pick = -1;
    r.bars.forEach((bar, e) => { if (bar.s < SECTIONS.length - 1 && (pick < 0 || bar.u > r.bars[pick].u)) pick = e; });
    if (pick < 0) break;
    const bar = r.bars[pick];
    const extra = STEEL_DENSITY * (SECTIONS[bar.s + 1].A - SECTIONS[bar.s].A) * bar.L;
    if (r.mass + extra > TASK.budget) break;
    genome.bars[pick][2]++;
  }
  return r.mass <= TASK.budget ? { genome, ...r } : null;
}

function setTask(task) {
  Object.assign(TASK, task);
  CLASS_NAMES.splice(1, 4, ...MODE_CLASS_NAMES[TASK.mode]);
  TASK.budget = Infinity; // set below, from the Warren truss
  makeTerrain(TASK.terrainSeed);
  for (const key of Object.keys(REFS)) delete REFS[key];
  resetNodeIds();
  let best = null;
  for (const k of [4, 5, 6, 7, 8, 10, 12]) {
    const r = sizeUp(warrenGenome(TERRAIN.span / k));
    if (r && (!best || bridgeCost(r.u, r.mass) < bridgeCost(best.u, best.mass))) best = r;
  }
  if (TASK.mode === 'budget') {
    // The budget: the steel of the lightest Warren truss (found above) times the factor;
    // 0.15 t per metre of the span if no Warren truss holds.
    TASK.budget = (TASK.budgetFactor || 1) * (best ? best.mass : 0.15 * TERRAIN.span);
    best = null;
    for (const k of [4, 5, 6, 7, 8, 10, 12]) {
      const r = fillBudget(warrenGenome(TERRAIN.span / k));
      if (r && (!best || r.u < best.u)) best = r;
    }
  }
  // Ids of the reference nodes are not reused by the genomes of evolution.
  REFS.warren = best ? { name: 'ферма Уоррена', ...best, cost: bridgeCost(best.u, best.mass), strength: 1 / best.u } : null;
  if (REFS.warren) Object.assign(REFS.warren, classify({ mechanism: 0, u: REFS.warren.u, mass: REFS.warren.mass }));
}
