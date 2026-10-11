import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpSource, HTTP_MAX_RATE_LIMIT_RETRIES, HTTP_MIN_INTERVAL_MS } from './http-source.js';
import { readGuestPage, SourceBudgetStop, SourceReadError } from './http-transport.js';

const url = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3812345678';
const result = (requested: string) => ({ html: '<h1>Engineer</h1>', url: requested, status: 200, bytes: 17 });
function clock() {
  let time = 0; const waits: number[] = [];
  return { now: () => time, wait: async (ms: number) => { waits.push(ms); time += ms; }, waits };
}

test('first-request 429 can recover once after a bounded cooldown, with transparent metrics', async () => {
  const timing = clock(); let reads = 0; const sentAt: number[] = [];
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
    readSource: async requested => { reads++; sentAt.push(timing.now()); if (reads === 1) throw new SourceReadError('http_429'); return result(requested); } });
  assert.equal((await source.read(url)).status, 200);
  assert.deepEqual(sentAt, [0, 12_000]);
  assert.equal(source.summary().sourceAttempts, 2);
  assert.equal(source.summary().rateLimitResponses, 1);
  assert.equal(source.summary().rateLimitRetries, 1);
  assert.equal(source.summary().recoveredRateLimits, 1);
  assert.equal(source.summary().waitMs, 12_000);
  assert.equal(source.summary().terminalFailure, null);
});

test('real guarded reader passes Retry-After to the controller without reading error content', async () => {
  const timing = clock(); let reads = 0; let cancelled = false;
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
    readSource: (requested, options) => readGuestPage(requested, { ...options, fetcher: async () => {
      reads++;
      if (reads === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429, headers: { 'retry-after': '18' } });
      assert.equal(timing.now(), 18_000);
      return new Response('<h1>Engineer</h1>', { headers: { 'content-type': 'text/html' } });
    } }) });
  await source.read(url);
  assert.equal(reads, 2); assert.equal(cancelled, true);
  assert.equal(source.summary().recoveredRateLimits, 1);
});

test('persistent 429 sends exactly two attempts and latches the circuit against later pages', async () => {
  const timing = clock(); let reads = 0;
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
    readSource: async () => { reads++; throw new SourceReadError('http_429'); } });
  await assert.rejects(source.read(url), (error: unknown) => error instanceof SourceReadError && !error.retryable);
  await assert.rejects(source.read(url), /http_429/);
  assert.equal(reads, 2);
  assert.equal(source.summary().rateLimitResponses, 2);
  assert.equal(source.summary().recoveredRateLimits, 0);
  assert.equal(source.summary().stopReason, 'rate_limit_retry_exhausted');
});

test('server waits beyond the 20-second bound stop immediately, never truncate Retry-After', async () => {
  const timing = clock(); let reads = 0;
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
    readSource: async () => { reads++; throw new SourceReadError('http_429', false, 60_000); } });
  await assert.rejects(source.read(url), /http_429/);
  assert.equal(reads, 1); assert.equal(timing.waits.length, 0);
  assert.equal(source.summary().rateLimitRetries, 0);
  assert.equal(source.summary().stopReason, 'retry_after_exceeds_bound');
});

test('a 20-second Retry-After is allowed while short or zero waits still respect pacing', async () => {
  for (const delay of [0, 500, 20_000]) {
    const timing = clock(); let reads = 0;
    const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
      readSource: async requested => { if (++reads === 1) throw new SourceReadError('http_429', false, delay); return result(requested); } });
    await source.read(url);
    assert.equal(timing.now(), Math.max(HTTP_MIN_INTERVAL_MS, delay));
    assert.equal(source.summary().recoveredRateLimits, 1);
  }
});

test('rate-limit recovery budget is shared by every page, not reset by successful reads', async () => {
  const timing = clock(); let reads = 0;
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
    readSource: async requested => { reads++; if (reads % 2 === 1) throw new SourceReadError('http_429'); return result(requested); } });
  await source.read(url); await source.read(url);
  await assert.rejects(source.read(url), /http_429/);
  assert.equal(reads, 5);
  assert.equal(source.summary().rateLimitRetries, HTTP_MAX_RATE_LIMIT_RETRIES);
  assert.equal(source.summary().recoveredRateLimits, 2);
  assert.equal(source.summary().stopReason, 'run_rate_limit_retry_bound');
});

