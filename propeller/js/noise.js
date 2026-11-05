'use strict';
// NOISE: what a sonar hears from the propeller. Three sources, levels in dB re 1 µPa at 1 m (source level):
//
// 1. TONES (blade rate). Every blade crosses the fin wakes several times per turn; its lift jumps a little each time.
//    Of all wake harmonics only m = Z, 2Z, 3Z... add up over the Z blades (the others cancel): a thrust force that
//    pulses at the frequency k·Z·n. For one strip of the blade the jump of the angle of attack is
//      δα = a_m · V · cos φ / W  (a_m - wake harmonic, V - boat speed, W - water speed at the blade),
//    the jump of the thrust is 0.5ρW²c · CLα · δα · cos φ · S(k) · F, where S is the Sears function: a wide blade
//    feels a quick wake change only on average (|S| = 1 / √(1 + 2πk), k = m·Ω·c / 2W) and F - the Prandtl tip factor.
//    SKEW: a section skewed back by the angle ψ meets the wake later: its force comes with the phase m·ψ.
//    The force of the whole blade is the sum of the strips with their phases - with a strong skew they cancel.
//    SIDEWAYS: the force along the rotation of a blade turns with the blade; summed over the blades the harmonics
//    m = kZ − 1 and kZ + 1 give a force across the shaft (on the bearing) at the same frequency k·Z·n.
//    For an odd Z one of kZ ± 1 is even - with four fins, often a strong fin harmonic (7 blades: 8).
//    The pulsing forces radiate like small dipoles: p = F·f / (2c) at 1 m (c - speed of sound).
// 2. BROADBAND (trailing edge noise). Turbulence of the boundary layer leaves the trailing edge and hums.
//    Its power grows as W⁵ (fifth power of the water speed at the blade!) × the boundary layer thickness × span.
//    A large, slowly turning propeller is quieter.
// 3. CAVITATION. If the pressure on a blade falls below the vapour pressure, water boils; the bubbles collapse
//    with a crackle that is heard from far away. Cavitation number σ = (p_static − p_vapour) / (0.5ρW²).
//    A section cavitates where its suction −Cp_min > σ - checked at 24 positions round the disc (the top is the
//    shallowest, the fin wakes change the angle of attack). The tip vortex cavitates when
//    σ < 0.068 · CL² · Re^0.35 (McCormick). Level = CAVITATION_LEVEL + 10·lg(extent of cavitation).
//
// The propeller loads stay the same at one J (hydro.js), so all three sources can be scaled to any speed:
// tones grow as V³ in pressure (60 lg V), broadband as V^2.5 (50 lg V), cavitation starts at the
// cavitation inception speed and then grows very fast.

const NOISE = {
  positions: 24,           // positions round the disc for cavitation
  maxTone: 6,              // tones k·Z·n, k = 1..6 (or while k·Z ≤ WAKE.harmonics)
  broadbandLevel: 76,      // dB: calibration of the trailing edge noise
  cavitationLevel: 160,    // dB at the cavitation extent 1
  tipVortex: 0.068,        // McCormick's constant
  tipAt: 0.9,              // the tip vortex is fed by the load near this radius
  tipWeight: 0.05,         // extent of a fully cavitating tip vortex (share of a blade)
};

// SPECTRUM SHAPE (for the pictures, the sound and the sea mode):
// a broadband level L (dB) spread over frequencies around fp: spectrum level (dB per 1 Hz) at f.
// Shape 2u / (1 + u²)², u = f / fp: its integral over f is fp, so the band levels add up to L.
function bandDensity(level, fp, f) {
  const u = f / fp;
  return level - 10 * Math.log10(fp) + 10 * Math.log10(2 * u / (1 + u * u) ** 2);
}

// Peak frequency of the trailing edge noise at the boat speed V: f ≈ 0.1·W / δ at 3/4 of the radius.
function broadbandPeak(prep, V) {
  const s = prep.strips.reduce((b, e) => (Math.abs(e.x - 0.75) < Math.abs(b.x - 0.75) ? e : b));
  return 0.1 * s.w * (V / prep.V) / s.delta;
}

const CAVITATION_PEAK = 1500; // Hz: collapsing bubbles crackle around here

