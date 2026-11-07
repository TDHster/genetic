'use strict';
// UI wiring: buttons, workers, the turning fan on screen, panels, sound. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

// The goal of the score (applied on reset): quieter at the middle setting (default) or the inaudible breeze.
function readSetup() {
  return { goal: $('cfg-goal').value, ambient: $('cfg-ambient').value };
}
const silentMode = () => isSilent(state.setup);

// Fans that are not in the pool: the classic designs (scored here, on the main thread, for the current goal).
function makeClassics(setup) {
  const named = (id, genome) => ({ id, genome: copyFan(genome), ...evaluateFan(genome, setup), parents: null });
  return {
    reference: named('ref', REFERENCE), metal: named('metal', OLD_METAL), five: named('five', FIVE_SICKLE), uneven: named('uneven', FIVE_UNEVEN),
  };
}
let CLASSICS = makeClassics(DEFAULT_GOAL);
const CLASSIC_NAMES = {
  ref: 'Эталон: обычный 3-лопастной', metal: 'Старый металлический 4-лопастной', five: '5 саблевидных лопастей',
  uneven: '5 саблевидных, неравный шаг',
};
let REF_ANALYSIS = analyzeFan(REFERENCE);

const state = {
  evo: null,
  token: 0,             // changes on every reset: results of an old run are thrown away
  running: false,
  busy: false,
  shown: null,          // fan on screen
  analysis: null,       // analyzeFan(shown.genome)
  lastShownAt: 0,
  pendingShown: null,
  lastStep: null,
  imported: null,
  pinnedSpecies: null,
  stopReason: null,
  autoStopOff: false,
  rate: 0,
  view3d: null,
  staticView: null,
  progress: '',
  psi: 0,               // rotation of the rotor on screen
  speed: 1,             // speed setting index (FAN.settings; 3 - the night speed)
  cond: null,           // noiseAt(...) of the shown fan at the speed setting
  refCond: null,
  listen: 'this',       // what plays: 'this' fan, 'ref' - the reference, 'off' - only the room
  ambient: 'night',     // the background that plays and is drawn (AMBIENTS key)
  setup: { ...DEFAULT_GOAL },  // the goal of the current run (readSetup on reset)
};

// ---- Scoring in Web Workers (or on the main thread, when workers are not allowed) ----

const evaluator = (() => {
  let workers = [];
  try {
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    for (let k = 0; k < n; k++) workers.push(new Worker('js/worker.js'));
  } catch (e) {
    workers = []; // file:// - Chrome does not start workers from files
  }
  let nextId = 1;
  const waiting = new Map();
  for (const w of workers) {
    w.onmessage = (e) => { const done = waiting.get(e.data.id); waiting.delete(e.data.id); done(e.data.result); };
    w.onerror = () => { workers = []; };
  }
  const one = (w, genome) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    w.postMessage({ id, genome, setup: state.setup });
  });
  return {
    get parallel() { return workers.length; },
    // Scores in the order of the genomes; onProgress(done, total).
    async all(genomes, onProgress) {
      const results = new Array(genomes.length);
      let done = 0;
      const finish = (k, result) => { results[k] = result; done++; if (onProgress) onProgress(done, genomes.length); };
      if (workers.length === 0) {
        for (let k = 0; k < genomes.length; k++) {
          if (k % 8 === 0) await new Promise((r) => setTimeout(r, 0)); // let the page breathe
          finish(k, evaluateFan(genomes[k], state.setup));
        }
        return results;
      }
      let next = 0;
      await Promise.all(workers.map(async (w) => {
        while (next < genomes.length) {
          const k = next++;
          finish(k, await one(w, genomes[k]));
        }
      }));
      return results;
    },
  };
})();

function readConfig() {
  return {
    seed: Number($('cfg-seed').value) || 1,
    populationSize: Number($('cfg-pop').value),
    speciation: $('cfg-species').checked,
    mutationsPerChild: Math.max(1, Number($('cfg-mut').value) || 1),
  };
}

function readStopRules() {
  const on = (id) => $(id).checked;
  return {
    beatReference: on('stop-ref-on') ? Math.max(1e-9, Number($('stop-ref').value) / 100) : 0,
    stagnation: on('stop-stag-on') ? Number($('stop-stag').value) : 0,
    maxGenerations: on('stop-max-on') ? Number($('stop-max').value) : 0,
  };
}

