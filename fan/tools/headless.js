// Run the evolution of fan blades without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [species|plain] [loud|silent] [ambient]
//        node tools/headless.js check [loud|silent] [ambient]   - the classic fans in detail and the best of 100 random ones
//        ambient: none | night | crickets | rain | city (for the goal "silent", default night)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The page scripts run in this very context (as classic <script>s share one global scope).
const FILES = ['rng.js', 'room.js', 'fan.js', 'aero.js', 'acoustics.js', 'ambient.js', 'fitness.js', 'evolution.js'];
for (const file of FILES) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), { filename: file });
}
const run = (code) => vm.runInThisContext(code);
const goalArgs = process.argv[2] === 'check' ? process.argv.slice(3) : process.argv.slice(6);
const setup = { goal: goalArgs[0] === 'silent' ? 'silent' : 'loud', ambient: goalArgs[1] || 'night' };
const evaluate = (g) => run('evaluateFan')(g, setup);

const describe = (d) => d.rating === undefined ? `${d.score.toFixed(2)} (${run('CLASS_NAMES')[d.cls]})` :
  `${d.score.toFixed(2)} (${run('speciesName')(d.species)}, L_R ${d.rating.toFixed(1)} дБА = L_A ${d.la.toFixed(1)} + K_T ${d.kt.toFixed(1)}; ` +
  `упор ${d.thrust.toFixed(2)} Н, ${d.power.toFixed(1)} Вт, срыв ${(100 * d.stalled).toFixed(0)}%, ${run('CLASS_NAMES')[d.cls]}` +
  (d.quietBreeze !== undefined ? `; неслышно: ${d.nightRpm.toFixed(0)} об/мин, ветер ${d.quietBreeze.toFixed(2)} м/с` : '') + ')';

if (process.argv[2] === 'check') {
  for (const name of ['REFERENCE', 'OLD_METAL', 'FIVE_SICKLE', 'FIVE_UNEVEN']) {
    const g = run(name);
    const a = run('analyzeFan')(g, setup);
    console.log(`${name}: ${describe(evaluate(g))}`);
    if (!a.blows) continue;
    const c = a.noise;
    console.log(`  тоны ${c.laTones.toFixed(1)} дБА, сплошной ${c.laBroadband.toFixed(1)} дБА (${c.broadband.toFixed(1)} дБ, пик ${c.teFreq.toFixed(0)} Гц, срыв ${Number.isFinite(c.stall) ? c.stall.toFixed(1) : '—'} дБ); ` +
      `худший тон ${c.worst ? `${c.worst.f.toFixed(0)} Гц ${c.worst.level.toFixed(1)} дБ, слышимость ${c.audibility.toFixed(1)}` : '—'}`);
    console.log(`  поток ${(a.flow * 60).toFixed(1)} м³/мин, ветер у диска ${a.breeze.disc.toFixed(2)} м/с, в 2 м ${a.breeze.at.toFixed(2)} м/с; ` +
      `σ ${(a.stress / 1e6).toFixed(1)} МПа на ${a.stressAt.toFixed(2)} R, тоньше всего ${(a.thinnest * 1000).toFixed(1)} мм, перекрытие ${a.overlap.toFixed(2)}, ` +
      `дисбаланс ${a.balance.imbalance.toExponential(1)}, углы ${a.balance.angles.map((t) => (t * 180 / Math.PI).toFixed(0)).join('/')}`);
    console.log('  тоны:', c.tones.filter((t) => t.level > 0).slice(0, 12).map((t) => `${t.h}:${t.f.toFixed(0)}Гц ${t.level.toFixed(0)}`).join(' '));
    console.log('  x/α°/CL/Re/срыв:', a.op.elements.map((e, i) => `${e.x.toFixed(2)}/${(e.alpha * 180 / Math.PI).toFixed(1)}/${e.cl.toFixed(2)}/${(e.re / 1000).toFixed(0)}k/${(100 * a.prep.strips[i].share).toFixed(0)}`).join(' '));
  }
  const rng = run('makeRng(1)');
  const list = Array.from({ length: 100 }, () => evaluate(run('randomFan')(rng)));
  list.sort((a, b) => b.score - a.score);
  console.log('случайные: лучший', describe(list[0]));
  console.log('случайные: медиана', list[50].score.toFixed(1), 'классы', run('CLASS_NAMES').map((n, i) => `${n} ${list.filter((d) => d.cls === i).length}`).join(', '));
  const t0 = Date.now();
  for (let k = 0; k < 200; k++) evaluate(run('REFERENCE'));
  console.log(`одна оценка ${((Date.now() - t0) / 200).toFixed(2)} мс`);
  process.exit(0);
}

const generations = Number(process.argv[2] || 60);
const populationSize = Number(process.argv[3] || 100);
const seed = Number(process.argv[4] || 1);
const speciation = (process.argv[5] || 'species') === 'species';

globalThis.cfg = { seed, populationSize, mutationsPerChild: 1, speciation };
const started = Date.now();
const evo = run('new Evolution(cfg)');
const names = run('CLASS_NAMES');
const genomes = evo.firstGenomes();
evo.start(genomes, genomes.map(evaluate));

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null).filter(Boolean);
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ${describe(best)}`);
}

console.log(`эталон: ${describe(evaluate(run('REFERENCE')))}`);
report();
let lastReport = 0;
while (evo.matings < generations * populationSize) {
  evo.stepBatch(evaluate);
  if (evo.generation - lastReport >= 10) { lastReport = Math.floor(evo.generation); report(); }
}
report();
console.log('виды (вид × штук = лучшая оценка):', evo.speciesTable().map((g) => `${run('speciesName')(g.key)}×${g.size}=${g.best.score.toFixed(1)}`).join(', '));
const best = evo.best();
const angles = run('bladeAngles')(best.genome).angles.map((t) => (t * 180 / Math.PI).toFixed(1));
console.log('углы лопастей:', angles.join(' / '));
const round = (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v);
console.log(JSON.stringify(best.genome, round));
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(0)} s (${(evo.matings / seconds).toFixed(1)}/s)`);
