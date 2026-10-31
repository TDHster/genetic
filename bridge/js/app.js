'use strict';
// UI wiring: buttons, the main loop, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

const state = {
  evo: null,
  running: false,
  shown: null,      // the bridge on the picture, scored again with the forces of every truck position
  shownId: null,
  lastStep: null,
  lastFrame: performance.now(),
  budget: 0,        // matings allowed by the speed limit but not done yet
  rate: 0,
  truckTime: 0,     // seconds since the truck started
  stopReason: null,
  autoStopOff: false, // Start pressed after an auto-stop: keep going until Reset
};

function readConfig() {
  return {
    seed: Number($('cfg-seed').value) || 1,
    populationSize: Number($('cfg-pop').value),
    mutationsPerChild: Math.max(1, Number($('cfg-mut').value) || 1),
    task: { terrainSeed: Number($('cfg-terrain').value) || 1, mode: $('cfg-mode').value },
  };
}

function readStopRules() {
  const on = (id) => $(id).checked;
  return {
    stagnation: on('stop-stag-on') ? Number($('stop-stag').value) : 0,
    maxGenerations: on('stop-max-on') ? Number($('stop-max').value) : 0,
  };
}

function reset() {
  state.evo = new Evolution(readConfig());
  state.lastStep = null;
  state.stopReason = null;
  state.autoStopOff = false;
  state.shownId = null;
  $('step-log').textContent = 'Нажми «1 спаривание», чтобы увидеть один шаг эволюции подробно.';
  $('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');
  refreshPanels(true);
}

function setRunning(on) {
  if (on && state.stopReason) state.autoStopOff = true;
  state.running = on;
  state.budget = 0;
  $('btn-run').textContent = on ? '⏸ Пауза' : '▶ Старт';
}

// ---- Main loop ----
function frame(now) {
  const dt = Math.min(0.1, (now - state.lastFrame) / 1000);
  state.lastFrame = now;
  state.truckTime += dt;

  if (state.running) {
    // Speed limit: generations per second (0 = as fast as possible).
    const gps = Number($('cfg-speed').value);
    if (gps) state.budget += gps * state.evo.pool.length * dt;
    const start = performance.now();
    while (state.running && performance.now() - start < 25 && (!gps || state.budget >= 1)) {
      const batch = gps ? Math.min(20, Math.floor(state.budget)) : 20;
      for (let i = 0; i < batch; i++) state.lastStep = state.evo.step();
      state.budget -= gps ? batch : 0;
      const reason = state.autoStopOff ? null : state.evo.stopReason(readStopRules());
      if (reason) {
        state.stopReason = reason;
        setRunning(false);
        refreshPanels(true);
      }
    }
    // A slow computer cannot keep up: do not pile up the debt.
    state.budget = Math.min(state.budget, state.evo.pool.length);
  }
  refreshPanels(false);
  drawShown();
  requestAnimationFrame(frame);
}

// Where the truck is now: it drives across in TRUCK_SECONDS, waits a moment on the far bank, starts again.
const TRUCK_SECONDS = 6;
function truckX() {
  if (!$('show-truck').checked || !state.shown || !state.shown.state) return null;
  const t = (state.truckTime % (TRUCK_SECONDS + 1)) / TRUCK_SECONDS;
  return Math.min(1, t) * TERRAIN.span;
}

// The sag is millimetres to centimetres: enlarge it so that the biggest one is ~1/25 of the span on the picture.
function sagScale(b) {
  if (!$('show-sag').checked || !b.state || !b.sag) return 0;
  return Math.max(1, TERRAIN.span / 25 / b.sag);
}

function drawShown() {
  if (!state.shown) return;
  const c = $('bridge-canvas');
  drawBridge(c.getContext('2d'), state.shown, c.width, c.height, truckX(), sagScale(state.shown));
}

let lastSlowRefresh = 0;
let lastMatings = 0;
function refreshPanels(force) {
  const now = performance.now();
  if (!force && now - lastSlowRefresh < 150) return;
  const seconds = (now - lastSlowRefresh) / 1000;
  if (state.running && !force && seconds > 0) state.rate = (state.evo.matings - lastMatings) / seconds;
  lastMatings = state.evo.matings;
  lastSlowRefresh = now;

  const picked = pickShownBridge();
  drawStats();
  const c = $('chart-canvas');
  drawPopulationChart(c.getContext('2d'), state.evo.history.concat([state.evo.snapshot()]), c.width, c.height);
  const id = picked.id || 'warren';
  if (force || id !== state.shownId) {
    state.shownId = id;
    // Score it again keeping the forces of every truck position (the pool keeps only the verdict).
    state.shown = { ...picked, ...evaluateBridge(picked.genome, true) };
    drawBridgeInfo();
    drawScoreInfo();
    drawGenome();
  }
}

