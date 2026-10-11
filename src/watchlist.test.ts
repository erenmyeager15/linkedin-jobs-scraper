import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInitialRequests, createBudget, reserveJob, reserveSave } from './lib.js';
import { ScanTracker } from './scan.js';
import {
  changeReportCsv, compareWatchlist, finishWatchlist, projectWatchlistRecord, readWatchlistState, resolveWatchlistOptions,
  type ChangeReport, type WatchlistScan, type WatchlistState, type WatchlistStorage,
} from './watchlist.js';
import type { JobRecord } from './types.js';

const input = { jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'], maxResults: 5, maxJobsPerSearch: 5, watchlistName: 'test-jobs' };
const options = resolveWatchlistOptions(input)!;
const day = (n: number, time = '12:00:00.000') => `2026-09-${String(n).padStart(2, '0')}T${time}Z`;

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobTitle: 'Software Engineer', companyName: 'Example Company', companyLinkedInUrl: null, companyLogoUrl: null,
    jobLocation: 'London, UK', country: 'GB', workplaceType: 'Hybrid', workplaceEvidenceStatus: 'explicit', workplaceEvidence: [], jobType: 'Full-time', experienceLevel: 'Mid-Senior level',
    postedDate: '2 days ago', postedAt: day(18), expiresAt: null, numberOfApplicants: 5,
    jobDescription: 'Build public software using Python and SQL.', jobDescriptionHtml: '<p>Build software</p>',
    responsibilities: null, qualifications: null, benefits: [], requiredSkills: ['Python', 'SQL'],
    salaryRange: 'GBP 80K - 100K / year', salaryMin: 80000, salaryMax: 100000, salaryCurrency: 'GBP', salaryPeriod: 'YEAR',
    jobFunctions: [], industries: [], jobUrl: 'https://www.linkedin.com/jobs/view/3812345678',
    applyUrl: 'https://careers.example/jobs/123?utm_source=linkedin', jobId: '3812345678', companySize: null, companyIndustry: null,
    easyApply: false, keywordUsed: 'Direct job URL', locationUsed: '', sourceSearchUrl: null, resultPosition: null,
    scrapedAt: day(20, '12:00:10.000'), ...overrides,
  };
}

function scan(records: JobRecord[] = [record()], scanDay = 20): WatchlistScan {
  return {
    options, runId: `run-${scanDay}`, startedAt: day(scanDay), now: day(scanDay, '12:01:00.000'), records,
    summary: { schemaVersion: 1, startedAt: day(scanDay), finishedAt: day(scanDay, '12:00:50.000'),
      jobsSaved: records.length, jobsCharged: records.length, stopReason: 'max-results',
      boundedObservationComplete: true, fullSearchCoverage: false, reasons: [], coverage: [] },
  };
}

function memoryStorage(initial: unknown = null) {
  const memory = { state: structuredClone(initial), writes: 0, assertions: 0, releases: 0, publishes: [] as ChangeReport[],
    busy: false, loseLockAt: 0, failPublishAt: 0, writeError: false, acceptThenThrow: false };
  const storage: WatchlistStorage = {
    async read() { return structuredClone(memory.state); },
    async acquireLock() { return memory.busy ? null : 'lease'; },
    async assertLock() { if (++memory.assertions === memory.loseLockAt) throw new Error('Lease lost'); },
    async releaseLock() { memory.releases += 1; },
    async write(state) {
      memory.writes += 1;
      if (memory.writeError) throw new Error('Write timeout');
      memory.state = structuredClone(state);
      if (memory.acceptThenThrow) throw new Error('Response lost after accepting write');
    },
    async publish(report) {
      memory.publishes.push(structuredClone(report));
      if (memory.publishes.length === memory.failPublishAt) throw new Error('Publish unavailable');
    },
  };
  return { memory, storage };
}

