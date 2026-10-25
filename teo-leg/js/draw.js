'use strict';
// Drawing: the leg, the foot path, the population chart. Does not affect evolution.

const COLORS = {
  bg: '#05070f',
  bar: '#ffe14a',
  crank: '#ff9a1f',
  joint: '#ffffff',
  path: '#5b8def',
  contact: '#3fbf5f',
  jansen: 'rgba(240,192,64,0.7)',
  ground: '#6b7390',
  text: '#9aa6c7',
};

// The foot's position at every step (null where the leg falls apart).
function footPath(result) {
  return result.sim.poses.map((p) => (p && result.genome.foot >= 0 ? p[result.genome.foot] : null));
}

// All bars of a genome as [from, to] point indices, the crank first.
function legBars(genome) {
  const bars = [[0, 1]];
  genome.joints.forEach((j, k) => bars.push([j.a, FIXED_POINTS + k], [j.b, FIXED_POINTS + k]));
  return bars;
}

// angle: crank angle in radians. compare: another leg result whose foot path is drawn dashed.
function drawLeg(ctx, legResult, angle, w, h, compare) {
  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  if (!legResult) { ctx.restore(); return; }

  const { sim, genome, gait } = legResult;
  const used = sim.used;
  if (genome.foot < 0) {
    message(ctx, w, h, 'У этой ноги нет ни одного шарнира — нечем шагать.');
    ctx.restore();
    return;
  }
  const valid = sim.poses.filter(Boolean);
  if (!valid.length) {
    message(ctx, w, h, 'Эта нога не собирается ни при каком угле кривошипа.');
    ctx.restore();
    return;
  }

  // The comparison path is shifted so both legs stand on the same ground, with the
  // middle of their ground contact at the same x - then the shapes are easy to compare.
  const path = footPath(legResult);
  let comparePath = null;
  if (compare && compare.gait && gait) {
    const other = footPath(compare);
    const mid = (pts, contact) => {
      const xs = contact.map((s) => pts[s].x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const dx = mid(path, gait.contact) - mid(other, compare.gait.contact);
    const dy = gait.ground - compare.gait.ground;
    comparePath = other.map((p) => p && { x: p.x + dx, y: p.y + dy });
  }

  // Fit the points that matter (and the comparison path) into the canvas.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const extend = (p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); };
  for (const pose of valid) for (const i of used) extend(pose[i]);
  if (comparePath) for (const p of comparePath) if (p) extend(p);
  const pad = 30;
  const scale = Math.min((w - 2 * pad) / Math.max(1, maxX - minX), (h - 2 * pad - 20) / Math.max(1, maxY - minY));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // World y points up, canvas y points down.
  const X = (x) => w / 2 + (x - cx) * scale;
  const Y = (y) => h / 2 - 10 - (y - cy) * scale;

  // Ground line and foot path.
  if (gait) {
    ctx.strokeStyle = COLORS.ground;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Y(gait.ground) + 1); ctx.lineTo(w, Y(gait.ground) + 1);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (comparePath) drawFootPath(ctx, comparePath, X, Y, COLORS.jansen, [6, 4]);
  drawFootPath(ctx, path, X, Y, COLORS.path, []);
  if (gait) {
    ctx.strokeStyle = COLORS.contact;
    ctx.lineWidth = 4;
    ctx.beginPath();
    gait.contact.forEach((s, n) => {
      const g = path[s];
      if (n === 0) ctx.moveTo(X(g.x), Y(g.y)); else ctx.lineTo(X(g.x), Y(g.y));
    });
    ctx.stroke();
  }

  // The leg itself at the current crank angle (exact pose, not the nearest sample).
  const pose = legPose(genome, angle, used);
  if (!pose) {
    message(ctx, w, h - 30, 'При этом угле кривошипа нога разваливается (стержни не дотягиваются).');
    ctx.restore();
    return;
  }
  const bars = legBars(genome);
  const hasBar = new Set(bars.map(([a, b]) => Math.min(a, b) + ',' + Math.max(a, b)));
  const isUsed = (i) => used.has(i);

  // A joint hanging on two points that are themselves joined by a bar forms a rigid
  // triangle - a solid plate in a real Strandbeest. Shade those.
  ctx.fillStyle = 'rgba(255,225,74,0.12)';
  genome.joints.forEach((j, k) => {
    const i = FIXED_POINTS + k;
    if (!isUsed(i) || !hasBar.has(Math.min(j.a, j.b) + ',' + Math.max(j.a, j.b))) return;
    ctx.beginPath();
    [j.a, j.b, i].forEach((p, n) => (n ? ctx.lineTo : ctx.moveTo).call(ctx, X(pose[p].x), Y(pose[p].y)));
    ctx.fill();
  });

  // Bars: the crank is orange, bars that matter are yellow, unused ones are faint.
  ctx.lineCap = 'round';
  for (const [a, b] of bars) {
    if (!pose[a] || !pose[b]) continue;
    const crank = a === 0 && b === 1;
    const live = isUsed(a) && isUsed(b);
    ctx.strokeStyle = crank ? COLORS.crank : live ? COLORS.bar : 'rgba(255,225,74,0.18)';
    ctx.lineWidth = crank ? 5 : live ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(X(pose[a].x), Y(pose[a].y));
    ctx.lineTo(X(pose[b].x), Y(pose[b].y));
    ctx.stroke();
  }

  // Points with names. Fixed points (axle and frame) are orange.
  pose.forEach((p, i) => {
    if (!p || (i === 3 && !isUsed(3))) return;
    const fixed = i === 0 || i === 2 || i === 3;
    const live = isUsed(i) || i <= 1;
    ctx.globalAlpha = live ? 1 : 0.3;
    ctx.fillStyle = fixed ? COLORS.crank : COLORS.joint;
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), fixed ? 6 : 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(i === genome.foot ? `стопа (${pointName(i)})` : pointName(i), X(p.x) + 8, Y(p.y) - 6);
  });
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawFootPath(ctx, points, X, Y, color, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let pen = false;
  for (let s = 0; s <= points.length; s++) {
    const p = points[s % points.length];
    if (!p) { pen = false; continue; }
    if (pen) ctx.lineTo(X(p.x), Y(p.y)); else ctx.moveTo(X(p.x), Y(p.y));
    pen = true;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function message(ctx, w, h, text) {
  ctx.fillStyle = COLORS.text;
  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
  ctx.textAlign = 'left';
}

// Stacked area of classes per generation + best score line (right axis) + Jansen's level.
function drawPopulationChart(ctx, history, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const pad = { l: 34, r: 34, t: 8, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const n = history.length;
  if (n < 2) return;
  const maxScore = Math.max(JANSEN_SCORE, ...history.map((r) => r.best)) * 1.1;

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
  ctx.strokeStyle = COLORS.jansen;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l, sy(JANSEN_SCORE)); ctx.lineTo(pad.l + pw, sy(JANSEN_SCORE));
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
  ctx.fillStyle = COLORS.jansen;
  ctx.fillText('Янсен', pad.l + 4, sy(JANSEN_SCORE) - 4);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  const gens = n - 1;
  const step = niceStep(gens / 5);
  for (let g = 0; g <= gens; g += step) ctx.fillText(String(g), pad.l + (g / gens) * pw, h - 6);
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, x))));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

// ---- The whole walker ----
// LEGS copies of one leg on TWO crankshafts - front and rear, LEGS/2 legs on each - drawn
// in an oblique 3D view: x - walking direction, y - up, z - across the body.
// Phases: the front shaft has 0, 120, 240 degrees, the rear one 60, 180, 300, so the feet
// take turns between the front and the rear and the body is supported at both ends.
// The ground moves backwards at the walking speed, so the walker seems to walk.
// (This is only the picture: the score still uses the "LEGS legs, MIN_FEET on the ground" rule.)
const WALKER_VIEW = { depthX: Math.cos(Math.PI / 6), depthY: Math.sin(Math.PI / 6), depthScale: 0.6 };

function drawWalker(ctx, legResult, angle, w, h) {
  ctx.save();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  if (!legResult || !legResult.gait || !legResult.sim.complete) {
    message(ctx, w, h, 'Лучшая нога пула пока не шагает — зверя собрать не из чего.');
    ctx.restore();
    return;
  }
  const { sim, genome, gait } = legResult;
  const used = sim.used;
  const foot = genome.foot;

  // Size of one leg over the whole turn (points that matter only).
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of sim.poses) for (const i of used) {
    minX = Math.min(minX, p[i].x); maxX = Math.max(maxX, p[i].x); maxY = Math.max(maxY, p[i].y);
  }
  const legWidth = maxX - minX, ground = gait.ground;
  const perShaft = Math.max(1, Math.round(LEGS / 2));
  const spacing = Math.max(20, legWidth * 0.75); // distance between legs across the body
  const depth = spacing * (perShaft - 1);

  // The body travels against the stride; the front shaft is on that side.
  const direction = Math.sign(sim.poses[gait.contact[gait.contact.length - 1]][foot].x - sim.poses[gait.contact[0]][foot].x) || 1;
  const travel = gait.speed * angle / (2 * Math.PI);
  const shaftGap = legWidth * 1.15;
  const shafts = [
    { name: 'front', dx: -direction * shaftGap, phase: 0 },
    { name: 'rear', dx: 0, phase: Math.PI / perShaft },
  ];
  const sceneMinX = minX + Math.min(0, ...shafts.map((s) => s.dx)) - legWidth * 0.2;
  const sceneMaxX = maxX + Math.max(0, ...shafts.map((s) => s.dx)) + legWidth * 0.2;

  // Fit the scene.
  const sceneW = (sceneMaxX - sceneMinX) + depth * WALKER_VIEW.depthScale * WALKER_VIEW.depthX + 20;
  const sceneH = (maxY - ground) + depth * WALKER_VIEW.depthScale * WALKER_VIEW.depthY + 40;
  const scale = Math.min((w - 20) / sceneW, (h - 30) / sceneH);
  const ox = 10 - sceneMinX * scale;
  const oy = h - 10 - 20 * scale;
  const P = (x, y, z) => ({
    x: ox + (x + z * WALKER_VIEW.depthScale * WALKER_VIEW.depthX) * scale,
    y: oy - (y - ground + z * WALKER_VIEW.depthScale * WALKER_VIEW.depthY) * scale,
  });

  // Ground grid, scrolling with the travel.
  const step = 20;
  const shift = ((direction * travel) % step + step) % step;
  ctx.strokeStyle = 'rgba(107,115,144,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = sceneMinX - step + shift; x <= sceneMaxX; x += step) {
    const a = P(x, ground, -spacing), b = P(x, ground, depth + spacing);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  for (let z = -spacing; z <= depth + spacing; z += spacing / 2) {
    const a = P(sceneMinX, ground, z), b = P(sceneMaxX, ground, z);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // Poses of all legs: each shaft carries perShaft legs, phases 360/perShaft apart.
  const legs = [];
  for (const shaft of shafts) {
    for (let k = 0; k < perShaft; k++) {
      const pose = legPose(genome, angle + shaft.phase + (2 * Math.PI * k) / perShaft, used);
      if (pose) legs.push({ z: k * spacing, dx: shaft.dx, pose });
    }
  }
  const bars = legBars(genome).filter(([a, b]) => used.has(a) && used.has(b));

  // Far legs first, near legs last (painter's algorithm); far ones are dimmer.
  const drawLegAt = ({ z, dx, pose }) => {
    const fade = 0.45 + 0.55 * (1 - z / Math.max(1, depth));
    ctx.globalAlpha = fade;
    ctx.lineCap = 'round';
    for (const [a, b] of bars) {
      const crank = a === 0 && b === 1;
      const pa = P(pose[a].x + dx, pose[a].y, z), pb = P(pose[b].x + dx, pose[b].y, z);
      ctx.strokeStyle = crank ? COLORS.crank : COLORS.bar;
      ctx.lineWidth = crank ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    const f = pose[foot];
    const onGround = f.y <= ground + GROUND_TOLERANCE;
    // Shadow of the foot on the ground, then the foot.
    const sp = P(f.x + dx, ground, z);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(sp.x, sp.y, 5, 2, 0, 0, 2 * Math.PI); ctx.fill();
    const fp = P(f.x + dx, f.y, z);
    ctx.fillStyle = onGround ? COLORS.contact : COLORS.joint;
    ctx.beginPath(); ctx.arc(fp.x, fp.y, onGround ? 4 : 3, 0, 2 * Math.PI); ctx.fill();
  };
  legs.sort((a, b) => b.z - a.z).forEach(drawLegAt);
  ctx.globalAlpha = 1;

  // Shafts (orange - crankshafts, grey - frame axles) and the deck over both shafts.
  const fixed = [0, 2, 3].filter((i) => used.has(i));
  const pos = (i) => (i === 0 ? { x: 0, y: 0 } : genome.frame[i - 2]);
  ctx.lineWidth = 3;
  for (const shaft of shafts) {
    for (const i of fixed) {
      const a = P(pos(i).x + shaft.dx, pos(i).y, -10), b = P(pos(i).x + shaft.dx, pos(i).y, depth + 10);
      ctx.strokeStyle = i === 0 ? COLORS.crank : '#9aa6c7';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  const deckY = Math.max(...fixed.map((i) => pos(i).y)) + 8;
  const xs = [];
  for (const shaft of shafts) for (const i of fixed) xs.push(pos(i).x + shaft.dx);
  const x0 = Math.min(...xs) - 10, x1 = Math.max(...xs) + 10;
  const deck = [P(x0, deckY, -10), P(x1, deckY, -10), P(x1, deckY, depth + 10), P(x0, deckY, depth + 10)];
  ctx.fillStyle = 'rgba(91,141,239,0.18)';
  ctx.strokeStyle = 'rgba(91,141,239,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  deck.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath(); ctx.fill(); ctx.stroke();

  ctx.fillStyle = COLORS.text;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(`2 вала × ${perShaft} ноги · ${legResult.links} звеньев · ${gait.speed.toFixed(0)} см за оборот`, 10, 16);
  ctx.restore();
}
