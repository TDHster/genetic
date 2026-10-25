'use strict';
// GENOME: what a clock "organism" inherits.
//
// A clock is a bag of parts (same set as in the video):
//   30 gears, 7 hands, 1 ratchet, 1 spring, 1 housing.
// The genome stores:
//   1) bonds   - which attachment point is stuck to which (the "who binds to who" matrix),
//   2) teeth   - number of teeth of each gear,
//   3) lengths - length of each hand in meters (matters when a hand works as a pendulum rod).
// The genome knows nothing about clocks: it does not say "this is a pendulum".
// Whether the bonds form anything useful is decided later, in mechanism.js.

const GEAR_COUNT = 30;
const HAND_COUNT = 7;
const MIN_TEETH = 4;
const MIN_LENGTH = 0.01; // m
const MAX_LENGTH = 100;  // m

// ---- Attachment points ----
// Every bond connects two attachment points. Each part has one or two of them:
//   gear:    center (axle)  and teeth (rim)
//   hand:    end A          and end B
//   ratchet: center (pivot) and teeth
//   spring:  end A          and end B
//   housing: one point (the clock body; it never moves)
const POINTS = [];
for (let i = 0; i < GEAR_COUNT; i++) {
  POINTS.push({ kind: 'gear', index: i, side: 'center' });
  POINTS.push({ kind: 'gear', index: i, side: 'teeth' });
}
for (let j = 0; j < HAND_COUNT; j++) {
  POINTS.push({ kind: 'hand', index: j, side: 'endA' });
  POINTS.push({ kind: 'hand', index: j, side: 'endB' });
}
const RATCHET_CENTER = POINTS.push({ kind: 'ratchet', index: 0, side: 'center' }) - 1;
const RATCHET_TEETH = POINTS.push({ kind: 'ratchet', index: 0, side: 'teeth' }) - 1;
const SPRING_A = POINTS.push({ kind: 'spring', index: 0, side: 'endA' }) - 1;
const SPRING_B = POINTS.push({ kind: 'spring', index: 0, side: 'endB' }) - 1;
const HOUSING = POINTS.push({ kind: 'housing', index: 0, side: 'body' }) - 1;
const POINT_COUNT = POINTS.length; // 79

const gearCenter = (i) => 2 * i;
const gearTeeth = (i) => 2 * i + 1;
const handEnd = (j, end) => 2 * GEAR_COUNT + 2 * j + end; // end: 0 = A, 1 = B

// Two points belong to the same part (e.g. a gear's own center and teeth)?
function samePart(a, b) {
  return POINTS[a].kind === POINTS[b].kind && POINTS[a].index === POINTS[b].index;
}

// Human-readable names, shown in the UI.
const KIND_LABEL = { gear: 'Ш', hand: 'С', ratchet: 'Храповик', spring: 'Пружина', housing: 'Корпус' };
const SIDE_LABEL = { center: 'ось', teeth: 'зубья', endA: 'конец A', endB: 'конец B', body: '' };
function pointName(p) {
  const pt = POINTS[p];
  if (pt.kind === 'housing') return 'Корпус';
  const part = (pt.kind === 'gear' || pt.kind === 'hand') ? KIND_LABEL[pt.kind] + (pt.index + 1) : KIND_LABEL[pt.kind];
  return part + '.' + SIDE_LABEL[pt.side];
}

// ---- The bond matrix ----
// The video stores bonds as a symmetric matrix POINT_COUNT x POINT_COUNT of 0/1.
// Only the upper triangle matters (a-b is the same bond as b-a), which gives
// 79*78/2 = 3081 possible bonds. We number them 0..3080 ("pair index").
// A genome keeps just the list of pair indices that are 1 - same information, less memory.
const PAIRS = [];      // pair index -> [a, b], a < b
const PAIR_INDEX = []; // PAIR_INDEX[a][b] -> pair index
for (let a = 0; a < POINT_COUNT; a++) {
  PAIR_INDEX.push(new Array(POINT_COUNT).fill(-1));
}
for (let a = 0; a < POINT_COUNT; a++) {
  for (let b = a + 1; b < POINT_COUNT; b++) {
    PAIR_INDEX[a][b] = PAIR_INDEX[b][a] = PAIRS.length;
    PAIRS.push([a, b]);
  }
}