test('watchlist is optional, validated and never enabled by default', () => {
  assert.equal(resolveWatchlistOptions({}), null);
  assert.equal(resolveWatchlistOptions({ watchlistName: '' }), null);
  assert.equal(resolveWatchlistOptions({ ...input, watchlistName: '  TEST-JOBS ' })!.name, 'test-jobs');
  assert.throws(() => resolveWatchlistOptions({ ...input, watchlistName: '../outside' }), /watchlistName/);
  assert.throws(() => resolveWatchlistOptions({ ...input, watchlistRetentionDays: 91 }), /watchlistRetentionDays/);
  assert.throws(() => resolveWatchlistOptions({ ...input, watchlistMaxJobs: 1.5 }), /watchlistMaxJobs/);
});

test('scope ignores tracking/parameter order but isolates changed filters and result limits', () => {
  const first = resolveWatchlistOptions({ watchlistName: 'a', searchUrls: ['https://www.linkedin.com/jobs/search/?keywords=engineer&location=India&trk=one'] })!;
  const reordered = resolveWatchlistOptions({ watchlistName: 'a', searchUrls: ['https://www.linkedin.com/jobs/search/?location=India&keywords=engineer&trk=two'] })!;
  assert.equal(first.scopeId, reordered.scopeId);
  assert.notEqual(options.scopeId, resolveWatchlistOptions({ ...input, maxResults: 6 })!.scopeId);
  assert.notEqual(options.scopeId, resolveWatchlistOptions({ ...input, jobUrls: ['https://www.linkedin.com/jobs/view/3812345679'] })!.scopeId);
});

test('first successful bounded scan is a baseline, not a new-job claim', () => {
  const result = compareWatchlist(scan(), null);
  assert.equal(result.report.status, 'initialized');
  assert.equal(result.report.observations[0].status, 'baseline');
  assert.equal(result.report.counts.newlyObserved, 0);
  assert.equal(result.report.scan.fullSearchCoverage, false);
  assert.equal(result.state.revision, 1);
  assert.equal(readWatchlistState(result.state, options.scopeId)!.jobs.length, 1);
});

test('repeat ignores relative posting age, scrape time, skill ordering, case and application tracking', () => {
  const original = compareWatchlist(scan(), null).state;
  const repeated = record({ scrapedAt: day(21, '12:00:10.000'), postedAt: day(19), postedDate: '3 days ago',
    jobTitle: '  software   engineer ', requiredSkills: ['sql', 'python', 'SQL'], applyUrl: 'https://careers.example/jobs/123?utm_source=other' });
  const result = compareWatchlist(scan([repeated], 21), original);
  assert.equal(result.report.counts.unchanged, 1);
  assert.deepEqual(result.report.observations[0].changes, []);
  assert.equal(result.report.observations[0].firstSeenAt, record().scrapedAt);
});

test('known salary, location, skills and application changes carry previous/current values and times', () => {
  const previous = compareWatchlist(scan(), null).state;
  const changed = record({ salaryMin: 90000, jobLocation: 'Manchester, UK', requiredSkills: ['Python', 'SQL', 'AWS'],
    applyUrl: 'https://careers.example/jobs/456', scrapedAt: day(21, '12:00:10.000') });
  const result = compareWatchlist(scan([changed], 21), previous);
  assert.equal(result.report.counts.updated, 1);
  assert.deepEqual(result.report.observations[0].changes.map((item) => item.field), ['jobLocation', 'salaryMin', 'requiredSkills', 'applyUrl']);
  const salary = result.report.observations[0].changes.find((item) => item.field === 'salaryMin')!;
  assert.equal(salary.previous, 80000);
  assert.equal(salary.current, 90000);
  assert.equal(salary.previousObservedAt, record().scrapedAt);
  assert.equal(salary.observedAt, changed.scrapedAt);
  assert.equal(previous.jobs[0].values.salaryMin, 80000, 'comparison must not mutate its input state');
});

