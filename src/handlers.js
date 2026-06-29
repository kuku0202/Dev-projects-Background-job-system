const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Example job handlers. A handler is `async (payload, job) => void` — it does
 * the work, throws on failure (which triggers a retry), and returns on success.
 *
 * These are dummies that just sleep/log, standing in for real work like sending
 * an email, scraping a page, or generating a worksheet.
 */
export const handlers = {
  async sendEmail(payload) {
    await sleep(100);
    console.log(`  [sendEmail] -> ${payload.to ?? 'unknown'}: ${payload.subject ?? '(no subject)'}`);
  },

  async scrape(payload) {
    await sleep(150);
    console.log(`  [scrape] fetched ${payload.url ?? 'unknown'}`);
  },

  // Fails on its first `failTimes` attempts, then succeeds — demonstrates retries.
  async flaky(payload, job) {
    await sleep(50);
    const failTimes = payload.failTimes ?? 2;
    if (job.attempts <= failTimes) {
      throw new Error(`transient failure on attempt ${job.attempts}`);
    }
    console.log(`  [flaky] succeeded on attempt ${job.attempts}`);
  },

  // Always fails — demonstrates a job going "dead" after exhausting retries.
  async alwaysFails() {
    await sleep(20);
    throw new Error('this job can never succeed');
  },
};