const sears = (k) => 1 / Math.sqrt(1 + 2 * Math.PI * k);
const decibel = (p) => 20 * Math.log10(Math.max(1e-30, p) / 1e-6);
const sumDecibels = (list) => 10 * Math.log10(list.reduce((s, l) => s + Math.pow(10, l / 10), 0) || 1e-30);

// Everything about the noise that does not depend on the speed and the depth: computed once at the working point.
// op = propellerForces(..., keep) at the working J.
function prepareNoise(g, op) {
  const Z = g.blades, omega = 2 * Math.PI * op.n, V = op.V, D = propDiameter(g);
  const rho = WATER.rho;
  // A sum over the strips of (force per slower water) × wake harmonic m × Sears, with the skew phase m·ψ.
  // Returns [with skew, without skew] amplitudes (N).
  const harmonicForce = (m, perSlow) => {
    let re = 0, im = 0, plain = 0;
    if (m < 1) return [0, 0];
    for (const e of op.elements) {
      const amp = perSlow(e) * wakeHarmonic(m, e.r, g) * V * sears(m * omega * e.c / (2 * e.w)) * e.dr;
      re += amp * Math.cos(m * e.skew);
      im -= amp * Math.sin(m * e.skew);
      plain += amp;
    }
    return [Math.hypot(re, im), Math.abs(plain)];
  };
  const tones = [];
  for (let k = 1; k <= NOISE.maxTone && k * Z + 1 <= WAKE.harmonics; k++) {
    const m = k * Z;
    const axial = harmonicForce(m, (e) => e.thrustPerSlow);
    // The force along the rotation of every blade turns with the blade: summed over the blades it gives a sideways
    // force on the shaft bearing from the harmonics m ± 1 (half of each).
    const lo = harmonicForce(m - 1, (e) => e.sidePerSlow), hi = harmonicForce(m + 1, (e) => e.sidePerSlow);
    const side = Math.hypot(lo[0], hi[0]) / 2, sideNoSkew = Math.hypot(lo[1], hi[1]) / 2;
    // force amplitude (N) at op.V; noSkew - the same without skew (to show what skew gives)
    tones.push({ k, m, axial: axial[0], side, force: Math.hypot(axial[0], side), noSkew: Math.hypot(axial[1], sideNoSkew) });
  }
  // Angle of attack of every strip round the disc (wake harmonics, smoothed by the Sears function).
  const P = NOISE.positions;
  const strips = op.elements.map((e) => {
    const alpha = [], suction = [];
    const h = [];
    for (let m = 1; m <= WAKE.harmonics; m++) h.push(wakeHarmonic(m, e.r, g) * sears(m * omega * e.c / (2 * e.w)));
    for (let p = 0; p < P; p++) {
      const theta = 2 * Math.PI * p / P;
      let dw = 0;
      for (let m = 1; m <= h.length; m++) dw += h[m - 1] * Math.cos(m * theta);
      const a = e.alpha + e.alphaPerSlow * dw * V;
      alpha.push(a);
      suction.push(suctionPeak(a, e.f, e.tau));
    }
    const delta = 0.047 * e.c * Math.pow(e.re, -0.2) * (1 + 2 * Math.abs(e.cl));  // boundary layer at the trailing edge
    return { r: e.r, x: e.x, w: e.w, c: e.c, dr: e.dr, re: e.re, alpha, suction, delta, pressureGain: e.pressureGain };
  });
  const broadband = strips.reduce((s, e) => s + Z * e.w ** 5 * e.delta * e.dr, 0);
  // The tip vortex: lift of the strip nearest NOISE.tipAt at every position.
  const tip = op.elements.reduce((best, e) => (Math.abs(e.x - NOISE.tipAt) < Math.abs(best.x - NOISE.tipAt) ? e : best));
  const tipStrip = strips[op.elements.indexOf(tip)];
  const tipCl = tipStrip.alpha.map((a) => HYDRO.liftSlope * (Math.max(-HYDRO.stall, Math.min(HYDRO.stall, a)) + 2 * tip.f));
  const tipFactor = g.duct ? DUCT.tipVortex : 1;
  return {
    V, n: op.n, D, Z, tones, strips, broadband,
    tip: { r: tip.r, w: tip.w, re: tip.re, cl: tipCl, factor: tipFactor, pressureGain: tip.pressureGain },
  };
}

