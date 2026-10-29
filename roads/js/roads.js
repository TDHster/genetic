'use strict';
// THE ROAD NETWORK: what evolves and what a genome turns into.
//
// Cities are fixed by the task. The genome always has JUNCTIONS: extra points in the field
// where roads may meet (Steiner points). Two modes (TASK.mode):
//   - 'tree': the roads are NOT in the genome. For any set of points (cities + junctions) the shortest
//     tree that connects them is known exactly - the minimum spanning tree (see fitness.js).
//     Evolution only answers "where to put the junctions and how many", every genome is a valid network;
//   - 'roads': the roads ARE in the genome too, as pairs of nodes. A random genome is a tangle of long
//     roads, often with cities left unconnected. Evolution has to learn everything itself: connect all
//     the cities, drop the extra roads, and only then place the junctions.
//
// Coordinates are kilometres on a map MAP_W × MAP_H.

const MAP_W = 100;
const MAP_H = 70;

// The task: which cities to connect. Filled by setTask() in fitness.js.
//   map: 'trilattice' | 'grid' | 'random' | 'triangle' | 'square' | 'hexagon'; cities: how many (random map only);
//   mapSeed: seed of the random map (separate from the evolution seed: same map, different runs).
//   mode: 'tree' | 'roads' (see above).
const TASK = { map: 'trilattice', cities: 20, mapSeed: 1, mode: 'roads' };
// City positions of the current task (filled by setTask).
const CITIES = [];

const MAP_NAMES = {
  trilattice: 'треугольная решётка',
  grid: 'квадратная сетка',
  random: 'случайные города',
  triangle: 'три города',
  square: 'квадрат',
  hexagon: 'шестиугольник',
};

// City positions for the task.
function makeCities(task) {
  const cx = MAP_W / 2, cy = MAP_H / 2;
  if (task.map === 'triangle') return [{ x: 15, y: 58 }, { x: 88, y: 50 }, { x: 42, y: 8 }];
  if (task.map === 'square') {
    const s = 56;
    return [{ x: cx - s / 2, y: cy - s / 2 }, { x: cx + s / 2, y: cy - s / 2 }, { x: cx + s / 2, y: cy + s / 2 }, { x: cx - s / 2, y: cy + s / 2 }];
  }
  if (task.map === 'hexagon') {
    const r = 31;
    return [0, 1, 2, 3, 4, 5].map((k) => ({ x: cx + r * Math.cos(k * Math.PI / 3), y: cy + r * Math.sin(k * Math.PI / 3) }));
  }
  if (task.map === 'trilattice') {
    // 4 rows of 4, every row shifted by half a step: all neighbours at the same distance (equilateral triangles).
    const step = 20, rowH = step * Math.sqrt(3) / 2, cities = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) cities.push({ x: cx + (i - 1.75 + (j % 2) / 2) * step, y: cy + (j - 1.5) * rowH });
    return cities;
  }
  if (task.map === 'grid') {
    const step = 17, cities = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) cities.push({ x: cx + (i - 2) * step, y: cy + (j - 1.5) * step });
    return cities;
  }
  // Random cities, not closer than minGap to each other (otherwise two dots merge on the map).
  const rng = makeRng(task.mapSeed);
  const n = task.cities;
  const margin = 4;
  const minGap = Math.min(8, 0.6 * Math.sqrt(MAP_W * MAP_H / n));
  const cities = [];
  for (let tries = 0; cities.length < n && tries < 100000; tries++) {
    const p = { x: margin + rng.next() * (MAP_W - 2 * margin), y: margin + rng.next() * (MAP_H - 2 * margin) };
    if (cities.every((c) => Math.hypot(c.x - p.x, c.y - p.y) >= minGap)) cities.push(p);
  }
  return cities;
}

// More than n − 2 junctions never help: a Steiner tree for n cities has at most n − 2 of them.
function maxJunctions() {
  return Math.max(0, CITIES.length - 2);
}

function randomPoint(rng) {
  return { x: rng.next() * MAP_W, y: rng.next() * MAP_H };
}

// Junctions of the 'roads' mode have an id, so that roads can refer to them while junctions come and go.
// Node keys in roads: a city is its index 0..n−1, a junction is its id (n, n+1, ...).
let nextJunctionId = 0;
function resetJunctionIds() {
  nextJunctionId = CITIES.length;
}