test('transport/server retry and rate-limit retry cannot stack on the same page', async () => {
  for (const categories of [['http_429', 'http_503'], ['transport_failed', 'http_429']]) {
    const timing = clock(); let reads = 0;
    const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
      readSource: async () => { const category = categories[reads++]; throw new SourceReadError(category, category !== 'http_429'); } });
    await assert.rejects(source.read(url), (error: unknown) => error instanceof SourceReadError && !error.retryable);
    assert.equal(reads, 2); assert.equal(source.summary().retries, 1);
    assert.equal(source.summary().recoveredRateLimits, 0); assert.equal(source.summary().recoveredTransientErrors, 0);
  }
});

test('transient failure can recover once and a 503 respects its own server-directed cooldown', async () => {
  const timing = clock(); let reads = 0;
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
    readSource: async requested => { if (++reads === 1) throw new SourceReadError('http_503', true, 6000); return result(requested); } });
  await source.read(url);
  assert.equal(timing.now(), 6000); assert.equal(reads, 2);
  assert.equal(source.summary().transientRetries, 1); assert.equal(source.summary().recoveredTransientErrors, 1);
  assert.equal(source.summary().rateLimitRetries, 0);
});

test('spending allowance is rechecked during cooldown and lost allowance sends no retry', async () => {
  const timing = clock(); let reads = 0;
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => timing.now() < 750,
    readSource: async () => { reads++; throw new SourceReadError('http_429'); } });
  await assert.rejects(source.read(url), (error: unknown) => error instanceof SourceBudgetStop && error.reason === 'budget');
  assert.equal(reads, 1); assert.equal(source.summary().retries, 0);
  assert.equal(source.summary().waitMs, 750);
  assert.equal(source.summary().stopReason, 'spending_or_result_bound');
});

test('cooldown that cannot fit the source deadline stops without sleeping or retrying', async () => {
  const timing = clock(); let reads = 0;
  const source = new HttpSource({ ...timing, deadline: 10_000, canContinue: () => true,
    readSource: async () => { reads++; throw new SourceReadError('http_429'); } });
  await assert.rejects(source.read(url), (error: unknown) => error instanceof SourceBudgetStop && error.reason === 'time');
  assert.equal(reads, 1); assert.equal(timing.waits.length, 0);
  assert.equal(source.summary().retries, 0);
  assert.equal(source.summary().stopReason, 'source_time_bound');
});

test('pacing serializes even overlapping callers, does not delay the first read and snapshots are immutable', async () => {
  const timing = clock(); const sentAt: number[] = []; let active = 0;
  const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
    readSource: async requested => { assert.equal(active++, 0); sentAt.push(timing.now()); await Promise.resolve(); active--; return result(requested); } });
  await Promise.all([source.read(url), source.read(url), source.read(url)]);
  assert.deepEqual(sentAt, [0, 1500, 3000]);
  assert.equal(source.summary().sourceAttempts, 3);
  assert.equal(source.summary().decodedHtmlBytes, 51);
  const snapshot = source.summary(); snapshot.policy.minIntervalMs = 0; snapshot.rateLimitRetries = 999;
  assert.equal(source.summary().policy.minIntervalMs, 1500); assert.equal(source.summary().rateLimitRetries, 0);
});

test('budget-zero and expired deadline make no source attempt', async () => {
  let reads = 0;
  for (const [canContinue, deadline] of [[() => false, 180_000], [() => true, 0]] as const) {
    const source = new HttpSource({ ...clock(), canContinue, deadline,
      readSource: async requested => { reads++; return result(requested); } });
    await assert.rejects(source.read(url), SourceBudgetStop);
    assert.equal(source.summary().sourceAttempts, 0);
  }
  assert.equal(reads, 0);
});

test('authwalls, redirects, size errors and unexpected errors never trigger a retry or expose secrets', async () => {
  for (const error of [new SourceReadError('http_403'), new SourceReadError('http_302'), new SourceReadError('html_size_limit'), new Error('secret token')]) {
    const timing = clock(); let reads = 0;
    const source = new HttpSource({ ...timing, deadline: 180_000, canContinue: () => true,
      readSource: async () => { reads++; throw error; } });
    await assert.rejects(source.read(url), (caught: unknown) => caught instanceof SourceReadError && !caught.retryable && !caught.message.includes('secret'));
    assert.equal(reads, 1); assert.equal(timing.waits.length, 0);
    assert.equal(source.summary().stopReason, 'source_unavailable');
  }
});
