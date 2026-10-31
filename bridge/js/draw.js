'use strict';
// Drawing: the valley, the bridge with its forces, the truck, the population chart. Does not affect evolution.

const COLORS = {
  bg: '#05070f',
  skyTop: '#0b1430',
  skyBottom: '#1a2a4a',
  ground: '#5a4630',
  groundEdge: '#8a6d48',
  water: 'rgba(60, 120, 220, 0.75)',
  bar: '#c9d1e6',
  tension: [91, 141, 239],    // blue: the bar is pulled
  compression: [255, 107, 94], // red: the bar is pushed
  node: '#f2f4fa',
  support: '#f0c040',
  junk: '#4a5470',
  buried: '#b3412f',
  truck: '#f0c040',
  text: '#9aa6c7',
  warren: '#b0b8d0',
};

// The world-to-canvas mapping: the whole valley plus room for towers.
function bridgeView(w, h) {
  const pad = 10;
  const x0 = -0.15 * TERRAIN.span, x1 = 1.15 * TERRAIN.span;
  const y0 = TERRAIN.bottom - 2, y1 = TERRAIN.maxY;
  const scale = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0));
  const ox = (w - (x1 - x0) * scale) / 2, oy = (h - (y1 - y0) * scale) / 2;
  return { X: (x) => ox + (x - x0) * scale, Y: (y) => oy + (y1 - y) * scale, scale, x0, x1, y0, y1 };
}

function drawValley(ctx, v, w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, COLORS.skyTop);
  sky.addColorStop(1, COLORS.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // Water first: the ground covers it everywhere but in the river.
  ctx.fillStyle = COLORS.water;
  ctx.fillRect(v.X(0), v.Y(TERRAIN.waterY), v.X(TERRAIN.span) - v.X(0), h - v.Y(TERRAIN.waterY));
  ctx.beginPath();
  ctx.moveTo(0, v.Y(0));
  for (const p of TERRAIN.pts) ctx.lineTo(v.X(p.x), v.Y(p.y));
  ctx.lineTo(w, v.Y(0));
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = COLORS.ground;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, v.Y(0));
  for (const p of TERRAIN.pts) ctx.lineTo(v.X(p.x), v.Y(p.y));
  ctx.lineTo(w, v.Y(0));
  ctx.strokeStyle = COLORS.groundEdge;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Bar width on the canvas by its section.
const barWidth = (s) => 1.2 + 0.75 * s;

