// Run the bridge evolution without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [terrainSeed] [light|strength|budget] [budgetFactor]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ console, Math });
for (const file of ['rng.js', 'terrain.js', 'truss.js', 'bridge.js', 'fitness.js', 'evolution.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context, { filename: file });
}

const generations = Number(process.argv[2] || 300);
const populationSize = Number(process.argv[3] || 300);
const seed = Number(process.argv[4] || 1);
const terrainSeed = Number(process.argv[5] || 1);
const mode = process.argv[6] || 'light';
const budgetFactor = Number(process.argv[7] || 1);
context.cfg = { seed, populationSize, mutationsPerChild: 1, task: { terrainSeed, mode, budgetFactor } };
const started = Date.now();
const evo = vm.runInContext('new Evolution(cfg)', context);
const names = vm.runInContext('CLASS_NAMES', context);
const terrain = vm.runInContext('TERRAIN', context);
const warren = vm.runInContext('REFS.warren', context);
const budget = vm.runInContext('TASK.budget', context);
if (mode === 'budget') console.log(`бюджет стали ${budget.toFixed(2)} т`);
console.log(`долина ${terrainSeed}: пролёт ${terrain.span} м, глубина ${terrain.depth.toFixed(1)} м${terrain.rock ? ', скала' : ''}; ` +
  (warren ? `ферма Уоррена ${warren.mass.toFixed(2)} т (u = ${warren.u.toFixed(2)}, u·M = ${(warren.u * warren.mass).toFixed(2)} т)` : 'ферма Уоррена не держит'));

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => (c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null)).filter(Boolean);
  const what = mode === 'budget' && best.cls >= 2 ? `${best.mass.toFixed(2)} т, запас ×${(1 / best.u).toFixed(2)}` : best.cls >= 2 ? `${best.mass.toFixed(2)} т, u = ${best.u.toFixed(2)}, u·M = ${(best.u * best.mass).toFixed(2)} т` : best.mechanism ? `механизм ${best.mechanism}` : `u = ${best.u.toFixed(2)}`;
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ${best.score.toFixed(4)} ${what}` +
    ` | узлов ${best.genome.nodes.length}, стержней ${best.genome.bars.length}, опор ${best.supports}`);
}

report();
const every = Number(process.env.EVERY || 50);
while (evo.matings < generations * populationSize) {
  evo.step();
  if (evo.matings % (populationSize * every) === 0) report();
}
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(1)} s (${Math.round(evo.matings / seconds)}/s)`);
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify({ terrain, best: evo.best().genome }));
