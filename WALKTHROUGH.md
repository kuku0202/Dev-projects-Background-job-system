# Interview Walkthrough Script — Background Job System

> A speaking script for presenting this take-home. Aim for ~10–12 min of talking
> + live demo, then Q&A. Lines in *italics* are stage directions; everything else
> is a talk track you can read or paraphrase.

---

## 0. Opening (30 sec)

"Thanks for taking the time. I built a background job system — the kind of thing
you'd use to run work asynchronously: sending emails, scraping pages, generating
reports. Clients **push** jobs onto a durable queue, and a server **pulls** and
runs them concurrently, with retries and scheduling.

I'll start with the requirements and my design choices, then walk the code, then
run a live demo, and finish with the trade-offs I made and what I'd do next."

---

## 1. Requirements & how I covered them (1 min)

*Pull up `instruction.md` — the requirements table.*

"The README asked for five things, and here's where each lives:

- **Client pushes jobs** → the `Client` library.
- **Server pulls and executes** → worker loops in `Server`.
- **Concurrency with a limit** → I run N worker loops; the loop count *is* the limit.
- **Retry with a per-job limit** → exponential backoff, and after max attempts the job goes 'dead'.
- **The extra credit — scheduled jobs** → a `run_at` column; a job is invisible until its time arrives."

---

## 2. Key design decisions (2 min) — *this is what they're really evaluating*

### Language: Node.js
"The README suggested Node or Go. I chose Node because the work here is
**I/O-bound** — emails, HTTP scrapes — and Node's single-threaded async model lets
me run many jobs concurrently without locks or thread pools."

### Storage: SQLite via Node's built-in `node:sqlite`
"This is the decision I'd most want to talk about. The classic answer is Redis,
but I deliberately chose **SQLite** for two reasons:

1. **Zero setup.** It's built into Node 22 — no server to install. You can clone
   and run it with nothing but Node. For a take-home, reviewability matters.
2. **Durability and atomicity for free.** Jobs survive a crash, and I get
   transactional claiming without building my own locking.

The important part: **all storage logic lives in one class — `Queue`.** So
'SQLite vs Redis' is a swappable detail, not an architectural commitment. If we
needed multi-machine scale, I'd reimplement that one file against Redis."

### Concurrency model: "the loop count is the limit"
"Instead of a semaphore counting in-flight jobs, I start exactly `concurrency`
worker loops. Each loop grabs one job, runs it to completion, grabs the next.
At most `concurrency` jobs run at once — simple and impossible to get wrong."

---

## 3. Code walkthrough (3–4 min) — *open files in this order*

### `src/db.js` — the schema
"One `jobs` table. The columns that matter:
- `status`: pending → running → succeeded, or → dead.
- `attempts` / `max_attempts`: the retry budget.
- `run_at`: epoch milliseconds — this single column powers scheduling.
- I store timestamps as integers so scheduling is just integer comparison.
- WAL mode + a busy timeout so concurrent access doesn't block."

### `src/queue.js` — the heart of the system
*Point at the `_claim` statement.*

"This is the most important piece — **atomic claiming**:

```sql
UPDATE jobs SET status='running', attempts=attempts+1
 WHERE id = (SELECT id FROM jobs
             WHERE status='pending' AND run_at <= now
             ORDER BY priority DESC, run_at ASC, id ASC LIMIT 1)
RETURNING *
```

In one statement it picks the next ready job, flips it to `running`, bumps the
attempt count, and returns the row. Because `node:sqlite` is **synchronous**, this
runs to completion before any other worker loop gets the thread — so two workers
can **never** claim the same job. The `WHERE run_at <= now` clause is also what
hides scheduled jobs until their time comes.

Then `retryOrFail`: on failure, if attempts remain, I reschedule with
**exponential backoff** — `base * 2^(attempts-1)` — otherwise mark it dead."

