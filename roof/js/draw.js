'use strict';
// Drawing: the house with the roof, the drop race, the population chart. Does not affect evolution.

const COLORS = {
  bg: '#05070f',
  roof: '#5b8def',
  house: '#1a2240',
  wall: '#2a3560',
  ground: '#6b7390',
  text: '#9aa6c7',
  drop: '#9fd4ff',
  stuck: '#ff6b5e',
  line: '#b0b8d0',
  arc: '#ff9a1f',
  cycloid: '#3fbf5f',
};
const REF_COLORS = { line: COLORS.line, arc: COLORS.arc, cycloid: COLORS.cycloid };

// Where a drop sliding from point `start` of `pts` is at time t (seconds).
// On every straight piece the acceleration is constant: s = v_a τ + a τ² / 2,
// v_a is the speed after the turn at the start of the piece (see slide() in fitness.js).
function dropPosition(pts, start, run, t) {
  const n = run.times.length - 1; // pieces passed
  if (t >= run.times[n]) return { ...pts[start + n], done: true };
  let k = 0;
  while (k < n - 1 && t >= run.times[k + 1]) k++;
  const a = pts[start + k], b = pts[start + k + 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const va = run.speeds[k];
  const vb = Math.sqrt(va * va + 2 * G * (a.y - b.y));
  const acc = (vb * vb - va * va) / (2 * len);
  const tau = t - run.times[k];
  const s = Math.min(len, va * tau + acc * tau * tau / 2);
  return { x: a.x + (b.x - a.x) * s / len, y: a.y + (b.y - a.y) * s / len, done: false };
}

// Drops for one roof: from the ridge only, or (rain) from every point.
function roofDrops(pts) {
  const starts = TASK.rain ? pts.slice(0, -1).map((_, k) => k) : [0];
  return starts.map((start) => ({ start, run: slide(pts, start) }));
}

// The world-to-canvas mapping for the house picture.
function houseView(w, h, extraLow) {
  const W = TASK.width, H = TASK.height;
  const wallH = Math.max(1.5, 0.45 * Math.max(W, H));
  const low = Math.min(0, extraLow) - wallH;
  const pad = 24;
  const scale = Math.min((w - 2 * pad) / (2 * W * 1.08), (h - 2 * pad - 16) / (H - low));
  const X = (x) => w / 2 + x * scale;
  const Y = (y) => pad + 16 + (H - y) * scale;
  return { X, Y, scale, wallH, low };
}

// roof: the result to show; t: race time, s; refs: reference results that race too (or []).
function drawRace(ctx, roof, t, w, h, refs) {
  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const W = TASK.width;
  const allPts = [roof.pts, ...refs.map((r) => r.pts)];
  const lowest = Math.min(...allPts.map((pts) => Math.min(...pts.map((p) => p.y))));
  const { X, Y, scale, low } = houseView(w, h, lowest);

  // Ground and walls. The walls stand a little inside the eaves (an overhang).
  ctx.strokeStyle = COLORS.ground;
  ctx.beginPath(); ctx.moveTo(0, Y(low)); ctx.lineTo(w, Y(low)); ctx.stroke();
  ctx.fillStyle = COLORS.wall;
  ctx.fillRect(X(-0.85 * W), Y(Math.min(0, lowest)), 1.7 * W * scale, Y(low) - Y(Math.min(0, lowest)));

  // The attic: the roof and its mirror copy, closed between the eaves.
  const full = roof.pts.slice().reverse().map((p) => ({ x: -p.x, y: p.y })).concat(roof.pts.slice(1));
  ctx.fillStyle = COLORS.house;
  ctx.beginPath();
  full.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
  ctx.closePath();
  ctx.fill();

  // Reference curves on the right half: smooth (sampled finely), dashed.
  const smooth = { line: linePoints, arc: arcPoints, cycloid: cycloidPoints };
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  for (const r of refs) {
    ctx.strokeStyle = REF_COLORS[r.key];
    ctx.beginPath();
    smooth[r.key](TASK.segments * 20).forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // The roof itself.
  ctx.strokeStyle = COLORS.roof;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  full.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.roof;
  for (const p of roof.pts.slice(1, -1)) {
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.5, 0, 2 * Math.PI); ctx.fill();
  }

  // Drops. The roof's drops slide on both halves; reference drops - on the right half only.
  const drop = (p, color, r) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), r, 0, 2 * Math.PI); ctx.fill();
  };
  for (const d of roofDrops(roof.pts)) {
    const p = dropPosition(roof.pts, d.start, d.run, t);
    const color = !d.run.reached && p.done ? COLORS.stuck : COLORS.drop;
    const r = TASK.rain ? 3.5 : 6;
    drop(p, color, r);
    drop({ x: -p.x, y: p.y }, color, r);
  }
  for (const r of refs) {
    const run = slide(r.pts, 0);
    drop(dropPosition(r.pts, 0, run, t), REF_COLORS[r.key], 5);
  }

  // Clock and finish times.
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.fillText(`t = ${t.toFixed(2)} с`, 10, 18);
  ctx.restore();
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// Class shares per generation (stacked), the best time (white) and the reference times (dashed).
function drawPopulationChart(ctx, history, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 34, r: 44, t: 8, b: 22 };
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

  // Time axis (right): from a bit below the fastest time to a bit above the straight roof,
  // so that the small gap between the best roof and the cycloid is visible.
  const times = history.map((r) => r.time).filter((v) => v !== null);
  const refs = ['line', 'arc', 'cycloid'].map(refTime).filter(Number.isFinite);
  const tMin = Math.min(...times, ...refs) * 0.97;
  const tMax = Math.max(...refs) * 1.25;
  const sy = (t) => pad.t + ph * (1 - (Math.min(tMax, t) - tMin) / (tMax - tMin));

  ctx.font = '11px system-ui, sans-serif';
  ctx.setLineDash([6, 4]);
  for (const key of ['line', 'arc', 'cycloid']) {
    const t = refTime(key);
    if (!Number.isFinite(t)) continue;
    ctx.strokeStyle = REF_COLORS[key];
    ctx.beginPath(); ctx.moveTo(pad.l, sy(t)); ctx.lineTo(pad.l + pw, sy(t)); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  history.forEach((r, i) => {
    if (r.time === null) return;
    const x = pad.l + (i / (n - 1)) * pw;
    if (!started) { ctx.moveTo(x, sy(r.time)); started = true; } else ctx.lineTo(x, sy(r.time));
  });
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  for (const f of [0, 0.5, 1]) ctx.fillText(Math.round(f * 100) + '%', pad.l - 4, pad.t + ph * (1 - f) + 4);
  ctx.textAlign = 'left';
  for (const f of [0, 0.5, 1]) ctx.fillText((tMin + f * (tMax - tMin)).toFixed(2) + ' с', pad.l + pw + 4, pad.t + ph * (1 - f) + 4);
  ctx.textAlign = 'center';
  const gens = n - 1;
  const step = niceStep(gens / 5);
  for (let g = 0; g <= gens; g += step) ctx.fillText(String(g), pad.l + (g / gens) * pw, h - 6);
}
