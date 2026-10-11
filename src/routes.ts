import { Router, type PlaywrightCrawlingContext } from 'crawlee';
import { Actor } from 'apify';
import {
  BLOCK_TEXT_MARKERS,
  buildDetailUrl,
  canonicalJobUrl,
  canSaveMore,
  detailAllowance,
  detailOrCard,
  hasUsableJobData,
  inferSkills,
  isBlockedStatus,
  isBlockedUrl,
  isFinished,
  mergeUniqueStrings,
  normalizePostedAt,
  parseSalaryRange,
  registerCharge,
  releaseEnqueued,
  releaseSave,
  reserveJob,
  reserveSave,
  searchKey,
  wasPushedRecordSaved,
  type SearchUserData,
} from './lib.js';
import { getBudget, getScan, observeSavedJob } from './state.js';
import type { JobRecord } from './types.js';
import { extractLinkedInDom } from './extractors.js';
import { matchesWorkplace, resolveWorkplace, type WorkplaceType } from './workplace.js';
import { nextDiscovery, titleSupportsWorkplace, validateDiscovery } from './discovery.js';

export const router = Router.create<PlaywrightCrawlingContext>();

router.addHandler('search', async ({ page, request, response, session, log, crawler }) => {
  const {
    keyword,
    location,
    start,
    searchId,
    sourceSearchUrl,
    requestedWorkplaceTypes = [],
    titleDiscovery,
  } = request.userData as SearchUserData;
  const budget = getBudget();
  const key = searchId ?? searchKey(keyword, location);
  if (titleDiscovery) validateDiscovery(titleDiscovery, requestedWorkplaceTypes);

  if (isFinished(budget)) {
    getScan().cap(key);
    log.info('Result budget reached; skipping remaining search pages.');
    return;
  }

  const status = response?.status();
  if (isBlockedStatus(status)) {
    session?.retire();
    throw new Error(`LinkedIn returned HTTP ${status} for the guest job search.`);
  }
  if (status && status >= 400) throw new Error(`LinkedIn returned HTTP ${status} for the guest job search.`);

  const allowance = detailAllowance(budget, key);
  if (allowance <= 0) {
    getScan().cap(key);
    log.info(`Per-search limit reached for "${keyword}" in "${location}".`);
    return;
  }

  log.info(`Search: "${keyword}" in "${location}" — start ${start}, allowance ${allowance}`);

  // The guest endpoint returns a fragment of <li> job cards.
  const scan = await page.evaluate(extractLinkedInDom, { kind: 'search' as const, pageUrl: request.url, blockMarkers: BLOCK_TEXT_MARKERS });
  if (scan.kind !== 'search') throw new Error('Unexpected DOM extraction kind.');

  // Blocking is checked before anything else is trusted, so a wall can never be
  // mistaken for an exhausted search.
  if (scan.blocked || isBlockedUrl(page.url())) {
    session?.retire();
    throw new Error('LinkedIn blocked the guest job search (authwall or verification).');
  }

  getScan().searchPage(key, scan.results.map((job) => job.jobId), scan.cardCount, scan.emptyRecognized);
  if (titleDiscovery) getScan().titleDiscovery(key, titleDiscovery.maxSearchPages, 0);

  if (scan.results.length === 0) {
    log.info('No usable job cards returned; see RUN-SUMMARY for verified coverage.');
    return;
  }

  log.info(`Scraped ${scan.results.length} job cards (start ${start})`);

  // Reserve a budget slot per job id. Ids already queued in this run are skipped, so
  // overlapping searches never consume the budget twice for one job.
  const positioned = scan.results.map((job, index) => ({
    ...job,
    resultPosition: start + index + 1,
  }));
  const candidates = titleDiscovery ? positioned.filter(job => titleSupportsWorkplace(job, requestedWorkplaceTypes)) : positioned;
  if (titleDiscovery) getScan().titleDiscovery(key, titleDiscovery.maxSearchPages, positioned.length - candidates.length);
  const unique = candidates.filter((job) => reserveJob(budget, key, job.jobId));
  unique.forEach((job) => getScan().queueDetail(key, job.jobId));

  if (unique.length > 0) {
    await crawler.addRequests(
      unique.map((job) => ({
        url: buildDetailUrl(job.jobId),
        label: 'job-detail',
        uniqueKey: `detail-${job.jobId}`,
        userData: {
          ...job,
          jobUrl: job.jobUrl ?? canonicalJobUrl(job.jobId),
          keyword,
          location,
          searchId: key,
          sourceSearchUrl,
          requestedWorkplaceTypes,
        },
      })),
    );
  }

  log.info(`Enqueued ${unique.length} detail pages`, {
    queuedTotal: budget.enqueued,
    maxResults: budget.maxResults,
  });

  // Paginate by the offset LinkedIn actually served, so cards missing an id cannot
  // shift the window and silently skip jobs.
  const step = Math.max(scan.cardCount, scan.results.length);
  const nextDiscoveryPage = titleDiscovery ? nextDiscovery(titleDiscovery) : undefined;
  if (step > 0 && detailAllowance(budget, key) > 0 && nextDiscoveryPage !== null) {
    const nextStart = start + step;
    const nextUrl = new URL(request.url);
    nextUrl.searchParams.set('start', String(nextStart));
    await crawler.addRequests([{
      url: nextUrl.toString(),
      label: 'search',
      uniqueKey: `search-${key}-${nextStart}`,
      userData: {
        keyword,
        location,
        start: nextStart,
        searchId: key,
        sourceSearchUrl,
        requestedWorkplaceTypes,
        ...(nextDiscoveryPage ? { titleDiscovery: nextDiscoveryPage } : {}),
      } satisfies SearchUserData,
    }]);
  } else if (step > 0) {
    getScan().cap(key);
  }
});

