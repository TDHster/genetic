'use strict';
// DRAWING THE CLOCK, in the style of the video:
//   dark blue circles - gears (number = teeth), yellow lines - hands,
//   orange bracket - ratchet, white spiral - spring, blue disc - pendulum bob.
// Only the parts that matter are drawn (see buildDrawingTree in mechanism.js).
// Positions are computed once per clock, then the clock is animated in "clock time".

const layoutCache = new WeakMap();

// Area of a gear grows with its teeth, so radius ~ sqrt(teeth).
function gearRadius(teeth) {
  return 8 + 2.4 * Math.sqrt(teeth);
}

// Place gears: escape wheel at (0,0); a meshing gear goes next to its parent
// (we try 48 directions and take the one with the most free space);
// a gear on the same axle shares the parent's center.
function layoutClock(clock) {
  if (layoutCache.has(clock)) return layoutCache.get(clock);
  const { mech, genome } = clock;
  const tree = mech.drawing;
  const pos = new Map();
  const wheel = mech.moving.wheel;
  const pendLength = gearRadius(genome.teeth[wheel]) + 150;

  // Keep the pendulum's swing area and the ratchet above the wheel free.
  const blocked = [];
  for (let y = 0; y <= pendLength + 20; y += 18) blocked.push({ x: 0, y, r: 16 });
  const wheelR = gearRadius(genome.teeth[wheel]);
  blocked.push({ x: 0, y: -wheelR - 8, r: 30 });

  const placed = []; // circles of placed gears
  const anchorOf = (n) => {
    // A hand node: walk up to the gear it is attached to.
    while (n >= GEAR_COUNT) n = tree.parent.get(n).from;
    return n;
  };

  for (const n of tree.order) {
    if (n >= GEAR_COUNT) continue; // hands are drawn on their gear
    const r = gearRadius(genome.teeth[n]);
    const link = tree.parent.get(n);
    if (!link) { pos.set(n, { x: 0, y: 0, r }); placed.push(pos.get(n)); continue; }
    const from = pos.get(anchorOf(link.from));
    if (link.kind === 'axle') {
      pos.set(n, { x: from.x, y: from.y, r });
    } else {
      let best = null;
      for (let i = 0; i < 48; i++) {
        const a = -Math.PI / 2 + (i / 48) * 2 * Math.PI;
        const x = from.x + (from.r + r + 2) * Math.cos(a);
        const y = from.y + (from.r + r + 2) * Math.sin(a);
        let clearance = 60;
        for (const c of placed.concat(blocked)) {
          if (c.x === from.x && c.y === from.y) continue; // the parent's own axle
          clearance = Math.min(clearance, Math.hypot(c.x - x, c.y - y) - c.r - r);
        }
        if (!best || clearance > best.clearance + 1e-6) best = { x, y, clearance };
      }
      pos.set(n, { x: best.x, y: best.y, r });
    }
    placed.push(pos.get(n));
  }

  // A hand must stick out of the biggest gear on its axle.
  const axleRadius = (p) => Math.max(...[...pos.values()].filter((q) => q.x === p.x && q.y === p.y).map((q) => q.r));
  const hands = mech.hands.map((h, i) => {
    const gear = anchorOf(GEAR_COUNT + h.hand);
    return { ...h, gear, length: axleRadius(pos.get(gear)) + 18 + 10 * (i % 3) };
  });

  const layout = { pos, hands, pendLength, wheel };
  layoutCache.set(clock, layout);
  return layout;
}

