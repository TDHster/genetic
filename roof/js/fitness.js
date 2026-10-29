'use strict';
// FITNESS: how fast does water get off the roof?
//
// A drop starts at rest and slides down the broken line without friction.
// On a straight piece the acceleration is constant (g times the sine of the slope), so
//   speed at the end:  v_b = sqrt(v_a² + 2 g (y_a - y_b))   (energy is conserved on the piece),
//   time on the piece: length / ((v_a + v_b) / 2)           - exact, no time steps needed.
// At a BREAK POINT the drop hits the next piece: only the part of its velocity along the new
// piece survives, v -> v · cos(turn angle); the part across it is lost in the impact.
// A smooth bend (a few degrees) costs almost nothing; a sharp V-shaped pit (turn of 90° or more)
// stops the drop dead. Without this rule a drop falling into a pit kept all its speed and
// shot up the opposite wall almost to its start height - like a ball, not like water.
// If the speed runs out on a piece that goes up, the drop rolls back into the pit:
// water stays on the roof.
//
// Two tasks (TASK.rain):
//   - one drop from the ridge (default): time T of this drop. This is the classic
//     brachistochrone problem; the answer is a cycloid;
//   - rain everywhere: a drop starts at rest at every break point (and at the ridge),
//     T = their average time. Vertical rain falls evenly per metre of width, hence equal-width pieces.
//
// SCORE:
//   - water gets stuck: score = the part that gets off (0..1): how far the drop got in x,
//     counting how high it climbed up the wall of the pit before rolling back (one drop),
//     or the share of drops that reach the eave (rain);
//   - otherwise score = 1 + T_line / T, where T_line is the time on a plain straight slope.
//     1 + 1 = 2 means "as fast as a straight roof", above 2 - faster.

// Slide a drop from point `start` of the broken line `pts`.
// Returns { reached, time, times: time at every point it passed,
//           speeds: speed at the start of every piece it passed (after the turn), stopIndex,
//           stopX: how far (in x) it got - on the piece where it stopped, how high it climbed }.
function slide(pts, start) {
  let t = 0, v = 0, dir = null;
  const times = [0], speeds = [];
  for (let k = start; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    if (dir) v *= Math.max(0, dir.x * d.x + dir.y * d.y); // impact at the break point: cos of the turn
    const v2 = v * v + 2 * G * (a.y - b.y);
    if (v2 <= 0) {
      // Climbs up the piece until the speed runs out: distance v² / (2 g sin(slope)), then rolls back.
      const rise = b.y - a.y;
      const part = rise > 0 ? Math.min(1, v * v / (2 * G * rise)) : 0;
      return { reached: false, time: t, times, speeds, stopIndex: k, stopX: a.x + (b.x - a.x) * part };
    }
    const vb = Math.sqrt(v2);
    speeds.push(v);
    t += 2 * len / (v + vb);
    v = vb;
    dir = d;
    times.push(t);
  }
  return { reached: true, time: t, times, speeds, stopIndex: pts.length - 1, stopX: pts[pts.length - 1].x };
}

// Time for a broken line. stride: drops of the rain start at every stride-th point
// (1 for the genome; k for a reference sampled k times finer, so the starts are at the same x).
function measure(pts, stride) {
  const last = pts.length - 1;
  if (!TASK.rain) {
    const s = slide(pts, 0);
    return s.reached ? { ok: true, time: s.time } : { ok: false, share: s.stopX / TASK.width };
  }
  let reached = 0, total = 0, sum = 0;
  for (let k = 0; k < last; k += stride) {
    const s = slide(pts, k);
    total++;
    if (s.reached) { reached++; sum += s.time; }
  }
  return reached === total ? { ok: true, time: sum / total } : { ok: false, share: reached / total };
}

const CLASS_NAMES = ['вода застревает', 'медленнее прямого ската', 'быстрее прямого ската', 'быстрее дуги Галилея', 'на уровне циклоиды или быстрее'];
const CLASS_COLORS = ['#1b2a6b', '#7a3b8f', '#3fd0d6', '#3fbf5f', '#f0c040'];
const NEAR_CYCLOID = 0.01; // "at the cycloid level" = not more than 1% slower

// Reference roofs, recomputed by setTask(): line, arc, cycloid as ready-made results.
const REF_DETAIL = 1; // references are measured as broken lines of the same N pieces: a fair comparison
const REFS = {};

function setTask(task) {
  Object.assign(TASK, task);
  const m = TASK.segments * REF_DETAIL;
  // Classes need the reference times, so first measure, then classify.
  const make = (key, name, pts) => ({ key, name, pts, ...measure(pts, REF_DETAIL) });
  REFS.line = make('line', 'прямой скат', linePoints(m));
  REFS.arc = make('arc', 'дуга Галилея', arcPoints(m));
  REFS.cycloid = make('cycloid', 'циклоида', cycloidPoints(m));
  REFS.cycloid.shape = cycloidShape();
  for (const r of Object.values(REFS)) Object.assign(r, classify(r));
}

// Time of a reference, Infinity if water gets stuck on it.
function refTime(key) {
  return REFS[key] && REFS[key].ok ? REFS[key].time : Infinity;
}

function classify(m) {
  if (!m.ok) return { cls: 0, score: m.share };
  const score = 1 + REFS.line.time / m.time;
  let cls;
  if (m.time >= refTime('line')) cls = 1;
  else if (m.time >= refTime('arc')) cls = 2;
  else if (!(m.time <= refTime('cycloid') * (1 + NEAR_CYCLOID))) cls = 3;
  else cls = 4;
  return { cls, score };
}

function evaluateRoof(genome) {
  const pts = roofPoints(genome);
  const m = measure(pts, 1);
  return { pts, ...m, ...classify(m) };
}

// Extra numbers for the panels (not part of the score).
function roofStats(pts) {
  let length = 0, steepest = 0, lowest = Infinity;
  for (let k = 1; k < pts.length; k++) {
    const dx = pts[k].x - pts[k - 1].x, dy = pts[k].y - pts[k - 1].y;
    length += Math.hypot(dx, dy);
    steepest = Math.max(steepest, Math.abs(Math.atan2(dy, dx)) * 180 / Math.PI);
    lowest = Math.min(lowest, pts[k].y);
  }
  return { length, steepest, lowest };
}