// Colour of a bar by its force N: blue - tension, red - compression, the brighter the closer to its limit.
function forceColor(N, bar) {
  const sec = SECTIONS[bar.s];
  const strength = sec.A * STEEL_STRESS;
  const limit = N >= 0 ? strength : Math.min(strength, Math.PI * Math.PI * STEEL_E * sec.I / (bar.L * bar.L));
  const k = Math.min(1, Math.abs(N) / limit);
  const [r, g, b] = N >= 0 ? COLORS.tension : COLORS.compression;
  const mix = (c) => Math.round(70 + (c - 70) * (0.25 + 0.75 * k));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// bridge: a scored bridge (with .state when it stands, see evaluateBridge(genome, true));
// truckX: where the truck is (m, null = no truck); sagScale: how many times the sag is enlarged (0 = not shown).
function drawBridge(ctx, bridge, w, h, truckX, sagScale) {
  ctx.save();
  const v = bridgeView(w, h);
  drawValley(ctx, v, w, h);
  const D = deckCount();

  // Forces and displacements with the truck at truckX: between two road nodes the truck load is shared
  // by them in proportion, and so are the forces (the model is linear).
  let forces = null, disp = null;
  if (bridge.state) {
    const t = truckX === null ? 0 : Math.min(D - 1, Math.max(0, truckX / DECK_STEP));
    const i = Math.min(D - 2, Math.floor(t)), f = t - i;
    const a = bridge.state(truckX === null ? 0 : i), b = bridge.state(truckX === null ? 0 : i + 1);
    forces = a.forces.map((n, e) => n * (1 - f) + b.forces[e] * f);
    disp = a.disp.map((d, k) => ({ u: d.u * (1 - f) + b.disp[k].u * f, v: d.v * (1 - f) + b.disp[k].v * f }));
  }
  const pos = (k) => {
    const p = bridge.pts[k];
    if (!disp || !sagScale) return { x: v.X(p.x), y: v.Y(p.y) };
    return { x: v.X(p.x + disp[k].u * sagScale), y: v.Y(p.y + disp[k].v * sagScale) };
  };

  ctx.lineCap = 'round';
  // Bars that do not work: through the ground (red dashes) and pieces not joined to the road (grey dashes).
  ctx.setLineDash([4, 4]);
  for (const bar of bridge.bars) {
    if (bar.used) continue;
    ctx.strokeStyle = bar.buried ? COLORS.buried : COLORS.junk;
    ctx.lineWidth = Math.max(1, barWidth(bar.s) * 0.6);
    const p = pos(bar.a), q = pos(bar.b);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  // Working bars: thicker first, so the thin ones stay visible.
  const order = bridge.bars.map((bar, e) => e).filter((e) => bridge.bars[e].used)
    .sort((a, b) => bridge.bars[b].s - bridge.bars[a].s);
  const worst = bridge.worst && bridge.worst.bar >= 0 ? bridge.worst.bar : -1;
  for (const e of order) {
    const bar = bridge.bars[e];
    const p = pos(bar.a), q = pos(bar.b);
    if (e === worst && bridge.u > 1) {
      // The bar that breaks first: a red glow.
      ctx.strokeStyle = 'rgba(255, 60, 40, 0.45)';
      ctx.lineWidth = barWidth(bar.s) + 8;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    ctx.strokeStyle = forces ? forceColor(forces[e], bar) : COLORS.bar;
    ctx.lineWidth = barWidth(bar.s);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  // Nodes: supports as yellow triangles standing on the ground, the others as small dots.
  bridge.pts.forEach((p, k) => {
    if (!bridge.reached[k] && k >= D) return;
    const c = pos(k);
    if (p.fixed) {
      ctx.fillStyle = COLORS.support;
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x - 6, c.y + 9); ctx.lineTo(c.x + 6, c.y + 9); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = COLORS.node;
      ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, 2 * Math.PI); ctx.fill();
    }
  });

  // The truck on the road (drawn at the road, with the sag if it is shown).
  if (truckX !== null) {
    const t = Math.min(D - 1, Math.max(0, truckX / DECK_STEP));
    const i = Math.min(D - 2, Math.floor(t)), f = t - i;
    const a = pos(i), b = pos(i + 1);
    const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
    const len = 2.4 * DECK_STEP * v.scale / 4, hh = Math.max(8, 0.9 * v.scale);
    ctx.fillStyle = COLORS.truck;
    ctx.fillRect(x - len / 2, y - hh - 3, len, hh);
    ctx.fillRect(x + len / 2 - len * 0.3, y - hh * 1.6 - 3, len * 0.3, hh * 0.6);
    ctx.fillStyle = '#222';
    for (const dx of [-0.3, 0.3]) { ctx.beginPath(); ctx.arc(x + dx * len, y - 2, 3, 0, 2 * Math.PI); ctx.fill(); }
  }

  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = '#dfe5f5';
  ctx.fillText(bridgeSummary(bridge), 10, 18);
  if (forces && sagScale) {
    ctx.fillStyle = COLORS.text;
    ctx.fillText(`прогиб увеличен в ${Math.round(sagScale)} раз`, 10, 36);
  }
  ctx.restore();
}

function bridgeSummary(b) {
  if (b.mechanism) return `складывается: свободных движений ${b.mechanism} · сталь ${b.mass.toFixed(2)} т`;
  return `сталь ${b.mass.toFixed(2)} т · загрузка ${(b.u * 100).toFixed(0)}%` + (b.u > 1 ? ` — ломается (${b.worst.why})` : ' — держит');
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// Class shares per generation (stacked), the cost of the best bridge that holds (white) and of the Warren truss (dashed).
// The cost is tonnes in both modes: the steel, or the steel per unit of strength (u·M).
function drawPopulationChart(ctx, history, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 34, r: 52, t: 8, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const n = history.length;
  if (n < 2) return;

  for (let x = 0; x < pw; x++) {
    const row = history[Math.min(n - 1, Math.round((x / (pw - 1)) * (n - 1)))].counts;
    const total = row.reduce((a, b) => a + b, 0);
    let y = pad.t + ph;
    for (let c = 0; c < row.length; c++) {
      const hh = (row[c] / total) * ph;
      ctx.fillStyle = CLASS_COLORS[c];
      ctx.fillRect(pad.l + x, y - hh, 1.5, hh);
      y -= hh;
    }
  }

  // Cost axis (right): from 0 to a bit above the Warren truss (worse bridges at the top edge).
  const ref = REFS.warren ? REFS.warren.cost : Math.max(1, ...history.map((r) => r.cost || 0));
  const hi = 1.3 * ref;
  const sy = (m) => pad.t + ph * (1 - Math.min(hi, m) / hi);
  ctx.font = '11px system-ui, sans-serif';
  if (REFS.warren) {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = COLORS.warren;
    ctx.beginPath(); ctx.moveTo(pad.l, sy(ref)); ctx.lineTo(pad.l + pw, sy(ref)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  history.forEach((r, i) => {
    if (r.cost === null) return;
    const x = pad.l + (i / (n - 1)) * pw;
    if (started) ctx.lineTo(x, sy(r.cost)); else { ctx.moveTo(x, sy(r.cost)); started = true; }
  });
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  for (const f of [0, 0.5, 1]) ctx.fillText(Math.round(f * 100) + '%', pad.l - 4, pad.t + ph * (1 - f) + 4);
  ctx.textAlign = 'left';
  for (const f of [0, 0.5, 1]) ctx.fillText((f * hi).toFixed(1) + ' т', pad.l + pw + 4, pad.t + ph * (1 - f) + 4);
  ctx.textAlign = 'center';
  const gens = n - 1;
  const step = niceStep(gens / 5);
  for (let g = 0; g <= gens; g += step) ctx.fillText(String(g), pad.l + (g / gens) * pw, h - 6);
}
