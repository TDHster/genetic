'use strict';
// 2D PICTURES: the noise spectrum, noise over speed, the wake harmonics, cavitation along the blade,
// the propeller curves, the propeller seen from behind, the pool chart. Nothing here affects evolution.
// "a" everywhere is the result of analyzePropeller(genome) (+ a.curves), "cond" - noiseAt(a.prep, V, depth).

const COLORS = {
  bg: '#04090f',
  grid: '#15263a',
  text: '#c9d6ee',
  muted: '#7b8aa6',
  prop: '#4fd1c5',
  reference: '#f0c040',
  tone: '#ff8a5b',
  broadband: '#5b9dff',
  cavitation: '#ff4d6d',
  fin: '#5c6b85',
  side: '#b48cff',
  stator: '#3f8f88',
};
const CLASS_COLORS = ['#3a4466', '#9b5de5', '#e07a3f', '#3fa7d6', '#5fd47d'];

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

// What the sonar hears: tones (lines), broadband (curve), cavitation (red hump). The reference is dashed.
// sea (the sea mode: { sea, range }) - a grey area: the sea noise lifted by 20·lg(range) − sonar gain(f);
// whatever sticks out above it is heard from farther than the goal.
function drawSpectrum(ctx, a, ref, cond, refCond, w, h, sea) {
  const f0 = 1, f1 = 20000;
  const top = Math.max(130, ...cond.tones.map((t) => t.level), ...refCond.tones.map((t) => t.level)) + 5;
  const fr = chartFrame(ctx, w, h, { x0: f0, x1: f1, y0: 40, y1: top, logX: true, yStep: 20, xLabel: 'частота, Гц', yLabel: 'уровень, дБ' });
  const freqs = [];
  for (let k = 0; k <= 120; k++) freqs.push(f0 * (f1 / f0) ** (k / 120));
  if (sea) {
    const lift = 20 * Math.log10(sea.range);
    const pts = freqs.filter((f) => f >= SONAR.lowest && f <= SONAR.highest)
      .map((f) => [fr.X(f), fr.Y(Math.max(40, Math.min(top, seaDensity(f, sea.sea) + lift - sonarGain(f))))]);
    ctx.fillStyle = 'rgba(140, 160, 190, 0.18)';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], fr.Y(40));
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], fr.Y(40));
    ctx.closePath();
    ctx.fill();
    polyline(ctx, pts, '#9fb2cc', 1.2);
    ctx.fillStyle = '#9fb2cc';
    ctx.textAlign = 'left';
    ctx.fillText(`море: выше — слышно дальше ${sea.range >= 1000 ? (sea.range / 1000).toFixed(1) + ' км' : sea.range + ' м'}`, fr.pad.l + 4, fr.pad.t + 26);
  }
  const curve = (c, an, color, dash) => {
    const fp = broadbandPeak(an.prep, c.V);
    polyline(ctx, freqs.map((f) => [fr.X(f), fr.Y(Math.max(40, bandDensity(c.broadband, fp, f)))]), color, dash ? 1.2 : 2, dash);
    if (c.extent > 0) {
      polyline(ctx, freqs.map((f) => [fr.X(f), fr.Y(Math.max(40, bandDensity(c.cavitation, CAVITATION_PEAK, f)))]),
        dash ? COLORS.reference : COLORS.cavitation, dash ? 1.2 : 2.2, dash);
    }
  };
  curve(refCond, ref, COLORS.reference, [5, 4]);
  curve(cond, a, COLORS.broadband, null);
  for (const t of refCond.tones) {
    if (t.f < f0) continue;
    polyline(ctx, [[fr.X(t.f) + 2, fr.Y(40)], [fr.X(t.f) + 2, fr.Y(Math.max(40, t.level))]], COLORS.reference, 1, [3, 3]);
  }
  ctx.fillStyle = COLORS.tone;
  for (const t of cond.tones) {
    if (t.f < f0 || t.level < 40) continue;
    polyline(ctx, [[fr.X(t.f), fr.Y(40)], [fr.X(t.f), fr.Y(t.level)]], COLORS.tone, 2.2);
    ctx.beginPath(); ctx.arc(fr.X(t.f), fr.Y(t.level), 3, 0, 7); ctx.fill();
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(`всего ${cond.total.toFixed(1)} дБ (эталон ${refCond.total.toFixed(1)})`, fr.pad.l + fr.pw - 4, fr.pad.t + 12);
}