test('missing fields are unknown; enrichment is not falsely called a changed value', () => {
  const baseline = compareWatchlist(scan([record({ applyUrl: null })]), null).state;
  const enriched = compareWatchlist(scan([record({ scrapedAt: day(21, '12:00:10.000') })], 21), baseline);
  assert.equal(enriched.report.counts.updated, 0);
  assert.deepEqual(enriched.report.observations[0].newlyAvailableFields, ['applyUrl']);
  const missing = compareWatchlist(scan([record({ applyUrl: null, jobLocation: null, requiredSkills: [],
    scrapedAt: day(22, '12:00:10.000') })], 22), enriched.state);
  assert.equal(missing.report.counts.updated, 0);
  assert.ok(missing.report.observations[0].unavailableFields.includes('applyUrl'));
  assert.equal(missing.state.jobs[0].values.jobLocation, 'London, UK');
  const changed = compareWatchlist(scan([record({ jobLocation: 'Bristol, UK', scrapedAt: day(23, '12:00:10.000') })], 23), missing.state);
  assert.equal(changed.report.observations[0].changes[0].previousObservedAt, day(21, '12:00:10.000'));
});

test('salary amount comparisons require matching currency and period, and never mix unknown units', () => {
  const baseline = compareWatchlist(scan(), null).state;
  const unknown = compareWatchlist(scan([record({ salaryCurrency: null, salaryMin: 999999, scrapedAt: day(21, '12:00:10.000') })], 21), baseline);
  assert.equal(unknown.report.counts.updated, 0);
  assert.equal(unknown.state.jobs[0].values.salaryMin, 80000);
  const differentUnit = compareWatchlist(scan([record({ salaryPeriod: 'HOUR', salaryMin: 50, salaryMax: null,
    scrapedAt: day(22, '12:00:10.000') })], 22), unknown.state);
  assert.deepEqual(differentUnit.report.observations[0].changes.map((item) => item.field), ['salaryPeriod']);
  assert.deepEqual(differentUnit.report.observations[0].incomparableFields, ['salaryMin']);
  assert.equal(differentUnit.state.jobs[0].values.salaryMax, undefined, 'old annual maximum must not be retained as hourly');
});

test('ambiguous currency symbols and unknown pay periods cannot create salary change alerts', () => {
  const baseline = compareWatchlist(scan(), null).state;
  for (const units of [{ salaryCurrency: '$' }, { salaryCurrency: 'XYZ' }, { salaryPeriod: 'UNKNOWN' }]) {
    const result = compareWatchlist(scan([record({ ...units, salaryMin: 999999, scrapedAt: day(21, '12:00:10.000') })], 21), baseline);
    assert.equal(result.report.counts.updated, 0);
    assert.equal(result.state.jobs[0].values.salaryMin, 80000);
    assert.ok(result.report.observations[0].unavailableFields.includes('salaryCurrency'));
  }
  const symbolsOnly = compareWatchlist(scan([record({ salaryCurrency: '$' })]), null);
  assert.equal(symbolsOnly.state.jobs[0].values.salaryMin, undefined);
});

test('unseen jobs remain retained without closed, expired or removed events', () => {
  const second = record({ jobId: '3812345679' });
  const baseline = compareWatchlist(scan([record(), second]), null).state;
  const repeated = compareWatchlist(scan([record({ scrapedAt: day(21, '12:00:10.000') })], 21), baseline);
  assert.equal(repeated.state.jobs.length, 2);
  assert.equal(repeated.report.observations.length, 1);
  assert.equal(repeated.report.counts.updated, 0);
});

test('retention and capacity are bounded and eviction never masquerades as closure', () => {
  const baseline = compareWatchlist(scan(), null).state;
  const next = scan([record({ jobId: '3812345679', scrapedAt: day(23, '12:00:10.000') })], 23);
  next.options = { ...options, retentionDays: 1, maxStoredJobs: 1 };
  const result = compareWatchlist(next, baseline);
  assert.equal(result.state.jobs.length, 1);
  assert.equal(result.report.counts.evicted, 1);
  assert.equal(result.report.counts.newlyObserved, 1);
  assert.equal(result.report.observations[0].status, 'newly_observed');
  const largeBatch = scan([record(), record({ jobId: '3812345679' })]);
  largeBatch.options = { ...options, maxStoredJobs: 1 };
  assert.equal(compareWatchlist(largeBatch, null).report.counts.evicted, 1);
});

