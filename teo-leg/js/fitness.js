'use strict';
// FITNESS: how fast does a walker on these legs go?
//
// We turn the crank a full circle and look at the path of the foot. It has two parts:
//   STANCE - the foot is on the ground and pushes the body forward (the stride);
//   RETURN - the foot is carried back through the air to start the next stride.
//
// SPEED. The crank turns at a constant rate (one turn = one unit of time). While a foot
// stands on the ground, the body moves at the speed of that foot relative to the body:
// stride / stance time. Several legs take turns, so per crank turn the body travels
//   speed = stride / share of the turn on the ground        (cm per crank turn)
// A short stance means a fast foot - but then fewer feet stand on the ground at once.
// We assume a walker with LEGS legs evenly out of phase and want at least MIN_FEET of them
// on the ground at any moment (stable, not hopping from leg to leg):
// the share on the ground must be at least MIN_FEET / LEGS.
//
// A good walking leg:
//   - can turn the crank all the way round (otherwise it jams);
//   - the foot is the lowest point - the knees do not scrape the ground;
//   - walks FAST (the main criterion);
//   - always stands on at least MIN_FEET feet (support = min(1, (share x LEGS / MIN_FEET)^2));
//   - the stance is EVEN (otherwise the feet of different legs fight each other);
//   - on the return the foot is CARRIED over the ground: when it moves back above the place
//     where it stood, it must be high (clearance). A foot that slides back low over the
//     ground - even 1 cm up - shuffles and catches on every bump;
//   - lifts the foot HIGH: higher is better up to a third of the leg height
//     (leg height = from the crank axle down to the ground);
//   - the foot never rises above the body (the crank axle) - otherwise it is a flail, not a leg;
//   - uses no more MATERIAL than Jansen's leg (total length of the bars that matter).
//     Without this rule evolution simply grows the leg: longer bars - longer stride.
//
// OPTIONAL RULES (switched on/off and weighted in the UI, see FITNESS_OPTIONS):
//   - HIGH JOINTS (ground clearance of the mechanism): q = lowest point of the mechanism
//     (except the foot) over the turn / leg height. Higher "belly" - passes bigger obstacles;
//   - BAR ANGLES: in every joint, the angle between its two bars over the turn. Near 0 or
//     180 degrees the lever arm is tiny and the joint carries a huge load.
//     q = worst sin(angle) / sin(30 deg), at most 1: angles between 30 and 150 are fine;
//   - COMPACTNESS (a light bonus): q = area swept by Jansen's leg / area swept by this leg
//     (bounding box of all points that matter over the turn), at most 1.
// Each optional rule enters as a factor 1 - weight x (1 - q): weight 0 = no effect,
// weight 1 = the full quality q.
//
// score = 1 + speed x support x evenness x clearance x lift x material x optional factors
// score = 1                       breaks the rules: knees scrape the ground or the foot flies above the body
// score = share of the circle where the leg assembles (0..1), for legs that jam
// score = 0                       no foot at all
// Only the parts the foot depends on count: unused joints are neutral (like unused bonds in the clock).

const GROUND_TOLERANCE = 1;  // cm: foot counts as "on the ground" within 1 cm of its lowest point
const KNEE_CLEARANCE = 2;    // cm: other joints must stay at least this high above the ground
const CLEARANCE = 10;        // cm: wanted height of the foot when it moves back over the stance zone
const CLEARANCE_MARGIN = 0.15; // the zone is the stance minus 15% at each end (lift-off, landing)
const LIFT_SHARE = 1 / 3;    // lift bonus grows until the lift reaches 1/3 of the leg height
const LEGS = 6;              // legs of the walker, evenly out of phase
const MIN_FEET = 2;          // feet that must be on the ground at any moment
const MATERIAL_BUDGET = 480; // cm of bars - Jansen's leg uses 479.4

const GOOD_ANGLE = 30;       // degrees: bar angles between 30 and 150 get no penalty

// Optional rules: { height: weight 0..1 | 0 = off, angle: ..., compact: ... }.
// Set by setFitnessOptions() when evolution starts; Jansen's score is recomputed with them.
let FITNESS_OPTIONS = { height: 0.05, angle: 0.05, compact: 0.05 };

