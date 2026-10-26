'use strict';
// EVOLUTION: the same scheme as in the clock, leg and coast projects (this file is a copy of coast/js/evolution.js).
//   1. take 3 random rotors from the pool, the best two are the parents;
//   2. they mate, the child gets one mutation;
//   3. the worst of 3 random rotors dies, the child takes its place.
// One "generation" = as many matings as there are rotors in the pool.
// Nothing here knows what a rotor is: only scores are compared.
//
// BATCHES. Scoring a rotor means a whole torque table (~10 ms), so children are scored in
// parallel (Web Workers in the browser). The loop is split in two:
//   propose() - pick parents, make a child genome (uses the rng);
//   accept()  - when the score is known: pick who dies, put the child in (uses the rng).
// BATCH children are proposed from the same pool, then accepted in the order they were proposed.
// So a run depends only on the seed - not on how many workers there are or which finishes first.
//
// SPECIES (the idea of the NEAT algorithm: "protecting innovation"), as in teo-leg:
//   - species = number of blades (cfg.speciation);
//   - every species is guaranteed MIN_SPECIES places, the rest is shared by the best score of each species;
//   - birth: a species by its quota, a tournament inside it; death: in the species furthest over its quota.
// A fresh 5-blade rotor is worse than a tuned 3-blade one until its blades get the right size;
// without species it dies in the first tournament.

const MIN_SPECIES = 8;           // places guaranteed to every species (if the pool is big enough)
const QUOTA_UPDATE_EVERY = 50;   // matings between quota recalculations
const BATCH = 8;                 // children scored at once

class Evolution {
  // cfg: { seed, populationSize, mutationsPerChild, speciation }.
  // The first pool must be scored too: firstGenomes() -> score them -> start(results).
  constructor(cfg) {
    this.cfg = cfg;
    this.rng = makeRng(cfg.seed);
    this.nextId = 1;
    this.matings = 0;
    this.pool = [];
  }

  firstGenomes() {
    const list = [];
    for (let i = 0; i < this.cfg.populationSize; i++) list.push(randomRotor(this.rng));
    return list;
  }

  // results[i] = evaluateRotor(genomes[i])
  start(genomes, results) {
    this.pool = genomes.map((g, i) => this.makeRotor(g, results[i], null));
    this.counts = new Array(CLASS_NAMES.length).fill(0);
    for (const d of this.pool) this.counts[d.cls]++;
    this.bestScore = Math.max(...this.pool.map((d) => d.score));
    this.history = [this.snapshot()]; // one row per generation
    this.lastImprovementAt = 0;
    this.members = new Map();         // species -> list of pool indices
    this.memberPos = [];              // position of each index in its list
    this.pool.forEach((_, i) => this.joinSpecies(i));
    this.quotas = new Map();
    this.updateQuotas();
  }

  makeRotor(genome, result, parents) {
    return { id: this.nextId++, genome, ...result, parents };
  }

  joinSpecies(i) {
    const key = this.pool[i].species;
    if (!this.members.has(key)) this.members.set(key, []);
    const list = this.members.get(key);
    this.memberPos[i] = list.length;
    list.push(i);
  }

  leaveSpecies(i) {
    const key = this.pool[i].species;
    const list = this.members.get(key);
    const last = list.pop();
    if (last !== i) {
      list[this.memberPos[i]] = last;
      this.memberPos[last] = this.memberPos[i];
    }
    if (list.length === 0) this.members.delete(key);
  }

  // Quotas: a guaranteed minimum for every species, the rest by the best rotor of the species.
  updateQuotas() {
    const size = this.pool.length;
    const species = [...this.members.keys()];
    const minimum = Math.min(MIN_SPECIES, Math.floor(size / 2 / Math.max(1, species.length)));
    const best = new Map();
    for (const k of species) best.set(k, Math.max(...this.members.get(k).map((i) => this.pool[i].score)));
    const weight = (k) => Math.max(0, best.get(k) - 1); // only what is above "does not turn"
    const totalWeight = species.reduce((sum, k) => sum + weight(k), 0);
    const rest = size - minimum * species.length;
    this.quotas = new Map();
    this.quotasAt = this.matings;
    for (const k of species) {
      const share = totalWeight > 0 ? weight(k) / totalWeight : 1 / species.length;
      this.quotas.set(k, minimum + rest * share);
    }
  }

