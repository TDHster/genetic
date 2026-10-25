'use strict';
// UI wiring: buttons, workers, the storm on screen, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

// Designs that are not in the pool: the reference and the bare coast (scored here, on the main thread).
const REFERENCE_DESIGN = { id: 'ref', genome: copyDesign(REFERENCE), ...evaluateDesign(REFERENCE), parents: null };
const BARE_DESIGN = { id: 'bare', genome: { segments: [] }, ...evaluateDesign({ segments: [] }), parents: null };

const state = {
  evo: null,
  token: 0,             // changes on every reset: results of an old run are thrown away
  running: false,
  busy: false,          // a batch is being scored
  shown: null,          // design on screen
  pendingShown: null,   // the best changed: shown when the current storm ends
  lastStep: null,
  imported: null,
  pinnedSpecies: null,
  stopReason: null,
  autoStopOff: false,
  rate: 0,
  section: 30,          // column of the cross-section
  sim: null,            // the storm on screen
  pause: 0,             // seconds to wait after a storm before it starts again
  view3d: null,
  progress: '',
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
  // Results of designs that build the same thing are the same: see ScoreCache in fitness.js.
  // It lives here, on the main thread, and is kept across resets (the storm does not change).
  const cache = new ScoreCache();
  let asked = 0, simulated = 0;
  return {
    get parallel() { return workers.length; },
    get savedShare() { return asked ? 1 - simulated / asked : 0; },
    // Scores in the order of the genomes; onProgress(done, total).
    async all(genomes, onProgress) {
      const results = new Array(genomes.length);
      const found = genomes.map((g) => cache.lookup(g));
      const todo = new Map(); // key -> indices of the genomes that build it: simulated once
      found.forEach((f, k) => {
        if (f.result) results[k] = f.result;
        else if (todo.has(f.key)) todo.get(f.key).push(k);
        else todo.set(f.key, [k]);
      });
      const jobs = [...todo.entries()];
      asked += genomes.length;
      simulated += jobs.length;
      let done = genomes.length - jobs.reduce((sum, [, ks]) => sum + ks.length, 0);
      const finish = ([key, ks], result) => {
        cache.store(key, result);
        for (const k of ks) results[k] = { ...result, parts: found[k].parts };
        done += ks.length;
        if (onProgress) onProgress(done, genomes.length);
      };
      if (workers.length === 0) {
        for (const job of jobs) {
          await new Promise((r) => setTimeout(r, 0)); // let the page breathe
          finish(job, evaluateDesign(genomes[job[1][0]]));
        }
        return results;
      }
      let next = 0;
      await Promise.all(workers.map(async (w) => {
        while (next < jobs.length) {
          const job = jobs[next++];
          finish(job, await one(w, genomes[job[1][0]]));
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
    state.progress = `Стартовый пул: шторм прошли ${done} из ${total} проектов…`;
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

// ---- The storm on screen ----

function pickShown() {
  const evo = state.evo, src = $('view-source').value;
  if (src === 'reference') return REFERENCE_DESIGN;
  if (src === 'bare') return BARE_DESIGN;
  if (src === 'imported' && state.imported) return state.imported;
  if (!evo) return REFERENCE_DESIGN;
  if (src === 'child' && state.lastStep) return state.lastStep.child;
  if (src === 'loser' && state.lastStep) return state.lastStep.loser;
  if (src === 'species' && state.pinnedSpecies !== null) {
    const row = evo.speciesTable().find((r) => r.parts === state.pinnedSpecies);
    if (row) return row.best;
  }
  return evo.best();
}

function startStorm(design) {
  state.shown = design;
  state.pendingShown = null;
  state.sim = new WaveSim(buildWorld(design.genome, EVAL_DX), STORM);
  state.pause = 0;
  if (state.view3d) state.view3d.setSim(state.sim);
  drawScoreInfo();
  drawGenome();
}

// A new design to show: right away if the viewer asked for it, after the storm if it is just a new best.
function offerShown(design, now) {
  if (!state.shown || now) startStorm(design);
  else if (design.id !== state.shown.id) state.pendingShown = design;
}

let lastFrame = performance.now();
function frame(time) {
  const dt = Math.min(0.1, (time - lastFrame) / 1000);
  lastFrame = time;
  const sim = state.sim;
  if (sim) {
    if (sim.done) {
      state.pause += dt;
      if (state.pause > 2) startStorm(state.pendingShown || state.shown);
    } else {
      // Advance the model by playback-speed x real time (capped, so a slow machine does not freeze).
      const target = Math.min(sim.storm.duration, sim.t + dt * Number($('play-speed').value));
      const t0 = performance.now();
      while (sim.t < target && performance.now() - t0 < 12) sim.step();
    }
    const plan = $('plan-canvas'), sec = $('section-canvas');
    drawPlan(plan.getContext('2d'), state.sim, state.section, plan.width, plan.height);
    drawSection(sec.getContext('2d'), state.sim, state.section, sec.width, sec.height);
    drawLive();
  }
  if (state.view3d) state.view3d.render(dt);
  requestAnimationFrame(frame);
}

function drawLive() {
  const sim = state.sim, s = sim.storm;
  const tl = $('timeline');
  tl.querySelector('.ramp').style.width = `${(100 * s.measureFrom / s.duration).toFixed(1)}%`;
  tl.querySelector('.done').style.cssText = `left:${(100 * s.measureFrom / s.duration).toFixed(1)}%;` +
    `width:${(100 * Math.max(0, sim.t - s.measureFrom) / s.duration).toFixed(1)}%`;
  let text = `t = ${sim.t.toFixed(0)} из ${s.duration} с`;
  if (sim.t < s.measureFrom) text += ' · волны подходят к стенке, перехлёст пока не считается';
  else {
    const q = worstOvertopping(sim.overtopping().q);
    text += ` · перехлёст (худшая четверть стенки) <b class="${q <= Q_SAFE ? 'good' : 'bad'}">${q.toFixed(2)} л/с·м</b>`;
  }
  if (sim.blocks && sim.blocks.cells.length) {
    const volume = designCost(sim.world).volume;
    text += ` · смыто ${(100 * sim.washed / volume).toFixed(1)}% блоков`;
  }
  if (sim.done) text += ' · шторм кончился, сейчас начнётся заново';
  if (state.pendingShown) text += ' · после шторма покажу новый лучший проект';
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
    document.title = 'Стартовый пул… — Защита набережной';
    return;
  }
  // The tab title shows the stage of evolution, so it can be watched from another tab.
  document.title = `${state.running ? '▶ ' : ''}Поколение ${Math.floor(evo.generation)} · ${evo.bestScore.toFixed(1)} — Защита набережной`;
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${state.rate.toFixed(1)} проектов/с (${evaluator.parallel || 'нет'} потоков)` : '') +
    ` · из кэша ${(100 * evaluator.savedShare).toFixed(0)}%` +
    ` · лучшая оценка <b>${evo.bestScore.toFixed(2)}</b> (эталон ${REFERENCE_SCORE.toFixed(2)})` +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

const money = (v) => `${(v / 1000).toFixed(0)} тыс.`;

function drawScoreInfo() {
  const d = state.shown, r = REFERENCE_DESIGN, b = BARE_DESIGN;
  const who = d === REFERENCE_DESIGN ? 'Эталон' : d === BARE_DESIGN ? 'Берег без защиты'
    : `Проект #${d.id} (${d.parents ? `потомок #${d.parents[0]} и #${d.parents[1]}` : d === state.imported ? 'из файла' : 'из случайного стартового пула'})`;
  let html = `<div>${who} · класс: <b>${CLASS_NAMES[d.cls]}</b> · оценка <b>${d.score.toFixed(2)}</b>` +
    (d.score > 0 ? ` · ${(100 * d.score / REFERENCE_SCORE).toFixed(0)}% от эталона` : '') + '</div>';
  if (d.cls === 0) {
    $('score-info').innerHTML = html + `<p class="muted">Ничего не построено: перехлёст как у голого берега, ${b.q.toFixed(1)} л/с·м. Оценка 0.</p>`;
    return;
  }
  const row = (name, mine, ref, note) => `<tr><td>${name}</td><td><b>${mine}</b></td><td>${ref}</td><td>${note}</td></tr>`;
  const qText = (x) => `${x.q.toFixed(2)} л/с·м → ${x.protection.toFixed(2)}`;
  html += '<table class="score-table"><tr><th>Множитель</th><th>Этот проект</th><th>Эталон</th><th>Что значит</th></tr>' +
    row('Защита', qText(d), qText(r), `перехлёст на худшей четверти стенки; без защиты ${b.q.toFixed(1)}, безопасно ≤ ${Q_SAFE} (тогда 1); шкала логарифмическая`) +
    row('Экономия', `${money(d.cost.price)} → ${d.economy.toFixed(2)}`, `${money(r.cost.price)} → ${r.economy.toFixed(2)}`, `1 / (1 + цена / ${money(BUDGET)}); ${d.cost.volume.toFixed(0)} м³ блоков`) +
    row('Целость', `смыто ${(100 * d.damage).toFixed(1)}% → ${d.integrity.toFixed(2)}`, `смыто ${(100 * r.damage).toFixed(1)}% → ${r.integrity.toFixed(2)}`, '(доля уцелевших блоков)⁴: что рушится сейчас, не переживёт следующий шторм') +
    '</table>' +
    `<div class="formula">оценка = 1 + 100 × ${d.protection.toFixed(2)} × ${d.economy.toFixed(2)} × ${d.integrity.toFixed(2)} = <b>${d.score.toFixed(2)}</b></div>` +
    `<p class="note">Средний перехлёст по всей стенке: ${d.qMean.toFixed(2)} л/с·м (без защиты ${b.qMean.toFixed(1)}).</p>`;
  $('score-info').innerHTML = html;
}

function drawGenome() {
  const d = state.shown, g = d.genome;
  if (!g.segments.length) { $('genome-info').innerHTML = '<span class="muted">Сегментов нет.</span>'; return; }
  const world = buildWorld(g, EVAL_DX);
  let html = `<div class="muted">Сегментов: ${g.segments.length}, строят что-то: ${world.segmentCells.filter((n) => n > 0).length}. ` +
    'Угол 0° — вдоль берега (волнолом), 90° — в море (буна). Гребень — над спокойной водой; при шторме вода на 1,5 м выше. ' +
    'Бледные строки — сегменты, которые ничего не строят.</div>';
  html += '<table><tr><th>#</th><th>Центр (x, y)</th><th>Угол</th><th>Длина × ширина</th><th>Гребень</th><th>Из чего</th></tr>';
  g.segments.forEach((s, k) => {
    const style = world.segmentCells[k] > 0 ? '' : ' class="muted"';
    const bl = BLOCKS[s.block];
    html += `<tr${style}><td>${k + 1}</td><td>${s.x.toFixed(0)}, ${s.y.toFixed(0)} м</td><td>${s.angle.toFixed(0)}°</td>` +
      `<td>${s.length.toFixed(0)} × ${s.width.toFixed(0)} м</td><td>${s.crest >= 0 ? '+' : ''}${s.crest.toFixed(1)} м</td>` +
      `<td><span class="swatch" style="background:${bl.color}"></span>${bl.name}</td></tr>`;
  });
  $('genome-info').innerHTML = html + '</table>';
}

function drawSpecies() {
  const rows = state.evo.speciesTable();
  const on = state.evo.cfg.speciation;
  let html = on ? '' : '<div class="muted">Виды выключены: турнир идёт по всему пулу, квот нет. Таблица — просто состав пула.</div>';
  html += `<table><tr><th>Сегментов</th><th>Проектов</th>${on ? '<th>Квота</th>' : ''}<th>Лучшая оценка</th></tr>`;
  for (const r of rows) {
    const mark = r.parts === state.pinnedSpecies && $('view-source').value === 'species' ? ' ◀' : '';
    html += `<tr class="clickable" data-parts="${r.parts}"><td>${r.parts}</td><td>${r.size}</td>` +
      (on ? `<td>${r.quota.toFixed(0)}</td>` : '') + `<td>${r.best.score.toFixed(1)}${mark}</td></tr>`;
  }
  $('species-info').innerHTML = html + '</table>';
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, ${c.parts} сегм., оценка ${c.score.toFixed(2)}` +
    (c.cls > 0 ? ` (перехлёст ${c.q.toFixed(2)} л/с·м, ${money(c.cost.price)}, смыто ${(100 * c.damage).toFixed(1)}%)` : '');
  const head = s.parentSpecies !== null
    ? [`Родителей выбрали в виде «${s.parentSpecies} сегм.» (вид берётся с вероятностью по квоте),`,
      `погибший — из вида «${s.deathSpecies} сегм.» (он сильнее всех превысил квоту).`, '']
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
$('btn-replay').onclick = () => startStorm(state.shown);
$('vertical').onchange = () => { if (state.view3d) state.view3d.setVertical(Number($('vertical').value)); };
$('plan-canvas').onclick = (e) => {
  if (!state.sim) return;
  const c = e.currentTarget, rect = c.getBoundingClientRect();
  state.section = planColumn(state.sim, c.width, c.height, (e.clientX - rect.left) * c.width / rect.width);
};
$('species-info').onclick = (e) => {
  const tr = e.target.closest('tr[data-parts]');
  if (!tr) return;
  state.pinnedSpecies = Number(tr.dataset.parts);
  const opt = $('view-source').querySelector('option[value=species]');
  opt.disabled = false;
  opt.textContent = `Лучший проект вида: ${state.pinnedSpecies} сегм.`;
  $('view-source').value = 'species';
  offerShown(pickShown(), true);
  drawSpecies();
};

$('btn-export').onclick = () => {
  const d = state.shown;
  const data = {
    about: 'Coastal defence design. Segments: centre x (along the shore) and y (from the sea, wall at ' +
      `${WORLD.WALL_Y} m), angle (deg, 0 = parallel to the shore), length, width (m), crest (m above still water), ` +
      'block (index in BLOCKS: ' + BLOCKS.map((b, i) => `${i} ${b.name}`).join(', ') + ').',
    score: d.score,
    referenceScore: REFERENCE_SCORE,
    overtopping: d.q,
    price: d.cost && d.cost.price,
    genome: d.genome,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `coast-${d.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.genome || !Array.isArray(data.genome.segments)) throw new Error('нет списка сегментов');
    const genome = copyDesign(data.genome);
    for (const s of genome.segments) {
      for (const key of Object.keys(RANGES)) {
        if (!Number.isFinite(s[key])) throw new Error(`у сегмента нет поля ${key}`);
        s[key] = clamp(s[key], RANGES[key]);
      }
      if (!(s.block >= 0 && s.block < BLOCKS.length)) throw new Error('нет такого материала: ' + s.block);
    }
    state.imported = { id: 'file', genome, ...evaluateDesign(genome), parents: null };
    $('view-source').querySelector('option[value=imported]').disabled = false;
    $('view-source').value = 'imported';
    offerShown(state.imported, true);
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
  e.target.value = '';
};

$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');
$('plan-legend').innerHTML = BLOCKS.map((b) => `<span style="--c:${b.color}">${b.name}</span>`).join('') +
  `<span style="--c:${COLORS.damage}">смытые блоки</span><span style="--c:${COLORS.wall}">стенка</span>`;

// The 3D view is an ES module: it may come after this script, or not at all (file://).
function start3d() {
  if (state.view3d || !window.View3D) return;
  state.view3d = window.View3D.create($('view3d'));
  state.view3d.setVertical(Number($('vertical').value));
  if (state.sim) state.view3d.setSim(state.sim);
}
window.addEventListener('view3d-ready', start3d);
start3d();
setTimeout(() => {
  if (!state.view3d) {
    $('view3d').innerHTML = '<div class="fallback">3D-вид не загрузился. Страницу нужно открыть через http-сервер, ' +
      'а не двойным кликом: из папки genetic запустить «python3 -m http.server 8765» и открыть http://localhost:8765/coast/</div>';
  }
}, 3000);
if (!evaluator.parallel) {
  state.progress = 'Фоновые потоки недоступны (страница открыта как файл): считаю в основном потоке, медленно.';
}

startStorm(REFERENCE_DESIGN);
requestAnimationFrame(frame);
reset();