const CLASS_NAMES = ['не работает', 'нарушает правила', 'крутится, но не шагает', 'шагает', 'шагает лучше Янсена'];
const CLASS_COLORS = ['#1b2a6b', '#7a3b8f', '#3fd0d6', '#3fbf5f', '#f0c040'];

function measureGait(sim, footIndex) {
  const foot = sim.poses.map((p) => p[footIndex]);
  const ground = Math.min(...foot.map((f) => f.y));
  const lift = Math.max(...foot.map((f) => f.y)) - ground;

  // Stance: the longest run of consecutive steps with the foot on the ground (wraps around).
  const onGround = foot.map((f) => f.y <= ground + GROUND_TOLERANCE);
  let best = { start: 0, length: 0 };
  if (onGround.every(Boolean)) best = { start: 0, length: STEPS };
  else {
    for (let s = 0; s < STEPS; s++) {
      if (!onGround[s] || onGround[(s - 1 + STEPS) % STEPS]) continue; // not the start of a run
      let length = 0;
      while (length < STEPS && onGround[(s + length) % STEPS]) length++;
      if (length > best.length) best = { start: s, length };
    }
  }
  const contact = [];
  for (let n = 0; n < best.length; n++) contact.push((best.start + n) % STEPS);
  // Return: everything else, in order, from the end of the stance to its start.
  const back = [];
  for (let n = best.length; n < STEPS; n++) back.push((best.start + n) % STEPS);

  // Stride: how far the foot travels along the ground.
  const xs = contact.map((s) => foot[s].x);
  const stride = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const share = best.length / STEPS;

  // Evenness: 1 when every step moves the foot by the same distance, lower when it jerks.
  let evenness = 0;
  if (contact.length > 2) {
    const dx = [];
    for (let n = 1; n < contact.length; n++) dx.push(foot[contact[n]].x - foot[contact[n - 1]].x);
    const mean = dx.reduce((a, b) => a + b, 0) / dx.length;
    const std = Math.sqrt(dx.reduce((a, b) => a + (b - mean) ** 2, 0) / dx.length);
    evenness = mean === 0 ? 0 : Math.max(0, 1 - std / Math.abs(mean));
  }

  // Clearance: the lowest point of the foot while it moves BACK (against the stride)
  // above the middle of the stance zone. Infinity if it never passes over it.
  const direction = contact.length > 1 ? Math.sign(foot[contact[contact.length - 1]].x - foot[contact[0]].x) : 0;
  const zoneMargin = stride * CLEARANCE_MARGIN;
  const zoneLo = Math.min(...xs) + zoneMargin, zoneHi = Math.max(...xs) - zoneMargin;
  let clearance = Infinity;
  for (const s of back) {
    const dx = foot[(s + 1) % STEPS].x - foot[s].x;
    if (Math.sign(dx) === direction) continue; // still moving with the stride (landing, lift-off)
    if (foot[s].x >= zoneLo && foot[s].x <= zoneHi) clearance = Math.min(clearance, foot[s].y - ground);
  }

  // Does any other point that matters (joints, crank, frame) come down to the ground?
  let scrapes = false;
  for (const p of sim.poses) {
    for (const i of sim.used) {
      if (i !== footIndex && p[i].y < ground + KNEE_CLEARANCE) scrapes = true;
    }
  }

  // The body is at the crank axle (y = 0). The foot must stay below it.
  const height = -ground;                                   // leg height: axle to ground
  const aboveBody = Math.max(...foot.map((f) => f.y)) > 0;

  // Speed: cm the body travels per crank turn (see the header).
  const speed = share > 0 ? stride / share : 0;

  return { ground, height, lift, stride, share, speed, evenness, clearance, contact, scrapes, aboveBody };
}

// Lowest point of the mechanism (except the foot) over the turn, cm above the ground.
function lowestJoint(sim, footIndex, ground) {
  let low = Infinity;
  for (const p of sim.poses) for (const i of sim.used) if (i !== footIndex) low = Math.min(low, p[i].y);
  return low - ground;
}

