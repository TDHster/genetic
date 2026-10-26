// Run the evolution of wind turbine rotors without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [species|plain]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The page scripts run in this very context (as classic <script>s share one global scope).
for (const file of ['rng.js', 'airfoil.js', 'rotor.js', 'aero.js', 'fitness.js', 'evolution.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), { filename: file });
}
const run = (code) => vm.runInThisContext(code);

const generations = Number(process.argv[2] || 60);
const populationSize = Number(process.argv[3] || 100);
const seed = Number(process.argv[4] || 1);
const speciation = (process.argv[5] || 'species') === 'species';

globalThis.cfg = { seed, populationSize, mutationsPerChild: 1, speciation };
const started = Date.now();
const evo = run('new Evolution(cfg)');
const score = run('evaluateRotor');
const names = run('CLASS_NAMES');
const reference = run('evaluateRotor(REFERENCE)');
const genomes = evo.firstGenomes();
evo.start(genomes, genomes.map(score));

const describe = (d) => `${d.score.toFixed(2)} (${d.species} лоп., ${d.useful.toFixed(0)} полезных кВт·ч/год из ${d.aepAll.toFixed(0)}, ` +
  `старт ${d.selfStart ? d.vStart.toFixed(1) + ' м/с' : 'мотором'}, Cp ${d.cpOwn.toFixed(3)} при λ ${d.lambdaOpt}, ` +
  `пульсация ${d.ripple.toFixed(2)}, материал ${d.area.toFixed(2)} м²)`;

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null).filter(Boolean);
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ${describe(best)}`);
}

console.log(`эталон: ${describe({ ...reference, species: 3 })}`);
report();
let lastReport = 0;
while (evo.matings < generations * populationSize) {
  evo.stepBatch(score);
  if (evo.generation - lastReport >= 10) { lastReport = Math.floor(evo.generation); report(); }
}
report();
console.log('виды (лопастей × роторов = лучшая оценка):', evo.speciesTable().map((g) => `${g.blades}×${g.size}=${g.best.score.toFixed(1)}`).join(' '));
const round = (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v);
console.log(JSON.stringify(evo.best().genome, round));
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(0)} s (${(evo.matings / seconds).toFixed(1)}/s)`);
