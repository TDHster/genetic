'use strict';
// MECHANISM ("physics"): what does a genome actually build, and does it move?
//
// This is a simplified model, not a full physics engine. The rules:
//
// 1. PENDULUM. A hand whose one end is glued to the housing (pivot) and whose other end
//    holds a gear (bob). The rod and the bob must not touch anything else
//    (the ratchet center is the only exception), otherwise it cannot swing.
//    Period: T = 2*pi*sqrt(L / g) - the textbook formula; the video uses the same one.
//
// 2. ESCAPEMENT. The ratchet center hangs on a pendulum rod, the ratchet teeth grip
//    the teeth of one gear - the "escape wheel". Each full swing of the pendulum lets
//    the escape wheel advance by exactly one tooth. So the wheel turns once per
//    (teeth x T) seconds - steady, regardless of how hard it is pushed.
//
// 3. SPRING. A wound mainspring. Like the video, we assume it sits in the housing
//    (the housing is not drawn), so any spring end stuck to a gear drives that gear.
//
// 4. GEAR TRAIN. Gears and hands connected to each other must turn together:
//      teeth-teeth  -> meshing gears: speed ratio = -(teeth A / teeth B), direction flips
//      axle-axle, axle-hand, hand-hand -> rigidly joined: same speed
//    If the constraints contradict each other (a loop of gears with incompatible ratios),
//    or something holds the train still (teeth glued to the housing, a hand stuck in
//    teeth...), the whole connected group is JAMMED and cannot move.
//
// 5. The group of gears that contains the escape wheel MOVES only if it also contains
//    a driven gear and is not jammed. Every hand in that group then turns with
//    a constant period - this is a working clock.

const GRAVITY = 9.81;

function pendulumPeriod(length) {
  return 2 * Math.PI * Math.sqrt(length / GRAVITY);
}

// Main entry point. Returns everything we know about the clock:
// what was found, why it does or does not work, and which bond plays which role.
function analyzeClock(genome) {
  const links = buildLinks(genome);
  const roles = new Map(); // pair index -> role ('pendulum' | 'escapement' | 'spring' | 'train' | 'jam')
  const jams = [];         // human-readable reasons why something is stuck

  const pendulums = findPendulums(genome, links, roles);
  const escapement = findEscapement(links, pendulums, roles, jams);
  const drives = findSpringDrives(links, pendulums, roles, jams);
  const externalLocks = escapement.locked.concat(drives.locked);
  const train = solveGearTrain(genome, pendulums, externalLocks, roles, jams);

  // Does the escape wheel's group actually move?
  let moving = null;
  if (escapement.ok) {
    const wheel = escapement.wheel;
    const group = train.group[wheel];
    const driven = drives.gears.filter((g) => train.group[g] === group);
    if (driven.length > 0 && !train.jammedGroups.has(group)) {
      moving = { group, wheel, driven, pendulum: escapement.pendulum };
    }
  }

  const hands = moving ? readHands(genome, train, moving) : [];
  if (moving) markWorkingBonds(genome, train, moving, drives, roles);

  return {
    pendulums,
    escapement,
    drives,
    moving,                         // null if the gear train does not tick
    hands,                          // [{ hand, period }] for every hand that turns
    periods: distinctPeriods(hands),
    roles,
    jams,
    drawing: moving ? buildDrawingTree(genome, train, moving, hands, drives) : null,
  };
}

// links[p] = list of points bonded to point p (bonds inside one part are ignored).
function buildLinks(genome) {
  const links = Array.from({ length: POINT_COUNT }, () => []);
  for (const k of genome.bonds) {
    const [a, b] = PAIRS[k];
    if (samePart(a, b)) continue; // a gear's center glued to its own teeth means nothing
    links[a].push(b);
    links[b].push(a);
  }
  return links;
}

function setRole(roles, a, b, role) {
  roles.set(PAIR_INDEX[a][b], role);
}

