'use strict';
// 2D PICTURES: pressure along the chord, the polar, Cl and L/D against the angle, the genome, the pool chart, the gallery.
// Nothing here affects evolution.
//   at     - analyzeAt(...) at the current angle (full: panels, boundary layer, pressures);
//   points - a polar from sweepPolar (light points).

const COLORS = {
  bg: '#05070f',
  grid: '#1b2340',
  text: '#c9d2ee',
  muted: '#7d87a6',
  upper: '#5bd0ff',
  lower: '#ff9a5a',
  airfoil: '#c9d2ee',
  reference: '#f0c040',
  good: '#5fd47d',
  bad: '#ff6b5e',
  now: '#ffffff',
};

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// A chart frame: axes from x0..x1, y0..y1; returns coordinate functions.
function chartFrame(ctx, w, h, { x0, x1, y0, y1, xLabel, yLabel, xStep, yStep, padRight, padBottom }) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 44, r: padRight || 10, t: 10, b: padBottom || 30 };
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
    ctx.fillText(+x.toFixed(4), X(x), pad.t + ph + 13);
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
  ctx.fillText(xLabel, pad.l + pw / 2, pad.t + ph + 26);
  ctx.save();
  ctx.translate(11, pad.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
  return { X, Y, pad, pw, ph };
}

function polyline(ctx, points, color, width, dash) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1.5;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
}

function marker(ctx, x, y, kind, color) {
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (kind === 'transition') { ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 3); ctx.lineTo(x + 5, y + 3); ctx.closePath(); ctx.fill(); }
  else { ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke(); }
  ctx.lineWidth = 1;
}

// Outline of a genome as canvas points: X(x), Y(y) map chord coordinates.
function outline(g, X, Y) {
  const pts = [];
  for (let k = STATIONS.length - 1; k >= 0; k--) pts.push([X(STATIONS[k]), Y(cstY(g.l, STATIONS[k]))]);
  for (let k = 1; k < STATIONS.length; k++) pts.push([X(STATIONS[k]), Y(cstY(g.u, STATIONS[k]))]);
  return pts;
}

// ---- Pressure along the chord, with the airfoil and its boundary layer underneath ----