router.addHandler('job-detail', async ({ page, request, response, session, log, crawler }) => {
  const card = request.userData as Record<string, unknown>;
  const {
    jobId,
    keyword,
    location,
    searchId,
  } = card;
  const budget = getBudget();
  const key = (searchId as string | undefined)
    ?? searchKey(keyword as string, location as string);

  if (!canSaveMore(budget)) {
    getScan().cap(key);
    log.info('Result budget reached; skipping job detail.');
    return;
  }

  const status = response?.status();
  if (isBlockedStatus(status)) {
    session?.retire();
    throw new Error(`LinkedIn returned HTTP ${status} for job ${jobId}.`);
  }
  if (status && status >= 400) throw new Error(`LinkedIn returned HTTP ${status} for job ${jobId}.`);

  log.info(`Detail: ${jobId}`);

  const detail = await page.evaluate(extractLinkedInDom, { kind: 'detail' as const, pageUrl: request.url, blockMarkers: BLOCK_TEXT_MARKERS });
  if (detail.kind !== 'detail') throw new Error('Unexpected DOM extraction kind.');

  const postedDate = detailOrCard(detail.postedDate, card.postedDate as string | null);
  const salaryRange = detailOrCard(detail.salaryRange, card.salaryRange as string | null);
  const parsedSalary = parseSalaryRange(salaryRange);
  const description = detail.jobDescription ?? null;
  const workplace = resolveWorkplace({ criteria: detail.workplaceType,
    structuredLocationTypes: detail.structuredLocationTypes,
    title: detailOrCard(detail.jobTitle, card.jobTitle as string | null),
    location: detailOrCard(detail.jobLocation, card.jobLocation as string | null),
    description });
  const record: JobRecord = {
    jobTitle: detailOrCard(detail.jobTitle, card.jobTitle as string | null),
    companyName: detailOrCard(detail.companyName, card.companyName as string | null),
    companyLinkedInUrl: detailOrCard(
      detail.companyLinkedInUrl,
      card.companyLinkedInUrl as string | null,
    ),
    companyLogoUrl: detailOrCard(
      detail.companyLogoUrl,
      card.companyLogoUrl as string | null,
    ),
    jobLocation: detailOrCard(detail.jobLocation, card.jobLocation as string | null),
    country: detail.country ?? null,
    ...workplace,
    jobType: detail.jobType ?? null,
    experienceLevel: detail.experienceLevel ?? null,
    postedDate,
    postedAt: normalizePostedAt(detail.structuredPostedAt ?? postedDate),
    expiresAt: normalizePostedAt(detail.structuredExpiresAt),
    numberOfApplicants: detail.numberOfApplicants ?? null,
    jobDescription: description,
    jobDescriptionHtml: detail.jobDescriptionHtml ?? null,
    responsibilities: detail.responsibilities ?? null,
    qualifications: detail.qualifications ?? null,
    benefits: mergeUniqueStrings(detail.benefits),
    requiredSkills: mergeUniqueStrings(
      detail.requiredSkills,
      inferSkills(description),
    ),
    salaryRange,
    salaryMin: detail.structuredSalaryMin ?? parsedSalary.salaryMin,
    salaryMax: detail.structuredSalaryMax ?? parsedSalary.salaryMax,
    salaryCurrency: detail.structuredSalaryCurrency ?? parsedSalary.salaryCurrency,
    salaryPeriod: detail.structuredSalaryPeriod ?? parsedSalary.salaryPeriod,
    jobFunctions: mergeUniqueStrings(detail.jobFunctions),
    industries: mergeUniqueStrings(detail.industries),
    jobUrl: (card.jobUrl as string) || canonicalJobUrl(jobId as string),
    applyUrl: detail.applyUrl ?? null,
    jobId: jobId as string,
    companySize: detail.companySize ?? null,
    companyIndustry: detail.companyIndustry ?? null,
    easyApply: detail.easyApply ?? false,
    keywordUsed: keyword as string,
    locationUsed: location as string,
    sourceSearchUrl: (card.sourceSearchUrl as string | null) ?? null,
    resultPosition: typeof card.resultPosition === 'number' ? card.resultPosition : null,
    scrapedAt: new Date().toISOString(),
  };

  // Blocking is judged before the record is trusted, so a wall can never be saved or
  // charged even when it happens to fill in enough fields to look real.
  if (detail.blocked || isBlockedUrl(page.url())) {
    session?.retire();
    throw new Error(`LinkedIn blocked the job detail page for ${jobId}.`);
  }

  if (!hasUsableJobData(record)) {
    getScan().unusableDetail(key);
    releaseEnqueued(budget, key);
    log.warning(`No usable job data for ${jobId}; not saving and not charging.`);
    return;
  }
  if (!detail.jobTitle && !detail.jobDescription) {
    // The old scrape mode may keep a usable search-card fallback. Such a fallback
    // alone is not sufficient evidence to advance a saved watchlist baseline.
    getScan().unusableDetail(key);
  }

  const requestedWorkplaceTypes = (card.requestedWorkplaceTypes ?? []) as WorkplaceType[];
  if (!matchesWorkplace(workplace, requestedWorkplaceTypes)) {
    getScan().filterDetail(key, record.jobId, workplace.workplaceEvidenceStatus === 'explicit' ? 'nonmatching' : 'unverified');
    // Keep the navigation slot consumed: rejected candidates must not trigger
    // unlimited paid discovery in a small low-price run.
    log.info(`Skipping ${jobId}: requested workplace is not supported by explicit role evidence; not saving or charging.`, {
      workplaceEvidenceStatus: workplace.workplaceEvidenceStatus,
      workplaceType: workplace.workplaceType,
    });
    return;
  }

  // The slot is reserved before any await, so concurrent workers cannot overshoot
  // maxResults or keep charging after the spending limit is reached.
  if (!reserveSave(budget)) {
    log.info('Result budget reached while parsing; discarding extra job.');
    return;
  }

  try {
    const chargeResult = await Actor.pushData(record, 'job-scraped');
    const recordSaved = wasPushedRecordSaved(chargeResult);
    if (!recordSaved) {
      releaseSave(budget);
    } else {
      getScan().saveDetail(key, record.jobId);
      observeSavedJob(record);
    }
    registerCharge(
      budget,
      recordSaved && (chargeResult.chargedCount ?? 0) > 0 ? 1 : 0,
      Boolean(chargeResult.eventChargeLimitReached),
    );
  } catch (error) {
    releaseSave(budget);
    throw error;
  }

  log.info(`Pushed job ${jobId}`, { saved: budget.pushed, maxResults: budget.maxResults });

  // Stop paying for navigation once the budget or the spending limit is exhausted.
  if (isFinished(budget)) {
    const reason = budget.stopReason ?? 'max-results';
    log.info(`Stopping crawl: ${reason}.`);
    crawler.stop(`Reached ${reason}`);
  }
});
