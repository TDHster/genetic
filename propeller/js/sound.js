'use strict';
// SOUND: what the propeller sounds like, synthesised from the computed noise (Web Audio). Nothing here affects evolution.
//
// The blade tones are a few hertz - below what the ear hears. A sonar operator hears them anyway: the broadband
// noise of the propeller swells and fades with every blade passing ("the turn count"). So here:
//   - broadband: white noise through a low-pass filter at the trailing-edge noise peak, loudness from its level;
//   - blade rate: that noise is amplitude-modulated at Z·n, the deeper the louder the tones are against it;
//   - cavitation: a sparse crackle (random clicks) through a band-pass around 1.5 kHz, loudness from its level.
// Levels are relative: SOUND_REF dB plays at a moderate volume, every 20 dB is ×10 in amplitude.

const SOUND_REF = 120;   // dB that plays at the gain 0.25
const SOUND_MAX = 0.9;

const PropellerSound = (() => {
  let ctx = null, n = null;

  // A looped buffer of white noise, or of sparse clicks (crackle).
  function noiseBuffer(seconds, crackle) {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      if (!crackle) data[i] = Math.random() * 2 - 1;
      else data[i] = Math.random() < 0.0015 ? (Math.random() * 2 - 1) * 1.0 : (Math.random() * 2 - 1) * 0.02;
    }
    return buf;
  }

  function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = (crackle) => {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuffer(3, crackle);
      s.loop = true;
      s.start();
      return s;
    };
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    // broadband, modulated at the blade rate
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    const bbGain = ctx.createGain();
    const mod = ctx.createGain();           // its gain = 1 − depth/2 + depth/2 · sin(2π f t)
    const lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.connect(lfoDepth).connect(mod.gain);
    lfo.start();
    source(false).connect(lowpass).connect(bbGain).connect(mod).connect(master);
    // cavitation crackle
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = CAVITATION_PEAK;
    band.Q.value = 0.7;
    const cavGain = ctx.createGain();
    cavGain.gain.value = 0;
    source(true).connect(band).connect(cavGain).connect(master);
    n = { lowpass, bbGain, mod, lfo, lfoDepth, cavGain };
  }

  const gainOf = (level) => Math.min(SOUND_MAX, 0.25 * Math.pow(10, (level - SOUND_REF) / 20));

  // cond = noiseAt(...), a = analyzePropeller(...) of the shown propeller.
  function update(a, cond) {
    if (!ctx || !n || !cond) return;
    const t = ctx.currentTime, ease = 0.15;
    const bladeRate = cond.tones.length ? cond.tones[0].f : 0;
    // modulation depth: how strong the tones are against the broadband noise
    const tonePower = Math.pow(10, cond.tonal / 10), bbPower = Math.pow(10, cond.broadband / 10);
    const depth = Math.min(0.95, 1.4 * Math.sqrt(tonePower / (tonePower + bbPower)));
    n.lowpass.frequency.setTargetAtTime(Math.min(8000, Math.max(150, 3 * broadbandPeak(a.prep, cond.V))), t, ease);
    n.bbGain.gain.setTargetAtTime(gainOf(Math.max(cond.broadband, cond.tonal)), t, ease);
    n.mod.gain.setTargetAtTime(1 - depth / 2, t, ease);
    n.lfoDepth.gain.setTargetAtTime(depth / 2, t, ease);
    n.lfo.frequency.setTargetAtTime(Math.max(0.5, bladeRate), t, ease);
    n.cavGain.gain.setTargetAtTime(cond.extent > 0 ? 4 * gainOf(cond.cavitation) : 0, t, ease);
  }

  return {
    get on() { return ctx !== null; },
    toggle() {
      if (ctx) { ctx.close(); ctx = null; n = null; return false; }
      start();
      return true;
    },
    update,
  };
})();
