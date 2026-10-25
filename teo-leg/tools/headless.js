// Run the leg evolution without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [free|jansen] [species|plain]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ console, Math, Set });
for (const file of ['rng.js', 'linkage.js', 'fitness.js', 'evolution.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context, { filename: file });
}

const generations = Number(process.argv[2] || 300);
const populationSize = Number(process.argv[3] || 1000);
const seed = Number(process.argv[4] || 1);
const mode = process.argv[5] || 'free';
const speciation = (process.argv[6] || 'species') === 'species';

// Optional fitness rules (weights 0..1, 0 = off): FIT=height,angle,compact, e.g. FIT=0.5,0.5,0.2 (default 5% each)
const [height, angle, compact] = (process.env.FIT || '0.05,0.05,0.05').split(',').map(Number);
context.cfg = { seed, populationSize, mutationsPerChild: 1, mode, speciation, fitness: { height, angle, compact } };
const started = Date.now();
const evo = vm.runInContext('new Evolution(cfg)', context);
const names = vm.runInContext('CLASS_NAMES', context);
const jansen = vm.runInContext('JANSEN_SCORE', context);

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null).filter(Boolean);
  const g = best.gait;
  const gait = g ? `шаг ${g.stride.toFixed(1)} см, на земле ${(g.share * 100).toFixed(0)}%, ровность ${g.evenness.toFixed(2)}, подъём ${g.lift.toFixed(1)} см` : '';
  const top = evo.speciesTable().reduce((a, b) => (b.size > a.size ? b : a));
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | чаще всего ${top.links}зв (${(100 * top.size / evo.pool.length).toFixed(0)}%) | best ${best.links}зв ${best.score.toFixed(2)} (Янсен ${jansen.toFixed(2)}) ${gait}`);
}

report();
while (evo.matings < generations * populationSize) {
  evo.step();
  if (evo.matings % (populationSize * 25) === 0) report();
}
const best = evo.best();
console.log('виды (звеньев × ног = лучшая оценка):', evo.speciesTable().map((g) => `${g.links}зв×${g.size}=${g.best.score.toFixed(1)}`).join(' '));
const used = best.sim.used;
console.log('best leg:', best.genome.joints.map((j, k) => {
  const i = 4 + k, name = context.pointName(i);
  return `${used.has(i) ? '' : '('}${name}${i === best.genome.foot ? '*' : ''}=${context.pointName(j.a)}:${j.ra.toFixed(1)}+${context.pointName(j.b)}:${j.rb.toFixed(1)}${used.has(i) ? '' : ')'}`;
}).join(' '), '| frame', best.genome.frame.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(' '));
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(1)} s (${Math.round(evo.matings / seconds)}/s)`);
