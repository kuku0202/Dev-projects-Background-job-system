import { DatabaseSync } from 'node:sqlite';

/**
 * Open (or create) the job database and ensure the schema exists.
 *
 * Timestamps are stored as epoch milliseconds (integers) so scheduling math is
 * trivial. WAL mode + a busy timeout let multiple worker loops (and even
 * separate processes) read/write without tripping over each other.
 *
 * @param {string} path  File path, or ":memory:" for an ephemeral DB (tests).
 */
export function openDb(path = 'jobs.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT    NOT NULL,
      payload      TEXT    NOT NULL DEFAULT '{}',
      status       TEXT    NOT NULL DEFAULT 'pending',
      priority     INTEGER NOT NULL DEFAULT 0,
      attempts     INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at       INTEGER NOT NULL,
      last_error   TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);
  // Index the columns the poller filters/sorts on, so claiming a job stays cheap
  // even with a large backlog.
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs(status, run_at);');
  return db;
}
