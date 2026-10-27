// Runs evolution without a browser, on the same js/*.js modules, scoring in worker threads.
// Usage: node tools/headless.mjs [generations] [pool] [seed] [scaffold|free] [threads]
// Environment: TILT (degrees of the tilt test, default 5; 0 = no tilt test), STONES (default 100),
// GATE (m: width of a passage under the structure, default 0), ARCH (1: round centering), MIRROR (1/0, default 1: mirror symmetry), GROW (1/0, default 1: the passage widens from 15 cm up to GATE), PILE (1/0, default 1: score = height x share of stones in the structure), NOEND (1/0, default 1:
// no stones on their ends), STEPS (1: the quarry starts with 15 stones and doubles up to STONES when the best
// stagnates; needs MIRROR=0), STACK (1: stacking mode - laid against the real parent, nearly regular stones,
// collapse costs; implies GENOME=tree; at the end the best is also checked with a 5° tilt), SPANCAP (1, with GATE:
// height over the passage counts only up to 0.5 m - the way up is a clean, then a wider span), REGULAR (1: perfect bricks, no wedges), GENOME (tree: stones laid relative to each other, js/tree-genome.js), PEDESTAL (m, half-size: build on a pedestal over a pit, score = reach), TIME (seconds: stop after this long),
// SEED (comma-separated structure JSON files, e.g. from tools/diagnose.mjs OUT=: the pool starts with them),
// OUT (file for the best structure JSON, rewritten at every report; with a growing passage also OUT-<cm>cm.json for each cleared width; it can be loaded on the page with
// "Загрузить постройку"), MAP (file for all elites of the map of finds, written at the end).
// The result depends on the thread count (it is the batch size), so compare runs with equal threads.

import { Worker } from 'node:worker_threads';
import { writeFileSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Evolution, batchSize, BASE_BINS, TAPER_BINS } from '../js/evolution.js';
import { WorkerPool } from '../js/workers.js';

const generations = Number(process.argv[2] ?? 100);
const poolSize = Number(process.argv[3] ?? 200);
const seed = Number(process.argv[4] ?? 1);
const scaffold = (process.argv[5] ?? 'scaffold') !== 'free';
const threads = Number(process.argv[6] ?? Math.max(1, availableParallelism() - 1));
const tiltDeg = Number(process.env.TILT ?? 5);
const stoneCount = Number(process.env.STONES ?? 100);
const pile = (process.env.PILE ?? '1') !== '0';     // score = height x share of stones in the structure
const noEnd = (process.env.NOEND ?? '1') !== '0';   // masonry rule: no stones on their ends
const gateWidth = Number(process.env.GATE ?? 0);    // m: a passage under the structure (0 = none)
const gateArch = process.env.ARCH === '1';          // round centering (a half-cylinder) instead of a box
const mirror = (process.env.MIRROR ?? '1') !== '0';  // mirror symmetry across x = 0
const gateGrow = (process.env.GROW ?? '1') !== '0';  // the passage starts narrow and widens up to GATE
const growStones = process.env.STEPS === '1';        // the quarry starts small and grows up to STONES
const pedestal = Number(process.env.PEDESTAL ?? 0);  // m: pedestal over a pit, score = reach
const genome = process.env.GENOME ?? 'direct';       // tree: stones laid relative to each other
const regular = process.env.REGULAR === '1';         // perfect bricks
const stack = process.env.STACK === '1';             // stacking mode (see js/physics.js)
const spanCap = process.env.SPANCAP === '1';         // with GATE: height over the passage counts up to 0.5 m

const workerUrl = new URL('./node-worker.mjs', import.meta.url);
const pool = new WorkerPool(() => {
  const w = new Worker(workerUrl);
  return {
    postMessage: (m) => w.postMessage(m),
    onMessage: (cb) => w.on('message', cb),
    terminate: () => w.terminate(),
  };
}, threads);

const seedGenomes = (process.env.SEED ? process.env.SEED.split(',') : []).map((file) => {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.seed !== seed || data.stoneCount !== stoneCount || !!data.mirror !== mirror) {
    console.warn(`warning: ${file} was made for seed ${data.seed}, ${data.stoneCount} stones, mirror ${!!data.mirror}`);
  }
  return data.genome;
});

const evo = new Evolution({ seed, poolSize, stoneCount, scaffold, tiltDeg, pile, noEnd, gateWidth, gateArch, mirror, gateGrow,
  maxGenerations: generations, seedGenomes, growStones, pedestal, genome, regular, stack, spanCap });
// SIM='{"fixedPhase":3}' overrides simulation settings in the workers (see SIM in js/physics.js).
await pool.init({ ...evo.evalConfig(), sim: JSON.parse(process.env.SIM ?? '{}') });
const evaluateAll = (genomes, thresholds) => pool.evaluateAll(genomes, thresholds);
const batch = batchSize(poolSize, threads);

