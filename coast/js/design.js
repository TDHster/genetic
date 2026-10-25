'use strict';
// THE DESIGN: what we build in front of the promenade wall.
//
// A design is a list of SEGMENTS - straight mounds of blocks seen from above:
//   { x, y, angle, length, width, crest, block }
//   x, y    - centre (m), y < WALL_Y: only in the sea or on the beach, never on the promenade;
//             nothing is built in the first GENERATION_ZONE metres: that is where the model makes the waves;
//   angle   - degrees, 0 = parallel to the shore (a breakwater), 90 = towards the sea (a groyne);
//   length, width - m;
//   crest   - top of the mound above still water (m), may be below it (a submerged reef);
//   block   - what it is made of, see BLOCKS.
// The segments are laid onto the grid. A mound of loose blocks cannot stand with vertical sides:
// its cross-section is a trapezoid with side slopes 1 : SLOPE (1 up, SLOPE across), so a cell at
// distance d from the axis is raised to min(crest, bed + (width/2 - d) / SLOPE).
// A high mound has to be wide - and costs accordingly. Where segments overlap, the higher top wins.
// Lesson learnt: with flat-topped boxes evolution built 4 m wide, 10 m high walls of pebbles.
//
// STRENGTH. Fast water washes blocks away. Izbash's formula (1935) gives the critical speed
// for a stone of size D lying in a current:
//   u_cr = C * sqrt(2 g Delta D),   Delta = rho_block / rho_water - 1
// C = 0.86 for a loose stone on the surface; interlocking concrete armour units hold better (C = 1.1).
// In the storm every structure cell watches the water speed; when it stays above u_cr for longer
// than FAIL_TIME, the top layer (one block size D) is washed out. See WaveSim.damage().
// The water attacks a block from above (if the cell is under water) and from the side (the speed in the
// neighbouring wet cells) - otherwise a mound standing above the water could never be damaged.
// The model speed is depth-averaged; near the bed under a breaking wave it is higher, so the speed
// is multiplied by a turbulence factor (WORLD.TURBULENCE), as in rip-rap design rules.
// price - per m3, in arbitrary money; gammaF - roughness for run-up (see the overtopping in sim.js).

const BLOCKS = [
  { name: 'мелкий камень', D: 0.5, rho: 2650, C: 0.86, gammaF: 0.55, price: 35, color: '#c8b896' },
  { name: 'средний камень', D: 1.0, rho: 2650, C: 0.86, gammaF: 0.55, price: 50, color: '#a89878' },
  { name: 'крупный камень', D: 1.6, rho: 2650, C: 0.86, gammaF: 0.55, price: 70, color: '#857a66' },
  { name: 'бетонные тетраподы', D: 2.0, rho: 2400, C: 1.1, gammaF: 0.4, price: 180, color: '#c9ccd2' },
];
for (const b of BLOCKS) b.ucr = b.C * Math.sqrt(2 * G * (b.rho / 1025 - 1) * b.D);

const MAX_SEGMENTS = 8;
const SLOPE = 1.5;          // side slope of a mound of blocks, horizontal per vertical
const GENERATION_ZONE = 16; // m at the sea boundary where nothing may be built
const RANGES = {
  x: [0, WORLD.LX],
  y: [GENERATION_ZONE, WORLD.WALL_Y],
  angle: [0, 180],
  length: [4, 160],
  width: [4, 40],
  crest: [-6, 6],
};

// Lay the segments onto a fresh copy of the bare coast.
// Returns the world for WaveSim plus, per structure cell, what it is made of.
function buildWorld(design, dx) {
  const world = makeWorld(dx);
  const { nx, z, wallRow } = world;
  const bare = z.slice();
  const crestOf = new Map(); // cell -> { crest, block, seg }
  design.segments.forEach((s, seg) => {
    const a = s.angle * Math.PI / 180;
    const ex = Math.cos(a) * s.length / 2, ey = Math.sin(a) * s.length / 2;
    const r = s.width / 2;
    const i0 = Math.max(0, Math.floor((Math.min(s.x - ex, s.x + ex) - r) / dx));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(s.x - ex, s.x + ex) + r) / dx));
    const j0 = Math.max(Math.ceil(GENERATION_ZONE / dx), Math.floor((Math.min(s.y - ey, s.y + ey) - r) / dx));
    const j1 = Math.min(wallRow - 1, Math.floor((Math.max(s.y - ey, s.y + ey) + r) / dx));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        // distance from the cell centre to the segment (a capsule test)
        const px = (i + 0.5) * dx - (s.x - ex), py = (j + 0.5) * dx - (s.y - ey);
        const L2 = 4 * (ex * ex + ey * ey);
        const t = L2 > 0 ? Math.max(0, Math.min(1, (px * 2 * ex + py * 2 * ey) / L2)) : 0;
        const qx = px - 2 * ex * t, qy = py - 2 * ey * t;
        const d = Math.sqrt(qx * qx + qy * qy);
        if (d >= r) continue;
        const top = Math.min(s.crest, bare[c] + (r - d) / SLOPE);
        if (top < bare[c] + 0.1) continue;
        const old = crestOf.get(c);
        if (!old || top > old.crest) crestOf.set(c, { crest: top, block: s.block, seg });
      }
    }
  });
  const cells = [...crestOf.keys()].sort((p, q) => p - q);
  const blocks = {
    cells: Int32Array.from(cells),
    type: Int32Array.from(cells.map((c) => crestOf.get(c).block)),
    zBase: Float64Array.from(cells.map((c) => bare[c])),
    zTop: Float64Array.from(cells.map((c) => crestOf.get(c).crest)),
  };
  for (const c of cells) z[c] = crestOf.get(c).crest;
  world.blocks = blocks;
  // Cells owned by every segment: a segment under the bed or under a higher one builds nothing (neutral).
  world.segmentCells = design.segments.map(() => 0);
  for (const c of cells) world.segmentCells[crestOf.get(c).seg]++;
  return world;
}

