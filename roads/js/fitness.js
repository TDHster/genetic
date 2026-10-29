'use strict';
// FITNESS: how short is the road network?
//
// The nodes are the cities plus the junctions from the genome. Roads are straight lines between nodes.
// For a fixed set of nodes the shortest connected network is the MINIMUM SPANNING TREE (MST):
// Prim's algorithm grows it from one node, every time adding the shortest road from the tree
// to a node not yet in it. This part is exact and fast, so evolution only has to place the junctions.
//
// Without junctions the answer is the MST of the cities themselves - the best network that uses
// only roads from city to city. With junctions it can be shorter: three cities are joined best
// by three roads meeting at one point (the Fermat point), not by two sides of the triangle.
// The shortest network with junctions allowed is the STEINER TREE. Known facts about it:
//   - every useful junction has exactly 3 roads meeting at 120°;
//   - it is never shorter than √3/2 ≈ 0.866 of the MST (the Steiner ratio), so the gain is at most 13.4%;
//   - finding it is hard (NP-hard): no fast exact method is known for many cities.
//
// SCORE = L_MST / L: 1 means "as long as the MST", above 1 - shorter.
// A junction with 1 road only adds a dead end, with 2 roads - a bend; both are useless,
// but they do not break the network: the score simply counts their length.

// Minimum spanning tree of the points (Prim, O(V²) - fine for a hundred nodes).
// Returns { length, edges: [[i, j], ...] } with indices into `nodes`.
function mst(nodes) {
  const n = nodes.length;
  const inTree = new Uint8Array(n);
  const dist = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const edges = [];
  let length = 0;
  dist[0] = 0;
  for (let step = 0; step < n; step++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || dist[i] < dist[u])) u = i;
    inTree[u] = 1;
    if (from[u] >= 0) { edges.push([from[u], u]); length += dist[u]; }
    const p = nodes[u];
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const d = Math.hypot(nodes[i].x - p.x, nodes[i].y - p.y);
      if (d < dist[i]) { dist[i] = d; from[i] = u; }
    }
  }
  return { length, edges };
}

// The Fermat point of a triangle: the point with the smallest sum of distances to the corners
// (Weiszfeld's iterations). If one angle is 120° or more, the answer is that corner itself.
function fermatPoint(a, b, c) {
  const corners = [a, b, c];
  for (let k = 0; k < 3; k++) {
    const p = corners[k], q = corners[(k + 1) % 3], r = corners[(k + 2) % 3];
    const cos = ((q.x - p.x) * (r.x - p.x) + (q.y - p.y) * (r.y - p.y)) /
      (Math.hypot(q.x - p.x, q.y - p.y) * Math.hypot(r.x - p.x, r.y - p.y));
    if (cos <= -0.5) return null; // angle >= 120°: no junction needed
  }
  let x = (a.x + b.x + c.x) / 3, y = (a.y + b.y + c.y) / 3;
  for (let it = 0; it < 200; it++) {
    let sx = 0, sy = 0, sw = 0;
    for (const p of corners) {
      const w = 1 / Math.max(1e-12, Math.hypot(p.x - x, p.y - y));
      sx += p.x * w; sy += p.y * w; sw += w;
    }
    x = sx / sw; y = sy / sw;
  }
  return { x, y };
}

// The known exact answer (as junctions) for the ready-made maps; null for random cities.
function exactJunctions() {
  if (TASK.map === 'triangle') {
    const f = fermatPoint(...CITIES);
    return f ? [f] : [];
  }
  if (TASK.map === 'square') {
    // Two junctions on the middle line, each joined to two neighbouring corners at 120°.
    const [a, b, , d] = CITIES;
    const s = b.x - a.x, cy = (a.y + d.y) / 2, off = s / (2 * Math.sqrt(3));
    return [{ x: a.x + off, y: cy }, { x: b.x - off, y: cy }];
  }
  if (TASK.map === 'hexagon') return []; // regular hexagon: the MST (5 sides) is already optimal
  return null;
}

const STEINER_RATIO = Math.sqrt(3) / 2;

// Classes: the first three by length, the last two by the shape of the answer.
const CLASS_NAMES = ['длиннее остова', 'как остов', 'короче остова', 'короче, все развилки под 120°', 'точный ответ'];
const CLASS_COLORS = ['#1b2a6b', '#7a3b8f', '#3fd0d6', '#3fbf5f', '#f0c040'];
const SAME_LENGTH = 1e-4; // within 0.01% counts as "the same length" (rounding, a junction on a straight road)

// References, recomputed by setTask(): the MST of the cities, the lower bound, the exact answer if known.
const REFS = {};

function setTask(task) {
  Object.assign(TASK, task);
  CITIES.length = 0;
  CITIES.push(...makeCities(TASK));
  // The MST first: scores and classes are measured against it.
  const m = mst(CITIES);
  REFS.mst = { key: 'mst', name: 'остов без развилок', junctionInfo: [], length: m.length, edges: m.edges };
  REFS.bound = { length: STEINER_RATIO * m.length };
  delete REFS.exact;
  const exact = exactJunctions();
  if (exact) REFS.exact = { key: 'exact', name: 'точный ответ', ...evaluateRoads({ junctions: exact }) };
  // Classes need the exact length, so classify the references after it is known.
  Object.assign(REFS.mst, classify({ length: m.length, junctionInfo: [] }));
  if (REFS.exact) Object.assign(REFS.exact, classify(REFS.exact));
}

// Length of a reference, Infinity if there is none.
function refLength(key) {
  return REFS[key] ? REFS[key].length : Infinity;
}

// Gain over the MST: 0.05 = 5% shorter, negative = longer.
function gainOverMst(length) {
  return 1 - length / REFS.mst.length;
}

// net: { length, junctionInfo: junctionStats(...) }.
function classify(net) {
  const gain = gainOverMst(net.length);
  let cls;
  if (REFS.exact && net.length <= REFS.exact.length * (1 + SAME_LENGTH)) cls = 4;
  else if (gain < -SAME_LENGTH) cls = 0;
  else if (gain < SAME_LENGTH) cls = 1;
  else if (net.junctionInfo.every((j) => j.useless || j.at120)) cls = 3;
  else cls = 2;
  return { cls, score: REFS.mst.length / net.length };
}

function evaluateRoads(genome) {
  const nodes = CITIES.concat(genome.junctions);
  const m = mst(nodes);
  const net = { nodes, length: m.length, edges: m.edges };
  net.junctionInfo = junctionStats(net);
  return { ...net, ...classify(net) };
}

// For every junction: its roads and the angles between them (for the classes and the panels).
function junctionStats(net) {
  const nc = CITIES.length;
  const roads = net.nodes.map(() => []);
  for (const [i, j] of net.edges) { roads[i].push(j); roads[j].push(i); }
  return net.nodes.slice(nc).map((p, k) => {
    const dirs = roads[nc + k].map((j) => Math.atan2(net.nodes[j].y - p.y, net.nodes[j].x - p.x)).sort((a, b) => a - b);
    const angles = dirs.map((a, i) => ((i + 1 < dirs.length ? dirs[i + 1] : dirs[0] + 2 * Math.PI) - a) * 180 / Math.PI);
    const degree = dirs.length;
    // "At 120°": three roads, every angle within 5° of 120.
    const at120 = degree === 3 && angles.every((a) => Math.abs(a - 120) < 5);
    return { p, degree, angles: degree >= 2 ? angles : [], useless: degree <= 2, at120 };
  });
}
