'use strict';
// EVOLUTION: the same scheme as in the clock project.
//   1. take 3 random legs from the pool;
//   2. the worst one dies;
//   3. the two survivors mate, the child gets one mutation;
//   4. the child takes the dead leg's place.
// One "generation" = as many matings as there are legs in the pool.
// Nothing here knows what a leg is: only scores are compared.
//
// SPECIES (the idea of the NEAT algorithm: "protecting innovation").
// Without species, free mode gets stuck on simple legs: a fresh complex leg walks badly
// until its lengths are tuned, and dies in its first tournament against a tuned simple leg.
// With species on (cfg.speciation):
//   - a leg's species = how many moving links (rigid bodies) it has: 3 for a 4-bar linkage,
//     7 for Jansen's leg. Not the number of joints: a chain of rigid triangles adds joints
//     but no links - it is one solid body;
//   - the pool is split into QUOTAS: every species is guaranteed MIN_SPECIES places,
//     the remaining places are shared in proportion to the best leg of each species;
//   - BIRTH: a species is picked with probability proportional to its quota, a tournament
//     of 3 inside it picks the parents (a species of 1-2 legs breeds anyway);
//   - DEATH: in the species that is furthest over its quota, the worst of 3 random legs dies.
// So a new complex species gets its places and time to tune, while good species grow.
// The child may belong to another species (a mutation changed the scheme) - that is how
// new species appear. Without species: the plain scheme above, on the whole pool.
//
// STOPPING: evolution never stops by itself. stopReason() implements the usual rules:
// goal reached, stagnation (no improvement for N generations), generation limit.

const MIN_SPECIES = 10;          // places guaranteed to every species (if the pool is big enough)
const QUOTA_UPDATE_EVERY = 50;   // matings between quota recalculations

class Evolution {
  constructor(cfg) {
    this.cfg = cfg;
    // Optional fitness rules must be set before any leg is scored (Jansen is rescored too).
    if (cfg.fitness) setFitnessOptions(cfg.fitness);
    this.rng = makeRng(cfg.seed);
    this.nextId = 1;
    this.matings = 0;
    this.pool = [];
    for (let i = 0; i < cfg.populationSize; i++) this.pool.push(this.createLeg(randomLeg(this.rng, cfg.mode), null));
    this.counts = new Array(CLASS_NAMES.length).fill(0);
    for (const c of this.pool) this.counts[c.cls]++;
    this.history = [this.snapshot()]; // one row per generation
    this.bestScore = Math.max(...this.pool.map((c) => c.score));
    this.lastImprovementAt = 0;
    // Species: species -> list of pool indices; position of each index in its list; quotas.
    this.members = new Map();
    this.memberPos = [];
    this.pool.forEach((_, i) => this.joinSpecies(i));
    this.quotas = new Map();
    this.updateQuotas();
  }

  joinSpecies(i) {
    const key = this.pool[i].links;
    if (!this.members.has(key)) this.members.set(key, []);
    const list = this.members.get(key);
    this.memberPos[i] = list.length;
    list.push(i);
  }

  leaveSpecies(i) {
    const key = this.pool[i].links;
    const list = this.members.get(key);
    const last = list.pop();
    if (last !== i) {
      list[this.memberPos[i]] = last;
      this.memberPos[last] = this.memberPos[i];
    }
    if (list.length === 0) this.members.delete(key);
  }

  // Quotas: a guaranteed minimum for every species with a foot, the rest by the best leg.
  updateQuotas() {
    const size = this.pool.length;
    const species = [...this.members.keys()];
    const withFoot = species.filter((k) => k > 1); // 1 link = only the crank, no leg
    const minimum = Math.min(MIN_SPECIES, Math.floor(size / 2 / Math.max(1, withFoot.length)));
    const best = new Map();
    for (const k of species) best.set(k, Math.max(...this.members.get(k).map((i) => this.pool[i].score)));
    // Only what is above "turns but does not walk" (score 1) counts.
    const weight = (k) => Math.max(0, best.get(k) - 1);
    const totalWeight = species.reduce((sum, k) => sum + weight(k), 0);
    const rest = size - minimum * withFoot.length;
    this.quotas = new Map();
    for (const k of species) {
      const share = totalWeight > 0 ? weight(k) / totalWeight : 1 / species.length;
      this.quotas.set(k, (k > 1 ? minimum : 0) + rest * share);
    }
  }

  // Up to `count` different random members of a species.
  randomMembers(key, count) {
    const list = this.members.get(key);
    const picked = [];
    while (picked.length < Math.min(count, list.length)) {
      const i = list[this.rng.int(list.length)];
      if (!picked.includes(i)) picked.push(i);
    }
    return picked;
  }

