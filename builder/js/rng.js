// Seeded pseudo-random number generator.
// Same seed -> same sequence -> same evolution run, so experiments are reproducible.

export function makeRng(seed) {
  // mulberry32: tiny and fast, good enough for a simulation (not for cryptography).
  let state = seed >>> 0;

  function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0, 1)
  }

  return {
    next,
    // Integer in [0, n)
    int: (n) => Math.floor(next() * n),
    // Integer in [lo, hi] inclusive
    intRange: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    // Spread evenly on a log scale: 0.01..0.1 is as likely as 10..100
    logUniform: (lo, hi) => lo * Math.pow(hi / lo, next()),
    // Standard normal distribution (Box-Muller)
    normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
    chance: (p) => next() < p,
    // Poisson-distributed count with the given mean (Knuth's method, fine for small means)
    poisson: (mean) => {
      const limit = Math.exp(-mean);
      let k = 0, p = next();
      while (p > limit) { k++; p *= next(); }
      return k;
    },
  };
}