async function reset() {
  const token = ++state.token;
  setRunning(false);
  state.evo = null;
  state.lastStep = null;
  state.stopReason = null;
  state.autoStopOff = false;
  $('step-log').textContent = 'Нажми «1 пачка», чтобы увидеть шаг эволюции подробно.';
  state.setup = readSetup();
  CLASSICS = makeClassics(state.setup);
  REF_ANALYSIS = analyzeFan(REFERENCE, state.setup);
  state.imported = state.imported && { ...state.imported, ...evaluateFan(state.imported.genome, state.setup) };
  if (silentMode()) {
    // listen to what the goal is about: the night speed against its background
    setAmbient(state.setup.ambient);
    setSpeed(3);
  }
  const evo = new Evolution(readConfig());
  const genomes = evo.firstGenomes();
  const results = await evaluator.all(genomes, (done, total) => {
    if (token !== state.token) return;
    state.progress = `Стартовый пул: посчитано ${done} из ${total} вентиляторов…`;
    drawStats();
  });
  if (token !== state.token) return;
  evo.start(genomes, results);
  state.evo = evo;
  state.progress = '';
  refreshPanels(true);
  offerShown(pickShown(), true);
}

function setRunning(on) {
  if (on && state.stopReason) state.autoStopOff = true;
  state.running = on;
  $('btn-run').textContent = on ? '⏸ Пауза' : '▶ Старт';
  if (on) runBatches();
}

// One batch: BATCH proposals from the same pool, scored in parallel, accepted in order.
async function oneBatch() {
  const evo = state.evo, token = state.token;
  if (!evo || state.busy) return false;
  state.busy = true;
  const proposals = [];
  for (let k = 0; k < BATCH; k++) proposals.push(evo.propose());
  const results = await evaluator.all(proposals.map((p) => p.genome));
  state.busy = false;
  if (token !== state.token) return false;
  for (let k = 0; k < proposals.length; k++) state.lastStep = evo.accept(proposals[k], results[k]);
  $('step-log').textContent = describeStep(state.lastStep);
  return true;
}

async function runBatches() {
  while (state.running) {
    if (!state.evo || !(await oneBatch())) { await new Promise((r) => setTimeout(r, 100)); continue; }
    const reason = state.autoStopOff ? null : state.evo.stopReason(readStopRules());
    if (reason) {
      state.stopReason = reason;
      setRunning(false);
    }
    refreshPanels(false);
  }
  refreshPanels(true);
}

// ---- The fan on screen ----

function pickShown() {
  const evo = state.evo, src = $('view-source').value;
  if (CLASSICS[src]) return CLASSICS[src];
  if (src === 'imported' && state.imported) return state.imported;
  if (!evo) return CLASSICS.reference;
  if (src === 'child' && state.lastStep) return state.lastStep.child;
  if (src === 'loser' && state.lastStep) return state.lastStep.loser;
  if (src === 'species' && state.pinnedSpecies !== null) {
    const row = evo.speciesTable().find((r) => r.key === state.pinnedSpecies);
    if (row) return row.best;
  }
  return evo.best();
}

function show(fan) {
  state.shown = fan;
  state.pendingShown = null;
  state.lastShownAt = performance.now();
  const a = analyzeFan(fan.genome, state.setup);
  a.genome = fan.genome;
  if (a.blows && !a.night) a.night = nightSpeed(a, state.setup.ambient);
  state.analysis = a;
  updateCondition();
  if (state.view3d) state.view3d.setFan(rotorOf(), a);
  if (state.staticView) state.staticView.setFan(rotorOf());
  drawScoreInfo();
  drawGenome();
  drawCharts();
  drawLive();
  updateSound();
}

// A new fan to show: right away if the viewer asked for it; a new best - at most once a second.
function offerShown(fan, now) {
  if (!state.shown || now) { show(fan); return; }
  if (fan.id === state.shown.id) return;
  state.pendingShown = fan;
}

// The rotor as built (pitch trimmed for the breeze); a fan that does not blow - its raw genome.
const rotorOf = () => (state.analysis && state.analysis.rotor) || state.shown.genome;
// The same for a pool member (its trim comes back from the worker).
const builtRotor = (d) => (d.trim ? trimFan(d.genome, d.trim) : d.genome);

// The turn rate on screen as a share of FAN.rpm: a speed setting, or the night speed of the shown fan.
const night = () => state.speed === 3;
const refNight = () => referenceNight(state.setup.ambient);
const speedScale = () => (night() ? (state.analysis && state.analysis.night ? state.analysis.night.rpm : 0) : FAN.settings[state.speed]) / FAN.rpm;

