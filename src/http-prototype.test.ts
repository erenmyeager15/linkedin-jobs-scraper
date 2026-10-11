import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Actor } from 'apify';
import { Request, type PlaywrightCrawlingContext } from 'crawlee';
import { chromium, type Browser } from 'playwright';
import { buildSearchRequests, createBudget, reserveJob } from './lib.js';
import { staticHtmlPage, MAX_STATIC_HTML_BYTES } from './html-page.js';
import { extractLinkedInDom } from './extractors.js';
import { nextDiscovery, titleDiscovery, titleSupportsWorkplace } from './discovery.js';
import { router } from './routes.js';
import { ScanTracker } from './scan.js';
import { setBudget, setScan } from './state.js';
import type { JobRecord } from './types.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const pageUrl = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3812345678';
const quiet = { info() {}, warning() {}, error() {}, debug() {} };
const html = `<html><body><h1>Software Engineer - Remote</h1>
  <a class="topcard__org-name-link" href="/company/example?trk=abc">Example</a>
  <span class="topcard__flavor--bullet">London, UK</span>
  <div class="show-more-less-html__markup"><p>This is a remote position.</p><h3>Responsibilities</h3><ul><li>Build Python and SQL services.</li></ul></div>
  <a href="https://careers.example/job/42">Apply now</a>
  <script>const unusedBoilerplate = 'captcha authwall';</script><div hidden>Security verification</div>
  <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Software Engineer - Remote',
    jobLocationType: 'TELECOMMUTE', datePosted: '2026-09-20', baseSalary: { currency: 'GBP', value: { minValue: 80000, maxValue: 100000, unitText: 'YEAR' } } })}</script>
</body></html>`;

test('browser and browser-free parsers preserve identical public detail fields and source evidence', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const arguments_ = { kind: 'detail' as const, pageUrl, blockMarkers: ['authwall', 'captcha', 'security verification'] };
    const browserResult = await page.evaluate(extractLinkedInDom, arguments_);
    const staticResult = await staticHtmlPage(html, pageUrl).evaluate(extractLinkedInDom, arguments_);
    assert.deepEqual(staticResult, browserResult);
    assert.equal(staticResult.blocked, false);
    assert.equal(staticResult.companyLinkedInUrl, 'https://www.linkedin.com/company/example');
  } finally { await page.close(); }
});

test('HTML fragments, entity decoding and relative search links agree across both parsers', async () => {
  const fragment = '<li><div class="base-card" data-entity-urn="urn:li:jobPosting:3812345678"><h3>Software Engineer &amp; Remote</h3><h4 class="base-search-card__subtitle"><a href="/company/example">Example</a></h4><a class="base-card__full-link" href="/jobs/view/3812345678">View</a></div></li>';
  const page = await browser.newPage();
  try {
    await page.setContent(fragment);
    const arguments_ = { kind: 'search' as const, pageUrl, blockMarkers: ['captcha'] };
    assert.deepEqual(await staticHtmlPage(fragment, pageUrl).evaluate(extractLinkedInDom, arguments_), await page.evaluate(extractLinkedInDom, arguments_));
  } finally { await page.close(); }
});

test('real-source nonbreaking-space encodings normalize without changing HTML content', async () => {
  const source = '<html><body><h1>Engineer</h1><div class="show-more-less-html__markup"><p>Java / Kafka / Postgres&nbsp;</p><p>AWS cloud&#160;</p></div></body></html>';
  const page = await browser.newPage();
  try {
    await page.setContent(source);
    const arguments_ = { kind: 'detail' as const, pageUrl, blockMarkers: [] };
    const browserResult = await page.evaluate(extractLinkedInDom, arguments_);
    const staticResult = await staticHtmlPage(source, pageUrl).evaluate(extractLinkedInDom, arguments_);
    assert.deepEqual(staticResult, browserResult);
    assert.match(staticResult.jobDescriptionHtml!, /Postgres&nbsp;/);
    assert.match(staticResult.jobDescription!, /Java \/ Kafka \/ Postgres/);
  } finally { await page.close(); }
});

