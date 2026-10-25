'use strict';
// EVOLUTION: a pool of clocks, competition, mating, mutation.
//
// Same scheme as in the video ("steady state" with a tournament of three):
//   1. take 3 random clocks from the pool;
//   2. sort them by fitness; the worst one dies;
//   3. the two survivors mate, the child gets 1 mutation (configurable);
//   4. the child takes the place of the dead clock.
// There are no distinct generations. For counting time we say that one
// "generation" has passed after as many matings as there are clocks in the pool.
//
// Note: nothing here knows what a clock is. Evolution only compares scores.
//
// STOPPING. Nature never stops, and neither does this loop by itself.
// A genetic algorithm usually stops on one of these rules (see stopReason):
//   - the goal is reached (every target hand is accurate enough);
//   - stagnation: the best score has not improved for N generations;
//   - a generation limit.
// Stagnation is a trap here: the "age of pendulums" lasts hundreds of generations
// without any improvement, and then a breakthrough comes. Stop too early - no clock.

class Evolution {
  constructor(cfg) {
    this.cfg = cfg;
    this.rng = makeRng(cfg.seed);
    this.nextId = 1;
    this.matings = 0;
    this.pool = [];
    for (let i = 0; i < cfg.populationSize; i++) {
      this.pool.push(this.createClock(randomGenome(this.rng, cfg), null));
    }
    // counts[c] = how many clocks of class c are in the pool right now
    this.counts = new Array(CLASS_NAMES.length).fill(0);
    for (const c of this.pool) this.counts[c.cls]++;
    this.history = [this.counts.slice()]; // one row per generation
    // For the stagnation rule: the best score ever seen and when it was reached.
    this.bestScore = Math.max(...this.pool.map((c) => c.score));
    this.lastImprovementAt = 0; // mating number
  }

  createClock(genome, parents) {
    const mech = analyzeClock(genome);
    const fit = evaluateClock(mech, this.cfg.targets);
    return {
      id: this.nextId++,
      genome,
      mech,
      score: fit.score,
      cls: fit.cls,
      matches: fit.matches,
      parents,              // ids of mom and dad (null for the random first pool)
      bornAt: this.matings, // mating number when it was born
    };
  }

  get generation() {
    return this.matings / this.pool.length;
  }

  // One round of the tournament. Returns what happened, for the step-by-step view.
  step() {
    const size = this.pool.length;
    const picked = [];
    while (picked.length < 3) {
      const i = this.rng.int(size);
      if (!picked.includes(i)) picked.push(i);
    }
    // Sort by score; equal scores are already in random order because picks are random.
    picked.sort((a, b) => this.pool[b].score - this.pool[a].score);
    const [momIdx, dadIdx, loserIdx] = picked;
    const mom = this.pool[momIdx], dad = this.pool[dadIdx], loser = this.pool[loserIdx];

    const childGenome = crossover(mom.genome, dad.genome, this.rng);
    const mutations = [];
    for (let m = 0; m < this.cfg.mutationsPerChild; m++) {
      mutations.push(mutate(childGenome, this.rng, this.cfg));
    }
    const child = this.createClock(childGenome, [mom.id, dad.id]);

    this.pool[loserIdx] = child;
    this.counts[loser.cls]--;
    this.counts[child.cls]++;
    this.matings++;
    if (this.matings % size === 0) this.history.push(this.counts.slice());
    if (child.score > this.bestScore) {
      this.bestScore = child.score;
      this.lastImprovementAt = this.matings;
    }

    return { mom, dad, loser, child, mutations };
  }

  get generationsWithoutImprovement() {
    return (this.matings - this.lastImprovementAt) / this.pool.length;
  }

  // Should we stop? Returns a human-readable reason, or null to keep going.
  // rules: { maxError: 0.00001 (fraction, 0.001%), stagnation: 500, maxGenerations: 5000 }
  // A rule set to 0 (or missing) is off.
  stopReason(rules) {
    if (rules.maxError) {
      const best = this.best();
      const allTargetsMatched = best.matches.length === this.cfg.targets.length;
      if (allTargetsMatched && best.matches.every((m) => Math.abs(m.error) <= rules.maxError)) {
        return `цель достигнута: все стрелки точнее ${(rules.maxError * 100).toPrecision(2)}%`;
      }
    }
    if (rules.stagnation && this.generationsWithoutImprovement >= rules.stagnation) {
      return `застой: ${rules.stagnation} поколений без улучшения`;
    }
    if (rules.maxGenerations && this.generation >= rules.maxGenerations) {
      return `достигнут предел в ${rules.maxGenerations} поколений`;
    }
    return null;
  }

  // The highest-scoring clock in the pool. Among equals - the oldest one,
  // so the picture does not jump between equivalent clocks.
  best() {
    let best = this.pool[0];
    for (const c of this.pool) {
      if (c.score > best.score || (c.score === best.score && c.id < best.id)) best = c;
    }
    return best;
  }
}