function pickShownBridge() {
  const source = $('view-source').value;
  if (source === 'warren' && REFS.warren) return REFS.warren;
  if (source === 'child' && state.lastStep) return state.lastStep.child;
  if (source === 'loser' && state.lastStep) return state.lastStep.loser;
  return state.evo.best();
}

// ---- Panels ----
const tons = (m) => `${m.toFixed(2)} т`;
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const strengthMode = () => TASK.mode === 'strength';
// The cost in words: the steel, or the steel per unit of strength.
const costText = (r) => (strengthMode() ? `${tons(r.cost)} стали на единицу прочности` : tons(r.mass));

function drawStats() {
  const evo = state.evo;
  const best = evo.best();
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${Math.round(state.rate).toLocaleString('ru')}/с` : '') +
    (best.cls >= 2 ? ` · лучший мост <b>${costText(best)}</b>` +
      (REFS.warren ? ` (ферма Уоррена ${costText(REFS.warren)}, ${strengthMode() ? 'эффективнее' : 'легче'} ` +
        `в ${(REFS.warren.cost / best.cost).toFixed(2)} раза)` : '')
      : ' · ни один мост ещё не держит') +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

function drawBridgeInfo() {
  const b = state.shown;
  const who = b.name ? `Эталон: ${b.name}`
    : `Мост #${b.id} (${b.parents ? `потомок #${b.parents[0]} и #${b.parents[1]}` : 'из случайного начального пула'})`;
  const used = b.bars.filter((bar) => bar.used).length;
  const buried = b.bars.filter((bar) => bar.buried).length;
  const junk = b.bars.length - used - buried;
  $('bridge-info').innerHTML = `<div>${who} · класс: <b>${CLASS_NAMES[b.cls]}</b> · оценка <b>${b.score.toFixed(4)}</b> · ` +
    `сталь <b>${tons(b.mass)}</b> · стержней ${used}` +
    (buried ? ` · <span class="bad">сквозь грунт ${buried}</span>` : '') +
    (junk ? ` · <span class="muted">не связаны с дорогой ${junk}</span>` : '') +
    ` · свободных узлов ${b.genome.nodes.length} · опор ${b.supports}` +
    (b.mechanism ? '' : ` · загрузка <b>${pct(b.u)}</b> (самое слабое место: ${b.worst.why})` +
      ` · прогиб ${(b.sag * 1000).toFixed(0)} мм из ${(TERRAIN.span / SAG_LIMIT * 1000).toFixed(0)}`) +
    '</div>';
}

function drawScoreInfo() {
  const b = state.shown;
  const w = REFS.warren;
  if (b.mechanism) {
    $('score-info').innerHTML = `Мост складывается: у него <b>${b.mechanism}</b> свободных движений — способов сдвинуть узлы, ` +
      'не растянув и не сжав ни одного стержня (узел на одном стержне, четырёхугольник без диагонали, цепочка шарниров дороги). ' +
      `Оценка = 0,5 / (1 + ${b.mechanism}) = <b>${b.score.toFixed(4)}</b>. Каждый новый треугольник убирает одно-два свободных движения ` +
      'и поднимает оценку, поэтому эволюция сначала учится просто стоять.';
    return;
  }
  const sm = strengthMode();
  const row = (r, name) => `<tr><td>${name}</td><td>${sm ? '' : '<b>'}${tons(r.mass)}${sm ? '' : '</b>'}</td><td>${pct(r.u)}</td>` +
    (sm ? `<td>×${(1 / r.u).toFixed(2)}</td><td><b>${r.u > 1 ? '—' : tons(r.u * r.mass)}</b></td>` : '') +
    `<td>${(r.sag * 1000).toFixed(0)} мм</td><td>${r.supports}</td><td>${r.bars.filter((bar) => bar.used).length}</td></tr>`;
  const table = '<table class="score-table"><tr><th>Мост</th><th>Сталь</th><th>Загрузка</th>' +
    (sm ? '<th>Запас прочности</th><th>Сталь на единицу прочности</th>' : '') +
    '<th>Прогиб</th><th>Опор</th><th>Стержней</th></tr>' +
    (b.name ? '' : row(b, '<b>этот мост</b>')) + (w ? row(w, w.name) : '') + '</table>';
  const formula = b.u > 1
    ? `оценка = 0,5 + 0,5 / загрузка = 0,5 + 0,5 / ${b.u.toFixed(3)} = <b>${b.score.toFixed(4)}</b>`
    : sm
      ? `оценка = 1 + (u·M)<sub>Уоррена</sub> / (u·M) = 1 + ${w.cost.toFixed(3)} / (${b.u.toFixed(3)} × ${b.mass.toFixed(3)}) = <b>${b.score.toFixed(4)}</b>`
      : `оценка = 1 + M<sub>Уоррена</sub> / M = 1 + ${w.mass.toFixed(3)} / ${b.mass.toFixed(3)} = <b>${b.score.toFixed(4)}</b>`;
  const goal = sm
    ? '<p class="note">Цель — <b>прочность на тонну стали</b>. Запас прочности 1 / u: во сколько раз можно увеличить все нагрузки, ' +
      'пока что-то не сломается. Сталь на единицу прочности u·M — примерно столько весил бы мост, если утоньшить все его сечения ' +
      'до загрузки 100%. Мост с загрузкой 60% таскает 40% лишней стали, поэтому здесь сразу окупается маленький стержень, ' +
      'который разгружает самое слабое место: загрузка падает сильнее, чем растёт масса.</p>'
    : '';
  $('score-info').innerHTML = table + `<div class="formula">${formula}</div>` + goal +
    `<p class="note">Загрузка — худшее отношение «нагрузка / что выдержит» по всем стержням и всем положениям грузовика ` +
    `(${TRUCK_LOAD / 10} т), плюс прогиб дороги к допустимому (пролёт / ${SAG_LIMIT}). Больше 100% — мост ломается. ` +
    'Сжатый стержень выдерживает меньше растянутого: длинный и тонкий он выпучивается вбок (сила Эйлера π²EI/L²). ' +
    'Поэтому сжатые стержни у хороших мостов короткие и толстые, а растянутые — длинные и тонкие. ' +
    'Ферма Уоррена — классический мост из треугольников над дорогой, опирается только на берега; ' +
    'её сечения и высота подобраны перебором для этой долины.</p>';
}

