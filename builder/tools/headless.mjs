// Runs evolution without a browser, on the same js/*.js modules, scoring in worker threads.
// Usage: node tools/headless.mjs [generations] [pool] [seed] [scaffold|free] [threads]
// Environment: TILT (degrees of the tilt test, default 5; 0 = no tilt test), STONES (default 60), TIME (seconds: stop after this long),
// OUT (file for the best structure JSON,
// rewritten at every report; it can be loaded on the page with "Загрузить постройку").
// The result depends on the thread count (it is the batch size), so compare runs with equal threads.

import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Evolution, batchSize } from '../js/evolution.js';
import { WorkerPool } from '../js/workers.js';

const generations = Number(process.argv[2] ?? 100);
const poolSize = Number(process.argv[3] ?? 200);
const seed = Number(process.argv[4] ?? 1);
const scaffold = (process.argv[5] ?? 'scaffold') !== 'free';
const threads = Number(process.argv[6] ?? Math.max(1, availableParallelism() - 1));
const tiltDeg = Number(process.env.TILT ?? 5);
const stoneCount = Number(process.env.STONES ?? 60);

const workerUrl = new URL('./node-worker.mjs', import.meta.url);
const pool = new WorkerPool(() => {
  const w = new Worker(workerUrl);
  return {
    postMessage: (m) => w.postMessage(m),
    onMessage: (cb) => w.on('message', cb),
    terminate: () => w.terminate(),
  };
}, threads);

const evo = new Evolution({ seed, poolSize, stoneCount, scaffold, tiltDeg, maxGenerations: generations });
// SIM='{"fixedPhase":3}' overrides simulation settings in the workers (see SIM in js/physics.js).
await pool.init({ ...evo.evalConfig(), sim: JSON.parse(process.env.SIM ?? '{}') });
const evaluateAll = (genomes, thresholds) => pool.evaluateAll(genomes, thresholds);
const batch = batchSize(poolSize, threads);

const t0 = performance.now();
const fmt = (v) => v.toFixed(3);
function report() {
  const h = evo.history[evo.history.length - 1];
  const b = evo.best.result;
  console.log(`gen ${String(h.generation).padStart(4)}  best ${fmt(b.height)} m  median ${fmt(h.median)}`
    + `  stones ${b.stones}  hanging ${b.hanging}  fallen ${b.fallen}`
    + `  profile ${b.profile.map((r) => r.toFixed(2)).join('/')}`
    + `  ${((performance.now() - t0) / 1000).toFixed(0)} s, ${(evo.matings / (performance.now() - t0) * 1000).toFixed(0)} evals/s`
    + `, rejected ${(100 * evo.rejected / Math.max(1, evo.matings)).toFixed(0)}% (aborted ${(100 * evo.aborted / Math.max(1, evo.matings)).toFixed(0)}%)`);
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(evo.exportBest(), null, 1));
}

console.log(`seed ${seed}, pool ${poolSize}, ${scaffold ? 'scaffold' : 'free (no scaffold)'}, tilt ${tiltDeg}°, `
  + `${stoneCount} stones, ${threads} threads`);
await evo.init(evaluateAll);
report();
let lastReported = 0;
const timeLimit = Number(process.env.TIME ?? 0) * 1000;
while (!evo.stopReason() && !(timeLimit && performance.now() - t0 > timeLimit)) {
  await evo.step(evaluateAll, batch);
  const g = Math.floor(evo.generation);
  if (g >= lastReported + 10) { lastReported = g; report(); }
}
report();
console.log('stop:', evo.stopReason());
if (process.env.OUT) console.log('saved', process.env.OUT);
pool.terminate();
