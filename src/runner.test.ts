import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Actor } from 'apify';
import { BasicCrawler, Request } from 'crawlee';
import { runActor, type RunDependencies } from './runner.js';
import { SourceReadError } from './http-transport.js';
import type { ActorInput } from './types.js';
import type { ChangeReport, WatchlistState, WatchlistStorage } from './watchlist.js';

const quiet = { info() {}, warning() {}, error() {}, debug() {} };
const html = '<h1>US Software Engineer</h1><a class="topcard__org-name-link" href="/company/example">Example</a><span class="topcard__flavor--bullet">Austin, TX</span><div class="show-more-less-html__markup"><p>Build Python and SQL services.</p></div>';
function sourceTiming() {
  let time = 0;
  return { now: () => time, wait: async (ms: number) => { time += ms; } };
}
function fakeActor(t: TestContext, input: ActorInput, allowance = 100) {
  const output: Record<string, any> = {}; const rows: any[] = []; const messages: string[] = [];
  t.mock.method(Actor, 'init', async () => {});
  t.mock.method(Actor, 'getInput', async () => input);
  t.mock.method(Actor, 'isAtHome', () => true);
  t.mock.method(Actor, 'getEnv', () => ({ memoryMbytes: 1024, actorRunId: 'offline-fixture' }));
  t.mock.method(Actor, 'getChargingManager', () => ({ getPricingInfo: () => ({ isPayPerEvent: true }), calculateMaxEventChargeCountWithinLimit: () => allowance }));
  t.mock.method(Actor, 'setValue', async (key: string, value: unknown) => { output[key] = value; });
  t.mock.method(Actor, 'setStatusMessage', async (message: string) => { messages.push(message); });
  t.mock.method(Actor, 'pushData', async (row: unknown, event: string) => { assert.equal(event, 'job-scraped'); rows.push(row); return { chargedCount: 1, eventChargeLimitReached: false }; });
  t.mock.method(Actor, 'createProxyConfiguration', async () => { throw new Error('No proxy must be created in these fixtures'); });
  t.mock.method(Actor, 'exit', async () => {});
  return { output, rows, messages };
}

// Exercise the configured handler without initializing a queue, browser or external source.
async function handler(crawler: BasicCrawler<any>, request: Request, stopped: () => void,
  addRequests: (requests: any[]) => Promise<void> = async () => { throw new Error('Unexpected paging'); }) {
  const callable = crawler as unknown as { requestHandler: (context: unknown) => Promise<void> };
  await callable.requestHandler({ request, crawler: { stop: stopped, addRequests }, log: quiet });
}

test('production entrypoint returns at zero allowance before proxy, source, crawler or watchlist setup', async (t) => {
  const fake = fakeActor(t, { watchlistName: 'never-opened', keywords: ['engineer'], locations: ['United States'] }, 0);
  await runActor({ readSource: async () => { throw new Error('Unexpected fetch'); }, runCrawler: async () => { throw new Error('Unexpected crawl'); } });
  assert.equal(fake.output['RUN-SUMMARY'].stopReason, 'charge-limit'); assert.equal(fake.rows.length, 0);
  assert.equal(fake.output['RUN-SUMMARY'].boundedObservationComplete, false);
});

test('production HTTP path saves a full job through the shared parser and writes coverage metadata', async (t) => {
  const fake = fakeActor(t, { jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'], maxResults: 1, transport: 'http' });
  let reads = 0;
  await runActor({ readSource: async url => { reads++; return { html, url, bytes: Buffer.byteLength(html), status: 200 }; },
    runCrawler: async (crawler, requests) => { assert.equal(crawler.constructor, BasicCrawler); assert.equal(requests.length, 1); await handler(crawler, new Request<Record<string, any>>(requests[0]), () => {}); } });
  assert.equal(reads, 1); assert.equal(fake.rows.length, 1); assert.equal(fake.rows[0].jobTitle, 'US Software Engineer');
  assert.equal(fake.rows[0].companyName, 'Example'); assert.match(fake.rows[0].jobDescription, /Python/);
  assert.equal(fake.output['RUN-SUMMARY'].boundedObservationComplete, true);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].automaticFallback, false);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].explicitProxy, false);
});

test('production persistent HTTP rate limit stops after one retry and cannot report an empty successful scan', async (t) => {
  const fake = fakeActor(t, { jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'], transport: 'http' });
  let stopped = 0;
  await assert.rejects(runActor({ sourceTiming: sourceTiming(), readSource: async () => { throw new SourceReadError('http_429'); },
    runCrawler: async (crawler, requests) => {
      const request = new Request<Record<string, any>>(requests[0]);
      await assert.rejects(handler(crawler, request, () => { stopped++; }), /http_429/);
      assert.equal(request.noRetry, true);
      const callable = crawler as unknown as { failedRequestHandler: (context: unknown) => Promise<void> };
      await callable.failedRequestHandler({ request, log: quiet });
    } }), /No usable jobs/);
  assert.equal(stopped, 1); assert.equal(fake.rows.length, 0);
  assert.equal(fake.output['RUN-SUMMARY'].boundedObservationComplete, false);
  assert.ok(fake.output['RUN-SUMMARY'].reasons.includes('request-failed'));
  assert.equal(fake.output['RUN-SUMMARY'].stopReason, 'rate-limit');
  assert.equal(fake.output['TRANSPORT-SUMMARY'].sourceAttempts, 2);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].retries, 1);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].recoveredRateLimits, 0);
});

