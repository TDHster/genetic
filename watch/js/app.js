'use strict';
// UI wiring: buttons, the main loop, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

const state = {
  evo: null,
  running: false,
  shown: null,          // clock currently shown in the viewer
  lastStep: null,       // result of the last Evolution.step()
  imported: null,       // clock loaded from a file
  clockTime: 0,         // simulated seconds for the animation
  lastFrame: performance.now(),
  rate: 0,              // matings per second
  hoverPair: null,
  shownId: null,        // to redraw panels only when the shown clock changes
  stopReason: null,     // why evolution stopped by itself (null if it did not)
  autoStopOff: false,   // the user pressed Start after an auto-stop: keep going
};

function readStopRules() {
  const on = (id) => $(id).checked;
  return {
    maxError: on('stop-error-on') ? Number($('stop-error').value) / 100 : 0,
    stagnation: on('stop-stag-on') ? Number($('stop-stag').value) : 0,
    maxGenerations: on('stop-max-on') ? Number($('stop-max').value) : 0,
  };
}

function readConfig() {
  const targets = $('cfg-targets').value.split(/[,;\s]+/).map(Number).filter((x) => x > 0).sort((a, b) => a - b);
  return {
    seed: Number($('cfg-seed').value) || 1,
    populationSize: Number($('cfg-pop').value),
    mutationsPerChild: Math.max(1, Number($('cfg-mut').value) || 1),
    maxTeeth: Math.max(10, Math.min(1000, Number($('cfg-teeth').value) || 1000)),
    initialBonds: Math.max(0, Number($('cfg-bonds').value) || 0),
    targets: targets.length ? targets : [60, 3600, 86400],
  };
}

function reset() {
  state.evo = new Evolution(readConfig());
  state.lastStep = null;
  state.clockTime = 0;
  state.stopReason = null;
  state.autoStopOff = false;
  $('step-log').textContent = 'Нажми «1 спаривание», чтобы увидеть один шаг эволюции подробно.';
  refreshPanels(true);
}

function setRunning(on) {
  // Start after an auto-stop means "I know, continue anyway".
  if (on && state.stopReason) state.autoStopOff = true;
  state.running = on;
  $('btn-run').textContent = on ? '⏸ Пауза' : '▶ Старт';
}

