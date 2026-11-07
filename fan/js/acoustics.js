'use strict';
// ACOUSTICS: what the person in bed hears from the fan, and how much it bothers them.
// Sound pressure levels in dB re 20 µPa at FAN.listener metres.
//
// 1. TONES. Every blade crosses the wake strips of the spokes and the pole; its push jumps each time. One blade alone
//    pulses at all harmonics m of the turn rate n, as strong as the inflow harmonic m (room.js) × the response of the
//    blade (aero.js) × the Sears function: a wide blade feels a quick change only on average (|S| = 1 / √(1 + 2πk),
//    k = m·Ω·c / 2W). SWEEP: a section swept back by ψ meets a strip later - its force comes with the phase m·ψ, and the
//    strips of a strongly swept blade cancel.
//    ALL BLADES. Blade j stands at the angle θ_j: its force at the harmonic h comes with the phase h·θ_j. The fan as a whole
//    pushes the air at the frequency h·n with the force of one blade × |Σ_j e^(i·h·θ_j)|.
//      - evenly spaced Z blades: the sum is Z for h = Z, 2Z, 3Z... and exactly 0 for every other h. All the energy goes
//        into the "blade passing frequency" Z·n and its multiples - the hum;
//      - unevenly spaced blades: the sum is smaller at h = kZ and not zero elsewhere - the hum is broken into many
//        weaker tones at all the multiples of n.
//    A force on the air pulsing at f radiates like a small dipole: p = F·f / (2·c·r) (c - speed of sound, r - distance).
//    The force along the rotation of a blade turns with it: summed over the blades the inflow harmonics h ± 1 give a
//    sideways force at h·n, with the same blade sum.
// 2. BROADBAND (trailing edge noise, after Brooks, Pope & Marcolini). The turbulent boundary layer leaves the trailing
//    edge and hisses. Its power ∝ δ*·M⁵·span (δ* - boundary layer displacement thickness, M = W / c - Mach number at the
//    blade): it grows as the FIFTH power of the blade speed, so a large slow fan is much quieter than a small fast one.
// 3. TURBULENT INFLOW (leading edge noise, after Amiet). The air behind the guard and the motor is turbulent; every
//    eddy that hits a leading edge gives the blade a little knock. Power ∝ span·c·M³·Tu² (Tu - turbulence intensity,
//    eddies of size Λ): a low rumble with its peak near W / (2πΛ)·4, a few hundred hertz. It grows as the CUBE of the
//    blade speed, slower than the trailing edge hiss. Fan noise below ~500 Hz is mostly this; it also masks the hum.
// 4. STALL. Where the angle of attack goes past the stall (at the hub, or every turn in the pole wake) the air leaves
//    the blade; the separated layer is ~30 times thicker and roars lower and louder. Same formula with δ_sep = 0.15·c.
//
// WHAT BOTHERS A PERSON (psychoacoustics, simplified from the standards):
//   - A-weighted level L_A: the ear is deaf to low notes (−30 dB at 50 Hz, −16 at 100 Hz, 0 at 1 kHz);
//   - a tone is far more annoying than a hiss of the same level. ISO 1996-2 (annex C): the tones within one critical band
//     of the ear (≈ 100 Hz wide below 500 Hz, ≈ 20% of f above) add up; their audibility is ΔL = tone − masking noise
//     in that band + 2 + lg(1 + (f/502)^2.5). The masking is the fan's own broadband noise or the threshold of hearing,
//     whichever is louder. The penalty K_T grows from 0 at ΔL = 4 dB to 6 dB at ΔL = 10 dB (smoothed here);
//   - the rating level L_R = L_A + K_T (dB(A)) - what fitness.js minimises.

const NOISE = {
  bpm: 147,                // dB: calibration of the broadband noise, 10·lg(δ*·M⁵·span / r²) + this. Pure BPM gives
                           // ~128; household fans measure louder (turbulent inflow, tip gap, guard) - fitted to them
  inflow: 122,             // dB: calibration of the leading edge noise, 10·lg(c·M³·span·Tu² / r²) + this
  turbulence: 0.08,        // turbulence intensity of the air behind the guard and the motor
  eddy: 0.02,              // m: eddy size
  stallThickness: 0.15,    // separated layer thickness / chord: stalled flow roars ~15 dB louder
  positions: 72,           // positions round the disc for the stall check
  lowest: 20,              // Hz: lower limit of hearing taken into account
  highest: 16000,
  quietest: -20,           // dB: quieter tones are dropped
};

const sears = (k) => 1 / Math.sqrt(1 + 2 * Math.PI * k);
const pressureLevel = (p) => 20 * Math.log10(Math.max(1e-30, p) / 2e-5);
const powerSum = (list) => 10 * Math.log10(list.reduce((s, l) => s + Math.pow(10, l / 10), 0) || 1e-30);