// The reference at the turn rate rpm, with the aerodynamics solved there (cached: the last one).
let refAtCache = null;
function referenceAt(rpm) {
  if (!refAtCache || Math.abs(refAtCache.rpm - rpm) > 0.5) {
    const g = REF_ANALYSIS.rotor, op = fanForces(g, rpm / 60, true);
    refAtCache = { rpm, cond: noiseAt(prepareNoise(g, op), 1) };
  }
  return refAtCache.cond;
}

// The noise of the shown fan and of the reference at the speed setting. At the night speed the reference turns
// as fast as the shown fan (the same breeze, roughly) - so one hears whether IT would be heard there.
function updateCondition() {
  const a = state.analysis;
  if (night()) {
    state.cond = a && a.blows ? a.night.cond : null;
    state.refCond = referenceAt(a && a.blows ? a.night.rpm : refNight().rpm);
    return;
  }
  const s = speedScale();
  state.refCond = noiseAt(REF_ANALYSIS.prep, s);
  state.cond = a && a.blows ? noiseAt(a.prep, s) : null;
}

function updateSound() {
  if (!FanSound.on) return;
  FanSound.setFan(state.listen !== 'off' && (state.listen === 'ref' || !!state.cond));
  if (state.listen === 'ref') FanSound.update(state.refCond, bladeAngles(REFERENCE).angles);
  else if (state.cond) FanSound.update(state.cond, bladeAngles(state.shown.genome).angles);
}

let lastFrame = performance.now();
function frame(time) {
  const dt = Math.min(0.1, (time - lastFrame) / 1000);
  lastFrame = time;
  const modelDt = dt * Number($('time-scale').value);
  if (state.cond) {
    state.psi = (state.psi + 2 * Math.PI * state.cond.n * modelDt) % (2 * Math.PI);
    if (state.view3d) state.view3d.render({ psi: state.psi, dt: modelDt, s: speedScale() });
  } else if (state.view3d) state.view3d.render(null);
  if (state.pendingShown && time - state.lastShownAt > 1000) show(state.pendingShown);
  requestAnimationFrame(frame);
}

function drawCharts() {
  const a = state.analysis;
  const c = (id) => { const el = $(id); return [el.getContext('2d'), el.width, el.height]; };
  const ids = ['spectrum-canvas', 'harmonics-canvas', 'speed-canvas', 'stall-canvas'];
  if (!a.blows) {
    for (const id of ids) { const [ctx, w, h] = c(id); ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h); }
    return;
  }
  let [ctx, w, h] = c('spectrum-canvas');
  drawSpectrum(ctx, state.cond, state.refCond, w, h, state.ambient);
  [ctx, w, h] = c('harmonics-canvas');
  drawHarmonics(ctx, state.shown.genome, state.cond, w, h);
  [ctx, w, h] = c('speed-canvas');
  drawNoiseSpeed(ctx, a, REF_ANALYSIS, state.cond, w, h, a.night.rpm);
  [ctx, w, h] = c('stall-canvas');
  drawStall(ctx, a, w, h);
}

const db = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const toneText = (c) => (c.worst ? `${c.worst.f.toFixed(0)} Гц, слышимость ${c.audibility.toFixed(1)} дБ` : 'тонов нет');

function drawLive() {
  const c = state.cond, a = state.analysis;
  if (!c) { $('live').innerHTML = 'Этот вентилятор не дует.'; return; }
  const s = c.n / a.n, rpm = c.n * 60;   // the turn rate against the middle setting: push ∝ s², breeze ∝ s, power ∝ s³
  const tip = 2 * Math.PI * c.n * fanDiameter(a.genome) / 2;
  const breeze = a.breeze.at * s;
  const ref = state.refCond;
  $('live').innerHTML = (night() ? `<b>🌙 ночная скорость</b> (не слышно на фоне «${AMBIENTS[state.setup.ambient].name}»): ${rpm.toFixed(0)} об/мин` :
    `скорость <b>${state.speed + 1}</b>: ${rpm.toFixed(0)} об/мин`) + ` · конец лопасти ${tip.toFixed(1)} м/с · ` +
    `упор ${(a.thrust * s * s).toFixed(2)} Н, ${(a.flow * s * 60).toFixed(0)} м³/мин, ветер в 2 м ≈ ${breeze.toFixed(1)} м/с · ` +
    `${(a.power * s * s * s).toFixed(1)} Вт · у кровати <b class="${c.rating < ref.rating ? 'good' : 'bad'}">L_R ${c.rating.toFixed(1)} дБА</b> ` +
    `(дБ(A) ${c.la.toFixed(1)} + тон ${c.kt.toFixed(1)}; эталон ${ref.rating.toFixed(1)}) · самый слышный тон: ${toneText(c)}` +
    (c.laStall > c.laRest - STALL_CLASS ? ' · <b class="bad">ревёт срыв</b>' : '') + againstText(c) + nightText(c, ref);
}

