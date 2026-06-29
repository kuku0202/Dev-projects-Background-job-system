/**
 * The only storage-aware layer. Both the Client (producer) and the Server
 * (consumer) talk to the queue through this class, so swapping SQLite for
 * Redis/Postgres later means reimplementing just this file.
 *
 * `node:sqlite` runs synchronously, so each method below executes atomically
 * with respect to the other worker loops in the process — that's what makes
 * `claim()` safe without explicit locking.
 */
export class Queue {
  constructor(db) {
    this.db = db;

    this._insert = db.prepare(`
      INSERT INTO jobs (type, payload, status, priority, attempts, max_attempts,
                        run_at, created_at, updated_at)
      VALUES (:type, :payload, 'pending', :priority, 0, :max_attempts,
              :run_at, :now, :now)
    `);

    // Flip the next ready job from pending -> running and bump attempts, all in
    // one statement. RETURNING gives us the claimed row back.
    this._claim = db.prepare(`
      UPDATE jobs
         SET status = 'running', attempts = attempts + 1, updated_at = :now
       WHERE id = (
         SELECT id FROM jobs
          WHERE status = 'pending' AND run_at <= :now
          ORDER BY priority DESC, run_at ASC, id ASC
          LIMIT 1
       )
      RETURNING *
    `);

    this._complete = db.prepare(`
      UPDATE jobs SET status = 'succeeded', last_error = NULL, updated_at = :now
       WHERE id = :id
    `);

    this._retry = db.prepare(`
      UPDATE jobs
         SET status = 'pending', run_at = :run_at, last_error = :error, updated_at = :now
       WHERE id = :id
    `);

    this._kill = db.prepare(`
      UPDATE jobs SET status = 'dead', last_error = :error, updated_at = :now
       WHERE id = :id
    `);

    this._get = db.prepare('SELECT * FROM jobs WHERE id = :id');
    this._stats = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
  }

  /**
   * Push a job. Returns the new job id.
   *
   * @param {object}  opts
   * @param {string}  opts.type          handler name to run
   * @param {object}  [opts.payload]     JSON-serializable args
   * @param {number}  [opts.maxAttempts] per-job retry limit (default 3)
   * @param {number}  [opts.priority]    higher runs first (default 0)
   * @param {number}  [opts.delayMs]     run this many ms from now (scheduling)
   * @param {Date|number} [opts.runAt]   absolute time to run; overrides delayMs
   */
  enqueue({ type, payload = {}, maxAttempts = 3, priority = 0, delayMs = 0, runAt } = {}) {
    if (!type || typeof type !== 'string') {
      throw new Error('enqueue: `type` is required and must be a string');
    }
    const now = Date.now();
    let when = now + delayMs;
    if (runAt != null) when = runAt instanceof Date ? runAt.getTime() : Number(runAt);

    const info = this._insert.run({
      type,
      payload: JSON.stringify(payload),
      priority,
      max_attempts: maxAttempts,
      run_at: when,
      now,
    });
    return Number(info.lastInsertRowid);
  }

  /** Atomically claim the next ready job, or return null if none is available. */
  claim() {
    const row = this._claim.get({ now: Date.now() });
    return row ? this._hydrate(row) : null;
  }

  /** Mark a job as successfully finished. */
  complete(id) {
    this._complete.run({ id, now: Date.now() });
  }

  /**
   * Handle a failed job: retry with exponential backoff if attempts remain,
   * otherwise mark it dead. Returns the new status.
   *
   * @param {object} job        the claimed job (with its already-incremented attempts)
   * @param {string} error      failure message
   * @param {number} baseBackoffMs backoff base; delay = base * 2^(attempts-1)
   */
  retryOrFail(job, error, baseBackoffMs = 1000) {
    const now = Date.now();
    if (job.attempts < job.max_attempts) {
      const backoff = baseBackoffMs * 2 ** (job.attempts - 1);
      this._retry.run({ id: job.id, run_at: now + backoff, error: String(error), now });
      return 'pending';
    }
    this._kill.run({ id: job.id, error: String(error), now });
    return 'dead';
  }

  /** Fetch a single job by id (payload parsed). */
  get(id) {
    const row = this._get.get({ id });
    return row ? this._hydrate(row) : null;
  }

  /** Counts by status, e.g. { pending: 2, succeeded: 5, dead: 1 }. */
  stats() {
    const out = {};
    for (const { status, n } of this._stats.all()) out[status] = n;
    return out;
  }

  _hydrate(row) {
    return { ...row, payload: JSON.parse(row.payload) };
  }
}
