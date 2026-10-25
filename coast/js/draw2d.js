'use strict';
// 2D PICTURES: the plan (top view), the cross-section, the pool chart. Nothing here affects evolution.
//
// Plan: the sea at the top, the promenade at the bottom (y grows towards the land).
// Section: across the shore at one column, the sea on the left, the land on the right.

const COLORS = {
  bg: '#05070f',
  text: '#c9d2ee',
  muted: '#7d87a6',
  sand: '#c8b27a',
  bed: '#4a3f2c',
  promenade: '#6d7486',
  wall: '#d9dce4',
  water: '#2f6fd6',
  damage: '#ff5a4a',
  reference: '#f0c040',
};

// Surface elevation above the storm level -> colour (deep blue trough .. white crest).
function waterColor(e) {
  const t = Math.max(0, Math.min(1, (e + 2.5) / 5));
  const r = Math.round(10 + 230 * t * t), g = Math.round(40 + 200 * t), b = Math.round(110 + 140 * t);
  return `rgb(${r},${g},${b})`;
}

// Bed level -> colour of dry land or of the sea bed seen through the water.
function bedColor(z) {
  const t = Math.max(0, Math.min(1, (z + 8) / 10));
  return `rgb(${Math.round(70 + 130 * t)},${Math.round(62 + 115 * t)},${Math.round(45 + 75 * t)})`;
}

// Colour of the overtopping at a column, l/s per metre: green (safe) .. red (dangerous).
function overtopColor(q) {
  const t = Math.max(0, Math.min(1, Math.log10(Math.max(q, 0.01) / 0.1) / 2.5)); // 0.1 .. 30 l/s/m
  return `hsl(${Math.round(120 * (1 - t))}, 85%, 55%)`;
}

// sim - a running WaveSim; section - column index of the section line.
function drawPlan(ctx, sim, section, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  if (!sim) return;
  const { nx, ny, z, eta } = sim;
  const s = Math.min(w / nx, h / ny), ox = (w - nx * s) / 2, oy = (h - ny * s) / 2;
  const surge = sim.storm.surge, wallRow = sim.world.wallRow;
  const blockAt = sim.blockAt, b = sim.blocks;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i, depth = eta[c] - z[c];
      let color;
      const k = blockAt ? blockAt[c] : -1;
      if (j === wallRow) color = COLORS.wall;
      else if (j > wallRow) color = COLORS.promenade;
      else if (k >= 0 && z[c] > b.zBase[k] && (depth < 0.3 || z[c] > surge - 0.5)) {
        color = z[c] < b.zTop[k] - 0.01 ? COLORS.damage : BLOCKS[b.type[k]].color;
      } else if (depth > WORLD.H_MIN) color = waterColor(eta[c] - surge);
      else color = bedColor(z[c]);
      ctx.fillStyle = color;
      ctx.fillRect(ox + i * s, oy + j * s, s + 0.5, s + 0.5);
      // Submerged blocks: an outline over the water.
      if (k >= 0 && depth >= 0.3 && z[c] <= surge - 0.5 && z[c] > b.zBase[k]) {
        ctx.strokeStyle = z[c] < b.zTop[k] - 0.01 ? COLORS.damage : BLOCKS[b.type[k]].color;
        ctx.strokeRect(ox + i * s + 1.5, oy + j * s + 1.5, s - 3, s - 3);
      }
    }
  }
  // Overtopping along the wall (so far in this storm).
  const o = sim.toeSamples > 0 ? sim.overtopping() : null;
  if (o) {
    for (let i = 0; i < nx; i++) {
      ctx.fillStyle = overtopColor(o.q[i] * 1000);
      ctx.fillRect(ox + i * s, oy + (wallRow + 1) * s, s + 0.5, s * 0.6);
    }
  }
  // Section line.
  ctx.strokeStyle = '#ffffff';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(ox + (section + 0.5) * s, oy);
  ctx.lineTo(ox + (section + 0.5) * s, oy + ny * s);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('море', ox + 6, oy + 14);
  ctx.fillText('набережная', ox + 6, oy + ny * s - 6);
  return { s, ox, oy };
}

// Column under a mouse x in the plan canvas.
function planColumn(sim, w, h, mx) {
  const s = Math.min(w / sim.nx, h / sim.ny), ox = (w - sim.nx * s) / 2;
  return Math.max(0, Math.min(sim.nx - 1, Math.floor((mx - ox) / s)));
}