// ---- Main loop: evolve for a few milliseconds, then draw ----
function frame(now) {
  const dt = Math.min(0.1, (now - state.lastFrame) / 1000);
  state.lastFrame = now;
  state.clockTime += dt * Number($('time-speed').value);

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

let lastSlowRefresh = 0;
let lastMatings = 0;
function refreshPanels(force) {
  const now = performance.now();
  const slow = force || now - lastSlowRefresh > 300;
  if (slow) {
    // Matings per second, measured over the time since the previous refresh.
    const seconds = (now - lastSlowRefresh) / 1000;
    if (state.running && !force && seconds > 0) {
      state.rate = (state.evo.matings - lastMatings) / seconds;
    }
    lastMatings = state.evo.matings;
    lastSlowRefresh = now;
    state.shown = pickShownClock();
    drawStats();
    drawChart();
    if (force || !state.shown || state.shown.id !== state.shownId) {
      state.shownId = state.shown && state.shown.id;
      drawClockInfo();
      drawGenome();
      drawBondList();
    }
  }
  const c = $('clock-canvas');
  drawClock(c.getContext('2d'), state.shown, state.clockTime, c.width, c.height);
}

function pickShownClock() {
  const source = $('view-source').value;
  if (source === 'imported' && state.imported) return state.imported;
  if (source === 'child' && state.lastStep) return state.lastStep.child;
  if (source === 'loser' && state.lastStep) return state.lastStep.loser;
  return state.evo.best();
}

// ---- Panels ----
function drawStats() {
  const evo = state.evo;
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${Math.round(state.rate).toLocaleString('ru')}/с` : '') +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

function drawChart() {
  const c = $('chart-canvas');
  const rows = state.evo.history.concat([state.evo.counts]);
  drawPopulationChart(c.getContext('2d'), rows, c.width, c.height);
}

function drawClockInfo() {
  const clock = state.shown;
  if (!clock) { $('clock-info').innerHTML = ''; return; }
  const parents = clock.parents ? `потомок #${clock.parents[0]} и #${clock.parents[1]}` : 'из случайного начального пула';
  let html = `<div>Часы <b>#${clock.id}</b> (${parents}) · класс: <b>${CLASS_NAMES[clock.cls]}</b> · оценка <b>${clock.score.toFixed(6)}</b></div>`;

  const pend = clock.mech.moving ? clock.mech.moving.pendulum : clock.mech.pendulums[0];
  if (pend) {
    html += `<div class="muted">Маятник: длина ${formatLength(pend.length)}, период ${pend.period.toFixed(5)} с` +
      (clock.mech.moving ? ` · спусковое колесо Ш${clock.mech.moving.wheel + 1}: ${clock.genome.teeth[clock.mech.moving.wheel]} зубьев → оборот за ${(clock.genome.teeth[clock.mech.moving.wheel] * pend.period).toFixed(3)} с` : '') +
      `</div>`;
  }
  if (clock.matches.length) {
    html += '<table><tr><th>Цель</th><th>Стрелка показывает</th><th>Ошибка</th><th>Уход за сутки</th><th>Вклад в оценку</th></tr>';
    for (const m of clock.matches) {
      const err = m.error * 100;
      const cls = Math.abs(err) < 0.01 ? 'good' : Math.abs(err) > 10 ? 'bad' : '';
      html += `<tr><td>${m.target} с</td><td>${formatPeriod(m.period)} с</td>` +
        `<td class="${cls}">${formatError(err)}</td><td>${formatDrift(m)}</td><td>${m.quality.toFixed(4)}</td></tr>`;
    }
    html += '</table>';
    const extra = clock.mech.periods.length - clock.matches.length;
    if (extra > 0) html += `<div class="muted">Ещё стрелок без цели: ${extra}</div>`;
  }
  $('clock-info').innerHTML = html;
}

// Error in percent. Below a millionth of a percent we write "≈ 0" but keep the exact value:
// it is never exactly zero, because the pendulum length is a real number.
function formatError(err) {
  const exact = `${err >= 0 ? '+' : ''}${err.toPrecision(3)}%`;
  return Math.abs(err) < 1e-6 ? `≈ 0 <span class="muted">(${exact})</span>` : exact;
}

// How far this hand drifts from true time in one day.
// A hand with period P instead of T shows t*T/P after t real seconds.
function formatDrift(m) {
  const perDay = 86400 * (m.target / m.period - 1); // seconds; + means the clock runs fast
  const a = Math.abs(perDay), sign = perDay >= 0 ? 'спешит' : 'отстаёт';
  if (a < 1e-6) return '< 1 мкс';
  if (a < 1e-3) return `${sign} ${(a * 1e6).toFixed(1)} мкс`;
  if (a < 1) return `${sign} ${(a * 1e3).toFixed(1)} мс`;
  if (a < 60) return `${sign} ${a.toFixed(1)} с`;
  if (a < 3600) return `${sign} ${(a / 60).toFixed(1)} мин`;
  return `${sign} ${(a / 3600).toFixed(1)} ч`;
}

function drawGenome() {
  const c = $('genome-canvas');
  drawGenomeMatrix(c.getContext('2d'), state.shown, c.width, c.height, state.hoverPair);
}

function drawBondList() {
  const clock = state.shown;
  if (!clock) { $('bond-list').innerHTML = ''; $('jam-list').innerHTML = ''; return; }
  const byRole = {};
  for (const k of clock.genome.bonds) {
    const role = clock.mech.roles.get(k) || 'neutral';
    (byRole[role] = byRole[role] || []).push(bondName(k));
  }
  let html = `<div class="muted">Всего связей: ${clock.genome.bonds.length}</div>`;
  for (const role of Object.keys(ROLE_NAMES)) {
    const list = byRole[role];
    if (!list) continue;
    const shown = role === 'neutral' && list.length > 6 ? list.slice(0, 6).concat(`… и ещё ${list.length - 6}`) : list;
    html += `<div class="bond-role" style="--c:${ROLE_COLORS[role]}"><b>${ROLE_NAMES[role]}</b> (${list.length})` +
      `<ul>${shown.map((s) => `<li>${s}</li>`).join('')}</ul></div>`;
  }
  $('bond-list').innerHTML = html;

  const jams = [...new Set(clock.mech.jams)];
  let why = '';
  if (!clock.mech.pendulums.length) why += '<li>Нет маятника: нужна стрелка, одним концом на корпусе, другим держащая шестерню, и больше ни к чему не прикреплённая.</li>';
  else if (!clock.mech.escapement.ok) why += '<li>Нет спуска: ось храповика должна висеть на стержне маятника, а зубья храповика — держать зубья одной шестерни.</li>';
  else if (!clock.mech.moving) why += '<li>Спусковое колесо не крутится: в его группе шестерён нет пружины, или группа заклинена.</li>';
  else if (!clock.mech.hands.length) why += '<li>Передача тикает, но стрелки нет — показывать нечем (прото-часы).</li>';
  for (const j of jams) why += `<li>${j}</li>`;
  $('jam-list').innerHTML = why ? `<ul>${why}</ul>` : '<span class="good">Всё, что собрано, работает.</span>';
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, оценка ${c.score.toFixed(6)}`;
  return [
    'Из пула случайно взяли трёх и отсортировали по оценке:',
    '  ' + line('1.', s.mom),
    '  ' + line('2.', s.dad),
    '  ' + line('3.', s.loser) + '  ← погибает',
    '',
    `Скрещивание #${s.mom.id} × #${s.dad.id}: каждая клетка матрицы связей,`,
    'каждое число зубьев и каждая длина берутся у случайного родителя.',
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
$('view-source').onchange = () => refreshPanels(true);

$('btn-export').onclick = () => {
  const clock = state.shown;
  if (!clock) return;
  const data = {
    about: 'Genome of an evolved clock. bonds = list of [point, point] names.',
    class: CLASS_NAMES[clock.cls],
    score: clock.score,
    periods: clock.mech.periods,
    genome: {
      bonds: clock.genome.bonds.map((k) => PAIRS[k]),
      teeth: clock.genome.teeth,
      lengths: clock.genome.lengths,
    },
    bondNames: clock.genome.bonds.map(bondName),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `clock-${clock.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const genome = {
      bonds: data.genome.bonds.map(([a, b]) => PAIR_INDEX[a][b]).sort((x, y) => x - y),
      teeth: data.genome.teeth,
      lengths: data.genome.lengths,
    };
    state.imported = state.evo.createClock(genome, null);
    const opt = $('view-source').querySelector('option[value=imported]');
    opt.disabled = false;
    $('view-source').value = 'imported';
    refreshPanels(true);
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
  e.target.value = '';
};

// Genome matrix hover: name the bond under the mouse.
$('genome-canvas').addEventListener('mousemove', (e) => {
  const c = e.currentTarget, r = c.getBoundingClientRect();
  const x = (e.clientX - r.left) * (c.width / r.width), y = (e.clientY - r.top) * (c.height / r.height);
  const pair = genomeMatrixHitTest(x, y, c.width);
  state.hoverPair = pair;
  let text = ' ';
  if (pair) {
    const k = PAIR_INDEX[pair[0]][pair[1]];
    const has = state.shown && state.shown.genome.bonds.includes(k);
    const role = has ? (state.shown.mech.roles.get(k) || 'neutral') : null;
    text = `${pointName(pair[0])} — ${pointName(pair[1])}: ` + (has ? `есть связь (${ROLE_NAMES[role]})` : 'связи нет');
  }
  $('genome-hover').textContent = text;
  drawGenome();
});
$('genome-canvas').addEventListener('mouseleave', () => { state.hoverPair = null; drawGenome(); });

// Legends
$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');
$('genome-legend').innerHTML = Object.keys(ROLE_NAMES).map((r) => `<span style="--c:${ROLE_COLORS[r]}">${ROLE_NAMES[r]}</span>`).join('');

reset();
requestAnimationFrame(frame);