// At the night speed: is this fan heard against the background of the goal, and the reference at the same speed?
function nightText(c, ref) {
  if (!night()) return '';
  const key = state.setup.ambient, heard = (x) => audibleExcess(x, key);
  const say = (e) => (e > 0.5 ? `<b class="bad">слышен</b> (на ${e.toFixed(1)} дБ над фоном)` : '<b class="good">не слышен</b>');
  return `<br>на ${(c.n * 60).toFixed(0)} об/мин: этот ${say(heard(c))}, эталон на тех же оборотах ${say(heard(ref))}` +
    ` (своя ночная скорость эталона — ${refNight().rpm.toFixed(0)} об/мин)`;
}

// How the fan is heard against the chosen background.
function againstText(c) {
  if (state.ambient === 'none') return '';
  const h = heardAgainst(c, state.ambient), name = AMBIENTS[state.ambient].name;
  const loud = h.over > 3 ? `громче фона на ${h.over.toFixed(0)} дБА` : h.over > -3 ? 'вровень с фоном' : `тише фона на ${(-h.over).toFixed(0)} дБА`;
  const tone = h.audibility > 4 ? `<b class="bad">гул слышен</b> (${h.tone.f.toFixed(0)} Гц)` : '<b class="good">гул тонет в фоне</b>';
  return `<br>фон «${name}» ${h.la.toFixed(0)} дБА: вентилятор ${loud}, ${tone}`;
}

// ---- Panels ----

let lastSlowRefresh = 0, lastMatings = 0;
function refreshPanels(force) {
  const now = performance.now();
  if (!force && now - lastSlowRefresh < 300) return;
  if (state.evo && state.running && !force) state.rate = (state.evo.matings - lastMatings) / ((now - lastSlowRefresh) / 1000);
  lastMatings = state.evo ? state.evo.matings : 0;
  lastSlowRefresh = now;
  drawStats();
  if (!state.evo) return;
  drawSpecies();
  const c = $('chart-canvas');
  drawPopulationChart(c.getContext('2d'), state.evo.history.concat([state.evo.snapshot()]), c.width, c.height);
  const pick = pickShown();
  if (!state.shown || pick.id !== state.shown.id) offerShown(pick, force && $('view-source').value !== 'best');
}

function drawStats() {
  const evo = state.evo;
  if (!evo) {
    $('stats').textContent = state.progress;
    document.title = 'Стартовый пул… — Лопасти вентилятора';
    return;
  }
  // The tab title shows the stage of evolution, so it can be watched from another tab.
  document.title = `${state.running ? '▶ ' : ''}Поколение ${Math.floor(evo.generation)} · ${evo.bestScore.toFixed(1)} — Лопасти вентилятора`;
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${state.rate.toFixed(0)} вентиляторов/с (${evaluator.parallel || 'нет'} потоков)` : '') +
    ` · лучшая оценка <b>${evo.bestScore.toFixed(2)}</b> (эталон ${REFERENCE_SCORE.toFixed(2)})` +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

function whoIs(d) {
  if (CLASSIC_NAMES[d.id]) return CLASSIC_NAMES[d.id];
  return `Вентилятор #${d.id} (${d.parents ? `потомок #${d.parents[0]} и #${d.parents[1]}` : d === state.imported ? 'из файла' : 'из случайного стартового пула'})`;
}

