# Background Job System — Design & Instructions

A small but production-shaped background job system: clients **push** jobs onto a
durable queue, and a server **pulls** and executes them concurrently with a
concurrency cap, automatic retries with exponential backoff, and support for
**scheduled** (run-later) jobs.

## Goals (from the README)

| Requirement | Where it's handled |
|---|---|
| Client can push jobs to the queue | `src/client.js` → `Client.enqueue()` |
| Server pulls jobs and executes them | `src/server.js` → worker loops |
| Run multiple jobs at once + concurrency limit | `Server({ concurrency })` — N worker loops |
| Retry failed jobs with a per-job retry limit | `Queue.retryOrFail()` + `max_attempts` |
| **Extra:** scheduled jobs ("run in 2 days") | `enqueue({ delayMs })` / `runAt` + `run_at` column |

## Why these choices

- **Language: Node.js** — single-threaded async model makes concurrent I/O-bound
  jobs simple to reason about, and it's the README's first suggestion.
- **Storage: SQLite via the built-in `node:sqlite` module** (Node ≥ 22.5). This
  keeps the project **dependency-free** — no Redis/Postgres server to install — so
  a reviewer can run it with nothing but Node. SQLite gives us durability and
  atomic job claiming. The `Queue` is the only storage-aware layer, so swapping in
  Redis/Postgres later means reimplementing one class.

## Architecture

```
  Client.enqueue(...)                      Server (concurrency = N)
        |                                  ┌──────────────────────────┐
        v                                  │ workerLoop 1 ─┐          │
  ┌───────────────┐    claim() (atomic)    │ workerLoop 2 ─┤ run      │
  │  jobs table   │ <───────────────────── │   ...          handler   │
  │  (SQLite)     │ ─── job row ──────────> │ workerLoop N ─┘          │
  └───────────────┘                        └──────────────────────────┘
        ^   complete() / retryOrFail()                 |
        └──────────────────────────────────────────────┘
```

### Job lifecycle / states

```
 pending ──claim──> running ──success──> succeeded
    ^                  │
    │                  └──failure, attempts < max──> (backoff) pending
    │                  └──failure, attempts == max ─────────> dead
    └── scheduled jobs wait here until run_at <= now
```

### The `jobs` table

| column | meaning |
|---|---|
| `id` | primary key |
| `type` | handler name to dispatch to |
| `payload` | JSON args for the handler |
| `status` | `pending` / `running` / `succeeded` / `dead` |
| `priority` | higher runs first |
| `attempts` | how many times tried so far |
| `max_attempts` | per-job retry limit |
| `run_at` | epoch ms; job is invisible until `now >= run_at` (enables scheduling) |
| `last_error` | last failure message |
| `created_at` / `updated_at` | timestamps |

### Concurrency model

The server starts exactly `concurrency` worker loops. Each loop claims **one** job
at a time, runs it to completion, then claims the next — so at most `concurrency`
jobs run simultaneously. No semaphore bookkeeping needed; the loop count *is* the
limit.

### Atomic claiming

`node:sqlite` is synchronous, so a `claim()` call runs to completion before any
other worker loop gets the JS thread. The claim is a single
`UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` that flips a row from
`pending` → `running` and increments `attempts` in one statement — no two workers
can grab the same job.

### Retries & backoff

On handler failure, if `attempts < max_attempts` the job is reset to `pending`
with `run_at = now + base * 2^(attempts-1)` (exponential backoff). When attempts
are exhausted it becomes `dead`.

## Layout

```
src/
  db.js       schema + connection (PRAGMA WAL, busy_timeout)
  queue.js    Queue: enqueue / claim / complete / retryOrFail / stats
  client.js   Client library — thin wrapper to push jobs
  server.js   Server — worker pool, dispatch, graceful shutdown
  handlers.js example job handlers (sendEmail, flaky, etc.)
demo.js       end-to-end demo: enqueue jobs (incl. failing + scheduled), run server
test/queue.test.js   unit/integration tests (node:test)
```

## How to run

```bash
node demo.js          # seeds jobs and runs the server until the queue drains
node --test           # run the test suite
```

No `npm install` required — everything uses Node's standard library.

## Build steps (checklist)

1. [x] `db.js` — schema + WAL connection
2. [x] `queue.js` — enqueue, atomic claim, complete, retryOrFail, stats
3. [x] `client.js` — push API (immediate + scheduled)
4. [x] `server.js` — concurrent worker pool, retry dispatch, graceful stop
5. [x] `handlers.js` — sample handlers incl. a flaky one to show retries
6. [x] `demo.js` — end-to-end demonstration
7. [x] `test/` — automated tests for concurrency, retry, scheduling
