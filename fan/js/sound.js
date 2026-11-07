'use strict';
// SOUND: what the fan sounds like in the bedroom, synthesised from the computed noise (Web Audio).
// Nothing here affects evolution.
//
// THE FAN:
//   - tones: ONE oscillator at the turn rate n with a custom wave (PeriodicWave): its harmonic h has exactly the amplitude
//     of the computed tone at h·n. An evenly spaced fan gives a clean hum (only h = Z, 2Z...), an unevenly spaced one -
//     a denser, "rougher" sound with many weak harmonics;
//   - broadband: white noise through three band-pass filters - the trailing edge hiss, the leading edge rumble and the
//     stall roar - each at its peak frequency and level;
//   - swish: the noise is gently modulated as the blades pass (a pulse per blade at its angle: an uneven fan has an
//     uneven rhythm).
// THE BACKGROUND (ambient.js): the same kind of band-passed noise for every part of its spectrum, plus texture:
//   raindrops (sparse clicks), crickets (a chirping tone), distant traffic (slow swells).
// The fan can be switched off to hear the room alone. Fan and background go through the same level scale:
// SOUND_REF dB plays at the rms SOUND_GAIN, every 20 dB is ×10 in amplitude - so their loudness is compared honestly.
// A quiet night is really quiet: a boost (setBoost, dB) lifts everything together, the balance stays. A compressor at the end keeps loud sounds from clipping.
// Laptop speakers do not play below ~100 Hz: headphones are better.

const SOUND_REF = 50;     // dB that plays at SOUND_GAIN (rms)
const SOUND_GAIN = 0.12;
const SWISH_DEPTH = 0.12;
const SWISH_WIDTH = 0.18; // rad: width of the pulse of one blade
const WHITE_RMS = 1 / Math.sqrt(3);
const BAND_Q = 0.6;       // a broad band, like the spectrum shape in acoustics.js

