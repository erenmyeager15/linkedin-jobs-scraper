import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDetailUrl,
  buildDirectJobRequests,
  buildInitialRequests,
  buildSearchRequests,
  buildSearchUrl,
  canonicalJobUrl,
  canSaveMore,
  createBudget,
  detailAllowance,
  detailOrCard,
  hasUsableJobData,
  inferSkills,
  extractLinkedInJobId,
  isBlockedStatus,
  isBlockedUrl,
  isFinished,
  looksBlockedText,
  maxRequestsForRun,
  normalizeLinkedInSearchUrl,
  normalizePostedAt,
  parseSalaryRange,
  registerCharge,
  releaseEnqueued,
  releaseSave,
  reserveJob,
  reserveSave,
  resolveLimits,
  searchKey,
  validateInputModes,
  wasPushedRecordSaved,
} from './lib.js';
import type { ActorInput } from './types.js';

const baseInput: ActorInput = {
  keywords: ['software engineer'],
  locations: ['London, UK'],
};

test('limit defaults match the published input schema', () => {
  const limits = resolveLimits({});
  assert.equal(limits.maxResults, 5);
  assert.equal(limits.maxJobsPerSearch, 5);
});

test('limits are clamped and a per-search cap never exceeds the total cap', () => {
  assert.equal(resolveLimits({ maxResults: 99999 }).maxResults, 5000);
  assert.equal(resolveLimits({ maxResults: 0 }).maxResults, 1);
  assert.equal(resolveLimits({ maxResults: 10, maxJobsPerSearch: 500 }).maxJobsPerSearch, 10);
});

test('search URL targets the guest endpoint and maps every filter code', () => {
  const url = new URL(
    buildSearchUrl(
      {
        workplaceType: ['remote'],
        jobType: ['full-time'],
        experienceLevel: ['mid-senior'],
        datePosted: 'past-week',
        easyApplyOnly: true,
        sortBy: 'recent',
        minimumSalary: '80000',
      },
      'data engineer',
      'Berlin',
      20,
    ),
  );

  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  assert.equal(url.searchParams.get('keywords'), 'data engineer');
  assert.equal(url.searchParams.get('location'), 'Berlin');
  assert.equal(url.searchParams.get('start'), '20');
  assert.equal(url.searchParams.get('f_WT'), '2');
  assert.equal(url.searchParams.get('f_JT'), 'F');
  assert.equal(url.searchParams.get('f_E'), '4');
  assert.equal(url.searchParams.get('f_TPR'), 'r604800');
  assert.equal(url.searchParams.get('f_AL'), 'true');
  assert.equal(url.searchParams.get('sortBy'), 'DD');
  assert.equal(url.searchParams.get('f_SB2'), '3');
});

test('unknown filter values are dropped instead of sent as empty parameters', () => {
  // API callers can bypass the schema enum, so the runtime guard still matters.
  const workplaceType = ['telepathic'] as unknown as ActorInput['workplaceType'];
  const url = new URL(buildSearchUrl({ workplaceType }, 'qa', 'Paris', 0));
  assert.equal(url.searchParams.has('f_WT'), false);
});

test('one search request is built per unique keyword and location pair', () => {
  const requests = buildSearchRequests({ ...baseInput, keywords: ['a', 'b'], locations: ['x', 'y'] });

  assert.equal(requests.length, 4);
  assert.deepEqual(
    requests.map((request) => request.userData.start),
    [0, 0, 0, 0],
  );
});

test('no keyword or location combination is silently dropped by a small maxResults', () => {
  const requests = buildSearchRequests({
    ...baseInput,
    keywords: ['a', 'b', 'c'],
    locations: ['x', 'y', 'z'],
    maxResults: 2,
  });

  assert.equal(requests.length, 9);
});

test('duplicate keyword and location pairs are collapsed', () => {
  const requests = buildSearchRequests({ ...baseInput, keywords: ['a', 'a'], locations: ['x', 'x'] });
  assert.equal(requests.length, 1);
});

test('the crawl request limit covers real offset paging', () => {
  // 500 jobs in one search needs ~50 guest pages, far more than a flat allowance.
  const limit = maxRequestsForRun({ maxResults: 500, maxJobsPerSearch: 500 }, 1);
  assert.ok(limit >= 500 + 50, `expected room for paging, got ${limit}`);
});

test('detail URL uses the guest job posting endpoint', () => {
  assert.equal(
    buildDetailUrl('3812345678'),
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3812345678',
  );
});

test('full LinkedIn search URLs preserve filters and become guest API requests', () => {
  const normalized = normalizeLinkedInSearchUrl(
    'https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=India&f_WT=2&f_TPR=r86400&trk=public_jobs',
  );
  const url = new URL(normalized.url);

  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  assert.equal(url.searchParams.get('keywords'), 'software engineer');
  assert.equal(url.searchParams.get('location'), 'India');
  assert.equal(url.searchParams.get('f_WT'), '2');
  assert.equal(url.searchParams.get('f_TPR'), 'r86400');
  assert.equal(url.searchParams.get('start'), '0');
  assert.equal(normalized.sourceSearchUrl.includes('trk='), false);
});

