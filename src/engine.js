'use strict';
// The D2 engine in a worker thread (src/engine-worker.js). One worker for the whole window; requests run one at a time
// in the order they came. A request that takes longer than the timeout ends the worker (the next request starts a fresh
// one), so a diagram that never finishes its layout cannot hang the editor. No vscode import: tests use it directly.
const path = require('path');
const { Worker } = require('worker_threads');

class Engine {
  constructor(o = {}) {
    this.libDir = o.libDir || path.join(__dirname, '..', 'lib', 'd2');
    this.timeoutMs = o.timeoutMs || 20000;
    this.worker = null; this.seq = 0; this.pending = new Map(); this.queue = Promise.resolve(); this.disposed = false;
    this.restarts = 0;
  }

  start() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'engine-worker.js'), { workerData: { libDir: this.libDir } });
    w.on('message', (m) => {
      if (m && typeof m.id === 'number' && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p.resolve(m.result); return; }
      if (m && m.type === 'exit') this.kill('the D2 engine stopped' + (m.error ? ': ' + m.error : ''));
    });
    w.on('error', (e) => this.kill('the D2 engine failed: ' + ((e && e.message) || e)));
    w.on('exit', () => { if (this.worker === w) { this.worker = null; this.failAll('the D2 engine stopped'); } });
    if (w.unref) w.unref();
    this.worker = w;
    return w;
  }

  failAll(msg) { for (const [, p] of this.pending) p.resolve({ error: { message: msg, crashed: true } }); this.pending.clear(); }

  kill(msg) {
    const w = this.worker;
    this.worker = null;
    this.failAll(msg);
    if (w) { this.restarts++; w.terminate().catch(() => {}); }
  }

  /** Sends one request after the ones before it; resolves with the worker's result ({ error } on failure or timeout). */
  request(type, data, timeoutMs) {
    const job = this.queue.then(() => this.send(type, data, timeoutMs || this.timeoutMs));
    this.queue = job.then(() => {}, () => {});
    return job;
  }

  send(type, data, timeoutMs) {
    if (this.disposed) return Promise.resolve({ error: { message: 'the D2 engine is closed' } });
    const w = this.start();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        resolve({ error: { message: `The D2 engine took longer than ${Math.round(timeoutMs / 1000)} s and was restarted. A very large diagram may need a longer time (setting zovoD2.renderTimeoutSeconds).`, timeout: true } });
        this.kill('timeout');
      }, timeoutMs);
      this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
      try { w.postMessage({ id, type, data }); } catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ error: { message: String((e && e.message) || e) } }); }
    });
  }

  run(req, timeoutMs) { return this.request('run', req, timeoutMs); }
  version() { return this.request('version', {}); }

  dispose() {
    this.disposed = true;
    const w = this.worker;
    this.worker = null;
    this.failAll('the D2 engine is closed');
    if (w) w.terminate().catch(() => {});
  }
}

module.exports = { Engine };