// ---- 1. Pendulums ----
function findPendulums(genome, links, roles) {
  const result = [];
  for (let h = 0; h < HAND_COUNT; h++) {
    for (const [pivot, tip] of [[handEnd(h, 0), handEnd(h, 1)], [handEnd(h, 1), handEnd(h, 0)]]) {
      // The pivot end hangs on the housing and touches nothing else (ratchet allowed).
      if (!links[pivot].includes(HOUSING)) continue;
      if (!links[pivot].every((q) => q === HOUSING || q === RATCHET_CENTER)) continue;

      // The tip end holds exactly one gear and touches nothing else (ratchet allowed).
      const gearPoints = links[tip].filter((q) => POINTS[q].kind === 'gear');
      if (gearPoints.length === 0) continue;
      const bob = POINTS[gearPoints[0]].index;
      if (!gearPoints.every((q) => POINTS[q].index === bob)) continue;
      if (!links[tip].every((q) => POINTS[q].kind === 'gear' || q === RATCHET_CENTER)) continue;

      // The bob gear hangs only on this rod - nothing else holds it.
      const bobLinks = links[gearCenter(bob)].concat(links[gearTeeth(bob)]);
      if (!bobLinks.every((q) => q === tip)) continue;

      const length = genome.lengths[h];
      result.push({ hand: h, bob, pivot, tip, length, period: pendulumPeriod(length) });
      setRole(roles, pivot, HOUSING, 'pendulum');
      for (const q of gearPoints) setRole(roles, tip, q, 'pendulum');
      break;
    }
  }
  return result;
}

// Is this point part of a pendulum? Returns the pendulum or null.
function pendulumOfPoint(pendulums, p) {
  const pt = POINTS[p];
  for (const pend of pendulums) {
    if (pt.kind === 'hand' && pt.index === pend.hand) return pend;
    if (pt.kind === 'gear' && pt.index === pend.bob) return pend;
  }
  return null;
}

// Train node id: gears are 0..29, hands are 30..36. Pendulum parts are not in the train.
function trainNode(pendulums, p) {
  const pt = POINTS[p];
  if (pt.kind !== 'gear' && pt.kind !== 'hand') return -1;
  if (pendulumOfPoint(pendulums, p)) return -1;
  return pt.kind === 'gear' ? pt.index : GEAR_COUNT + pt.index;
}

function nodeName(n) {
  return n < GEAR_COUNT ? 'Ш' + (n + 1) : 'С' + (n - GEAR_COUNT + 1);
}

// ---- 2. Escapement ----
function findEscapement(links, pendulums, roles, jams) {
  const result = { ok: false, pendulum: null, wheel: -1, locked: [] };
  let broken = false;

  // Ratchet center: must hang on one pendulum rod (the housing is also fine - it's a pivot).
  for (const q of links[RATCHET_CENTER]) {
    if (q === HOUSING) continue;
    const pend = pendulumOfPoint(pendulums, q);
    if (pend && POINTS[q].kind === 'hand') {
      if (result.pendulum && result.pendulum !== pend) broken = true; // two pendulums pull it apart
      result.pendulum = pend;
      continue;
    }
    broken = true;
    const n = trainNode(pendulums, q);
    if (n >= 0) {
      result.locked.push(n);
      jams.push('храповик держит ' + nodeName(n));
      setRole(roles, RATCHET_CENTER, q, 'jam');
    }
  }

  // Ratchet teeth: must grip the teeth of exactly one gear.
  const gripped = [];
  for (const q of links[RATCHET_TEETH]) {
    const n = trainNode(pendulums, q);
    if (n >= 0 && n < GEAR_COUNT && POINTS[q].side === 'teeth') gripped.push(n);
    else if (n >= 0) {
      result.locked.push(n);
      jams.push('зубья храповика держат ' + nodeName(n));
      setRole(roles, RATCHET_TEETH, q, 'jam');
    } else if (q === HOUSING) {
      broken = true; // the ratchet is glued to the body and cannot rock
    }
  }
  if (gripped.length > 1) {
    broken = true;
    for (const g of gripped) {
      result.locked.push(g);
      setRole(roles, RATCHET_TEETH, gearTeeth(g), 'jam');
    }
    jams.push('храповик вцепился сразу в несколько шестерён');
  } else if (gripped.length === 1) {
    result.wheel = gripped[0];
  }

  result.ok = !broken && result.pendulum !== null && result.wheel >= 0;
  if (result.ok) {
    const pend = result.pendulum;
    const rodEnd = links[RATCHET_CENTER].find((q) => q === pend.pivot || q === pend.tip);
    setRole(roles, RATCHET_CENTER, rodEnd, 'escapement');
    setRole(roles, RATCHET_TEETH, gearTeeth(result.wheel), 'escapement');
  } else if (result.wheel >= 0) {
    // A ratchet without a swinging pendulum works as a lock: the gear cannot turn.
    result.locked.push(result.wheel);
  }
  return result;
}

