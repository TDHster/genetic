// Run the evolution of airfoils without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [Re] [min thickness] [min Cm or none; default -0.1]
//        node tools/headless.js polar [NACA code] [Re]     - print a polar of a NACA airfoil (model check)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The page scripts run in this very context (as classic <script>s share one global scope).
for (const file of ['rng.js', 'linalg.js', 'geometry.js', 'panel.js', 'boundary.js', 'aero.js', 'fitness.js', 'evolution.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), { filename: file });
}
const run = (code) => vm.runInThisContext(code);
const fx = (v, d) => (v === null || v === undefined ? '—' : v.toFixed(d));

if (process.argv[2] === 'polar') {
  const code = process.argv[3] || '4412', re = Number(process.argv[4] || 1e6);
  globalThis.args = { code, re };
  const pts = run('sweepPolar(preparePanels(airfoilShape(nacaGenome(args.code))), args.re, {})');
  console.log(`NACA ${code}, Re ${re.toExponential(1)}`);
  console.log('  α     Cl      Cd   (трение)    L/D     Cm   переход верх/низ   отрыв верх/низ');
  for (const p of pts) {
    if (p.failed) { console.log(`${String(p.alpha).padStart(5)}  не сошлось`); continue; }
    console.log(`${p.alpha.toFixed(1).padStart(5)} ${p.cl.toFixed(3).padStart(6)} ${p.cd.toFixed(5)} (${p.cdf.toFixed(5)}) ` +
      `${p.ld.toFixed(1).padStart(6)} ${p.cm.toFixed(3).padStart(6)}   ${fx(p.xtrU, 2)} / ${fx(p.xtrL, 2)}        ` +
      `${fx(p.sepU, 2)} / ${fx(p.sepL, 2)} ${p.attached ? '' : ' срыв'}`);
  }
  process.exit(0);
}

const generations = Number(process.argv[2] || 60);
const populationSize = Number(process.argv[3] || 100);
const seed = Number(process.argv[4] || 1);
const re = Number(process.argv[5] || 1e6);
const tMin = Number(process.argv[6] || 0.12);
const cmMin = process.argv[7] === undefined ? run('SETUP').cmMin : process.argv[7] === 'none' ? null : Number(process.argv[7]);

globalThis.cfg = { seed, populationSize, mutationsPerChild: 1 };
globalThis.setup = { ...run('SETUP'), re, tMin, cmMin };
const started = Date.now();
const evo = run('new Evolution(cfg)');
const score = (g) => run('evaluateAirfoil')(g, globalThis.setup);
const names = run('CLASS_NAMES');
const refCode = run('referenceCode(setup)');
const reference = score(run(`nacaGenome('${refCode}')`));
const genomes = evo.firstGenomes();
evo.start(genomes, genomes.map(score));

const describe = (d) => `${d.score.toFixed(2)} (L/D ${fx(d.ld, 1)} при α ${fx(d.alpha, 1)}°, Cl ${fx(d.cl, 3)}, Cd ${fx(d.cd, 5)}, ` +
  `Cm ${fx(d.cm, 3)}, толщина ${(100 * d.t).toFixed(1)}% в ${(100 * d.tAt).toFixed(0)}%, кривизна ${(100 * d.camber).toFixed(1)}% в ${(100 * d.camberAt).toFixed(0)}%, ` +
  `переход ${fx(d.xtrU, 2)}/${fx(d.xtrL, 2)}, Cl max ${d.clMax.toFixed(2)})`;

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null).filter(Boolean);
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ${describe(best)}`);
}

console.log(`Re ${re.toExponential(1)}, толщина от ${(100 * tMin).toFixed(0)}%, Cm от ${cmMin === null ? '—' : cmMin}`);
console.log(`эталон NACA ${refCode}: ${describe(reference)}`);
report();
let lastReport = 0;
while (evo.matings < generations * populationSize) {
  evo.stepBatch(score);
  if (evo.generation - lastReport >= 10) { lastReport = Math.floor(evo.generation); report(); }
}
report();
const round = (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v);
console.log(JSON.stringify(evo.best().genome, round));
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(0)} s (${(evo.matings / seconds).toFixed(1)}/s)`);
