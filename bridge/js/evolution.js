'use strict';
// EVOLUTION: the same scheme as in the other projects.
//   1. take 3 random bridges from the pool;
//   2. the worst one dies;
//   3. the two survivors mate, the child gets one mutation;
//   4. the child takes the dead bridge's place.
// One "generation" = as many matings as there are bridges in the pool.
// Nothing here knows what a bridge is: only scores are compared.
//
// STOPPING: evolution never stops by itself. stopReason() implements the usual rules:
// stagnation and a generation limit.

class Evolution {
  constructor(cfg) {
    this.cfg = cfg;
    // The valley (and the reference truss) must be ready before any bridge is scored.
    setTask(cfg.task);
    this.rng = makeRng(cfg.seed);
    this.nextId = 1;
    this.matings = 0;
    this.pool = [];
    for (let i = 0; i < cfg.populationSize; i++) this.pool.push(this.createBridge(randomBridge(this.rng), null));
    this.counts = new Array(CLASS_NAMES.length).fill(0);
    for (const c of this.pool) this.counts[c.cls]++;
    this.bestScore = Math.max(...this.pool.map((c) => c.score));
    this.lastImprovementAt = 0;
    this.history = [this.snapshot()]; // one row per generation
  }

  createBridge(genome, parents) {
    return { id: this.nextId++, genome, ...evaluateBridge(genome), parents };
  }

  // What we remember about each generation: class counts, the best score and its cost (if it holds).
  snapshot() {
    const best = this.best();
    return { counts: this.counts.slice(), best: this.bestScore, cost: best.cls >= 2 ? best.cost : null,
      strength: best.cls >= 2 ? best.strength : null };
  }

  get generation() {
    return this.matings / this.pool.length;
  }

  get generationsWithoutImprovement() {
    return (this.matings - this.lastImprovementAt) / this.pool.length;
  }

  step() {
    const size = this.pool.length;
    const picked = [];
    while (picked.length < 3) {
      const i = this.rng.int(size);
      if (!picked.includes(i)) picked.push(i);
    }
    picked.sort((a, b) => this.pool[b].score - this.pool[a].score);
    const [momIdx, dadIdx, loserIdx] = picked;
    const mom = this.pool[momIdx], dad = this.pool[dadIdx], loser = this.pool[loserIdx];

    const genome = crossover(mom.genome, dad.genome, this.rng);
    const mutations = [];
    for (let m = 0; m < this.cfg.mutationsPerChild; m++) mutations.push(mutate(genome, this.rng));
    const child = this.createBridge(genome, [mom.id, dad.id]);

    this.pool[loserIdx] = child;
    this.counts[loser.cls]--;
    this.counts[child.cls]++;
    this.matings++;
    if (child.score > this.bestScore) {
      this.bestScore = child.score;
      this.lastImprovementAt = this.matings;
    }
    if (this.matings % size === 0) this.history.push(this.snapshot());
    return { mom, dad, loser, child, mutations };
  }

  // rules: { stagnation: 300, maxGenerations: 3000 }; 0 = off.
  stopReason(rules) {
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
    for (const c of this.pool) {
      if (c.score > best.score || (c.score === best.score && c.id < best.id)) best = c;
    }
    return best;
  }
}
