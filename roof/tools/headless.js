// Run the roof evolution without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [drop|rain] [width] [height] [segments] [floor]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ console, Math });
for (const file of ['rng.js', 'roof.js', 'fitness.js', 'evolution.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context, { filename: file });
}

const generations = Number(process.argv[2] || 300);
const populationSize = Number(process.argv[3] || 500);
const seed = Number(process.argv[4] || 1);
const task = {
  rain: (process.argv[5] || 'drop') === 'rain',
  width: Number(process.argv[6] || 4),
  height: Number(process.argv[7] || 3),
  segments: Number(process.argv[8] || 16),
  floor: process.argv[9] === 'floor',
};
context.cfg = { seed, populationSize, mutationsPerChild: 1, task };
const started = Date.now();
const evo = vm.runInContext('new Evolution(cfg)', context);
const names = vm.runInContext('CLASS_NAMES', context);
const refs = vm.runInContext('REFS', context);
const t = (r) => (r.ok ? `${r.time.toFixed(4)} с` : `застревает (${(r.share * 100).toFixed(0)}%)`);
console.log(`эталоны: прямой ${t(refs.line)}, дуга ${t(refs.arc)}, циклоида ${t(refs.cycloid)}` +
  (task.rain ? '' : ` (точно ${refs.cycloid.shape.exactTime.toFixed(4)} с)`));

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => (c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null)).filter(Boolean);
  const gap = best.ok && refs.cycloid.ok ? ` (циклоида ${((best.time / refs.cycloid.time - 1) * 100).toFixed(2)}%)` : '';
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ${best.score.toFixed(4)} ${t(best)}${gap}`);
}

report();
while (evo.matings < generations * populationSize) {
  evo.step();
  if (evo.matings % (populationSize * 50) === 0) report();
}
console.log('best roof, см:', evo.best().genome.ys.map((y) => (y * 100).toFixed(0)).join(' '));
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(1)} s (${Math.round(evo.matings / seconds)}/s)`);