function drawScoreInfo() {
  const d = state.shown, a = state.analysis, r = REF_ANALYSIS;
  let html = `<div>${whoIs(d)} · класс: <b>${CLASS_NAMES[d.cls]}</b> · оценка <b>${d.score.toFixed(2)}</b></div>`;
  if (!a.blows) {
    $('score-info').innerHTML = html + '<p class="muted">Лопасти гонят воздух назад или не гонят вовсе.</p>';
    return;
  }
  const n = a.noise, rn = r.noise;
  const row = (name, mine, ref, note) => `<tr><td>${name}</td><td><b>${mine}</b></td><td>${ref}</td><td>${note}</td></tr>`;
  const mpa = (x) => `${(x / 1e6).toFixed(1)} МПа`;
  const rnight = refNight(), bg = AMBIENTS[state.setup.ambient].name;
  html += '<table class="score-table"><tr><th>Часть</th><th>Этот</th><th>Эталон</th><th>Что значит</th></tr>' +
    (silentMode() ? row('Неслышимый ветер', `${a.night.breeze.toFixed(2)} м/с`, `${rnight.breeze.toFixed(2)} м/с`,
      `ветер в 2 м на ночной скорости — самой быстрой, на которой вентилятор не слышно ` +
      (state.setup.ambient === 'none' ? 'в полной тишине (ниже порога слуха)' : `на фоне «${bg}»`) +
      `: ни в одной полосе слуха не громче фона, тоны не торчат`) +
      row('Ночная скорость', `${a.night.rpm.toFixed(0)} об/мин`, `${rnight.rpm.toFixed(0)} об/мин`,
        `упор ${(a.thrust * (a.night.rpm / FAN.rpm) ** 2).toFixed(2)} Н; аэродинамика пересчитана на этих оборотах`) : '') +
    row('Оценочный уровень L_R', `${n.rating.toFixed(1)} дБА`, `${rn.rating.toFixed(1)} дБА`,
      `в ${FAN.listener} м, на скорости 2 (${FAN.rpm} об/мин) = дБ(A) + штраф за тон`) +
    row('· дБ(A)', `${n.la.toFixed(1)}`, `${rn.la.toFixed(1)}`,
      `тоны ${db(n.laTones)}, шум ${db(n.laBroadband)}${Number.isFinite(n.laStall) && n.laStall > 0 ? `, из него срыв ${db(n.laStall)}` : ''}; ухо глухо к низким: −16 дБ на 100 Гц`) +
    row('· штраф за тон K_T', `${n.kt.toFixed(1)}`, `${rn.kt.toFixed(1)}`,
      `от 0 до 6 дБ по ISO 1996-2: насколько тон торчит над шумом в полосе слуха; самый слышный — ${toneText(n)}`) +
    row('Ветер', `${a.thrust.toFixed(2)} Н`, `${r.thrust.toFixed(2)} Н`,
      `нужно не меньше ${FAN.thrust} Н; меньше — штраф ${BREEZE_PENALTY} за каждое «вдвое слабее»; ${(a.flow * 60).toFixed(0)} м³/мин`) +
    row('Мощность на валу', `${a.power.toFixed(1)} Вт`, `${r.power.toFixed(1)} Вт`,
      `+${POWER_GAIN} за каждое «вдвое меньше» эталона, −${POWER_LOSS} за «вдвое больше»; мотор даёт не больше ${FAN.maxPower} Вт`) +
    row('Прочность', mpa(a.stress), mpa(r.stress),
      `худшее сечение на ${a.stressAt.toFixed(2)} R на скорости 3; предел пластика ${mpa(FAN.plastic.stress)}`) +
    row('Тоньше всего', `${(a.thinnest * 1000).toFixed(1)} мм`, `${(r.thinnest * 1000).toFixed(1)} мм`,
      `пресс-форма не заполняет стенку тоньше ${FAN.plastic.minThickness * 1000} мм`) +
    row('Перекрытие', a.overlap.toFixed(2), r.overlap.toFixed(2),
      `ширина лопасти (вид спереди) / самый узкий промежуток ${(a.gap * 180 / Math.PI).toFixed(0)}°; больше 1 — не отлить`) +
    row('Вибрация при повороте головы', `${(a.wobble * 100).toFixed(0)}%`, `${(r.wobble * 100).toFixed(0)}%`,
      `пульсация гироскопического момента: инерция ротора неодинакова в его плоскости (2 лопасти — 100%, ровные 3 и больше — 0); ` +
      `допуск ${WOBBLE_TOLERANCE * 100}%, сверх него штраф ${WOBBLE_PENALTY} за каждое удвоение`) +
    '</table>' +
    `<div class="formula">оценка = 100 + ${silentMode() ? `${SILENT_WEIGHT} × log2(${a.night.breeze.toFixed(2)} / ${rnight.breeze.toFixed(2)})` :
      `${NOISE_WEIGHT} × ${a.quieter.toFixed(1)} дБА тише`} ${a.powerPoints >= 0 ? '+' : '−'} ${Math.abs(a.powerPoints).toFixed(1)} за мощность` +
    (a.penalty > 0 ? ` − штраф ${a.penalty.toFixed(1)}` : '') + ` = <b>${a.raw.toFixed(2)}</b>` +
    (Math.abs(a.raw - d.score) > 0.01 ? ` → ${d.score.toFixed(2)} (ниже ${SCORE_FLOOR} оценка плавно прижимается к нулю: 100 / (20 − x))` : '') + '</div>' +
    (a.penalty > 0 ? `<p class="note">Штраф: ${[['слабый ветер', a.weak], ['мотор', a.motor], ['прочность и литьё', a.strength], ['перекрытие', a.overlapPenalty], ['вибрация', a.wobblePenalty]]
      .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}.</p>` : '');
  $('score-info').innerHTML = html;
}