// Noise at the boat speed V (m/s) and the shaft depth (m). prep = prepareNoise(...).
function noiseAt(prep, V, depth) {
  const s = V / prep.V, n = prep.n * s, Z = prep.Z, P = NOISE.positions, rho = WATER.rho;
  // 1. tones
  const tones = prep.tones.map((t) => {
    const f = t.k * Z * n;
    const level = decibel(t.force * s * s / Math.SQRT2 * f / (2 * WATER.sound));
    const noSkew = decibel(t.noSkew * s * s / Math.SQRT2 * f / (2 * WATER.sound));
    const share = t.force > 0 ? (t.side / t.force) ** 2 : 0;  // share of the power from the sideways force
    return { k: t.k, m: t.m, f, level, noSkew, share };
  });
  const tonal = sumDecibels(tones.map((t) => t.level));
  // 2. broadband
  const broadband = 10 * Math.log10(prep.broadband * s ** 5) + NOISE.broadbandLevel;
  // 3. cavitation: sections round the disc and the tip vortex
  let extent = 0;
  const strips = prep.strips.map((e) => {
    const q = 0.5 * rho * (e.w * s) ** 2;
    const margin = [];
    for (let p = 0; p < P; p++) {
      const sigma = (pressureMargin(depth - e.r * Math.cos(2 * Math.PI * p / P)) + e.pressureGain * s * s) / q;
      const ratio = e.suction[p] / sigma;  // > 1: cavitates
      margin.push(ratio);
      if (ratio > 1) extent += (ratio - 1) * Z * e.c * e.dr / (prep.D * prep.D) / P;
    }
    return margin;
  });
  const t = prep.tip, tipRatio = [];
  const qTip = 0.5 * rho * (t.w * s) ** 2, reTip = t.re * s;
  for (let p = 0; p < P; p++) {
    const sigma = (pressureMargin(depth - t.r * Math.cos(2 * Math.PI * p / P)) + t.pressureGain * s * s) / qTip;
    const ratio = t.factor * NOISE.tipVortex * t.cl[p] ** 2 * Math.pow(reTip, 0.35) / sigma;
    tipRatio.push(ratio);
    if (ratio > 1) extent += (ratio - 1) * Z * NOISE.tipWeight / P;
  }
  const cavitation = extent > 0 ? NOISE.cavitationLevel + 10 * Math.log10(extent) : -Infinity;
  const total = sumDecibels([tonal, broadband, ...(extent > 0 ? [cavitation] : [])]);
  return { V, depth, n, tones, tonal, broadband, cavitation, extent, total, strips, tipRatio, inception: inceptionSpeed(prep, depth) };
}

// Cavitation inception speed (m/s) at the depth: the lowest speed at which anything starts to boil.
// σ(V) = P/(q₀s²) + G/q₀ (s = V/V₀; P - static pressure margin, G - pressure gain of a pump-jet ring at V₀):
// a section boils when σ falls to its suction: s² = P / (q₀·suction − G).
// The tip vortex: its index grows as Re^0.35 ∝ s^0.35 - solved by bisection.
function inceptionSpeed(prep, depth) {
  const P = NOISE.positions, rho = WATER.rho;
  let best = Infinity;
  for (const e of prep.strips) {
    const q = 0.5 * rho * e.w * e.w;
    for (let p = 0; p < P; p++) {
      const room = q * e.suction[p] - e.pressureGain;
      if (room <= 0) continue;
      const margin = pressureMargin(depth - e.r * Math.cos(2 * Math.PI * p / P));
      best = Math.min(best, prep.V * Math.sqrt(margin / room));
    }
  }
  const t = prep.tip, q = 0.5 * rho * t.w * t.w;
  for (let p = 0; p < P; p++) {
    const need = t.factor * NOISE.tipVortex * t.cl[p] ** 2 * Math.pow(t.re, 0.35);
    if (need <= 0) continue;
    const margin = pressureMargin(depth - t.r * Math.cos(2 * Math.PI * p / P));
    const boils = (s) => need * Math.pow(s, 0.35) * q * s * s > margin + t.pressureGain * s * s;
    let lo = 0.01, hi = 100;
    if (!boils(hi)) continue;
    for (let i = 0; i < 40; i++) { const mid = Math.sqrt(lo * hi); if (boils(mid)) hi = mid; else lo = mid; }
    best = Math.min(best, prep.V * hi);
  }
  return best;
}
