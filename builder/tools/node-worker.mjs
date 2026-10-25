// Node worker thread: the same protocol as js/worker.js, for tools/headless.mjs.
import { parentPort } from 'node:worker_threads';
import { makeMessageHandler } from '../js/eval-core.js';

const handle = makeMessageHandler((m) => parentPort.postMessage(m));
parentPort.on('message', handle);
