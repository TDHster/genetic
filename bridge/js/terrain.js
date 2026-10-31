'use strict';
// THE TERRAIN: two banks and a valley with a river between them. The bridge has to carry a road across.
//
// Coordinates are metres: x along the road, y up. The road (deck) is straight at y = 0, from the edge
// of the left bank (x = 0) to the edge of the right bank (x = span). Beyond them the banks are flat at y = 0.
// The valley is a random broken line: walls of random steepness, a bumpy bottom, sometimes a rock in the middle.
// At the bottom there is a river: nothing can stand in the water.
//
// A node of the bridge that ends up in the ground is moved up to the surface and becomes a SUPPORT
// (a hinge fixed to the ground). A node in the water is moved up to the water surface and does not
// become a support: it only floats there as a part of the truss.

const DECK_STEP = 4; // m, distance between the nodes of the road

// The task: terrainSeed - seed of the random valley (separate from the evolution seed: same valley, different runs);
// mode - the goal: 'light' (the lightest bridge) or 'strength' (the least steel per unit of strength), see fitness.js.
const TASK = { terrainSeed: 1, mode: 'light' };

// The current valley (filled by makeTerrain): span, depth, pts (surface from x = 0 to span), waterY, view bounds.
const TERRAIN = {};

function makeTerrain(seed) {
  const rng = makeRng(seed * 7919 + 13);
  const segments = rng.intRange(8, 14);           // road segments: span 32..56 m
  const span = segments * DECK_STEP;
  const depth = 10 + rng.next() * 15;            // 10..25 m
  const power = 0.35 + rng.next() * 0.9;          // < 1: steep walls and a wide bottom; ~1: a V-shaped valley
  const skew = Math.exp((rng.next() - 0.5) * 0.9); // the deepest point is not always in the middle
  const rock = rng.chance(0.5)
    ? { t: 0.3 + rng.next() * 0.4, w: 0.05 + rng.next() * 0.08, h: (0.3 + rng.next() * 0.45) * depth }
    : null;
  const N = 24;
  const pts = [{ x: 0, y: 0 }];
  let wobble = 0;
  for (let i = 1; i < N; i++) {
    const t = i / N;
    const ts = Math.pow(t, skew);
    let y = -depth * Math.pow(Math.sin(Math.PI * ts), power);
    wobble = 0.6 * wobble + rng.normal() * 0.8;   // smoothed bumps of the walls and the bottom
    y += wobble;
    if (rock) y += rock.h * Math.max(0, 1 - Math.abs(t - rock.t) / rock.w);
    pts.push({ x: t * span, y: Math.min(-0.5, y) });
  }
  pts.push({ x: span, y: 0 });
  const bottom = Math.min(...pts.map((p) => p.y));
  const waterY = bottom + 1 + rng.next() * 2;
  Object.assign(TERRAIN, {
    seed, segments, span, depth, pts, waterY, bottom, rock: !!rock,
    // Where nodes may be: a bit over the banks, down to the bottom, up to towers 0.35 of the span high.
    minX: -0.2 * span, maxX: 1.2 * span, minY: bottom, maxY: 0.35 * span,
  });
}

// Height of the ground at x.
function groundY(x) {
  const pts = TERRAIN.pts;
  if (x <= 0 || x >= TERRAIN.span) return 0;
  const i = Math.min(pts.length - 2, Math.floor(x / TERRAIN.span * (pts.length - 1)));
  const a = pts[i], b = pts[i + 1];
  return a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
}

const inRiver = (x) => groundY(x) < TERRAIN.waterY;

// Where a node really goes: not inside the ground, not under water, inside the allowed area.
function placeNode(x, y) {
  x = Math.min(TERRAIN.maxX, Math.max(TERRAIN.minX, x));
  y = Math.min(TERRAIN.maxY, y);
  if (inRiver(x)) return { x, y: Math.max(y, TERRAIN.waterY) };
  return { x, y: Math.max(y, groundY(x)) };
}

// A support: a node standing on dry ground.
function isSupport(p) {
  return !inRiver(p.x) && p.y <= groundY(p.x) + 1e-6;
}

// Does the bar p-q go through the ground? The ends may touch the surface, the middle may not.
function barInGround(p, q) {
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  const k = Math.max(2, Math.ceil(L / 0.5));
  for (let i = 1; i < k; i++) {
    const x = p.x + (q.x - p.x) * i / k, y = p.y + (q.y - p.y) * i / k;
    if (y < groundY(x) - 0.05) return true;
  }
  return false;
}
