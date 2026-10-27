// Diagnostic: does the score prefer a stepped pyramid to columns and heaps of the same stones?
// Hand-made genomes are scored by the same evaluateGenome as the workers, at several tilt angles.
// Usage: node tools/diagnose.mjs [stones] [seed] [scaffold|free]
// Environment: TILTS (comma-separated degrees, default 0,3,5,8,11.3; 11.3° = a side load of 0.2 g),
// ONLY (regexp: score only the structures whose name matches), SIM (JSON overrides of SIM in physics.js),
// OUT (directory: every structure is saved there as <name>.json, loadable by the page and as a seed).
//
// Pass criterion (printed at the end): at the default tilt (5°) the pyramid's score - height x share of
// the stones in the structure, as in "whole pile" mode - is strictly above every column, the heap and the slab.
// 15 stones is a weak test: columns of 10-15 flat stones fall even without a tilt (soft joints, +-4 mm
// corners). 100 stones is the size evolution actually works with.

import { initRapier } from '../js/eval-core.js';
import { makeQuarry } from '../js/stones.js';
import { evaluateGenome, SIM } from '../js/physics.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeRng } from '../js/rng.js';

const N = Number(process.argv[2] ?? 15);
const seed = Number(process.argv[3] ?? 1);
const scaffold = (process.argv[4] ?? 'scaffold') !== 'free';
const tilts = (process.env.TILTS ?? '0,3,5,8,11.3').split(',').map(Number);
const DEFAULT_TILT = 5;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
Object.assign(SIM, JSON.parse(process.env.SIM ?? '{}'));
if (process.env.OUT) mkdirSync(process.env.OUT, { recursive: true });

const R = await initRapier();
// The same quarry as evolution's (so a structure saved here is a valid seed), but the layouts take the
// rectangular stones first: wedges would make a hand-made column lean.
const quarry = makeQuarry(N, seed);
const order = [...quarry.filter((s) => !s.wedge), ...quarry.filter((s) => s.wedge)].map((s) => s.id);

// Pitch a little above the largest stone (sizes are +-10 %), so neighbours in a course do not overlap.
const PX = 0.34;    // along the stone's length (x when yaw = 0)
const PZ = 0.17;    // along its width

const at = (i, x, z, axis = 2, yaw = 0) => ({ stone: i, x, z, yaw, axis, tiltDir: 0, tilt: 0 });

// Courses of flat stones: each course is [cols along x, rows along z], centred on 0.
// Stones above sit over the joints below (the grid is shifted by half a pitch per missing stone).
function courses(list) {
  const placements = [];
  for (const [cols, rows] of list) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        placements.push(at(placements.length, (c - (cols - 1) / 2) * PX, (r - (rows - 1) / 2) * PZ));
      }
    }
  }
  return placements.slice(0, N);
}

// A stepped pyramid: course k is a square of half-width W - k*d, filled with as many stones as fit
// (the stone is twice as long as wide, so twice as many rows as columns). d sets the slope: d = PX/2
// is a step of half a stone length per side on every course. W is the largest that needs at most N stones.
function pyramidCourses(W, d, wall) {
  const list = [];
  for (let w = W; ; w -= d) {
    const cols = Math.floor(2 * w / PX + 1e-9);
    if (cols < 1) return list;
    list.push([cols, wall ? 1 : 2 * cols]);
  }
}
function pyramid(d, wall = false) {
  const count = (W) => pyramidCourses(W, d, wall).reduce((s, [c, r]) => s + c * r, 0);
  let W = PX / 2;
  while (count(W + 0.005) <= N) W += 0.005;
  const list = pyramidCourses(W, d, wall);
  const base = list[0];
  return {
    name: `${wall ? 'wall ' : ''}pyramid ${base[0]}x${base[1]}, ${list.length} courses, d ${(100 * d).toFixed(1)} cm`,
    placements: courses(list),
  };
}

// The contestants. All of them use N stones (fewer if a layout has fewer places).
function contestants() {
  const column = (axis, cross = false) => Array.from({ length: N }, (_, i) => at(i, 0, 0, axis, cross ? 90 * (i % 2) : 0));
  const rng = makeRng(seed);
  // A heap like the ones evolution builds: stones dropped near the centre, any allowed side.
  const spread = 0.15 * Math.sqrt(N / 15);
  const heap = Array.from({ length: N }, (_, i) => ({
    stone: i, x: spread * rng.normal(), z: spread * rng.normal(), yaw: 360 * rng.next(),
    axis: 1 + rng.int(2), tiltDir: 360 * rng.next(), tilt: rng.chance(0.8) ? 0 : 30 * rng.next(),
  }));
  const side = Math.ceil(Math.sqrt(N / 2));
  const list = {
    // Stones one above another, all the same way (a 30x15 cm bed), and crossed (yaw 0 / 90, a 15x15 cm bed).
    'column flat': column(2),
    'column flat crossed': column(2, true),
    'column on edge': column(1),
    'column on end': column(0),
    [`slab ${side}x${2 * side}`]: courses([[side, 2 * side]]),
    heap,
  };
  for (const p of [pyramid(PX / 2), pyramid(PX / 4), pyramid(PX / 6), pyramid(PX / 10), pyramid(PX / 2, true), pyramid(PX / 4, true)]) list[p.name] = p.placements;
  return list;
}

const fmt = (v) => v.toFixed(2).padStart(5);
const table = {};
console.log(`${N} stones, seed ${seed}, ${scaffold ? 'scaffold' : 'free'}; cell = score (height m x share) / fallen`);
console.log('structure'.padEnd(38) + tilts.map((t) => `tilt ${t}°`.padStart(14)).join(''));
for (const [name, layout] of Object.entries(contestants())) {
  if (only && !only.test(name)) continue;
  const placements = layout.map((p) => ({ ...p, stone: order[p.stone] }));
  if (process.env.OUT) {
    writeFileSync(`${process.env.OUT}/${name.replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify({
      seed, stoneCount: N, scaffold, tiltDeg: DEFAULT_TILT, pile: true, noEnd: true, gateWidth: 0, gateArch: false,
      mirror: false, generation: 0, result: { height: 0 }, genome: { placements },
    }, null, 1));
  }
  let line = name.padEnd(38);
  for (const tiltDeg of tilts) {
    const r = evaluateGenome(R, quarry, { placements }, { scaffold, tiltDeg, pile: true });
    (table[name] ??= {})[tiltDeg] = r;
    line += `${fmt(r.score)} (${fmt(r.height)})/${String(r.fallen).padStart(2)}`.padStart(14);
  }
  console.log(line);
}
console.log('(score, height in brackets, / fallen stones; score 0 with height > 0 = still moving, "unstable")');

// Verdict at the default tilt: the best pyramid against every non-pyramid.
if (tilts.includes(DEFAULT_TILT)) {
  const names = Object.keys(table);
  const score = (n) => table[n][DEFAULT_TILT].score;
  const pyramids = names.filter((n) => n.includes('pyramid'));
  const others = names.filter((n) => !n.includes('pyramid') && n !== 'column on end');   // no ends: noEnd rule
  if (!pyramids.length || !others.length) process.exit();
  const best = pyramids.reduce((a, b) => (score(b) > score(a) ? b : a));
  const rival = others.reduce((a, b) => (score(b) > score(a) ? b : a));
  const pass = score(best) > score(rival);
  console.log(`tilt ${DEFAULT_TILT}°: best pyramid "${best}" ${score(best).toFixed(3)} vs best other "${rival}" `
    + `${score(rival).toFixed(3)} -> ${pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = pass ? 0 : 1;
}
