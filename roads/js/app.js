'use strict';
// UI wiring: buttons, the main loop, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

const state = {
  evo: null,
  running: false,
  shown: null,
  shownId: null,
  lastStep: null,
  lastFrame: performance.now(),
  budget: 0,            // matings allowed by the speed limit but not done yet
  rate: 0,
  stopReason: null,
  autoStopOff: false,   // Start pressed after an auto-stop: keep going until Reset
};

function readConfig() {
  return {
    seed: Number($('cfg-seed').value) || 1,
    populationSize: Number($('cfg-pop').value),
    mutationsPerChild: Math.max(1, Number($('cfg-mut').value) || 1),
    task: {
      map: $('cfg-map').value,
      mode: $('cfg-mode').value,
      tripShare: tripShare(),
      cities: Math.min(50, Math.max(3, Math.round(Number($('cfg-cities').value) || 20))),
      mapSeed: Number($('cfg-map-seed').value) || 1,
    },
  };
}

// The slider "shorter roads - faster trips": 0..100% -> w = 0..1.
function tripShare() {
  return Number($('cfg-trip').value) / 100;
}

function readStopRules() {
  const on = (id) => $(id).checked;
  return {
    // A tiny epsilon so "0%" means "exactly the known answer" despite rounding.
    nearExact: on('stop-exact-on') ? Math.max(1e-9, Number($('stop-exact').value) / 100) : 0,
    stagnation: on('stop-stag-on') ? Number($('stop-stag').value) : 0,
    maxGenerations: on('stop-max-on') ? Number($('stop-max').value) : 0,
  };
}