test('structured-only description fragments keep their text in both parsers without executing scripts', async () => {
  const structured = JSON.stringify({ '@type': 'JobPosting',
    title: 'Remote Engineer', hiringOrganization: { name: 'Example' }, jobLocationType: 'TELECOMMUTE',
    description: '<p>This is a remote position.</p><p>Build Python services.</p><script>secret boilerplate</script>',
  }).replace(/</g, '\\u003c');
  const source = `<html><body><script type="application/ld+json">${structured}</script></body></html>`;
  const page = await browser.newPage();
  try {
    await page.setContent(source);
    const arguments_ = { kind: 'detail' as const, pageUrl, blockMarkers: [] };
    const browserResult = await page.evaluate(extractLinkedInDom, arguments_);
    const staticResult = await staticHtmlPage(source, pageUrl).evaluate(extractLinkedInDom, arguments_);
    assert.deepEqual(staticResult, browserResult);
    assert.match(staticResult.jobDescription!, /This is a remote position/);
    assert.match(staticResult.jobDescription!, /Build Python services/);
    assert.doesNotMatch(staticResult.jobDescription!, /secret boilerplate/);
  } finally { await page.close(); }
});

test('static DOM never executes scripts, rejects arbitrary evaluate calls and bounds memory input', async () => {
  const page = staticHtmlPage('<script>throw new Error("executed")</script><h1>Job</h1>', pageUrl);
  const result = await page.evaluate(extractLinkedInDom, { kind: 'detail' as const, pageUrl, blockMarkers: [] });
  assert.equal(result.kind, 'detail');
  await assert.rejects(() => page.evaluate(() => 1), /only the shared/);
  assert.throws(() => staticHtmlPage('x'.repeat(MAX_STATIC_HTML_BYTES + 1), pageUrl), /parsing limit/);
  assert.throws(() => staticHtmlPage('<h1>Job</h1>', 'file:///private'), /HTTP/);
});

test('title strategy is bounded, requires workplace evidence and cannot become an endless paging loop', () => {
  assert.throws(() => titleDiscovery(0), /1-50/);
  assert.throws(() => titleDiscovery(51), /1-50/);
  const first = titleDiscovery(2);
  assert.equal(nextDiscovery(first)?.pageNumber, 2);
  assert.equal(nextDiscovery(nextDiscovery(first)!), null);
  assert.equal(titleSupportsWorkplace({ jobTitle: 'Engineer', jobLocation: 'US' }, ['remote']), false);
  assert.equal(titleSupportsWorkplace({ jobTitle: 'Remote Sensing Engineer', jobLocation: 'US' }, ['remote']), false);
  assert.equal(titleSupportsWorkplace({ jobTitle: 'Software Engineer - Remote Eligible', jobLocation: 'US' }, ['remote']), false);
  assert.equal(titleSupportsWorkplace({ jobTitle: 'Software Engineer - Remote', jobLocation: 'US' }, ['remote']), true);
});

test('title discovery skips unsupported card titles before spending detail budget and stops at its page cap', async () => {
  const initial = buildSearchRequests({ keywords: ['engineer'], locations: ['US'], workplaceType: ['remote'] });
  const tracker = new ScanTracker(initial, new Date().toISOString());
  const budget = createBudget({ maxResults: 25, maxJobsPerSearch: 25 });
  setBudget(budget); setScan(tracker);
  const request = new Request({ ...initial[0], userData: { ...initial[0].userData, titleDiscovery: titleDiscovery(1) } });
  const fragment = `<ul>${['Engineer', 'Software Engineer - Remote', 'Remote Sensing Engineer'].map((title, i) =>
    `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${3812345678 + i}"><h3>${title}</h3></div></li>`).join('')}</ul>`;
  const queued: Array<{ label: string }> = [];
  await router.getHandler('search')({ page: staticHtmlPage(fragment, request.url), request, response: { status: () => 200 },
    session: { retire() {} }, log: quiet, crawler: { async addRequests(items: typeof queued) { queued.push(...items); } },
  } as unknown as PlaywrightCrawlingContext);
  assert.equal(queued.length, 1); assert.equal(queued[0].label, 'job-detail');
  assert.equal(budget.enqueued, 1);
  const summary = tracker.finish(budget, new Date().toISOString());
  assert.equal(summary.coverage[0].titlesSkipped, 2);
  assert.equal(summary.coverage[0].discoveryStrategy, 'title-supported-workplace');
  assert.equal(summary.coverage[0].status, 'capped');
  assert.equal(summary.fullSearchCoverage, false);
});