// Total noise over the boat speed at the depth of cond, for this propeller and the reference.
function drawNoiseSpeed(ctx, a, ref, cond, w, h) {
  const speeds = [];
  for (let v = 2; v <= 24; v += 0.5) speeds.push(v);
  const line = (an) => speeds.map((v) => noiseAt(an.prep, v * KNOT, cond.depth).total);
  const mine = line(a), theirs = line(ref);
  const lo = Math.floor(Math.min(...mine, ...theirs) / 10) * 10, hi = Math.ceil(Math.max(...mine, ...theirs) / 10) * 10 + 5;
  const f = chartFrame(ctx, w, h, { x0: 0, x1: 24, y0: lo, y1: hi, xStep: 2, xLabel: `скорость лодки, узлы (глубина ${cond.depth} м)`, yLabel: 'шум, дБ' });
  polyline(ctx, speeds.map((v, i) => [f.X(v), f.Y(theirs[i])]), COLORS.reference, 1.5, [6, 4]);
  polyline(ctx, speeds.map((v, i) => [f.X(v), f.Y(mine[i])]), COLORS.prop, 2.2);
  const vNow = cond.V / KNOT;
  polyline(ctx, [[f.X(vNow), f.pad.t], [f.X(vNow), f.pad.t + f.ph]], '#ffffff55', 1);
  const vi = cond.inception / KNOT;
  if (vi < 24) {
    ctx.fillStyle = COLORS.cavitation;
    ctx.beginPath(); ctx.arc(f.X(vi), f.Y(noiseAt(a.prep, cond.inception, cond.depth).total), 4, 0, 7); ctx.fill();
    ctx.textAlign = vi > 18 ? 'right' : 'left';
    ctx.fillText(`кавитация с ${vi.toFixed(1)} уз`, f.X(vi) + (vi > 18 ? -7 : 7), f.Y(noiseAt(a.prep, cond.inception, cond.depth).total) + 14);
  }
  const vp = SETUP.patrolSpeed;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'center';
  ctx.fillText('патруль', f.X(vp), f.pad.t + 12);
  polyline(ctx, [[f.X(vp), f.pad.t + 16], [f.X(vp), f.pad.t + f.ph]], COLORS.muted, 1, [2, 3]);
}

// Wake harmonics at 3/4 of the radius: the propeller feels only m = Z, 2Z, 3Z... (coloured);
// above them - how many dB the skew took away from that tone.
function drawWake(ctx, a, g, cond, w, h) {
  const r = 0.75 * propDiameter(g) / 2, M = 40;
  const amps = [];
  for (let m = 1; m <= M; m++) amps.push(wakeHarmonic(m, r, g));
  const top = Math.max(...amps) * 1.25;
  const f = chartFrame(ctx, w, h, { x0: 0, x1: M + 1, y0: 0, y1: top * 100, xStep: 4, xLabel: 'гармоника следа m (раз за оборот)', yLabel: 'амплитуда, % скорости' });
  const bw = (f.X(1) - f.X(0)) * 0.7;
  for (let m = 1; m <= M; m++) {
    const felt = m % g.blades === 0, side = (m + 1) % g.blades === 0 || (m - 1) % g.blades === 0;
    const stator = g.duct && m % g.stators === 0;
    ctx.fillStyle = felt ? COLORS.tone : side ? COLORS.side : stator ? COLORS.stator : (m % WAKE.fins === 0 ? COLORS.fin : '#2a3a55');
    ctx.fillRect(f.X(m) - bw / 2, f.Y(amps[m - 1] * 100), bw, f.Y(0) - f.Y(amps[m - 1] * 100));
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const t of cond.tones) {
    if (t.m > M) continue;
    const cut = t.noSkew - t.level;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(Math.abs(cut) >= 0.5 ? `−${cut.toFixed(0)}` : '0', f.X(t.m), f.Y(amps[t.m - 1] * 100) - 4);
  }
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`${g.blades} лоп.: вдоль вала m = ${g.blades}, ${2 * g.blades}…, вбок m = ${g.blades - 1}, ${g.blades + 1}…; числа — дБ, убранные откосом`, f.pad.l + f.pw - 4, f.pad.t + 12);
}

