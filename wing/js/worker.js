'use strict';
// A Web Worker that scores airfoils: the same scripts as the page, no drawing.
// Message in: { id, genome, setup }; message out: { id, result } (result of evaluateAirfoil).
importScripts('rng.js', 'linalg.js', 'geometry.js', 'panel.js', 'boundary.js', 'aero.js', 'fitness.js');

onmessage = (e) => {
  const { id, genome, setup } = e.data;
  postMessage({ id, result: evaluateAirfoil(genome, setup) });
};