// ---- 3. Spring ----
function findSpringDrives(links, pendulums, roles, jams) {
  const result = { gears: [], locked: [] };
  for (const end of [SPRING_A, SPRING_B]) {
    for (const q of links[end]) {
      const n = trainNode(pendulums, q);
      if (n < 0) continue;
      if (n < GEAR_COUNT) {
        // Spring on a gear (axle or rim) pushes it around.
        if (!result.gears.includes(n)) result.gears.push(n);
      } else {
        // Spring on a hand pins the hand.
        result.locked.push(n);
        jams.push('пружина зажала ' + nodeName(n));
        setRole(roles, end, q, 'jam');
      }
    }
  }
  return result;
}

// ---- 4. Gear train ----
// Every gear/hand gets a speed relative to the first part of its connected group.
// Connections are constraints: "B turns at speed A x factor".
// externalLocks: parts already held still by the ratchet or the spring.
function solveGearTrain(genome, pendulums, externalLocks, roles, jams) {
  const NODES = GEAR_COUNT + HAND_COUNT;
  const edges = Array.from({ length: NODES }, () => []);
  const lockedNodes = new Set(externalLocks);

  for (const k of genome.bonds) {
    const [a, b] = PAIRS[k];
    if (samePart(a, b)) continue;
    const na = trainNode(pendulums, a), nb = trainNode(pendulums, b);

    // Something glued to the housing.
    if (na >= 0 && b === HOUSING || nb >= 0 && a === HOUSING) {
      const n = na >= 0 ? na : nb, p = na >= 0 ? a : b;
      if (POINTS[p].side === 'center') continue; // a gear axle on the housing is just a bearing
      lockedNodes.add(n);
      jams.push(nodeName(n) + ' приклеена к корпусу');
      roles.set(k, 'jam');
      continue;
    }
    if (na < 0 || nb < 0) continue;

    const sa = POINTS[a].side, sb = POINTS[b].side;
    const aTeeth = sa === 'teeth', bTeeth = sb === 'teeth';
    if (aTeeth && bTeeth) {
      // Meshing gears: the smaller one turns faster, in the opposite direction.
      const factor = -genome.teeth[na] / genome.teeth[nb];
      edges[na].push({ to: nb, factor, bond: k, kind: 'mesh' });
      edges[nb].push({ to: na, factor: 1 / factor, bond: k, kind: 'mesh' });
    } else if (aTeeth || bTeeth) {
      // Teeth pressed against an axle or a hand: nothing can turn.
      lockedNodes.add(na); lockedNodes.add(nb);
      jams.push(nodeName(na) + ' и ' + nodeName(nb) + ' заклинили друг друга');
      roles.set(k, 'jam');
    } else {
      // Axle-axle, axle-hand, hand-hand: rigidly joined, same speed.
      edges[na].push({ to: nb, factor: 1, bond: k, kind: 'axle' });
      edges[nb].push({ to: na, factor: 1, bond: k, kind: 'axle' });
    }
  }

  // Walk every connected group, assigning relative speeds and looking for contradictions.
  const group = new Array(NODES).fill(-1);
  const speed = new Array(NODES).fill(0);
  const jammedGroups = new Set();
  let groupCount = 0;
  for (let start = 0; start < NODES; start++) {
    if (group[start] >= 0) continue;
    const id = groupCount++;
    group[start] = id;
    speed[start] = 1;
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      if (lockedNodes.has(n)) jammedGroups.add(id);
      for (const e of edges[n]) {
        const expected = speed[n] * e.factor;
        if (group[e.to] < 0) {
          group[e.to] = id;
          speed[e.to] = expected;
          queue.push(e.to);
        } else if (Math.abs(speed[e.to] - expected) > 1e-9 * Math.abs(expected)) {
          if (!jammedGroups.has(id)) jams.push('кольцо из шестерён с несовместимыми передаточными числами');
          jammedGroups.add(id);
          roles.set(e.bond, 'jam');
        }
      }
    }
  }
  return { edges, group, speed, lockedNodes, jammedGroups };
}