// Cavitation margin along the blade: suction / σ at the worst position in a turn (> 1 - the water boils).
function drawCavitation(ctx, a, cond, w, h) {
  const strips = a.prep.strips;
  const worst = cond.strips.map((m) => Math.max(...m));
  const tip = Math.max(...cond.tipRatio);
  const hi = Math.max(1.5, ...worst, tip) * 1.1;
  const f = chartFrame(ctx, w, h, { x0: BOAT.hubRatio, x1: 1, y0: 0, y1: hi, xStep: 0.25, xLabel: 'радиус r / R', yLabel: 'разрежение / σ' });
  ctx.fillStyle = 'rgba(255, 77, 109, 0.12)';
  ctx.fillRect(f.pad.l, f.pad.t, f.pw, f.Y(1) - f.pad.t);
  polyline(ctx, [[f.X(BOAT.hubRatio), f.Y(1)], [f.X(1), f.Y(1)]], COLORS.cavitation, 1.5);
  polyline(ctx, strips.map((s, i) => [f.X(s.x), f.Y(worst[i])]), COLORS.prop, 2.2);
  ctx.fillStyle = tip > 1 ? COLORS.cavitation : COLORS.reference;
  ctx.beginPath(); ctx.arc(f.X(NOISE.tipAt), f.Y(tip), 5, 0, 7); ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillText('концевой вихрь', f.X(NOISE.tipAt) - 80, f.Y(tip) - 8);
  ctx.fillStyle = COLORS.cavitation;
  ctx.fillText('выше линии — вода закипает', f.pad.l + 6, f.Y(1) - 5);
}

// KT, 10·KQ and the propulsive efficiency over J, with the working point.
function drawCurves(ctx, a, w, h) {
  const c = a.curves;
  const f = chartFrame(ctx, w, h, { x0: 0, x1: HYDRO.jMax, y0: 0, y1: 1, xStep: 0.5, yStep: 0.2, xLabel: 'J = V / (n·D)', yLabel: 'KT, 10·KQ, КПД' });
  const ok = (y) => Math.max(0, Math.min(1, y));
  polyline(ctx, c.map((p) => [f.X(p.J), f.Y(ok(p.KT))]), COLORS.prop, 2);
  polyline(ctx, c.map((p) => [f.X(p.J), f.Y(ok(10 * p.KQ))]), COLORS.tone, 2);
  polyline(ctx, c.map((p) => [f.X(p.J), f.Y(ok(p.eta))]), '#ffffff', 1.5, [5, 3]);
  // the hull line KT = need · J²
  const need = requiredLoad(a.genome);
  const hull = [];
  for (let J = 0; J <= HYDRO.jMax; J += 0.05) hull.push([f.X(J), f.Y(ok(need * J * J))]);
  polyline(ctx, hull, COLORS.muted, 1, [2, 3]);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(f.X(a.J), f.Y(ok(a.op.KT)), 4, 0, 7); ctx.fill();
  ctx.textAlign = 'left';
  ctx.font = '11px system-ui, sans-serif';
  const legend = [['KT — упор', COLORS.prop], ['10·KQ — момент', COLORS.tone], ['КПД', '#ffffff'], ['нужно корпусу', COLORS.muted]];
  legend.forEach(([t, col], i) => { ctx.fillStyle = col; ctx.fillText(t, f.pad.l + 8 + i * 110, f.pad.t + 12); });
}