  createLeg(genome, parents) {
    const result = evaluateLeg(genome);
    let joints = 0;
    for (const p of result.sim.used) if (p >= FIXED_POINTS) joints++;
    // Species = number of moving links (rigid bodies), see rigidBodies() in linkage.js.
    const links = rigidBodies(genome, result.sim.used).links;
    return { id: this.nextId++, genome, ...result, joints, links, parents };
  }

  // What we remember about each generation: class counts and the best score.
  snapshot() {
    return { counts: this.counts.slice(), best: this.bestScore || Math.max(...this.pool.map((c) => c.score)) };
  }

  get generation() {
    return this.matings / this.pool.length;
  }

  get generationsWithoutImprovement() {
    return (this.matings - this.lastImprovementAt) / this.pool.length;
  }

  step() {
    return this.cfg.speciation ? this.stepWithSpecies() : this.stepPlain();
  }

  // The plain scheme: 3 random legs from the whole pool, the worst dies.
  stepPlain() {
    const size = this.pool.length;
    const picked = [];
    while (picked.length < 3) {
      const i = this.rng.int(size);
      if (!picked.includes(i)) picked.push(i);
    }
    picked.sort((a, b) => this.pool[b].score - this.pool[a].score);
    const [momIdx, dadIdx, loserIdx] = picked;
    return this.breed(this.pool[momIdx], this.pool[dadIdx], loserIdx);
  }

  // With species: parents from a species picked by quota, death in the most crowded species.
  stepWithSpecies() {
    if (this.matings % QUOTA_UPDATE_EVERY === 0) this.updateQuotas();

    // Birth: pick a species with probability proportional to its quota.
    const keys = [...this.members.keys()];
    let r = this.rng.next() * keys.reduce((sum, k) => sum + (this.quotas.get(k) || 0), 0);
    let parentSpecies = keys[keys.length - 1];
    for (const k of keys) {
      r -= this.quotas.get(k) || 0;
      if (r <= 0) { parentSpecies = k; break; }
    }
    const parents = this.randomMembers(parentSpecies, 3).sort((a, b) => this.pool[b].score - this.pool[a].score);
    const mom = this.pool[parents[0]], dad = this.pool[parents[1] !== undefined ? parents[1] : parents[0]];

    // Death: in the species furthest over its quota, the worst of 3 random legs.
    let deathSpecies = keys[0], over = -Infinity;
    for (const k of keys) {
      const excess = this.members.get(k).length - (this.quotas.get(k) || 0);
      if (excess > over) { over = excess; deathSpecies = k; }
    }
    const doomed = this.randomMembers(deathSpecies, 3).sort((a, b) => this.pool[a].score - this.pool[b].score)[0];

    const result = this.breed(mom, dad, doomed);
    result.parentSpecies = parentSpecies;
    result.deathSpecies = deathSpecies;
    return result;
  }

  // Mate two parents, mutate the child, put it in place of pool[loserIdx].
  breed(mom, dad, loserIdx) {
    const size = this.pool.length;
    const loser = this.pool[loserIdx];
    const genome = crossover(mom.genome, dad.genome, this.rng);
    const mutations = [];
    for (let m = 0; m < this.cfg.mutationsPerChild; m++) mutations.push(mutate(genome, this.rng, this.cfg.mode));
    const child = this.createLeg(genome, [mom.id, dad.id]);

    this.leaveSpecies(loserIdx);
    this.pool[loserIdx] = child;
    this.joinSpecies(loserIdx);
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

  // For the UI: every species with its size, quota and best leg, simplest first.
  speciesTable() {
    return [...this.members.entries()]
      .map(([links, list]) => {
        let best = this.pool[list[0]];
        for (const i of list) if (this.pool[i].score > best.score) best = this.pool[i];
        return { links, size: list.length, quota: this.quotas.get(links) || 0, best };
      })
      .sort((a, b) => a.links - b.links);
  }

  // rules: { beatJansen: 0.05 (wanted margin over Jansen, fraction), stagnation: 200, maxGenerations: 2000 }; 0 = off.
  stopReason(rules) {
    if (rules.beatJansen && this.bestScore > JANSEN_SCORE * (1 + rules.beatJansen)) {
      // Report the margin actually reached, not the threshold (the threshold is often 0%).
      const margin = (this.bestScore / JANSEN_SCORE - 1) * 100;
      const wanted = rules.beatJansen * 100;
      return `цель достигнута: лучшая нога на ${margin.toFixed(1)}% лучше ноги Янсена` +
        (wanted >= 0.05 ? ` (нужно было ${wanted.toFixed(wanted < 1 ? 1 : 0)}%)` : '');
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
    for (const c of this.pool) {
      if (c.score > best.score || (c.score === best.score && c.id < best.id)) best = c;
    }
    return best;
  }
}
