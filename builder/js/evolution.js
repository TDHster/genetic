// EVOLUTION: almost the same scheme as in the clock and leg projects.
//   1. take 3 random structures from the pool;
//   2. the two best mate, the child gets one mutation;
//   3. the child takes the place of the worst of the three - if it is not worse than it.
// The difference from the siblings is in step 3 (there the worst always dies). It makes evolution
// much faster here: a child only has to be scored until it is clearly worse than the one it would
// replace. The physics stops as soon as the top of the structure is below that score - the top
// of a stone structure only goes down after the scaffolding is removed (opts.abortBelow in physics.js).
// Equal scores replace, so neutral changes still spread.
// One "generation" = as many matings as there are structures in the pool.
// Nothing here knows what a tower is: only scores are compared.
//
// BATCHES. Scoring a structure means simulating it (tens of milliseconds), so children are made
// in batches and scored in parallel by a pool of workers. A batch waits for its slowest child
// (scoring times differ tenfold), so batches are large - see batchSize(). The tournaments of one
// batch use disjoint triples, so no structure dies twice. The result depends on the seed and on
// the batch size (the number of workers), nothing else: the physics is deterministic.
//
// STOPPING: stopReason() - stagnation (best not improved for cfg.stagnation generations)
// or the generation limit (cfg.maxGenerations). Both are optional and may change during a run.
//
// MAP OF FINDS (MAP-Elites). A pool alone keeps one line of the best and gets stuck in the first
// local optimum - a column. So every scored structure is also offered to a map: a grid by the base
// radius and the taper (radius at the top / at the base), see cellOf(). Each cell keeps its best
// structure, so wide bases, cones and columns live side by side instead of pushing each other out.
// ARCHIVE_SHARE of children have two random elites of the map as parents (and are scored to the end:
// their cell is not known in advance, so there is nothing to stop early against); they compete for
// the pool like any child, so the map also feeds the pool with new forms.

import { makeRng } from './rng.js';
import { makeQuarry } from './stones.js';
import { randomGenome, crossover, mutate, cloneGenome } from './genome.js';
import { GATE_HEIGHT } from './physics.js';

// GROWING PASSAGE (cfg.gateGrow). A portal or a vault over a wide passage is several parts that must come
// together at once: without the lintel the pillars score nothing, there is no slope to climb. So the
// passage starts narrow (GATE_START - one stone spans it) and widens by GATE_STEP, up to cfg.gateWidth,
// as soon as the best structure stands GATE_READY over it with no stone inside. Only the difficulty grows,
// no shape is given: lintel -> pillars moved together by corbelling -> a false vault.
export const GATE_START = 0.15;
export const GATE_STEP = 0.05;
export const GATE_READY = GATE_HEIGHT + 0.2;

// GROWING QUARRY (cfg.growStones), the same idea for the number of stones. With 15 stones evolution builds
// a tidy 0.9 m tower within a minute; with 100 it only finds a wide heap 0.7-0.8 m high, although a hand-made
// pyramid of 100 stones stands higher (and evolution improves it further when started from it). So the
// quarry starts small (STONES_START) and doubles, up to cfg.stoneCount, when the best has not improved for
// STONES_STAGNATION generations. The stones of a small quarry are the first stones of the big one (makeQuarry
// is sequential), so every structure stays valid; it just scores a smaller share of the larger pile and has
// to grow. Not with mirror symmetry: its pairs (stone i <-> i + N/2) would change with N.
export const STONES_START = 15;
export const STONES_STAGNATION = 15;


export const ARCHIVE_SHARE = 0.5;
// Cell borders: radius of the base (m) and taper (radius of the upper 40 % / of the base).
export const BASE_BINS = [0.25, 0.5, 0.75, 1, 1.5, 2];
export const TAPER_BINS = [0.3, 0.5, 0.7, 0.9, 1.1];

const binOf = (v, borders) => { let i = 0; while (i < borders.length && v >= borders[i]) i++; return i; };

// The map cell of a scored structure, or null (fell apart, stopped early).
export function cellOf(result) {
  if (!result.profile || !(result.score > 0)) return null;
  const [base, , , u1, u2] = result.profile;
  if (!(base > 0)) return null;
  return [binOf(base, BASE_BINS), binOf(Math.max(u1, u2) / base, TAPER_BINS)];
}

// About a third of the pool (the most disjoint triples it has), but at least 2 per worker.
export function batchSize(poolSize, workers) {
  return Math.max(2 * workers, Math.floor(poolSize / 3));
}