const t0 = performance.now();
const fmt = (v) => v.toFixed(3);
function report() {
  const h = evo.history[evo.history.length - 1];
  const b = evo.best.result;
  console.log(`gen ${String(h.generation).padStart(4)}  best ${fmt(b.score)} (${fmt(b.height)} m × ${fmt(b.share)})`
    + (evo.gateNow ? `  passage ${(100 * evo.gateNow).toFixed(0)} cm: over ${fmt(b.gateAbove)} m, inside ${b.gateBlocked}` : '')
    + (growStones ? `  quarry ${evo.stonesNow}` : '')
    + (pedestal ? `  reach ${fmt(b.reach)} m` : '')
    + (stack ? `  standing ${(100 * b.standing).toFixed(0)}%` : '')
    + `  median ${fmt(h.median)}  map ${evo.archive.size} cells`
    + `  stones ${b.stones}  level ${(100 * b.level).toFixed(0)}%  hanging ${b.hanging}  fallen ${b.fallen}`
    + `  profile ${b.profile.map((r) => r.toFixed(2)).join('/')}`
    + `  ${((performance.now() - t0) / 1000).toFixed(0)} s, ${(evo.matings / (performance.now() - t0) * 1000).toFixed(0)} evals/s`
    + `, rejected ${(100 * evo.rejected / Math.max(1, evo.matings)).toFixed(0)}% (aborted ${(100 * evo.aborted / Math.max(1, evo.matings)).toFixed(0)}%)`);
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(evo.exportBest(), null, 1));
}

console.log(`seed ${seed}, pool ${poolSize}, ${scaffold ? 'scaffold' : 'free (no scaffold)'}, tilt ${tiltDeg}°, `
  + `${growStones ? `${evo.stonesNow} -> ` : ''}${stoneCount} stones, ${pile ? 'whole pile' : 'height only'}, ${noEnd ? 'no stones on end' : 'any side'}, ${pedestal ? `pedestal ±${pedestal} m (reach), ` : ''}${genome === 'tree' ? 'tree genome, ' : ''}${regular ? 'perfect bricks, ' : ''}${stack ? 'stacking, ' : ''}${spanCap ? 'span cap, ' : ''}${mirror ? 'mirrored' : 'no symmetry'}, `
  + `${gateWidth ? `passage ${gateWidth} m${gateArch ? ' (round centering)' : ''}, ` : ''}${threads} threads`);
await evo.init(evaluateAll);
report();
let lastReported = 0;
const timeLimit = Number(process.env.TIME ?? 0) * 1000;
while (!evo.stopReason() && !(timeLimit && performance.now() - t0 > timeLimit)) {
  await evo.step(evaluateAll, batch);
  if (evo.gateReady()) {
    // The best that cleared this width is about to be rescored for a wider passage: keep it.
    if (process.env.OUT) {
      writeFileSync(process.env.OUT.replace(/\.json$/, '') + `-${Math.round(100 * evo.gateNow)}cm.json`,
        JSON.stringify(evo.exportBest(), null, 1));
    }
    const w = evo.widenGate();
    await pool.init({ ...evo.evalConfig(), sim: JSON.parse(process.env.SIM ?? '{}') });
    await evo.rescore(evaluateAll);
    console.log(`gen ${Math.floor(evo.generation)}: passage widened to ${(100 * w).toFixed(0)} cm`
      + ` (best now ${fmt(evo.best.result.score)})`);
  }
  if (evo.stonesReady()) {
    const n = evo.growStones();
    await pool.init({ ...evo.evalConfig(), sim: JSON.parse(process.env.SIM ?? '{}') });
    await evo.rescore(evaluateAll);
    console.log(`gen ${Math.floor(evo.generation)}: quarry grown to ${n} stones (best now ${fmt(evo.best.result.score)})`);
  }
  const g = Math.floor(evo.generation);
  if (g >= lastReported + 10) { lastReported = g; report(); }
}
report();
console.log('stop:', evo.stopReason());
// The best, evolved without (or with a weaker) tilt test, checked with a 5° tilt: does it stand in a less ideal world?
if (stack && tiltDeg < 5) {
  await pool.init({ ...evo.evalConfig(), tiltDeg: 5, sim: JSON.parse(process.env.SIM ?? '{}') });
  const [r] = await evaluateAll([evo.best.genome]);
  console.log(`check with a 5° tilt: score ${fmt(r.score)} (was ${fmt(evo.best.result.score)}), height ${fmt(r.height)} m,`
    + ` standing ${(100 * r.standing).toFixed(0)}%${r.unstable ? ', unstable' : ''}`);
}
if (process.env.OUT) console.log('saved', process.env.OUT);

// The map of finds: rows - taper (top radius / base radius), columns - base radius; cell = height, m.
const edges = (b) => ['<' + b[0], ...b.slice(1).map((v, i) => `${b[i]}-${v}`), '>' + b[b.length - 1]];
console.log('map: height (m) by base radius (columns, m) and taper (rows)');
console.log('taper\\base'.padEnd(12) + edges(BASE_BINS).map((e) => e.padStart(9)).join(''));
edges(TAPER_BINS).forEach((row, j) => {
  let line = row.padEnd(12);
  for (let i = 0; i <= BASE_BINS.length; i++) {
    const e = evo.archive.get(`${i},${j}`);
    line += (e ? e.result.height.toFixed(2) : '.').padStart(9);
  }
  console.log(line);
});
if (process.env.MAP) {
  const all = [...evo.archive.entries()].map(([cell, ind]) => ({ cell, ...evo.exportIndividual(ind) }));
  writeFileSync(process.env.MAP, JSON.stringify(all));
  console.log('map saved', process.env.MAP);
}
pool.terminate();