// A-weighting (IEC 61672), dB.
function aWeight(f) {
  const f2 = f * f;
  const ra = 12194 ** 2 * f2 * f2 / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
}
// Threshold of hearing (Terhardt), dB SPL.
function hearingThreshold(f) {
  const k = f / 1000;
  return 3.64 * Math.pow(k, -0.8) - 6.5 * Math.exp(-0.6 * (k - 3.3) ** 2) + 1e-3 * k ** 4;
}
// Width of the critical band of the ear around f (Zwicker), Hz.
function criticalBand(f) {
  return 25 + 75 * Math.pow(1 + 1.4 * (f / 1000) ** 2, 0.69);
}
// Tone penalty K_T (dB) from the audibility ΔL: ISO 1996-2 gives 0 below 4 dB, ΔL − 4 up to 10 dB, then 6.
// Smoothed (tanh) so that evolution feels a slope everywhere.
function tonePenalty(audibility) {
  return 3 * (1 + Math.tanh((audibility - 7) / 2.2));
}

// SPECTRUM SHAPE: a broadband level L (dB) spread over frequencies around fp: spectrum level (dB per 1 Hz) at f.
// Shape 2u / (1 + u²)², u = f / fp: its integral over f is fp, so it adds up to L.
function bandDensity(level, fp, f) {
  const u = f / fp;
  return level - 10 * Math.log10(fp) + 10 * Math.log10(2 * u / (1 + u * u) ** 2);
}

// The blade sum |Σ_j e^(i·h·θ_j)| for the angles of the blades.
function bladeSum(angles, h) {
  let re = 0, im = 0;
  for (const t of angles) { re += Math.cos(h * t); im += Math.sin(h * t); }
  return Math.hypot(re, im);
}

// Everything about the noise that does not depend on the speed setting: computed once at FAN.rpm.
// op = fanForces(g, n, true).
function prepareNoise(g, op) {
  const Z = g.blades, omega = 2 * Math.PI * op.n, H = INFLOW.harmonics - 1;
  const { angles } = bladeAngles(g);
  // Force of ONE blade at the inflow harmonic m (N): a sum over the strips with the sweep phase m·ψ.
  const oneBlade = (m, perSlow) => {
    if (m < 1) return 0;
    let re = 0, im = 0;
    for (const e of op.elements) {
      const amp = perSlow(e) / Z * inflowHarmonic(m, e.r) * e.w * sears(m * omega * e.c / (2 * e.W)) * e.dr;
      re += amp * Math.cos(m * e.sweep);
      im -= amp * Math.sin(m * e.sweep);
    }
    return Math.hypot(re, im);
  };
  const axial = [], side = [];
  for (let m = 0; m <= H + 1; m++) { axial.push(oneBlade(m, (e) => e.thrustPerSlow)); side.push(oneBlade(m, (e) => e.sidePerSlow)); }
  const tones = [];
  for (let h = 1; h <= H; h++) {
    const blade = Math.hypot(axial[h], Math.hypot(side[h - 1], side[h + 1]) / 2);
    const sum = bladeSum(angles, h);
    tones.push({ h, blade, sum, force: blade * sum, even: blade * (h % Z === 0 ? Z : 0) });
  }
  // Angle of attack of every strip round the disc; stalled share; broadband sources.
  const P = NOISE.positions, c0 = AIR.sound;
  let te = 0, stall = 0, le = 0, teFreq = 0, stallFreq = 0, leFreq = 0, stalledShare = 0, span = 0;
  const strips = op.elements.map((e) => {
    const alpha = [];
    const [down, up] = stallAngles(e.f, e.re);
    let stalledHere = 0, pastSum = 0;
    for (let p = 0; p < P; p++) {
      const a = e.alpha + e.alphaPerSlow * e.w * inflowDeficit(2 * Math.PI * p / P, e.r, e.c);
      alpha.push(a);
      const past = a > up ? a - up : a < down ? down - a : 0;
      if (past > 0) { stalledHere++; pastSum += past; }
    }
    const share = stalledHere / P;
    const M5 = (e.W / c0) ** 5;
    // displacement thickness at the trailing edge: turbulent plate 0.047·c·Re^−0.2, thicker on a loaded bent plate
    const delta = 0.047 * e.c * Math.pow(e.re, -0.2) * (1 + 2 * Math.abs(e.cl));
    const deltaSep = NOISE.stallThickness * e.c * (1 + (share > 0 ? 4 * pastSum / stalledHere : 0));
    const pTe = Z * delta * M5 * e.dr * (1 - share), pSt = Z * deltaSep * M5 * e.dr * share;
    const pLe = Z * e.c * (e.W / c0) ** 3 * NOISE.turbulence ** 2 * e.dr;
    te += pTe; stall += pSt; le += pLe;
    leFreq += pLe * 4 * e.W / (2 * Math.PI * NOISE.eddy);
    // peak frequencies (BPM: Strouhal f·δ*/W = 0.02·M^−0.6), averaged by power
    teFreq += pTe * 0.02 * Math.pow(e.W / c0, -0.6) * e.W / delta;
    stallFreq += pSt * 0.02 * Math.pow(e.W / c0, -0.6) * e.W / deltaSep;
    stalledShare += share * e.dr;
    span += e.dr;
    return { x: e.x, r: e.r, c: e.c, W: e.W, dr: e.dr, alpha, share, stallUp: up, stallDown: down };
  });
  return {
    n: op.n, Z, tones, strips,
    te, teFreq: te > 0 ? teFreq / te : 1000, stall, stallFreq: stall > 0 ? stallFreq / stall : 300,
    le, leFreq: le > 0 ? leFreq / le : 300,
    stalledShare: stalledShare / span,
  };
}