// Volume (m3) and price of what is built.
function designCost(world) {
  const { blocks, dx } = world;
  let volume = 0, price = 0;
  for (let k = 0; k < blocks.cells.length; k++) {
    const v = (blocks.zTop[k] - blocks.zBase[k]) * dx * dx;
    volume += v;
    price += v * BLOCKS[blocks.type[k]].price;
  }
  return { volume, price };
}

// The reference design, by hand (like Jansen's leg in teo-leg): a classic detached breakwater
// of large rock across the whole bay, parallel to the shore, crest 1.5 m above the storm water level,
// 24 m wide at the bed (with 1 : 1.5 slopes that leaves a narrow crest).
const REFERENCE = {
  segments: [{ x: 120, y: 56, angle: 0, length: 232, width: 24, crest: 3, block: 2 }],
};

// ---- Genome operations ----

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const randomIn = (rng, [lo, hi]) => lo + (hi - lo) * rng.next();

function randomSegment(rng) {
  return {
    x: randomIn(rng, RANGES.x),
    y: randomIn(rng, RANGES.y),
    angle: rng.chance(0.5) ? 0 : randomIn(rng, RANGES.angle),
    length: rng.logUniform(8, RANGES.length[1]),
    width: randomIn(rng, [4, 24]),
    crest: randomIn(rng, RANGES.crest),
    block: rng.int(BLOCKS.length),
  };
}

function randomDesign(rng) {
  const n = 1 + rng.int(4);
  const segments = [];
  for (let k = 0; k < n; k++) segments.push(randomSegment(rng));
  return { segments };
}

function copyDesign(d) {
  return { segments: d.segments.map((s) => ({ ...s })) };
}

// Number of segments from a random parent, every segment from a random parent that has it.
function crossover(mom, dad, rng) {
  const donor = rng.chance(0.5) ? mom : dad, other = donor === mom ? dad : mom;
  return {
    segments: donor.segments.map((s, k) => ({ ...(k < other.segments.length && rng.chance(0.5) ? other.segments[k] : s) })),
  };
}

// A nudge: usually small, sometimes large (log scale, like the bar lengths in teo-leg).
function nudge(rng, value, range, scale) {
  return clamp(value + scale * Math.pow(10, -2 + 2 * rng.next()) * rng.normal(), range);
}

// One mutation; returns a description for the log.
function mutate(design, rng) {
  const segs = design.segments, n = segs.length;
  const r = rng.next();
  const k = rng.int(Math.max(1, n)), s = segs[k];
  const f = (v) => v.toFixed(1);

  if (n > 0 && r < 0.25) {
    const bx = s.x, by = s.y;
    s.x = nudge(rng, s.x, RANGES.x, 40);
    s.y = nudge(rng, s.y, RANGES.y, 40);
    return `сегмент ${k + 1} сдвинут: (${f(bx)}, ${f(by)}) → (${f(s.x)}, ${f(s.y)}) м`;
  }
  if (n > 0 && r < 0.35) {
    const b = s.angle;
    s.angle = ((nudge(rng, s.angle, [-360, 360], 90) % 180) + 180) % 180;
    return `сегмент ${k + 1} повёрнут: ${f(b)}° → ${f(s.angle)}°`;
  }
  if (n > 0 && r < 0.5) {
    const b = s.length;
    s.length = nudge(rng, s.length, RANGES.length, 60);
    return `сегмент ${k + 1}: длина ${f(b)} → ${f(s.length)} м`;
  }
  if (n > 0 && r < 0.58) {
    const b = s.width;
    s.width = nudge(rng, s.width, RANGES.width, 10);
    return `сегмент ${k + 1}: ширина ${f(b)} → ${f(s.width)} м`;
  }
  if (n > 0 && r < 0.73) {
    const b = s.crest;
    s.crest = nudge(rng, s.crest, RANGES.crest, 4);
    return `сегмент ${k + 1}: гребень ${f(b)} → ${f(s.crest)} м`;
  }
  if (n > 0 && r < 0.83) {
    const b = s.block;
    s.block = (s.block + 1 + rng.int(BLOCKS.length - 1)) % BLOCKS.length;
    return `сегмент ${k + 1}: ${BLOCKS[b].name} → ${BLOCKS[s.block].name}`;
  }
  if (r < 0.9 && n < MAX_SEGMENTS) {
    segs.push(randomSegment(rng));
    return `новый сегмент ${n + 1}`;
  }
  if (r < 0.96 && n > 0) {
    segs.splice(k, 1);
    return `сегмент ${k + 1} удалён`;
  }
  if (n > 0 && n < MAX_SEGMENTS && s.length >= 16) {
    // Split in two with a gap: a breakwater gets an opening, a long groyne becomes two.
    const a = s.angle * Math.PI / 180, gap = 4 + 12 * rng.next();
    const half = (s.length - gap) / 2, shift = (half + gap) / 2;
    const second = { ...s, length: half, x: clamp(s.x + Math.cos(a) * shift, RANGES.x), y: clamp(s.y + Math.sin(a) * shift, RANGES.y) };
    s.length = half;
    s.x = clamp(s.x - Math.cos(a) * shift, RANGES.x);
    s.y = clamp(s.y - Math.sin(a) * shift, RANGES.y);
    segs.push(second);
    return `сегмент ${k + 1} разрезан на два, проход ${f(gap)} м`;
  }
  if (n < MAX_SEGMENTS) {
    segs.push(randomSegment(rng));
    return `новый сегмент ${n + 1}`;
  }
  return 'мутация не нашла, что менять';
}
