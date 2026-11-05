'use strict';
// A Web Worker that scores propellers: the same scripts as the page, no drawing.
// Message in: { id, genome, setup }; message out: { id, result } (result of evaluatePropeller).
importScripts('rng.js', 'boat.js', 'propeller.js', 'hydro.js', 'noise.js', 'sea.js', 'fitness.js');

onmessage = (e) => {
  const { id, genome, setup } = e.data;
  postMessage({ id, result: evaluatePropeller(genome, setup) });
};
