'use strict';
// THE ROAD NETWORK: what evolves and what a genome turns into.
//
// Cities are fixed by the task. The genome is a list of JUNCTIONS: extra points in the field
// where roads may meet (Steiner points). The roads themselves are not in the genome:
// for any set of points (cities + junctions) the shortest tree that connects them is known exactly -
// the minimum spanning tree (see fitness.js). So the only question evolution answers is
// "where to put the junctions and how many", and every genome is some valid network.
//
// Coordinates are kilometres on a map MAP_W × MAP_H.

const MAP_W = 100;
const MAP_H = 70;

// The task: which cities to connect. Filled by setTask() in fitness.js.
//   map: 'trilattice' | 'grid' | 'random' | 'triangle' | 'square' | 'hexagon'; cities: how many (random map only);
//   mapSeed: seed of the random map (separate from the evolution seed: same map, different runs).
const TASK = { map: 'trilattice', cities: 20, mapSeed: 1 };
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

// Starting pool: from 1 to n − 2 junctions at random places. At least one junction on purpose:
// a network without junctions is the plain spanning tree, which is already good, and the evolution
// would start from it instead of finding its way. Most random networks are longer than the spanning
// tree: a junction in a random place only adds a detour.
function randomRoads(rng) {
  const k = 1 + rng.int(maxJunctions());
  const junctions = [];
  for (let i = 0; i < k; i++) junctions.push(randomPoint(rng));
  return { junctions };
}

// CROSSOVER: cut the map with a random straight line. Junctions on one side come from mom,
// on the other side from dad. Junctions matter locally (each one serves the cities around it),
// so a cut through the map keeps the good local pieces of both parents.
function crossover(mom, dad, rng) {
  const p = randomPoint(rng);
  const a = rng.next() * Math.PI;
  const nx = Math.cos(a), ny = Math.sin(a);
  const side = (q) => (q.x - p.x) * nx + (q.y - p.y) * ny >= 0;
  const junctions = mom.junctions.filter(side).concat(dad.junctions.filter((q) => !side(q))).map((q) => ({ ...q }));
  // Too many after the cut: drop random ones.
  while (junctions.length > maxJunctions()) junctions.splice(rng.int(junctions.length), 1);
  return { junctions };
}

const clampX = (x) => Math.min(MAP_W, Math.max(0, x));
const clampY = (y) => Math.min(MAP_H, Math.max(0, y));

// MUTATION: one random change. Returns a short description for the "last mating" panel.
//   - small shift of one junction (40%): fine-tuning, this is how junctions settle at 120°;
//   - big shift of one junction (15%);
//   - new junction near a random city or junction (15%) or anywhere on the map (10%);
//   - one junction removed (20%).
// None of them knows the answer (no "put it at the Fermat point"): the changes are blind,
// only selection decides what stays.
function mutate(genome, rng) {
  const js = genome.junctions;
  const fmt = (q) => `(${q.x.toFixed(1)}; ${q.y.toFixed(1)})`;
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
