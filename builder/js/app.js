// UI: buttons, the evolution loop, the 3D replay of the best structure, panels, import and export.
// Evolution runs asynchronously: IN_FLIGHT children are always being scored by Web Workers, and a new
// child starts as soon as one is done (see Evolution.startChild). The 3D view replays the best
// structure in the main thread with the same physics code.

import RAPIER from '../vendor/rapier-simd.mjs';
import { Evolution, BASE_BINS, TAPER_BINS } from './evolution.js';
import { WorkerPool } from './workers.js';
import { StructureView } from './scene3d.js';
import { drawHistory, drawProfile, drawMap } from './charts.js';
import { makeQuarry } from './stones.js';

const $ = (id) => document.getElementById(id);

const WORKERS = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
const IN_FLIGHT = 2 * WORKERS;   // children being scored at once: a worker never waits for a job
const FOLLOW_DELAY = 1500;   // ms on the final picture before switching to a newer best

let view = null;
let pool = null;
let evo = null;
let running = false;
let busy = null;             // reset in progress
const inFlight = new Set();  // promises of children being scored
let targetMatings = 0;       // "1 поколение": keep starting children until this many matings
let widening = null;         // the promise of widening the passage (no children start meanwhile)
let stoppedBy = null;
let genTimes = [];           // timestamps of recent generations, for the speed
let evalTimes = [];          // timestamps of recent scored children, for the speed
let shown = null;            // what the 3D view shows: {kind: 'best'|'imported', id, data}
let finishedAt = 0;
let mapHit = null;           // (x, y) -> map cell key, from the last drawMap

const evaluateAll = (genomes, thresholds) => pool.evaluateAll(genomes, thresholds);

function readConfig() {
  return {
    seed: Number($('cfg-seed').value) || 1,
    poolSize: Number($('cfg-pool').value),
    stoneCount: Number($('cfg-stones').value),
    scaffold: $('cfg-scaffold').checked,
    tiltDeg: $('cfg-tilt-on').checked ? Number($('cfg-tilt').value) : 0,
    pile: $('cfg-pile').checked,
    noEnd: $('cfg-noend').checked,
    gateWidth: $('cfg-gate-on').checked ? Number($('cfg-gate').value) : 0,
    gateArch: $('cfg-arch').checked,
    mirror: $('cfg-mirror').checked,
    gateGrow: $('cfg-gate-grow').checked,
  };
}

function applyStopRules() {
  if (!evo) return;
  evo.cfg.stagnation = $('stop-stag-on').checked ? Number($('stop-stag').value) : 0;
  evo.cfg.maxGenerations = $('stop-max-on').checked ? Number($('stop-max').value) : 0;
}

// Waits until every child in flight is scored (nothing new starts while not running).
async function drain() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

async function reset() {
  running = false;
  targetMatings = 0;
  updateRunButton();
  if (busy) await busy;
  if (widening) await widening;
  await drain();
  stoppedBy = null;
  genTimes = [];
  evalTimes = [];
  evo = new Evolution(readConfig());
  applyStopRules();
  $('stats').textContent = 'Создаю стартовый пул…';
  busy = pool.init(evo.evalConfig()).then(() => evo.init(evaluateAll));
  await busy;
  busy = null;
  updatePanels();
  showBest();
}

function wantMore() {
  return !widening && (running || evo.matings + inFlight.size < targetMatings);
}

// The passage widens (see Evolution.gateReady): wait for the children in flight, give the workers the
// new width, score the pool again, go on.
async function widen() {
  const e = evo;
  widening = (async () => {
    await drain();
    e.widenGate();
    await pool.init(e.evalConfig());
    await e.rescore(evaluateAll);
  })();
  await widening;
  widening = null;
  if (e !== evo) return;
  updatePanels();
  showBest();
  fill();
}

// Keeps IN_FLIGHT children being scored while evolution should go on.
function fill() {
  const e = evo;
  while (wantMore() && inFlight.size < IN_FLIGHT) {
    const job = e.startChild();
    const p = pool.evaluate(job.genome, job.abortBelow).then((result) => {
      inFlight.delete(p);
      if (e !== evo) return;   // a reset happened meanwhile
      const gen = Math.floor(e.generation);
      e.finishChild(job, result);
      evalTimes.push(performance.now());
      if (evalTimes.length > 200) evalTimes.shift();
      if (Math.floor(e.generation) > gen) {
        genTimes.push(performance.now());
        if (genTimes.length > 10) genTimes.shift();
        updatePanels();
      }
      if (!widening && e.gateReady()) widen();
      const reason = running && e.stopReason();
      if (reason) {
        stoppedBy = reason;
        running = false;
        updateRunButton();
        updatePanels();
      }
      fill();
    });
    inFlight.add(p);
  }
}

function toggleRun() {
  if (!evo || (busy && !running)) return;
  running = !running;
  if (running && stoppedBy) {
    // After an automatic stop "Start" continues without that rule, like in the sibling projects.
    $('stop-stag-on').checked = false;
    $('stop-max-on').checked = false;
    applyStopRules();
    stoppedBy = null;
  }
  updateRunButton();
  if (running) fill();
}

