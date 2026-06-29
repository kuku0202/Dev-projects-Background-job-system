import { openDb } from './db.js';
import { Queue } from './queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Background job server — the consumer side.
 *
 * Runs `concurrency` worker loops. Each loop claims one job at a time and runs
 * it to completion before claiming the next, so at most `concurrency` jobs run
 * simultaneously: the loop count *is* the concurrency limit.
 */
export class Server {
  /**
   * @param {object} opts
   * @param {string} [opts.path]          DB path (or pass an existing Queue via opts.queue)
   * @param {Queue}  [opts.queue]         reuse an existing Queue (e.g. in tests)
   * @param {object} [opts.handlers]      map of jobType -> async (payload, job) => void
   * @param {number} [opts.concurrency]   max jobs in flight (default 5)
   * @param {number} [opts.pollIntervalMs] idle poll delay when the queue is empty
   * @param {number} [opts.baseBackoffMs] retry backoff base
   * @param {(evt:object)=>void} [opts.onEvent] optional lifecycle hook for logging
   */
  constructor({
    path = 'jobs.db',
    queue,
    handlers = {},
    concurrency = 5,
    pollIntervalMs = 200,
    baseBackoffMs = 1000,
    onEvent = () => {},
  } = {}) {
    this.db = queue ? null : openDb(path);
    this.queue = queue ?? new Queue(this.db);
    this.handlers = handlers;
    this.concurrency = concurrency;
    this.pollIntervalMs = pollIntervalMs;
    this.baseBackoffMs = baseBackoffMs;
    this.onEvent = onEvent;
    this.running = false;
    this._loops = [];
  }

  register(type, handler) {
    this.handlers[type] = handler;
    return this;
  }

  /** Start the worker loops. Non-blocking; call stop() to shut down. */
  start() {
    if (this.running) return;
    this.running = true;
    this.onEvent({ type: 'server:start', concurrency: this.concurrency });
    for (let i = 0; i < this.concurrency; i++) {
      this._loops.push(this._workerLoop(i));
    }
  }

  async _workerLoop(workerId) {
    while (this.running) {
      const job = this.queue.claim();
      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      await this._process(job, workerId);
    }
  }

  async _process(job, workerId) {
    const handler = this.handlers[job.type];
    this.onEvent({ type: 'job:start', job, workerId });

    if (!handler) {
      const status = this.queue.retryOrFail(
        job,
        `no handler registered for type "${job.type}"`,
        this.baseBackoffMs,
      );
      this.onEvent({ type: 'job:error', job, error: 'no handler', status });
      return;
    }

    try {
      await handler(job.payload, job);
      this.queue.complete(job.id);
      this.onEvent({ type: 'job:success', job, workerId });
    } catch (err) {
      const status = this.queue.retryOrFail(job, err?.message ?? err, this.baseBackoffMs);
      this.onEvent({ type: 'job:error', job, error: err?.message ?? String(err), status });
    }
  }

  /** Gracefully stop: stop claiming new work and wait for in-flight loops. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    await Promise.all(this._loops);
    this._loops = [];
    if (this.db) this.db.close();
    this.onEvent({ type: 'server:stop' });
  }

  stats() {
    return this.queue.stats();
  }
}
