'use strict';
// FITNESS: how well can this clock tell time?
//
// The only thing selection "sees" is this score. It never looks at the structure:
// it does not reward "having a ratchet" or "having a spring" - only the end result.
//
// Levels (the same categories the video shows on its population chart):
//   0  nothing works
//   1  pendulum - keeps time, but you must watch it and count swings
//   2  proto-clock - gears tick steadily, but there is no hand to read
//   3+ clock with 1, 2, 3, 4+ hands
// Inside the "clock" level the score grows with accuracy: every target period
// (by default 60 s, 3600 s, 86400 s - second, minute and hour hand of a 24h clock)
// is matched with the closest hand, and closer is better.

const CLASS_NAMES = ['ничего', 'маятник', 'прото-часы', '1 стрелка', '2 стрелки', '3 стрелки', '4+ стрелки'];
const CLASS_COLORS = ['#1b2a6b', '#5b8def', '#3fd0d6', '#3fbf5f', '#e8d443', '#f08c2e', '#e0453a'];

function evaluateClock(mech, targets) {
  if (mech.moving && mech.periods.length > 0) {
    const matches = matchHandsToTargets(mech.periods, targets);
    const accuracy = matches.reduce((sum, m) => sum + m.quality, 0);
    return {
      cls: Math.min(2 + mech.periods.length, CLASS_NAMES.length - 1),
      score: 3 + accuracy,
      matches,
    };
  }
  if (mech.moving) return { cls: 2, score: 2, matches: [] };
  if (mech.pendulums.length > 0) return { cls: 1, score: 1, matches: [] };
  return { cls: 0, score: 0, matches: [] };
}

// Pair each target with a different hand, closest pairs first.
function matchHandsToTargets(periods, targets) {
  const pairs = [];
  for (const target of targets) {
    for (const period of periods) {
      pairs.push({ target, period, distance: Math.abs(Math.log(period / target)) });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance);

  const usedTargets = new Set(), usedPeriods = new Set(), matches = [];
  for (const p of pairs) {
    if (usedTargets.has(p.target) || usedPeriods.has(p.period)) continue;
    usedTargets.add(p.target);
    usedPeriods.add(p.period);
    matches.push({
      target: p.target,
      period: p.period,
      error: p.period / p.target - 1,
      // 1 for a perfect hand, falls smoothly as the hand drifts away from the target.
      // Twice too slow (or too fast) gives ~0.13; 1% off gives ~0.9.
      quality: 1 / (1 + 10 * p.distance),
    });
  }
  return matches.sort((a, b) => a.target - b.target);
}
