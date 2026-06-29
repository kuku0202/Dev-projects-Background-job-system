import { existsSync, rmSync } from 'node:fs';
import { Client } from './src/client.js';
import { Server } from './src/server.js';
import { handlers } from './src/handlers.js';

const DB = 'demo-jobs.db';

// Start from a clean slate so the demo is reproducible.
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f);

const log = (evt) => {
  switch (evt.type) {
    case 'job:start':
      console.log(`▶ start  #${evt.job.id} ${evt.job.type} (attempt ${evt.job.attempts})`);
      break;
    case 'job:success':
      console.log(`✓ done   #${evt.job.id} ${evt.job.type}`);
      break;
    case 'job:error':
      console.log(`✗ fail   #${evt.job.id} ${evt.job.type} -> ${evt.status} (${evt.error})`);
      break;
  }
};

// --- Producer: push a mix of jobs ------------------------------------------
const client = new Client(DB);

console.log('Enqueuing jobs...\n');
for (let i = 1; i <= 6; i++) {
  client.enqueue('sendEmail', { to: `user${i}@example.com`, subject: `Hello #${i}` });
}
client.enqueue('scrape', { url: 'https://example.com' }, { priority: 10 }); // jumps the line
client.enqueue('flaky', { failTimes: 2 }, { maxAttempts: 5 });   // fails twice, then succeeds
client.enqueue('alwaysFails', {}, { maxAttempts: 2 });           // exhausts retries -> dead
client.schedule('sendEmail', { to: 'later@example.com', subject: 'Scheduled!' }, 1500); // ~1.5s later
client.close();

// --- Consumer: run the server ----------------------------------------------
const server = new Server({
  path: DB,
  handlers,
  concurrency: 3,        // at most 3 jobs at once
  baseBackoffMs: 300,    // short backoff so the demo finishes quickly
  onEvent: log,
});

console.log('Starting server (concurrency=3)...\n');
server.start();

// Let it run, then drain and report. The scheduled job (~1.5s) and retries
// (with backoff) all complete within this window.
await new Promise((r) => setTimeout(r, 5000));

console.log('\nFinal stats:', server.stats());
await server.stop();
