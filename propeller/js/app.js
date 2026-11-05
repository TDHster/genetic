'use strict';
// UI wiring: buttons, workers, the turning propeller on screen, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

// The goal of the score (applied on reset): quieter than the reference (default) or quieter than the sea.
function readSetup() {
  return { goal: $('cfg-goal').value, sea: $('cfg-sea').value, range: Math.max(1, Number($('cfg-range').value) || 500) };
}
const seaMode = () => isSea(state.setup);

// Propellers that are not in the pool: the classic designs (scored here, on the main thread, for the current goal).
function makeClassics(setup) {
  const named = (id, genome) => ({ id, genome: copyPropeller(genome), ...evaluatePropeller(genome, setup), parents: null });
  return { reference: named('ref', REFERENCE), ship: named('ship', SHIP_FOUR), five: named('five', FIVE_SKEWED), jet: named('jet', PUMP_JET) };
}
let CLASSICS = makeClassics(DEFAULT_GOAL);
const CLASSIC_NAMES = { ref: 'Эталон: 7-лопастной саблевидный', ship: 'Корабельный 4-лопастной', five: '5-лопастной с откосом', jet: 'Насадка (pump-jet), сделана вручную' };
let REF_ANALYSIS = analyzePropeller(REFERENCE);

const state = {
  evo: null,
  token: 0,             // changes on every reset: results of an old run are thrown away
  running: false,
  busy: false,
  shown: null,          // propeller on screen
  analysis: null,       // analyzePropeller(shown.genome) + curves
  lastShownAt: 0,
  pendingShown: null,
  lastStep: null,
  imported: null,
  pinnedSpecies: null,
  stopReason: null,
  autoStopOff: false,
  rate: 0,
  view3d: null,
  staticView: null,     // the propeller alone, standing still
  progress: '',
  psi: 0,               // rotation of the propeller on screen
  cond: null,           // noiseAt(...) at the shown speed and depth
  refCond: null,
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
          finish(k, evaluatePropeller(genomes[k], state.setup));
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
    range: seaMode() && on('stop-range-on') ? state.setup.range : 0,
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
  REF_ANALYSIS = analyzePropeller(REFERENCE, state.setup);
  state.imported = state.imported && { ...state.imported, ...evaluatePropeller(state.imported.genome, state.setup) };
  $('stop-range-wrap').hidden = !seaMode();
  const evo = new Evolution(readConfig());
  const genomes = evo.firstGenomes();
  const results = await evaluator.all(genomes, (done, total) => {
    if (token !== state.token) return;
    state.progress = `Стартовый пул: посчитано ${done} из ${total} винтов…`;
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

// ---- The propeller on screen ----

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

function show(prop) {
  state.shown = prop;
  state.pendingShown = null;
  state.lastShownAt = performance.now();
  const a = analyzePropeller(prop.genome, state.setup);
  a.genome = prop.genome;
  if (a.pushes) a.curves = performanceCurves(prop.genome, SETUP.patrolSpeed * KNOT, 60);
  state.analysis = a;
  updateCondition();
  if (state.view3d) state.view3d.setPropeller(prop.genome, a);
  if (state.staticView) state.staticView.setPropeller(prop.genome);
  drawScoreInfo();
  drawGenome();
  drawCharts();
  PropellerSound.update(a, state.cond);
}

// A new propeller to show: right away if the viewer asked for it; a new best - at most once a second.
function offerShown(prop, now) {
  if (!state.shown || now) { show(prop); return; }
  if (prop.id === state.shown.id) return;
  state.pendingShown = prop;
}

const speed = () => Number($('speed').value);   // knots
const depth = () => Number($('depth').value);   // m

// The noise of the shown propeller and of the reference at the speed and depth of the sliders.
function updateCondition() {
  $('speed-out').textContent = `${speed().toFixed(1)} уз`;
  $('depth-out').textContent = `${depth()} м`;
  state.refCond = noiseAt(REF_ANALYSIS.prep, speed() * KNOT, depth());
  state.cond = state.analysis && state.analysis.pushes ? noiseAt(state.analysis.prep, speed() * KNOT, depth()) : null;
  // the sea mode: how far the sonar hears both at the speed and depth of the sliders
  state.seaNow = seaMode() && state.cond ? seaDetection(state.analysis.prep, state.cond, state.setup.sea) : null;
  state.refSeaNow = seaMode() ? seaDetection(REF_ANALYSIS.prep, state.refCond, state.setup.sea) : null;
}

let lastFrame = performance.now(), lastCharts = 0;
function frame(time) {
  const dt = Math.min(0.1, (time - lastFrame) / 1000);
  lastFrame = time;
  const modelDt = dt * Number($('time-scale').value);
  if (state.cond) {
    state.psi += 2 * Math.PI * state.cond.n * modelDt;
    if (state.view3d) state.view3d.render({ psi: state.psi, dt: modelDt, cond: state.cond });
    if (time - lastCharts > 500) { lastCharts = time; drawLive(); }
  } else if (state.view3d) state.view3d.render(null);
  if (state.pendingShown && time - state.lastShownAt > 1000) show(state.pendingShown);
  requestAnimationFrame(frame);
}

function drawCharts() {
  const a = state.analysis;
  const c = (id) => { const el = $(id); return [el.getContext('2d'), el.width, el.height]; };
  const ids = ['spectrum-canvas', 'speed-canvas', 'wake-canvas', 'cav-canvas'];
  if (!a.pushes) {
    for (const id of ids) { const [ctx, w, h] = c(id); ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h); }
    return;
  }
  let [ctx, w, h] = c('spectrum-canvas');
  drawSpectrum(ctx, a, REF_ANALYSIS, state.cond, state.refCond, w, h, seaMode() ? state.setup : null);
  [ctx, w, h] = c('speed-canvas');
  drawNoiseSpeed(ctx, a, REF_ANALYSIS, state.cond, w, h);
  [ctx, w, h] = c('wake-canvas');
  drawWake(ctx, a, state.shown.genome, state.cond, w, h);
  [ctx, w, h] = c('cav-canvas');
  drawCavitation(ctx, a, state.cond, w, h);
}

const kn = (v) => (v / KNOT).toFixed(1);
const distance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} км` : `${m.toFixed(0)} м`);
const worstText = (w) => (w.kind === 'tone' ? `тон ${w.f.toFixed(1)} Гц` : `сплошной шум в полосе ${w.f.toFixed(0)} Гц`);
const db = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

function drawLive() {
  const c = state.cond, a = state.analysis;
  if (!c) { $('live').innerHTML = 'Этот винт не может толкать лодку.'; return; }
  const rpm = c.n * 60;
  let text = `скорость <b>${speed().toFixed(1)} уз</b> на глубине <b>${depth()} м</b> · ${rpm.toFixed(0)} об/мин · ` +
    `конец лопасти ${(2 * Math.PI * c.n * propDiameter(a.genome) / 2).toFixed(1)} м/с · ` +
    `шум <b>${c.total.toFixed(1)} дБ</b> (тоны ${db(c.tonal)}, сплошной ${db(c.broadband)}, кавитация ${c.extent > 0 ? db(c.cavitation) : '—'}) · `;
  text += c.extent > 0
    ? `<b class="bad">кавитирует: началась с ${kn(c.inception)} уз</b>`
    : `<b class="good">без кавитации</b> (начнётся с ${kn(c.inception)} уз на этой глубине)`;
  if (state.seaNow) {
    const sn = state.seaNow, goal = state.setup.range;
    text += ` · море ${SEA_STATES[state.setup.sea].name}: <b class="${sn.range <= goal ? 'good' : 'bad'}">слышно с ${distance(sn.range)}</b>` +
      ` (выдаёт ${worstText(sn.worst)}; эталон — с ${distance(state.refSeaNow.range)}, цель — не дальше ${distance(goal)})`;
  }
  if (speed() * KNOT > a.vMax + 0.05) text += ` · <span class="muted">быстрее ${kn(a.vMax)} уз лодка с этим винтом не идёт</span>`;
  $('live').innerHTML = text;
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
    document.title = 'Стартовый пул… — Винт подлодки';
    return;
  }
  // The tab title shows the stage of evolution, so it can be watched from another tab.
  document.title = `${state.running ? '▶ ' : ''}Поколение ${Math.floor(evo.generation)} · ${evo.bestScore.toFixed(1)} — Винт подлодки`;
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${state.rate.toFixed(0)} винтов/с (${evaluator.parallel || 'нет'} потоков)` : '') +
    ` · лучшая оценка <b>${evo.bestScore.toFixed(2)}</b> (эталон ${REFERENCE_SCORE.toFixed(2)})` +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

