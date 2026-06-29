import { openDb } from './db.js';
import { Queue } from './queue.js';

/**
 * Client library — the producer side. A thin, friendly wrapper over the queue
 * so application code never touches SQL.
 *
 *   const client = new Client('jobs.db');
 *   client.enqueue('sendEmail', { to: 'a@b.com' });
 *   client.schedule('report', { day: 'mon' }, 2 * 24 * 60 * 60 * 1000); // in 2 days
 */
export class Client {
  constructor(path = 'jobs.db') {
    this.db = openDb(path);
    this.queue = new Queue(this.db);
  }

  /**
   * Push a job to run as soon as a worker is free.
   * @returns {number} job id
   */
  enqueue(type, payload = {}, opts = {}) {
    return this.queue.enqueue({ type, payload, ...opts });
  }

  /**
   * Push a job to run `delayMs` from now (scheduled job).
   * @returns {number} job id
   */
  schedule(type, payload = {}, delayMs = 0, opts = {}) {
    return this.queue.enqueue({ type, payload, delayMs, ...opts });
  }

  /** Push a job to run at an absolute time. */
  scheduleAt(type, payload = {}, runAt, opts = {}) {
    return this.queue.enqueue({ type, payload, runAt, ...opts });
  }

  stats() {
    return this.queue.stats();
  }

  close() {
    this.db.close();
  }
}