const FanSound = (() => {
  let ctx = null, n = null, ambientKey = 'none', fanOn = true, boost = 0;

  const rmsOf = (level) => SOUND_GAIN * Math.pow(10, (level - SOUND_REF) / 20);

  // A looped buffer: white noise, or sparse raindrop clicks (normalised to rms 1).
  function buffer(seconds, kind) {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    if (kind === 'white') {
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    }
    // drops: a short decaying tick here and there, of random strength
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.random() < 120 / ctx.sampleRate) {
        const amp = Math.random() ** 2, len = Math.floor(ctx.sampleRate * (0.002 + 0.006 * Math.random()));
        for (let k = 0; k < len && i + k < data.length; k++) data[i + k] += amp * (Math.random() * 2 - 1) * Math.exp(-k / (len / 4));
      }
    }
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length) || 1;
    for (let i = 0; i < data.length; i++) data[i] /= rms;
    return buf;
  }

  function loop(buf) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(0, Math.random() * buf.duration);
    return s;
  }

  // Gain that makes band-passed white noise (centre f, BAND_Q) play at `level` dB.
  function bandGain(level, f) {
    const width = Math.PI / 2 * f / BAND_Q, nyquist = ctx.sampleRate / 2;
    return Number.isFinite(level) ? rmsOf(level) / (WHITE_RMS * Math.sqrt(Math.min(1, width / nyquist))) : 0;
  }

  function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 12;
    limiter.connect(ctx.destination);
    const master = ctx.createGain();          // the boost for quiet scenes
    master.gain.value = Math.pow(10, boost / 20);
    master.connect(limiter);
    const fanBus = ctx.createGain(), ambientBus = ctx.createGain();
    fanBus.gain.value = fanOn ? 1 : 0;
    fanBus.connect(master);
    ambientBus.connect(master);
    const white = buffer(4, 'white');
    // fan tones
    const osc = ctx.createOscillator();
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0;
    osc.connect(toneGain).connect(fanBus);
    osc.start();
    // fan broadband: one noise source, three bands, then the swish modulation
    const noise = loop(white);
    const swish = ctx.createGain();
    swish.connect(fanBus);
    const band = () => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = BAND_Q;
      const g = ctx.createGain();
      g.gain.value = 0;
      noise.connect(f).connect(g).connect(swish);
      return { f, g };
    };
    const bands = { te: band(), le: band(), stall: band() };
    const lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.connect(lfoDepth).connect(swish.gain);
    lfo.start();
    n = { osc, toneGain, bands, swish, lfo, lfoDepth, lastWave: '', master, fanBus, ambientBus, white, ambient: [] };
    buildAmbient();
  }

  // ---- The background ----

  function buildAmbient() {
    for (const node of n.ambient) { try { node.stop && node.stop(); } catch (e) { /* already stopped */ } node.disconnect(); }
    n.ambient = [];
    const keep = (...nodes) => { n.ambient.push(...nodes); return nodes[0]; };
    for (const part of AMBIENTS[ambientKey].parts) {
      if (part.crickets) { crickets(part, keep); continue; }
      // the broad part: band-passed noise (a raindrop part gives a quarter of its power to the drops)
      const share = part.drops ? 0.75 : 1;
      const src = keep(loop(n.white));
      const f = keep(ctx.createBiquadFilter());
      f.type = 'bandpass';
      f.frequency.value = part.fp;
      f.Q.value = BAND_Q;
      const g = keep(ctx.createGain());
      g.gain.value = bandGain(part.level + 10 * Math.log10(share), part.fp);
      src.connect(f).connect(g);
      let out = g;
      if (part.swell) {
        // distant traffic: the rumble swells and fades every ~15 s
        const swell = keep(ctx.createGain()), slow = keep(ctx.createOscillator()), depth = keep(ctx.createGain());
        swell.gain.value = 0.6;
        slow.frequency.value = 0.07;
        depth.gain.value = 0.4;
        slow.connect(depth).connect(swell.gain);
        slow.start();
        g.connect(swell);
        out = swell;
      }
      out.connect(n.ambientBus);
      if (part.drops) {
        const drops = keep(loop(buffer(5, 'drops')));
        const hp = keep(ctx.createBiquadFilter());
        hp.type = 'highpass';
        hp.frequency.value = 1500;
        const dg = keep(ctx.createGain());
        dg.gain.value = rmsOf(part.level + 10 * Math.log10(1 - share));
        drops.connect(hp).connect(dg).connect(n.ambientBus);
      }
    }
  }

  // Crickets: two voices near fp, each a tone pulsed ~30 times a second in chirps of about half a second.
  function crickets(part, keep) {
    [[0.985, 29, 0.83], [1.02, 34, 1.1]].forEach(([k, pulse, chirp]) => {
      const tone = keep(ctx.createOscillator());
      tone.frequency.value = part.fp * k;
      const fast = keep(ctx.createGain()), slow = keep(ctx.createGain()), level = keep(ctx.createGain());
      fast.gain.value = 0.5;
      slow.gain.value = 0.5;
      const lfoFast = keep(ctx.createOscillator()), lfoSlow = keep(ctx.createOscillator());
      lfoFast.type = 'square';
      lfoFast.frequency.value = pulse;
      lfoSlow.type = 'square';
      lfoSlow.frequency.value = chirp;
      const dFast = keep(ctx.createGain()), dSlow = keep(ctx.createGain());
      dFast.gain.value = 0.5;
      dSlow.gain.value = 0.5;
      lfoFast.connect(dFast).connect(fast.gain);
      lfoSlow.connect(dSlow).connect(slow.gain);
      // two voices, each on a quarter of the time: rms of one = amplitude·√(1/2)·√(1/4)
      level.gain.value = rmsOf(part.level - 3) / Math.sqrt(1 / 8);
      tone.connect(fast).connect(slow).connect(level).connect(n.ambientBus);
      tone.start(); lfoFast.start(); lfoSlow.start();
    });
  }

  // ---- The fan ----

  // cond = noiseAt(...) of the fan to play, angles - its blade angles (rad).
  function update(cond, angles) {
    if (!ctx || !n || !cond) return;
    const t = ctx.currentTime, ease = 0.12, nyquist = ctx.sampleRate / 2;
    // tones: harmonic h of the turn rate, amplitude √2·rms
    const H = Math.min(INFLOW.harmonics, Math.floor(nyquist / Math.max(1, cond.n)) - 1);
    const real = new Float32Array(H + 1), imag = new Float32Array(H + 1);
    for (const tone of cond.tones) if (tone.h <= H) imag[tone.h] = Math.SQRT2 * rmsOf(tone.level);
    const key = Array.from(imag, (v) => v.toFixed(5)).join(',');
    if (key !== n.lastWave) {
      n.osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
      n.lastWave = key;
    }
    n.osc.frequency.setTargetAtTime(cond.n, t, ease);
    n.toneGain.gain.setTargetAtTime(1, t, ease);
    // broadband bands
    const setBand = (b, level, freq) => {
      const f = Math.max(30, Math.min(nyquist * 0.9, freq));
      b.f.frequency.setTargetAtTime(f, t, ease);
      b.g.gain.setTargetAtTime(bandGain(level, f), t, ease);
    };
    setBand(n.bands.te, cond.te, cond.teFreq);
    setBand(n.bands.le, cond.le, cond.leFreq);
    setBand(n.bands.stall, cond.stall, cond.stallFreq);
    // swish: a pulse per blade at its angle, repeated every turn
    const K = 40, sr = new Float32Array(K + 1), si = new Float32Array(K + 1);
    for (let h = 1; h <= K; h++) {
      const shape = Math.exp(-((h * SWISH_WIDTH) ** 2) / 2);
      for (const a of angles) { sr[h] += shape * Math.cos(h * a); si[h] -= shape * Math.sin(h * a); }
    }
    n.lfo.setPeriodicWave(ctx.createPeriodicWave(sr, si));
    n.lfo.frequency.setTargetAtTime(cond.n, t, ease);
    n.swish.gain.setTargetAtTime(1 - SWISH_DEPTH, t, ease);
    n.lfoDepth.gain.setTargetAtTime(SWISH_DEPTH, t, ease);
  }

  return {
    get on() { return ctx !== null; },
    toggle() {
      if (ctx) { ctx.close(); ctx = null; n = null; return false; }
      start();
      return true;
    },
    update,
    // the fan on or off (the background keeps playing)
    setFan(on) {
      fanOn = on;
      if (n) n.fanBus.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.08);
    },
    // a volume boost (dB) for everything: quiet scenes (the night speed) are hard to hear at the true scale
    setBoost(db) {
      boost = db;
      if (n) n.master.gain.setTargetAtTime(Math.pow(10, db / 20), ctx.currentTime, 0.08);
    },
    // the background: a key of AMBIENTS
    setAmbient(key) {
      ambientKey = key;
      if (n) buildAmbient();
    },
  };
})();