test('browser transport rejects insufficient cloud memory before paid proxy preparation', async (t) => {
  fakeActor(t, { transport: 'browser', keywords: ['engineer'], locations: ['United States'] });
  t.mock.method(Actor, 'getEnv', () => ({ memoryMbytes: 256 }));
  await assert.rejects(runActor(), /at least 1024 MB/);
});

test('production entrypoint connects saved observations to a baseline and matching repeat without cloud storage', async (t) => {
  const fake = fakeActor(t, { jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'], maxResults: 1,
    watchlistName: 'offline-us-hiring', transport: 'http' });
  let runId = 'fixture-baseline'; let state: WatchlistState | null = null;
  const reports: ChangeReport[] = [];
  t.mock.method(Actor, 'getEnv', () => ({ memoryMbytes: 1024, actorRunId: runId }));
  const storage: WatchlistStorage = { read: async () => state, acquireLock: async () => 'offline-lock',
    assertLock: async () => {}, releaseLock: async () => {}, write: async next => { state = next; },
    publish: async report => { reports.push(report); } };
  const dependencies = { openStorage: async () => storage,
    readSource: async (url: string) => ({ html, url, bytes: Buffer.byteLength(html), status: 200 }),
    runCrawler: async (crawler: BasicCrawler<any>, requests: Parameters<NonNullable<RunDependencies['runCrawler']>>[1]) => {
      await handler(crawler, new Request<Record<string, any>>(requests[0]), () => {});
    } };
  await runActor(dependencies);
  assert.equal(reports.at(-1)?.status, 'initialized'); assert.equal(reports.at(-1)?.baselineCommitted, true);
  runId = 'fixture-repeat'; await runActor(dependencies);
  assert.equal(reports.at(-1)?.status, 'compared'); assert.equal(reports.at(-1)?.baselineCommitted, true);
  assert.equal(reports.at(-1)?.counts.unchanged, 1); assert.equal(reports.at(-1)?.counts.newlyObserved, 0);
  assert.equal(fake.rows.length, 2, 'repeat saves and charges the successful observation again');
});

test('25-job production baseline and repeat can recover a first-search 429, save full jobs and commit matching history', async (t) => {
  const fake = fakeActor(t, { keywords: ['engineer'], locations: ['United States'], maxResults: 25, maxJobsPerSearch: 25,
    watchlistName: 'offline-rate-limit', transport: 'http' });
  let runId = 'offline-baseline'; let state: WatchlistState | null = null; let reads = 0;
  const reports: ChangeReport[] = [];
  t.mock.method(Actor, 'getEnv', () => ({ memoryMbytes: 256, actorRunId: runId }));
  const storage: WatchlistStorage = { read: async () => state, acquireLock: async () => 'offline-lock',
    assertLock: async () => {}, releaseLock: async () => {}, write: async next => { state = next; },
    publish: async report => { reports.push(report); } };
  const searchHtml = Array.from({ length: 25 }, (_, index) => `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${3812345678 + index}"><h3>Engineer</h3></div></li>`).join('');
  const run = async () => runActor({ sourceTiming: sourceTiming(), openStorage: async () => storage,
    readSource: async url => {
      if (++reads === 1) throw new SourceReadError('http_429', false, 3000);
      const body = url.includes('/search?') ? searchHtml : html;
      return { html: body, url, status: 200, bytes: Buffer.byteLength(body) };
    },
    runCrawler: async (crawler, requests) => {
      assert.equal((crawler as unknown as { maxRequestRetries: number }).maxRequestRetries, 0,
        'Crawler retries must not multiply the source retry allowance.');
      let stopped = false;
      const queue = requests.map(spec => new Request<Record<string, any>>(spec));
      while (queue.length && !stopped) await handler(crawler, queue.shift()!, () => { stopped = true; },
        async added => { queue.push(...added.map(spec => new Request<Record<string, any>>(spec))); });
    },
  });
  await run();
  assert.equal(fake.rows.length, 25); assert.equal(new Set(fake.rows.map(row => row.jobId)).size, 25);
  assert.ok(fake.rows.every(row => row.jobDescription.includes('Python') && row.companyName === 'Example'));
  assert.equal(fake.output['RUN-SUMMARY'].boundedObservationComplete, true);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].sourceAttempts, 27);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].recoveredRateLimits, 1);
  assert.equal(reports.at(-1)?.status, 'initialized'); assert.equal(reports.at(-1)?.baselineCommitted, true);
  reads = 0; runId = 'offline-repeat'; await run();
  assert.equal(fake.rows.length, 50); assert.equal(fake.output['RUN-SUMMARY'].jobsCharged, 25);
  assert.equal(reports.at(-1)?.status, 'compared'); assert.equal(reports.at(-1)?.baselineCommitted, true);
  assert.equal(reports.at(-1)?.counts.unchanged, 25); assert.equal(reports.at(-1)?.counts.newlyObserved, 0);
});