function randomRoads(rng) {
  return TASK.mode === 'roads' ? randomRoadsFree(rng) : randomRoadsTree(rng);
}
function crossover(mom, dad, rng) {
  return TASK.mode === 'roads' ? crossoverFree(mom, dad, rng) : crossoverTree(mom, dad, rng);
}
function mutate(genome, rng) {
  return TASK.mode === 'roads' ? mutateFree(genome, rng) : mutateTree(genome, rng);
}

// A random straight line across the map: side(q) tells which side of it the point q is on.
function randomCut(rng) {
  const p = randomPoint(rng);
  const a = rng.next() * Math.PI;
  const nx = Math.cos(a), ny = Math.sin(a);
  return (q) => (q.x - p.x) * nx + (q.y - p.y) * ny >= 0;
}

// ===== Mode 'tree': only junctions in the genome =====

// Starting pool: from 1 to n − 2 junctions at random places. At least one junction on purpose:
// a network without junctions is the plain spanning tree, which is already good, and the evolution
// would start from it instead of finding its way. Most random networks are longer than the spanning
// tree: a junction in a random place only adds a detour.
function randomRoadsTree(rng) {
  const k = 1 + rng.int(maxJunctions());
  const junctions = [];
  for (let i = 0; i < k; i++) junctions.push(randomPoint(rng));
  return { junctions };
}

// CROSSOVER: cut the map with a random straight line. Junctions on one side come from mom,
// on the other side from dad. Junctions matter locally (each one serves the cities around it),
// so a cut through the map keeps the good local pieces of both parents.
function crossoverTree(mom, dad, rng) {
  const side = randomCut(rng);
  const junctions = mom.junctions.filter(side).concat(dad.junctions.filter((q) => !side(q))).map((q) => ({ ...q }));
  // Too many after the cut: drop random ones.
  while (junctions.length > maxJunctions()) junctions.splice(rng.int(junctions.length), 1);
  return { junctions };
}

const fmtPoint = (q) => `(${q.x.toFixed(1)}; ${q.y.toFixed(1)})`;
const clampX = (x) => Math.min(MAP_W, Math.max(0, x));
const clampY = (y) => Math.min(MAP_H, Math.max(0, y));

// MUTATION: one random change. Returns a short description for the "last mating" panel.
//   - small shift of one junction (40%): fine-tuning, this is how junctions settle at 120°;
//   - big shift of one junction (15%);
//   - new junction near a random city or junction (15%) or anywhere on the map (10%);
//   - one junction removed (20%).
// None of them knows the answer (no "put it at the Fermat point"): the changes are blind,
// only selection decides what stays.
function mutateTree(genome, rng) {
  const js = genome.junctions;
  const fmt = fmtPoint;
  const r = rng.next();
  let op = r < 0.4 ? 'small' : r < 0.55 ? 'big' : r < 0.7 ? 'near' : r < 0.8 ? 'anywhere' : 'remove';
  // Impossible operations turn into possible ones: nothing to move or remove -> add; no room to add -> move.
  if (!js.length && (op === 'small' || op === 'big' || op === 'remove')) op = 'near';
  if (js.length >= maxJunctions() && (op === 'near' || op === 'anywhere')) op = 'small';
  if (!js.length && op === 'small') return 'нечего менять';

  if (op === 'small' || op === 'big') {
    const i = rng.int(js.length);
    const sigma = op === 'big' ? 10 : 1;
    js[i] = { x: clampX(js[i].x + sigma * rng.normal()), y: clampY(js[i].y + sigma * rng.normal()) };
    return `${op === 'big' ? 'большой' : 'малый'} сдвиг развилки ${i + 1} → ${fmt(js[i])}`;
  }
  if (op === 'remove') {
    const [q] = js.splice(rng.int(js.length), 1);
    return `удалена развилка ${fmt(q)}`;
  }
  let q;
  if (op === 'near') {
    const nodes = CITIES.concat(js);
    const c = nodes[rng.int(nodes.length)];
    q = { x: clampX(c.x + 6 * rng.normal()), y: clampY(c.y + 6 * rng.normal()) };
  } else {
    q = randomPoint(rng);
  }
  js.push(q);
  return `новая развилка ${fmt(q)}${op === 'near' ? ' рядом с узлом' : ' в случайном месте'}`;
}

// ===== Mode 'roads': junctions and roads in the genome =====
// genome = { junctions: [{ id, x, y }], roads: [[a, b], ...] } with node keys (see nextJunctionId).

// Position of a node by its key.
function nodeByKey(genome, key) {
  return key < CITIES.length ? CITIES[key] : genome.junctions.find((j) => j.id === key);
}

