'use strict';
// UI wiring: buttons, workers, the wind tunnel, charts, panels. Nothing here affects evolution itself.

const $ = (id) => document.getElementById(id);

const TUNNEL_CHORD = 0.4;    // m - the model in the 3D tunnel (same as view3d.js)
const TUNNEL_SPAN = 1.0;     // m - wall to wall
const AIR = { rho: 1.225, nu: 1.5e-5 };
const SHOW_EVERY = 1500;     // ms: a new best airfoil is put into the tunnel not more often

const state = {
  evo: null,
  setup: null,          // { re, tMin, margin, cmMin } of the current run
  token: 0,             // changes on every reset: results of an old run are thrown away
  running: false,
  busy: false,
  shown: null,          // airfoil on screen: { id, genome, ...evaluateAirfoil }
  analysis: null,       // analyzeAirfoil(shown.genome, setup, true)
  reference: null,      // { item, analysis } of the reference for this setup
  classics: {},
  at: null,             // analyzeAt at the current angle
  alpha: 4,
  lastShownAt: 0,
  pendingShown: null,
  lastStep: null,
  imported: null,
  picked: null,         // chosen in the gallery
  stopReason: null,
  autoStopOff: false,
  rate: 0,
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
  const one = (w, genome, setup) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    w.postMessage({ id, genome, setup });
  });
  return {
    get parallel() { return workers.length; },
    // Scores in the order of the genomes; onProgress(done, total).
    async all(genomes, setup, onProgress) {
      const results = new Array(genomes.length);
      let done = 0;
      const finish = (k, result) => { results[k] = result; done++; if (onProgress) onProgress(done, genomes.length); };
      if (workers.length === 0) {
        for (let k = 0; k < genomes.length; k++) {
          if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // let the page breathe
          finish(k, evaluateAirfoil(genomes[k], setup));
        }
        return results;
      }
      let next = 0;
      await Promise.all(workers.map(async (w) => {
        while (next < genomes.length) {
          const k = next++;
          finish(k, await one(w, genomes[k], setup));
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
    mutationsPerChild: Math.max(1, Number($('cfg-mut').value) || 1),
  };
}

function readSetup() {
  const cm = $('cfg-cm').value;
  return { ...SETUP, re: Number($('cfg-re').value), tMin: Number($('cfg-tmin').value), cmMin: cm === 'none' ? null : Number(cm) };
}

function readStopRules() {
  const on = (id) => $(id).checked;
  return {
    referenceScore: state.reference.item.score,
    beatReference: on('stop-ref-on') ? Math.max(1e-9, Number($('stop-ref').value) / 100) : 0,
    stagnation: on('stop-stag-on') ? Number($('stop-stag').value) : 0,
    maxGenerations: on('stop-max-on') ? Number($('stop-max').value) : 0,
  };
}

// Classic airfoils for the current setup (scored on the main thread: three polars, ~0.1 s).
function prepareClassics(setup) {
  const named = (id, name, genome) => ({ id, name, genome, ...evaluateAirfoil(genome, setup), parents: null });
  const code = referenceCode(setup);
  state.classics = {
    reference: named('ref', `NACA ${code}`, nacaGenome(code)),
    n0012: named('0012', 'NACA 0012', nacaGenome('0012')),
    n2412: named('2412', 'NACA 2412', nacaGenome('2412')),
  };
  state.reference = { item: state.classics.reference, analysis: analyzeAirfoil(state.classics.reference.genome, setup, true) };
  $('view-source').querySelector('option[value=reference]').textContent = `Эталон: NACA ${code}`;
}

async function reset() {
  const token = ++state.token;
  setRunning(false);
  state.evo = null;
  state.lastStep = null;
  state.stopReason = null;
  state.autoStopOff = false;
  state.setup = readSetup();
  prepareClassics(state.setup);
  $('step-log').textContent = 'Нажми «1 пачка», чтобы увидеть шаг эволюции подробно.';
  const evo = new Evolution(readConfig());
  const genomes = evo.firstGenomes();
  const results = await evaluator.all(genomes, state.setup, (done, total) => {
    if (token !== state.token) return;
    state.progress = `Стартовый пул: продуто ${done} из ${total} профилей…`;
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
  const started = performance.now();
  const results = await evaluator.all(proposals.map((p) => p.genome), state.setup);
  state.busy = false;
  if (token !== state.token) return false;
  state.rate = 0.8 * state.rate + 0.2 * BATCH / ((performance.now() - started) / 1000);
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

// ---- The airfoil on screen ----

function pickShown() {
  const evo = state.evo, src = $('view-source').value;
  if (state.classics[src]) return state.classics[src];
  if (src === 'imported' && state.imported) return state.imported;
  if (src === 'gallery' && state.picked) return state.picked;
  if (!evo) return state.classics.reference;
  if (src === 'child' && state.lastStep) return state.lastStep.child;
  if (src === 'loser' && state.lastStep) return state.lastStep.loser;
  return evo.best();
}

function show(item) {
  state.shown = item;
  state.pendingShown = null;
  state.lastShownAt = performance.now();
  state.analysis = analyzeAirfoil(item.genome, state.setup, true);
  setAlpha(state.analysis.work ? state.analysis.work.alpha : 4);
  drawScoreInfo();
  drawGenome();
}

// A new airfoil to show: right away if the viewer asked for it; a new best - not more often than SHOW_EVERY.
function offerShown(item, now) {
  if (!state.shown || now) { show(item); return; }
  if (item.id === state.shown.id) return;
  state.pendingShown = item;
}

function setAlpha(a) {
  state.alpha = Math.max(ALPHAS[0], Math.min(ALPHAS[ALPHAS.length - 1], a));
  $('alpha').value = state.alpha;
  $('alpha-out').textContent = `${state.alpha.toFixed(1)}°`;
  updateFlow();
}

// The flow at the current angle: charts, tunnel, readouts.
function updateFlow() {
  if (!state.analysis || !state.analysis.P) {
    state.at = null;
    if (state.view3d) state.view3d.setFlow(null, null);
    drawCharts();
    drawLive();
    return;
  }
  state.at = analyzeAt(state.analysis.P, state.alpha, state.setup.re);
  if (state.view3d) state.view3d.setFlow(state.shown.genome, state.at);
  drawCharts();
  drawLive();
}

function canvasCtx(id) {
  const c = $(id);
  return [c.getContext('2d'), c.width, c.height];
}

function drawCharts() {
  const a = state.analysis, ref = state.reference.analysis;
  const isRef = state.shown === state.reference.item;
  const [cpCtx, cw, ch] = canvasCtx('cp-canvas');
  drawCpChart(cpCtx, state.shown.genome, state.at, isRef ? null : state.reference.item.genome, cw, ch);
  const [pCtx, pw, ph] = canvasCtx('polar-canvas');
  drawPolar(pCtx, a.points, isRef ? null : ref.points, state.at, a.work, pw, ph);
  const [lCtx, lw, lh] = canvasCtx('cla-canvas');
  drawClAlpha(lCtx, a.points, isRef ? null : ref.points, state.alpha, a.work, state.setup.margin, lw, lh);
}

function drawLive() {
  const at = state.at;
  if (!at) { $('live').textContent = 'Это не профиль: поверхности пересекаются, продуть нельзя.'; return; }
  const v = state.setup.re * AIR.nu / TUNNEL_CHORD, q = 0.5 * AIR.rho * v * v, area = TUNNEL_CHORD * TUNNEL_SPAN;
  const fmt = (x) => (x === null ? 'нет' : `${(100 * x).toFixed(0)}%`);
  const sep = (s) => (s.separationX === null || s.separationX >= 0.995 ? 'нет'
    : s.separationX >= AERO.attachedTo ? `${fmt(s.separationX)} (у кромки, допустимо)` : `<b class="bad">${fmt(s.separationX)}</b>`);
  $('live').innerHTML =
    `Труба: модель хордой ${TUNNEL_CHORD * 100} см и размахом ${TUNNEL_SPAN} м, поток <b>${v.toFixed(1)} м/с</b> (Re ${state.setup.re.toExponential(0)}). ` +
    `Весы: подъёмная сила <b>${(at.cl * q * area).toFixed(0)} Н</b>, сопротивление <b>${(at.cd * q * area).toFixed(1)} Н</b> ` +
    `(трение ${(100 * at.cdf / at.cd).toFixed(0)}%), момент ${(at.cm * q * area * TUNNEL_CHORD).toFixed(1)} Н·м.<br>` +
    `α <b>${at.alpha.toFixed(1)}°</b> · Cl <b>${at.cl.toFixed(3)}</b> · Cd <b>${at.cd.toFixed(5)}</b> · ` +
    `качество L/D <b class="${at.attached ? 'good' : 'bad'}">${at.ld.toFixed(1)}</b> · Cm ${at.cm.toFixed(3)} · ` +
    `переход верх ${fmt(at.upper.transitionX)}${at.upper.bubble ? ' (через ламинарный отрыв)' : ''}, низ ${fmt(at.lower.transitionX)} · ` +
    `отрыв верх ${sep(at.upper)}, низ ${sep(at.lower)}` +
    (at.attached ? '' : ' · <b class="bad">СРЫВ</b>: дальше модель только намекает');
}

// ---- Panels ----

function drawStats() {
  const evo = state.evo;
  if (!evo) {
    $('stats').textContent = state.progress;
    document.title = 'Стартовый пул… — Профиль крыла';
    return;
  }
  document.title = `${state.running ? '▶ ' : ''}Поколение ${Math.floor(evo.generation)} · ${evo.bestScore.toFixed(1)} — Профиль крыла`;
  $('stats').innerHTML =
    `Seed <b>${evo.cfg.seed}</b> · поколение <b>${evo.generation.toFixed(1)}</b> · спариваний <b>${evo.matings.toLocaleString('ru')}</b>` +
    (state.running ? ` · ${state.rate.toFixed(0)} профилей/с (${evaluator.parallel || 'нет'} потоков)` : '') +
    ` · лучшая оценка <b>${evo.bestScore.toFixed(2)}</b> (эталон ${state.reference.item.score.toFixed(2)})` +
    ` · без улучшений ${Math.floor(evo.generationsWithoutImprovement)} пок.` +
    (state.stopReason ? ` · <span class="stopped">Остановлено: ${state.stopReason}` +
      (state.autoStopOff ? ' (продолжаю без автостопа до «Сброс»)' : '') + '</span>' : '');
}

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;

function drawScoreInfo() {
  const d = state.shown, a = state.analysis, s = state.setup, w = a.work, ref = state.reference.item;
  if (d.cls === 0) { $('score-info').innerHTML = '<p class="bad">Поверхности пересекаются — это не профиль. Оценка 0.</p>'; return; }
  const rows = [];
  rows.push(['Рабочий угол', w ? `${w.alpha.toFixed(1)}°` : '<span class="bad">нет</span>',
    `лучшее качество среди углов, у которых поток не отрывается и ещё ${s.margin}° выше`]);
  rows.push(['Качество L/D', w ? w.ld.toFixed(1) : '—', w ? `Cl ${w.cl.toFixed(3)} / Cd ${w.cd.toFixed(5)}` : 'профиль срывается раньше, чем набирает запас']);
  rows.push(['× толщина', a.thin.toFixed(3), `${pct(a.geo.t)} при норме ${pct(s.tMin, 0)}${a.thin < 1 ? ': штраф (t / норма)⁴' : ''}`]);
  if (s.cmMin !== null) rows.push(['× момент', a.moment.toFixed(3), w ? `Cm ${w.cm.toFixed(3)}, нужно не ниже ${s.cmMin}` : '']);
  rows.push(['= оценка', `<b>${d.score.toFixed(2)}</b>`, d === ref ? 'это эталон' : `эталон ${ref.name}: ${ref.score.toFixed(2)} (${d.score >= ref.score ? '+' : ''}${(100 * (d.score / ref.score - 1)).toFixed(1)}%)`]);
  $('score-info').innerHTML =
    `<table class="score-table">${rows.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table>` +
    `<div class="formula">оценка = L/D на рабочем угле × min(1, t / ${s.tMin})⁴${s.cmMin !== null ? ` × штраф за Cm < ${s.cmMin}` : ''}</div>` +
    `<p class="note">Класс: <b>${CLASS_NAMES[d.cls]}</b>. Cl max без отрыва ${a.clMax.toFixed(2)}` +
    `${a.alphaStall !== null ? `, срыв с ${a.alphaStall.toFixed(1)}°` : ''}.</p>`;
}

function drawGenome() {
  const d = state.shown, g = d.genome, geo = state.analysis.geo;
  const [ctx, w, h] = canvasCtx('genome-canvas');
  drawGenome2d(ctx, g, d === state.reference.item ? null : state.reference.item.genome, w, h);
  const list = (arr) => arr.map((v) => v.toFixed(3)).join(' ');
  $('genome-info').innerHTML = `<table>
    <tr><th>Имя</th><td>${d.name || '#' + d.id}${d.parents ? ` (родители #${d.parents.join(', #')})` : ''}</td></tr>
    <tr><th>Верх (6 весов)</th><td>${list(g.u)}</td></tr>
    <tr><th>Низ (6 весов)</th><td>${list(g.l)}</td></tr>
    <tr><th>Толщина</th><td>${pct(geo.t)} в ${pct(geo.tAt, 0)} хорды; на 80% хорды ${pct(geo.tRear)}</td></tr>
    <tr><th>Кривизна</th><td>${pct(geo.camber)} в ${pct(geo.camberAt, 0)} хорды</td></tr>
    <tr><th>Радиус носка</th><td>${pct(geo.noseRadius, 2)} хорды</td></tr>
  </table>`;
}

function drawGallery() {
  const evo = state.evo, box = $('gallery');
  if (!evo) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  for (const d of evo.top(12)) {
    const fig = document.createElement('figure');
    if (state.shown && d.id === state.shown.id) fig.className = 'active';
    const c = document.createElement('canvas');
    c.width = 240; c.height = 90;
    drawMini(c.getContext('2d'), d.genome, c.width, c.height, CLASS_COLORS[d.cls] + '66');
    const cap = document.createElement('figcaption');
    cap.textContent = `#${d.id} · ${d.score.toFixed(1)}${d.alpha !== null ? ` · ${d.alpha}°` : ''}`;
    fig.append(c, cap);
    fig.onclick = () => {
      state.picked = d;
      const opt = $('view-source').querySelector('option[value=gallery]');
      opt.disabled = false;
      opt.textContent = `Из галереи: #${d.id}`;
      $('view-source').value = 'gallery';
      offerShown(d, true);
      drawGallery();
    };
    box.append(fig);
  }
}

function describeStep(s) {
  const line = (label, c) => `${label} #${c.id}: ${CLASS_NAMES[c.cls]}, оценка ${c.score.toFixed(2)}` +
    (c.ld !== null ? ` (L/D ${c.ld.toFixed(1)} при ${c.alpha}°, толщина ${pct(c.t)}, кривизна ${pct(c.camber)})` : '');
  return [
    `Последний потомок из пачки в ${BATCH}:`,
    'Родители — лучшие двое из трёх случайных, погибший — худший из трёх случайных.',
    'Скрещивание: каждый из 6 бугров (верх и низ вместе) берётся от мамы или от папы.', '',
    line('Мама', s.mom), line('Папа', s.dad), '',
    'Мутации потомка:', ...s.mutations.map((m) => '  · ' + m), '',
    line('Потомок', s.child), line('Погиб', s.loser),
  ].join('\n');
}

let lastPanelsAt = 0;
function refreshPanels(force) {
  const now = performance.now();
  drawStats();
  if (!force && now - lastPanelsAt < 400) return;
  lastPanelsAt = now;
  const evo = state.evo;
  if (evo) {
    const [ctx, w, h] = canvasCtx('chart-canvas');
    drawPoolChart(ctx, evo.history, state.reference.item.score, w, h);
    drawGallery();
  }
  const src = $('view-source').value;
  if (evo && (src === 'best' || src === 'child' || src === 'loser')) {
    const next = pickShown();
    if (next && (!state.shown || next.id !== state.shown.id)) {
      if (src !== 'best' || force) offerShown(next, true);
      else state.pendingShown = next;
    }
  }
  if (state.pendingShown && (force || now - state.lastShownAt > SHOW_EVERY)) show(state.pendingShown);
}

// ---- Export ----

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

$('btn-export').onclick = () => {
  const d = state.shown;
  download(`airfoil-${d.id}.json`, JSON.stringify({
    about: 'Airfoil as CST weights (Kulfan): y(x) = sqrt(x)(1-x) * sum A_i * C(5,i) x^i (1-x)^(5-i); u - upper surface, l - lower; chord 1.',
    setup: state.setup,
    score: d.score,
    workingPoint: state.analysis.work,
    genome: d.genome,
  }, null, 2), 'application/json');
};

// Selig .dat: name, then x y from the tail over the upper surface to the nose and along the lower surface back.
$('btn-dat').onclick = () => {
  const g = state.shown.genome, lines = [`GA-airfoil-${state.shown.id}`];
  for (let k = STATIONS.length - 1; k >= 0; k--) lines.push(`${STATIONS[k].toFixed(6)} ${cstY(g.u, STATIONS[k]).toFixed(6)}`);
  for (let k = 1; k < STATIONS.length; k++) lines.push(`${STATIONS[k].toFixed(6)} ${cstY(g.l, STATIONS[k]).toFixed(6)}`);
  download(`airfoil-${state.shown.id}.dat`, lines.join('\n') + '\n', 'text/plain');
};

$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const g = data.genome;
    const nums = (list, name) => {
      if (!Array.isArray(list) || list.length !== CST_ORDER + 1 || !list.every(Number.isFinite)) throw new Error(`поле ${name}: нужно ${CST_ORDER + 1} чисел`);
      return list.slice();
    };
    if (!g) throw new Error('нет поля genome');
    const genome = fixWeights({ u: nums(g.u, 'u'), l: nums(g.l, 'l') });
    state.imported = { id: 'file', name: file.name, genome, ...evaluateAirfoil(genome, state.setup), parents: null };
    $('view-source').querySelector('option[value=imported]').disabled = false;
    $('view-source').value = 'imported';
    offerShown(state.imported, true);
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
  e.target.value = '';
};

// ---- Controls ----

$('btn-run').onclick = () => setRunning(!state.running);
$('btn-step').onclick = async () => { setRunning(false); if (await oneBatch()) refreshPanels(true); };
$('btn-reset').onclick = () => reset();
$('btn-new-seed').onclick = () => { $('cfg-seed').value = 1 + Math.floor(Math.random() * 1e6); reset(); };
$('view-source').onchange = () => offerShown(pickShown(), true);
$('btn-work').onclick = () => setAlpha(state.analysis.work ? state.analysis.work.alpha : 4);

// The slider recomputes the flow (~1 ms) and the smoke (~50 ms): once per animation frame at most.
let alphaWanted = null;
$('alpha').oninput = () => { alphaWanted = Number($('alpha').value); $('alpha-out').textContent = `${alphaWanted.toFixed(1)}°`; };
const viewOptions = () => ({ smoke: $('show-smoke').checked, pressure: $('show-pressure').checked, forces: $('show-forces').checked });
for (const id of ['show-smoke', 'show-pressure', 'show-forces']) $(id).onchange = () => state.view3d && state.view3d.setOptions(viewOptions());

let lastFrame = performance.now();
function frame(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (alphaWanted !== null) { const a = alphaWanted; alphaWanted = null; setAlpha(a); }
  if (state.view3d) {
    const v = state.setup.re * AIR.nu / TUNNEL_CHORD;
    state.view3d.render(dt, Number($('time-scale').value) * v / TUNNEL_CHORD);
  }
  requestAnimationFrame(frame);
}

$('chart-legend').innerHTML = CLASS_NAMES.map((n, i) => `<span style="--c:${CLASS_COLORS[i]}">${n}</span>`).join('');

// The 3D view is an ES module: it may come after this script, or not at all (file://).
function start3d() {
  if (state.view3d || !window.View3D) return;
  state.view3d = window.View3D.create($('view3d'));
  state.view3d.setOptions(viewOptions());
  if (state.shown) state.view3d.setFlow(state.shown.genome, state.at);
}
window.addEventListener('view3d-ready', start3d);
start3d();
setTimeout(() => {
  if (!state.view3d) {
    $('view3d').innerHTML = '<div class="fallback">3D-труба не загрузилась. Страницу нужно открыть через http-сервер, ' +
      'а не двойным кликом: из папки genetic запустить «python3 -m http.server 8765» и открыть http://localhost:8765/wing/</div>';
  }
}, 3000);
if (!evaluator.parallel) {
  state.progress = 'Фоновые потоки недоступны (страница открыта как файл): считаю в основном потоке, медленнее.';
}

state.setup = readSetup();
prepareClassics(state.setup);
show(state.classics.reference);
requestAnimationFrame(frame);
reset();
