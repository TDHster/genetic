'use strict';
// THE BOAT: sea water, the submarine the propeller drives, and the wake the propeller works in.
// Nothing here evolves: this is the world the propeller has to live in.
//
// The submarine is a generic diesel-electric boat: hull 70 m long, 7 m across, one propeller at the stern
// behind four stern fins in a cross (+) and a sail (the "tower") further forward.
//
// THE WAKE. The propeller does not work in clean water: the hull slows the water down (more near the hub,
// less at the tip), and every fin leaves a narrow strip of slow water behind it. A blade going round
// meets these strips again and again: its load jumps up and down several times per turn - this is what makes
// a propeller hum. The wake behind four fins repeats four times per turn: its "harmonics" are 4, 8, 12...
// times per turn. A propeller with Z blades only feels the harmonics Z, 2Z, 3Z... (the rest cancel between
// the blades). So 4 or 8 blades behind 4 fins are loud, 7 blades are quiet. That is why submarines have 7.

const WATER = {
  rho: 1025,          // kg/m³
  nu: 1.19e-6,        // m²/s, kinematic viscosity at 15 °C
  g: 9.81,
  pAtm: 101325,       // Pa
  pVapour: 1700,      // Pa: below this pressure the water boils (cavitates)
  sound: 1500,        // m/s
};
const KNOT = 0.5144;  // m/s

const BOAT = {
  resistance: 2690,     // N per (m/s)²: hull drag R = resistance · V² (wetted 1500 m², Ct 0.0035)
  thrustDeduction: 0.15, // the propeller sucks at the hull: it has to push 1 / (1 − t) times the drag
  power: 4.0e6,         // W on the shaft at full power
  maxTorque: 420e3,     // N·m: the most the electric motor can twist. A slow propeller needs a big torque
                        // for the same power: with a small motor it cannot use the full power.
  maxDiameter: 5.0,     // m: the largest propeller that fits behind the hull
  hubRatio: 0.25,       // hub diameter / propeller diameter
};

// Where the propeller is judged (see fitness.js): the quiet patrol.
const SETUP = {
  patrolSpeed: 10,      // knots
  depth: 12,            // m from the surface to the shaft: periscope depth, where cavitation comes early
};

// The mean wake at relative radius x = r / R: share of the boat speed the water has lost.
// Slow water near the hub (0.5), almost clean water at the tip (0.12); about 0.25 on average.
function wakeMean(x) {
  const s = Math.max(0, Math.min(1, (1 - x) / (1 - BOAT.hubRatio)));
  return 0.12 + 0.38 * Math.pow(s, 1.5);
}

// The wake behind the fins and the sail, as Fourier harmonics (cosines of m·θ, θ = 0 at the top).
// Every fin wake is a narrow Gauss bump of depth `depth` and width `width` (metres, so narrower in angle at a
// larger radius); the sail wake is wider and shallower. The hull and small appendages add a weak background.
const WAKE = {
  fins: 4, finDepth: 0.30, finWidth: 0.35,
  sailDepth: 0.12, sailWidth: 1.2,
  background: 0.012, backgroundDecay: 15,
  harmonics: 60,        // harmonics 1..60 are taken into account
};

// THE PUMP-JET (a gene of the propeller, see propeller.js): a ring (shroud) round the rotor and S stator vanes in front.
//   - The ring slows the water down to `slowdown` of its speed at the rotor: the pressure there grows by
//     0.5ρ·va²·(1 − slowdown²), so cavitation comes later. But the ring pulls back: it takes
//     backThrust × (1 − slowdown) of the rotor thrust, and its two surfaces add friction.
//   - The gap between the blade tips and the ring is tiny: no Prandtl tip loss, and the tip vortex is weak
//     (its cavitation index × tipVortex).
//   - Every stator vane leaves a thin wake right in front of the rotor: harmonics S, 2S, 3S...
const DUCT = {
  backThrust: 0.6,
  friction: 0.004,      // friction coefficient of the ring (both sides)
  tipVortex: 0.3,
  statorDepth: 0.08, statorWidth: 0.12,   // wake of one vane: depth (share of speed), width (m)
};

// Amplitude of the wake harmonic m at the radius r (m), share of the boat speed. With g - plus the stator vanes of a pump-jet.
// A Gauss bump d·exp(−(θ/β)²) has the cosine harmonics d·β/√π·exp(−m²β²/4); four fins at 0°, 90°, 180°, 270°
// add up to 4× that for m = 4, 8, 12... and cancel for the others. The top fin is right behind the sail.
function wakeHarmonic(m, r, g) {
  const beta = (width) => width / Math.max(0.2, r);
  const bump = (depth, width) => depth * beta(width) / Math.sqrt(Math.PI) * Math.exp(-m * m * beta(width) ** 2 / 4);
  let a = bump(WAKE.sailDepth, WAKE.sailWidth) + WAKE.background * Math.exp(-m / WAKE.backgroundDecay);
  if (m % WAKE.fins === 0) a += WAKE.fins * bump(WAKE.finDepth, WAKE.finWidth);
  if (g && g.duct && m % g.stators === 0) a += g.stators * bump(DUCT.statorDepth, DUCT.statorWidth);
  return a;
}

// Static pressure minus vapour pressure at the depth (m) - what keeps water from boiling.
function pressureMargin(depth) {
  return WATER.pAtm + WATER.rho * WATER.g * Math.max(0, depth) - WATER.pVapour;
}