// The propeller seen from behind (the fins behind it in grey) and, on the right, the shape along the radius.
function drawPropeller(ctx, g, w, h, small) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const discW = small ? w : Math.min(w * 0.5, h);
  const cx = discW / 2, cy = h / 2, R = (Math.min(discW, h) / 2 - (small ? 2 : 10));
  const Rmax = R, Rp = R * g.diameter;
  if (!small) {
    // fins behind
    ctx.strokeStyle = COLORS.fin;
    ctx.lineWidth = 5;
    for (let k = 0; k < WAKE.fins; k++) {
      const ang = 2 * Math.PI * k / WAKE.fins;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(ang) * Rmax * 0.4, cy - Math.cos(ang) * Rmax * 0.4);
      ctx.lineTo(cx + Math.sin(ang) * Rmax * 1.02, cy - Math.cos(ang) * Rmax * 1.02);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.arc(cx, cy, Rmax, 0, 7); ctx.stroke();
  }
  // pump-jet stator vanes (in front of the rotor, seen through it)
  if (g.duct) {
    ctx.strokeStyle = COLORS.stator;
    ctx.lineWidth = small ? 1 : 3;
    for (let k = 0; k < g.stators; k++) {
      const ang = 2 * Math.PI * (k + 0.5) / g.stators;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(ang) * Rp * BOAT.hubRatio, cy - Math.cos(ang) * Rp * BOAT.hubRatio);
      ctx.lineTo(cx + Math.sin(ang) * Rp, cy - Math.cos(ang) * Rp);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }
  // blades: outline of every blade, angles from the top, clockwise on screen = the rotation seen from behind
  const N = 30, D = propDiameter(g);
  const lead = [], trail = [];
  for (let i = 0; i <= N; i++) {
    const x = BOAT.hubRatio + (1 - BOAT.hubRatio) * i / N;
    const s = sectionAt(g, x);
    const half = s.c / 2 * Math.cos(s.pitchAngle) / s.r;
    lead.push([x, -s.skew + half]);
    trail.push([x, -s.skew - half]);
  }
  for (let k = 0; k < g.blades; k++) {
    const base = 2 * Math.PI * k / g.blades;
    ctx.beginPath();
    [...lead, ...trail.slice().reverse()].forEach(([x, ang], i) => {
      const px = cx + Math.sin(base + ang) * Rp * x, py = cy - Math.cos(base + ang) * Rp * x;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = k === 0 && !small ? '#d9b26a' : '#b08d4e';
    ctx.fill();
    ctx.strokeStyle = '#f3dca6';
    ctx.stroke();
  }
  ctx.fillStyle = '#6c7a90';
  ctx.beginPath(); ctx.arc(cx, cy, Rp * BOAT.hubRatio, 0, 7); ctx.fill();
  if (g.duct) {
    ctx.strokeStyle = '#8fa3bd';
    ctx.lineWidth = small ? 2 : Math.max(3, Rp * g.ductLength * 0.12);
    ctx.beginPath(); ctx.arc(cx, cy, Rp * 1.03, 0, 7); ctx.stroke();
    ctx.lineWidth = 1;
  }
  if (small) return;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'center';
  ctx.font = '11px system-ui, sans-serif';
  const label = `вид сзади, Ø ${D.toFixed(2)} м${g.duct ? `, насадка, статор ${g.stators} лоп.` : ''}, вращение по часовой →`;
  ctx.fillText(label, Math.max(cx, ctx.measureText(label).width / 2 + 2), h - 2);
  // shape along the radius
  const x0 = discW + 40, x1 = w - 10, y0 = 14, y1 = h - 26;
  const X = (x) => x0 + (x - BOAT.hubRatio) / (1 - BOAT.hubRatio) * (x1 - x0);
  const Y = (v, lo, hi) => y1 - (v - lo) / (hi - lo) * (y1 - y0);
  ctx.strokeStyle = COLORS.grid;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  const rows = [
    ['шаг P/D', '#4fd1c5', (s) => s.pd, 0, 2.2],
    ['ширина c/D ×3', '#d9b26a', (s) => 3 * s.c / D, 0, 2.2],
    ['толщина t/c ×10', '#9b8cff', (s) => 10 * s.tau, 0, 2.2],
    ['откос, ° / 40', '#ff8a5b', (s) => s.skew * 180 / Math.PI / 40, -0.8, 2.2],
  ];
  rows.forEach(([label, color, fn, lo, hi], j) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = BOAT.hubRatio + (1 - BOAT.hubRatio) * i / N;
      pts.push([X(x), Y(fn(sectionAt(g, x)), lo, hi)]);
    }
    polyline(ctx, pts, color, 2);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, x0 + 6 + (j % 2) * 110, y0 + 12 + Math.floor(j / 2) * 13);
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
