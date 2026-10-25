// Run the evolution of coastal defences without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [species|plain]
// One storm takes ~0.1 s, so runs are slow: start several seeds as separate processes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The page scripts run in this very context (as classic <script>s share one global scope).
// A separate vm context is 25% slower: every global lookup in the hot loops goes through it.
for (const file of ['rng.js', 'sim.js', 'design.js', 'fitness.js', 'evolution.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), { filename: file });
}
const run = (code) => vm.runInThisContext(code);

const generations = Number(process.argv[2] || 30);
const populationSize = Number(process.argv[3] || 60);
const seed = Number(process.argv[4] || 1);
const speciation = (process.argv[5] || 'species') === 'species';

globalThis.cfg = { seed, populationSize, mutationsPerChild: 1, speciation };
const started = Date.now();
const evo = run('new Evolution(cfg)');
const cache = run('new ScoreCache()');
const score = (genome) => cache.score(genome);
const names = run('CLASS_NAMES');
const reference = run('REFERENCE_SCORE');
const bare = run('bareCoast()');
const blocks = run('BLOCKS');
const genomes = evo.firstGenomes();
evo.start(genomes, genomes.map(score));

const describe = (d) => `${d.score.toFixed(2)} (${d.parts} сегм., перехлёст ${d.q.toFixed(2)} л/с·м, ` +
  `цена ${(d.cost.price / 1000).toFixed(0)} тыс., смыто ${(d.damage * 100).toFixed(1)}%)`;

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null).filter(Boolean);
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ${describe(best)}`);
}

console.log(`без защиты: перехлёст ${bare.q.toFixed(2)} л/с·м (худшая четверть), эталон: ${reference.toFixed(2)}`);
report();
let lastReport = 0;
while (evo.matings < generations * populationSize) {
  evo.stepBatch(score);
  if (evo.generation - lastReport >= 5) { lastReport = Math.floor(evo.generation); report(); }
}
report();
console.log('виды (сегментов × проектов = лучшая оценка):', evo.speciesTable().map((g) => `${g.parts}×${g.size}=${g.best.score.toFixed(1)}`).join(' '));
const best = evo.best();
console.log('best:', best.genome.segments.map((s) =>
  `[x ${s.x.toFixed(0)} y ${s.y.toFixed(0)} ∠${s.angle.toFixed(0)}° L ${s.length.toFixed(0)} W ${s.width.toFixed(0)} гребень ${s.crest.toFixed(1)} ${blocks[s.block].name}]`).join(' '));
console.log(JSON.stringify(best.genome));
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(0)} s (${(evo.matings / seconds).toFixed(1)}/s), ` +
  `${(100 * cache.hitRate).toFixed(0)}% from the cache`);