function oneGeneration() {
  if (!evo || running || busy) return;
  targetMatings = (Math.floor(evo.generation) + 1) * evo.cfg.poolSize;
  genTimes = [];
  fill();
}

function updateRunButton() {
  $('btn-run').textContent = running ? '⏸ Пауза' : '▶ Старт';
}

function updatePanels() {
  if (!evo || !evo.best) return;
  const h = evo.history[evo.history.length - 1];
  let speed = '';
  if (genTimes.length >= 2) {
    const sec = (genTimes[genTimes.length - 1] - genTimes[0]) / 1000 / (genTimes.length - 1);
    speed = ` · ${sec.toFixed(1)} с/поколение`;
  }
  if (evalTimes.length >= 20) {
    const perSec = (evalTimes.length - 1) / ((evalTimes[evalTimes.length - 1] - evalTimes[0]) / 1000);
    speed += ` · ${perSec.toFixed(0)} оценок/с`;
  }
  const b = evo.best.result;
  const best = evo.cfg.pile ? `оценка <b>${b.score.toFixed(2)}</b> (${b.height.toFixed(2)} м × ${(100 * b.share).toFixed(0)} %)`
    : `<b>${b.height.toFixed(2)} м</b>`;
  const gate = evo.gateNow ? ` · проход <b>${Math.round(100 * evo.gateNow)} см</b>`
    + (evo.cfg.gateGrow && evo.gateNow < evo.cfg.gateWidth ? ` (растёт до ${Math.round(100 * evo.cfg.gateWidth)})` : '') : '';
  $('stats').innerHTML = `Поколение <b>${Math.floor(evo.generation)}</b> · лучшая ${best}${gate} · карта ${evo.archive.size} клеток`
    + ` · медиана ${h.median.toFixed(2)} м · воркеров ${WORKERS}${speed}`
    + (stoppedBy ? ` · <span class="stopped">остановлено: ${stoppedBy}</span>` : '');
  drawHistory($('chart-canvas'), evo.history);
  redrawMap();
  // The tab title too: progress stays visible while the tab is in the background.
  document.title = `Каменщик · поколение ${Math.floor(evo.generation)} · ${evo.best.result.height.toFixed(2)} м`;
  if (shown && shown.kind === 'best' && shown.id !== evo.best.id && view.finished) {
    $('view-title').textContent = `${shown.title} (в пуле уже есть выше)`;
  }
}

function describe(result, born, replayHeight) {
  const p = result.profile;
  const upper = (p[3] + p[4]) / 2;
  const taper = upper > 0 ? (p[0] / upper).toFixed(1) : '—';
  let check = '';
  if (replayHeight !== undefined) {
    const same = Math.abs(replayHeight - result.height) < 1e-6;
    check = `<tr><th>Показ</th><td class="${same ? 'good' : 'bad'}">${replayHeight.toFixed(3)} м`
      + `${same ? ' — совпадает с оценкой' : ' — не совпадает с оценкой!'}</td></tr>`;
  }
  const gatePart = result.gateAbove !== undefined
    ? `высота над проходом × 0,8<sup>${result.gateBlocked}</sup>` : 'высота';
  const score = result.share !== undefined && Math.abs(result.score - result.height) > 1e-9
    ? `<tr><th>Оценка</th><td><b>${result.score.toFixed(3)}</b> = ${gatePart} × доля кучи ${(100 * result.share).toFixed(0)} %</td></tr>`
    : '';
  return `<table>
    <tr><th>Высота</th><td><b>${result.height.toFixed(3)} м</b></td></tr>
    ${result.gateAbove !== undefined ? `<tr><th>Над проходом</th><td>${result.gateAbove.toFixed(3)} м,
      камней в проходе: ${result.gateBlocked}</td></tr>` : ''}
    ${score}
    <tr><th>Камней в плане / в постройке</th><td>${result.stones} / ${result.structure}</td></tr>
    <tr><th>Упало при испытании</th><td>${result.fallen}</td></tr>
    <tr><th>Висячих (пролёты)</th><td>${result.hanging}</td></tr>
    <tr><th>Основание / верх (радиус)</th><td>${taper}</td></tr>
    ${born !== undefined ? `<tr><th>Родилась в поколении</th><td>${Math.floor(born)}</td></tr>` : ''}
    ${check}
  </table>`;
}

function showInfo(result, born, replayHeight) {
  $('best-info').innerHTML = describe(result, born, replayHeight);
  drawProfile($('profile-canvas'), result.profile, result.height);
}

// Replays a structure of the current run (the best one or a cell of the map).
function showIndividual(ind, title) {
  $('view-title').textContent = title;
  showInfo(ind.result, ind.born);
  const opts = { scaffold: evo.cfg.scaffold, tiltDeg: evo.cfg.tiltDeg, pile: evo.cfg.pile, gateWidth: evo.cfg.gateWidth,
    gateArch: evo.cfg.gateArch, mirror: evo.cfg.mirror };
  view.show(evo.quarry, ind.genome, opts, ind.result.height, (r) => {
    finishedAt = performance.now();
    showInfo(ind.result, ind.born, r.height);
  });
  redrawMap();
}

