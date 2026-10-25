'use strict';
// Population chart and genome matrix.

// Stacked area chart: share of each class (nothing, pendulum, ..., 4+ hands) per generation.
// Same picture as in the video.
function drawPopulationChart(ctx, history, w, h) {
  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 34, r: 8, t: 8, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const n = history.length;
  if (n < 2) return;

  // One column per pixel; each column shows the generation under it.
  for (let x = 0; x < pw; x++) {
    const row = history[Math.min(n - 1, Math.round((x / (pw - 1)) * (n - 1)))];
    const total = row.reduce((a, b) => a + b, 0);
    let y = pad.t + ph;
    for (let c = 0; c < row.length; c++) {
      const hh = (row[c] / total) * ph;
      ctx.fillStyle = CLASS_COLORS[c];
      ctx.fillRect(pad.l + x, y - hh, 1.5, hh);
      y -= hh;
    }
  }

  ctx.fillStyle = '#9aa6c7';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (const f of [0, 0.5, 1]) ctx.fillText(Math.round(f * 100) + '%', pad.l - 4, pad.t + ph * (1 - f) + 4);
  ctx.textAlign = 'center';
  const gens = n - 1;
  const stepGen = niceStep(gens / 5);
  for (let g = 0; g <= gens; g += stepGen) {
    ctx.fillText(String(g), pad.l + (g / gens) * pw, h - 6);
  }
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, x))));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

// Genome matrix: 79 x 79 cells, one per pair of attachment points.
// A filled cell is a bond; its color says what the bond does in this clock.
const ROLE_COLORS = {
  pendulum: '#5b8def',
  escapement: '#ff9a1f',
  spring: '#ffffff',
  train: '#3fbf5f',
  jam: '#e0453a',
  neutral: '#6b7390',
};
const ROLE_NAMES = {
  pendulum: 'маятник',
  escapement: 'спуск (храповик)',
  spring: 'пружина',
  train: 'передача и стрелки',
  jam: 'мешает (клинит)',
  neutral: 'нейтральная — ни на что не влияет',
};

// Group boundaries along the matrix axes, for labels.
const MATRIX_GROUPS = [
  { from: 0, to: 2 * GEAR_COUNT, label: 'Шестерни' },
  { from: 2 * GEAR_COUNT, to: 2 * GEAR_COUNT + 2 * HAND_COUNT, label: 'Стрелки' },
  { from: RATCHET_CENTER, to: RATCHET_TEETH + 1, label: 'Х' },
  { from: SPRING_A, to: SPRING_B + 1, label: 'П' },
  { from: HOUSING, to: HOUSING + 1, label: 'К' },
];

function genomeMatrixGeometry(w) {
  const offset = 18;
  const cell = Math.floor((w - offset) / POINT_COUNT);
  return { offset, cell };
}

function drawGenomeMatrix(ctx, clock, w, h, hoverPair) {
  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, w, h);
  const { offset, cell } = genomeMatrixGeometry(w);
  const size = cell * POINT_COUNT;

  ctx.fillStyle = '#0d1428';
  ctx.fillRect(offset, offset, size, size);
  // Group separators and labels.
  ctx.strokeStyle = '#26304f';
  ctx.fillStyle = '#9aa6c7';
  ctx.font = '10px system-ui, sans-serif';
  for (const g of MATRIX_GROUPS) {
    const a = offset + g.from * cell, b = offset + g.to * cell;
    ctx.beginPath();
    ctx.moveTo(a, offset); ctx.lineTo(a, offset + size);
    ctx.moveTo(offset, a); ctx.lineTo(offset + size, a);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(g.label, (a + b) / 2, 12);
    ctx.save();
    ctx.translate(11, (a + b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(g.label, 0, 0);
    ctx.restore();
  }
  if (!clock) return;

  // Bonds are symmetric, so each one is drawn twice (above and below the diagonal).
  for (const k of clock.genome.bonds) {
    const [a, b] = PAIRS[k];
    const role = clock.mech.roles.get(k) || 'neutral';
    ctx.fillStyle = ROLE_COLORS[role];
    const pad = role === 'neutral' ? 1 : 0;
    ctx.fillRect(offset + a * cell + pad, offset + b * cell + pad, cell - 2 * pad, cell - 2 * pad);
    ctx.fillRect(offset + b * cell + pad, offset + a * cell + pad, cell - 2 * pad, cell - 2 * pad);
  }
  if (hoverPair) {
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(offset + hoverPair[0] * cell - 0.5, offset + hoverPair[1] * cell - 0.5, cell + 1, cell + 1);
  }
}

// Which pair of points is under the mouse (or null).
function genomeMatrixHitTest(x, y, w) {
  const { offset, cell } = genomeMatrixGeometry(w);
  const a = Math.floor((x - offset) / cell), b = Math.floor((y - offset) / cell);
  if (a < 0 || b < 0 || a >= POINT_COUNT || b >= POINT_COUNT || a === b) return null;
  return [a, b];
}
