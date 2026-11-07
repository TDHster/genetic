'use strict';
// 2D PICTURES: the spectrum at the bed, the turn harmonics, noise over the turn rate, the angle of attack along the blade,
// the fan seen from the front, the pool chart. Nothing here affects evolution.
// "a" everywhere is the result of analyzeFan(genome), "cond" - noiseAt(a.prep, s).

const COLORS = {
  bg: '#090a16',
  grid: '#1b1e38',
  text: '#cfd3ef',
  muted: '#8086ab',
  fan: '#7fd6ff',
  reference: '#f0c040',
  tone: '#ff8a5b',
  masking: '#5b9dff',
  threshold: '#6b7094',
  ambient: '#6fd38f',
  stall: '#ff4d6d',
  spoke: '#4a4f78',
  plastic: 'rgba(110, 190, 255, 0.55)',
  plasticEdge: '#bfe6ff',
};
const CLASS_COLORS = ['#3a3f66', '#7d6bb0', '#9b5de5', '#e07a3f', '#3fa7d6', '#5fd47d'];

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// A chart frame: axes x0..x1 (log10 if logX), y0..y1; returns coordinate functions.
function chartFrame(ctx, w, h, { x0, x1, y0, y1, xLabel, yLabel, xStep, yStep, logX }) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 44, r: 10, t: 10, b: 30 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const tx = (x) => (logX ? Math.log10(x) : x);
  const X = (x) => pad.l + (tx(x) - tx(x0)) / (tx(x1) - tx(x0)) * pw;
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * ph;
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.textAlign = 'center';
  const xs = [];
  if (logX) {
    for (let d = Math.ceil(Math.log10(x0)); d <= Math.log10(x1) + 1e-9; d++) xs.push(10 ** d);
  } else {
    xStep = xStep || niceStep((x1 - x0) / 6);
    for (let x = Math.ceil(x0 / xStep) * xStep; x <= x1 + 1e-9; x += xStep) xs.push(x);
  }
  for (const x of xs) {
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(X(x), pad.t); ctx.lineTo(X(x), pad.t + ph); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(x >= 1000 ? `${x / 1000}k` : String(+x.toFixed(2)), X(x), pad.t + ph + 13);
  }
  yStep = yStep || niceStep((y1 - y0) / 5);
  ctx.textAlign = 'right';
  for (let y = Math.ceil(y0 / yStep) * yStep; y <= y1 + 1e-9; y += yStep) {
    ctx.strokeStyle = Math.abs(y) < 1e-9 ? COLORS.muted : COLORS.grid;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(y)); ctx.lineTo(pad.l + pw, Y(y)); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(+y.toFixed(3), pad.l - 4, Y(y) + 4);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(xLabel, pad.l + pw / 2, h - 3);
  ctx.save();
  ctx.translate(11, pad.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
  return { X, Y, pad, pw, ph };
}

function polyline(ctx, points, color, width, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1.5;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
}


