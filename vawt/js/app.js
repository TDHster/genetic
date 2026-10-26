'use strict';
// UI wiring: buttons, workers, the turning rotor on screen, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

// Rotors that are not in the pool: the classic designs (scored here, on the main thread).
const named = (id, genome) => ({ id, genome: copyRotor(genome), ...evaluateRotor(genome), parents: null });
const CLASSICS = {
  reference: named('ref', REFERENCE),
  gorlov: named('gorlov', GORLOV),
  egg: named('egg', EGG_BEATER),
};
const CLASSIC_NAMES = { ref: 'Эталон: H-ротор', gorlov: 'Спираль Горлова', egg: '«Взбивалка» Дарье' };
const REF_ANALYSIS = analyzeRotor(REFERENCE, true);

const BLADE_DENSITY = 6;   // kg per m² of blade (hollow aluminium / fibreglass) - for the start from rest only
const START_LOG_EVERY = 0.25;

const state = {
  evo: null,
  token: 0,             // changes on every reset: results of an old run are thrown away
  running: false,
  busy: false,
  shown: null,          // rotor on screen
  analysis: null,       // analyzeRotor(shown.genome, true)
  pendingShown: null,   // a new best waits until the start from rest is over
  lastShownAt: 0,
  lastStep: null,
  imported: null,
  pinnedSpecies: null,
  stopReason: null,
  autoStopOff: false,
  rate: 0,
  view3d: null,
  progress: '',
  live: null,           // the turning rotor: { mode, psi, omega, t, history, connected, status }
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
    w.postMessage({ id, genome });
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
          if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // let the page breathe
          finish(k, evaluateRotor(genomes[k]));
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
  const evo = new Evolution(readConfig());
  const genomes = evo.firstGenomes();
  const results = await evaluator.all(genomes, (done, total) => {
    if (token !== state.token) return;
    state.progress = `Стартовый пул: посчитано ${done} из ${total} роторов…`;
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

// ---- The rotor on screen ----

function pickShown() {
  const evo = state.evo, src = $('view-source').value;
  if (CLASSICS[src]) return CLASSICS[src];
  if (src === 'imported' && state.imported) return state.imported;
  if (!evo) return CLASSICS.reference;
  if (src === 'child' && state.lastStep) return state.lastStep.child;
  if (src === 'loser' && state.lastStep) return state.lastStep.loser;
  if (src === 'species' && state.pinnedSpecies !== null) {
    const row = evo.speciesTable().find((r) => r.blades === state.pinnedSpecies);
    if (row) return row.best;
  }
  return evo.best();
}

function show(rotor) {
  state.shown = rotor;
  state.pendingShown = null;
  state.lastShownAt = performance.now();
  state.analysis = analyzeRotor(rotor.genome, true);
  state.inertia = rotorInertia(rotor.genome);
  if (state.view3d) state.view3d.setRotor(rotor.genome, state.analysis);
  const mode = state.live ? state.live.mode : 'run';
  startLive(mode);
  drawScoreInfo();
  drawGenome();
}

// A new rotor to show: right away if the viewer asked for it; a new best - not during a start from rest
// and not more often than once a second (otherwise the picture would flicker early in a run).
function offerShown(rotor, now) {
  if (!state.shown || now) { show(rotor); return; }
  if (rotor.id === state.shown.id) return;
  state.pendingShown = rotor;
}

function rotorInertia(g) {
  let inertia = 0;
  const dz = BOX.height / SHAPE_STATIONS;
  for (let k = 0; k < SHAPE_STATIONS; k++) {
    const p = bladePoint(g, (k + 0.5) / SHAPE_STATIONS);
    const mass = BLADE_DENSITY * p.c * dz * Math.sqrt(1 + p.drdz * p.drdz + p.helix * p.helix);
    inertia += mass * p.r * p.r;
  }
  for (const r of strutRadii(g)) inertia += BLADE_DENSITY * STRUT_CHORD * r * r * r / 3;
  return g.blades * inertia + 0.5; // + shaft and generator
}

const wind = () => Number($('wind').value);

// Working point at the wind v: the λ the controller holds (from the power curve) and the power.
function workingPoint(v) {
  const p = state.analysis.power.reduce((best, x) => (Math.abs(x.v - v) < Math.abs(best.v - v) ? x : best));
  return p;
}

// Torque of the rotor (N·m) at rotor speed omega and angle psi, wind v: bilinear in the table.
function aeroTorque(omega, psi, v) {
  const t = state.analysis.table;
  const f = Math.min(LAMBDAS.length - 1.001, Math.max(0, omega * BOX.radius / v / AERO.lambdaStep));
  const i = Math.floor(f), u = f - i;
  const q = atAzimuth(t.cq[i], psi) * (1 - u) + atAzimuth(t.cq[i + 1], psi) * u;
  return q * TORQUE_UNIT * v * v;
}

function startLive(mode) {
  const v = wind();
  const work = workingPoint(v);
  const omega = mode === 'run' ? work.lambda * v / BOX.radius : 0;
  let psi = state.live ? state.live.psi : 0;
  if (mode === 'start') {
    // The start from rest begins in the luckiest position of the rotor (the score takes the worst one):
    // then a rotor that moves at all shows where it gets stuck.
    const rest = state.analysis.table.cq[0];
    psi = tubeTheta(rest.indexOf(Math.max(...rest)));
  }
  state.live = { mode, psi, psi0: psi, omega, t: 0, history: [], connected: mode === 'run', status: '', lastLog: -1 };
  $('btn-mode-run').classList.toggle('active', mode === 'run');
  $('btn-mode-start').classList.toggle('active', mode === 'start');
  $('spinup-wrap').style.display = mode === 'start' ? '' : 'none';
}

// Model time step of the turning rotor.
function stepLive(dt) {
  const live = state.live, v = wind();
  const work = workingPoint(v);
  const omegaWork = work.lambda * v / BOX.radius;
  if (live.mode === 'run') {
    // The controller holds the working λ (a starter motor helped, if needed); it eases to a new wind.
    live.omega += (omegaWork - live.omega) * Math.min(1, dt * 1.5);
    live.psi += live.omega * dt;
    live.t += dt;
    live.status = omegaWork > 0 ? 'работает' : 'не даёт энергии при этом ветре';
    return;
  }
  // The start from rest: I·dω/dt = aerodynamic torque − friction (the generator waits for the working speed).
  const h = 0.02;
  for (let tLeft = dt; tLeft > 1e-9; tLeft -= h) {
    const step = Math.min(h, tLeft);
    const q = aeroTorque(live.omega, live.psi, v);
    if (live.omega <= 1e-4 && q <= FRICTION) {
      live.omega = 0; // friction holds it (a negative torque does not turn it backwards: friction again)
    } else {
      live.omega = Math.max(0, live.omega + step * (q - FRICTION) / state.inertia);
      // The generator is off until the working speed; then the controller holds it there and takes the rest of the torque.
      if (omegaWork > 0 && live.omega >= omegaWork) { live.omega = omegaWork; live.connected = true; }
    }
    live.psi += live.omega * step;
    live.t += step;
    if (live.t - live.lastLog >= START_LOG_EVERY) {
      live.lastLog = live.t;
      live.history.push({ t: live.t, rpm: live.omega * 60 / (2 * Math.PI) });
    }
  }
  const lambda = live.omega * BOX.radius / v;
  const hist = live.history;
  const ago = hist.length > 40 ? hist[hist.length - 41].rpm : null; // 10 s ago
  const rpm = live.omega * 60 / (2 * Math.PI);
  if (live.connected) live.status = '<b class="good">вышел на рабочий режим, генератор включён</b>';
  else if (live.omega === 0) {
    const turned = (live.psi - live.psi0) * 180 / Math.PI;
    live.status = live.t < 2 ? 'стоит' : turned < 1
      ? '<b class="bad">не трогается с места: ветер не пересиливает трение</b>'
      : `<b class="bad">повернулся на ${turned.toFixed(0)}° и встал: в этом положении момент меньше трения</b>`;
  }
  else if (ago !== null && Math.abs(rpm - ago) < 0.2 && lambda < 0.8 * work.lambda) {
    live.status = `<b class="bad">застрял на λ ≈ ${lambda.toFixed(1)}: «мёртвая зона» — лопасти в срыве, момента не хватает на разгон</b>`;
  } else live.status = 'разгоняется';
}

function aeroTorqueMean(omega, v) {
  const t = state.analysis.table;
  const f = Math.min(LAMBDAS.length - 1.001, omega * BOX.radius / v / AERO.lambdaStep);
  const i = Math.floor(f), u = f - i;
  return (t.cqMean[i] * (1 - u) + t.cqMean[i + 1] * u) * TORQUE_UNIT * v * v;
}

let lastFrame = performance.now(), lastCharts = 0;
function frame(time) {
  const dt = Math.min(0.1, (time - lastFrame) / 1000);
  lastFrame = time;
  if (state.live && state.analysis) {
    const modelDt = dt * Number($('time-scale').value);
    stepLive(modelDt);
    const v = wind(), live = state.live;
    const li = lambdaIndex(live.omega * BOX.radius / v);
    if (state.view3d) state.view3d.render({ psi: live.psi, li, v, dt: modelDt });
    if (time - lastCharts > 90) { lastCharts = time; drawCharts(); drawLive(); }
    // a new best: shown when the start from rest is not running, at most once a second
    if (state.pendingShown && (live.mode === 'run' || live.connected || live.t > 600) && time - state.lastShownAt > 1000) {
      show(state.pendingShown);
    }
  } else if (state.view3d) state.view3d.render(null);
  requestAnimationFrame(frame);
}

function drawCharts() {
  const a = state.analysis, g = state.shown.genome, live = state.live, v = wind();
  const lambda = live.omega * BOX.radius / v;
  const c = (id) => { const el = $(id); return [el.getContext('2d'), el.width, el.height]; };
  let [ctx, w, h] = c('torque-canvas');
  drawTorque(ctx, a, g, lambda, v, live.psi, w, h);
  [ctx, w, h] = c('cp-canvas');
  drawCp(ctx, a, REF_ANALYSIS, lambda, w, h);
  [ctx, w, h] = c('start-canvas');
  drawStart(ctx, a, REF_ANALYSIS, v, w, h);
  [ctx, w, h] = c('power-canvas');
  drawPower(ctx, a, REF_ANALYSIS, v, w, h);
  if (live.mode === 'start') {
    [ctx, w, h] = c('spinup-canvas');
    const work = workingPoint(v);
    drawSpinUp(ctx, live.history, work.lambda * v / BOX.radius * 60 / (2 * Math.PI), w, h);
  }
}

function drawLive() {
  const live = state.live, v = wind();
  const lambda = live.omega * BOX.radius / v;
  const rpm = live.omega * 60 / (2 * Math.PI);
  const q = live.omega > 0 ? aeroTorqueMean(live.omega, v) : 0;
  const p = Math.max(0, (q - FRICTION) * live.omega);
  const own = 0.5 * AIR.rho * state.analysis.swept * v ** 3;
  let text = `ветер <b>${v} м/с</b> · ${rpm.toFixed(0)} об/мин · λ ${lambda.toFixed(2)} · ` +
    `конец лопасти ${(live.omega * state.analysis.tipRadius).toFixed(1)} м/с`;
  if (live.mode === 'run' || live.connected) text += ` · мощность <b>${p.toFixed(0)} Вт</b> (Cp ${(p / own).toFixed(2)})`;
  text += ` · ${live.status}`;
  if (live.mode === 'start') {
    const rest = state.analysis.table.cq[0].map((c) => c * TORQUE_UNIT * v * v);
    text += ` · t = ${live.t.toFixed(0)} с · ротор поставлен в самое удачное положение (момент в покое ${Math.max(...rest).toFixed(2)} Н·м; ` +
      `в худшем ${Math.min(...rest).toFixed(2)} Н·м, трение ${FRICTION} Н·м)`;
  }
  if (live.mode === 'run' && !state.analysis.selfStart) text += ' · <span class="muted">сам не стартует: раскручен пусковым мотором</span>';
  else if (live.mode === 'run' && v < state.analysis.vStart) text += ` · <span class="muted">сам стартует только с ${state.analysis.vStart.toFixed(1)} м/с</span>`;
  if (state.pendingShown && live.mode === 'start') text += ' · <span class="muted">после пуска покажу новый лучший ротор</span>';
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
    document.title = 'Стартовый пул… — Ветряк';
    return;
  }
  // The tab title shows the stage of evolution, so it can be watched from another tab.
  document.title = `${state.running ? '▶ ' : ''}Поколение ${Math.floor(evo.generation)} · ${evo.bestScore.toFixed(1)} — Ветряк`;
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${state.rate.toFixed(0)} роторов/с (${evaluator.parallel || 'нет'} потоков)` : '') +
    ` · лучшая оценка <b>${evo.bestScore.toFixed(2)}</b> (эталон ${REFERENCE_SCORE.toFixed(2)})` +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

const kwh = (x) => `${x.toFixed(0)} кВт·ч`;
const startText = (x) => (x.selfStart ? `сам с ${x.vStart.toFixed(1)} м/с` : x.vStart < Infinity ? `мотором (сам — только с ${x.vStart.toFixed(1)} м/с)` : 'мотором (сам не стартует)');

function whoIs(d) {
  if (CLASSIC_NAMES[d.id]) return CLASSIC_NAMES[d.id];
  return `Ротор #${d.id} (${d.parents ? `потомок #${d.parents[0]} и #${d.parents[1]}` : d === state.imported ? 'из файла' : 'из случайного стартового пула'})`;
}

function drawScoreInfo() {
  const d = state.shown, r = CLASSICS.reference, a = state.analysis;
  let html = `<div>${whoIs(d)} · класс: <b>${CLASS_NAMES[d.cls]}</b> · оценка <b>${d.score.toFixed(2)}</b>` +
    ` · ${(100 * d.score / REFERENCE_SCORE).toFixed(0)}% от эталона</div>`;
  if (d.cls === 0) {
    $('score-info').innerHTML = html + `<p class="muted">Ротор не даёт энергии ни при каком ветре: сопротивление больше подъёмной силы
      (лучший Cp ${a.cpMax.toFixed(3)}). Оценка меньше 1 — чем ближе к 1, тем ближе к «крутится».</p>`;
    return;
  }
  const row = (name, mine, ref, note) => `<tr><td>${name}</td><td><b>${mine}</b></td><td>${ref}</td><td>${note}</td></tr>`;
  html += '<table class="score-table"><tr><th>Часть</th><th>Этот ротор</th><th>Эталон</th><th>Что значит</th></tr>' +
    row('Энергия за год', kwh(d.aepAll), kwh(r.aepAll), `если бы ротор всегда крутился; ветер по Вейбуллу, в среднем ${SITE.meanWind} м/с; конец лопасти не быстрее ${TIP_SPEED} м/с`) +
    row('Старт', `${startText(d)} → ${kwh(d.aep)}`, `${startText(r)} → ${kwh(r.aep)}`,
      `сам: считаются только ветры от скорости самозапуска; с пусковым мотором: × ${MOTOR_START} от всей энергии (берётся что больше)`) +
    row('Плавность', `пульсация ${d.ripple.toFixed(2)} → ${d.smoothness.toFixed(2)}`, `пульсация ${r.ripple.toFixed(2)} → ${r.smoothness.toFixed(2)}`,
      `(макс − мин) / среднее момента за оборот; 1 − ${RIPPLE_WEIGHT} × min(1, пульсация / ${RIPPLE_REF})`) +
    row('Материал', `${d.area.toFixed(2)} м² → ${d.material.toFixed(2)}`, `${r.area.toFixed(2)} м² → ${r.material.toFixed(2)}`,
      'площадь лопастей и траверс; бюджет — как у эталона, больше — пропорционально хуже') +
    '</table>' +
    `<div class="formula">оценка = 1 + ${d.aep.toFixed(0)} × ${d.smoothness.toFixed(2)} × ${d.material.toFixed(2)} / 100 = <b>${d.score.toFixed(2)}</b></div>` +
    `<p class="note">Лучший Cp ${a.cpOwn.toFixed(3)} (по своей ометаемой площади ${a.swept.toFixed(2)} м²) при λ ${a.lambdaOpt}. ` +
    `Самый слабый момент на разгоне: ${a.weakestAt === 0 ? 'в покое, в худшем положении' : `при λ ${a.weakestAt}`}.</p>`;
  $('score-info').innerHTML = html;
}

function drawGenome() {
  const d = state.shown, g = d.genome, a = state.analysis;
  const c = $('profile-canvas');
  drawProfile(c.getContext('2d'), g, c.width, c.height, false);
  const struts = strutRadii(g);
  const m = (x) => `${(x * BOX.radius).toFixed(2)}`;
  const solidity = g.blades * (g.chord[1]) / bladePoint(g, 0.5).r;
  $('genome-info').innerHTML = '<table>' +
    `<tr><th>Лопастей</th><td>${g.blades}</td></tr>` +
    `<tr><th>Радиус снизу вверх, м</th><td>${g.radius.map(m).join(' · ')}</td></tr>` +
    `<tr><th>Хорда снизу, посередине, сверху, м</th><td>${g.chord.map((x) => x.toFixed(3)).join(' · ')}</td></tr>` +
    `<tr><th>Закрутка (спираль)</th><td>${g.twist.toFixed(0)}° за высоту ротора${g.blades ? ` (${(g.twist / (360 / g.blades) * 100).toFixed(0)}% от угла между лопастями)` : ''}</td></tr>` +
    `<tr><th>Установочный угол</th><td>${g.pitch.toFixed(1)}° (плюс — носок внутрь)</td></tr>` +
    `<tr><th>Профиль</th><td>NACA 00${Math.round(g.thickness * 100)}</td></tr>` +
    `<tr><th>Траверсы</th><td>${struts.length ? `${struts.length * g.blades} шт.` : 'не нужны: концы лопастей у вала'}</td></tr>` +
    `<tr><th>Заполнение σ = B·c/R посередине</th><td>${solidity.toFixed(2)}</td></tr>` +
    `<tr><th>Ометаемая площадь</th><td>${a.swept.toFixed(2)} м² (габарит ${BOX_AREA.toFixed(1)} м²)</td></tr>` +
    '</table>';
}

function drawSpecies() {
  const rows = state.evo.speciesTable();
  const on = state.evo.cfg.speciation;
  let html = on ? '' : '<div class="muted">Виды выключены: турнир идёт по всему пулу, квот нет. Таблица — просто состав пула.</div>';
  html += `<table><tr><th></th><th>Лопастей</th><th>Роторов</th>${on ? '<th>Квота</th>' : ''}<th>Лучший</th></tr>`;
  for (const r of rows) {
    const mark = r.blades === state.pinnedSpecies && $('view-source').value === 'species' ? ' ◀' : '';
    html += `<tr class="clickable" data-blades="${r.blades}"><td><canvas width="48" height="56" class="mini"></canvas></td>` +
      `<td>${r.blades}</td><td>${r.size}</td>` + (on ? `<td>${r.quota.toFixed(0)}</td>` : '') +
      `<td>${r.best.score.toFixed(1)} · ${CLASS_NAMES[r.best.cls]}${mark}</td></tr>`;
  }
  $('species-info').innerHTML = html + '</table>';
  $('species-info').querySelectorAll('canvas.mini').forEach((cv, i) => drawProfile(cv.getContext('2d'), rows[i].best.genome, cv.width, cv.height, true));
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, ${c.species} лоп., оценка ${c.score.toFixed(2)}` +
    (c.cls > 0 ? ` (${c.aep.toFixed(0)} кВт·ч, старт ${c.selfStart ? `сам с ${c.vStart.toFixed(1)} м/с` : 'мотором'}, Cp ${c.cpOwn.toFixed(2)})` : '');
  const head = s.parentSpecies !== null
    ? [`Родителей выбрали в виде «${s.parentSpecies} лоп.» (вид берётся с вероятностью по квоте),`,
      `погибший — из вида «${s.deathSpecies} лоп.» (он сильнее всех превысил квоту).`, '']
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
$('btn-mode-run').onclick = () => { startLive('run'); $('time-scale').value = '1'; };
$('btn-mode-start').onclick = () => { startLive('start'); $('time-scale').value = '10'; };
$('wind').oninput = () => {
  $('wind-out').textContent = `${wind()} м/с`;
  if (state.live && state.live.mode === 'start') startLive('start');
};
$('species-info').onclick = (e) => {
  const tr = e.target.closest('tr[data-blades]');
  if (!tr) return;
  state.pinnedSpecies = Number(tr.dataset.blades);
  const opt = $('view-source').querySelector('option[value=species]');
  opt.disabled = false;
  opt.textContent = `Лучший ротор вида: ${state.pinnedSpecies} лоп.`;
  $('view-source').value = 'species';
  offerShown(pickShown(), true);
  drawSpecies();
};

$('btn-export').onclick = () => {
  const d = state.shown;
  const data = {
    about: `Vertical-axis wind turbine rotor in a box ${BOX.height} m high, radius ${BOX.radius} m. ` +
      'blades; radius: 5 points bottom..top (share of the box radius); chord: 3 points bottom, middle, top (m); ' +
      'twist (deg around the shaft, bottom to top); pitch (deg, + = nose in); thickness (t/c of NACA 00xx).',
    score: d.score,
    referenceScore: REFERENCE_SCORE,
    aep: d.aep,
    genome: d.genome,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `vawt-${d.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const g = data.genome;
    const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));
    const nums = (list, n, name) => {
      if (!Array.isArray(list) || list.length !== n || !list.every(Number.isFinite)) throw new Error(`поле ${name}: нужно ${n} чисел`);
      return list;
    };
    if (!g) throw new Error('нет поля genome');
    for (const key of ['blades', 'twist', 'pitch', 'thickness']) if (!Number.isFinite(g[key])) throw new Error(`нет поля ${key}`);
    const genome = {
      blades: Math.round(clamp(g.blades, RANGES.blades)),
      radius: nums(g.radius, RADIUS_POINTS, 'radius').map((x) => clamp(x, RANGES.radius)),
      chord: nums(g.chord, CHORD_POINTS, 'chord').map((x) => clamp(x, RANGES.chord)),
      twist: clamp(g.twist, RANGES.twist),
      pitch: clamp(g.pitch, RANGES.pitch),
      thickness: clamp(g.thickness, RANGES.thickness),
    };
    state.imported = { id: 'file', genome, ...evaluateRotor(genome), parents: null };
    $('view-source').querySelector('option[value=imported]').disabled = false;
    $('view-source').value = 'imported';
    offerShown(state.imported, true);
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
  e.target.value = '';
};

$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');
$('wind-out').textContent = `${wind()} м/с`;

// The 3D view is an ES module: it may come after this script, or not at all (file://).
function start3d() {
  if (state.view3d || !window.View3D) return;
  state.view3d = window.View3D.create($('view3d'));
  if (state.shown) state.view3d.setRotor(state.shown.genome, state.analysis);
}
window.addEventListener('view3d-ready', start3d);
start3d();
setTimeout(() => {
  if (!state.view3d) {
    $('view3d').innerHTML = '<div class="fallback">3D-вид не загрузился. Страницу нужно открыть через http-сервер, ' +
      'а не двойным кликом: из папки genetic запустить «python3 -m http.server 8765» и открыть http://localhost:8765/vawt/</div>';
  }
}, 3000);
if (!evaluator.parallel) {
  state.progress = 'Фоновые потоки недоступны (страница открыта как файл): считаю в основном потоке, медленнее.';
}

show(CLASSICS.reference);
requestAnimationFrame(frame);
reset();
