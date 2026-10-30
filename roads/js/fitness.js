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
// In the 'roads' mode (TASK.mode) the roads come from the genome instead of the MST. Then a network
// can leave cities unconnected, and it can have extra roads (rings, dead ends) that only add length.
//
// In the 'routes' mode (roads also from the genome) the goal is not only short roads but also short TRIPS.
// The COST of a network mixes the two, w = TASK.tripShare (the slider, 0..1):
//   C = (1 − w) · L / L_MST + w · T / T_straight,
// L - length of the roads, T - average shortest path by road between two cities (all pairs),
// T_straight - average straight-line distance between two cities (as if every pair had a direct road).
// Both parts are 1 for "as good as the reference": the MST for the roads, straight lines for the trips.
// w = 0: only building counts, the answer is the Steiner tree. The bigger w, the more a direct road
// between cities is worth: rings and chords appear, trips get shorter, the roads get longer.
// w = 1: only trips count, the answer is a direct road between every pair of cities.
// In the other modes the cost is just the length L.
//
// SCORE:
//   - not all cities are connected (only possible when the roads are in the genome): the share of cities
//     in the largest connected piece of the network, 0..1;
//   - all connected: 1 + C_MST / C, where C_MST is the cost of the MST of the cities.
//     2 means "as good as the MST", above 2 - better.
// So any connected network beats any broken one, and among connected ones the cheaper wins.
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

// Classes: broken network, then three by length, the last two by the shape of the answer.
// The 'routes' mode has its own classes (setTask picks them): there the shape that matters is rings.
const TREE_CLASSES = ['не все города связаны', 'длиннее остова', 'как остов', 'короче остова', 'короче, все развилки под 120°', 'точный ответ'];
const ROUTE_CLASSES = ['не все города связаны', 'хуже остова', 'как остов', 'лучше остова: дерево', 'лучше остова: с кольцами'];
let CLASS_NAMES = TREE_CLASSES;
const CLASS_COLORS = ['#3a1020', '#1b2a6b', '#7a3b8f', '#3fd0d6', '#3fbf5f', '#f0c040'];
const SAME_LENGTH = 1e-4; // within 0.01% counts as "the same length" (rounding, a junction on a straight road)

// References, recomputed by setTask(): the MST of the cities, the lower bound, the exact answer if known.
const REFS = {};

function setTask(task) {
  Object.assign(TASK, task);
  CITIES.length = 0;
  CITIES.push(...makeCities(TASK));
  resetJunctionIds();
  CLASS_NAMES = TASK.mode === 'routes' ? ROUTE_CLASSES : TREE_CLASSES;
  // The MST first: scores and classes are measured against it.
  const m = mst(CITIES);
  REFS.straight = averageStraight();
  REFS.mst = { key: 'mst', name: 'остов без развилок', nodes: CITIES.slice(), junctionInfo: [], length: m.length, edges: m.edges, roadCount: m.edges.length,
    connected: true, share: 1, extra: 0 };
  Object.assign(REFS.mst, networkCost(REFS.mst));
  REFS.bound = { length: STEINER_RATIO * m.length };
  delete REFS.exact;
  // The exact Steiner tree is the answer only when the length alone counts.
  const exact = TASK.mode === 'routes' ? null : exactJunctions();
  if (exact) REFS.exact = { key: 'exact', name: 'точный ответ', ...evaluateTree({ junctions: exact }) };
  // Classes need the exact length, so classify the references after it is known.
  Object.assign(REFS.mst, classify(REFS.mst));
  if (REFS.exact) Object.assign(REFS.exact, classify(REFS.exact));
}

// The trip share w can change during a run (the slider): the MST cost and the classes of the references
// change with it. The pool is re-scored by Evolution.rescore().
function setTripShare(w) {
  TASK.tripShare = w;
  Object.assign(REFS.mst, networkCost(REFS.mst));
  Object.assign(REFS.mst, classify(REFS.mst));
}

// Length of a reference, Infinity if there is none.
function refLength(key) {
  return REFS[key] ? REFS[key].length : Infinity;
}

// Cost of a reference (= length unless the mode is 'routes'), Infinity if there is none.
function refCost(key) {
  return REFS[key] ? REFS[key].cost : Infinity;
}

// Gain over the MST: 0.05 = 5% shorter, negative = longer.
function gainOverMst(length) {
  return 1 - length / REFS.mst.length;
}

// Cost of a connected network: the length, or in the 'routes' mode the mix of length and trips (see the top).
// Returns { cost, trip, detour }: trip - average shortest path between two cities by road,
// detour - average of (path by road / straight line), 1 = every trip goes straight.
function networkCost(net) {
  if (TASK.mode !== 'routes') return { cost: net.length };
  const { trip, detour } = tripStats(net);
  const w = TASK.tripShare;
  return { cost: (1 - w) * net.length / REFS.mst.length + w * trip / REFS.straight, trip, detour };
}

// Average straight-line distance between two cities: the trip if every pair had a direct road.
function averageStraight() {
  let sum = 0, pairs = 0;
  for (let s = 0; s < CITIES.length; s++) {
    for (let t = s + 1; t < CITIES.length; t++) { sum += Math.hypot(CITIES[s].x - CITIES[t].x, CITIES[s].y - CITIES[t].y); pairs++; }
  }
  return sum / pairs;
}