function showBest() {
  if (!evo || !evo.best) return;
  const best = evo.best;
  shown = { kind: 'best', id: best.id, title: `Лучшая постройка · поколение ${Math.floor(best.born)}` };
  showIndividual(best, shown.title);
}

function showCell(key) {
  const ind = evo && evo.archive.get(key);
  if (!ind) return;
  $('view-follow').checked = false;
  shown = { kind: 'cell', key, id: ind.id };
  showIndividual(ind, `Карта находок, клетка ${key} · поколение ${Math.floor(ind.born)}`);
}

function redrawMap() {
  if (!evo) return;
  mapHit = drawMap($('map-canvas'), evo.archive, BASE_BINS, TAPER_BINS, shown && shown.kind === 'cell' ? shown.key : null);
}

function showImported(data) {
  shown = { kind: 'imported', data };
  $('view-follow').checked = false;
  $('view-title').textContent = `Загруженная постройка (seed ${data.seed}, ${data.scaffold ? 'с лесами' : 'без лесов'})`;
  showInfo(data.result);
  const quarry = makeQuarry(data.stoneCount, data.seed);
  view.show(quarry, data.genome, { scaffold: data.scaffold, tiltDeg: data.tiltDeg, pile: data.pile, gateWidth: data.gateWidth || 0, gateArch: !!data.gateArch, mirror: !!data.mirror }, data.result.height, (r) => {
    finishedAt = performance.now();
    showInfo(data.result, undefined, r.height);
  });
}

function replay() {
  if (shown && shown.kind === 'imported') showImported(shown.data);
  else if (shown && shown.kind === 'cell') showCell(shown.key);
  else showBest();
}

function exportShown() {
  let data = null;
  if (shown && shown.kind === 'imported') data = shown.data;
  else if (shown && shown.kind === 'cell' && evo.archive.get(shown.key)) data = evo.exportIndividual(evo.archive.get(shown.key));
  else if (evo && evo.best) data = evo.exportBest();
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `builder-seed${data.seed}-${data.result.height.toFixed(2)}m.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.genome || !Array.isArray(data.genome.placements) || !data.stoneCount) throw new Error('нет плана постройки');
    showImported(data);
  } catch (e) {
    alert(`Не удалось загрузить: ${e.message}`);
  }
}

function animate() {
  view.render();
  // Follow the best: after a replay ends, switch to a newer best after a short pause.
  if ($('view-follow').checked && evo && evo.best && view.finished
      && (!shown || shown.kind !== 'best' || shown.id !== evo.best.id)
      && performance.now() - finishedAt > FOLLOW_DELAY) {
    showBest();
  }
  requestAnimationFrame(animate);
}

async function main() {
  await RAPIER.init();
  view = new StructureView($('view-canvas'), $('view-label'), RAPIER);
  pool = new WorkerPool(() => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    return {
      postMessage: (m) => w.postMessage(m),
      onMessage: (cb) => { w.onmessage = (e) => cb(e.data); },
      terminate: () => w.terminate(),
    };
  }, WORKERS);

  $('btn-run').onclick = toggleRun;
  $('btn-gen').onclick = oneGeneration;
  $('btn-reset').onclick = reset;
  $('btn-new-seed').onclick = () => { $('cfg-seed').value = 1 + Math.floor(Math.random() * 1e6); reset(); };
  $('cfg-tilt').oninput = () => { $('cfg-tilt-out').textContent = `${$('cfg-tilt').value}°`; };
  $('cfg-tilt-on').onchange = () => { $('cfg-tilt').disabled = !$('cfg-tilt-on').checked; };
  $('cfg-gate').oninput = () => { $('cfg-gate-out').textContent = `${Math.round(100 * $('cfg-gate').value)} см`; };
  $('cfg-gate-on').onchange = () => { $('cfg-gate').disabled = !$('cfg-gate-on').checked; };
  for (const id of ['stop-stag-on', 'stop-stag', 'stop-max-on', 'stop-max']) $(id).onchange = applyStopRules;
  $('btn-replay').onclick = replay;
  $('map-canvas').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    const key = mapHit && mapHit(e.clientX - r.left, e.clientY - r.top);
    if (key) showCell(key);
  };
  $('view-speed').onchange = () => { view.speed = Number($('view-speed').value); };
  $('btn-export').onclick = exportShown;
  $('file-import').onchange = (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; };
  window.addEventListener('resize', () => { if (evo) drawHistory($('chart-canvas'), evo.history); });

  requestAnimationFrame(animate);
  await reset();
}

main().catch((e) => {
  $('stats').innerHTML = `<span class="bad">Ошибка: ${e.message}. Страницу нужно открывать через локальный сервер
    (python3 -m http.server), а не как файл.</span>`;
  console.error(e);
});