// Broadband spectrum level (dB/Hz) at f of a noise state (noiseAt).
function broadbandDensity(cond, f) {
  const parts = [bandDensity(cond.te, cond.teFreq, f), bandDensity(cond.le, cond.leFreq, f)];
  if (cond.stall > -Infinity) parts.push(bandDensity(cond.stall, cond.stallFreq, f));
  return powerSum(parts);
}

const FREQ_GRID = (() => {
  const list = [], N = 90;
  for (let k = 0; k <= N; k++) list.push(NOISE.lowest * (NOISE.highest / NOISE.lowest) ** (k / N));
  return list;
})();

// The noise at the speed scale s (turn rate / FAN.rpm: the speed settings): every speed and force scales with it,
// tones as s³ in pressure (60·lg s), the trailing edge and stall as s^2.5 (50·lg s), the leading edge as s^1.5 (30·lg s),
// frequencies as s.
function noiseAt(prep, s) {
  const n = prep.n * s, r = FAN.listener, c0 = AIR.sound;
  const level = (F, f) => pressureLevel(F * s * s / Math.SQRT2 * f / (2 * c0 * r));
  const tones = [];
  for (const t of prep.tones) {
    const f = t.h * n;
    if (f < NOISE.lowest || f > NOISE.highest) continue;
    const L = level(t.force, f);
    if (L < NOISE.quietest) continue;  // numerically zero (an even blade sum)
    tones.push({ h: t.h, f, level: L, even: t.even > 0 ? level(t.even, f) : -Infinity, sum: t.sum });
  }
  const bb = (power) => (power > 0 ? 10 * Math.log10(power * s ** 5 / (r * r)) + NOISE.bpm : -Infinity);
  const cond = {
    s, n, tones, te: bb(prep.te), teFreq: prep.teFreq * s, stall: bb(prep.stall), stallFreq: prep.stallFreq * s,
    le: 10 * Math.log10(prep.le * s ** 3 / (r * r)) + NOISE.inflow, leFreq: prep.leFreq * s,
  };
  // A-weighted levels: the tones one by one, the broadband integrated over the frequency grid
  cond.laTones = powerSum(tones.map((t) => t.level + aWeight(t.f)));
  let bbA = 0, bbLin = 0, stallA = 0;
  for (let k = 1; k < FREQ_GRID.length; k++) {
    const f = Math.sqrt(FREQ_GRID[k] * FREQ_GRID[k - 1]), df = FREQ_GRID[k] - FREQ_GRID[k - 1];
    const d = broadbandDensity(cond, f);
    bbA += Math.pow(10, (d + aWeight(f)) / 10) * df;
    bbLin += Math.pow(10, d / 10) * df;
    if (cond.stall > -Infinity) stallA += Math.pow(10, (bandDensity(cond.stall, cond.stallFreq, f) + aWeight(f)) / 10) * df;
  }
  cond.laBroadband = 10 * Math.log10(bbA || 1e-30);
  cond.laStall = 10 * Math.log10(stallA || 1e-30);
  cond.broadband = 10 * Math.log10(bbLin || 1e-30);
  cond.la = powerSum([cond.laTones, cond.laBroadband]);
  // everything but the stall (A-weighted): to tell how much of the noise is the stall roar
  cond.laRest = 10 * Math.log10(Math.max(1e-30, Math.pow(10, cond.la / 10) - stallA));
  cond.total = powerSum([...tones.map((t) => t.level), cond.broadband]);
  // tone audibility: tones within one critical band add up, against the masking noise in that band
  let worst = null;
  for (const t of tones) {
    const band = criticalBand(t.f);
    const inBand = tones.filter((o) => Math.abs(o.f - t.f) <= band / 2).map((o) => o.level);
    const masking = powerSum([broadbandDensity(cond, t.f) + 10 * Math.log10(band), hearingThreshold(t.f)]);
    t.audibility = powerSum(inBand) - masking + 2 + Math.log10(1 + (t.f / 502) ** 2.5);
    if (!worst || t.audibility > worst.audibility) worst = t;
  }
  cond.worst = worst;
  cond.audibility = worst ? worst.audibility : -Infinity;
  cond.kt = worst ? tonePenalty(worst.audibility) : 0;
  cond.rating = cond.la + cond.kt;
  return cond;
}