function drawCpChart(ctx, g, at, refG, w, h) {
  const profileH = 125;
  if (!at) {
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = COLORS.muted; ctx.fillText('поток не посчитался', 20, 20);
    return;
  }
  const cp = at.sol.cp;
  let top = 1.5;
  for (let i = 0; i < cp.length; i++) top = Math.max(top, -cp[i]);
  top = Math.min(8, Math.ceil(top * 2 + 0.3) / 2);
  const f = chartFrame(ctx, w, h, { x0: 0, x1: 1, y0: -1.2, y1: top, xLabel: 'x / хорда', yLabel: '−Cp', padBottom: 30 + profileH });
  for (const [side, color] of [['upper', COLORS.upper], ['lower', COLORS.lower]]) {
    const s = at[side];
    const pts = s.idx.map((i) => [f.X(at.P.xm[i]), f.Y(-cp[i])]);
    polyline(ctx, pts, color, 2);
    const mark = (x, kind) => {
      if (x === null) return;
      let k = 0;
      for (let q = 1; q < s.idx.length; q++) if (Math.abs(at.P.xm[s.idx[q]] - x) < Math.abs(at.P.xm[s.idx[k]] - x)) k = q;
      marker(ctx, f.X(x), f.Y(-cp[s.idx[k]]) - 10, kind, kind === 'transition' ? COLORS.now : COLORS.bad);
    };
    mark(s.transitionX, 'transition');
    if (s.separationX !== null && s.separationX < 0.995) mark(s.separationX, 'separation');
  }
  // the airfoil below the chart (chord along the x axis of the chart, not turned: the angle is seen in the tunnel);
  // the boundary layer displacement thickness exaggerated ×5
  const y0 = f.pad.t + f.ph + 30 + profileH * 0.72, scale = f.pw;
  const toCanvas = (x, y) => [f.pad.l + x * scale, y0 - y * scale];
  ctx.save();
  ctx.beginPath(); ctx.rect(0, f.pad.t + f.ph + 30, w, profileH - 14); ctx.clip();
  if (refG) polyline(ctx, outline(refG, (x) => x, (y) => y).map(([x, y]) => toCanvas(x, y)), COLORS.reference, 1, [4, 3]);
  ctx.fillStyle = 'rgba(91, 208, 255, 0.25)';
  for (const side of [at.upper, at.lower]) {
    ctx.beginPath();
    side.idx.forEach((i, k) => {
      const d = 5 * Math.min(0.012, at.dstar[i]);   // past a separation δ* explodes: the band is capped
      const [x, y] = toCanvas(at.P.xm[i] + at.P.nx[i] * d, at.P.ym[i] + at.P.ny[i] * d);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    for (let k = side.idx.length - 1; k >= 0; k--) {
      const i = side.idx[k];
      const [x, y] = toCanvas(at.P.xm[i], at.P.ym[i]);
      ctx.lineTo(x, y);
    }
    ctx.fill();
  }
  const pts = outline(g, (x) => x, (y) => y).map(([x, y]) => toCanvas(x, y));
  ctx.fillStyle = '#26304f';
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.fill();
  polyline(ctx, pts, COLORS.airfoil, 1.2);
  ctx.restore();
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'left';
  ctx.fillText('поток →     полоса — толщина пограничного слоя ×5', f.pad.l, h - 4);
}

// ---- Polar Cl(Cd) ----

function drawPolar(ctx, points, refPoints, current, work, w, h) {
  const ok = (p) => !p.failed;
  const all = points.filter(ok).concat(refPoints ? refPoints.filter(ok) : []);
  const attachedCd = all.filter((p) => p.attached).map((p) => p.cd);
  const x1 = Math.min(0.05, Math.max(0.02, (attachedCd.length ? Math.max(...attachedCd) : 0.02) * 1.3));
  const cls = all.map((p) => p.cl);
  const y0 = Math.min(-0.2, Math.floor(Math.min(...cls, 0) * 5) / 5), y1 = Math.max(1, Math.ceil(Math.max(...cls, 1) * 5) / 5);
  const f = chartFrame(ctx, w, h, { x0: 0, x1, y0, y1, xLabel: 'Cd (сопротивление)', yLabel: 'Cl (подъёмная сила)' });
  ctx.save();
  ctx.beginPath(); ctx.rect(f.pad.l, f.pad.t, f.pw, f.ph); ctx.clip();
  if (work) polyline(ctx, [[f.X(0), f.Y(0)], [f.X(x1), f.Y(x1 * work.ld)]], 'rgba(95, 212, 125, 0.6)', 1, [3, 3]);
  if (refPoints) polyline(ctx, refPoints.filter((p) => ok(p) && p.attached).map((p) => [f.X(p.cd), f.Y(p.cl)]), COLORS.reference, 1.5, [5, 4]);
  polyline(ctx, points.filter((p) => ok(p) && p.attached).map((p) => [f.X(p.cd), f.Y(p.cl)]), COLORS.upper, 2);
  ctx.fillStyle = 'rgba(91, 208, 255, 0.3)';
  for (const p of points) if (ok(p) && !p.attached) { ctx.beginPath(); ctx.arc(f.X(p.cd), f.Y(p.cl), 2, 0, 2 * Math.PI); ctx.fill(); }
  if (work) { ctx.fillStyle = COLORS.good; ctx.beginPath(); ctx.arc(f.X(work.cd), f.Y(work.cl), 4, 0, 2 * Math.PI); ctx.fill(); }
  if (current) { ctx.strokeStyle = COLORS.now; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(f.X(current.cd), f.Y(current.cl), 6, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.restore();
}

// ---- Cl and L/D against the angle of attack ----

function drawClAlpha(ctx, points, refPoints, alphaNow, work, margin, w, h) {
  const ok = (p) => !p.failed;
  const cls = points.filter(ok).map((p) => p.cl).concat(refPoints ? refPoints.filter(ok).map((p) => p.cl) : []);
  const y0 = Math.min(-0.5, Math.floor(Math.min(...cls, 0) * 2) / 2), y1 = Math.max(1.5, Math.ceil(Math.max(...cls, 1) * 2) / 2);
  const f = chartFrame(ctx, w, h, { x0: ALPHAS[0], x1: ALPHAS[ALPHAS.length - 1], y0, y1, xLabel: 'угол атаки, °', yLabel: 'Cl', xStep: 2, padRight: 40 });
  const lds = points.filter((p) => ok(p) && p.attached).map((p) => p.ld).concat(refPoints ? refPoints.filter((p) => ok(p) && p.attached).map((p) => p.ld) : []);
  const ldMax = niceStep(Math.max(50, ...lds) / 4) * 4;
  const Yld = (v) => f.pad.t + (1 - (v - ldMax * y0 / y1) / (ldMax - ldMax * y0 / y1)) * f.ph;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'left';
  for (let v = 0; v <= ldMax; v += ldMax / 4) ctx.fillText(String(v), f.pad.l + f.pw + 4, Yld(v) + 4);
  if (work) {
    ctx.fillStyle = 'rgba(95, 212, 125, 0.15)';
    ctx.fillRect(f.X(work.alpha), f.pad.t, f.X(work.alpha + margin) - f.X(work.alpha), f.ph);
  }
  // stalled region: everything after the first stalled angle above the attached ones
  const firstStall = points.find((p, i) => i > 0 && ok(p) && !p.attached && points.slice(0, i).some((q) => q.attached));
  if (firstStall) {
    ctx.fillStyle = 'rgba(255, 107, 94, 0.08)';
    ctx.fillRect(f.X(firstStall.alpha), f.pad.t, f.pad.l + f.pw - f.X(firstStall.alpha), f.ph);
    ctx.fillStyle = COLORS.bad;
    ctx.fillText('срыв', f.X(firstStall.alpha) + 4, f.pad.t + 12);
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(f.pad.l, f.pad.t, f.pw, f.ph); ctx.clip();
  if (refPoints) {
    polyline(ctx, refPoints.filter(ok).map((p) => [f.X(p.alpha), f.Y(p.cl)]), COLORS.reference, 1.2, [5, 4]);
  }
  polyline(ctx, points.filter(ok).map((p) => [f.X(p.alpha), f.Y(p.cl)]), 'rgba(91, 208, 255, 0.3)', 1);
  polyline(ctx, points.filter((p) => ok(p) && p.attached).map((p) => [f.X(p.alpha), f.Y(p.cl)]), COLORS.upper, 2);
  polyline(ctx, points.filter((p) => ok(p) && p.attached && p.ld > 0).map((p) => [f.X(p.alpha), Yld(p.ld)]), COLORS.good, 1.5, [4, 3]);
  ctx.restore();
  polyline(ctx, [[f.X(alphaNow), f.pad.t], [f.X(alphaNow), f.pad.t + f.ph]], COLORS.now, 1, [2, 3]);
}

// ---- The genome: the airfoil, its camber line and the bumps of the upper surface ----

function drawGenome2d(ctx, g, refG, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const scale = w - 40, X = (x) => 20 + x * scale, Y = (y) => h * 0.55 - y * scale;
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(0)); ctx.stroke();
  for (let i = 0; i <= CST_ORDER; i++) {
    const pts = STATIONS.map((x) => [X(x), Y(classFunction(x) * g.u[i] * bernstein(i, x))]);
    polyline(ctx, pts, `hsla(${200 + 25 * i}, 70%, 65%, 0.55)`, 1);
  }
  if (refG) polyline(ctx, outline(refG, X, Y), COLORS.reference, 1, [4, 3]);
  const pts = outline(g, X, Y);
  ctx.fillStyle = 'rgba(91, 208, 255, 0.12)';
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.fill();
  polyline(ctx, pts, COLORS.airfoil, 2);
  polyline(ctx, STATIONS.map((x) => [X(x), Y((cstY(g.u, x) + cstY(g.l, x)) / 2)]), COLORS.lower, 1, [3, 3]);
  ctx.fillStyle = COLORS.muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('пунктир — средняя линия (кривизна); жёлтый — эталон', 20, h - 8);
}

// Small silhouette for the gallery.
function drawMini(ctx, g, w, h, color) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const scale = w - 8, X = (x) => 4 + x * scale, Y = (y) => h * 0.55 - y * scale;
  const pts = outline(g, X, Y);
  ctx.fillStyle = color || 'rgba(91, 208, 255, 0.35)';
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.fill();
  polyline(ctx, pts, COLORS.airfoil, 1);
}

// ---- Pool composition by generation + the best score ----

function drawPoolChart(ctx, history, referenceScore, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  if (!history || !history.length) return;
  const pad = { l: 34, r: 44, t: 8, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const n = history.length, X = (i) => pad.l + (n > 1 ? i / (n - 1) : 0) * pw;
  ctx.font = '11px system-ui, sans-serif';
  // stacked shares of the classes
  const total = history[0].counts.reduce((a, b) => a + b, 0);
  let below = new Array(n).fill(0);
  for (let c = 0; c < CLASS_NAMES.length; c++) {
    ctx.fillStyle = CLASS_COLORS[c];
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(X(i), pad.t + ph * (1 - (below[i] + history[i].counts[c]) / total));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(i), pad.t + ph * (1 - below[i] / total));
    ctx.fill();
    below = below.map((b, i) => b + history[i].counts[c]);
  }
  ctx.globalAlpha = 1;
  // best score, right axis
  const top = niceStep(Math.max(referenceScore || 0, ...history.map((r) => r.best)) * 1.1 / 4) * 4;
  const Y = (v) => pad.t + ph * (1 - v / top);
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'left';
  for (let v = 0; v <= top + 1e-9; v += top / 4) ctx.fillText(String(+v.toFixed(1)), pad.l + pw + 4, Y(v) + 4);
  ctx.textAlign = 'right';
  ctx.fillText('100%', pad.l - 4, pad.t + 9);
  ctx.fillText('0', pad.l - 4, pad.t + ph);
  ctx.textAlign = 'center';
  ctx.fillText(`поколение ${n - 1}`, pad.l + pw / 2, h - 5);
  if (referenceScore) polyline(ctx, [[pad.l, Y(referenceScore)], [pad.l + pw, Y(referenceScore)]], COLORS.reference, 1, [5, 4]);
  polyline(ctx, history.map((r, i) => [X(i), Y(r.best)]), COLORS.now, 2);
}
