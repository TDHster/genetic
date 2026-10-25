'use strict';
// UI wiring: buttons, the main loop, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

// Jansen's leg, rescored on every reset (the optional rules may have changed).
let JANSEN_LEG = null;
function scoreJansen() {
  JANSEN_LEG = { id: 0, genome: copyLeg(JANSEN), ...evaluateLeg(JANSEN), parents: null };
}

const state = {
  evo: null,
  running: false,
  shown: null,
  shownId: null,
  lastStep: null,
  imported: null,
  angle: 0,             // crank angle for the animation
  lastFrame: performance.now(),
  rate: 0,
  pinnedSpecies: null,  // species picked in the species table
  stopReason: null,
  autoStopOff: false,   // Start pressed after an auto-stop: keep going until Reset
};

function readConfig() {
  return {
    seed: Number($('cfg-seed').value) || 1,
    populationSize: Number($('cfg-pop').value),
    mode: $('cfg-mode').value,
    speciation: $('cfg-species').checked,
    // Optional rules: weight 0..1, 0 when switched off.
    fitness: {
      height: $('fit-height-on').checked ? Number($('fit-height').value) / 100 : 0,
      angle: $('fit-angle-on').checked ? Number($('fit-angle').value) / 100 : 0,
      compact: $('fit-compact-on').checked ? Number($('fit-compact').value) / 100 : 0,
    },
    mutationsPerChild: Math.max(1, Number($('cfg-mut').value) || 1),
  };
}

function readStopRules() {
  const on = (id) => $(id).checked;
  return {
    // A tiny epsilon so "0%" means "strictly better than Jansen".
    beatJansen: on('stop-jansen-on') ? Math.max(1e-9, Number($('stop-jansen').value) / 100) : 0,
    stagnation: on('stop-stag-on') ? Number($('stop-stag').value) : 0,
    maxGenerations: on('stop-max-on') ? Number($('stop-max').value) : 0,
  };
}

function reset() {
  state.evo = new Evolution(readConfig());
  scoreJansen();
  state.lastStep = null;
  state.stopReason = null;
  state.autoStopOff = false;
  $('step-log').textContent = 'Нажми «1 спаривание», чтобы увидеть один шаг эволюции подробно.';
  refreshPanels(true);
}

function setRunning(on) {
  if (on && state.stopReason) state.autoStopOff = true;
  state.running = on;
  $('btn-run').textContent = on ? '⏸ Пауза' : '▶ Старт';
}

// ---- Main loop ----
function frame(now) {
  const dt = Math.min(0.1, (now - state.lastFrame) / 1000);
  state.lastFrame = now;
  state.angle += dt * 2 * Math.PI * Number($('crank-speed').value);

  if (state.running) {
    const start = performance.now();
    while (state.running && performance.now() - start < 25) {
      for (let i = 0; i < 20; i++) state.lastStep = state.evo.step();
      const reason = state.autoStopOff ? null : state.evo.stopReason(readStopRules());
      if (reason) {
        state.stopReason = reason;
        setRunning(false);
        refreshPanels(true);
      }
    }
  }
  refreshPanels(false);
  requestAnimationFrame(frame);
}

let lastSlowRefresh = 0;
let lastMatings = 0;
function refreshPanels(force) {
  const now = performance.now();
  if (force || now - lastSlowRefresh > 300) {
    const seconds = (now - lastSlowRefresh) / 1000;
    if (state.running && !force && seconds > 0) state.rate = (state.evo.matings - lastMatings) / seconds;
    lastMatings = state.evo.matings;
    lastSlowRefresh = now;

    state.shown = pickShownLeg();
    state.walkerLeg = state.evo.best(); // the walker always shows the best leg of the pool
    drawStats();
    drawSpecies();
    const c = $('chart-canvas');
    drawPopulationChart(c.getContext('2d'), state.evo.history.concat([state.evo.snapshot()]), c.width, c.height);
    if (force || state.shown.id !== state.shownId) {
      state.shownId = state.shown.id;
      drawLegInfo();
      drawScoreInfo();
      drawBars();
    }
  }
  const wc = $('walker-canvas');
  drawWalker(wc.getContext('2d'), state.walkerLeg, state.angle, wc.width, wc.height);
  const c = $('leg-canvas');
  const compare = $('show-jansen').checked && state.shown !== JANSEN_LEG ? JANSEN_LEG : null;
  drawLeg(c.getContext('2d'), state.shown, state.angle, c.width, c.height, compare);
}

