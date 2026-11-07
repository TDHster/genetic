'use strict';
// THE ROOM: the air, the fan body the blades are fixed to, and the uneven air the blades work in.
// Nothing here evolves: this is the world the blades have to live in.
//
// A household pedestal fan, 40 cm guard: a motor in a round housing, the rotor in front of it, a wire guard
// round both, the stand (a pole) below the motor. The fan stands in a bedroom at night; a person lies 1.5 m away.
//
// UNEVEN INFLOW. The blades suck the air through the rear guard, past the motor housing and the pole. Every spoke
// of the guard and the pole leave a narrow strip of slower air. A blade going round meets these strips again and
// again; its push jumps a little every time: this is what makes a fan hum. The strips are described by their
// "harmonics": how strongly the air speed changes 1, 2, 3... times per turn.
//   - the guard has SPOKES radial wires, evenly spread: harmonics SPOKES, 2·SPOKES... (here 24, 48...);
//   - the pole is one wide strip at the bottom: all harmonics, weaker the higher;
//   - the room air and the motor add a weak background.

const AIR = {
  rho: 1.2,            // kg/m³
  nu: 1.5e-5,          // m²/s, kinematic viscosity at 20 °C
  sound: 343,          // m/s
};

const FAN = {
  maxDiameter: 0.40,   // m: the largest rotor that fits in the guard
  hubRatio: 0.22,      // hub (motor) diameter / rotor diameter
  // THE MOTOR is a cheap induction motor: it turns at almost the same speed whatever the blades (its speed is set by
  // the mains frequency and the speed switch). So the blades are designed for a given speed, as in the factory.
  rpm: 1100,           // turns a minute at the middle speed setting ("2")
  settings: [900, 1100, 1300],  // rpm of the settings 1, 2, 3 (the score is taken at "2")
  thrust: 2.4,         // N: the push of the air the middle setting must give (~25 m³ of air a minute)
  maxPower: 20,        // W on the shaft at the middle setting: a cheap motor gives no more
  listener: 1.5,       // m: from the fan to the ear
  plastic: { stress: 8e6, minThickness: 1.2e-3, density: 950 },  // polypropylene: fatigue stress (Pa) with a margin,
                                                                  // thinnest wall a mould fills (m), kg/m³
};

// The inflow: share of the air speed lost in the wakes, as Fourier cosine harmonics (θ = 0 at the top).
// A Gauss bump d·exp(−(θ/β)²) has the cosine harmonics d·β/√π·exp(−m²β²/4); β = width / r (a strip of constant
// width in metres is narrower in angle far from the centre). SPOKES evenly spread spokes add up to SPOKES× that for
// m = SPOKES, 2·SPOKES... and cancel for the others. The pole is at the bottom (θ = π): its harmonics have the sign (−1)^m.
const INFLOW = {
  spokes: 24, spokeDepth: 0.10, spokeWidth: 0.008,
  poleDepth: 0.22, poleWidth: 0.04,
  background: 0.004, backgroundDecay: 20,
  harmonics: 80,       // harmonics 1..80 are taken into account
};

function inflowHarmonic(m, r) {
  const beta = (width) => width / Math.max(0.03, r);
  const bump = (depth, width) => depth * beta(width) / Math.sqrt(Math.PI) * Math.exp(-m * m * beta(width) ** 2 / 4);
  let a = (m % 2 ? -1 : 1) * bump(INFLOW.poleDepth, INFLOW.poleWidth);
  if (m % INFLOW.spokes === 0) a += INFLOW.spokes * bump(INFLOW.spokeDepth, INFLOW.spokeWidth);
  return Math.abs(a) + INFLOW.background * Math.exp(-m / INFLOW.backgroundDecay);
}

// The same inflow as a function of the angle θ (for the stall check round the disc): the share of the air speed lost.
// A blade of chord c feels the strip averaged over its width: the bump is widened to √(width² + (c/2)²) (same area).
function inflowDeficit(theta, r, c) {
  const rr = Math.max(0.03, r);
  const bump = (depth, width, d) => {
    const wide = Math.hypot(width, c / 2);
    return depth * width / wide * Math.exp(-((d * rr / wide) ** 2));
  };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let s = bump(INFLOW.poleDepth, INFLOW.poleWidth, wrap(theta - Math.PI));
  const step = 2 * Math.PI / INFLOW.spokes;
  const near = wrap(theta - Math.round(theta / step) * step);
  s += bump(INFLOW.spokeDepth, INFLOW.spokeWidth, near);
  return s;
}
