'use strict';
// EVOLUTION: the same scheme as in the other projects of this repository.
//   1. take 3 random airfoils from the pool, the best two are the parents;
//   2. they mate, the child gets one mutation;
//   3. the worst of 3 random airfoils dies, the child takes its place.
// One "generation" = as many matings as there are airfoils in the pool.
// Nothing here knows what an airfoil is: only scores are compared.
//
// BATCHES. Scoring an airfoil means a whole polar (~15 ms), so children are scored in parallel
// (Web Workers in the browser). The loop is split in two:
//   propose() - pick parents, make a child genome (uses the rng);
//   accept()  - when the score is known: pick who dies, put the child in (uses the rng).
// BATCH children are proposed from the same pool, then accepted in the order they were proposed.
// So a run depends only on the seed - not on how many workers there are or which finishes first.
// No species here (unlike vawt): every airfoil has the same 12 numbers, the task is smooth.

const BATCH = 8;                 // children scored at once

class Evolution {
  // cfg: { seed, populationSize, mutationsPerChild }.
  // The first pool must be scored too: firstGenomes() -> score them -> start(genomes, results).
  constructor(cfg) {
    this.cfg = cfg;
    this.rng = makeRng(cfg.seed);
    this.nextId = 1;
    this.matings = 0;
    this.pool = [];
  }

  firstGenomes() {
    const list = [];
    for (let i = 0; i < this.cfg.populationSize; i++) list.push(randomAirfoil(this.rng));
    return list;
  }

  start(genomes, results) {
    this.pool = genomes.map((g, i) => this.makeAirfoil(g, results[i], null));
    this.counts = new Array(CLASS_NAMES.length).fill(0);
    for (const d of this.pool) this.counts[d.cls]++;
    this.bestScore = Math.max(...this.pool.map((d) => d.score));
    this.history = [this.snapshot()]; // one row per generation
    this.lastImprovementAt = 0;
  }

  makeAirfoil(genome, result, parents) {
    return { id: this.nextId++, genome, ...result, parents };
  }

  // Up to `count` different random pool indices.
  randomIndices(count) {
    const picked = [];
    while (picked.length < Math.min(count, this.pool.length)) {
      const i = this.rng.int(this.pool.length);
      if (!picked.includes(i)) picked.push(i);
    }
    return picked;
  }

  get generation() {
    return this.matings / this.pool.length;
  }

  get generationsWithoutImprovement() {
    return (this.matings - this.lastImprovementAt) / this.pool.length;
  }

  snapshot() {
    return { counts: this.counts.slice(), best: this.bestScore };
  }

  // Parents and a child genome. Returns { genome, mom, dad, mutations }.
  propose() {
    const parents = this.randomIndices(3).sort((a, b) => this.pool[b].score - this.pool[a].score);
    const mom = this.pool[parents[0]], dad = this.pool[parents[1]];
    const genome = crossover(mom.genome, dad.genome, this.rng);
    const mutations = [];
    for (let m = 0; m < this.cfg.mutationsPerChild; m++) mutations.push(mutate(genome, this.rng));
    return { genome, mom, dad, mutations };
  }

  // The child is scored: somebody dies, the child takes the place.
  accept(proposal, result) {
    const doomed = this.randomIndices(3).sort((a, b) => this.pool[a].score - this.pool[b].score)[0];
    const loser = this.pool[doomed];
    const child = this.makeAirfoil(proposal.genome, result, [proposal.mom.id, proposal.dad.id]);
    this.pool[doomed] = child;
    this.counts[loser.cls]--;
    this.counts[child.cls]++;
    this.matings++;
    if (child.score > this.bestScore) {
      this.bestScore = child.score;
      this.lastImprovementAt = this.matings;
    }
    if (this.matings % this.pool.length === 0) this.history.push(this.snapshot());
    return { ...proposal, loser, child };
  }

  // A batch synchronously, for Node and tests: score(genome) -> result.
  stepBatch(score) {
    const proposals = [];
    for (let k = 0; k < BATCH; k++) proposals.push(this.propose());
    return proposals.map((p) => this.accept(p, score(p.genome)));
  }

  // rules: { referenceScore, beatReference: 0.05 (wanted margin, fraction), stagnation: 50, maxGenerations: 300 }; 0 = off.
  stopReason(rules) {
    if (rules.beatReference && this.bestScore > rules.referenceScore * (1 + rules.beatReference)) {
      const margin = (this.bestScore / rules.referenceScore - 1) * 100;
      return `цель достигнута: лучший профиль на ${margin.toFixed(1)}% лучше эталона`;
    }
    if (rules.stagnation && this.generationsWithoutImprovement >= rules.stagnation) {
      return `застой: ${rules.stagnation} поколений без улучшения`;
    }
    if (rules.maxGenerations && this.generation >= rules.maxGenerations) {
      return `достигнут предел в ${rules.maxGenerations} поколений`;
    }
    return null;
  }

  best() {
    let best = this.pool[0];
    for (const d of this.pool) {
      if (d.score > best.score || (d.score === best.score && d.id < best.id)) best = d;
    }
    return best;
  }

  // The n best airfoils, for the gallery.
  top(n) {
    return this.pool.slice().sort((a, b) => b.score - a.score || a.id - b.id).slice(0, n);
  }
}