function drawGenome() {
  const d = state.shown, g = d.genome, a = state.analysis;
  const c = $('profile-canvas');
  drawFan(c.getContext('2d'), rotorOf(), c.width, c.height, false);
  const list = (xs, f) => xs.map(f).join(' · ');
  const bal = bladeAngles(g);
  const deg = (t) => `${(t * 180 / Math.PI).toFixed(1)}°`;
  const moved = bal.angles.some((t, j) => Math.abs(t - bal.wished[j]) > 0.002);
  $('genome-info').innerHTML = '<table>' +
    `<tr><th>Лопастей</th><td>${g.blades}</td></tr>` +
    `<tr><th>Диаметр</th><td>${(fanDiameter(g) * 100).toFixed(1)} см (${(g.diameter * 100).toFixed(0)}% от наибольшего ${FAN.maxDiameter * 100} см)</td></tr>` +
    `<tr><th>Шаг P/D от ступицы к концу</th><td>${list(rotorOf().pitch, (x) => x.toFixed(2))}` +
      (a.blows ? ` <span class="muted">(гены ${list(g.pitch, (x) => x.toFixed(2))} × ${a.trim.toFixed(3)} — угол установлен на заводе под нужный ветер)</span>` : '') + '</td></tr>' +
    `<tr><th>Ширина c/D</th><td>${list(g.chord, (x) => x.toFixed(3))}</td></tr>` +
    `<tr><th>Изгиб f/c (у ступицы, середина, конец)</th><td>${list(g.camber, (x) => x.toFixed(3))}</td></tr>` +
    `<tr><th>Толщина t/c</th><td>${list(g.thickness, (x) => x.toFixed(3))}</td></tr>` +
    `<tr><th>Сабля на середине и на конце</th><td>${list(g.sweep, (x) => `${x.toFixed(0)}°`)}</td></tr>` +
    `<tr><th>Углы лопастей</th><td>${list(bal.angles, deg)}` +
      (moved ? `<br><span class="muted">хотел геном: ${list(bal.wished, deg)} — балансировка сдвинула, чтобы центр масс был на оси</span>` : '') + '</td></tr>' +
    (a.blows ? `<tr><th>На скорости 2</th><td>${FAN.rpm} об/мин, упор ${a.thrust.toFixed(2)} Н, ${a.power.toFixed(1)} Вт, ` +
      `ветер у решётки ${a.breeze.disc.toFixed(1)} м/с</td></tr>` : '') +
    '</table>';
}