// What the person hears: tones (lines) against the masking noise in the critical band of the ear (blue) and the threshold of
// hearing (grey); the room background dotted green (ambient.js). A tone is heard when it sticks out above them. The reference is dashed.
function drawSpectrum(ctx, cond, refCond, w, h, ambient) {
  const f0 = NOISE.lowest, f1 = NOISE.highest;
  const masking = (c, f) => broadbandDensity(c, f) + 10 * Math.log10(criticalBand(f));
  const freqs = [];
  for (let k = 0; k <= 100; k++) freqs.push(f0 * (f1 / f0) ** (k / 100));
  const top = Math.max(70, ...cond.tones.map((t) => t.level), ...refCond.tones.map((t) => t.level), ...freqs.map((f) => masking(cond, f))) + 5;
  const y0 = -5;
  const fr = chartFrame(ctx, w, h, { x0: f0, x1: f1, y0, y1: top, logX: true, yStep: 10, xLabel: 'частота, Гц', yLabel: 'уровень, дБ' });
  const clip = (y) => fr.Y(Math.max(y0, Math.min(top, y)));
  // threshold of hearing: everything below is silence
  ctx.fillStyle = 'rgba(110, 115, 150, 0.16)';
  ctx.beginPath();
  ctx.moveTo(fr.X(f0), fr.Y(y0));
  for (const f of freqs) ctx.lineTo(fr.X(f), clip(hearingThreshold(f)));
  ctx.lineTo(fr.X(f1), fr.Y(y0));
  ctx.closePath();
  ctx.fill();
  polyline(ctx, freqs.map((f) => [fr.X(f), clip(hearingThreshold(f))]), COLORS.threshold, 1.2);
  if (ambient && ambient !== 'none') {
    polyline(ctx, freqs.map((f) => [fr.X(f), clip(ambientDensity(ambient, f) + 10 * Math.log10(criticalBand(f)))]), COLORS.ambient, 1.6, [2, 3]);
  }
  polyline(ctx, freqs.map((f) => [fr.X(f), clip(masking(refCond, f))]), COLORS.reference, 1.2, [5, 4]);
  polyline(ctx, freqs.map((f) => [fr.X(f), clip(masking(cond, f))]), COLORS.masking, 2);
  for (const t of refCond.tones) {
    if (t.level < y0) continue;
    polyline(ctx, [[fr.X(t.f) + 2, fr.Y(y0)], [fr.X(t.f) + 2, clip(t.level)]], COLORS.reference, 1, [3, 3]);
  }
  ctx.fillStyle = COLORS.tone;
  for (const t of cond.tones) {
    if (t.level < y0) continue;
    polyline(ctx, [[fr.X(t.f), fr.Y(y0)], [fr.X(t.f), clip(t.level)]], COLORS.tone, 2);
    ctx.beginPath(); ctx.arc(fr.X(t.f), clip(t.level), 2.5, 0, 7); ctx.fill();
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(`L_R ${cond.rating.toFixed(1)} дБА (эталон ${refCond.rating.toFixed(1)})`, fr.pad.l + fr.pw - 4, fr.pad.t + 12);
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`дБ(A) ${cond.la.toFixed(1)} + тон ${cond.kt.toFixed(1)}`, fr.pad.l + fr.pw - 4, fr.pad.t + 26);
}

// Tones at the turn harmonics h (bars) and the same blades evenly spaced (outlines); the spoke harmonics dashed.
function drawHarmonics(ctx, g, cond, w, h) {
  const H = 60;
  const levels = new Array(H + 1).fill(-Infinity), even = new Array(H + 1).fill(-Infinity);
  for (const t of cond.tones) if (t.h <= H) { levels[t.h] = t.level; even[t.h] = t.even; }
  const finite = [...levels, ...even].filter(Number.isFinite);
  const top = Math.max(40, ...finite) + 5, y0 = -10;
  const f = chartFrame(ctx, w, h, { x0: 0, x1: H + 1, y0, y1: top, xStep: 6, xLabel: `гармоника h (частота h·n, n = ${cond.n.toFixed(1)} об/с)`, yLabel: 'тон, дБ' });
  for (let k = INFLOW.spokes; k <= H; k += INFLOW.spokes) polyline(ctx, [[f.X(k), f.pad.t], [f.X(k), f.pad.t + f.ph]], COLORS.spoke, 1.5, [4, 4]);
  const bw = (f.X(1) - f.X(0)) * 0.7;
  for (let k = 1; k <= H; k++) {
    if (Number.isFinite(levels[k]) && levels[k] > y0) {
      ctx.fillStyle = k % g.blades === 0 ? COLORS.tone : '#d6a35a';
      ctx.fillRect(f.X(k) - bw / 2, f.Y(levels[k]), bw, f.Y(y0) - f.Y(levels[k]));
    }
    if (Number.isFinite(even[k]) && even[k] > y0) {
      ctx.strokeStyle = '#ffffffaa';
      ctx.strokeRect(f.X(k) - bw / 2 - 1, f.Y(even[k]), bw + 2, f.Y(y0) - f.Y(even[k]));
    }
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.muted;
  const { angles } = bladeAngles(g);
  const uneven = g.blades > 1 && smallestGap(angles) < 2 * Math.PI / g.blades - 0.01;  // the whole rotor may be turned
  ctx.fillText(`${g.blades} лоп., ${uneven ? 'неравный шаг: столбики там, где у ровных пусто' : 'ровный шаг: тоны только на h = ' + g.blades + ', ' + 2 * g.blades + '…'}`,
    f.pad.l + f.pw - 4, f.pad.t + 12);
}

// The rating level and the plain dB(A) over the turn rate, for this fan and the reference; the speed settings marked.
function drawNoiseSpeed(ctx, a, ref, cond, w, h) {
  const rpms = [];
  for (let r = 500; r <= 1600; r += 25) rpms.push(r);
  const line = (an, key) => rpms.map((r) => noiseAt(an.prep, r / FAN.rpm)[key]);
  const mine = line(a, 'rating'), mineA = line(a, 'la'), theirs = line(ref, 'rating');
  const all = [...mine, ...theirs, ...mineA];
  const lo = Math.floor(Math.min(...all) / 10) * 10, hi = Math.ceil(Math.max(...all) / 10) * 10 + 5;
  const f = chartFrame(ctx, w, h, { x0: 500, x1: 1600, y0: lo, y1: hi, xStep: 100, xLabel: 'обороты в минуту', yLabel: 'L_R, дБА' });
  FAN.settings.forEach((r, i) => {
    polyline(ctx, [[f.X(r), f.pad.t + 16], [f.X(r), f.pad.t + f.ph]], COLORS.muted, 1, [2, 3]);
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), f.X(r), f.pad.t + 12);
  });
  polyline(ctx, rpms.map((r, i) => [f.X(r), f.Y(theirs[i])]), COLORS.reference, 1.5, [6, 4]);
  polyline(ctx, rpms.map((r, i) => [f.X(r), f.Y(mineA[i])]), COLORS.fan, 1);
  polyline(ctx, rpms.map((r, i) => [f.X(r), f.Y(mine[i])]), COLORS.fan, 2.2);
  const now = cond.s * FAN.rpm;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(f.X(now), f.Y(cond.rating), 4, 0, 7); ctx.fill();
}