function pickShownLeg() {
  const source = $('view-source').value;
  if (source === 'jansen') return JANSEN_LEG;
  if (source === 'imported' && state.imported) return state.imported;
  if (source === 'child' && state.lastStep) return state.lastStep.child;
  if (source === 'loser' && state.lastStep) return state.lastStep.loser;
  if (source === 'species') {
    const row = state.evo.speciesTable().find((r) => r.links === state.pinnedSpecies);
    if (row) return row.best;
  }
  return state.evo.best();
}

// ---- Panels ----
function drawStats() {
  const evo = state.evo;
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${Math.round(state.rate).toLocaleString('ru')}/с` : '') +
    ` · лучшая оценка <b>${evo.bestScore.toFixed(2)}</b> (Янсен ${JANSEN_SCORE.toFixed(2)})` +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

function drawLegInfo() {
  const leg = state.shown;
  const who = leg === JANSEN_LEG ? 'Нога Янсена'
    : `Нога #${leg.id} (${leg.parents ? `потомок #${leg.parents[0]} и #${leg.parents[1]}` : 'из случайного начального пула'})`;
  const vs = leg === JANSEN_LEG ? '' : ` · ${(100 * leg.score / JANSEN_SCORE).toFixed(0)}% от Янсена`;
  $('leg-info').innerHTML = `<div>${who} · класс: <b>${CLASS_NAMES[leg.cls]}</b> · оценка <b>${leg.score.toFixed(3)}</b>${vs}</div>`;
}

function drawScoreInfo() {
  const leg = state.shown;
  const g = leg.gait;
  if (!leg.sim.complete) {
    $('score-info').innerHTML = `Кривошип не проворачивается: нога собирается только на ${(100 * leg.sim.assembled / STEPS).toFixed(0)}% оборота. ` +
      `Оценка = эта доля = <b>${leg.score.toFixed(3)}</b>.`;
    return;
  }
  if (g.scrapes || g.aboveBody) {
    const why = g.scrapes
      ? 'какой-то шарнир опускается до уровня стопы — задевает землю'
      : 'стопа поднимается выше корпуса (оси кривошипа) — это цеп, а не нога';
    $('score-info').innerHTML = `Нога проворачивается, но нарушает правила: ${why}. Оценка <b>1</b>.`;
    return;
  }
  const f = g.factors;
  const j = JANSEN_LEG.gait, jf = j.factors;
  // Each row: what was measured -> the factor (0..1) that goes into the product.
  const row = (name, mine, jansen, note) => `<tr><td>${name}</td><td><b>${mine}</b></td><td>${jansen}</td><td>${note}</td></tr>`;
  const both = (fn) => [fn(g, f), fn(j, jf)];
  const rows = [
    ['Скорость', ...both((x) => `${x.speed.toFixed(1)} см/оборот`), `главное: шаг ${g.stride.toFixed(1)} см / доля на земле ${g.share.toFixed(3)}`],
    ['Опора', ...both((x, k) => `${(x.share * 100).toFixed(0)}% → ${k.support.toFixed(2)}`), `${LEGS} ног, на земле всегда не меньше ${MIN_FEET}: нужно не меньше ${(100 * MIN_FEET / LEGS).toFixed(0)}% оборота`],
    ['Ровность хода', ...both((x, k) => k.evenness.toFixed(3)), '1 = стопа едет по земле равномерно (ноги не мешают друг другу)'],
    ['Просвет над шагом', ...both((x, k) => `${Number.isFinite(x.clearance) ? x.clearance.toFixed(1) + ' см' : '—'} → ${k.clearance.toFixed(2)}`), `как высоко стопа идёт назад над местом, где стояла (нужно ${CLEARANCE} см): нет шарканья`],
    ['Подъём', ...both((x, k) => `${x.lift.toFixed(1)} см → ${k.lift.toFixed(2)}`), `чем выше, тем лучше — до трети высоты ноги (${(g.height * LIFT_SHARE).toFixed(0)} см); стопа не выше корпуса`],
    ['Материал', ...both((x, k) => `${x.material.toFixed(0)} см → ${k.material.toFixed(2)}`), `больше ${MATERIAL_BUDGET} см — штраф`],
  ];
  const w = FITNESS_OPTIONS;
  if ('height' in f) rows.push(['Высокие шарниры', ...both((x, k) => `${x.lowestJoint.toFixed(1)} из ${x.height.toFixed(0)} см → ${k.height.toFixed(2)}`),
    `самая низкая точка механизма (кроме стопы) / высота ноги; сила ${Math.round(w.height * 100)}%`]);
  if ('angle' in f) rows.push(['Углы в шарнирах', ...both((x, k) => `${x.worstAngle.toFixed(1)}° → ${k.angle.toFixed(2)}`),
    `худший угол между стержнями (от 0° или 180°); без штрафа от ${GOOD_ANGLE}°; сила ${Math.round(w.angle * 100)}%`]);
  if ('compact' in f) rows.push(['Компактность', ...both((x, k) => `${(x.area / 1e4).toFixed(2)} м² → ${k.compact.toFixed(2)}`),
    `площадь, которую заметает механизм; не больше, чем у Янсена — полный балл; сила ${Math.round(w.compact * 100)}%`]);
  $('score-info').innerHTML =
    '<table class="score-table"><tr><th>Множитель</th><th>Эта нога</th><th>Янсен</th><th>Что значит</th></tr>' +
    rows.map((r) => row(...r)).join('') + '</table>' +
    `<div class="formula">оценка = 1 + скорость × качество = 1 + ${g.speed.toFixed(1)} × ${Object.values(f).map((v) => v.toFixed(2)).join(' × ')} = <b>${leg.score.toFixed(2)}</b></div>`;
}