test('an empty experimental discovery page still discloses its narrower scope', async () => {
  const initial = buildSearchRequests({ keywords: ['engineer'], locations: ['US'], workplaceType: ['remote'] });
  const tracker = new ScanTracker(initial, new Date().toISOString());
  setBudget(createBudget({ maxResults: 25, maxJobsPerSearch: 25 })); setScan(tracker);
  const request = new Request({ ...initial[0], userData: { ...initial[0].userData, titleDiscovery: titleDiscovery(2) } });
  await router.getHandler('search')({ page: staticHtmlPage('', request.url), request,
    response: { status: () => 200 }, session: { retire() {} }, log: quiet,
    crawler: { async addRequests() { throw new Error('An empty page must not schedule more discovery.'); } },
  } as unknown as PlaywrightCrawlingContext);
  const summary = tracker.finish(createBudget({ maxResults: 25, maxJobsPerSearch: 25 }), new Date().toISOString());
  assert.equal(summary.coverage[0].discoveryStrategy, 'title-supported-workplace');
  assert.equal(summary.coverage[0].discoveryPageLimit, 2);
  assert.equal(summary.fullSearchCoverage, false);
  assert.equal(summary.boundedObservationComplete, false);
});

test('a remote search-card title does not bypass contradictory hybrid evidence in the actual detail', async (t) => {
  const initial = buildSearchRequests({ keywords: ['engineer'], locations: ['US'], workplaceType: ['remote'] });
  const tracker = new ScanTracker(initial, new Date().toISOString());
  const budget = createBudget({ maxResults: 25, maxJobsPerSearch: 25 });
  const key = initial[0].userData.searchId;
  tracker.searchPage(key, ['3812345678'], 1); tracker.cap(key);
  reserveJob(budget, key, '3812345678'); tracker.queueDetail(key, '3812345678');
  setBudget(budget); setScan(tracker);
  const changed = html.replace('This is a remote position.', 'This role is categorized as hybrid.');
  let pushes = 0;
  t.mock.method(Actor, 'pushData', async () => { pushes += 1; return { chargedCount: 1, eventChargeLimitReached: false }; });
  const request = new Request({ url: pageUrl, label: 'job-detail', userData: { ...initial[0].userData, jobId: '3812345678' } });
  await router.getHandler('job-detail')({ page: staticHtmlPage(changed, pageUrl), request, response: { status: () => 200 },
    session: { retire() {} }, log: quiet, crawler: { stop() {} },
  } as unknown as PlaywrightCrawlingContext);
  assert.equal(pushes, 0); assert.equal(tracker.finish(budget, new Date().toISOString()).boundedObservationComplete, false);
});

test('browser-free detail writes use the same atomic charge/monitoring guards', async (t) => {
  const initial = buildSearchRequests({ keywords: ['engineer'], locations: ['US'], workplaceType: ['remote'] });
  const tracker = new ScanTracker(initial, new Date().toISOString());
  const budget = createBudget({ maxResults: 1, maxJobsPerSearch: 1 });
  const key = initial[0].userData.searchId;
  tracker.searchPage(key, ['3812345678'], 1); tracker.cap(key);
  reserveJob(budget, key, '3812345678'); tracker.queueDetail(key, '3812345678');
  setBudget(budget); const observed: JobRecord[] = []; setScan(tracker, row => observed.push(row));
  t.mock.method(Actor, 'pushData', async () => ({ chargedCount: 0, eventChargeLimitReached: true }));
  await router.getHandler('job-detail')({ page: staticHtmlPage(html, pageUrl),
    request: new Request({ url: pageUrl, label: 'job-detail', userData: { ...initial[0].userData, jobId: '3812345678' } }),
    response: { status: () => 200 }, session: { retire() {} }, log: quiet, crawler: { stop() {} },
  } as unknown as PlaywrightCrawlingContext);
  assert.equal(observed.length, 0); assert.equal(budget.pushed, 0); assert.equal(budget.charged, 0);
  assert.equal(tracker.finish(budget, new Date().toISOString()).boundedObservationComplete, false);
});
