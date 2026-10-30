'use strict';
// THE BRIDGE: what evolves and how it changes.
//
// The road is given by the task: nodes 0..D along y = 0 every DECK_STEP metres (D = TERRAIN.segments),
// joined by the road bars [i, i+1]. The two end nodes stand on the banks. Everything else is in the genome:
//   genome = { nodes: [{id, x, y}], bars: [[a, b, size]] }
//   nodes - free nodes (hinges) anywhere in the air or on the ground (a node on dry ground is a support);
//   bars  - pairs of node keys plus the section (index into SECTIONS). A node key: a road node is its
//           index 0..D, a free node is its id (D+1, D+2, ...). The road bars are in `bars` too: evolution
//           chooses their sections, but can never remove them - the road must be there.
// Bars cross each other freely (one passes in front of the other), they are joined only at nodes.

// Steel tube sections: 8 sizes, each 1.5 times the area of the previous one (15..256 cm²).
// A tube with the wall 1/20 of its radius: A = 2πr·(r/20) = πr²/10, second moment of area I = A·r²/2.
// A thicker tube is heavier, but holds more and buckles much later (I grows as A²).
const SECTIONS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
  const A = 0.0015 * Math.pow(1.5, k); // m²
  const r = Math.sqrt(10 * A / Math.PI);
  return { name: `${Math.round(A * 1e4)} см²`, A, r, I: A * r * r / 2 };
});
const NEW_SECTION = 3; // new bars start at 51 cm²

const MAX_NODES = 40;  // free nodes
const MAX_BARS = 160;

const deckCount = () => TERRAIN.segments + 1; // road nodes
const isDeckBar = ([a, b]) => a < deckCount() && b < deckCount() && Math.abs(a - b) === 1;

// Free nodes have ids, so that bars can refer to them while nodes come and go (reset in setTask).
let nextNodeId = 0;
function resetNodeIds() {
  nextNodeId = deckCount();
}

function nodeByKey(genome, key) {
  return key < deckCount() ? { x: key * DECK_STEP, y: 0 } : genome.nodes.find((q) => q.id === key);
}

function allKeys(genome) {
  const keys = [];
  for (let i = 0; i < deckCount(); i++) keys.push(i);
  for (const q of genome.nodes) keys.push(q.id);
  return keys;
}

const barKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
function hasBar(genome, a, b) {
  return genome.bars.some(([u, v]) => (u === a && v === b) || (u === b && v === a));
}

// One of the k nodes nearest to `key` (not itself and not yet joined to it).
function nearKey(genome, key, rng, k = 4) {
  const p = nodeByKey(genome, key);
  const d = (q) => { const o = nodeByKey(genome, q); return Math.hypot(o.x - p.x, o.y - p.y); };
  const others = allKeys(genome).filter((q) => q !== key && !hasBar(genome, key, q));
  if (!others.length) return null;
  others.sort((a, b) => d(a) - d(b));
  return others[rng.int(Math.min(k, others.length))];
}

const fmtPoint = (q) => `(${q.x.toFixed(1)}; ${q.y.toFixed(1)})`;

// A new free node where it may stand (placeNode: not in the ground, not in the water).
function newNode(x, y) {
  return { id: nextNodeId++, ...placeNode(x, y) };
}

// STARTING POOL: the bare road (it folds up at once: a chain of hinges holds nothing)
// plus a few random mutations - some bars and triangles here and there. No bridge of the start stands.
function randomBridge(rng) {
  const genome = { nodes: [], bars: [] };
  for (let i = 0; i < TERRAIN.segments; i++) genome.bars.push([i, i + 1, NEW_SECTION]);
  const extra = rng.intRange(2, 8);
  for (let m = 0; m < extra; m++) mutate(genome, rng);
  return genome;
}

// A random straight line across the valley: side(q) tells which side of it the point q is on.
function randomCut(rng) {
  const p = { x: TERRAIN.span * rng.next(), y: TERRAIN.bottom + (TERRAIN.maxY - TERRAIN.bottom) * 0.5 * rng.next() };
  const a = rng.next() * Math.PI;
  const nx = Math.cos(a), ny = Math.sin(a);
  return (q) => (q.x - p.x) * nx + (q.y - p.y) * ny >= 0;
}

// CROSSOVER: a random cut. Nodes and bars (by their middle point) on one side come from mom, on the other
// side from dad. Bars to a node the child did not get are dropped. Both parents have all road bars,
// so the child gets each of them from one parent (with that parent's section).
function crossover(mom, dad, rng) {
  const side = randomCut(rng);
  const nodes = [];
  const seen = new Set();
  for (const q of mom.nodes.filter(side).concat(dad.nodes.filter((q) => !side(q)))) {
    if (!seen.has(q.id)) { seen.add(q.id); nodes.push({ ...q }); }
  }
  const child = { nodes, bars: [] };
  const exists = (key) => key < deckCount() || seen.has(key);
  const keys = new Set();
  const take = (parent, mine) => {
    for (const [a, b, s] of parent.bars) {
      const pa = nodeByKey(parent, a), pb = nodeByKey(parent, b);
      if (side({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }) !== mine) continue;
      if (!exists(a) || !exists(b) || keys.has(barKey(a, b))) continue;
      keys.add(barKey(a, b));
      child.bars.push([a, b, s]);
    }
  };
  take(mom, true);
  take(dad, false);
  return child;
}