// Species table: one row per species; a click shows that species' best leg.
function drawSpecies() {
  const rows = state.evo.speciesTable();
  const on = state.evo.cfg.speciation;
  let html = on ? '' : '<div class="muted">Виды выключены: турнир идёт по всему пулу, квот нет. Таблица — просто состав пула.</div>';
  html += `<table><tr><th>Звеньев</th><th>Ног</th>${on ? '<th>Квота</th>' : ''}<th>Лучшая оценка</th></tr>`;
  for (const r of rows) {
    const mark = r.links === state.pinnedSpecies && $('view-source').value === 'species' ? ' ◀' : '';
    html += `<tr class="clickable" data-links="${r.links}"><td>${r.links}</td><td>${r.size}</td>` +
      (on ? `<td>${r.quota.toFixed(0)}</td>` : '') + `<td>${r.best.score.toFixed(1)}${mark}</td></tr>`;
  }
  $('species-info').innerHTML = html + '</table>';
}

// The genome as a table: crank, frame pivots, then every joint and its two bars.
function drawBars() {
  const leg = state.shown;
  const g = leg.genome;
  const used = leg.sim.used;
  const scale = Number($('build-scale').value) || 1;
  const cm = (v) => `${v.toFixed(1)} см` + (scale !== 1 ? ` <span class="muted">(${(v * scale).toFixed(1)})</span>` : '');
  let html = `<div class="muted">Шарниров: ${g.joints.length}, из них работают на стопу: ${g.joints.filter((_, k) => used.has(FIXED_POINTS + k)).length}; ` +
    `подвижных звеньев (твёрдых тел): ${leg.links !== undefined ? leg.links : rigidBodies(g, used).links}. ` +
    'Бледные строки — нейтральные шарниры, стопа от них не зависит.</div>';
  html += '<table><tr><th>Точка</th><th>Висит на</th><th>Стержни</th><th>Сторона</th></tr>';
  html += `<tr><td><b>M</b></td><td>O</td><td>${cm(CRANK)} (кривошип, задан)</td><td></td></tr>`;
  g.frame.forEach((p, i) => {
    const style = used.has(2 + i) ? '' : ' class="muted"';
    html += `<tr${style}><td><b>${pointName(2 + i)}</b></td><td>рама</td><td>x = ${p.x.toFixed(1)}, y = ${p.y.toFixed(1)}</td><td></td></tr>`;
  });
  g.joints.forEach((j, k) => {
    const i = FIXED_POINTS + k;
    const style = used.has(i) ? '' : ' class="muted"';
    const name = i === g.foot ? `${pointName(i)} — стопа` : pointName(i);
    html += `<tr${style}><td><b>${name}</b></td><td>${pointName(j.a)} и ${pointName(j.b)}</td>` +
      `<td>${cm(j.ra)} и ${cm(j.rb)}</td><td>${j.side > 0 ? 'слева' : 'справа'}</td></tr>`;
  });
  html += '</table>';
  $('bars-info').innerHTML = html;
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, ${c.links} звеньев, оценка ${c.score.toFixed(3)}`;
  const head = s.parentSpecies !== undefined
    ? [
      `Виды: родителей выбрали в виде «${s.parentSpecies} звеньев» (вид берётся с вероятностью по квоте),`,
      'внутри вида — турнир, двое лучших становятся родителями:',
      '  ' + line('мама', s.mom),
      '  ' + line('папа', s.dad),
      `Погибает худшая из трёх случайных ног самого переполненного вида «${s.deathSpecies} звеньев»:`,
      '  ' + line('', s.loser),
    ]
    : [
      'Из пула случайно взяли три ноги и отсортировали по оценке:',
      '  ' + line('1.', s.mom),
      '  ' + line('2.', s.dad),
      '  ' + line('3.', s.loser) + '  ← погибает',
    ];
  return head.concat([
    '',
    `Скрещивание #${s.mom.id} × #${s.dad.id}: число шарниров — от случайного родителя,`,
    'каждый шарнир, каждая точка рамы и стопа — тоже от случайного родителя.',
    'Мутация: ' + s.mutations.join('; '),
    '',
    line('Потомок', s.child) + ` — занимает место #${s.loser.id}`,
  ]).join('\n');
}

