'use strict';
// UI wiring: buttons, the main loop, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

const state = {
  evo: null,
  running: false,
  shown: null,
  shownId: null,
  lastStep: null,
  raceTime: 0,          // seconds since the drops were released (in model time)
  lastFrame: performance.now(),
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
      width: Math.max(0.5, Number($('cfg-width').value) || 4),
      height: Math.max(0.5, Number($('cfg-height').value) || 3),
      segments: Number($('cfg-segments').value),
      rain: $('cfg-rain').value === 'rain',
      floor: $('cfg-floor').checked,
    },
  };
}

function readStopRules() {
  const on = (id) => $(id).checked;
  return {
    // A tiny epsilon so "0%" means "not slower than the cycloid".
    nearCycloid: on('stop-cyc-on') ? Math.max(1e-9, Number($('stop-cyc').value) / 100) : 0,
    stagnation: on('stop-stag-on') ? Number($('stop-stag').value) : 0,
    maxGenerations: on('stop-max-on') ? Number($('stop-max').value) : 0,
  };
}

function reset() {
  state.evo = new Evolution(readConfig());
  state.lastStep = null;
  state.stopReason = null;
  state.autoStopOff = false;
  state.raceTime = 0;
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
  state.raceTime += dt * Number($('race-speed').value);

  if (state.running) {
    const start = performance.now();
    while (state.running && performance.now() - start < 25) {
      for (let i = 0; i < 100; i++) state.lastStep = state.evo.step();
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

// The race lasts until the slowest drop finishes, plus a pause; then it starts again.
function raceLength(refs) {
  const runs = [];
  for (const d of roofDrops(state.shown.pts)) runs.push(d.run);
  for (const r of refs) runs.push(slide(r.pts, 0));
  return Math.max(0.5, ...runs.map((r) => r.times[r.times.length - 1])) + 0.6;
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

    const shown = pickShownRoof();
    drawStats();
    const c = $('chart-canvas');
    drawPopulationChart(c.getContext('2d'), state.evo.history.concat([state.evo.snapshot()]), c.width, c.height);
    if (force || shown.id !== state.shownId || shown !== state.shown) {
      state.shown = shown;
      state.shownId = shown.id;
      drawRoofInfo();
      drawScoreInfo();
      drawGenome();
    }
  }
  const refs = raceRefs();
  if (state.raceTime > raceLength(refs)) state.raceTime = 0;
  const rc = $('race-canvas');
  drawRace(rc.getContext('2d'), state.shown, state.raceTime, rc.width, rc.height, refs);
}

// Which references race next to the shown roof: only for one drop from the ridge, and not itself.
function raceRefs() {
  if (TASK.rain || !$('show-refs').checked) return [];
  return Object.values(REFS).filter((r) => r !== state.shown);
}

function pickShownRoof() {
  const source = $('view-source').value;
  if (REFS[source]) return REFS[source];
  if (source === 'child' && state.lastStep) return state.lastStep.child;
  if (source === 'loser' && state.lastStep) return state.lastStep.loser;
  return state.evo.best();
}

// ---- Panels ----
const sec = (r) => (r.ok ? `${r.time.toFixed(3)} с` : 'застревает');

function drawStats() {
  const evo = state.evo;
  const best = evo.best();
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${Math.round(state.rate).toLocaleString('ru')}/с` : '') +
    ` · лучшая оценка <b>${evo.bestScore.toFixed(4)}</b> (${sec(best)}; циклоида ${sec(REFS.cycloid)})` +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

function drawRoofInfo() {
  const roof = state.shown;
  const who = roof.key ? `Эталон: ${roof.name}`
    : `Крыша #${roof.id} (${roof.parents ? `потомок #${roof.parents[0]} и #${roof.parents[1]}` : 'из случайного начального пула'})`;
  $('roof-info').innerHTML = `<div>${who} · класс: <b>${CLASS_NAMES[roof.cls]}</b> · оценка <b>${roof.score.toFixed(4)}</b> · ` +
    `${TASK.rain ? 'среднее время капли' : 'время капли с конька'} <b>${sec(roof)}</b></div>`;
  $('race-note').textContent = TASK.rain
    ? 'Дождь: капли стартуют одновременно с конька и с каждого излома. Время крыши — среднее по всем каплям.'
    : 'Капли отпускают с конька одновременно. Синяя скользит по крыше (и по зеркальной половине), цветные — по эталонам из тех же кусков.';
}

function drawScoreInfo() {
  const roof = state.shown;
  if (!roof.ok) {
    $('score-info').innerHTML = TASK.rain
      ? `Вода застревает: до карниза доходят ${(roof.share * 100).toFixed(0)}% капель, остальные останавливаются в ямах ` +
        `или перед подъёмом. Оценка = эта доля = <b>${roof.score.toFixed(3)}</b>.`
      : `Капля застревает: впереди точка не ниже конька, капля проходит только ${(roof.share * 100).toFixed(0)}% пути. ` +
        `Оценка = эта доля = <b>${roof.score.toFixed(3)}</b>.`;
    return;
  }
  const rows = [roof, ...Object.values(REFS).filter((r) => r !== roof)].map((r) => {
    const s = roofStats(r.pts);
    const vsLine = r.ok ? `${((REFS.line.time / r.time - 1) * 100).toFixed(2)}%` : '—';
    return `<tr><td>${r.key ? r.name : '<b>эта крыша</b>'}</td><td><b>${sec(r)}</b></td><td>${vsLine}</td>` +
      `<td>${s.length.toFixed(2)} м</td><td>${s.steepest.toFixed(0)}°</td><td>${(s.lowest * 100).toFixed(0)} см</td></tr>`;
  });
  const c = REFS.cycloid.shape;
  const cycNote = TASK.rain
    ? 'В дожде циклоида уже не обязана быть лучшей: капли с нижней части крыши стартуют с места, и им важен свой наклон.'
    : `Гладкая циклоида (не ломаная) — <b>${c.exactTime.toFixed(4)} с</b>: это предел, быстрее не может ни одна крыша. ` +
      `Ломаная из ${TASK.segments} кусков медленнее: на каждом изломе капля теряет часть скорости. ` +
      'Лучшая ломаная немного отличается от вписанной в циклоиду (у конька она положе, там у циклоиды резкий поворот), ' +
      'поэтому эволюция может обогнать эталонные ломаные.' +
      (c.dips && !TASK.floor ? ` Здесь ширина больше высоты в π/2 раз и сильнее, поэтому циклоида уходит ниже карниза на ${(c.depth * 100).toFixed(0)} см и возвращается.` : '') +
      (c.dips && TASK.floor ? ' Здесь циклоида ушла бы ниже карниза, а это запрещено, поэтому эталон — полуарка циклоиды до уровня карниза и горизонтальный участок.' : '');
  $('score-info').innerHTML =
    '<table class="score-table"><tr><th>Крыша</th><th>Время</th><th>Быстрее прямого</th><th>Длина ската</th><th>Самый крутой кусок</th><th>Самая низкая точка</th></tr>' +
    rows.join('') + '</table>' +
    `<div class="formula">оценка = 1 + T<sub>прямой</sub> / T = 1 + ${REFS.line.time.toFixed(3)} / ${roof.time.toFixed(3)} = <b>${roof.score.toFixed(4)}</b></div>` +
    `<p class="note">${cycNote}</p>`;
}

// The genome as a table: every break point, its height and the slope of the piece before it.
function drawGenome() {
  const pts = state.shown.pts;
  const cyc = REFS.cycloid.pts;
  const step = (cyc.length - 1) / (pts.length - 1);
  let html = '<table><tr><th>Точка</th><th>x</th><th>Высота</th><th>Наклон куска до неё</th><th>Циклоида</th></tr>';
  pts.forEach((p, k) => {
    const name = k === 0 ? 'конёк' : k === pts.length - 1 ? 'карниз' : String(k);
    const slope = k ? `${(Math.atan2(pts[k - 1].y - p.y, p.x - pts[k - 1].x) * 180 / Math.PI).toFixed(1)}°` : '';
    const style = k === 0 || k === pts.length - 1 ? ' class="muted"' : '';
    html += `<tr${style}><td>${name}</td><td>${p.x.toFixed(2)} м</td><td>${(p.y * 100).toFixed(1)} см</td><td>${slope}</td>` +
      `<td class="muted">${(cyc[Math.round(k * step)].y * 100).toFixed(1)} см</td></tr>`;
  });
  $('genome-info').innerHTML = html + '</table><p class="note">Конёк и карниз заданы задачей, эволюция их не трогает. ' +
    'Наклон положительный — кусок идёт вниз к карнизу.</p>';
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, ${sec(c)}, оценка ${c.score.toFixed(4)}`;
  return [
    'Из пула случайно взяли три крыши и отсортировали по оценке:',
    '  ' + line('1.', s.mom),
    '  ' + line('2.', s.dad),
    '  ' + line('3.', s.loser) + '  ← погибает',
    '',
    `Скрещивание #${s.mom.id} × #${s.dad.id}: случайный разрез, верх крыши от первой, низ от второй.`,
    'Мутация: ' + s.mutations.join('; '),
    '',
    line('Потомок', s.child) + ` — занимает место #${s.loser.id}`,
  ].join('\n');
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
$('view-source').onchange = () => { state.raceTime = 0; refreshPanels(true); };
$('show-refs').onchange = () => { state.raceTime = 0; };

$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');

reset();
requestAnimationFrame(frame);