// MUTATION: one random change, blind - it does not know where the forces are.
//   - a new bar from a random node to one of its 4 nearest nodes (22%);
//   - a TRIANGLE: a new node beside a bar, joined to both its ends (15%). A triangle is the only figure
//     of hinged bars that cannot fold - that is why every truss is made of triangles;
//   - a node on a bar: a-b becomes a-j-b, j a little off the middle (8%);
//   - a bar removed (not a road bar) (13%);
//   - the section of a bar one size thicker or thinner (17%);
//   - a small (12%) or big (6%) shift of a free node;
//   - a free node removed together with its bars (7%).
// An impossible operation is replaced by a possible one.
function mutate(genome, rng) {
  const { nodes, bars } = genome;
  const r = rng.next();
  let op = r < 0.22 ? 'near' : r < 0.37 ? 'triangle' : r < 0.45 ? 'split' : r < 0.58 ? 'remove'
    : r < 0.75 ? 'size' : r < 0.87 ? 'small' : r < 0.93 ? 'big' : 'drop';
  const free = bars.map((b, i) => i).filter((i) => !isDeckBar(bars[i]));
  if ((op === 'remove' || op === 'split') && !free.length) op = 'triangle';
  if (!nodes.length && (op === 'small' || op === 'big' || op === 'drop')) op = 'triangle';
  // No room for a new node: remove one instead.
  if (nodes.length >= MAX_NODES && (op === 'triangle' || op === 'split')) op = 'drop';
  if (bars.length >= MAX_BARS && (op === 'near' || op === 'triangle' || op === 'split')) op = 'remove';
  const name = (key) => (key < deckCount() ? `дорога ${key}` : `узел ${nodes.findIndex((q) => q.id === key) + 1}`);

  if (op === 'near') {
    const keys = allKeys(genome);
    const a = keys[rng.int(keys.length)];
    const b = nearKey(genome, a, rng);
    if (b === null) return 'новый стержень не получился: соседи уже соединены';
    bars.push([a, b, NEW_SECTION]);
    return `новый стержень: ${name(a)} — ${name(b)}`;
  }
  if (op === 'triangle') {
    const [a, b] = bars[rng.int(bars.length)];
    const pa = nodeByKey(genome, a), pb = nodeByKey(genome, b);
    const L = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    // Off the middle of the bar, across it, by 0.3..1 of its length, up or down.
    const h = (0.3 + 0.7 * rng.next()) * L * (rng.chance(0.5) ? 1 : -1);
    const along = 0.5 + 0.3 * (rng.next() - 0.5);
    const j = newNode(pa.x + along * (pb.x - pa.x) - h * (pb.y - pa.y) / L,
      pa.y + along * (pb.y - pa.y) + h * (pb.x - pa.x) / L);
    nodes.push(j);
    bars.push([a, j.id, NEW_SECTION], [b, j.id, NEW_SECTION]);
    return `треугольник: узел ${fmtPoint(j)} соединён с концами стержня ${name(a)} — ${name(b)}`;
  }
  if (op === 'split') {
    const i = free[rng.int(free.length)];
    const [a, b, s] = bars[i];
    const pa = nodeByKey(genome, a), pb = nodeByKey(genome, b);
    const j = newNode((pa.x + pb.x) / 2 + rng.normal(), (pa.y + pb.y) / 2 + rng.normal());
    nodes.push(j);
    bars.splice(i, 1, [a, j.id, s], [j.id, b, s]);
    return `на стержень ${name(a)} — ${name(b)} поставлен узел ${fmtPoint(j)}`;
  }
  if (op === 'remove') {
    const [[a, b]] = bars.splice(free[rng.int(free.length)], 1);
    return `удалён стержень ${name(a)} — ${name(b)}`;
  }
  if (op === 'size') {
    const i = rng.int(bars.length);
    const [a, b, s] = bars[i];
    const t = Math.min(SECTIONS.length - 1, Math.max(0, s + (rng.chance(0.5) ? 1 : -1)));
    if (t === s) return `сечение стержня ${name(a)} — ${name(b)} не изменилось: оно уже крайнее`;
    bars[i] = [a, b, t];
    return `стержень ${name(a)} — ${name(b)}: сечение ${SECTIONS[s].name} → ${SECTIONS[t].name}`;
  }
  const k = rng.int(nodes.length);
  const q = nodes[k];
  if (op === 'small' || op === 'big') {
    const sigma = op === 'big' ? 3 : 0.5;
    nodes[k] = { id: q.id, ...placeNode(q.x + sigma * rng.normal(), q.y + sigma * rng.normal()) };
    return `${op === 'big' ? 'большой' : 'малый'} сдвиг узла ${k + 1} → ${fmtPoint(nodes[k])}`;
  }
  // drop
  nodes.splice(k, 1);
  genome.bars = bars.filter(([a, b]) => a !== q.id && b !== q.id);
  return `удалён узел ${k + 1} ${fmtPoint(q)} вместе со стержнями`;
}
