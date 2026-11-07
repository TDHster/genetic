'use strict';
// AMBIENT: the natural background of the bedroom at night - for listening and for the pictures only.
// It does NOT enter the score: the standards rate the fan itself, not the fan in a particular room.
// But a background masks: in the rain a fan hum may drown, in a quiet night every tone is heard.
//
// Every background is a sum of parts with a spectrum level (dB per 1 Hz) at f:
//   broad part:  bandDensity(level, fp, f) - the same shape as the fan's broadband noise (acoustics.js);
//   narrow part: a bump `octaves` wide around fp (crickets sing near one pitch).
// `level` is the part's total sound pressure level, dB re 20 µPa. The sound synthesis (sound.js) plays the same parts,
// plus the texture the spectrum does not tell: raindrops, cricket chirps, slow swells of distant traffic.

// Levels are chosen for typical A-weighted values: quiet night ~22 dB(A), crickets ~29, city ~33, rain ~42.
const AMBIENTS = {
  none: { name: 'нет', parts: [] },
  night: {
    name: 'тихая ночь',
    parts: [{ level: 28, fp: 150 }, { level: 18, fp: 1200 }],
  },
  crickets: {
    name: 'сверчки за окном',
    parts: [{ level: 28, fp: 150 }, { level: 18, fp: 1200 }, { level: 28, fp: 4600, octaves: 0.15, crickets: true }],
  },
  rain: {
    name: 'дождь',
    parts: [{ level: 36, fp: 250 }, { level: 42, fp: 3000, drops: true }],
  },
  city: {
    name: 'ночной город',
    parts: [{ level: 42, fp: 90, swell: true }, { level: 30, fp: 800 }],
  },
};

// Spectrum level of one part at f (dB/Hz).
function ambientPartDensity(part, f) {
  if (!part.octaves) return bandDensity(part.level, part.fp, f);
  // a Gauss bump in log2(f) of width `octaves`; its integral over f is ≈ fp·octaves·ln2·√(2π)
  const x = Math.log2(f / part.fp) / part.octaves;
  const width = part.fp * part.octaves * Math.LN2 * Math.sqrt(2 * Math.PI);
  return part.level - 10 * Math.log10(width) - 10 * Math.LOG10E * (x * x / 2);
}

// Spectrum level of the whole background at f (dB/Hz); −Infinity for silence.
function ambientDensity(key, f) {
  const parts = AMBIENTS[key].parts;
  return parts.length ? powerSum(parts.map((p) => ambientPartDensity(p, f))) : -Infinity;
}

// A-weighted level of the background, dB(A).
function ambientLA(key) {
  if (!AMBIENTS[key].parts.length) return -Infinity;
  let sum = 0;
  for (let k = 1; k < FREQ_GRID.length; k++) {
    const f = Math.sqrt(FREQ_GRID[k] * FREQ_GRID[k - 1]), df = FREQ_GRID[k] - FREQ_GRID[k - 1];
    sum += Math.pow(10, (ambientDensity(key, f) + aWeight(f)) / 10) * df;
  }
  return 10 * Math.log10(sum);
}

// How the fan is heard against the background: { la (background dB(A)), over (fan dB(A) − background dB(A)),
// audibility (worst tone, ISO 1996-2, with the background added to the masking), tone (that tone) }.
function heardAgainst(cond, key) {
  const la = ambientLA(key);
  let worst = null, best = -Infinity;
  for (const t of cond.tones) {
    const band = criticalBand(t.f);
    const inBand = cond.tones.filter((o) => Math.abs(o.f - t.f) <= band / 2).map((o) => o.level);
    const masking = powerSum([broadbandDensity(cond, t.f) + 10 * Math.log10(band), hearingThreshold(t.f),
      ambientDensity(key, t.f) + 10 * Math.log10(band)]);
    const audibility = powerSum(inBand) - masking + 2 + Math.log10(1 + (t.f / 502) ** 2.5);
    if (audibility > best) { best = audibility; worst = t; }
  }
  return { la, over: cond.la - la, audibility: best, tone: worst };
}
