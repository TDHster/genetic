// Run the road network evolution without a browser.
// Usage: node tools/headless.js [generations] [populationSize] [seed] [trilattice|grid|random|triangle|square|hexagon] [cities] [mapSeed] [routes|roads|tree] [tripShare, %]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ console, Math });
for (const file of ['rng.js', 'roads.js', 'fitness.js', 'evolution.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'), context, { filename: file });
}

const generations = Number(process.argv[2] || 500);
const populationSize = Number(process.argv[3] || 500);
const seed = Number(process.argv[4] || 1);
const task = {
  map: process.argv[5] || 'random',
  cities: Number(process.argv[6] || 15),
  mapSeed: Number(process.argv[7] || 1),
  mode: process.argv[8] || 'routes',
  tripShare: Number(process.argv[9] || 75) / 100,
};
context.cfg = { seed, populationSize, mutationsPerChild: 1, task };
const started = Date.now();
const evo = vm.runInContext('new Evolution(cfg)', context);
const names = vm.runInContext('CLASS_NAMES', context);
const refs = vm.runInContext('REFS', context);
const km = (l) => `${l.toFixed(3)} км`;
console.log(`городов ${vm.runInContext('CITIES.length', context)}: остов ${km(refs.mst.length)}, нижняя граница ${km(refs.bound.length)}` +
  (refs.exact ? `, точный ответ ${km(refs.exact.length)} (${(100 * (1 - refs.exact.length / refs.mst.length)).toFixed(2)}% короче остова)` : ''));

function report() {
  const best = evo.best();
  const shares = evo.counts.map((c, i) => (c ? `${names[i]} ${(100 * c / evo.pool.length).toFixed(0)}%` : null)).filter(Boolean);
  const gain = (100 * (1 - best.length / refs.mst.length)).toFixed(2);
  const gap = refs.exact ? `, от точного +${(100 * (best.length / refs.exact.length - 1)).toFixed(3)}%` : '';
  const roads = best.genome.roads ? `, дорог ${best.genome.roads.length} (лишних ${best.extra})` : '';
  console.log(`gen ${evo.generation.toFixed(0).padStart(4)} | ${shares.join(', ')} | best ` +
    (!best.connected ? `связано ${(100 * best.share).toFixed(0)}% городов`
      : task.mode === 'routes' ? `стоимость ${best.cost.toFixed(4)} (остов ${refs.mst.cost.toFixed(4)}), дороги ${km(best.length)}, ` +
        `средняя поездка ${km(best.trip)}, крюк ×${best.detour.toFixed(3)}`
      : `${km(best.length)} (короче остова на ${gain}%${gap})`) +
    `, развилок ${best.genome.junctions.length}${roads}`);
}

report();
while (evo.matings < generations * populationSize) {
  evo.step();
  if (evo.matings % (populationSize * 50) === 0) report();
}
const stats = evo.best().junctionInfo;
console.log('развилки лучшей сети:', stats.map((s) => `${s.degree} дор.${s.at120 ? ' 120°' : ''}${s.useless ? ' лишняя' : ''}`).join(', ') || 'нет');
const seconds = (Date.now() - started) / 1000;
console.log(`${evo.matings} matings in ${seconds.toFixed(1)} s (${Math.round(evo.matings / seconds)}/s)`);