// ---- 5. Hands ----
// Escape wheel period = teeth x pendulum period. Every other part of the group turns
// at (its relative speed / wheel's relative speed) times the wheel's speed.
function readHands(genome, train, moving) {
  const wheelPeriod = genome.teeth[moving.wheel] * moving.pendulum.period;
  const hands = [];
  for (let h = 0; h < HAND_COUNT; h++) {
    const n = GEAR_COUNT + h;
    if (train.group[n] !== moving.group) continue;
    const ratio = train.speed[n] / train.speed[moving.wheel];
    hands.push({ hand: h, period: wheelPeriod / Math.abs(ratio), ratio });
  }
  return hands;
}

// Several hands on one axle show the same thing - count each period once.
function distinctPeriods(hands) {
  const periods = hands.map((h) => h.period).sort((a, b) => a - b);
  return periods.filter((p, i) => i === 0 || Math.abs(p - periods[i - 1]) > 1e-9 * p);
}

function markWorkingBonds(genome, train, moving, drives, roles) {
  for (let n = 0; n < train.edges.length; n++) {
    if (train.group[n] !== moving.group) continue;
    for (const e of train.edges[n]) if (!roles.has(e.bond)) roles.set(e.bond, 'train');
  }
  for (const g of moving.driven) {
    for (const end of [SPRING_A, SPRING_B]) {
      for (const p of [gearCenter(g), gearTeeth(g)]) {
        const k = PAIR_INDEX[end][p];
        if (genome.bonds.includes(k)) roles.set(k, 'spring');
      }
    }
  }
}

// ---- For drawing ----
// Like the video, we draw only the parts that matter: the gears on the path
// from the escape wheel to every hand and to the driven gear.
function buildDrawingTree(genome, train, moving, hands, drives) {
  const parent = new Map([[moving.wheel, null]]);
  const queue = [moving.wheel];
  while (queue.length) {
    const n = queue.shift();
    for (const e of train.edges[n]) {
      if (!parent.has(e.to)) { parent.set(e.to, { from: n, kind: e.kind }); queue.push(e.to); }
    }
  }
  const needed = new Set();
  const targets = hands.map((h) => GEAR_COUNT + h.hand).concat(moving.driven);
  for (let n of targets) {
    while (n !== null && n !== undefined && !needed.has(n)) {
      needed.add(n);
      const p = parent.get(n);
      n = p ? p.from : null;
    }
  }
  needed.add(moving.wheel);
  // Keep BFS order so a parent is always placed before its children.
  const order = [...parent.keys()].filter((n) => needed.has(n));
  return {
    order,
    parent,
    relSpeed: (n) => train.speed[n] / train.speed[moving.wheel],
  };
}