function drawSpecies() {
  const rows = state.evo.speciesTable();
  const on = state.evo.cfg.speciation;
  let html = on ? '' : '<div class="muted">Виды выключены: турнир идёт по всему пулу, квот нет. Таблица — просто состав пула.</div>';
  html += `<table><tr><th></th><th>Вид</th><th>Штук</th>${on ? '<th>Квота</th>' : ''}<th>Лучший</th></tr>`;
  for (const r of rows) {
    const mark = r.key === state.pinnedSpecies && $('view-source').value === 'species' ? ' ◀' : '';
    html += `<tr class="clickable" data-key="${r.key}"><td><canvas width="56" height="56" class="mini"></canvas></td>` +
      `<td>${speciesName(r.key)}</td><td>${r.size}</td>` + (on ? `<td>${r.quota.toFixed(0)}</td>` : '') +
      `<td>${r.best.score.toFixed(1)} · ${CLASS_NAMES[r.best.cls]}${r.best.quietBreeze !== undefined ? ` · неслышно ${r.best.quietBreeze.toFixed(2)} м/с` :
        r.best.rating !== undefined ? ` · ${r.best.rating.toFixed(1)} дБА` : ''}${mark}</td></tr>`;
  }
  $('species-info').innerHTML = html + '</table>';
  $('species-info').querySelectorAll('canvas.mini').forEach((cv, i) => drawFan(cv.getContext('2d'), builtRotor(rows[i].best), cv.width, cv.height, true));
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, ${c.species} лоп., оценка ${c.score.toFixed(2)}` +
    (c.rating !== undefined ? ` (L_R ${c.rating.toFixed(1)} дБА, ${c.power.toFixed(1)} Вт` +
      (c.quietBreeze !== undefined ? `, неслышно ${c.quietBreeze.toFixed(2)} м/с на ${c.nightRpm.toFixed(0)} об/мин` : '') + ')' : '');
  const head = s.parentSpecies !== null
    ? [`Родителей выбрали в виде «${speciesName(s.parentSpecies)}» (вид берётся с вероятностью по квоте),`,
      `погибший — из вида «${speciesName(s.deathSpecies)}» (он сильнее всех превысил квоту).`, '']
    : ['Родители — лучшие двое из трёх случайных, погибший — худший из трёх случайных.', ''];
  return [
    `Последний потомок из пачки в ${BATCH}:`, ...head,
    line('Мама', s.mom), line('Папа', s.dad), '',
    'Мутации потомка:', ...s.mutations.map((m) => '  · ' + m), '',
    line('Потомок', s.child), line('Погиб', s.loser),
  ].join('\n');
}

// ---- Controls ----

$('btn-run').onclick = () => setRunning(!state.running);
$('btn-step').onclick = async () => {
  if (state.running) return;
  if (await oneBatch()) refreshPanels(true);
};
$('btn-reset').onclick = () => reset();
$('btn-new-seed').onclick = () => { $('cfg-seed').value = 1 + Math.floor(Math.random() * 999999); reset(); };
$('view-source').onchange = () => offerShown(pickShown(), true);
function setSpeed(index) {
  // the night is quiet by design: lift the volume of everything (fan and background together) to hear it
  if (index === 3 && state.speed !== 3 && Number($('boost').value) === 0) setBoost(20);
  state.speed = index;
  document.querySelectorAll('.speeds button[data-speed]').forEach((o) => o.classList.toggle('active', Number(o.dataset.speed) === index));
  if (!state.analysis) return;
  updateCondition();
  drawCharts();
  drawLive();
  updateSound();
}
document.querySelectorAll('.speeds button[data-speed]').forEach((b) => { b.onclick = () => setSpeed(Number(b.dataset.speed)); });
$('cfg-goal').onchange = () => { $('silent-settings').hidden = $('cfg-goal').value !== 'silent'; };
$('cfg-ambient').innerHTML = Object.entries(AMBIENTS)
  .map(([k, a]) => `<option value="${k}"${k === 'night' ? ' selected' : ''}>${k === 'none' ? 'тишина (порог слуха)' : a.name}</option>`).join('');
$('btn-sound').onclick = () => {
  const on = FanSound.toggle();
  $('btn-sound').classList.toggle('active', on);
  updateSound();
};
// What plays: this fan, the reference (to compare by ear) or nothing but the room.
document.querySelectorAll('#listen button').forEach((b) => {
  b.onclick = () => {
    state.listen = b.dataset.listen;
    document.querySelectorAll('#listen button').forEach((o) => o.classList.toggle('active', o === b));
    updateSound();
  };
});
$('ambient').innerHTML = Object.entries(AMBIENTS).map(([k, a]) => `<option value="${k}">${a.name}</option>`).join('');
$('ambient').value = state.ambient;
FanSound.setAmbient(state.ambient);
// Volume boost for quiet scenes (dB): fan and background together, the balance between them stays.
function setBoost(db) {
  $('boost').value = String(db);
  FanSound.setBoost(db);
}
$('boost').onchange = () => setBoost(Number($('boost').value));

function setAmbient(key) {
  state.ambient = key;
  $('ambient').value = key;
  FanSound.setAmbient(key);
  if (!state.analysis) return;
  drawCharts();
  drawLive();
}
$('ambient').onchange = () => setAmbient($('ambient').value);
$('species-info').onclick = (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  state.pinnedSpecies = Number(tr.dataset.key);
  const opt = $('view-source').querySelector('option[value=species]');
  opt.disabled = false;
  opt.textContent = `Лучший вида: ${speciesName(state.pinnedSpecies)}`;
  $('view-source').value = 'species';
  offerShown(pickShown(), true);
  drawSpecies();
};

$('btn-export').onclick = () => {
  const d = state.shown;
  const data = {
    about: `Household fan rotor, largest diameter ${FAN.maxDiameter} m, hub ${FAN.hubRatio} of the diameter, ${FAN.rpm} rpm. ` +
      'blades; diameter (share of the largest); pitch P/D and chord c/D: 4 points hub..tip; camber f/c and thickness t/c: ' +
      '3 points hub, middle, tip; sweep (deg, back against the rotation) at the middle and at the tip; ' +
      'spacing: wished shift of every blade from even spacing, share of 360°/Z (the rotor is then balanced). ' +
      'The pitch genes give the shape: the whole pitch is multiplied by pitchTrim for the wanted breeze.',
    score: d.score,
    referenceScore: REFERENCE_SCORE,
    goal: state.setup,
    ratingLevel: d.rating,
    inaudibleBreeze: d.quietBreeze,
    pitchTrim: d.trim,
    angles: bladeAngles(d.genome).angles.map((t) => +(t * 180 / Math.PI).toFixed(2)),
    genome: d.genome,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `fan-${d.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const g = data.genome;
    const nums = (list, n, name, range) => {
      if (!Array.isArray(list) || list.length !== n || !list.every(Number.isFinite)) throw new Error(`поле ${name}: нужно ${n} чисел`);
      return list.map((x) => clampTo(x, range));
    };
    if (!g) throw new Error('нет поля genome');
    for (const key of ['blades', 'diameter']) if (!Number.isFinite(g[key])) throw new Error(`нет поля ${key}`);
    const spacing = EVEN.slice();
    if (Array.isArray(g.spacing)) g.spacing.slice(0, MAX_BLADES).forEach((x, i) => { if (Number.isFinite(x)) spacing[i] = clampTo(x, RANGES.spacing); });
    const genome = {
      blades: Math.round(clampTo(g.blades, RANGES.blades)),
      diameter: clampTo(g.diameter, RANGES.diameter),
      pitch: nums(g.pitch, PITCH_POINTS, 'pitch', RANGES.pitch),
      chord: nums(g.chord, CHORD_POINTS, 'chord', RANGES.chord),
      camber: nums(g.camber, SECTION_POINTS, 'camber', RANGES.camber),
      thickness: nums(g.thickness, SECTION_POINTS, 'thickness', RANGES.thickness),
      sweep: nums(g.sweep, SWEEP_POINTS, 'sweep', RANGES.sweep),
      spacing,
    };
    state.imported = { id: 'file', genome, ...evaluateFan(genome, state.setup), parents: null };
    $('view-source').querySelector('option[value=imported]').disabled = false;
    $('view-source').value = 'imported';
    offerShown(state.imported, true);
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
  e.target.value = '';
};

$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');

// The 3D view is an ES module: it may come after this script, or not at all (file://).
function start3d() {
  if (state.view3d || !window.View3D) return;
  state.view3d = window.View3D.create($('view3d'));
  state.staticView = window.View3D.createStatic($('static3d'));
  if (state.shown) {
    state.view3d.setFan(rotorOf(), state.analysis);
    state.staticView.setFan(rotorOf());
  }
}
$('btn-static-reset').onclick = () => {
  if (!state.staticView || !state.shown) return;
  state.staticView.resetView();
  state.staticView.setFan(rotorOf());
};
window.addEventListener('view3d-ready', start3d);
start3d();
setTimeout(() => {
  if (!state.view3d) {
    $('view3d').innerHTML = '<div class="fallback">3D-вид не загрузился. Страницу нужно открыть через http-сервер, ' +
      'а не двойным кликом: из папки genetic запустить «python3 -m http.server 8765» и открыть http://localhost:8765/fan/</div>';
  }
}, 3000);
if (!evaluator.parallel) {
  state.progress = 'Фоновые потоки недоступны (страница открыта как файл): считаю в основном потоке, медленнее.';
}

show(CLASSICS.reference);
requestAnimationFrame(frame);
reset();