function whoIs(d) {
  if (CLASSIC_NAMES[d.id]) return CLASSIC_NAMES[d.id];
  return `Винт #${d.id} (${d.parents ? `потомок #${d.parents[0]} и #${d.parents[1]}` : d === state.imported ? 'из файла' : 'из случайного стартового пула'})`;
}

function drawScoreInfo() {
  const d = state.shown, a = state.analysis, r = REF_ANALYSIS;
  let html = `<div>${whoIs(d)} · класс: <b>${CLASS_NAMES[d.cls]}</b> · оценка <b>${d.score.toFixed(2)}</b></div>`;
  if (!a.pushes) {
    $('score-info').innerHTML = html + '<p class="muted">Винт не создаёт упора, равного сопротивлению лодки, ни на каких оборотах.</p>';
    return;
  }
  const n = a.noise, rn = r.noise;
  const row = (name, mine, ref, note) => `<tr><td>${name}</td><td><b>${mine}</b></td><td>${ref}</td><td>${note}</td></tr>`;
  const limit = (x) => (x.torqueLimited ? 'момент мотора' : 'мощность');
  const sea = a.sea, rsea = r.sea;
  html += '<table class="score-table"><tr><th>Часть</th><th>Этот винт</th><th>Эталон</th><th>Что значит</th></tr>' +
    (sea ? row('Слышно на фоне моря', `с ${distance(sea.range)}`, `с ${distance(rsea.range)}`,
      `море ${SEA_STATES[state.setup.sea].name}, на патруле; выдаёт ${worstText(sea.worst)}; ` +
      `оценка считает разницу с эталоном в дБ: ${(rsea.excess - sea.excess).toFixed(1)} дБ; цель — не дальше ${distance(state.setup.range)}`) : '') +
    row('Шум на патруле', `${n.total.toFixed(1)} дБ`, `${rn.total.toFixed(1)} дБ`,
      `${SETUP.patrolSpeed} уз на глубине ${SETUP.depth} м (вал); сумма трёх источников ниже`) +
    row('· тоны лопастей', `${db(n.tonal)} дБ`, `${db(rn.tonal)} дБ`, 'лопасти проходят следы стабилизаторов: гудение на частоте Z·n') +
    row('· сплошной шум', `${db(n.broadband)} дБ`, `${db(rn.broadband)} дБ`, 'турбулентность у задней кромки, растёт как W⁵') +
    row('· кавитация', n.extent > 0 ? `${db(n.cavitation)} дБ` : 'нет', rn.extent > 0 ? `${db(rn.cavitation)} дБ` : 'нет',
      `вода закипает у лопасти; начинается с ${kn(n.inception)} уз (эталон ${kn(rn.inception)}): не раньше эталона, иначе −${SLOWER_WEIGHT} за узел`) +
    row('Полный ход', `${kn(a.vMax)} уз`, `${kn(r.vMax)} уз`,
      `${BOAT.power / 1e6} МВт и не больше ${BOAT.maxTorque / 1000} кН·м; упирается в: ${limit(a)}. КПД ${a.eta.toFixed(2)} (эталон ${r.eta.toFixed(2)})`) +
    row('Прочность', `${(a.stress / 1e6).toFixed(0)} МПа`, `${(r.stress / 1e6).toFixed(0)} МПа`,
      `худшее сечение на ${a.stressAt.toFixed(2)} R на полном ходу; предел ${STRESS_LIMIT / 1e6} МПа`) +
    row('Перекрытие', a.overlap.toFixed(2), r.overlap.toFixed(2), 'доля круга, занятая лопастями; больше 1 — лопасти налезают друг на друга') +
    '</table>' +
    `<div class="formula">оценка = 100 + ${NOISE_WEIGHT} × ${a.quieter.toFixed(1)} дБ ${sea ? 'тише на фоне моря' : 'тише'} ${a.speedPoints >= 0 ? '+' : '−'} ${Math.abs(a.speedPoints).toFixed(1)} за скорость` +
    (a.marginPoints < 0 ? ` − ${(-a.marginPoints).toFixed(1)} за раннюю кавитацию` : '') +
    (a.penalty > 0 ? ` − штраф ${a.penalty.toFixed(1)}` : '') + ` = <b>${a.raw.toFixed(2)}</b>` +
    (Math.abs(a.raw - d.score) > 0.01 ? ` → ${d.score.toFixed(2)} (ниже ${SCORE_FLOOR} оценка плавно прижимается к нулю: 100 / (20 − x))` : '') + '</div>' +
    `<p class="note">Скорость: +${SPEED_WEIGHT} за узел сверх эталона, −${SLOWER_WEIGHT} за узел недобора. ` +
    `${a.faster >= 0 ? 'Быстрее' : 'Медленнее'} эталона на ${Math.abs(a.faster).toFixed(2)} уз.</p>`;
  $('score-info').innerHTML = html;
}