export class Evolution {
  // cfg: {seed, poolSize, stoneCount, scaffold, tiltDeg, pile, noEnd, gateWidth (0 = no gate), gateArch, mirror,
  //       maxGenerations?, stagnation?, seedGenomes? (start the pool with these)}
  constructor(cfg) {
    this.cfg = cfg;
    this.rules = { noEnd: !!cfg.noEnd };
    // With mirror symmetry the genome plans only the first half of the quarry (see buildPlan in physics.js).
    if (cfg.growStones && cfg.mirror) throw new Error('growing quarry does not work with mirror symmetry');
    // Stones in the quarry now: grows from STONES_START to cfg.stoneCount (see the header), or fixed.
    this.stonesNow = cfg.growStones ? Math.min(STONES_START, cfg.stoneCount) : cfg.stoneCount;
    this.archive = new Map();   // "i,j" (see cellOf) -> the best individual of the cell
    // The passage width now: grows from GATE_START to cfg.gateWidth (see the header), or fixed.
    this.gateNow = cfg.gateWidth && cfg.gateGrow ? Math.min(GATE_START, cfg.gateWidth) : cfg.gateWidth || 0;
    this.rng = makeRng(cfg.seed);
    this.quarry = makeQuarry(cfg.stoneCount, cfg.seed);
    this.matings = 0;
    this.pool = [];      // [{genome, result, id, born}]
    this.nextId = 1;
    this.history = [];   // one row per generation: {best, median, stones, hanging}
    this.best = null;
    this.lastImprovementAt = 0;
    this.mutationCounts = {};
    this.rejected = 0;   // children worse than the worst of their triple
    this.aborted = 0;    // ...of them, scored only until that was clear
    this.reserved = new Set();   // pool slots in triples of children being scored (asynchronous mode)
  }

  // The settings a worker needs to score genomes exactly like the others.
  evalConfig() {
    const { seed, scaffold, tiltDeg, pile, gateArch, mirror } = this.cfg;
    return { seed, stoneCount: this.stonesNow, scaffold, tiltDeg, pile: !!pile, gateWidth: this.gateNow, gateArch: !!gateArch,
      mirror: !!mirror };
  }

  get generation() { return this.matings / this.cfg.poolSize; }

  // Stones the genome may use: with mirror symmetry it plans only the first half (see buildPlan in physics.js).
  get genomeStones() { return this.cfg.mirror ? Math.floor(this.stonesNow / 2) : this.stonesNow; }

  // evaluateAll: (genomes, abortBelow thresholds or undefined) -> Promise<results>
  async init(evaluateAll) {
    // cfg.seedGenomes: hand-made structures to start from (an experiment: does a pyramid survive evolution?).
    const genomes = (this.cfg.seedGenomes || []).slice(0, this.cfg.poolSize).map(cloneGenome);
    while (genomes.length < this.cfg.poolSize) genomes.push(randomGenome(this.rng, this.genomeStones, this.rules));
    const results = await evaluateAll(genomes);
    this.pool = genomes.map((genome, i) => this.individual(genome, results[i]));
    for (const ind of this.pool) { this.consider(ind); this.offer(ind); }
    this.history.push(this.snapshot());
  }

  individual(genome, result) {
    return { genome, result, id: this.nextId++, born: this.generation };
  }

  consider(ind) {
    if (!this.best || ind.result.score > this.best.result.score) {
      this.best = ind;
      this.lastImprovementAt = this.generation;
    }
  }

  // Puts a structure on the map if its cell is empty or it beats the cell's best.
  offer(ind) {
    const cell = cellOf(ind.result);
    if (!cell) return;
    const key = cell.join(',');
    const old = this.archive.get(key);
    if (!old || ind.result.score > old.result.score) this.archive.set(key, ind);
  }

  // A tournament: the two best of the triple mate (or, for ARCHIVE_SHARE of children, two random elites
  // of the map), the child gets one mutation. Returns a job: {genome, target (the worst of the triple),
  // threshold (its score), abortBelow (score to stop early against, undefined for map children)}.
  makeChild(triple) {
    const [a, b, worst] = [...triple].sort((x, y) => this.pool[y].result.score - this.pool[x].result.score);
    let pa = this.pool[a], pb = this.pool[b], fromMap = false;
    if (this.archive.size >= 2 && this.rng.chance(ARCHIVE_SHARE)) {
      const elites = [...this.archive.values()];
      pa = elites[this.rng.int(elites.length)];
      pb = elites[this.rng.int(elites.length)];
      fromMap = true;
    }
    const genome = crossover(this.rng, pa.genome, pb.genome, this.genomeStones);
    const kind = mutate(this.rng, genome, this.genomeStones, this.rules);
    this.mutationCounts[kind] = (this.mutationCounts[kind] || 0) + 1;
    const threshold = this.pool[worst].result.score;
    return { genome, target: worst, threshold, abortBelow: fromMap ? undefined : threshold };
  }

  // The scored child replaces the worst of its triple if it is not worse.
  finish(job, result) {
    const genBefore = Math.floor(this.generation);
    if (result.aborted) this.aborted++;
    const ind = this.individual(job.genome, result);
    this.offer(ind);
    if (result.score < job.threshold) {
      this.rejected++;
    } else {
      this.pool[job.target] = ind;
      this.consider(ind);
    }
    this.matings++;
    if (Math.floor(this.generation) > genBefore) this.history.push(this.snapshot());
  }