// time: simulated seconds since the clock was "started".
function drawClock(ctx, clock, time, w, h) {
  ctx.save();
  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, w, h);

  if (!clock) { ctx.restore(); return; }
  const { mech, genome } = clock;

  if (!mech.moving) {
    if (mech.pendulums.length > 0) drawPendulumOnly(ctx, mech.pendulums[0], genome, time, w, h);
    else drawMessage(ctx, w, h, 'Пока ничего не работает: просто куча деталей.');
    ctx.restore();
    return;
  }

  const L = layoutClock(clock);
  const pend = mech.moving.pendulum;

  // Fit everything into the canvas.
  let minX = -40, maxX = 40, minY = -gearRadius(genome.teeth[L.wheel]) - 40, maxY = L.pendLength + 50;
  for (const p of L.pos.values()) {
    minX = Math.min(minX, p.x - p.r - 50); maxX = Math.max(maxX, p.x + p.r + 50);
    minY = Math.min(minY, p.y - p.r - 50); maxY = Math.max(maxY, p.y + p.r + 30);
  }
  const scale = Math.min(w / (maxX - minX), h / (maxY - minY), 1.6);
  ctx.translate(w / 2 - scale * (minX + maxX) / 2, h / 2 - scale * (minY + maxY) / 2);
  ctx.scale(scale, scale);

  // The escape wheel moves in jumps: one tooth per full swing of the pendulum.
  const ticks = Math.floor(time / pend.period);
  const frac = time / pend.period - ticks;
  const step = ticks + Math.min(1, frac / 0.08); // a quick jump at the start of each swing
  const wheelAngle = (2 * Math.PI * step) / genome.teeth[L.wheel];
  const angleOf = (n) => wheelAngle * mech.drawing.relSpeed(n);

  // Gears: bigger ones first, so gears on the same axle show as rings.
  const gears = [...L.pos.entries()].sort((a, b) => b[1].r - a[1].r);
  const stackIndex = new Map(); // how many gears already drawn on this axle
  for (const [n, p] of gears) {
    const key = p.x + ',' + p.y;
    const i = stackIndex.get(key) || 0;
    stackIndex.set(key, i + 1);
    drawGear(ctx, p, genome.teeth[n], angleOf(n), n === L.wheel, i);
  }

  // Spring on the driven gear.
  for (const g of mech.moving.driven) {
    const p = L.pos.get(g);
    if (p) drawSpring(ctx, p.x, p.y, Math.min(16, p.r * 0.55));
  }

  // Hands with their periods in red.
  ctx.lineCap = 'round';
  const labels = new Map();
  const axleTop = new Map(); // biggest radius on each axle
  for (const p of L.pos.values()) {
    const key = p.x + ',' + p.y;
    axleTop.set(key, Math.max(axleTop.get(key) || 0, p.r));
  }
  for (const hand of L.hands) {
    const p = L.pos.get(hand.gear);
    const a = angleOf(GEAR_COUNT + hand.hand) - Math.PI / 2;
    ctx.strokeStyle = '#ffe14a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + hand.length * Math.cos(a), p.y + hand.length * Math.sin(a));
    ctx.stroke();
    const key = p.x + ',' + p.y;
    const row = labels.get(key) || 0;
    labels.set(key, row + 1);
    ctx.fillStyle = '#ff4d4d';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(formatPeriod(hand.period), p.x, p.y - axleTop.get(key) - 34 - 15 * row);
  }

  // Pendulum + ratchet on top.
  const wheelR = L.pos.get(L.wheel).r;
  drawPendulum(ctx, 0, -wheelR - 10, L.pendLength + wheelR + 10, pend, time, true);
  ctx.restore();
}

// stackIndex: 0 for the biggest gear on an axle, 1 for the next one... (to spread the labels)
function drawGear(ctx, p, teeth, angle, isWheel, stackIndex) {
  ctx.fillStyle = '#0b1a4a';
  ctx.strokeStyle = isWheel ? '#9fb6ff' : '#d8e0ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  // Tooth marks so rotation is visible (at most 60 drawn).
  const marks = Math.min(teeth, 60);
  ctx.strokeStyle = 'rgba(216,224,255,0.45)';
  ctx.beginPath();
  for (let i = 0; i < marks; i++) {
    const a = angle + (i / marks) * 2 * Math.PI;
    ctx.moveTo(p.x + (p.r - 4) * Math.cos(a), p.y + (p.r - 4) * Math.sin(a));
    ctx.lineTo(p.x + p.r * Math.cos(a), p.y + p.r * Math.sin(a));
  }
  ctx.stroke();
  // A spoke, to see the rotation even with few teeth.
  ctx.strokeStyle = 'rgba(216,224,255,0.3)';
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + (p.r - 4) * Math.cos(angle), p.y + (p.r - 4) * Math.sin(angle));
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const la = Math.PI / 4 + stackIndex * 1.1;
  ctx.fillText(String(teeth), p.x + (p.r - 11) * Math.cos(la), p.y + (p.r - 11) * Math.sin(la) + 4);
}

function drawSpring(ctx, x, y, r) {
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let t = 0; t <= 1; t += 0.01) {
    const a = t * 3 * 2 * Math.PI;
    const rr = r * (0.2 + 0.8 * t);
    const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
    if (t === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawPendulum(ctx, px, py, length, pend, time, withRatchet) {
  const swing = 0.16 * Math.sin((2 * Math.PI * time) / pend.period);
  const bx = px + length * Math.sin(swing), by = py + length * Math.cos(swing);
  ctx.strokeStyle = '#ffe14a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.fillStyle = '#0a3aa8';
  ctx.strokeStyle = '#d8e0ff';
  ctx.beginPath();
  ctx.arc(bx, by, 16, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  // Ratchet (anchor) - rocks with the pendulum.
  if (withRatchet) drawRatchet(ctx, px, py, swing);
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(formatLength(pend.length), bx + 22, by - 2);
  ctx.fillText(pend.period.toFixed(4) + ' с', bx + 22, by + 14);
}

function drawRatchet(ctx, px, py, swing) {
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-swing);
  ctx.strokeStyle = '#ff9a1f';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-26, 22); ctx.lineTo(-16, 0); ctx.lineTo(16, 0); ctx.lineTo(26, 22);
  ctx.stroke();
  ctx.restore();
}

function drawPendulumOnly(ctx, pend, genome, time, w, h) {
  drawPendulum(ctx, w / 2, 40, h - 110, pend, time, false);
  drawMessage(ctx, w, h, 'Только маятник: он качается равномерно, но время надо считать самому.', h - 22);
}

function drawMessage(ctx, w, h, text, y) {
  ctx.fillStyle = '#9aa6c7';
  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, y || h / 2);
}

function formatPeriod(s) {
  if (s >= 1000) return Math.round(s * 1000) / 1000 >= 1e5 ? s.toFixed(0) : s.toFixed(3);
  return s.toFixed(s < 10 ? 4 : 3);
}
