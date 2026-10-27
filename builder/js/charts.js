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
    ctx.fillText(`${v}`, 4, y(v) + 4);
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

// The map of finds: a grid of cells (columns - base radius bins, rows - taper bins, the most tapered
// on top). archive: Map "i,j" -> individual. Returns a function (x, y) -> "i,j" for clicks.
export function drawMap(canvas, archive, baseBins, taperBins, selected) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cols = baseBins.length + 1, rows = taperBins.length + 1;
  const pad = { l: 54, r: 6, t: 6, b: 34 };
  const cw = (w - pad.l - pad.r) / cols, ch = (h - pad.t - pad.b) / rows;
  const edges = (b) => ['<' + b[0], ...b.slice(1).map((v, i) => `${b[i]}–${v}`), '>' + b[b.length - 1]];
  let maxScore = 0;
  for (const ind of archive.values()) maxScore = Math.max(maxScore, ind.result.score);

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = pad.l + i * cw, y = pad.t + j * ch;
      const ind = archive.get(`${i},${j}`);
      if (ind) {
        const t = maxScore > 0 ? ind.result.score / maxScore : 0;
        // From the panel colour to the accent (#ffb547) by score.
        ctx.fillStyle = `rgb(${Math.round(26 + t * 229)}, ${Math.round(34 + t * 147)}, ${Math.round(64 + t * 7)})`;
        ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        ctx.fillStyle = t > 0.6 ? '#1a1200' : '#dfe5f5';
        ctx.fillText(ind.result.height.toFixed(2), x + cw / 2, y + ch / 2);
      } else {
        ctx.strokeStyle = '#232c47';
        ctx.strokeRect(x + 1.5, y + 1.5, cw - 3, ch - 3);
      }
      if (selected === `${i},${j}`) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2);
        ctx.lineWidth = 1;
      }
    }
  }
  ctx.fillStyle = '#8d97b5';
  edges(baseBins).forEach((e, i) => ctx.fillText(e, pad.l + (i + 0.5) * cw, h - pad.b + 10));
  ctx.fillText('радиус основания, м', pad.l + (w - pad.l - pad.r) / 2, h - 8);
  ctx.textAlign = 'right';
  edges(taperBins).forEach((e, j) => ctx.fillText(e, pad.l - 6, pad.t + (j + 0.5) * ch));

  return (px, py) => {
    const i = Math.floor((px - pad.l) / cw), j = Math.floor((py - pad.t) / ch);
    return i >= 0 && i < cols && j >= 0 && j < rows ? `${i},${j}` : null;
  };
}