function reset() {
  state.evo = new Evolution(readConfig());
  state.lastStep = null;
  state.stopReason = null;
  state.autoStopOff = false;
  $('step-log').textContent = 'Нажми «1 спаривание», чтобы увидеть один шаг эволюции подробно.';
  // The exact answer exists only for the ready-made maps.
  $('view-source').querySelector('option[value=exact]').disabled = !REFS.exact;
  if (!REFS.exact && $('view-source').value === 'exact') $('view-source').value = 'best';
  $('cfg-cities').disabled = TASK.map !== 'random';
  $('cfg-map-seed').disabled = TASK.map !== 'random';
  $('cfg-trip').disabled = TASK.mode !== 'routes';
  // The classes depend on the mode.
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

  if (state.running) {
    // Speed limit: generations per second (0 = as fast as possible).
    const gps = Number($('cfg-speed').value);
    if (gps) state.budget += gps * state.evo.pool.length * dt;
    const start = performance.now();
    while (state.running && performance.now() - start < 25 && (!gps || state.budget >= 1)) {
      const batch = gps ? Math.min(100, Math.floor(state.budget)) : 100;
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
  requestAnimationFrame(frame);
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

  const shown = pickShownNet();
  drawStats();
  const c = $('chart-canvas');
  drawPopulationChart(c.getContext('2d'), state.evo.history.concat([state.evo.snapshot()]), c.width, c.height);
  if (force || shown.id !== state.shownId || shown !== state.shown) {
    state.shown = shown;
    state.shownId = shown.id;
    const mc = $('map-canvas');
    drawMap(mc.getContext('2d'), shown, mc.width, mc.height, $('show-mst').checked);
    drawNetInfo();
    drawScoreInfo();
    drawGenome();
  }
}

function pickShownNet() {
  const source = $('view-source').value;
  if (REFS[source]) return REFS[source];
  if (source === 'child' && state.lastStep) return state.lastStep.child;
  if (source === 'loser' && state.lastStep) return state.lastStep.loser;
  return state.evo.best();
}

// ---- Panels ----
const km = (l) => `${l.toFixed(2)} км`;
const pct = (x) => `${(x * 100).toFixed(2)}%`;

function drawStats() {
  const evo = state.evo;
  const best = evo.best();
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${Math.round(state.rate).toLocaleString('ru')}/с` : '') +
    (!best.connected ? ` · лучшая сеть связывает только <b>${Math.round(best.share * 100)}%</b> городов`
      : TASK.mode === 'routes'
        ? ` · лучшая сеть: стоимость <b>${best.cost.toFixed(4)}</b> (остов ${REFS.mst.cost.toFixed(4)}), дороги ${km(best.length)}, ` +
          `средняя поездка ${km(best.trip)}`
        : ` · лучшая сеть <b>${km(best.length)}</b> (короче остова на ${pct(gainOverMst(best.length))}` +
          (REFS.exact ? `; точный ответ ${km(REFS.exact.length)}` : '') + ')') +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

// Junction counts of a network: all, useful (3+ roads), at 120°.
function junctionCounts(net) {
  const s = net.junctionInfo.filter((j) => !j.crossroads);
  return { all: s.length, useful: s.filter((j) => !j.useless).length, at120: s.filter((j) => j.at120).length,
    crossroads: net.junctionInfo.length - s.length };
}

function drawNetInfo() {
  const net = state.shown;
  const who = net.key ? `Эталон: ${net.name}`
    : `Сеть #${net.id} (${net.parents ? `потомок #${net.parents[0]} и #${net.parents[1]}` : 'из случайного начального пула'})`;
  const j = junctionCounts(net);
  $('net-info').innerHTML = `<div>${who} · класс: <b>${CLASS_NAMES[net.cls]}</b> · оценка <b>${net.score.toFixed(4)}</b> · ` +
    `длина дорог <b>${km(net.length)}</b> · дорог ${net.roadCount}` +
    (net.extra ? ` (лишних в кольцах ${net.extra})` : '') +
    ` · развилок ${j.all} (полезных ${j.useful}, под 120° ${j.at120})` +
    (j.crossroads ? ` · перекрёстков ${j.crossroads}` : '') +
    (!net.connected ? ` · <span class="bad">связано ${Math.round(net.share * 100)}% городов</span>`
      : TASK.mode === 'routes' ? ` · средняя поездка <b>${km(net.trip)}</b>, крюк ×${net.detour.toFixed(2)} · стоимость <b>${net.cost.toFixed(4)}</b>` : '') +
    '</div>';
}

function drawScoreInfo() {
  const net = state.shown;
  const rows = [net, REFS.mst, REFS.exact].filter((r, i) => r && (i === 0 || r !== net)).map((r) => {
    const j = junctionCounts(r);
    return `<tr><td>${r === net ? '<b>эта сеть</b>' : r.name}</td><td><b>${km(r.length)}</b></td>` +
      `<td>${pct(gainOverMst(r.length))}</td><td>${j.useful}</td><td>${j.at120}</td></tr>`;
  });
  rows.push(`<tr class="muted"><td>нижняя граница (√3/2 остова)</td><td>${km(REFS.bound.length)}</td>` +
    `<td>${pct(gainOverMst(REFS.bound.length))}</td><td></td><td></td></tr>`);
  const exactNote = {
    triangle: 'Для трёх городов ответ — точка Ферма: из неё все три стороны видны под углом 120°.',
    square: 'Для квадрата ответ — две развилки на средней линии, «мостик» между ними; длина (1 + √3) × сторона. ' +
      'Мостик может стоять и поперёк — это второй, такой же короткий ответ. Крест по диагоналям длиннее: 2√2 × сторона.',
    hexagon: 'Для правильного шестиугольника развилки не помогают: лучшая сеть — пять сторон, то есть сам остов. ' +
      'Эволюция пробует развилки, но все они удлиняют сеть.',
    trilattice: 'Города в вершинах равносторонних треугольников — самый выгодный для развилок случай: остов здесь «гребёнка» ' +
      'из одинаковых дорог, а развилки складывают из них соты. Чем больше такая решётка, тем ближе выигрыш к пределу 13,4%. ' +
      'Точный ответ для решётки 4 × 4 не считали.',
    grid: 'Квадратная сетка: каждая клетка — маленький квадрат, а для квадрата развилки дают почти 9%. ' +
      'Но соседние клетки делят дороги, поэтому на всей сетке выигрыш меньше. Точный ответ не считали.',
    random: 'Для случайных городов точный ответ неизвестен: задача Штейнера NP-трудная. ' +
      'Известно только, что короче √3/2 ≈ 86,6% остова не бывает; на практике выигрыш у остова — 2–5%.',
  }[TASK.map];
  if (!net.connected) {
    const left = CITIES.length - Math.round(net.share * CITIES.length);
    $('score-info').innerHTML = `Не все города связаны: в самой большой связной части сети ${Math.round(net.share * CITIES.length)} ` +
      `из ${CITIES.length} городов, ещё ${left} отрезаны (красные). Оценка = доля связанных = <b>${net.score.toFixed(3)}</b>. ` +
      'Любая связная сеть получает больше единицы, поэтому сначала эволюция учится связывать все города, а уже потом — укорачивать дороги.';
    return;
  }
  if (TASK.mode === 'routes') {
    drawRouteScore(net);
    return;
  }
  $('score-info').innerHTML =
    '<table class="score-table"><tr><th>Сеть</th><th>Длина</th><th>Короче остова</th><th>Полезных развилок</th><th>Под 120°</th></tr>' +
    rows.join('') + '</table>' +
    `<div class="formula">оценка = 1 + L<sub>остова</sub> / L = 1 + ${REFS.mst.length.toFixed(2)} / ${net.length.toFixed(2)} = <b>${net.score.toFixed(4)}</b></div>` +
    `<p class="note">${exactNote}</p>`;
}

// 'routes' mode: building against trips.
function drawRouteScore(net) {
  const w = TASK.tripShare;
  const row = (r, name) => `<tr><td>${name}</td><td>${km(r.length)}</td><td>${km(r.trip)}</td><td>×${r.detour.toFixed(3)}</td>` +
    `<td>${r.roadCount}</td><td><b>${r.cost.toFixed(4)}</b></td></tr>`;
  $('score-info').innerHTML =
    '<table class="score-table"><tr><th>Сеть</th><th>Длина дорог L</th><th>Средняя поездка T</th><th>Средний крюк</th><th>Дорог</th><th>Стоимость C</th></tr>' +
    (net === REFS.mst ? '' : row(net, '<b>эта сеть</b>')) + row(REFS.mst, REFS.mst.name) + '</table>' +
    `<div class="formula">C = (1 − w)·L / L<sub>остова</sub> + w·T / T<sub>прямо</sub> = ${(1 - w).toFixed(2)} × ${net.length.toFixed(1)} / ${REFS.mst.length.toFixed(1)} + ` +
    `${w.toFixed(2)} × ${net.trip.toFixed(2)} / ${REFS.straight.toFixed(2)} = ${net.cost.toFixed(4)}<br>` +
    `оценка = 1 + C<sub>остова</sub> / C = 1 + ${REFS.mst.cost.toFixed(4)} / ${net.cost.toFixed(4)} = <b>${net.score.toFixed(4)}</b></div>` +
    '<p class="note">w — положение ползунка «короче дороги — быстрее добраться» (0…100%). T — среднее по всем парам городов: ' +
    'кратчайший путь по дорогам из одного в другой. T<sub>прямо</sub> — среднее расстояние по прямой, как если бы между каждой парой ' +
    'была своя дорога. Крюк — во сколько раз путь по дорогам длиннее прямой (×1 — дорога прямо). ' +
    'При 0% ответ — дерево Штейнера, с ростом w появляются кольца и прямые дороги между соседями, поездки короче, дорог больше. ' +
    'При 100% важны только поездки, и лучшая сеть — прямая дорога между каждой парой городов. ' +
    'Правило 120° здесь уже не обязано выполняться: развилку тянут к себе и стройка, и поездки.</p>';
}

// The genome as a table: every junction, its roads and the angles between them.
function drawGenome() {
  const net = state.shown;
  const stats = net.junctionInfo.filter((j) => !j.crossroads);
  const crossroads = net.junctionInfo.length - stats.length;
  const crossNote = crossroads ? `<p class="note">Ещё ${crossroads} перекрёстков — там дороги пересекаются. Их нет в геноме, ` +
    'но по ним можно свернуть, как на развилке.</p>' : '';
  if (!stats.length) {
    $('genome-info').innerHTML = roadsNote(net) + (roadsInGenome() || net.key
      ? '<p class="note">Развилок нет: дороги идут только от города к городу.</p>'
      : '<p class="note">Развилок нет: дороги идут только от города к городу, и сеть — это остов.</p>') + crossNote;
    return;
  }
  let html = '<table><tr><th>Развилка</th><th>x</th><th>y</th><th>Дорог</th><th>Углы между дорогами</th></tr>';
  stats.forEach((s, k) => {
    const cls = s.useless ? ' class="muted"' : s.at120 ? ' class="good"' : '';
    const angles = s.angles.map((a) => `${a.toFixed(0)}°`).join(' · ');
    const note = s.degree === 1 ? 'тупик' : s.degree === 2 ? 'просто изгиб' : '';
    html += `<tr${cls}><td>${k + 1}</td><td>${s.p.x.toFixed(1)}</td><td>${s.p.y.toFixed(1)}</td><td>${s.degree}</td>` +
      `<td>${note || angles}</td></tr>`;
  });
  $('genome-info').innerHTML = roadsNote(net) + html + '</table><p class="note">Зелёные — три дороги под 120°, как в точном ответе. ' +
    'Серые — лишние: тупик или изгиб на две дороги только удлиняют сеть, но и не ломают её. Координаты в км.</p>' + crossNote;
}

// What the genome says about roads: in the 'roads' mode they are in the genome, in the 'tree' mode - computed.
function roadsNote(net) {
  if (net.key) return '';
  return roadsInGenome()
    ? `<p class="note">Дороги — тоже часть генома: ${net.genome.roads.length} пар узлов, которые соединены дорогой.</p>`
    : '<p class="note">В геноме только развилки, дороги между узлами строит алгоритм Прима (остов).</p>';
}

function describeStep(s) {
  const size = (c) => (!c.connected ? `связано ${Math.round(c.share * 100)}% городов`
    : TASK.mode === 'routes' ? `стоимость ${c.cost.toFixed(4)} (дороги ${km(c.length)}, поездка ${km(c.trip)})` : km(c.length));
  const roads = (c) => (c.genome.roads ? `, дорог ${c.genome.roads.length}` : '');
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, ${size(c)}, развилок ${c.genome.junctions.length}${roads(c)}, оценка ${c.score.toFixed(4)}`;
  return [
    'Из пула случайно взяли три сети и отсортировали по оценке:',
    '  ' + line('1.', s.mom),
    '  ' + line('2.', s.dad),
    '  ' + line('3.', s.loser) + '  ← погибает',
    '',
    `Скрещивание #${s.mom.id} × #${s.dad.id}: карту режет случайная прямая, развилки` +
      (roadsInGenome() ? ' и дороги' : '') + ' с одной стороны от первой сети, с другой — от второй.',
    'Мутация: ' + s.mutations.join('; '),
    '',
    line('Потомок', s.child) + ` — занимает место #${s.loser.id}`,
  ].join('\n');
}

// ---- Buttons ----
$('btn-run').onclick = () => setRunning(!state.running);
$('btn-reset').onclick = () => { setRunning(false); reset(); };
// Same seed = same random start. A new seed gives a different starting pool (the map stays).
$('btn-new-seed').onclick = () => {
  $('cfg-seed').value = 1 + Math.floor(Math.random() * 99999);
  setRunning(false);
  reset();
};
$('btn-new-map').onclick = () => {
  $('cfg-map').value = 'random';
  $('cfg-map-seed').value = 1 + Math.floor(Math.random() * 99999);
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
// The map changes the task: apply at once, there is nothing to keep.
$('cfg-map').onchange = () => { setRunning(false); reset(); };
$('cfg-mode').onchange = () => { setRunning(false); reset(); };
// The trip weight changes on the fly: the same pool is scored again, evolution goes on towards the new goal.
$('cfg-trip').oninput = () => {
  $('cfg-trip-out').textContent = `${$('cfg-trip').value}%`;
  if (TASK.mode !== 'routes') return;
  setTripShare(tripShare());
  state.evo.rescore();
  state.stopReason = null;
  refreshPanels(true);
};
$('view-source').onchange = () => refreshPanels(true);
$('show-mst').onchange = () => refreshPanels(true);

reset();
requestAnimationFrame(frame);
