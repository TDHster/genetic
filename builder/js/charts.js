// Chart of the best and median height per generation (canvas 2D).

const COLORS = { best: '#ffb547', median: '#5b8def', grid: '#232c47', text: '#8d97b5' };

export function drawHistory(canvas, history) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const maxY = Math.max(0.5, ...history.map((r) => r.best)) * 1.1;
  const maxX = Math.max(10, history.length - 1);
  const x = (i) => pad.l + pw * i / maxX;
  const y = (v) => pad.t + ph * (1 - v / maxY);

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const stepY = maxY > 4 ? 1 : 0.5;
  for (let v = 0; v <= maxY; v += stepY) {
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
    ctx.fillText(`${v} м`, 4, y(v) + 4);
  }
  ctx.fillText('0', pad.l, h - 6);
  ctx.textAlign = 'right';
  ctx.fillText(`поколение ${maxX}`, w - pad.r, h - 6);
  ctx.textAlign = 'left';

  for (const key of ['median', 'best']) {
    ctx.strokeStyle = COLORS[key];
    ctx.lineWidth = key === 'best' ? 2 : 1.5;
    ctx.beginPath();
    history.forEach((r, i) => (i ? ctx.lineTo(x(i), y(r[key])) : ctx.moveTo(x(i), y(r[key]))));
    ctx.stroke();
  }
}

// Silhouette: radius of the structure in height bands, drawn as mirrored bars (top band on top).
export function drawProfile(canvas, profile, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!profile || !height) return;
  const maxR = Math.max(0.3, ...profile);
  // Same scale on both axes, so a cone looks like a cone.
  const scale = Math.min((w / 2 - 4) / maxR, (h - 4) / height);
  const bandH = height / profile.length;
  ctx.fillStyle = 'rgba(200, 160, 115, 0.85)';
  profile.forEach((r, i) => {
    const top = h - 2 - (i + 1) * bandH * scale;
    ctx.fillRect(w / 2 - r * scale, top + 1, 2 * r * scale, bandH * scale - 2);
  });
}
