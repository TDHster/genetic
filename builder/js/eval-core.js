// Evaluation shared by the browser worker (worker.js) and the Node worker (tools/node-worker.mjs).
// A worker gets the run settings once, builds the same quarry from the seed, then scores genomes.

import RAPIER from '../vendor/rapier-simd.mjs';
import { makeQuarry } from './stones.js';
import { evaluateGenome, SIM } from './physics.js';

let ready = null;

export function initRapier() {
  if (!ready) ready = RAPIER.init().then(() => RAPIER);
  return ready;
}

// cfg: {seed, stoneCount, scaffold, tiltDeg, sim?}. Returns (genome, abortBelow?) -> result.
// cfg.sim overrides simulation settings (SIM in physics.js) - for experiments from tools/headless.mjs.
export async function makeEvaluator(cfg) {
  const R = await initRapier();
  if (cfg.sim) Object.assign(SIM, cfg.sim);
  const quarry = makeQuarry(cfg.stoneCount, cfg.seed);
  const opts = { scaffold: cfg.scaffold, tiltDeg: cfg.tiltDeg };
  return (genome, abortBelow) => evaluateGenome(R, quarry, genome, { ...opts, abortBelow });
}

// Message protocol, the same for both kinds of workers:
//   in  {type: 'init', cfg}            out {type: 'ready'}
//   in  {type: 'eval', id, genome, abortBelow}  out {type: 'result', id, result}
export function makeMessageHandler(post) {
  let evaluate = null;
  return async (msg) => {
    if (msg.type === 'init') {
      evaluate = await makeEvaluator(msg.cfg);
      post({ type: 'ready' });
    } else if (msg.type === 'eval') {
      post({ type: 'result', id: msg.id, result: evaluate(msg.genome, msg.abortBelow) });
    }
  };
}
