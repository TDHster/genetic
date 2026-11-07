'use strict';
// AMBIENT: the natural background of the bedroom at night - for listening, for the pictures, and for the second goal
// of fitness.js ("inaudible breeze": the strongest breeze that is not heard against the background).
// The first goal does NOT use it: the standards rate the fan itself, not the fan in a particular room.
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

// ---- "Inaudible breeze" (the second goal of fitness.js) ----

// What masks a sound at f in one critical band of the ear: the background in that band or the threshold of hearing,
// whichever is louder (dB). Background 'none' - only the threshold: a really silent room.
function maskingAt(key, f) {
  const band = 10 * Math.log10(criticalBand(f));
  return powerSum([ambientDensity(key, f) + band, hearingThreshold(f)]);
}

// How far the fan sticks out of the background, dB (≤ 0: it is not heard):
//   - the broadband noise in every critical band against the masking in that band;
//   - every tone (with the tones of its band) by the ISO 1996-2 audibility against the same masking.
// cond: noiseAt(...) or the lighter sourcesAt(...).
const MASK_CACHE = {};   // masking minus the band width on FREQ_GRID, per background
function audibleExcess(cond, key) {
  if (!MASK_CACHE[key]) MASK_CACHE[key] = FREQ_GRID.map((f) => maskingAt(key, f) - 10 * Math.log10(criticalBand(f)));
  const mask = MASK_CACHE[key];
  let worst = -Infinity;
  for (let k = 0; k < FREQ_GRID.length; k++) worst = Math.max(worst, broadbandDensity(cond, FREQ_GRID[k]) - mask[k]);
  for (const t of cond.tones) {
    const band = criticalBand(t.f);
    let sum = 0;
    for (const o of cond.tones) if (Math.abs(o.f - t.f) <= band / 2) sum += Math.pow(10, o.level / 10);
    worst = Math.max(worst, 10 * Math.log10(sum) - maskingAt(key, t.f) + 2 + Math.log10(1 + (t.f / 502) ** 2.5));
  }
  return worst;
}

// The fastest speed (as a scale s of the turn rate of prep) at which the fan is not heard against the background:
// audibleExcess(noiseAt(prep, s)) = 0, by bisection on a log scale (every source only grows with s).
const QUIET_SCALE = [0.02, 2];
function quietestScale(prep, key) {
  const excess = (s) => audibleExcess(sourcesAt(prep, s), key);   // the sources are enough: no dB(A) needed
  if (excess(QUIET_SCALE[1]) <= 0) return QUIET_SCALE[1];
  if (excess(QUIET_SCALE[0]) > 0) return QUIET_SCALE[0];
  let lo = Math.log(QUIET_SCALE[0]), hi = Math.log(QUIET_SCALE[1]);
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (excess(Math.exp(mid)) > 0) hi = mid; else lo = mid;
  }
  return Math.exp(lo);  // the lower end: never a hair above the background
}