test('corrupt, duplicate and incompatible state is rejected rather than reset', () => {
  const baseline = compareWatchlist(scan(), null).state;
  assert.throws(() => readWatchlistState({ schemaVersion: 2 }, options.scopeId), /invalid/);
  assert.throws(() => readWatchlistState({ ...baseline, jobs: [baseline.jobs[0], baseline.jobs[0]] }, options.scopeId), /invalid/);
  assert.throws(() => readWatchlistState(baseline, 'a'.repeat(64)), /inputs or limits changed/);
  assert.throws(() => compareWatchlist(scan([record(), record()]), null), /duplicate/);
  const future = structuredClone(baseline);
  future.jobs[0].fieldObservedAt.jobLocation = day(25);
  assert.throws(() => readWatchlistState(future, options.scopeId), /invalid/);
  const malformedReport = structuredClone(baseline);
  malformedReport.lastReport.observations[0].jobUrl = 'https://unrelated.example/';
  assert.throws(() => readWatchlistState(malformedReport, options.scopeId), /invalid/);
});

test('large unmonitored descriptions are not retained in the watchlist projection', () => {
  const projected = projectWatchlistRecord(record({ jobDescription: 'x'.repeat(100000), requiredSkills: ['x'.repeat(4001)] }));
  assert.ok(projected.jobDescription!.length < 100);
  assert.deepEqual(projected.requiredSkills, []);
  assert.equal('jobDescriptionHtml' in projected, false);
});

test('reports are prepared before the locked state commit, then finalized', async () => {
  const { memory, storage } = memoryStorage();
  const report = await finishWatchlist(scan(), storage);
  assert.equal(report.status, 'initialized');
  assert.equal(memory.publishes[0].status, 'prepared');
  assert.equal(memory.publishes[0].baselineCommitted, false);
  assert.equal(memory.publishes[1].baselineCommitted, true);
  assert.equal(memory.writes, 1);
  assert.equal(memory.assertions, 2);
  assert.equal(memory.releases, 1);
});

test('failed, capped-with-unfinished-details and spending-limited batches never advance baseline', async () => {
  for (const reason of ['request-failed', 'unfinished-job-details', 'charge-limit']) {
    const { memory, storage } = memoryStorage();
    const incomplete = scan();
    incomplete.summary.boundedObservationComplete = false;
    incomplete.summary.reasons = [reason];
    const report = await finishWatchlist(incomplete, storage);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.baselineCommitted, false);
    assert.deepEqual(report.observations, []);
    assert.equal(memory.writes, 0);
  }
});

test('busy and lost leases never write a baseline', async () => {
  const busy = memoryStorage();
  busy.memory.busy = true;
  assert.equal((await finishWatchlist(scan(), busy.storage)).status, 'concurrent_run');
  assert.equal(busy.memory.writes, 0);
  const lost = memoryStorage();
  lost.memory.loseLockAt = 2;
  assert.equal((await finishWatchlist(scan(), lost.storage)).status, 'storage_error');
  assert.equal(lost.memory.writes, 0);
});

test('prepared report publication failure preserves the previous baseline', async () => {
  const { memory, storage } = memoryStorage();
  memory.failPublishAt = 1;
  const report = await finishWatchlist(scan(), storage);
  assert.equal(report.status, 'storage_error');
  assert.equal(memory.state, null);
  assert.equal(memory.writes, 0);
});

test('write timeout is explicitly ambiguous, including accepted writes with lost responses', async () => {
  for (const accepted of [false, true]) {
    const { memory, storage } = memoryStorage();
    memory.acceptThenThrow = accepted;
    memory.writeError = !accepted;
    const report = await finishWatchlist(scan(), storage);
    assert.equal(report.status, 'commit_unknown');
    assert.equal(report.baselineCommitted, false);
    assert.equal(memory.state !== null, accepted);
  }
});

test('same-run report replay does not write another baseline or charge any jobs', async () => {
  const { memory, storage } = memoryStorage();
  await finishWatchlist(scan(), storage);
  const report = await finishWatchlist({ ...scan(), records: [] }, storage);
  assert.equal(report.replayed, true);
  assert.equal(memory.writes, 1);
  assert.equal(report.counts.observed, 1);
});