// The angle of attack along the blade: its range over a turn (band), the mean (line) and the stall angles (red).
function drawStall(ctx, a, w, h) {
  const strips = a.prep.strips, deg = 180 / Math.PI;
  const rows = strips.map((s) => ({ x: s.x, lo: Math.min(...s.alpha) * deg, hi: Math.max(...s.alpha) * deg, up: s.stallUp * deg, down: s.stallDown * deg }));
  const mean = a.op.elements.map((e) => e.alpha * deg);
  const ymax = Math.max(15, ...rows.map((r) => Math.max(r.hi, r.up))) + 2, ymin = Math.min(-8, ...rows.map((r) => Math.min(r.lo, r.down))) - 1;
  const f = chartFrame(ctx, w, h, { x0: FAN.hubRatio, x1: 1, y0: ymin, y1: ymax, xStep: 0.1, xLabel: 'радиус r / R', yLabel: 'угол атаки, °' });
  ctx.fillStyle = 'rgba(127, 214, 255, 0.22)';
  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(f.X(r.x), f.Y(r.hi)) : ctx.moveTo(f.X(r.x), f.Y(r.hi))));
  for (let i = rows.length - 1; i >= 0; i--) ctx.lineTo(f.X(rows[i].x), f.Y(rows[i].lo));
  ctx.closePath();
  ctx.fill();
  polyline(ctx, rows.map((r) => [f.X(r.x), f.Y(r.up)]), COLORS.stall, 1.5);
  polyline(ctx, rows.map((r) => [f.X(r.x), f.Y(r.down)]), COLORS.stall, 1.5);
  polyline(ctx, rows.map((r, i) => [f.X(r.x), f.Y(mean[i])]), COLORS.fan, 2.2);
  ctx.fillStyle = COLORS.stall;
  ctx.textAlign = 'left';
  ctx.fillText('срыв', f.pad.l + 6, f.Y(rows[0].up) - 5);
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`в срыве ${(100 * a.prep.stalledShare).toFixed(0)}% лопасти×оборота`, f.pad.l + f.pw - 4, f.pad.t + 12);
}