function allKeys(genome) {
  return CITIES.map((_, i) => i).concat(genome.junctions.map((j) => j.id));
}

// One of the k nodes nearest to `key` (not itself): new roads mostly go to neighbours,
// as a builder would do, but which neighbour is random.
function nearKey(genome, key, rng, k = 4) {
  const p = nodeByKey(genome, key);
  const others = allKeys(genome).filter((q) => q !== key);
  const d = (q) => { const o = nodeByKey(genome, q); return Math.hypot(o.x - p.x, o.y - p.y); };
  others.sort((a, b) => d(a) - d(b));
  return others[rng.int(Math.min(k, others.length))];
}

const roadKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
function hasRoad(genome, a, b) {
  return genome.roads.some(([u, v]) => (u === a && v === b) || (u === b && v === a));
}

// Starting pool: up to n − 2 junctions at random places and from n/2 to 2n roads between random nodes -
// a tangle of long roads across the map. Usually some cities stay unconnected.
function randomRoadsFree(rng) {
  const n = CITIES.length;
  const junctions = [];
  const k = rng.int(maxJunctions() + 1);
  for (let i = 0; i < k; i++) junctions.push({ id: nextJunctionId++, ...randomPoint(rng) });
  const genome = { junctions, roads: [] };
  const keys = allKeys(genome);
  const m = rng.intRange(Math.ceil(n / 2), 2 * n);
  for (let i = 0; i < m; i++) {
    const a = keys[rng.int(keys.length)], b = keys[rng.int(keys.length)];
    if (a !== b && !hasRoad(genome, a, b)) genome.roads.push([a, b]);
  }
  return genome;
}

// CROSSOVER: the same random cut. Junctions and roads (by their middle point) on one side come from mom,
// on the other side from dad. Roads to a junction that the child did not get are dropped.
function crossoverFree(mom, dad, rng) {
  const side = randomCut(rng);
  const junctions = [];
  const seen = new Set();
  for (const j of mom.junctions.filter(side).concat(dad.junctions.filter((q) => !side(q)))) {
    if (!seen.has(j.id)) { seen.add(j.id); junctions.push({ ...j }); }
  }
  while (junctions.length > maxJunctions()) junctions.splice(rng.int(junctions.length), 1);
  const child = { junctions, roads: [] };
  const exists = (key) => key < CITIES.length || junctions.some((j) => j.id === key);
  const keys = new Set();
  const take = (parent, mine) => {
    for (const [a, b] of parent.roads) {
      const pa = nodeByKey(parent, a), pb = nodeByKey(parent, b);
      if (side({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }) !== mine) continue;
      if (!exists(a) || !exists(b) || keys.has(roadKey(a, b))) continue;
      keys.add(roadKey(a, b));
      child.roads.push([a, b]);
    }
  };
  take(mom, true);
  take(dad, false);
  return child;
}

