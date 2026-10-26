'use strict';
// 2D PICTURES: torque over a turn, Cp(λ), the start-up torque, the power curve, the rotor profile, the pool chart.
// Nothing here affects evolution. "a" everywhere is the result of analyzeRotor(genome, true).

const COLORS = {
  bg: '#05070f',
  grid: '#1b2340',
  text: '#c9d2ee',
  muted: '#7d87a6',
  rotor: '#5bd0ff',
  reference: '#f0c040',
  friction: '#ff6b5e',
  wind: '#2c3a66',
  now: '#ffffff',
};
const BLADE_COLORS = ['#5bd0ff', '#b48cff', '#5fd47d', '#ff9a5a', '#ff6fb0'];
const CLASS_COLORS = ['#3a4466', '#9b5de5', '#e07a3f', '#3fa7d6', '#5fd47d'];

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// A chart frame: axes from x0..x1, y0..y1; returns coordinate functions. Labels in the units given.
function chartFrame(ctx, w, h, { x0, x1, y0, y1, xLabel, yLabel, xStep, yStep }) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 44, r: 10, t: 10, b: 30 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const X = (x) => pad.l + (x - x0) / (x1 - x0) * pw;
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * ph;
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  xStep = xStep || niceStep((x1 - x0) / 6);
  yStep = yStep || niceStep((y1 - y0) / 5);
  ctx.textAlign = 'center';
  for (let x = Math.ceil(x0 / xStep) * xStep; x <= x1 + 1e-9; x += xStep) {
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(X(x), pad.t); ctx.lineTo(X(x), pad.t + ph); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(+x.toFixed(2), X(x), pad.t + ph + 13);
  }
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

// Index of the table row nearest to λ.
function lambdaIndex(lambda) {
  return Math.max(0, Math.min(LAMBDAS.length - 1, Math.round(lambda / AERO.lambdaStep)));
}

// Torque of one blade at rotor angle psi (N·m at the wind v), from the stored slice solutions at row li.
function bladeTorque(a, li, psi, k, g, v) {
  const solved = a.table.details[li], slices = a.table.slices;
  let q = 0;
  const offset = psi + 2 * Math.PI * k / g.blades;
  for (let s = 0; s < slices.length; s++) q += atAzimuth(solved[s].torque, offset + slices[s].phi);
  return q * (v / AERO.vRef) ** 2;
}

