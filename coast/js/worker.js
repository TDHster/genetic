'use strict';
// A Web Worker that scores designs: the same scripts as the page, no drawing.
// Message in: { id, genome }; message out: { id, result } (result of evaluateDesign).
importScripts('rng.js', 'sim.js', 'design.js', 'fitness.js');

onmessage = (e) => {
  const { id, genome } = e.data;
  postMessage({ id, result: evaluateDesign(genome) });
};