test('out-of-order scans are rejected under the writer lease', async () => {
  const baseline = compareWatchlist(scan([record({ scrapedAt: day(21, '12:00:10.000') })], 21), null).state;
  const { memory, storage } = memoryStorage(baseline);
  assert.equal((await finishWatchlist(scan(), storage)).status, 'stale_scan');
  assert.equal(memory.writes, 0);
});

test('final report failure retains a recoverable committed summary', async () => {
  const { memory, storage } = memoryStorage();
  memory.failPublishAt = 2;
  const report = await finishWatchlist(scan(), storage);
  assert.equal(report.baselineCommitted, true);
  assert.match(report.reason!, /needs replay/);
  assert.equal((memory.state as WatchlistState).lastReport.status, 'initialized');
});

test('CSV has fixed columns, quoted values and formula-neutralized user-visible fields', () => {
  const report = compareWatchlist(scan([record({ jobTitle: '=HYPERLINK("evil")' })]), null).report;
  const csv = changeReportCsv(report);
  assert.match(csv, /reportStatus,baselineCommitted,jobId/);
  assert.match(csv, /"'=HYPERLINK\(""evil""\)"/);
  assert.match(csv, /"Example Company"/);
});

test('coverage separates a completed bounded cap from full-search exhaustion', () => {
  const requests = buildInitialRequests({ keywords: ['engineer'], locations: ['UK'] });
  const tracker = new ScanTracker(requests, day(20));
  const budget = createBudget({ maxResults: 1, maxJobsPerSearch: 1 });
  const key = requests[0].userData.searchId;
  tracker.searchPage(key, ['3812345678', '3812345679'], 2);
  reserveJob(budget, key, '3812345678');
  tracker.queueDetail(key, '3812345678');
  reserveSave(budget);
  tracker.saveDetail(key, '3812345678');
  tracker.cap(key);
  const summary = tracker.finish(budget, day(20, '12:01:00.000'));
  assert.equal(summary.boundedObservationComplete, true);
  assert.equal(summary.fullSearchCoverage, false);
  assert.equal(summary.coverage[0].status, 'capped');
});

test('initial empty search cannot initialize a watchlist and malformed cards cannot count as exhausted', () => {
  const requests = buildInitialRequests({ keywords: ['engineer'], locations: ['UK'] });
  const key = requests[0].userData.searchId;
  for (const count of [0, 2]) {
    const tracker = new ScanTracker(requests, day(20));
    tracker.searchPage(key, [], count);
    const summary = tracker.finish(createBudget({ maxResults: 5, maxJobsPerSearch: 5 }), day(20, '12:01:00.000'));
    assert.equal(summary.boundedObservationComplete, false);
    assert.equal(summary.coverage[0].status, count ? 'failed' : 'unverified_empty');
  }
});

test('exhaustion after real cards is distinguished from unfinished or failed detail work', () => {
  const requests = buildInitialRequests({ keywords: ['engineer'], locations: ['UK'] });
  const key = requests[0].userData.searchId;
  const tracker = new ScanTracker(requests, day(20));
  const budget = createBudget({ maxResults: 5, maxJobsPerSearch: 5 });
  tracker.searchPage(key, ['3812345678'], 1);
  tracker.queueDetail(key, '3812345678');
  tracker.searchPage(key, [], 0);
  assert.equal(tracker.finish(budget, day(20, '12:01:00.000')).boundedObservationComplete, false);
  reserveSave(budget);
  tracker.saveDetail(key, '3812345678');
  assert.equal(tracker.finish(budget, day(20, '12:01:00.000')).fullSearchCoverage, true);
  tracker.fail(key);
  assert.equal(tracker.finish(budget, day(20, '12:01:00.000')).boundedObservationComplete, false);
});

test('an unrecognized error body after real cards is not verified exhaustion', () => {
  const requests = buildInitialRequests({ keywords: ['engineer'], locations: ['UK'] });
  const key = requests[0].userData.searchId;
  const tracker = new ScanTracker(requests, day(20));
  tracker.searchPage(key, ['3812345678'], 1);
  tracker.searchPage(key, [], 0, false);
  assert.equal(tracker.finish(createBudget({ maxResults: 5, maxJobsPerSearch: 5 }), day(20, '12:01:00.000')).coverage[0].status, 'unverified_empty');
});