function drawGenome() {
  const d = state.shown, g = d.genome, a = state.analysis;
  const c = $('profile-canvas');
  drawPropeller(c.getContext('2d'), g, c.width, c.height, false);
  const list = (xs, f) => xs.map(f).join(' · ');
  $('genome-info').innerHTML = '<table>' +
    `<tr><th>Лопастей</th><td>${g.blades}</td></tr>` +
    `<tr><th>Диаметр</th><td>${propDiameter(g).toFixed(2)} м (${(g.diameter * 100).toFixed(0)}% от наибольшего ${BOAT.maxDiameter} м)</td></tr>` +
    `<tr><th>Шаг P/D от ступицы к концу</th><td>${list(g.pitch, (x) => x.toFixed(2))}</td></tr>` +
    `<tr><th>Ширина c/D</th><td>${list(g.chord, (x) => x.toFixed(3))}</td></tr>` +
    `<tr><th>Изгиб профиля f/c (у ступицы, середина, конец)</th><td>${list(g.camber, (x) => x.toFixed(3))}</td></tr>` +
    `<tr><th>Толщина t/c</th><td>${list(g.thickness, (x) => x.toFixed(3))}</td></tr>` +
    `<tr><th>Откос на ⅓, ⅔ и конце</th><td>${list(g.skew, (x) => `${x.toFixed(0)}°`)}</td></tr>` +
    `<tr><th>Насадка (pump-jet)</th><td>${g.duct ? `есть: длина ${g.ductLength.toFixed(2)} D, поток у ротора ${(g.slowdown * 100).toFixed(0)}%, статор ${g.stators} лопаток`
      : `нет <span class="muted">(дремлющие гены: длина ${g.ductLength.toFixed(2)} D, поток ${(g.slowdown * 100).toFixed(0)}%, статор ${g.stators})</span>`}</td></tr>` +
    (a.pushes ? `<tr><th>Дисковое отношение (площадь лопастей / круг)</th><td>${a.area.toFixed(2)}</td></tr>` +
      `<tr><th>На патруле</th><td>${a.rpm.toFixed(0)} об/мин, J ${a.J.toFixed(2)}, ${(a.power / 1000).toFixed(0)} кВт</td></tr>` +
      `<tr><th>Полный ход</th><td>${a.rpmMax.toFixed(0)} об/мин</td></tr>` : '') +
    '</table>';
  if (a.pushes) {
    const cc = $('curves-canvas');
    drawCurves(cc.getContext('2d'), a, cc.width, cc.height);
  }
}