  // One batch of matings (deterministic: used by tools/headless.mjs). Returns the number of matings.
  async step(evaluateAll, batchSize) {
    const n = this.pool.length;
    const k = Math.max(1, Math.min(batchSize, Math.floor(n / 3)));
    // Disjoint random triples: a partial shuffle of the pool indices.
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < 3 * k; i++) {
      const j = i + this.rng.int(n - i);
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const jobs = [];
    for (let t = 0; t < k; t++) jobs.push(this.makeChild([idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]]));
    const results = await evaluateAll(jobs.map((j) => j.genome), jobs.map((j) => j.abortBelow));
    jobs.forEach((job, t) => this.finish(job, results[t]));
    return k;
  }

  // ASYNCHRONOUS mode (the browser): a new child starts as soon as a worker is free, no batches.
  // Faster (no waiting for the slowest child of a batch), but the run depends on timing, so the same
  // seed no longer gives the same run. Slots of a triple whose child is still being scored are reserved:
  // a structure cannot die twice, and its score (the child's threshold) cannot change meanwhile.
  startChild() {
    const n = this.pool.length;
    const triple = [];
    while (triple.length < 3) {
      const i = this.rng.int(n);
      if (!this.reserved.has(i) && !triple.includes(i)) triple.push(i);
    }
    for (const i of triple) this.reserved.add(i);
    const job = this.makeChild(triple);
    job.triple = triple;
    return job;
  }

  finishChild(job, result) {
    for (const i of job.triple) this.reserved.delete(i);
    this.finish(job, result);
  }

  // True when the passage should widen: the best stands GATE_READY over it with nothing inside.
  gateReady() {
    const r = this.best && this.best.result;
    return !!(this.cfg.gateGrow && this.gateNow < this.cfg.gateWidth - 1e-9 && r
      && r.gateAbove >= GATE_READY && r.gateBlocked === 0);
  }

  // True when the quarry should grow: the best has not improved for STONES_STAGNATION generations.
  stonesReady() {
    return !!(this.cfg.growStones && this.stonesNow < this.cfg.stoneCount
      && this.generation - this.lastImprovementAt >= STONES_STAGNATION);
  }

  // Doubles the quarry; the caller then gives the workers the new evalConfig() and calls rescore().
  growStones() {
    this.stonesNow = Math.min(this.cfg.stoneCount, 2 * this.stonesNow);
    return this.stonesNow;
  }

  // Widens the passage; the caller then gives the workers the new evalConfig() and calls rescore().
  widenGate() {
    this.gateNow = Math.min(this.cfg.gateWidth, this.gateNow + GATE_STEP);
    return this.gateNow;
  }

  // Scores the whole pool again (after the task changed): the map starts anew, the best is found anew.
  async rescore(evaluateAll) {
    const results = await evaluateAll(this.pool.map((ind) => ind.genome));
    this.pool.forEach((ind, i) => { ind.result = results[i]; });
    this.archive.clear();
    this.best = null;
    for (const ind of this.pool) { this.consider(ind); this.offer(ind); }
    this.lastImprovementAt = this.generation;
  }

  snapshot() {
    const scores = this.pool.map((c) => c.result.score).sort((a, b) => a - b);
    const top = this.pool.reduce((m, c) => (c.result.score > m.result.score ? c : m));
    return {
      generation: Math.floor(this.generation),
      best: scores[scores.length - 1],
      median: scores[Math.floor(scores.length / 2)],
      stones: top.result.stones,
      hanging: top.result.hanging,
      gate: this.gateNow,
      quarry: this.stonesNow,
    };
  }

  stopReason() {
    if (this.cfg.maxGenerations && this.generation >= this.cfg.maxGenerations) return 'предел поколений';
    if (this.cfg.stagnation && this.generation - this.lastImprovementAt >= this.cfg.stagnation) {
      return `нет улучшений ${this.cfg.stagnation} поколений`;
    }
    return null;
  }

  // For export: the best plan plus everything needed to rebuild it.
  exportBest() {
    return this.exportIndividual(this.best);
  }

  // For export: a structure plus everything needed to rebuild it.
  exportIndividual(ind) {
    return {
      seed: this.cfg.seed,
      stoneCount: this.stonesNow,
      scaffold: this.cfg.scaffold,
      tiltDeg: this.cfg.tiltDeg,
      pile: !!this.cfg.pile,
      noEnd: !!this.cfg.noEnd,
      gateWidth: this.gateNow,
      gateArch: !!this.cfg.gateArch,
      mirror: !!this.cfg.mirror,
      generation: Math.floor(ind.born),
      result: ind.result,
      genome: cloneGenome(ind.genome),
    };
  }
}
