// Read-only LOCAL prototype. No Actor.init, API client, proxy, named state or SDK storage.
import fs from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { Actor } from 'apify';
import { Request } from 'crawlee';
import { buildInitialRequests, createBudget, reserveJob, resolveLimits } from '../dist/lib.js';
import { titleDiscovery } from '../dist/discovery.js';
import { staticHtmlPage } from '../dist/html-page.js';
import { router } from '../dist/routes.js';
import { ScanTracker } from '../dist/scan.js';
import { setBudget, setScan } from '../dist/state.js';

if (process.env.APIFY_IS_AT_HOME === '1' || process.env.APIFY_ACTOR_RUN_ID || process.env.ACTOR_RUN_ID) {
  throw new Error('This prototype must not run inside a paid Actor.');
}
const flag = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const keyword = flag('keywords') ?? 'software engineer';
const minimumRequestIntervalMs = 1000;
const pageCap = flag('title-pages') ? Number(flag('title-pages')) : null;
const discovery = pageCap === null ? null : titleDiscovery(pageCap);
const input = { keywords: [keyword], locations: ['United States'], workplaceType: ['remote'],
  datePosted: 'past-week', sortBy: 'recent', maxResults: 25, maxJobsPerSearch: 25 };
const requests = buildInitialRequests(input).map(request => ({ ...request,
  userData: { ...request.userData, ...(discovery ? { titleDiscovery: discovery } : {}) } }));
const budget = createBudget(resolveLimits(input));
const startedAt = new Date().toISOString();
const tracker = new ScanTracker(requests, startedAt);
setBudget(budget); setScan(tracker);
const rows = [];
const captures = [];
const pending = [];
const keys = new Set();
let stopped = false;
const hardRequestLimit = 25 + (pageCap ?? 5);
const quiet = { info() {}, warning() {}, error() {}, debug() {} };
const crawler = { stop() { stopped = true; }, async addRequests(items) {
  for (const item of items) { if (!keys.has(item.uniqueKey)) { keys.add(item.uniqueKey); pending.push(item); } }
} };
await crawler.addRequests(requests);
const originalPush = Actor.pushData;
// The production handler calls a fake in-memory sink here, not Apify's API.
// JobsSaved therefore means locally collected; no event is actually charged.
Actor.pushData = async row => { rows.push(row); return { chargedCount: 0, eventChargeLimitReached: false }; };
const errors = [];
const start = performance.now();
let lastRequestStartedAt = -Infinity;
try {
  while (pending.length && !stopped) {
    if (captures.length >= hardRequestLimit || performance.now() - start > 120_000) {
      throw new Error('Local request/time bound reached; not claiming a completed observation.');
    }
    const spec = pending.shift();
    const source = new URL(spec.url);
    if (source.protocol !== 'https:' || source.hostname !== 'www.linkedin.com' || !source.pathname.startsWith('/jobs-guest/')) {
      throw new Error('The local prototype only reads public LinkedIn guest endpoints.');
    }
    const request = new Request(spec);
    if (spec.label === 'job-detail' && !budget.seenJobIds.has(spec.userData.jobId)) {
      if (!reserveJob(budget, spec.userData.searchId, spec.userData.jobId)) continue;
      tracker.queueDetail(spec.userData.searchId, spec.userData.jobId);
    }
    const waitMs = minimumRequestIntervalMs - (performance.now() - lastRequestStartedAt);
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastRequestStartedAt = performance.now();
    const response = await fetch(spec.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'www.linkedin.com') throw new Error('Unexpected public-source redirect.');
    const html = await response.text();
    captures.push({ spec, statusCode: response.status, pageUrl: response.url,
      decodedHtmlBytes: Buffer.byteLength(html), contentEncoding: response.headers.get('content-encoding'), retryAfter: response.headers.get('retry-after'), html });
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Unexpected public response content type.');
    const page = staticHtmlPage(html, response.url);
    try {
      await router.getHandler(spec.label)({ page, request, response: { status: () => response.status },
        session: { retire() {} }, log: quiet, crawler });
    } catch (error) {
      tracker.fail(spec.userData.searchId);
      throw error;
    }
  }
} catch (error) { errors.push(String(error)); }
finally { Actor.pushData = originalPush; }
const summary = tracker.finish(budget, new Date().toISOString(), errors.length > 0);
const result = { note: 'Local HTTP observation only; no paid proxy, Actor build/run, event charges, Apify storage writes or watchlist commit. The optional local receipt is not an Apify dataset. Local timing is not Apify cost or Residential reliability proof.',
  input, discovery, minimumRequestIntervalMs, elapsedSeconds: (performance.now() - start) / 1000,
  processPeakRssMiB: process.resourceUsage().maxRSS / 1024, httpRequests: captures.length,
  decodedHtmlBytes: captures.reduce((sum, value) => sum + value.decodedHtmlBytes, 0),
  // Content-Encoding is observed, but decoded bytes are NOT billable proxy bytes.
  errors, summary, rows, captures };
const output = flag('output');
if (output) {
  const target = resolve(output);
  const rel = relative(resolve('E:/APIFY PROJECT'), target);
  if (!rel || rel.startsWith('..') || /^(?:[A-Z]:|\/|\\)/i.test(rel)) throw new Error('Output must be a file within the named workspace.');
  await fs.writeFile(target, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ note: result.note, rows: rows.length, elapsedSeconds: result.elapsedSeconds,
  processPeakRssMiB: result.processPeakRssMiB, httpRequests: captures.length, decodedHtmlBytes: result.decodedHtmlBytes,
  errors, summary }, null, 2));
if (errors.length) process.exitCode = 1;