// Worst sin of the angle between the two bars of a joint, over all joints and the whole turn.
function worstBarAngle(leg, sim) {
  let worst = 1;
  leg.joints.forEach((joint, k) => {
    const i = FIXED_POINTS + k;
    if (!sim.used.has(i)) return;
    for (const p of sim.poses) {
      const ux = p[joint.a].x - p[i].x, uy = p[joint.a].y - p[i].y;
      const vx = p[joint.b].x - p[i].x, vy = p[joint.b].y - p[i].y;
      const sin = Math.abs(ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
      worst = Math.min(worst, sin);
    }
  });
  return worst;
}

// Area of the bounding box swept by all points that matter over the turn, cm^2.
function sweptArea(sim) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of sim.poses) for (const i of sim.used) {
    minX = Math.min(minX, p[i].x); maxX = Math.max(maxX, p[i].x);
    minY = Math.min(minY, p[i].y); maxY = Math.max(maxY, p[i].y);
  }
  return (maxX - minX) * (maxY - minY);
}

function evaluateLeg(leg) {
  const sim = simulateLeg(leg);
  if (leg.foot < 0 || !sim.complete) {
    // No foot at all, or the leg falls apart somewhere on the turn.
    return { sim, gait: null, cls: 0, score: leg.foot < 0 ? 0 : sim.assembled / STEPS };
  }
  const gait = measureGait(sim, leg.foot);
  if (gait.scrapes || gait.aboveBody) return { sim, gait, cls: 1, score: 1 };

  gait.material = barMaterial(leg, sim.used);
  const factors = {
    // Squared: with too short a stance the speed grows as 1/share, and a plain
    // share*LEGS factor would cancel it out exactly - no penalty at all.
    support: Math.min(1, Math.pow(gait.share * LEGS / MIN_FEET, 2)),
    evenness: gait.evenness,
    clearance: gait.contact.length > 1 ? Math.min(1, gait.clearance / CLEARANCE) : 0,
    lift: gait.height > 0 ? Math.min(1, gait.lift / (gait.height * LIFT_SHARE)) : 0,
    // Over budget: the penalty grows fast (10% over -> x0.66).
    material: Math.min(1, Math.pow(MATERIAL_BUDGET / gait.material, 4)),
  };
  // Optional rules: factor = 1 - weight x (1 - quality).
  const opt = FITNESS_OPTIONS;
  gait.lowestJoint = lowestJoint(sim, leg.foot, gait.ground);
  gait.worstAngle = Math.asin(Math.min(1, worstBarAngle(leg, sim))) * 180 / Math.PI; // 0..90 (and its mirror 90..180)
  gait.area = sweptArea(sim);
  const blend = (weight, q) => 1 - weight * (1 - Math.max(0, Math.min(1, q)));
  if (opt.height) factors.height = blend(opt.height, gait.lowestJoint / gait.height);
  if (opt.angle) factors.angle = blend(opt.angle, Math.sin(gait.worstAngle * Math.PI / 180) / Math.sin(GOOD_ANGLE * Math.PI / 180));
  if (opt.compact) factors.compact = blend(opt.compact, JANSEN_AREA / gait.area);
  gait.factors = factors;
  const quality = Object.values(factors).reduce((a, b) => a * b, 1);
  const score = 1 + gait.speed * quality;
  let cls = score < 2 ? 2 : 3;
  if (JANSEN_SCORE !== null && score > JANSEN_SCORE) cls = 4;
  return { sim, gait, cls, score };
}

// Jansen's own leg, scored by the same rules - the bar to beat.
const JANSEN_AREA = sweptArea(simulateLeg(JANSEN));
let JANSEN_SCORE = null;

// Switch the optional rules; Jansen's score is recomputed with the same rules.
function setFitnessOptions(options) {
  FITNESS_OPTIONS = { ...options };
  JANSEN_SCORE = null;
  JANSEN_SCORE = evaluateLeg(JANSEN).score;
}
setFitnessOptions(FITNESS_OPTIONS);
