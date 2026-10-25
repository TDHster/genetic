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

import { makeRng } from './rng.js';
import { makeQuarry } from './stones.js';
import { randomGenome, crossover, mutate, cloneGenome } from './genome.js';

// About a third of the pool (the most disjoint triples it has), but at least 2 per worker.
export function batchSize(poolSize, workers) {
  return Math.max(2 * workers, Math.floor(poolSize / 3));
}

export class Evolution {
  // cfg: {seed, poolSize, stoneCount, scaffold, tiltDeg, maxGenerations?, stagnation?}
  constructor(cfg) {
    this.cfg = cfg;
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
    const { seed, stoneCount, scaffold, tiltDeg } = this.cfg;
    return { seed, stoneCount, scaffold, tiltDeg };
  }

  get generation() { return this.matings / this.cfg.poolSize; }

  // evaluateAll: (genomes, abortBelow thresholds or undefined) -> Promise<results>
  async init(evaluateAll) {
    const genomes = [];
    for (let i = 0; i < this.cfg.poolSize; i++) genomes.push(randomGenome(this.rng, this.cfg.stoneCount));
    const results = await evaluateAll(genomes);
    this.pool = genomes.map((genome, i) => this.individual(genome, results[i]));
    for (const ind of this.pool) this.consider(ind);
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

  // A tournament: the two best of the triple mate, the child gets one mutation.
  // Returns a job: {genome, target (the worst of the triple), threshold (its score)}.
  makeChild(triple) {
    const [a, b, worst] = [...triple].sort((x, y) => this.pool[y].result.score - this.pool[x].result.score);
    const genome = crossover(this.rng, this.pool[a].genome, this.pool[b].genome, this.cfg.stoneCount);
    const kind = mutate(this.rng, genome, this.cfg.stoneCount);
    this.mutationCounts[kind] = (this.mutationCounts[kind] || 0) + 1;
    return { genome, target: worst, threshold: this.pool[worst].result.score };
  }

  // The scored child replaces the worst of its triple if it is not worse.
  finish(job, result) {
    const genBefore = Math.floor(this.generation);
    if (result.aborted) this.aborted++;
    if (result.score < job.threshold) {
      this.rejected++;
    } else {
      const ind = this.individual(job.genome, result);
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
    const results = await evaluateAll(jobs.map((j) => j.genome), jobs.map((j) => j.threshold));
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

  snapshot() {
    const scores = this.pool.map((c) => c.result.score).sort((a, b) => a - b);
    const top = this.pool.reduce((m, c) => (c.result.score > m.result.score ? c : m));
    return {
      generation: Math.floor(this.generation),
      best: scores[scores.length - 1],
      median: scores[Math.floor(scores.length / 2)],
      stones: top.result.stones,
      hanging: top.result.hanging,
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
    return {
      seed: this.cfg.seed,
      stoneCount: this.cfg.stoneCount,
      scaffold: this.cfg.scaffold,
      tiltDeg: this.cfg.tiltDeg,
      generation: Math.floor(this.generation),
      result: this.best.result,
      genome: cloneGenome(this.best.genome),
    };
  }
}