// The genome: free nodes and the sections of the bars.
function drawGenome() {
  const b = state.shown;
  const bySize = SECTIONS.map(() => 0);
  for (const [, , s] of b.genome.bars) bySize[s]++;
  let html = `<p class="note">Стержней в геноме ${b.genome.bars.length}: ` +
    SECTIONS.map((sec, i) => (bySize[i] ? `${sec.name} — ${bySize[i]}` : null)).filter(Boolean).join(', ') +
    `. Узлов дороги ${deckCount()} (заданы задачей), свободных узлов ${b.genome.nodes.length}.</p>`;
  if (b.genome.nodes.length) {
    html += '<table><tr><th>Узел</th><th>x, м</th><th>y, м</th><th>Стержней</th><th></th></tr>';
    b.genome.nodes.forEach((q, k) => {
      const degree = b.genome.bars.filter(([a, c]) => a === q.id || c === q.id).length;
      const what = isSupport(q) ? '<span style="color:#f0c040">опора на грунте</span>' : q.y > 0.05 ? 'над дорогой' : '';
      html += `<tr><td>${k + 1}</td><td>${q.x.toFixed(1)}</td><td>${q.y.toFixed(1)}</td><td>${degree}</td><td>${what}</td></tr>`;
    });
    html += '</table>';
  }
  $('genome-info').innerHTML = html;
}

function describeStep(s) {
  const size = (c) => (c.mechanism ? `складывается (${c.mechanism} своб. движений)`
    : c.u > 1 ? `ломается, загрузка ${pct(c.u)}`
      : `держит, ${tons(c.mass)}` + (strengthMode() ? `, загрузка ${pct(c.u)}, u·M ${tons(c.cost)}` : ''));
  const line = (label, c) => `${label} #${c.id}: ${size(c)}, узлов ${c.genome.nodes.length}, стержней ${c.genome.bars.length}, оценка ${c.score.toFixed(4)}`;
  return [
    'Из пула случайно взяли три моста и отсортировали по оценке:',
    '  ' + line('1.', s.mom),
    '  ' + line('2.', s.dad),
    '  ' + line('3.', s.loser) + '  ← погибает',
    '',
    `Скрещивание #${s.mom.id} × #${s.dad.id}: долину режет случайная прямая, узлы и стержни с одной стороны от первого моста, ` +
      'с другой — от второго.',
    'Мутация: ' + s.mutations.join('; '),
    '',
    line('Потомок', s.child) + ` — занимает место #${s.loser.id}`,
  ].join('\n');
}

// ---- Buttons ----
$('btn-run').onclick = () => setRunning(!state.running);
$('btn-reset').onclick = () => { setRunning(false); reset(); };
// Same seed = same random start. A new seed gives a different starting pool (the valley stays).
$('btn-new-seed').onclick = () => {
  $('cfg-seed').value = 1 + Math.floor(Math.random() * 99999);
  setRunning(false);
  reset();
};
$('btn-new-terrain').onclick = () => {
  $('cfg-terrain').value = 1 + Math.floor(Math.random() * 99999);
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
// Another goal is another task (other classes, other reference): start again at once.
$('cfg-mode').onchange = () => { setRunning(false); reset(); };

reset();
requestAnimationFrame(frame);
