// A pool of workers that score genomes in parallel.
// makeWorker() returns an object with postMessage(msg) and onMessage(callback) - a thin adapter,
// so the same pool works with browser Web Workers and Node worker threads.

export class WorkerPool {
  constructor(makeWorker, count) {
    this.workers = Array.from({ length: count }, () => makeWorker());
    this.pending = new Map();   // id -> resolve
    this.nextId = 0;
    this.queue = [];            // jobs waiting for a free worker
    this.free = [];
    this.readyWaiters = [];
    for (const w of this.workers) {
      w.onMessage((m) => {
        if (m.type === 'ready') {
          const resolve = this.readyWaiters.shift();
          if (resolve) resolve();
        } else if (m.type === 'result') {
          this.pending.get(m.id)(m.result);
          this.pending.delete(m.id);
          this.free.push(w);
          this.pump();
        }
      });
    }
  }

  get size() { return this.workers.length; }

  // Sends the run settings to every worker and waits until all are ready.
  init(cfg) {
    this.queue = [];
    const all = this.workers.map((w) => new Promise((resolve) => {
      this.readyWaiters.push(resolve);
      w.postMessage({ type: 'init', cfg });
    }));
    return Promise.all(all).then(() => { this.free = [...this.workers]; });
  }

  pump() {
    while (this.free.length && this.queue.length) {
      const w = this.free.shift();
      const job = this.queue.shift();
      this.pending.set(job.id, job.resolve);
      w.postMessage({ type: 'eval', id: job.id, genome: job.genome, abortBelow: job.abortBelow });
    }
  }

  evaluate(genome, abortBelow) {
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, genome, abortBelow, resolve });
      this.pump();
    });
  }

  // Results in the same order as genomes. thresholds[i] (optional): stop scoring genome i
  // as soon as it is clearly below that score (see Evolution).
  evaluateAll(genomes, thresholds) {
    return Promise.all(genomes.map((g, i) => this.evaluate(g, thresholds ? thresholds[i] : undefined)));
  }

  terminate() {
    for (const w of this.workers) w.terminate();
  }
}