// The fan seen from the front (the guard spokes and the pole behind it in grey) and, on the right, the shape along the radius.
// Angles: blade 0 at the top, the fan turns counter-clockwise on screen (seen from the front).
function drawFan(ctx, g, w, h, small) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const discW = small ? w : Math.min(w * 0.5, h);
  const cx = discW / 2, cy = h / 2, Rmax = Math.min(discW, h) / 2 - (small ? 2 : 12);
  const Rp = Rmax * g.diameter;
  const at = (ang, r) => [cx - Math.sin(ang) * r, cy - Math.cos(ang) * r];
  if (!small) {
    ctx.strokeStyle = COLORS.spoke;
    ctx.lineWidth = 1;
    for (let k = 0; k < INFLOW.spokes; k++) {
      const ang = 2 * Math.PI * k / INFLOW.spokes;
      ctx.beginPath(); ctx.moveTo(...at(ang, Rmax * 0.25)); ctx.lineTo(...at(ang, Rmax * 1.04)); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(cx, cy, Rmax * 1.04, 0, 7); ctx.stroke();
    ctx.fillStyle = '#2a2d4a';
    ctx.fillRect(cx - Rmax * 0.06, cy, Rmax * 0.12, h - cy);
  }
  const N = 30, D = fanDiameter(g);
  const lead = [], trail = [];
  for (let i = 0; i <= N; i++) {
    const x = FAN.hubRatio + (1 - FAN.hubRatio) * i / N;
    const s = sectionAt(g, x);
    const half = s.c / 2 * Math.cos(s.pitchAngle) / s.r;
    lead.push([x, -s.sweep + half]);
    trail.push([x, -s.sweep - half]);
  }
  const { angles } = bladeAngles(g);
  angles.forEach((base, k) => {
    ctx.beginPath();
    [...lead, ...trail.slice().reverse()].forEach(([x, ang], i) => {
      const [px, py] = at(base + ang, Rp * x);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = k === 0 && !small ? 'rgba(160, 215, 255, 0.75)' : COLORS.plastic;
    ctx.fill();
    ctx.strokeStyle = COLORS.plasticEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  });
  ctx.fillStyle = '#d9dcef';
  ctx.beginPath(); ctx.arc(cx, cy, Rp * FAN.hubRatio, 0, 7); ctx.fill();
  if (small) return;
  // gaps between neighbouring blades, at the rim
  const sorted = angles.map((t, j) => ({ t: ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), j })).sort((p, q) => p.t - q.t);
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  sorted.forEach((p, i) => {
    const next = sorted[(i + 1) % sorted.length];
    const gap = ((next.t - p.t) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
    const [px, py] = at(p.t + gap / 2, Rmax * 1.04 + 1);
    if (g.blades > 1) ctx.fillText(`${(gap * 180 / Math.PI).toFixed(0)}°`, px, py + 3);
  });
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = COLORS.muted;
  const label = `вид спереди, Ø ${(D * 100).toFixed(0)} см, вращение против часовой ↺`;
  ctx.fillText(label, Math.max(cx, ctx.measureText(label).width / 2 + 2), h - 2);
  // shape along the radius
  const x0 = discW + 40, x1 = w - 10, y0 = 14, y1 = h - 26;
  const X = (x) => x0 + (x - FAN.hubRatio) / (1 - FAN.hubRatio) * (x1 - x0);
  const Y = (v, lo, hi) => y1 - (v - lo) / (hi - lo) * (y1 - y0);
  ctx.strokeStyle = COLORS.grid;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  const rows = [
    ['угол лопасти, ° / 30', '#7fd6ff', (s) => s.pitchAngle * 180 / Math.PI / 30, 0, 2.6],
    ['ширина c/D ×4', '#d9b26a', (s) => 4 * s.c / D, 0, 2.6],
    ['изгиб f/c ×20', '#9b8cff', (s) => 20 * s.f, 0, 2.6],
    ['сабля, ° / 40', '#ff8a5b', (s) => s.sweep * 180 / Math.PI / 40, -1, 2.6],
  ];
  rows.forEach(([text, color, fn, lo, hi], j) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = FAN.hubRatio + (1 - FAN.hubRatio) * i / N;
      pts.push([X(x), Y(fn(sectionAt(g, x)), lo, hi)]);
    }
    polyline(ctx, pts, color, 2);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, x0 + 6 + (j % 2) * 120, y0 + 12 + Math.floor(j / 2) * 13);
  });
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'center';
  ctx.fillText('от ступицы к концу лопасти', (x0 + x1) / 2, h - 2);
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
  const step = niceStep(Math.max(1, gens / 5));
  for (let g = 0; g <= gens; g += step) ctx.fillText(String(g), pad.l + (g / gens) * pw, h - 6);
}