test('direct LinkedIn job URLs are validated, deduplicated, and canonicalized', () => {
  const id = extractLinkedInJobId(
    'https://www.linkedin.com/jobs/view/senior-engineer-3812345678/?trackingId=x',
  );
  assert.equal(id, '3812345678');
  assert.equal(canonicalJobUrl(id), 'https://www.linkedin.com/jobs/view/3812345678');

  const requests = buildDirectJobRequests({
    jobUrls: [
      'https://www.linkedin.com/jobs/view/senior-engineer-3812345678/',
      'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3812345678',
    ],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].label, 'job-detail');
  assert.equal(requests[0].userData.jobId, '3812345678');
});

test('keyword, search URL, and direct URL modes can be combined', () => {
  const requests = buildInitialRequests({
    keywords: ['software engineer'],
    locations: ['India'],
    searchUrls: ['https://www.linkedin.com/jobs/search/?keywords=data%20engineer&location=India'],
    jobUrls: ['https://www.linkedin.com/jobs/view/3812345678'],
  });

  assert.equal(requests.filter((request) => request.label === 'search').length, 2);
  assert.equal(requests.filter((request) => request.label === 'job-detail').length, 1);
});

test('input requires one complete search or direct URL mode', () => {
  assert.throws(() => validateInputModes({ keywords: ['engineer'] }), /both keywords and locations/);
  assert.throws(() => validateInputModes({}), /Provide keywords/);
  assert.doesNotThrow(() => validateInputModes({
    searchUrls: ['https://www.linkedin.com/jobs/search/?keywords=engineer'],
  }));
  assert.throws(
    () => normalizeLinkedInSearchUrl('https://linkedin.example/jobs/search/?keywords=engineer'),
    /linkedin\.com/,
  );
});

test('allowance is bounded by both the per-search cap and the total budget', () => {
  const budget = createBudget({ maxResults: 12, maxJobsPerSearch: 5 });
  const key = searchKey('dev', 'London');

  assert.equal(detailAllowance(budget, key), 5);

  for (let index = 0; index < 5; index += 1) {
    assert.equal(reserveJob(budget, key, `london-${index}`), true);
  }
  assert.equal(detailAllowance(budget, key), 0);
  assert.equal(reserveJob(budget, key, 'london-overflow'), false);

  const otherKey = searchKey('dev', 'Berlin');
  assert.equal(detailAllowance(budget, otherKey), 5);

  for (let index = 0; index < 5; index += 1) {
    reserveJob(budget, otherKey, `berlin-${index}`);
  }
  // 10 of 12 reserved, so the last search may only queue the remaining 2.
  assert.equal(detailAllowance(budget, searchKey('dev', 'Paris')), 2);
});

test('a job id seen in one search never costs budget again in another', () => {
  const budget = createBudget({ maxResults: 10, maxJobsPerSearch: 10 });
  const london = searchKey('dev', 'London');
  const reading = searchKey('dev', 'Reading');

  assert.equal(reserveJob(budget, london, 'job-1'), true);
  assert.equal(reserveJob(budget, reading, 'job-1'), false);
  assert.equal(budget.enqueued, 1);
});

test('a queued job that cannot become a record returns its slot', () => {
  const budget = createBudget({ maxResults: 3, maxJobsPerSearch: 3 });
  const key = searchKey('dev', 'London');

  reserveJob(budget, key, 'job-1');
  reserveJob(budget, key, 'job-2');
  reserveJob(budget, key, 'job-3');
  assert.equal(detailAllowance(budget, key), 0);

  releaseEnqueued(budget, key);
  assert.equal(detailAllowance(budget, key), 1);
});

test('reaching maxResults ends the run', () => {
  const budget = createBudget({ maxResults: 2, maxJobsPerSearch: 2 });

  assert.equal(reserveSave(budget), true);
  assert.equal(canSaveMore(budget), true);

  assert.equal(reserveSave(budget), true);
  assert.equal(isFinished(budget), true);
  assert.equal(budget.stopReason, 'max-results');
  assert.equal(detailAllowance(budget, searchKey('dev', 'London')), 0);
});

test('concurrent workers cannot overshoot maxResults', () => {
  const budget = createBudget({ maxResults: 2, maxJobsPerSearch: 5 });

  // Five workers race for two remaining slots; only two may proceed.
  const granted = [0, 1, 2, 3, 4].filter(() => reserveSave(budget));

  assert.equal(granted.length, 2);
  assert.equal(budget.pushed, 2);
});

test('a failed save returns its reserved slot', () => {
  const budget = createBudget({ maxResults: 1, maxJobsPerSearch: 1 });

  assert.equal(reserveSave(budget), true);
  assert.equal(canSaveMore(budget), false);

  releaseSave(budget);
  assert.equal(budget.pushed, 0);
  assert.equal(budget.stopReason, null);
  assert.equal(canSaveMore(budget), true);
});