test('persistent rate limit on a repeat preserves prior history, writes incomplete report and never bills jobs', async (t) => {
  const fake = fakeActor(t, { jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'], maxResults: 1,
    watchlistName: 'offline-history-preserved', transport: 'http' });
  let state: WatchlistState | null = null; let writes = 0;
  const reports: ChangeReport[] = [];
  const storage: WatchlistStorage = { read: async () => state, acquireLock: async () => 'offline-lock',
    assertLock: async () => {}, releaseLock: async () => {}, write: async next => { writes++; state = next; },
    publish: async report => { reports.push(report); } };
  const baseline = { sourceTiming: sourceTiming(), openStorage: async () => storage,
    readSource: async (url: string) => ({ html, url, status: 200, bytes: Buffer.byteLength(html) }),
    runCrawler: async (crawler: BasicCrawler<any>, requests: Parameters<NonNullable<RunDependencies['runCrawler']>>[1]) => {
      await handler(crawler, new Request<Record<string, any>>(requests[0]), () => {});
    } };
  await runActor(baseline);
  const before = JSON.stringify(state); assert.equal(writes, 1); assert.equal(fake.rows.length, 1);
  t.mock.method(Actor, 'getEnv', () => ({ memoryMbytes: 256, actorRunId: 'offline-blocked-repeat' }));
  await assert.rejects(runActor({ ...baseline, sourceTiming: sourceTiming(), readSource: async () => { throw new SourceReadError('http_429'); },
    runCrawler: async (crawler, requests) => {
      const request = new Request<Record<string, any>>(requests[0]);
      await assert.rejects(handler(crawler, request, () => {}), /http_429/);
      const callable = crawler as unknown as { failedRequestHandler: (context: unknown) => Promise<void> };
      await callable.failedRequestHandler({ request, log: quiet });
    } }), /No usable jobs/);
  assert.equal(fake.rows.length, 1); assert.equal(writes, 1); assert.equal(JSON.stringify(state), before);
  assert.equal(fake.output['RUN-SUMMARY'].jobsCharged, 0);
  assert.equal(fake.output['RUN-SUMMARY'].stopReason, 'rate-limit');
  assert.equal(reports.at(-1)?.status, 'incomplete'); assert.equal(reports.at(-1)?.baselineCommitted, false);
});

test('HTTP 200 authwall is a handler failure, not an empty successful or billable job', async (t) => {
  const fake = fakeActor(t, { jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'], transport: 'http' });
  const wall = '<h1>Security verification</h1><p>Verify you are a human</p>';
  await assert.rejects(runActor({ sourceTiming: sourceTiming(), readSource: async url => ({ html: wall, url, status: 200, bytes: wall.length }),
    runCrawler: async (crawler, requests) => {
      const request = new Request<Record<string, any>>(requests[0]);
      await assert.rejects(handler(crawler, request, () => {}), /blocked/);
      assert.equal(request.noRetry, true);
      const callable = crawler as unknown as { failedRequestHandler: (context: unknown) => Promise<void> };
      await callable.failedRequestHandler({ request, log: quiet });
    } }), /No usable jobs/);
  assert.equal(fake.rows.length, 0); assert.equal(fake.output['RUN-SUMMARY'].jobsCharged, 0);
  assert.equal(fake.output['RUN-SUMMARY'].stopReason, 'source-unavailable');
  assert.equal(fake.output['TRANSPORT-SUMMARY'].handlerFailure, 'handler_failed');
  assert.equal(fake.output['TRANSPORT-SUMMARY'].sourceAttempts, 1);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].retries, 0);
});

test('cooldown that cannot fit remaining run time reports time-limit and never advances empty history', async (t) => {
  const fake = fakeActor(t, { jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'], transport: 'http' });
  const timing = sourceTiming(); let reads = 0;
  await assert.rejects(runActor({ sourceTiming: timing, readSource: async () => { reads++; throw new SourceReadError('http_429'); },
    runCrawler: async (crawler, requests) => {
      // Simulate time already consumed by queue/storage overhead, not a real sleep.
      await timing.wait(175_000);
      await handler(crawler, new Request<Record<string, any>>(requests[0]), () => {});
    } }), /No usable jobs/);
  assert.equal(reads, 1); assert.equal(timing.now(), 175_000);
  assert.equal(fake.rows.length, 0);
  assert.equal(fake.output['RUN-SUMMARY'].stopReason, 'time-limit');
  assert.equal(fake.output['RUN-SUMMARY'].boundedObservationComplete, false);
  assert.equal(fake.output['TRANSPORT-SUMMARY'].stopReason, 'source_time_bound');
  assert.equal(fake.output['TRANSPORT-SUMMARY'].retries, 0);
});
