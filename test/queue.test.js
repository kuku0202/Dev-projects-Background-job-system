import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Queue } from '../src/queue.js';
import { Server } from '../src/server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshQueue() {
  return new Queue(openDb(':memory:'));
}

test('enqueue then claim returns the job and marks it running', () => {
  const q = freshQueue();
  const id = q.enqueue({ type: 'sendEmail', payload: { to: 'a@b.com' } });

  const job = q.claim();
  assert.equal(job.id, id);
  assert.equal(job.type, 'sendEmail');
  assert.deepEqual(job.payload, { to: 'a@b.com' });
  assert.equal(job.status, 'running');
  assert.equal(job.attempts, 1);

  // Nothing left to claim.
  assert.equal(q.claim(), null);
});

test('a claimed job is never handed to a second claimer', () => {
  const q = freshQueue();
  q.enqueue({ type: 'x' });
  assert.ok(q.claim());
  assert.equal(q.claim(), null, 'second claim must not get the same job');
});

test('scheduled jobs are invisible until run_at', () => {
  const q = freshQueue();
  q.enqueue({ type: 'later', delayMs: 10_000 });
  assert.equal(q.claim(), null, 'future job should not be claimable yet');

  // A job scheduled in the past is immediately claimable.
  q.enqueue({ type: 'now', delayMs: -5 });
  assert.equal(q.claim()?.type, 'now');
});

test('higher priority is claimed first', () => {
  const q = freshQueue();
  q.enqueue({ type: 'low', priority: 0 });
  q.enqueue({ type: 'high', priority: 10 });
  assert.equal(q.claim().type, 'high');
  assert.equal(q.claim().type, 'low');
});

test('retryOrFail retries until max_attempts, then marks dead', () => {
  const q = freshQueue();
  const id = q.enqueue({ type: 'x', maxAttempts: 2 });

  let job = q.claim();                                  // attempt 1
  assert.equal(q.retryOrFail(job, 'boom', 0), 'pending');

  job = q.claim();                                      // attempt 2 (== max)
  assert.equal(q.retryOrFail(job, 'boom', 0), 'dead');

  const dead = q.get(id);
  assert.equal(dead.status, 'dead');
  assert.equal(dead.last_error, 'boom');
  assert.equal(q.claim(), null, 'dead jobs are not reclaimed');
});

test('backoff pushes the retry into the future', () => {
  const q = freshQueue();
  q.enqueue({ type: 'x', maxAttempts: 3 });
  const job = q.claim();
  q.retryOrFail(job, 'boom', 1000); // backoff = 1000 * 2^0 = 1000ms
  assert.equal(q.claim(), null, 'job should be delayed by backoff, not immediately ready');
});

test('server processes jobs concurrently, retries flaky, and kills always-fail', async () => {
  const q = freshQueue();
  const done = [];
  const server = new Server({
    queue: q,
    concurrency: 4,
    baseBackoffMs: 1, // tiny so retries happen fast in the test
    handlers: {
      async ok(payload) {
        await sleep(20);
        done.push(payload.n);
      },
      async flaky(_payload, job) {
        if (job.attempts < 3) throw new Error('transient');
      },
      async bad() {
        throw new Error('always');
      },
    },
  });

  for (let n = 0; n < 8; n++) q.enqueue({ type: 'ok', payload: { n } });
  q.enqueue({ type: 'flaky', maxAttempts: 5 });
  q.enqueue({ type: 'bad', maxAttempts: 2 });

  server.start();
  // Poll until the queue drains (no pending/running) or we time out.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const s = q.stats();
    if (!s.pending && !s.running) break;
    await sleep(25);
  }
  await server.stop();

  const stats = q.stats();
  assert.equal(stats.succeeded, 9, '8 ok jobs + 1 eventually-successful flaky');
  assert.equal(stats.dead, 1, 'the always-failing job is dead');
  assert.equal(done.length, 8, 'all ok handlers ran');
});

test('jobs with no registered handler are retried then marked dead', async () => {
  const q = freshQueue();
  const server = new Server({ queue: q, baseBackoffMs: 1, handlers: {} });
  q.enqueue({ type: 'mystery', maxAttempts: 1 });

  server.start();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (q.stats().dead) break;
    await sleep(20);
  }
  await server.stop();

  assert.equal(q.stats().dead, 1);
});
