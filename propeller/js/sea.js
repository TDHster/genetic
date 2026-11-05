'use strict';
// THE SEA MODE: is the propeller quieter than the sea?
//
// The ocean is never silent. Its background noise (spectrum level, dB re 1 µPa² per Hz) is the power sum of
// (Wenz curves in the approximations of Coates, as in Urick's "Principles of Underwater Sound"; f in kHz):
//   turbulence (below ~10 Hz)   17 − 30·lg f
//   distant shipping            40 + 20·(s − 0.5) + 26·lg f − 60·lg(f + 0.03),   s = shipping activity 0..1
//   wind and waves              50 + 7.5·√w + 20·lg f − 40·lg(f + 0.4),         w = wind speed, m/s
//   thermal noise (above ~50 kHz) −15 + 20·lg f
//
// A sonar listens from SONAR.lowest to SONAR.highest Hz in two ways:
//   - broadband: in third-octave bands the propeller (broadband + cavitation, spread over their spectra) is compared
//     with the sea in the same band;
//   - narrowband (LOFAR): every tone is a line - it is compared with the sea in a 1 Hz bin around it. A line stands
//     far above the sea in its bin: tones give the boat away first, even when the total level is low.
// The array and the processing add a gain against the sea. A towed line array of length L hears a sound wave well only
// when the wave is shorter than the array: gain(f) = 10·lg(1 + 2·L·f / c) + processing. At 5 Hz the wave is 300 m long -
// low tones are hard to hear (that is why towed arrays are so long). The propeller is heard from the distance where
// its sound, weakened by spherical spreading (20·lg r), falls to the sea noise in its most audible band or bin:
//   excess E = max (propeller − sea + gain), dB at 1 m;   heard from r = 10^(E / 20) m.
// No absorption, no sound channels, detection at 0 dB: the distances are only for comparing propellers.

const SEA_STATES = {
  calm: { name: 'тихое', wind: 2, shipping: 0.3 },
  moderate: { name: 'умеренное', wind: 7, shipping: 0.5 },
  rough: { name: 'свежее', wind: 15, shipping: 0.7 },
};
// A towed array of an anti-submarine ship: length (m), processing gain (dB), the band it listens in (Hz).
const SONAR = { arrayLength: 300, processing: 20, lowest: 1, highest: 10000 };
const sonarGain = (f) => 10 * Math.log10(1 + 2 * SONAR.arrayLength * f / WATER.sound) + SONAR.processing;

// Third-octave bands: centres 1000·2^(n/3) Hz from 1 Hz to 10 kHz, edges ×2^(±1/6).
const SEA_BANDS = [];
for (let n = -30; n <= 10; n++) {
  const fc = 1000 * Math.pow(2, n / 3);
  SEA_BANDS.push({ fc, lo: fc * Math.pow(2, -1 / 6), hi: fc * Math.pow(2, 1 / 6) });
}

const powerSum = (levels) => 10 * Math.log10(levels.reduce((s, l) => s + Math.pow(10, l / 10), 0));

// Spectrum level of the sea noise at f (Hz), dB re 1 µPa²/Hz.
function seaDensity(f, state) {
  const k = f / 1000, st = SEA_STATES[state] || SEA_STATES.moderate;
  return powerSum([
    17 - 30 * Math.log10(k),
    40 + 20 * (st.shipping - 0.5) + 26 * Math.log10(k) - 60 * Math.log10(k + 0.03),
    50 + 7.5 * Math.sqrt(st.wind) + 20 * Math.log10(k) - 40 * Math.log10(k + 0.4),
    -15 + 20 * Math.log10(k),
  ]);
}

// Power (as a level, dB) of a spectrum density(f) over the band lo..hi: 8 log-spaced steps.
function bandLevel(density, lo, hi) {
  const N = 8, r = Math.pow(hi / lo, 1 / N);
  let p = 0;
  for (let i = 0; i < N; i++) {
    const f0 = lo * Math.pow(r, i), f1 = f0 * r;
    p += Math.pow(10, density(Math.sqrt(f0 * f1)) / 10) * (f1 - f0);
  }
  return 10 * Math.log10(p);
}

// How well the sonar hears the propeller against the sea. prep = prepareNoise(...), cond = noiseAt(prep, V, depth).
// Returns { excess (dB at 1 m), range (m), worst: { kind: 'tone'|'band', f, over (dB above the sea, with the gain) },
//           bands: [{ fc, prop, sea }], tones: [{ f, level, sea }] }.
function seaDetection(prep, cond, state) {
  const fp = broadbandPeak(prep, cond.V);
  const bands = SEA_BANDS.map((b) => {
    const parts = [bandLevel((f) => bandDensity(cond.broadband, fp, f), b.lo, b.hi)];
    if (cond.extent > 0) parts.push(bandLevel((f) => bandDensity(cond.cavitation, CAVITATION_PEAK, f), b.lo, b.hi));
    return { fc: b.fc, prop: powerSum(parts), sea: bandLevel((f) => seaDensity(f, state), b.lo, b.hi) };
  });
  const tones = cond.tones.filter((t) => t.f >= SONAR.lowest && t.f <= SONAR.highest)
    .map((t) => ({ f: t.f, level: t.level, sea: seaDensity(t.f, state) }));
  let worst = { kind: 'band', f: bands[0].fc, over: -Infinity };
  for (const b of bands) {
    const over = b.prop - b.sea + sonarGain(b.fc);
    if (over > worst.over) worst = { kind: 'band', f: b.fc, over };
  }
  for (const t of tones) {
    const over = t.level - t.sea + sonarGain(t.f);
    if (over > worst.over) worst = { kind: 'tone', f: t.f, over };
  }
  const excess = worst.over;
  return { excess, range: Math.pow(10, excess / 20), worst, bands, tones };
}