// MUTATION ('roads' mode): one random change, as blind as in the 'tree' mode.
//   - new road from a random node to one of its 4 nearest nodes (20%) or between two random nodes (5%);
//   - one road removed (15%);
//   - one end of a road moved to a node near that end (10%);
//   - a junction put on a road, a bit off its middle: the road a-b becomes a-j-b (15%);
//   - a node with 2+ roads splits: two of its roads (random) move to a new junction next to it,
//     joined to the node by a short road (5%). Without it evolution gets stuck: a bend a-b-c cannot
//     become a Y (three roads from a junction), nor a cross of 4 roads - two junctions of 3 roads,
//     because every step on the way there makes the network longer;
//   - small (20%) or big (5%) shift of a junction;
//   - a junction removed, its neighbours joined one after another so that the network does not fall apart (5%).
function mutateFree(genome, rng) {
  const { roads, junctions } = genome;
  const r = rng.next();
  let op = r < 0.2 ? 'near' : r < 0.25 ? 'any' : r < 0.4 ? 'remove' : r < 0.5 ? 'rewire' : r < 0.65 ? 'split'
    : r < 0.7 ? 'fork' : r < 0.9 ? 'small' : r < 0.95 ? 'big' : 'drop';
  if (!roads.length && op !== 'any') op = 'near';
  if (!junctions.length && (op === 'small' || op === 'big' || op === 'drop')) op = 'split';
  // No room for a new junction: remove one instead (otherwise useless junctions without roads take all the room).
  if (junctions.length >= maxJunctions() && (op === 'split' || op === 'fork')) op = junctions.length ? 'drop' : 'near';
  const name = (key) => (key < CITIES.length ? `город ${key + 1}` : `развилка ${junctions.findIndex((j) => j.id === key) + 1}`);

  if (op === 'near' || op === 'any') {
    const keys = allKeys(genome);
    const a = keys[rng.int(keys.length)];
    const b = op === 'near' ? nearKey(genome, a, rng) : keys[rng.int(keys.length)];
    if (a === b || hasRoad(genome, a, b)) return 'новая дорога не получилась: такая уже есть';
    roads.push([a, b]);
    return `новая дорога: ${name(a)} — ${name(b)}${op === 'near' ? ' (соседи)' : ''}`;
  }
  if (op === 'remove') {
    const [[a, b]] = roads.splice(rng.int(roads.length), 1);
    return `удалена дорога ${name(a)} — ${name(b)}`;
  }
  if (op === 'rewire') {
    const i = rng.int(roads.length);
    const [a, b] = roads[i];
    const c = nearKey(genome, b, rng);
    if (c === a || hasRoad(genome, a, c)) return 'перенос конца дороги не получился: такая дорога уже есть';
    roads[i] = [a, c];
    return `конец дороги ${name(a)} — ${name(b)} перенесён: теперь ${name(a)} — ${name(c)}`;
  }
  if (op === 'split') {
    const i = rng.int(roads.length);
    const [a, b] = roads[i];
    const pa = nodeByKey(genome, a), pb = nodeByKey(genome, b);
    const j = { id: nextJunctionId++, x: clampX((pa.x + pb.x) / 2 + 2 * rng.normal()), y: clampY((pa.y + pb.y) / 2 + 2 * rng.normal()) };
    junctions.push(j);
    roads.splice(i, 1, [a, j.id], [j.id, b]);
    return `на дорогу ${name(a)} — ${name(b)} поставлена развилка ${fmtPoint(j)}`;
  }
  if (op === 'fork') {
    const degree = new Map();
    for (const [a, b] of roads) { degree.set(a, (degree.get(a) || 0) + 1); degree.set(b, (degree.get(b) || 0) + 1); }
    const busy = [...degree.keys()].filter((key) => degree.get(key) >= 2);
    if (!busy.length) return 'деление узла не получилось: нет узла с двумя дорогами';
    const c = busy[rng.int(busy.length)];
    const mine = roads.map((road, i) => i).filter((i) => roads[i][0] === c || roads[i][1] === c);
    const i1 = mine.splice(rng.int(mine.length), 1)[0], i2 = mine[rng.int(mine.length)];
    const other = (i) => (roads[i][0] === c ? roads[i][1] : roads[i][0]);
    const n1 = other(i1), n2 = other(i2);
    const pc = nodeByKey(genome, c), p1 = nodeByKey(genome, n1), p2 = nodeByKey(genome, n2);
    // The new junction: a little way from the node towards the two roads it takes over.
    const j = { id: nextJunctionId++,
      x: clampX(pc.x + 0.25 * ((p1.x + p2.x) / 2 - pc.x) + rng.normal()),
      y: clampY(pc.y + 0.25 * ((p1.y + p2.y) / 2 - pc.y) + rng.normal()) };
    junctions.push(j);
    roads[i1] = [j.id, n1];
    roads[i2] = [j.id, n2];
    roads.push([c, j.id]);
    return `${name(c)} делится: дороги к узлам «${name(n1)}» и «${name(n2)}» ушли на новую развилку ${fmtPoint(j)}`;
  }
  const k = rng.int(junctions.length);
  const j = junctions[k];
  if (op === 'small' || op === 'big') {
    const sigma = op === 'big' ? 10 : 1;
    junctions[k] = { id: j.id, x: clampX(j.x + sigma * rng.normal()), y: clampY(j.y + sigma * rng.normal()) };
    return `${op === 'big' ? 'большой' : 'малый'} сдвиг развилки ${k + 1} → ${fmtPoint(junctions[k])}`;
  }
  // drop: remove the junction, chain its neighbours.
  const neighbours = [];
  genome.roads = roads.filter(([a, b]) => {
    if (a === j.id) neighbours.push(b);
    else if (b === j.id) neighbours.push(a);
    else return true;
    return false;
  });
  junctions.splice(k, 1);
  for (let i = 1; i < neighbours.length; i++) {
    if (!hasRoad(genome, neighbours[i - 1], neighbours[i])) genome.roads.push([neighbours[i - 1], neighbours[i]]);
  }
  return `удалена развилка ${k + 1} ${fmtPoint(j)}, её соседи соединены цепочкой`;
}
