'use strict';
// Drawing: the map with the road network, the population chart. Does not affect evolution.

const COLORS = {
  bg: '#05070f',
  grid: '#111a30',
  road: '#5b8def',
  city: '#f2f4fa',
  cityEdge: '#05070f',
  at120: '#3fbf5f',
  junction: '#f0c040',
  useless: '#6b7390',
  mst: '#b0b8d0',
  exact: '#f0c040',
  bound: '#ff6b5e',
  text: '#9aa6c7',
  unlinked: '#ff6b5e',
  crossroads: '#c9d6ff',
};

const CITY_RADIUS = 18; // px

// The world-to-canvas mapping for the map.
function mapView(w, h) {
  const pad = 16;
  const scale = Math.min((w - 2 * pad) / MAP_W, (h - 2 * pad) / MAP_H);
  const ox = (w - MAP_W * scale) / 2, oy = (h - MAP_H * scale) / 2;
  return { X: (x) => ox + x * scale, Y: (y) => oy + (MAP_H - y) * scale, scale, ox, oy };
}

// net: the network to show; showMst: draw the MST of the cities underneath, dashed.
function drawMap(ctx, net, w, h, showMst) {
  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const { X, Y, scale, ox, oy } = mapView(w, h);

  // A 10 km grid.
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  for (let x = 0; x <= MAP_W; x += 10) { ctx.moveTo(X(x), oy); ctx.lineTo(X(x), oy + MAP_H * scale); }
  for (let y = 0; y <= MAP_H; y += 10) { ctx.moveTo(ox, Y(y)); ctx.lineTo(ox + MAP_W * scale, Y(y)); }
  ctx.stroke();

  const segment = (a, b) => { ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(b.x), Y(b.y)); };
  if (showMst && net !== REFS.mst) {
    ctx.strokeStyle = COLORS.mst;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [i, j] of REFS.mst.edges) segment(CITIES[i], CITIES[j]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const nodes = net.nodes || CITIES;
  ctx.strokeStyle = COLORS.road;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [i, j] of net.edges) segment(nodes[i], nodes[j]);
  ctx.stroke();

  // Cities over the roads, junctions over the cities (a big city circle must not hide a junction next to it).
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.cityEdge;
  CITIES.forEach((c, i) => {
    // A city not connected to the main piece of the network: red (on an empty map with no roads yet all are white).
    ctx.fillStyle = net.linked && net.roadCount && !net.linked[i] ? COLORS.unlinked : COLORS.city;
    ctx.beginPath(); ctx.arc(X(c.x), Y(c.y), CITY_RADIUS, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  });

  // Junctions: green - three roads at 120°, yellow - a real junction but the angles are off, grey ring - useless.
  const stats = net.junctionInfo;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  // Crossroads (two roads crossing, not in the genome): a small light dot without a number.
  const ownCount = stats.filter((s) => !s.crossroads).length;
  stats.forEach((s, k) => {
    const x = X(s.p.x), y = Y(s.p.y);
    if (s.crossroads) {
      ctx.fillStyle = COLORS.crossroads;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI); ctx.fill();
      return;
    }
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
    if (s.useless) {
      ctx.strokeStyle = COLORS.useless; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.fillStyle = s.at120 ? COLORS.at120 : COLORS.junction; ctx.fill();
    }
    if (ownCount <= 25) {
      ctx.fillStyle = COLORS.text;
      ctx.fillText(String(k + 1), x + 6, y - 5);
    }
  });


  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(`дороги ${net.length.toFixed(1)} км` +
    (!net.connected ? ` · связано ${Math.round(net.share * 100)}% городов`
      : TASK.mode === 'routes' ? ` · средняя поездка ${net.trip.toFixed(1)} км · стоимость ${net.cost.toFixed(3)}` : ''), 10, 18);
  ctx.restore();
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// Class shares per generation (stacked), the best cost (white; = length unless the mode is 'routes') and the references (dashed).
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

  // Length axis (right): the gain over the MST is a few percent, so the axis spans only
  // from a bit below the best (or the exact answer) to a bit above the MST - at most 30% above,
  // longer networks (the random tangle at the start) are drawn at the top edge.
  // null = not all cities connected yet: nothing to draw.
  const mstL = refCost('mst');
  const lengths = history.map((r) => r.cost).filter((l) => l !== null);
  const lo = Math.min(...lengths, refCost('exact'), mstL) - 0.01 * mstL;
  const hi = Math.min(Math.max(mstL, ...lengths), 1.3 * mstL) + 0.01 * mstL;
  const sy = (l) => pad.t + ph * (1 - (Math.min(hi, l) - lo) / (hi - lo));

  ctx.font = '11px system-ui, sans-serif';
  ctx.setLineDash([6, 4]);
  for (const [key, color] of [['mst', COLORS.mst], ['exact', COLORS.exact]]) {
    if (!REFS[key]) continue;
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(pad.l, sy(REFS[key].cost)); ctx.lineTo(pad.l + pw, sy(REFS[key].cost)); ctx.stroke();
  }
  ctx.setLineDash([]);
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
  for (const f of [0, 0.5, 1]) ctx.fillText((lo + f * (hi - lo)).toFixed(TASK.mode === 'routes' ? 3 : 1) + (TASK.mode === 'routes' ? '' : ' км'), pad.l + pw + 4, pad.t + ph * (1 - f) + 4);
  ctx.textAlign = 'center';
  const gens = n - 1;
  const step = niceStep(gens / 5);
  for (let g = 0; g <= gens; g += step) ctx.fillText(String(g), pad.l + (g / gens) * pw, h - 6);
}