function drawSection(ctx, sim, i, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  if (!sim) return;
  const { nx, ny, dx, z, eta } = sim;
  const pad = { l: 30, r: 8, t: 10, b: 18 };
  const zMin = -WORLD.SEA_DEPTH - 0.5, zMax = WORLD.WALL_CREST + 3;
  const X = (y) => pad.l + (y / (ny * dx)) * (w - pad.l - pad.r);
  const Z = (v) => pad.t + (1 - (v - zMin) / (zMax - zMin)) * (h - pad.t - pad.b);
  const b = sim.blocks, blockAt = sim.blockAt;
  // Bed: the bare coast, then blocks on top of it.
  for (let j = 0; j < ny; j++) {
    const c = j * nx + i, x0 = X(j * dx), x1 = X((j + 1) * dx);
    const k = blockAt ? blockAt[c] : -1;
    const base = k >= 0 ? b.zBase[k] : z[c];
    ctx.fillStyle = j === sim.world.wallRow ? COLORS.wall : j > sim.world.wallRow ? COLORS.promenade : COLORS.bed;
    ctx.fillRect(x0, Z(base), x1 - x0 + 0.5, Z(zMin) - Z(base));
    if (k >= 0) {
      ctx.fillStyle = BLOCKS[b.type[k]].color;
      ctx.fillRect(x0, Z(z[c]), x1 - x0 + 0.5, Z(base) - Z(z[c]));
      if (z[c] < b.zTop[k] - 0.01) { // washed away: what is gone, as a red outline
        ctx.strokeStyle = COLORS.damage;
        ctx.strokeRect(x0 + 0.5, Z(b.zTop[k]), x1 - x0 - 1, Z(z[c]) - Z(b.zTop[k]));
      }
    }
  }
  // Water.
  ctx.fillStyle = 'rgba(47, 111, 214, 0.55)';
  ctx.strokeStyle = '#9cc4ff';
  ctx.lineWidth = 1.5;
  for (let j = 0; j < ny; j++) {
    const c = j * nx + i;
    if (eta[c] - z[c] <= WORLD.H_MIN) continue;
    const x0 = X(j * dx), x1 = X((j + 1) * dx);
    ctx.fillRect(x0, Z(eta[c]), x1 - x0 + 0.5, Z(z[c]) - Z(eta[c]));
    ctx.beginPath(); ctx.moveTo(x0, Z(eta[c])); ctx.lineTo(x1, Z(eta[c])); ctx.stroke();
  }
  ctx.lineWidth = 1;
  // Storm level and still water.
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = COLORS.muted;
  ctx.beginPath(); ctx.moveTo(pad.l, Z(sim.storm.surge)); ctx.lineTo(w - pad.r, Z(sim.storm.surge)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (const v of [-8, -4, 0, 4]) ctx.fillText(String(v), pad.l - 4, Z(v) + 4);
  ctx.textAlign = 'left';
  ctx.fillText(`нагон +${sim.storm.surge} м`, pad.l + 4, Z(sim.storm.surge) - 4);
  ctx.fillText(`разрез x = ${((i + 0.5) * dx).toFixed(0)} м`, pad.l + 4, pad.t + 10);
  ctx.textAlign = 'center';
  for (let y = 0; y <= ny * dx; y += 20) ctx.fillText(String(y), X(y), h - 4);
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function drawPopulationChart(ctx, history, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 34, r: 34, t: 8, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const n = history.length;
  if (n < 2) return;
  const maxScore = Math.max(REFERENCE_SCORE, ...history.map((r) => r.best)) * 1.1;

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

  const sy = (score) => pad.t + ph * (1 - score / maxScore);
  ctx.strokeStyle = COLORS.reference;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l, sy(REFERENCE_SCORE)); ctx.lineTo(pad.l + pw, sy(REFERENCE_SCORE));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((r, i) => {
    const x = pad.l + (i / (n - 1)) * pw;
    if (i === 0) ctx.moveTo(x, sy(r.best)); else ctx.lineTo(x, sy(r.best));
  });
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.fillStyle = COLORS.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (const f of [0, 0.5, 1]) ctx.fillText(Math.round(f * 100) + '%', pad.l - 4, pad.t + ph * (1 - f) + 4);
  ctx.textAlign = 'left';
  for (const f of [0, 0.5, 1]) ctx.fillText((f * maxScore).toFixed(0), pad.l + pw + 4, pad.t + ph * (1 - f) + 4);
  ctx.fillStyle = COLORS.reference;
  ctx.fillText('эталон', pad.l + 4, sy(REFERENCE_SCORE) - 4);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  const gens = n - 1;
  const step = niceStep(gens / 5);
  for (let g = 0; g <= gens; g += step) ctx.fillText(String(g), pad.l + (g / gens) * pw, h - 6);
}
