// Run the evolution of submarine propellers without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [species|plain] [reference|sea] [calm|moderate|rough]
//        node tools/headless.js check [reference|sea] [calm|moderate|rough]   - the classic propellers in detail
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The page scripts run in this very context (as classic <script>s share one global scope).
for (const file of ['rng.js', 'boat.js', 'propeller.js', 'hydro.js', 'noise.js', 'sea.js', 'fitness.js', 'evolution.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), { filename: file });
}
const run = (code) => vm.runInThisContext(code);

const kn = (v) => (v / run('KNOT')).toFixed(1);
// The goal: as on the page (default - quieter than the reference).
const goalArgs = process.argv[2] === 'check' ? process.argv.slice(3) : process.argv.slice(6);
const setup = { goal: goalArgs[0] === 'sea' ? 'sea' : 'reference', sea: goalArgs[1] || 'moderate' };
const evaluate = (g) => run('evaluatePropeller')(g, setup);
const describe = (d) => d.noise === undefined ? `${d.score.toFixed(2)} (${run('CLASS_NAMES')[d.cls]})` :
  `${d.score.toFixed(2)} (${run('speciesName')(d.species)}, шум ${d.noise.toFixed(1)} дБ: тоны ${d.tonal.toFixed(1)}, ` +
  `сплошной ${d.broadband.toFixed(1)}, кавит. ${Number.isFinite(d.cavitation) ? d.cavitation.toFixed(1) : '—'}; ` +
  `кавитация с ${kn(d.inception)} уз; макс. ${kn(d.vMax)} уз, КПД ${d.eta.toFixed(3)}, ${d.rpm.toFixed(0)} об/мин, ` +
  `σ корня ${(d.stress / 1e6).toFixed(0)} МПа, перекрытие ${d.overlap.toFixed(2)}` +
  (d.range !== undefined ? `; слышно с ${d.range.toFixed(0)} м (${d.worstKind === 'tone' ? 'тон' : 'полоса'} ${d.worstF.toFixed(0)} Гц)` : '') + ')';

if (process.argv[2] === 'check') {
  for (const name of ['REFERENCE', 'SHIP_FOUR', 'FIVE_SKEWED', 'PUMP_JET']) {
    const g = run(name);
    const a = run('analyzePropeller')(g, setup);
    console.log(`${name}: ${describe(evaluate(g))}`);
    console.log(`  J ${a.J.toFixed(3)}, KT ${a.op.KT.toFixed(3)}, 10KQ ${(10 * a.op.KQ).toFixed(3)}, ` +
      `патруль ${(a.power / 1000).toFixed(0)} кВт, EAR ${a.area.toFixed(2)}`);
    console.log('  тоны:', a.noise.tones.map((t) => `${t.f.toFixed(1)} Гц ${t.level.toFixed(1)} (без откоса ${t.noSkew.toFixed(1)})`).join(', '));
    console.log('  x/α°/CL/−Cpmin:', a.op.elements.map((e) => `${e.x.toFixed(2)}/${(e.alpha * 180 / Math.PI).toFixed(1)}/${e.cl.toFixed(2)}/${e.suction.toFixed(2)}`).join(' '));
  }
  const rng = run('makeRng(1)');
  const list = Array.from({ length: 100 }, () => evaluate(run('randomPropeller')(rng)));
  list.sort((a, b) => b.score - a.score);
  console.log('случайные: лучший', describe(list[0]));
  console.log('случайные: медиана', list[50].score.toFixed(1), 'классы', run('CLASS_NAMES').map((n, i) => `${n} ${list.filter((d) => d.cls === i).length}`).join(', '));
  process.exit(0);
}

const generations = Number(process.argv[2] || 60);
const populationSize = Number(process.argv[3] || 100);
const seed = Number(process.argv[4] || 1);
const speciation = (process.argv[5] || 'species') === 'species';

globalThis.cfg = { seed, populationSize, mutationsPerChild: 1, speciation };
const started = Date.now();
const evo = run('new Evolution(cfg)');
const score = evaluate;
const names = run('CLASS_NAMES');
const reference = evaluate(run('REFERENCE'));
const genomes = evo.firstGenomes();
evo.start(genomes, genomes.map(score));

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null).filter(Boolean);
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ${describe(best)}`);
}

console.log(`эталон: ${describe(reference)}`);
report();
let lastReport = 0;
while (evo.matings < generations * populationSize) {
  evo.stepBatch(score);
  if (evo.generation - lastReport >= 10) { lastReport = Math.floor(evo.generation); report(); }
}
report();
console.log('виды (вид × винтов = лучшая оценка):', evo.speciesTable().map((g) => `${run('speciesName')(g.key)}×${g.size}=${g.best.score.toFixed(1)}`).join(', '));
const round = (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v);
console.log(JSON.stringify(evo.best().genome, round));
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(0)} s (${(evo.matings / seconds).toFixed(1)}/s)`);