  // Up to `count` different random pool indices from a list.
  randomFrom(list, count) {
    const picked = [];
    while (picked.length < Math.min(count, list.length)) {
      const i = list[this.rng.int(list.length)];
      if (!picked.includes(i)) picked.push(i);
    }
    return picked;
  }

  get allIndices() {
    return this.pool.map((_, i) => i);
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

  // Parents and a child genome. Returns { genome, mom, dad, mutations, parentSpecies }.
  propose() {
    let candidates = this.allIndices, parentSpecies = null;
    if (this.cfg.speciation) {
      if (this.matings - this.quotasAt >= QUOTA_UPDATE_EVERY) this.updateQuotas();
      const keys = [...this.members.keys()];
      let r = this.rng.next() * keys.reduce((sum, k) => sum + (this.quotas.get(k) || 0), 0);
      parentSpecies = keys[keys.length - 1];
      for (const k of keys) {
        r -= this.quotas.get(k) || 0;
        if (r <= 0) { parentSpecies = k; break; }
      }
      candidates = this.members.get(parentSpecies);
    }
    const parents = this.randomFrom(candidates, 3).sort((a, b) => this.pool[b].score - this.pool[a].score);
    const mom = this.pool[parents[0]], dad = this.pool[parents[parents.length > 1 ? 1 : 0]];
    const genome = crossover(mom.genome, dad.genome, this.rng);
    const mutations = [];
    for (let m = 0; m < this.cfg.mutationsPerChild; m++) mutations.push(mutate(genome, this.rng));
    return { genome, mom, dad, mutations, parentSpecies };
  }

  // The child is scored: somebody dies, the child takes the place.
  accept(proposal, result) {
    let candidates = this.allIndices, deathSpecies = null;
    if (this.cfg.speciation) {
      let over = -Infinity;
      for (const [k, list] of this.members) {
        const excess = list.length - (this.quotas.get(k) || 0);
        if (excess > over) { over = excess; deathSpecies = k; }
      }
      candidates = this.members.get(deathSpecies);
    }
    const doomed = this.randomFrom(candidates, 3).sort((a, b) => this.pool[a].score - this.pool[b].score)[0];
    const loser = this.pool[doomed];
    const child = this.makeRotor(proposal.genome, result, [proposal.mom.id, proposal.dad.id]);
    this.leaveSpecies(doomed);
    this.pool[doomed] = child;
    this.joinSpecies(doomed);
    this.counts[loser.cls]--;
    this.counts[child.cls]++;
    this.matings++;
    if (child.score > this.bestScore) {
      this.bestScore = child.score;
      this.lastImprovementAt = this.matings;
    }
    if (this.matings % this.pool.length === 0) this.history.push(this.snapshot());
    return { ...proposal, loser, child, deathSpecies };
  }

  // A batch synchronously, for Node and tests: score(genome) -> result.
  stepBatch(score) {
    const proposals = [];
    for (let k = 0; k < BATCH; k++) proposals.push(this.propose());
    return proposals.map((p) => this.accept(p, score(p.genome)));
  }

  // For the UI: every species with its size, quota and best rotor, fewest blades first.
  speciesTable() {
    return [...this.members.entries()]
      .map(([blades, list]) => {
        let best = this.pool[list[0]];
        for (const i of list) if (this.pool[i].score > best.score) best = this.pool[i];
        return { blades, size: list.length, quota: this.quotas.get(blades) || 0, best };
      })
      .sort((a, b) => a.blades - b.blades);
  }

  // rules: { beatReference: 0.05 (wanted margin, fraction), stagnation: 50, maxGenerations: 300 }; 0 = off.
  stopReason(rules) {
    if (rules.beatReference && this.bestScore > REFERENCE_SCORE * (1 + rules.beatReference)) {
      const margin = (this.bestScore / REFERENCE_SCORE - 1) * 100;
      return `цель достигнута: лучший ротор на ${margin.toFixed(1)}% лучше эталона`;
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
}