### `src/client.js` — the producer
"A thin wrapper so app code never writes SQL. `enqueue` for now, `schedule` for
later — `schedule('report', data, twoDaysInMs)`."

### `src/server.js` — the consumer
"`start()` spins up the worker loops. Each loop: claim a job, dispatch to the
registered handler, mark complete on success or call `retryOrFail` on a thrown
error. Unknown job types and handler exceptions both flow through the same retry
path. `stop()` does a **graceful shutdown** — stops claiming and waits for
in-flight jobs to finish."

---

## 4. Live demo (2–3 min) — *the money shot*

"Let me run it. First the tests:"

```bash
node --test
```

*Wait for "pass 8".* "Eight tests — they cover atomic claiming, that scheduled
jobs stay hidden, priority ordering, retry-until-dead, backoff timing, and full
concurrent processing."

"Now the end-to-end demo:"

```bash
node demo.js
```

*As it runs, narrate what they see:*

"Watch the behavior here:
- Concurrency is 3 — you see jobs starting in overlapping batches of three.
- I gave the `scrape` job high **priority**, so it jumps ahead of the emails.
- The `flaky` job **fails twice and succeeds on attempt 3** — that's the retry path.
- `alwaysFails` exhausts its 2 attempts and goes **dead**.
- And the last email was **scheduled** 1.5 seconds out — notice it runs last,
  after its timer fires, even though it was enqueued early.

Final stats: 9 succeeded, 1 dead — exactly what we expect."

---

## 5. Trade-offs & what I'd do next (1–2 min) — *shows senior thinking*

"A few honest limitations, given the time box:

- **Single-process.** SQLite + in-process loops scale vertically. For multiple
  machines I'd move the queue to Redis or Postgres `SELECT … FOR UPDATE SKIP
  LOCKED` — but the `Queue` interface wouldn't change.
- **Crash recovery.** If the server dies mid-job, that job is stuck in `running`.
  In production I'd add a visibility timeout: a reaper that returns long-`running`
  jobs to `pending`. Easy to add — it's the same backoff logic.
- **Polling.** Idle workers poll every 200ms. Fine here; at scale I'd use
  `LISTEN/NOTIFY` or a blocking pop to cut latency.
- **Observability.** I emit lifecycle events through an `onEvent` hook; next step
  is real metrics — queue depth, success rate, time-in-queue.

I scoped to a clean, correct, **testable** core and kept the design swappable
rather than over-building. Happy to go deeper on any of these."

---

## 6. Anticipated questions — *prep, don't read aloud*

**"How do you prevent two workers from running the same job?"**
The single atomic `UPDATE … RETURNING` claim, plus `node:sqlite` being
synchronous. For multi-process I'd rely on SQLite's row locking / `BEGIN
IMMEDIATE`, or `SKIP LOCKED` on Postgres.

**"What happens if a job runs forever / the worker crashes?"**
Today it stays `running`. I'd add a heartbeat + visibility-timeout reaper to
requeue stuck jobs.

**"Why exponential backoff?"**
To avoid hammering a failing downstream dependency. I'd also add jitter in
production to prevent thundering-herd retries.

**"How would you scale to millions of jobs / many machines?"**
Swap `Queue`'s backend to Redis or Postgres, run many server processes, partition
by job type or priority into separate queues. The producer/consumer contract
stays identical.

**"Is the job lost if it fails between claim and complete?"**
No — the claim already incremented `attempts` and the row persists. On restart
I'd reclaim it via the reaper. (Mention this proactively — it shows you thought
about failure modes.)

**"Why not a real message broker (Kafka/RabbitMQ/SQS)?"**
Right tool at scale, but operationally heavy for a self-contained take-home, and
they don't give me the durable job *state* (attempts, status) without extra
bookkeeping. SQLite gives me the state table for free.

---

## One-line summary to land

"It's a small system, but it's **correct, durable, concurrent, and tested** — and
the storage is isolated behind one class so it scales by swapping a backend, not
rewriting the design."
