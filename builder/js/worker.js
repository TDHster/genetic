// Browser Web Worker: scores genomes off the main thread (see eval-core.js for the protocol).
import { makeMessageHandler } from './eval-core.js';

const handle = makeMessageHandler((m) => self.postMessage(m));
self.onmessage = (e) => handle(e.data);