function bondName(k) {
  const [a, b] = PAIRS[k];
  return pointName(a) + ' — ' + pointName(b);
}

// ---- Creating, mating and mutating genomes ----

// A completely random genome: a few random bonds, random teeth, random lengths.
function randomGenome(rng, cfg) {
  const bonds = new Set();
  const count = rng.poisson(cfg.initialBonds);
  while (bonds.size < count) bonds.add(rng.int(PAIRS.length));
  return {
    bonds: [...bonds].sort((x, y) => x - y),
    teeth: Array.from({ length: GEAR_COUNT }, () => rng.intRange(MIN_TEETH, cfg.maxTeeth)),
    lengths: Array.from({ length: HAND_COUNT }, () => rng.logUniform(MIN_LENGTH, MAX_LENGTH)),
  };
}

// Mating ("crossover"): every cell of the child's matrix is copied from mom or dad at random.
// So a bond both parents have is always inherited; a bond only one parent has - with 50% chance.
// Teeth and lengths are inherited gene by gene from a random parent as well.
function crossover(mom, dad, rng) {
  const bonds = [];
  let i = 0, j = 0;
  // Both lists are sorted, so we walk them together like in merge sort.
  while (i < mom.bonds.length || j < dad.bonds.length) {
    const a = i < mom.bonds.length ? mom.bonds[i] : Infinity;
    const b = j < dad.bonds.length ? dad.bonds[j] : Infinity;
    if (a === b) { bonds.push(a); i++; j++; }
    else if (a < b) { if (rng.chance(0.5)) bonds.push(a); i++; }
    else { if (rng.chance(0.5)) bonds.push(b); j++; }
  }
  return {
    bonds,
    teeth: mom.teeth.map((t, g) => rng.chance(0.5) ? t : dad.teeth[g]),
    lengths: mom.lengths.map((l, h) => rng.chance(0.5) ? l : dad.lengths[h]),
  };
}

// One random mutation. Changes the genome in place and returns a description for the UI.
// Kinds of mutation:
//   30% remove a random existing bond
//   30% add a random new bond
//   25% change the teeth of one gear
//   15% change the length of one hand
function mutate(genome, rng, cfg) {
  const r = rng.next();

  if (r < 0.3 && genome.bonds.length > 0) {
    const pos = rng.int(genome.bonds.length);
    const k = genome.bonds[pos];
    genome.bonds.splice(pos, 1);
    return 'разорвана связь ' + bondName(k);
  }

  if (r < 0.6) {
    const k = rng.int(PAIRS.length);
    const pos = lowerBound(genome.bonds, k);
    if (genome.bonds[pos] === k) return 'связь ' + bondName(k) + ' уже была (ничего не изменилось)';
    genome.bonds.splice(pos, 0, k);
    return 'новая связь ' + bondName(k);
  }

  if (r < 0.85) {
    const g = rng.int(GEAR_COUNT);
    const before = genome.teeth[g];
    // Mostly small steps (fine tuning), sometimes a completely new gear size.
    let after = rng.chance(0.7)
      ? before + (rng.chance(0.5) ? 1 : -1) * rng.intRange(1, 5)
      : rng.intRange(MIN_TEETH, cfg.maxTeeth);
    after = Math.max(MIN_TEETH, Math.min(cfg.maxTeeth, after));
    genome.teeth[g] = after;
    return 'Ш' + (g + 1) + ': зубьев ' + before + ' → ' + after;
  }

  const h = rng.int(HAND_COUNT);
  const before = genome.lengths[h];
  let after;
  if (rng.chance(0.7)) {
    // Relative change from 0.001% to 10%: allows both big jumps and very fine tuning.
    const scale = Math.pow(10, -5 + 4 * rng.next());
    after = before * (1 + scale * rng.normal());
  } else {
    after = rng.logUniform(MIN_LENGTH, MAX_LENGTH);
  }
  after = Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, after));
  genome.lengths[h] = after;
  return 'С' + (h + 1) + ': длина ' + formatLength(before) + ' → ' + formatLength(after);
}

// First position in a sorted array where value >= x.
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function formatLength(m) {
  return m < 1 ? (m * 100).toFixed(2) + ' см' : m.toFixed(4) + ' м';
}
