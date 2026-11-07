'use strict';
// A Web Worker that scores fans: the same scripts as the page, no drawing.
// Message in: { id, genome, setup }; message out: { id, result } (result of evaluateFan).
importScripts('rng.js', 'room.js', 'fan.js', 'aero.js', 'acoustics.js', 'ambient.js', 'fitness.js');

onmessage = (e) => {
  const { id, genome, setup } = e.data;
  postMessage({ id, result: evaluateFan(genome, setup) });
};