// Shortest paths by road from every city to every other one (Dijkstra, O(V²) per city).
function tripStats(net) {
  const n = CITIES.length, V = net.nodes.length;
  const adj = net.nodes.map(() => []);
  for (const [i, j] of net.edges) {
    const d = Math.hypot(net.nodes[i].x - net.nodes[j].x, net.nodes[i].y - net.nodes[j].y);
    adj[i].push(j, d); adj[j].push(i, d);
  }
  let sum = 0, detour = 0, pairs = 0;
  const dist = new Float64Array(V), done = new Uint8Array(V);
  for (let s = 0; s < n - 1; s++) {
    dist.fill(Infinity); done.fill(0); dist[s] = 0;
    for (let step = 0; step < V; step++) {
      let u = -1;
      for (let i = 0; i < V; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (dist[u] === Infinity) break;
      done[u] = 1;
      const a = adj[u];
      for (let k = 0; k < a.length; k += 2) if (dist[u] + a[k + 1] < dist[a[k]]) dist[a[k]] = dist[u] + a[k + 1];
    }
    for (let t = s + 1; t < n; t++) {
      sum += dist[t];
      detour += dist[t] / Math.hypot(CITIES[s].x - CITIES[t].x, CITIES[s].y - CITIES[t].y);
      pairs++;
    }
  }
  return { trip: sum / pairs, detour: detour / pairs };
}

// net: { connected, share, length, cost, extra, junctionInfo: junctionStats(...) }.
function classify(net) {
  if (!net.connected) return { cls: 0, score: net.share };
  const score = 1 + REFS.mst.cost / net.cost;
  if (TASK.mode === 'routes') {
    const gain = 1 - net.cost / REFS.mst.cost;
    const cls = gain < -SAME_LENGTH ? 1 : gain < SAME_LENGTH ? 2 : net.extra ? 4 : 3;
    return { cls, score };
  }
  const gain = gainOverMst(net.length);
  let cls;
  if (REFS.exact && net.length <= REFS.exact.length * (1 + SAME_LENGTH)) cls = 5;
  else if (gain < -SAME_LENGTH) cls = 1;
  else if (gain < SAME_LENGTH) cls = 2;
  else if (net.junctionInfo.every((j) => j.useless || j.at120)) cls = 4;
  else cls = 3;
  return { cls, score };
}

function evaluateRoads(genome) {
  return roadsInGenome() ? evaluateFree(genome) : evaluateTree(genome);
}

// 'tree' mode: the roads are the MST of cities + junctions.
function evaluateTree(genome) {
  const nodes = CITIES.concat(genome.junctions);
  const m = mst(nodes);
  const net = { nodes, length: m.length, cost: m.length, edges: m.edges, roadCount: m.edges.length, connected: true, share: 1, extra: 0 };
  net.junctionInfo = junctionStats(net);
  return { ...net, ...classify(net) };
}

// 'roads' and 'routes' modes: the roads are taken from the genome as they are.
// Where two roads cross, there is a CROSSROADS: a node of the network like a junction, only not in the genome.
// It does not change the length, but a trip can turn there, and two crossing roads are connected.
function evaluateFree(genome) {
  const n = CITIES.length;
  const own = CITIES.concat(genome.junctions);
  const index = new Map(genome.junctions.map((j, k) => [j.id, n + k]));
  const at = (key) => (key < n ? key : index.get(key));
  const roads = genome.roads.map(([a, b]) => [at(a), at(b)]);
  let length = 0;
  for (const [i, j] of roads) length += Math.hypot(own[i].x - own[j].x, own[i].y - own[j].y);
  const { nodes, edges } = addCrossroads(own, roads);
  // Union-find: which nodes are connected to which.
  const parent = nodes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  let extra = 0;
  for (const [i, j] of edges) {
    const ri = find(i), rj = find(j);
    if (ri === rj) extra++; // closes a ring: some road of the ring is not needed for connectivity
    else parent[ri] = rj;
  }
  // The largest piece by the number of cities in it.
  const citiesIn = new Map();
  for (let i = 0; i < n; i++) citiesIn.set(find(i), (citiesIn.get(find(i)) || 0) + 1);
  let main = -1, largest = 0;
  for (const [root, count] of citiesIn) if (count > largest) { largest = count; main = root; }
  const linked = CITIES.map((_, i) => find(i) === main);
  const net = { nodes, length, edges, roadCount: roads.length, firstCrossroads: own.length, connected: largest === n, share: largest / n, extra, linked };
  // Trips are counted only when every city can be reached.
  if (net.connected) Object.assign(net, networkCost(net));
  net.junctionInfo = junctionStats(net);
  return { ...net, ...classify(net) };
}

// Cut the roads where they cross. Returns { nodes: the given nodes + one node per crossing, edges: the pieces }.
// Roads that share an end do not cross. O(roads²) - fine for a few dozen roads.
function addCrossroads(own, roads) {
  const nodes = own.slice();
  const cuts = roads.map(() => []); // [position along the road 0..1, node index]
  for (let r = 0; r < roads.length; r++) {
    const [a, b] = roads[r];
    const p = own[a], rx = own[b].x - p.x, ry = own[b].y - p.y;
    for (let q = r + 1; q < roads.length; q++) {
      const [c, d] = roads[q];
      if (a === c || a === d || b === c || b === d) continue;
      const x = segmentCrossing(p, own[b], own[c], own[d]);
      if (!x) continue;
      const k = nodes.length;
      nodes.push({ x: p.x + x.t * rx, y: p.y + x.t * ry });
      cuts[r].push([x.t, k]);
      cuts[q].push([x.u, k]);
    }
  }
  const edges = [];
  roads.forEach(([a, b], r) => {
    let prev = a;
    for (const [, k] of cuts[r].sort((x, y) => x[0] - y[0])) { edges.push([prev, k]); prev = k; }
    edges.push([prev, b]);
  });
  return { nodes, edges };
}

// For every junction (and crossroads): its roads and the angles between them (for the classes and the panels).
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
    const crossroads = net.firstCrossroads !== undefined && nc + k >= net.firstCrossroads;
    return { p, degree, angles: degree >= 2 ? angles : [], useless: degree <= 2, at120, crossroads };
  });
}
