// Run the evolution without a browser and print the population over time.
// Usage: node tools/headless.js [generations] [populationSize] [seed]
// Loads the same js/*.js files the page uses, so results match the browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ console, Math, Set, Map, Array, Infinity });
for (const file of ['rng.js', 'genome.js', 'mechanism.js', 'fitness.js', 'evolution.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context, { filename: file });
}

const generations = Number(process.argv[2] || 300);
const populationSize = Number(process.argv[3] || 2000);
const seed = Number(process.argv[4] || 1);

context.cfg = {
  seed, populationSize, mutationsPerChild: 1, maxTeeth: 1000, initialBonds: 10,
  targets: [60, 3600, 86400],
};
const started = Date.now();
const evo = vm.runInContext('new Evolution(cfg)', context);
const names = vm.runInContext('CLASS_NAMES', context);

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null).filter(Boolean);
  const hands = best.matches.map((m) => `${m.period.toFixed(3)}s→${m.target}`).join(' ');
  console.log(`gen ${evo.generation.toFixed(0).padStart(5)} | ${shares.join(', ')} | best ${best.score.toFixed(4)} ${hands}`);
}

report();
const total = generations * populationSize;
while (evo.matings < total) {
  evo.step();
  if (evo.matings % (populationSize * 25) === 0) report();
}
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(1)} s (${Math.round(evo.matings / seconds)}/s)`);