// ---- Buttons ----
$('btn-run').onclick = () => setRunning(!state.running);
$('btn-reset').onclick = () => { setRunning(false); reset(); };
// Same seed = same random start. A new seed gives a different starting pool.
$('btn-new-seed').onclick = () => {
  $('cfg-seed').value = 1 + Math.floor(Math.random() * 99999);
  setRunning(false);
  reset();
};
$('btn-step').onclick = () => {
  setRunning(false);
  state.lastStep = state.evo.step();
  $('step-log').textContent = describeStep(state.lastStep);
  refreshPanels(true);
};
$('btn-gen').onclick = () => {
  setRunning(false);
  for (let i = 0; i < state.evo.pool.length; i++) state.lastStep = state.evo.step();
  $('step-log').textContent = describeStep(state.lastStep);
  refreshPanels(true);
};
$('view-source').onchange = () => refreshPanels(true);
$('species-info').onclick = (e) => {
  const row = e.target.closest('tr[data-links]');
  if (!row) return;
  state.pinnedSpecies = Number(row.dataset.links);
  const opt = $('view-source').querySelector('option[value=species]');
  opt.disabled = false;
  opt.textContent = `Лучшая нога вида: ${state.pinnedSpecies} звеньев`;
  $('view-source').value = 'species';
  refreshPanels(true);
};
$('build-scale').oninput = drawBars;

$('btn-export').onclick = () => {
  const leg = state.shown;
  const data = {
    about: 'Evolved leg linkage, cm. Points: 0 O, 1 M (crank tip, crank = 15), 2 B, 3 B2, then joints. ' +
      'Each joint hangs on points a and b at distances ra and rb; side picks one of two positions.',
    score: leg.score,
    jansenScore: JANSEN_SCORE,
    m: CRANK,
    genome: leg.genome,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `leg-${leg.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const genome = copyLeg(data.genome);
    // Check that every joint hangs on earlier points - otherwise the leg cannot be built.
    if (genome.frame.length !== 2) throw new Error('нужно 2 точки рамы');
    genome.joints.forEach((j, k) => {
      const i = FIXED_POINTS + k;
      if (!(j.a >= 0 && j.a < i && j.b >= 0 && j.b < i && j.a !== j.b)) throw new Error('шарнир ' + pointName(i) + ' висит не на тех точках');
    });
    if (genome.foot >= FIXED_POINTS + genome.joints.length) throw new Error('нет такой стопы');
    state.imported = state.evo.createLeg(genome, null);
    $('view-source').querySelector('option[value=imported]').disabled = false;
    $('view-source').value = 'imported';
    refreshPanels(true);
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
  e.target.value = '';
};

// Show slider values next to the sliders.
for (const id of ['fit-height', 'fit-angle', 'fit-compact']) {
  $(id).oninput = () => { document.querySelector(`output[for=${id}]`).textContent = $(id).value + '%'; };
}

$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');

reset();
requestAnimationFrame(frame);
