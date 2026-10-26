'use strict';
// A Web Worker that scores rotors: the same scripts as the page, no drawing.
// Message in: { id, genome }; message out: { id, result } (result of evaluateRotor).
importScripts('rng.js', 'airfoil.js', 'rotor.js', 'aero.js', 'fitness.js');

onmessage = (e) => {
  const { id, genome } = e.data;
  postMessage({ id, result: evaluateRotor(genome) });
};
