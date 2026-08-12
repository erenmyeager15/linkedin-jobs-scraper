import { Router, type PlaywrightCrawlingContext } from 'crawlee';
import { Actor } from 'apify';
import {
  BLOCK_TEXT_MARKERS,
  buildDetailUrl,
  canSaveMore,
  detailAllowance,
  hasUsableJobData,
  inferSkills,
  isBlockedStatus,
  isBlockedUrl,
  isFinished,
  registerCharge,
  releaseEnqueued,
  releaseSave,
  reserveJob,
  reserveSave,
  searchKey,
  type SearchUserData,
} from './lib.js';
import { getBudget } from './state.js';
import type { JobRecord } from './types.js';

export const router = Router.create<PlaywrightCrawlingContext>();

router.addHandler('search', async ({ page, request, response, session, log, crawler }) => {
  const { keyword, location, start } = request.userData as SearchUserData;
  const budget = getBudget();
  const key = searchKey(keyword, location);

  if (isFinished(budget)) {
    log.info('Result budget reached; skipping remaining search pages.');
    return;
  }

  const status = response?.status();
  if (isBlockedStatus(status)) {
    session?.retire();
    throw new Error(`LinkedIn returned HTTP ${status} for the guest job search.`);
  }

  const allowance = detailAllowance(budget, key);
  if (allowance <= 0) {
    log.info(`Per-search limit reached for "${keyword}" in "${location}".`);
    return;
  }

  log.info(`Search: "${keyword}" in "${location}" — start ${start}, allowance ${allowance}`);

  // The guest endpoint returns a fragment of <li> job cards.
  const scan = await page.evaluate((blockMarkers: string[]) => {
    const cards = document.querySelectorAll<HTMLElement>('li');
    let jobCardCount = 0;
    const results: Array<{
      jobId: string;
      jobTitle: string | null;
      companyName: string | null;
      companyLinkedInUrl: string | null;
      jobLocation: string | null;
      postedDate: string | null;
      salaryRange: string | null;
      applyUrl: string | null;
    }> = [];

    for (const card of cards) {
      try {
        const cardRoot = card.querySelector('.base-card, .base-search-card, [data-entity-urn]');
        const base = cardRoot || card;
        const urn = base.getAttribute('data-entity-urn') || '';
        const link = card.querySelector<HTMLAnchorElement>('a.base-card__full-link, a[href*="/jobs/view/"]');
        const href = link?.getAttribute('href') || '';

        // Count only real job cards, so the paging offset cannot jump past listings.
        if (cardRoot || href) jobCardCount += 1;

        let jobId = '';
        const urnM = urn.match(/jobPosting:(\d+)/);
        const hrefM = href.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/) || href.match(/(\d{6,})/);
        if (urnM) jobId = urnM[1];
        else if (hrefM) jobId = hrefM[1];
        if (!jobId) continue;

        const jobTitle = card.querySelector('.base-search-card__title, h3')?.textContent?.trim() || null;
        const companyEl = card.querySelector<HTMLAnchorElement>('.base-search-card__subtitle a, h4 a, .base-search-card__subtitle');
        const companyName = companyEl?.textContent?.trim() || null;
        const companyLinkedInUrl = (companyEl as HTMLAnchorElement)?.href || null;
        const jobLocation = card.querySelector('.job-search-card__location')?.textContent?.trim() || null;

        const timeEl = card.querySelector('time');
        const postedDate = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || null;

        const salaryEl = card.querySelector('.job-search-card__salary-info');
        const salaryRange = salaryEl?.textContent?.replace(/\s+/g, ' ').trim() || null;

        const applyUrl = href ? (href.startsWith('http') ? href.split('?')[0] : `https://www.linkedin.com${href}`) : null;

        results.push({
          jobId,
          jobTitle,
          companyName,
          companyLinkedInUrl,
          jobLocation,
          postedDate,
          salaryRange,
          applyUrl,
        });
      } catch {
        /* skip malformed card */
      }
    }

    const pageText = (document.body?.innerText || '').toLowerCase();

    return {
      results,
      cardCount: jobCardCount,
      blocked: blockMarkers.some((marker) => pageText.includes(marker)),
    };
  }, BLOCK_TEXT_MARKERS);

  // Blocking is checked before anything else is trusted, so a wall can never be
  // mistaken for an exhausted search.
  if (scan.blocked || isBlockedUrl(page.url())) {
    session?.retire();
    throw new Error('LinkedIn blocked the guest job search (authwall or verification).');
  }

  if (scan.results.length === 0) {
    log.info('No job cards returned; this search is exhausted.');
    return;
  }

  log.info(`Scraped ${scan.results.length} job cards (start ${start})`);

  // Reserve a budget slot per job id. Ids already queued in this run are skipped, so
  // overlapping searches never consume the budget twice for one job.
  const unique = scan.results.filter((job) => reserveJob(budget, key, job.jobId));

  if (unique.length > 0) {
    await crawler.addRequests(
      unique.map((job) => ({
        url: buildDetailUrl(job.jobId),
        label: 'job-detail',
        uniqueKey: `detail-${job.jobId}`,
        userData: { ...job, keyword, location },
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
  if (step > 0 && detailAllowance(budget, key) > 0) {
    const nextStart = start + step;
    const nextUrl = new URL(request.url);
    nextUrl.searchParams.set('start', String(nextStart));
    await crawler.addRequests([{
      url: nextUrl.toString(),
      label: 'search',
      uniqueKey: `search-${key}-${nextStart}`,
      userData: { keyword, location, start: nextStart } satisfies SearchUserData,
    }]);
  }
});

router.addHandler('job-detail', async ({ page, request, response, session, log, pushData, crawler }) => {
  const { jobId, keyword, location } = request.userData as Record<
    string,
    unknown
  >;
  const budget = getBudget();
  const key = searchKey(keyword as string, location as string);

  if (!canSaveMore(budget)) {
    log.info('Result budget reached; skipping job detail.');
    return;
  }

  const status = response?.status();
  if (isBlockedStatus(status)) {
    session?.retire();
    throw new Error(`LinkedIn returned HTTP ${status} for job ${jobId}.`);
  }

  log.info(`Detail: ${jobId}`);

  await page.waitForTimeout(1000 + Math.random() * 1500);

  const detail = await page.evaluate((blockMarkers: string[]) => {
    const text = (sel: string): string | null => {
      const el = document.querySelector(sel);
      return el?.textContent?.trim() || null;
    };
    const textAny = (sels: string[]): string | null => {
      for (const s of sels) {
        const v = text(s);
        if (v) return v;
      }
      return null;
    };

    const pageText = document.body?.innerText || '';
    const jobTitle = textAny([
      'h1.top-card-layout__title',
      '.top-card-layout__title',
      'h1',
    ]);

    const companyName = textAny([
      '.topcard__org-name-link',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
    ]);
    const companyEl = document.querySelector<HTMLAnchorElement>(
      '.topcard__org-name-link, .job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a'
    );
    const companyLinkedInUrl = companyEl?.href || null;

    const jobLocation = textAny([
      '.topcard__flavor--bullet',
      '.job-details-jobs-unified-top-card__bullet',
      '.jobs-unified-top-card__bullet',
    ]);

    let postedDate: string | null = textAny([
      '.topcard__flavor--metadata-posted-date',
      '.job-details-jobs-unified-top-card__posted-date',
      '.jobs-unified-top-card__posted-date',
    ]);
    if (!postedDate) {
      const m = pageText.match(
        /(Posted\s+\d+\s+(hour|day|week|month|year)s?\s+ago)/i
      );
      if (m) postedDate = m[1];
    }

    let numberOfApplicants: number | null = null;
    const appText = textAny([
      '.topcard__flavor--metadata-applications',
      '.job-details-jobs-unified-top-card__applicant-count',
      '.jobs-unified-top-card__applicant-count',
    ]);
    if (appText) {
      const m = appText.match(/(\d[\d,]*)/);
      if (m) {
        const parsed = parseInt(m[1].replace(/,/g, ''), 10);
        if (!Number.isNaN(parsed)) numberOfApplicants = parsed;
      }
    }
    if (numberOfApplicants === null) {
      const m = pageText.match(/(\d[\d,]*)\s*applicant/i);
      if (m) {
        const parsed = parseInt(m[1].replace(/,/g, ''), 10);
        if (!Number.isNaN(parsed)) numberOfApplicants = parsed;
      }
    }

    const jobDescription = textAny([
      '.description__text .show-more-less-html__markup',
      '.description__text',
      '.jobs-description-content__text',
      '.jobs-box__description-content',
      'article.jobs-description',
      '.job-view-layout',
    ]);

    let workplaceType: string | null = null;
    let jobType: string | null = null;
    let experienceLevel: string | null = null;

    const criteriaItems = document.querySelectorAll<HTMLElement>(
      '.description__job-criteria-list li, .jobs-unified-description__job-criteria-list li'
    );
    for (const item of criteriaItems) {
      const label = item
        .querySelector(
          '.description__job-criteria-subheader, .jobs-unified-description__job-criteria-subheader'
        )
        ?.textContent?.trim()
        .toLowerCase();
      const value = item
        .querySelector(
          '.description__job-criteria-text, .jobs-unified-description__job-criteria-text'
        )
        ?.textContent?.trim();
      if (!value) continue;
      if (
        label?.includes('employment type') ||
        label?.includes('job type') ||
        label === 'type'
      ) {
        jobType = value;
      } else if (
        label?.includes('seniority') ||
        label?.includes('experience') ||
        label === 'experience level' ||
        label === 'level'
      ) {
        experienceLevel = value;
      } else if (
        label?.includes('workplace') ||
        label === 'workplace type' ||
        label === 'location type'
      ) {
        workplaceType = value;
      }
    }

    if (!workplaceType) {
      const m = pageText.match(/\b(Remote|Hybrid|On-site|On site)\b/i);
      if (m) workplaceType = m[1];
    }
    if (!jobType) {
      const m = pageText.match(
        /\b(Full-time|Part-time|Contract|Internship|Temporary|Volunteer)\b/i
      );
      if (m) jobType = m[1];
    }
    if (!experienceLevel) {
      const m = pageText.match(
        /\b(Entry level|Mid-Senior level|Associate|Director|Executive|Internship)\b/i
      );
      if (m) experienceLevel = m[1];
    }

    let salaryRange: string | null = null;
    const salaryText = textAny([
      '.salary',
      '.salary-range',
      '.job-details-jobs-unified-top-card__salary',
      '.jobs-unified-top-card__salary',
    ]);
    if (salaryText) {
      salaryRange = salaryText;
    } else {
      const m = pageText.match(
        /(\$[\d,]+(?:\s*-\s*\$[\d,]+)?(?:\s*\/?\s*(?:year|hr|hour|month|day))?)/
      );
      if (m) salaryRange = m[1];
    }

    const requiredSkills: string[] = [];
    const skillHeadings = ['Skills', 'Qualifications', 'Required Skills', 'Technical Skills', 'Must Have'];
    for (const heading of skillHeadings) {
      const headingEl = Array.from(document.querySelectorAll('h2, h3, h4, strong')).find(
        (el) => el.textContent?.trim().toLowerCase() === heading.toLowerCase()
      );
      if (headingEl) {
        let next = headingEl.nextElementSibling;
        while (next) {
          if (next.tagName === 'UL') {
            next.querySelectorAll('li').forEach((li) => {
              const s = li.textContent?.trim();
              if (s) requiredSkills.push(s);
            });
            break;
          }
          if (['H2', 'H3', 'H4', 'HR'].includes(next.tagName)) break;
          next = next.nextElementSibling;
        }
      }
    }
    // When LinkedIn exposes no skills list, inference happens outside the browser
    // using whole-token matching so "Java" is not reported for "JavaScript".

    let companySize: string | null = null;
    let companyIndustry: string | null = null;
    const aboutSection = document.querySelector(
      '[data-anonymize="company-info"], .jobs-company__box, .jobs-company-info'
    );
    if (aboutSection) {
      const t = aboutSection.textContent || '';
      const sizeM = t.match(/(\d[\d,]*\s*(employees?|employee))/i);
      if (sizeM) companySize = sizeM[1];
      const indM = t.match(/Industry\s*:?\s*(.+?)(?:\n|$)/i);
      if (indM) companyIndustry = indM[1].trim();
    }

    const easyApply =
      pageText.includes('Easy Apply') &&
      !pageText.includes('not available');

    return {
      jobTitle,
      companyName,
      companyLinkedInUrl,
      jobLocation,
      workplaceType,
      jobType,
      experienceLevel,
      postedDate,
      numberOfApplicants,
      jobDescription,
      requiredSkills,
      salaryRange,
      companySize,
      companyIndustry,
      easyApply,
      blocked: blockMarkers.some((marker) => pageText.toLowerCase().includes(marker)),
    };
  }, BLOCK_TEXT_MARKERS);

  const record: JobRecord = {
    jobTitle: detail.jobTitle ?? null,
    companyName: detail.companyName ?? null,
    companyLinkedInUrl: detail.companyLinkedInUrl ?? null,
    jobLocation: detail.jobLocation ?? null,
    workplaceType: detail.workplaceType ?? null,
    jobType: detail.jobType ?? null,
    experienceLevel: detail.experienceLevel ?? null,
    postedDate: detail.postedDate ?? null,
    numberOfApplicants: detail.numberOfApplicants ?? null,
    jobDescription: detail.jobDescription ?? null,
    requiredSkills: detail.requiredSkills?.length
      ? detail.requiredSkills
      : inferSkills(detail.jobDescription ?? null),
    salaryRange: detail.salaryRange ?? null,
    applyUrl: (request.userData.applyUrl as string) ?? null,
    jobId: jobId as string,
    companySize: detail.companySize ?? null,
    companyIndustry: detail.companyIndustry ?? null,
    easyApply: detail.easyApply ?? false,
    keywordUsed: keyword as string,
    locationUsed: location as string,
    scrapedAt: new Date().toISOString(),
  };

  // Blocking is judged before the record is trusted, so a wall can never be saved or
  // charged even when it happens to fill in enough fields to look real.
  if (detail.blocked || isBlockedUrl(page.url())) {
    session?.retire();
    throw new Error(`LinkedIn blocked the job detail page for ${jobId}.`);
  }

  if (!hasUsableJobData(record)) {
    releaseEnqueued(budget, key);
    log.warning(`No usable job data for ${jobId}; not saving and not charging.`);
    return;
  }

  // The slot is reserved before any await, so concurrent workers cannot overshoot
  // maxResults or keep charging after the spending limit is reached.
  if (!reserveSave(budget)) {
    log.info('Result budget reached while parsing; discarding extra job.');
    return;
  }

  try {
    await pushData(record);
  } catch (error) {
    releaseSave(budget);
    throw error;
  }

  try {
    const chargeResult = await Actor.charge({ eventName: 'job-scraped' });
    registerCharge(budget, Boolean(chargeResult?.eventChargeLimitReached));
  } catch (error) {
    log.warning(`Charging job-scraped failed for ${jobId}: ${(error as Error).message}`);
  }

  log.info(`Pushed job ${jobId}`, { saved: budget.pushed, maxResults: budget.maxResults });

  // Stop paying for navigation once the budget or the spending limit is exhausted.
  if (isFinished(budget)) {
    const reason = budget.stopReason ?? 'max-results';
    log.info(`Stopping crawl: ${reason}.`);
    crawler.stop(`Reached ${reason}`);
  }
});