function drawSpecies() {
  const rows = state.evo.speciesTable();
  const on = state.evo.cfg.speciation;
  let html = on ? '' : '<div class="muted">Виды выключены: турнир идёт по всему пулу, квот нет. Таблица — просто состав пула.</div>';
  html += `<table><tr><th></th><th>Вид</th><th>Винтов</th>${on ? '<th>Квота</th>' : ''}<th>Лучший</th></tr>`;
  for (const r of rows) {
    const mark = r.key === state.pinnedSpecies && $('view-source').value === 'species' ? ' ◀' : '';
    html += `<tr class="clickable" data-key="${r.key}"><td><canvas width="56" height="56" class="mini"></canvas></td>` +
      `<td>${speciesName(r.key)}</td><td>${r.size}</td>` + (on ? `<td>${r.quota.toFixed(0)}</td>` : '') +
      `<td>${r.best.score.toFixed(1)} · ${CLASS_NAMES[r.best.cls]}${r.best.range !== undefined ? ` · слышно с ${distance(r.best.range)}` : r.best.noise !== undefined ? ` · ${r.best.noise.toFixed(1)} дБ` : ''}${mark}</td></tr>`;
  }
  $('species-info').innerHTML = html + '</table>';
  $('species-info').querySelectorAll('canvas.mini').forEach((cv, i) => drawPropeller(cv.getContext('2d'), rows[i].best.genome, cv.width, cv.height, true));
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, ${c.species} лоп., оценка ${c.score.toFixed(2)}` +
    (c.noise !== undefined ? ` (шум ${c.noise.toFixed(1)} дБ${c.range !== undefined ? `, слышно с ${distance(c.range)}` : ''}, полный ход ${kn(c.vMax)} уз)` : '');
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
const onCondition = () => { updateCondition(); drawCharts(); drawLive(); PropellerSound.update(state.analysis, state.cond); };
$('btn-sound').onclick = () => {
  const on = PropellerSound.toggle();
  $('btn-sound').classList.toggle('active', on);
  PropellerSound.update(state.analysis, state.cond);
};
$('speed').oninput = onCondition;
$('depth').oninput = onCondition;
$('cfg-goal').onchange = () => { $('sea-settings').hidden = $('cfg-goal').value !== 'sea'; };
$('btn-patrol').onclick = () => { $('speed').value = SETUP.patrolSpeed; $('depth').value = SETUP.depth; onCondition(); };
$('btn-full').onclick = () => {
  if (state.analysis && state.analysis.pushes) $('speed').value = (state.analysis.vMax / KNOT).toFixed(1);
  $('depth').value = 150;
  onCondition();
};
$('species-info').onclick = (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  state.pinnedSpecies = Number(tr.dataset.key);
  const opt = $('view-source').querySelector('option[value=species]');
  opt.disabled = false;
  opt.textContent = `Лучший винт вида: ${speciesName(state.pinnedSpecies)}`;
  $('view-source').value = 'species';
  offerShown(pickShown(), true);
  drawSpecies();
};

$('btn-export').onclick = () => {
  const d = state.shown;
  const data = {
    about: `Submarine propeller, largest diameter ${BOAT.maxDiameter} m, hub ${BOAT.hubRatio} of the diameter. ` +
      'blades; diameter (share of the largest); pitch P/D and chord c/D: 5 points hub..tip; camber f/c and thickness t/c: ' +
      '3 points hub, middle, tip; skew (deg, swept back against the rotation) at 1/3, 2/3 of the span and at the tip; ' +
      'duct (0 open, 1 pump-jet), ductLength (/ diameter), slowdown (water speed at the rotor / without the ring), stators.',
    score: d.score,
    referenceScore: REFERENCE_SCORE,
    noise: d.noise,
    topSpeedKnots: d.vMax / KNOT,
    genome: d.genome,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `propeller-${d.id}.json`;
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
    const genome = {
      blades: Math.round(clampTo(g.blades, RANGES.blades)),
      diameter: clampTo(g.diameter, RANGES.diameter),
      pitch: nums(g.pitch, PITCH_POINTS, 'pitch', RANGES.pitch),
      chord: nums(g.chord, CHORD_POINTS, 'chord', RANGES.chord),
      camber: nums(g.camber, SECTION_POINTS, 'camber', RANGES.camber),
      thickness: nums(g.thickness, SECTION_POINTS, 'thickness', RANGES.thickness),
      skew: nums(g.skew, SKEW_POINTS, 'skew', RANGES.skew),
      // pump-jet genes are optional (files of the first version have none)
      duct: g.duct ? 1 : 0,
      ductLength: Number.isFinite(g.ductLength) ? clampTo(g.ductLength, RANGES.ductLength) : NO_DUCT.ductLength,
      slowdown: Number.isFinite(g.slowdown) ? clampTo(g.slowdown, RANGES.slowdown) : NO_DUCT.slowdown,
      stators: Number.isFinite(g.stators) ? Math.round(clampTo(g.stators, RANGES.stators)) : NO_DUCT.stators,
    };
    state.imported = { id: 'file', genome, ...evaluatePropeller(genome, state.setup), parents: null };
    $('view-source').querySelector('option[value=imported]').disabled = false;
    $('view-source').value = 'imported';
    offerShown(state.imported, true);
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
  e.target.value = '';
};

$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');
$('speed').value = SETUP.patrolSpeed;
$('depth').value = SETUP.depth;

// The 3D view is an ES module: it may come after this script, or not at all (file://).
function start3d() {
  if (state.view3d || !window.View3D) return;
  state.view3d = window.View3D.create($('view3d'));
  state.staticView = window.View3D.createStatic($('static3d'));
  if (state.shown) {
    state.view3d.setPropeller(state.shown.genome, state.analysis);
    state.staticView.setPropeller(state.shown.genome);
  }
}
$('btn-static-reset').onclick = () => {
  if (!state.staticView || !state.shown) return;
  state.staticView.resetView();
  state.staticView.setPropeller(state.shown.genome);
};
window.addEventListener('view3d-ready', start3d);
start3d();
setTimeout(() => {
  if (!state.view3d) {
    $('view3d').innerHTML = '<div class="fallback">3D-вид не загрузился. Страницу нужно открыть через http-сервер, ' +
      'а не двойным кликом: из папки genetic запустить «python3 -m http.server 8765» и открыть http://localhost:8765/propeller/</div>';
  }
}, 3000);
if (!evaluator.parallel) {
  state.progress = 'Фоновые потоки недоступны (страница открыта как файл): считаю в основном потоке, медленнее.';
}

show(CLASSICS.reference);
requestAnimationFrame(frame);
reset();