// Torque over one turn at the current λ: every blade and the sum.
function drawTorque(ctx, a, g, lambda, v, psi, w, h) {
  const li = lambdaIndex(lambda);
  const N = 120;
  const unit = TORQUE_UNIT * v * v;
  const strut = strutTorque(g, LAMBDAS[li] * v / BOX.radius);
  const blades = [], total = [];
  for (let n = 0; n <= N; n++) {
    const p = 2 * Math.PI * n / N;
    let sum = strut;
    const row = [];
    for (let k = 0; k < g.blades; k++) { const q = bladeTorque(a, li, p, k, g, v); row.push(q); sum += q; }
    blades.push(row);
    total.push(sum);
  }
  const all = total.concat(...blades);
  let lo = Math.min(0, ...all), hi = Math.max(0.1, ...all);
  const span = hi - lo;
  lo -= span * 0.05; hi += span * 0.08;
  const f = chartFrame(ctx, w, h, { x0: 0, x1: 360, y0: lo, y1: hi, xStep: 60, xLabel: 'угол поворота ротора, °', yLabel: 'момент, Н·м' });
  for (let k = 0; k < g.blades; k++) {
    polyline(ctx, blades.map((r, n) => [f.X(360 * n / N), f.Y(r[k])]), BLADE_COLORS[k % 5] + '99', 1);
  }
  polyline(ctx, total.map((q, n) => [f.X(360 * n / N), f.Y(q)]), '#ffffff', 2.2);
  const mean = a.table.cqMean[li] * unit;
  polyline(ctx, [[f.X(0), f.Y(mean)], [f.X(360), f.Y(mean)]], COLORS.reference, 1, [5, 4]);
  const deg = ((psi * 180 / Math.PI) % 360 + 360) % 360;
  polyline(ctx, [[f.X(deg), f.pad.t], [f.X(deg), f.pad.t + f.ph]], '#ffffff55', 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.reference;
  ctx.fillText(`среднее ${mean.toFixed(1)} Н·м · λ ${LAMBDAS[li]}`, f.pad.l + 6, f.pad.t + 12);
}

// Cp (own swept area) over λ: the rotor, the reference, Betz.
function drawCp(ctx, a, ref, lambda, w, h) {
  const own = (x) => x.cpBox.map((cp, i) => cp * BOX_AREA / x.swept);
  const mine = own(a), theirs = own(ref);
  const f = chartFrame(ctx, w, h, { x0: 0, x1: AERO.lambdaMax, y0: -0.1, y1: 0.62, xStep: 1, yStep: 0.1, xLabel: 'быстроходность λ = скорость конца лопасти / ветер', yLabel: 'Cp' });
  polyline(ctx, [[f.X(0), f.Y(16 / 27)], [f.X(AERO.lambdaMax), f.Y(16 / 27)]], COLORS.muted, 1, [2, 4]);
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'right';
  ctx.fillText('предел Бетца 0,593', f.X(AERO.lambdaMax) - 4, f.Y(16 / 27) - 4);
  const clip = (y) => Math.max(-0.1, y);
  polyline(ctx, theirs.map((cp, i) => [f.X(LAMBDAS[i]), f.Y(clip(cp))]), COLORS.reference, 1.5, [6, 4]);
  polyline(ctx, mine.map((cp, i) => [f.X(LAMBDAS[i]), f.Y(clip(cp))]), COLORS.rotor, 2.2);
  const li = lambdaIndex(lambda);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(f.X(LAMBDAS[li]), f.Y(clip(mine[li])), 4, 0, 7); ctx.fill();
}

// Start-up: the mean torque coefficient over λ (with the worst position at rest) against the friction at the wind v.
function drawStart(ctx, a, ref, v, w, h) {
  const best = LAMBDAS.indexOf(a.lambdaOpt);
  const upTo = Math.min(LAMBDAS.length - 1, Math.max(best + 2, 12));
  const lam = LAMBDAS.slice(0, upTo + 1);
  const friction = FRICTION / (TORQUE_UNIT * v * v);
  const vals = a.table.cqMean.slice(0, upTo + 1).concat(ref.table.cqMean.slice(0, upTo + 1), [a.staticMin, friction * 1.5]);
  const lo = Math.min(-0.002, ...vals) * 1.1, hi = Math.max(...vals) * 1.1;
  const f = chartFrame(ctx, w, h, { x0: 0, x1: lam[lam.length - 1], y0: lo, y1: hi, xStep: 0.5, xLabel: 'λ на разгоне', yLabel: 'Cq' });
  polyline(ctx, lam.map((l, i) => [f.X(l), f.Y(ref.table.cqMean[i])]), COLORS.reference, 1.5, [6, 4]);
  polyline(ctx, lam.map((l, i) => [f.X(l), f.Y(a.table.cqMean[i])]), COLORS.rotor, 2.2);
  polyline(ctx, [[f.X(0), f.Y(friction)], [f.X(lam[lam.length - 1]), f.Y(friction)]], COLORS.friction, 1.5);
  // At rest the position matters: the range of torque over all rotor angles.
  ctx.strokeStyle = COLORS.rotor;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(f.X(0) + 2, f.Y(a.staticMin)); ctx.lineTo(f.X(0) + 2, f.Y(Math.max(...a.table.cq[0]))); ctx.stroke();
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.friction;
  ctx.fillText(`трение при ветре ${v} м/с`, f.X(lam[lam.length - 1]) - 4, f.Y(friction) - 5);
}

// Power curve (W) over the wind, with the Weibull wind distribution as bars behind it.
function drawPower(ctx, a, ref, v, w, h) {
  const pMax = Math.max(100, ...a.power.map((x) => x.p), ...ref.power.map((x) => x.p)) * 1.1;
  const f = chartFrame(ctx, w, h, { x0: 0, x1: SITE.vMax, y0: 0, y1: pMax / 1000, xStep: 2, xLabel: 'ветер, м/с', yLabel: 'мощность, кВт' });
  const shareMax = Math.max(...WINDS.map(windShare));
  ctx.fillStyle = COLORS.wind;
  for (const x of WINDS) {
    const hh = windShare(x) / shareMax * f.ph * 0.6;
    ctx.fillRect(f.X(x - SITE.dv / 2) + 1, f.pad.t + f.ph - hh, f.X(SITE.dv) - f.X(0) - 2, hh);
  }
  polyline(ctx, ref.power.map((x) => [f.X(x.v), f.Y(x.p / 1000)]), COLORS.reference, 1.5, [6, 4]);
  const working = a.power.filter((x) => x.v >= (a.selfStart ? a.vStart : 0));
  polyline(ctx, a.power.map((x) => [f.X(x.v), f.Y(x.p / 1000)]), COLORS.rotor + '55', 1.5);
  if (working.length) polyline(ctx, working.map((x) => [f.X(x.v), f.Y(x.p / 1000)]), COLORS.rotor, 2.2);
  polyline(ctx, [[f.X(v), f.pad.t], [f.X(v), f.pad.t + f.ph]], '#ffffff55', 1);
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'left';
  ctx.fillText('столбики — сколько часов в году дует такой ветер', f.pad.l + 6, f.pad.t + 12);
}

// Side view: every blade projected on the plane across the wind (shows the helix), the box; top view on the right.
function drawProfile(ctx, g, w, h, small) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const N = 40;
  const pts = Array.from({ length: N + 1 }, (_, i) => bladePoint(g, i / N));
  const sideW = small ? w : w * 0.62;
  const pad = small ? 3 : 14;
  const s = Math.min((sideW - 2 * pad) / (2 * BOX.radius), (h - 2 * pad) / BOX.height);
  const cx = sideW / 2, base = h - pad - (h - 2 * pad - s * BOX.height) / 2;
  if (!small) {
    ctx.strokeStyle = COLORS.grid;
    ctx.strokeRect(cx - s * BOX.radius, base - s * BOX.height, 2 * s * BOX.radius, s * BOX.height);
  }
  ctx.strokeStyle = COLORS.muted;
  ctx.lineWidth = small ? 1 : 2;
  ctx.beginPath(); ctx.moveTo(cx, base + 2); ctx.lineTo(cx, base - s * BOX.height - 2); ctx.stroke();
  // Struts
  for (const end of [0, 1]) {
    const p = pts[end * N];
    if (p.r <= STRUT_MIN) continue;
    for (let k = 0; k < g.blades; k++) {
      const x = Math.sin(p.phi + 2 * Math.PI * k / g.blades) * p.r;
      ctx.beginPath(); ctx.moveTo(cx, base - s * p.z); ctx.lineTo(cx + s * x, base - s * p.z); ctx.stroke();
    }
  }
  // Blades: back half darker, chord as line width
  for (let k = 0; k < g.blades; k++) {
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[i + 1];
      const ang = (p) => p.phi + 2 * Math.PI * k / g.blades;
      const front = Math.cos(ang(a)) < 0;
      ctx.strokeStyle = front ? BLADE_COLORS[k % 5] : BLADE_COLORS[k % 5] + '66';
      ctx.lineWidth = Math.max(1, s * a.c * (small ? 0.7 : 0.5));
      ctx.beginPath();
      ctx.moveTo(cx + s * Math.sin(ang(a)) * a.r, base - s * a.z);
      ctx.lineTo(cx + s * Math.sin(ang(b)) * b.r, base - s * b.z);
      ctx.stroke();
    }
  }
  ctx.lineWidth = 1;
  if (small) return;
  // Top view
  const tx = sideW + (w - sideW) / 2, ty = h / 2, ts = Math.min((w - sideW) / 2 - 8, h / 2 - 16) / BOX.radius;
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath(); ctx.arc(tx, ty, ts * BOX.radius, 0, 7); ctx.stroke();
  for (let k = 0; k < g.blades; k++) {
    ctx.strokeStyle = BLADE_COLORS[k % 5];
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const ang = p.phi + 2 * Math.PI * k / g.blades;
      const x = tx + ts * p.r * Math.cos(ang), y = ty - ts * p.r * Math.sin(ang);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'center';
  ctx.fillText('сверху', tx, h - 4);
  ctx.fillText('сбоку (ветер — от нас)', cx, 12);
  ctx.fillText('ветер →', tx, 12);
}

// Rotor speed during the start from rest: rpm over time.
function drawSpinUp(ctx, history, target, w, h) {
  const tMax = Math.max(30, history.length ? history[history.length - 1].t : 0);
  const rpmMax = Math.max(10, target * 1.2, ...history.map((p) => p.rpm));
  const f = chartFrame(ctx, w, h, { x0: 0, x1: tMax, y0: 0, y1: rpmMax, xLabel: 'время с начала пуска, с', yLabel: 'об/мин' });
  polyline(ctx, [[f.X(0), f.Y(target)], [f.X(tMax), f.Y(target)]], COLORS.reference, 1, [5, 4]);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.reference;
  ctx.fillText('рабочие обороты', f.pad.l + 6, f.Y(target) - 4);
  if (history.length > 1) polyline(ctx, history.map((p) => [f.X(p.t), f.Y(p.rpm)]), COLORS.rotor, 2);
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
