import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Actor } from 'apify';
import { Request, type PlaywrightCrawlingContext } from 'crawlee';
import { chromium, type Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import { buildDirectJobRequests, buildSearchRequests, createBudget, reserveJob } from './lib.js';
import { router } from './routes.js';
import { ScanTracker } from './scan.js';
import { setBudget, setScan } from './state.js';
import type { JobRecord } from './types.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const quiet = { info() {}, warning() {}, error() {}, debug() {} };
const detailHtml = `<!doctype html><html><body>
<h1 class="top-card-layout__title">Software Engineer</h1>
<a class="topcard__org-name-link" href="https://www.linkedin.com/company/example/">Example Company</a>
<span class="topcard__flavor--bullet">London, UK</span>
<span class="topcard__flavor--metadata-posted-date">2 days ago</span>
<div class="description__text"><div class="show-more-less-html__markup">
  <h3>Responsibilities</h3><ul><li>Build software with Python and SQL</li></ul>
  <h3>Benefits</h3><ul><li>Public benefit example</li></ul>
</div></div>
<a href="https://careers.example/jobs/123">Apply now</a>
<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Software Engineer', datePosted: '2026-09-20',
  hiringOrganization: { name: 'Example Company' }, employmentType: 'Full-time',
  baseSalary: { currency: 'GBP', value: { minValue: 80000, maxValue: 100000, unitText: 'YEAR' } } })}</script>
</body></html>`;

function context(page: PlaywrightCrawlingContext['page'], request: Request, extras: Record<string, unknown> = {}): PlaywrightCrawlingContext {
  return { page, request, response: { status: () => 200 }, session: { retire() {} }, log: quiet,
    crawler: { stop() {}, async addRequests() {} }, ...extras } as unknown as PlaywrightCrawlingContext;
}

test('actual browser parser preserves ordinary fields and passes only successfully saved jobs to monitoring', async (t) => {
  const page = await browser.newPage();
  try {
    await page.setContent(detailHtml);
    const requests = buildDirectJobRequests({ jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'] });
    const tracker = new ScanTracker(requests, new Date().toISOString());
    const budget = createBudget({ maxResults: 5, maxJobsPerSearch: 5 });
    const request = new Request(requests[0]);
    reserveJob(budget, request.userData.searchId, request.userData.jobId);
    tracker.queueDetail(request.userData.searchId, request.userData.jobId);
    setBudget(budget);
    const observed: JobRecord[] = [];
    setScan(tracker, (record) => observed.push(record));
    const pushed: unknown[] = [];
    t.mock.method(Actor, 'pushData', async (row: unknown, event: string) => {
      assert.equal(event, 'job-scraped');
      pushed.push(row);
      return { chargedCount: 1, eventChargeLimitReached: false };
    });
    await router.getHandler('job-detail')(context(page, request));
    assert.equal(pushed.length, 1);
    assert.equal(observed.length, 1);
    const row = observed[0];
    assert.equal(row.jobTitle, 'Software Engineer');
    assert.equal(row.companyName, 'Example Company');
    assert.equal(row.jobLocation, 'London, UK');
    assert.equal(row.salaryMin, 80000);
    assert.equal(row.salaryMax, 100000);
    assert.equal(row.salaryCurrency, 'GBP');
    assert.equal(row.salaryPeriod, 'YEAR');
    assert.equal(row.applyUrl, 'https://careers.example/jobs/123');
    assert.ok(row.requiredSkills.includes('Python'));
    assert.ok(row.requiredSkills.includes('SQL'));
    assert.match(row.jobDescription!, /Build software/);
    assert.equal(tracker.finish(budget, new Date().toISOString()).boundedObservationComplete, true);
  } finally { await page.close(); }
});

test('free/local successful writes remain fully reachable, but rejected spending-limit writes never enter the baseline', async (t) => {
  const page = await browser.newPage();
  try {
    await page.setContent(detailHtml);
    for (const limitReached of [false, true]) {
      const requests = buildDirectJobRequests({ jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'] });
      const tracker = new ScanTracker(requests, new Date().toISOString());
      const budget = createBudget({ maxResults: 5, maxJobsPerSearch: 5 });
      const request = new Request(requests[0]);
      reserveJob(budget, request.userData.searchId, request.userData.jobId);
      tracker.queueDetail(request.userData.searchId, request.userData.jobId);
      setBudget(budget);
      const observed: JobRecord[] = [];
      setScan(tracker, (record) => observed.push(record));
      const mocked = t.mock.method(Actor, 'pushData', async () => ({ chargedCount: 0, eventChargeLimitReached: limitReached }));
      await router.getHandler('job-detail')(context(page, request));
      mocked.mock.restore();
      assert.equal(observed.length, limitReached ? 0 : 1);
      assert.equal(budget.pushed, limitReached ? 0 : 1);
      assert.equal(tracker.finish(budget, new Date().toISOString()).boundedObservationComplete, !limitReached);
    }
  } finally { await page.close(); }
});

test('search cards, deduplication and bounded pagination feed accurate browser-derived coverage', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<ul>${['3812345678', '3812345679'].map((id) => `<li>
      <div class="base-card" data-entity-urn="urn:li:jobPosting:${id}"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}"></a>
      <h3 class="base-search-card__title">Engineer</h3><h4 class="base-search-card__subtitle">Example</h4></div></li>`).join('')}</ul>`);
    const requests = buildSearchRequests({ keywords: ['engineer'], locations: ['UK'] });
    const tracker = new ScanTracker(requests, new Date().toISOString());
    const budget = createBudget({ maxResults: 1, maxJobsPerSearch: 1 });
    setBudget(budget); setScan(tracker);
    const added: Array<{ label: string }> = [];
    await router.getHandler('search')(context(page, new Request(requests[0]), {
      crawler: { async addRequests(items: Array<{ label: string }>) { added.push(...items); } },
    }));
    assert.equal(added.length, 1);
    assert.equal(added[0].label, 'job-detail');
    const summary = tracker.finish(budget, new Date().toISOString());
    assert.equal(summary.coverage[0].jobIdsSeen, 2);
    assert.equal(summary.coverage[0].detailsQueued, 1);
    assert.equal(summary.coverage[0].status, 'capped');
    assert.ok(summary.reasons.includes('unfinished-job-details'));
  } finally { await page.close(); }
});

test('browser authwalls and HTTP error documents cannot become billable jobs', async (t) => {
  const page = await browser.newPage();
  try {
    const requests = buildDirectJobRequests({ jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'] });
    setBudget(createBudget({ maxResults: 5, maxJobsPerSearch: 5 }));
    setScan(new ScanTracker(requests, new Date().toISOString()));
    let pushes = 0;
    t.mock.method(Actor, 'pushData', async () => { pushes += 1; return { chargedCount: 1, eventChargeLimitReached: false }; });
    await page.setContent('<h1>Security verification</h1><p>Verify you are a human</p>');
    await assert.rejects(async () => router.getHandler('job-detail')(context(page, new Request(requests[0]))), /blocked/);
    await page.setContent(detailHtml);
    await assert.rejects(async () => router.getHandler('job-detail')(context(page, new Request(requests[0]), { response: { status: () => 404 } })), /HTTP 404/);
    assert.equal(pushes, 0);
  } finally { await page.close(); }
});

test('a card-only fallback can keep old scrape behavior but cannot advance monitoring', async (t) => {
  const page = await browser.newPage();
  try {
    await page.setContent('<p>No job detail content was published.</p>');
    const requests = buildDirectJobRequests({ jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'] });
    const tracker = new ScanTracker(requests, new Date().toISOString());
    const budget = createBudget({ maxResults: 5, maxJobsPerSearch: 5 });
    const request = new Request({ ...requests[0], userData: { ...requests[0].userData, jobTitle: 'Engineer', companyName: 'Example' } });
    reserveJob(budget, request.userData.searchId, request.userData.jobId);
    tracker.queueDetail(request.userData.searchId, request.userData.jobId);
    setBudget(budget); setScan(tracker);
    t.mock.method(Actor, 'pushData', async () => ({ chargedCount: 1, eventChargeLimitReached: false }));
    await router.getHandler('job-detail')(context(page, request));
    assert.equal(budget.pushed, 1);
    assert.equal(tracker.finish(budget, new Date().toISOString()).boundedObservationComplete, false);
  } finally { await page.close(); }
});

test('HTTP candidate keeps QA/billing/output contracts and declares its lower-memory configuration', () => {
  const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  const schema = json('INPUT_SCHEMA.json');
  assert.equal(schema.properties.watchlistName.default, '');
  assert.equal(schema.properties.maxResults.prefill, 1);
  assert.equal(schema.properties.maxJobsPerSearch.prefill, 1);
  const actor = json('.actor/actor.json');
  assert.equal(JSON.parse(actor.exampleRunInput.body).watchlistName, undefined);
  assert.equal(actor.pricingInfo.pricingPerEvent.actorChargeEvents['job-scraped'].eventPriceUsd, 0.001);
  assert.equal(actor.defaultRunOptions.memoryMbytes, 256);
  assert.equal(actor.minMemoryMbytes, 256);
  assert.equal(JSON.parse(actor.exampleRunInput.body).transport, 'http');
  assert.equal(schema.properties.proxyConfiguration.default.useApifyProxy, false);
  assert.equal(json('.actor/output_schema.json').properties.results.template, '{{links.apiDefaultDatasetUrl}}/items');
  assert.equal(json('.actor/dataset_schema.json').fields.properties.jobId.type, 'string');
  assert.equal(json('.actor/dataset_schema.json').fields.properties.workplaceEvidence.type, 'array');
});

test('browser workplace filter rejects hybrid and benefits-only candidates before saving or charging', async (t) => {
  const page = await browser.newPage();
  try {
    const requests = buildSearchRequests({ keywords: ['engineer'], locations: ['US'], workplaceType: ['remote'] });
    let pushes = 0;
    t.mock.method(Actor, 'pushData', async () => { pushes += 1; return { chargedCount: 1, eventChargeLimitReached: false }; });
    for (const [description, expectedUnknown] of [
      ['This role is categorized as hybrid. Office attendance is required.', false],
      ['Benefits include on-site health and wellness centers.', true],
    ] as const) {
      const tracker = new ScanTracker(requests, new Date().toISOString());
      const budget = createBudget({ maxResults: 1, maxJobsPerSearch: 1 });
      const key = requests[0].userData.searchId;
      tracker.searchPage(key, ['3812345678'], 1); tracker.cap(key);
      reserveJob(budget, key, '3812345678'); tracker.queueDetail(key, '3812345678');
      setBudget(budget); setScan(tracker);
      await page.setContent(detailHtml.replace('Build software with Python and SQL', description));
      const request = new Request({ url: 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3812345678',
        label: 'job-detail', userData: { ...requests[0].userData, jobId: '3812345678' } });
      await router.getHandler('job-detail')(context(page, request));
      const summary = tracker.finish(budget, new Date().toISOString());
      assert.equal(budget.pushed, 0); assert.equal(budget.charged, 0);
      assert.equal(budget.enqueued, 1, 'Do not recycle filtered slots into unbounded discovery.');
      assert.equal(summary.coverage[0].detailsFiltered, 1);
      assert.equal(summary.coverage[0].workplaceUnverified, expectedUnknown ? 1 : 0);
      assert.equal(summary.reasons.includes('unfinished-job-details'), false);
      assert.equal(summary.reasons.includes('workplace-filter-unverified'), expectedUnknown);
      assert.equal(summary.boundedObservationComplete, false);
    }
    assert.equal(pushes, 0);
  } finally { await page.close(); }
});

test('actual browser parser saves only an explicitly remote role, with inspectable source evidence', async (t) => {
  const page = await browser.newPage();
  try {
    const requests = buildSearchRequests({ keywords: ['engineer'], locations: ['US'], workplaceType: ['remote'] });
    const tracker = new ScanTracker(requests, new Date().toISOString());
    const budget = createBudget({ maxResults: 1, maxJobsPerSearch: 1 });
    const key = requests[0].userData.searchId;
    tracker.searchPage(key, ['3812345678'], 1); tracker.cap(key);
    reserveJob(budget, key, '3812345678'); tracker.queueDetail(key, '3812345678');
    setBudget(budget); setScan(tracker);
    await page.setContent(detailHtml.replace('Build software with Python and SQL', 'While this is a remote position, occasional travel is required. Home or Hybrid employees need internet equipment.'));
    const saved: JobRecord[] = [];
    t.mock.method(Actor, 'pushData', async (row: JobRecord) => { saved.push(row); return { chargedCount: 1, eventChargeLimitReached: false }; });
    await router.getHandler('job-detail')(context(page, new Request({
      url: 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3812345678', label: 'job-detail',
      userData: { ...requests[0].userData, jobId: '3812345678' },
    })));
    assert.equal(saved.length, 1); assert.equal(saved[0].workplaceType, 'Remote');
    assert.equal(saved[0].workplaceEvidenceStatus, 'explicit');
    assert.match(saved[0].workplaceEvidence[0].text, /remote position/);
    assert.equal(tracker.finish(budget, new Date().toISOString()).boundedObservationComplete, true);
  } finally { await page.close(); }
});

test('workplace filters from complete search URLs survive detail requests and pagination unchanged', async () => {
  const page = await browser.newPage();
  try {
    const requests = buildSearchRequests({ searchUrls: ['https://www.linkedin.com/jobs/search/?keywords=engineer&location=US&f_WT=2,3'] });
    const budget = createBudget({ maxResults: 5, maxJobsPerSearch: 5 });
    setBudget(budget); setScan(new ScanTracker(requests, new Date().toISOString()));
    await page.setContent('<li><div class="base-card" data-entity-urn="urn:li:jobPosting:3812345678"><h3>Engineer</h3></div></li>');
    const added: Array<{ label: string; url: string; userData: { requestedWorkplaceTypes: string[] } }> = [];
    await router.getHandler('search')(context(page, new Request(requests[0]), {
      crawler: { async addRequests(items: typeof added) { added.push(...items); } },
    }));
    assert.equal(added.length, 2);
    assert.ok(added.every(request => JSON.stringify(request.userData.requestedWorkplaceTypes) === '["remote","hybrid"]'));
    assert.equal(new URL(added.find(request => request.label === 'search')!.url).searchParams.get('f_WT'), '2,3');
  } finally { await page.close(); }
});
