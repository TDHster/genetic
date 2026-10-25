'use strict';
// FITNESS: does the design keep the promenade dry in the storm, does it survive, what does it cost?
//
// Every design meets the same once-in-100-years storm (STORM in sim.js). During the storm:
//   - the waves run through and around the structures, break, reflect;
//   - blocks that are hit by water faster than they can stand are washed away (layer by layer),
//     so a weak structure gets lower and lets more waves through as the storm goes on;
//   - at the wall the wave height is measured and turned into OVERTOPPING q (l/s per metre of wall).
//
// OVERTOPPING that counts = mean q over the worst WORST_SHARE of the wall: the promenade is only as
// safe as its most dangerous part (otherwise evolution protects the middle and forgets the ends).
// SAFE: EurOtop's limit for people on a promenade with such waves is about 1 l/s per metre.
//
// score = 1 + 100 x protection x economy x integrity
//   protection = how far from the bare coast to the safe limit, on a log scale (overtopping changes
//                by orders of magnitude): 0 = as bad as no protection, 1 = safe. Below the limit no more points:
//                once people are safe, the only way up is to build cheaper or stronger;
//   economy    = 1 / (1 + price / BUDGET): half the points at the budget, always better if cheaper;
//                without it evolution simply fills the whole bay with rock;
//   integrity  = (share of blocks left after the storm)^4: a structure that is falling apart now
//                will not survive the next storm. The 4th power makes 10% damage cost a third of the score.
// score = 0 - nothing is built at all.

const WORST_SHARE = 0.25;   // the worst quarter of the wall
const Q_SAFE = 1;           // l/s per metre
const BUDGET = 1e6;         // money units (see BLOCKS for prices per m3)
const EVAL_DX = 4;          // m, grid of the evaluation

const CLASS_NAMES = ['ничего не строит', 'не защищает', 'разваливается', 'защищает частично', 'набережная в безопасности', 'лучше эталона'];
const CLASS_COLORS = ['#1b2a6b', '#5a5f7a', '#c0504d', '#3fd0d6', '#3fbf5f', '#f0c040'];

// Overtopping (l/s per metre) of the worst WORST_SHARE of the wall.
function worstOvertopping(q) {
  const sorted = Array.from(q, (v) => v * 1000).sort((a, b) => b - a);
  const n = Math.max(1, Math.round(sorted.length * WORST_SHARE));
  let s = 0;
  for (let k = 0; k < n; k++) s += sorted[k];
  return s / n;
}

// The bare coast: computed once, every design is compared with it.
let BARE = null;
function bareCoast() {
  if (!BARE) {
    const sim = new WaveSim(makeWorld(EVAL_DX), STORM).run();
    const o = sim.overtopping();
    BARE = { q: worstOvertopping(o.q), qMean: o.mean * 1000 };
  }
  return BARE;
}

function evaluateDesign(design) {
  const world = buildWorld(design, EVAL_DX);
  const cost = designCost(world);
  const parts = world.segmentCells.filter((n) => n > 0).length; // segments that build something
  if (world.blocks.cells.length === 0) {
    return { score: 0, cls: 0, parts, cost, q: bareCoast().q, qMean: bareCoast().qMean, protection: 0, economy: 1, integrity: 1, damage: 0 };
  }
  const sim = new WaveSim(world, STORM).run();
  const o = sim.overtopping();
  const q = worstOvertopping(o.q);
  const q0 = bareCoast().q;
  const protection = q <= Q_SAFE ? 1 : Math.max(0, Math.log(q0 / q) / Math.log(q0 / Q_SAFE));
  const economy = 1 / (1 + cost.price / BUDGET);
  const damage = cost.volume > 0 ? sim.washed / cost.volume : 0;
  const integrity = Math.pow(1 - damage, 4);
  const score = 1 + 100 * protection * economy * integrity;
  let cls;
  if (protection < 0.1) cls = 1;
  else if (damage > 0.2) cls = 2;
  else if (protection < 1) cls = 3;
  else cls = REFERENCE_SCORE !== null && score > REFERENCE_SCORE ? 5 : 4;
  return { score, cls, parts, cost, q, qMean: o.mean * 1000, protection, economy, integrity, damage };
}

// CACHE. Evolution often makes a child that builds exactly what was already scored: a nudge smaller
// than a grid cell, a change in a segment that builds nothing, two identical parents. The storm is
// deterministic, so the result would be the same to the last bit: take it from the cache instead.
// The key is a hash of what is built (cells, materials, exact heights). The species (parts) depends on
// the genome, not only on what is built, so it is counted anew for every design.
class ScoreCache {
  constructor(limit = 50000) {
    this.limit = limit;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  // { key, parts, result }: result is null when the design has to be simulated.
  lookup(design) {
    const world = buildWorld(design, EVAL_DX);
    const { cells, type } = world.blocks;
    const bits = new Uint32Array(Float64Array.from(cells, (c) => world.z[c]).buffer);
    let h1 = 2166136261, h2 = 5381; // FNV-1a and djb2 side by side: a 64-bit key, collisions negligible
    const mix = (x) => { h1 = Math.imul(h1 ^ x, 16777619); h2 = (Math.imul(h2, 33) + x) | 0; };
    for (let k = 0; k < cells.length; k++) { mix(cells[k]); mix(type[k]); mix(bits[2 * k]); mix(bits[2 * k + 1]); }
    const key = `${cells.length}:${h1 >>> 0}:${h2 >>> 0}`;
    const parts = world.segmentCells.filter((n) => n > 0).length;
    const stored = this.map.get(key);
    if (stored) this.hits++; else this.misses++;
    return { key, parts, result: stored ? { ...stored, parts } : null };
  }

  store(key, result) {
    if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value); // forget the oldest
    this.map.set(key, result);
  }

  // Score a design: from the cache or by simulating the storm here.
  score(design) {
    const found = this.lookup(design);
    if (found.result) return found.result;
    const result = evaluateDesign(design);
    this.store(found.key, result);
    return result;
  }

  get hitRate() {
    return this.hits / Math.max(1, this.hits + this.misses);
  }
}

// Score of the hand-made reference design (like Jansen's leg in teo-leg).
let REFERENCE_SCORE = null;
REFERENCE_SCORE = evaluateDesign(REFERENCE).score;