test('a reached spending limit stops the run immediately', () => {
  const budget = createBudget({ maxResults: 100, maxJobsPerSearch: 100 });

  registerCharge(budget, 1, false);
  assert.equal(canSaveMore(budget), true);

  registerCharge(budget, 1, true);
  assert.equal(budget.stopReason, 'charge-limit');
  assert.equal(canSaveMore(budget), false);
  // No further save may be reserved once the spending limit is reached.
  assert.equal(reserveSave(budget), false);
});

test('only successful charges increment the charged count', () => {
  const budget = createBudget({ maxResults: 10, maxJobsPerSearch: 10 });

  registerCharge(budget, 0, false);
  assert.equal(budget.charged, 0);

  registerCharge(budget, 1, false);
  assert.equal(budget.charged, 1);
});

test('detail values win while search-card values fill missing fields', () => {
  assert.equal(detailOrCard('detail', 'card'), 'detail');
  assert.equal(detailOrCard(null, 'card'), 'card');
  assert.equal(detailOrCard(undefined, 'card'), 'card');
  assert.equal(detailOrCard(null, null), null);
});

test('block markers stay narrow enough to avoid discarding real listings', () => {
  // Ordinary guest-page sign-in prompts must not be treated as a block.
  assert.equal(looksBlockedText('Sign in to view more jobs like this'), false);
  assert.equal(looksBlockedText('Join LinkedIn to see who you know'), false);

  assert.equal(looksBlockedText('Please complete this security verification'), true);
  assert.equal(looksBlockedText('Redirected to the authwall'), true);
  assert.equal(looksBlockedText(null), false);
});

test('authwall and challenge responses are recognised', () => {
  assert.equal(isBlockedUrl('https://www.linkedin.com/authwall?trk=x'), true);
  assert.equal(isBlockedUrl('https://www.linkedin.com/uas/login'), true);
  assert.equal(isBlockedUrl('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1'), false);

  for (const status of [999, 403, 429, 500, 503]) {
    assert.equal(isBlockedStatus(status), true, `${status} should count as blocked`);
  }
  for (const status of [200, 404, undefined, null]) {
    assert.equal(isBlockedStatus(status), false, `${String(status)} should not count as blocked`);
  }
});

test('a job is only billable when it has a title plus company or description', () => {
  assert.equal(
    hasUsableJobData({ jobTitle: 'Engineer', companyName: 'Acme', jobDescription: null }),
    true,
  );
  assert.equal(
    hasUsableJobData({ jobTitle: 'Engineer', companyName: null, jobDescription: 'Build things' }),
    true,
  );
  assert.equal(hasUsableJobData({ jobTitle: 'Engineer', companyName: null, jobDescription: null }), false);
  assert.equal(hasUsableJobData({ jobTitle: null, companyName: 'Acme', jobDescription: 'x' }), false);
});

test('skill inference matches whole tokens only', () => {
  const skills = inferSkills('We use JavaScript, Node.js, C++ and .NET on AWS.');

  assert.ok(skills.includes('JavaScript'));
  assert.ok(skills.includes('Node.js'));
  assert.ok(skills.includes('C++'));
  assert.ok(skills.includes('.NET'));
  assert.ok(skills.includes('AWS'));
  // "Java" must not be reported just because "JavaScript" appears.
  assert.equal(skills.includes('Java'), false);
});

test('skill inference returns nothing without a description', () => {
  assert.deepEqual(inferSkills(null), []);
  assert.deepEqual(inferSkills('We value teamwork and clear writing.'), []);
});

test('salary ranges are normalized without guessing missing bounds', () => {
  assert.deepEqual(parseSalaryRange('$120,000 - $180,000 / year'), {
    salaryMin: 120000,
    salaryMax: 180000,
    salaryCurrency: '$',
    salaryPeriod: 'YEAR',
  });
  assert.deepEqual(parseSalaryRange('EUR 80K+ per annum'), {
    salaryMin: 80000,
    salaryMax: null,
    salaryCurrency: 'EUR',
    salaryPeriod: 'YEAR',
  });
});

test('posting dates normalize ISO and relative values', () => {
  const now = new Date('2026-08-23T12:00:00.000Z');
  assert.equal(normalizePostedAt('2026-08-20', now), '2026-08-20T00:00:00.000Z');
  assert.equal(normalizePostedAt('Posted 2 days ago', now), '2026-08-21T12:00:00.000Z');
});

test('atomic push results distinguish a saved record from a rejected charge', () => {
  assert.equal(wasPushedRecordSaved({ chargedCount: 1, eventChargeLimitReached: true }), true);
  assert.equal(wasPushedRecordSaved({ chargedCount: 0, eventChargeLimitReached: true }), false);
  assert.equal(wasPushedRecordSaved({ chargedCount: 0, eventChargeLimitReached: false }), true);
});
