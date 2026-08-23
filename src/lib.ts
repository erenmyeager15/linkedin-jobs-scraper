import type { ActorInput } from './types.js';
import { createHash } from 'node:crypto';

/** LinkedIn guest search filter codes. */
export const WORKPLACE_MAP: Record<string, string> = {
  remote: '2',
  hybrid: '3',
  onsite: '1',
};

export const JOB_TYPE_MAP: Record<string, string> = {
  'full-time': 'F',
  'part-time': 'P',
  contract: 'C',
  internship: 'I',
  temporary: 'T',
  volunteer: 'V',
};

export const EXP_LEVEL_MAP: Record<string, string> = {
  internship: '1',
  entry: '2',
  associate: '3',
  'mid-senior': '4',
  director: '5',
  executive: '6',
};

export const DATE_POSTED_MAP: Record<string, string> = {
  'past-24h': 'r86400',
  'past-week': 'r604800',
  'past-month': 'r2592000',
};

export const SALARY_MAP: Record<string, string> = {
  40000: '1',
  60000: '2',
  80000: '3',
  100000: '4',
  120000: '5',
};

/** Defaults mirror INPUT_SCHEMA.json so API callers and UI callers behave identically. */
export const DEFAULT_MAX_RESULTS = 5;
export const DEFAULT_MAX_JOBS_PER_SEARCH = 5;
export const MAX_RESULTS_LIMIT = 5000;
export const MAX_JOBS_PER_SEARCH_LIMIT = 500;
/** LinkedIn's guest search returns about ten cards per offset page. */
export const CARDS_PER_GUEST_PAGE = 10;

export const GUEST_SEARCH_ENDPOINT =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
export const GUEST_DETAIL_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

/**
 * Only the HTML document is fetched. LinkedIn's scripts and stylesheets are megabytes of
 * residential-proxy bandwidth per page and contribute nothing: every field comes from
 * server-rendered markup. Block detection uses unambiguous phrases, so losing
 * CSS-driven visibility cannot cause a false positive.
 */
export const ALLOWED_RESOURCE_TYPES = ['document'];

export function shouldAllowResource(resourceType: string): boolean {
  return ALLOWED_RESOURCE_TYPES.includes(resourceType);
}

export interface RunLimits {
  maxResults: number;
  maxJobsPerSearch: number;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * `maxResults` is a hard total across every keyword x location search.
 * A per-search cap can never exceed the total cap.
 */
export function resolveLimits(input: Pick<ActorInput, 'maxResults' | 'maxJobsPerSearch'>): RunLimits {
  const maxResults = clampInteger(input.maxResults, 1, MAX_RESULTS_LIMIT, DEFAULT_MAX_RESULTS);
  const perSearch = clampInteger(
    input.maxJobsPerSearch,
    1,
    MAX_JOBS_PER_SEARCH_LIMIT,
    DEFAULT_MAX_JOBS_PER_SEARCH,
  );

  return { maxResults, maxJobsPerSearch: Math.min(perSearch, maxResults) };
}

/** Offset pages a single search may need, used to size the crawl request limit. */
export function searchPagesPerSearch(limits: RunLimits): number {
  return Math.ceil(limits.maxJobsPerSearch / CARDS_PER_GUEST_PAGE) + 2;
}

export function maxRequestsForRun(limits: RunLimits, searchCount: number): number {
  return limits.maxResults + searchCount * searchPagesPerSearch(limits) + 10;
}

export function searchKey(keyword: string, location: string): string {
  return `${keyword}||${location}`;
}

export interface SearchUserData {
  keyword: string;
  location: string;
  start: number;
  searchId: string;
  sourceSearchUrl: string | null;
}

export interface SearchRequestSpec {
  url: string;
  label: 'search';
  uniqueKey: string;
  userData: SearchUserData;
}

export interface DetailRequestSpec {
  url: string;
  label: 'job-detail';
  uniqueKey: string;
  userData: {
    jobId: string;
    jobUrl: string;
    keyword: string;
    location: string;
    searchId: string;
    sourceSearchUrl: null;
    resultPosition: null;
  };
}

function filterCodes(values: string[] | undefined, map: Record<string, string>): string[] {
  if (!values?.length) return [];
  return values.map((value) => map[value.toLowerCase()]).filter((code): code is string => Boolean(code));
}

export function buildSearchUrl(
  input: Pick<
    ActorInput,
    | 'workplaceType'
    | 'jobType'
    | 'experienceLevel'
    | 'datePosted'
    | 'easyApplyOnly'
    | 'sortBy'
    | 'minimumSalary'
  >,
  keyword: string,
  location: string,
  start: number,
): string {
  const params = new URLSearchParams();
  params.set('keywords', keyword);
  params.set('location', location);
  params.set('start', String(start));

  const workplace = filterCodes(input.workplaceType, WORKPLACE_MAP);
  if (workplace.length) params.set('f_WT', workplace.join(','));

  const jobTypes = filterCodes(input.jobType, JOB_TYPE_MAP);
  if (jobTypes.length) params.set('f_JT', jobTypes.join(','));

  const levels = filterCodes(input.experienceLevel, EXP_LEVEL_MAP);
  if (levels.length) params.set('f_E', levels.join(','));

  const datePosted = input.datePosted ? DATE_POSTED_MAP[input.datePosted] : undefined;
  if (datePosted) params.set('f_TPR', datePosted);

  if (input.easyApplyOnly) params.set('f_AL', 'true');
  if (input.sortBy === 'recent') params.set('sortBy', 'DD');

  const salaryCode = input.minimumSalary ? SALARY_MAP[input.minimumSalary] : undefined;
  if (salaryCode) params.set('f_SB2', salaryCode);

  return `${GUEST_SEARCH_ENDPOINT}?${params.toString()}`;
}

export function buildDetailUrl(jobId: string): string {
  return `${GUEST_DETAIL_ENDPOINT}/${jobId}`;
}

function cleanStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function parseLinkedInUrl(rawValue: string, field: string): URL {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new Error(`Each ${field} item must be a non-empty LinkedIn URL.`);
  }
  if (rawValue.length > 2_048) throw new Error(`Each ${field} URL must be 2,048 characters or fewer.`);

  let url: URL;
  try {
    url = new URL(rawValue.trim());
  } catch {
    throw new Error(`Invalid LinkedIn URL in ${field}: ${rawValue}`);
  }

  const hostname = url.hostname.toLowerCase();
  const isLinkedIn = hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
  if (!isLinkedIn || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error(`${field} only accepts standard public linkedin.com URLs.`);
  }

  url.protocol = 'https:';
  url.hostname = 'www.linkedin.com';
  url.hash = '';
  return url;
}

function stableKey(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

export interface NormalizedSearchUrl {
  url: string;
  sourceSearchUrl: string;
  keyword: string;
  location: string;
}

export function normalizeLinkedInSearchUrl(rawValue: string): NormalizedSearchUrl {
  const source = parseLinkedInUrl(rawValue, 'searchUrls');
  const validPath = /^\/jobs\/search\/?$/i.test(source.pathname)
    || source.pathname === new URL(GUEST_SEARCH_ENDPOINT).pathname;
  if (!validPath) {
    throw new Error('searchUrls must contain LinkedIn Jobs search-result URLs.');
  }

  const removableParams = ['trk', 'refId', 'trackingId', 'position', 'pageNum', 'currentJobId'];
  removableParams.forEach((name) => source.searchParams.delete(name));
  source.searchParams.delete('start');
  const sourceSearchUrl = source.toString();

  const guest = new URL(GUEST_SEARCH_ENDPOINT);
  source.searchParams.forEach((value, key) => guest.searchParams.append(key, value));
  guest.searchParams.set('start', '0');

  return {
    url: guest.toString(),
    sourceSearchUrl,
    keyword: source.searchParams.get('keywords')?.trim() || 'Custom LinkedIn search',
    location: source.searchParams.get('location')?.trim() || '',
  };
}

export function extractLinkedInJobId(rawValue: string): string {
  const url = parseLinkedInUrl(rawValue, 'jobUrls');
  const id = url.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})(?:\/|$)/i)?.[1]
    ?? url.pathname.match(/\/jobPosting\/(\d{6,})(?:\/|$)/i)?.[1]
    ?? url.searchParams.get('currentJobId')?.match(/^\d{6,}$/)?.[0];
  if (!id) throw new Error(`Could not find a LinkedIn job ID in jobUrls URL: ${rawValue}`);
  return id;
}

export function canonicalJobUrl(jobId: string): string {
  return `https://www.linkedin.com/jobs/view/${jobId}`;
}

export function validateInputModes(input: ActorInput): void {
  const hasKeywords = cleanStringList(input.keywords).length > 0;
  const hasLocations = cleanStringList(input.locations).length > 0;
  if (hasKeywords !== hasLocations) {
    throw new Error('Keyword search requires both keywords and locations.');
  }

  const hasSearchUrls = (input.searchUrls ?? []).length > 0;
  const hasJobUrls = (input.jobUrls ?? []).length > 0;
  if (!hasKeywords && !hasSearchUrls && !hasJobUrls) {
    throw new Error('Provide keywords with locations, one or more searchUrls, or one or more jobUrls.');
  }
}

/**
 * Every unique keyword x location pair is queued. The total budget limits how many jobs
 * are saved, so searches are never silently dropped from the plan.
 */
export function buildSearchRequests(input: ActorInput, _limits?: RunLimits): SearchRequestSpec[] {
  const requests: SearchRequestSpec[] = [];
  const seenUrls = new Set<string>();

  for (const keyword of cleanStringList(input.keywords)) {
    for (const location of cleanStringList(input.locations)) {
      const key = searchKey(keyword, location);
      const url = buildSearchUrl(input, keyword, location, 0);
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      requests.push({
        url,
        label: 'search',
        uniqueKey: `search-${key}-0`,
        userData: {
          keyword,
          location,
          start: 0,
          searchId: key,
          sourceSearchUrl: null,
        },
      });
    }
  }

  const searchUrls = input.searchUrls ?? [];
  if (searchUrls.length > 20) throw new Error('searchUrls supports at most 20 URLs.');
  for (const rawUrl of searchUrls) {
    const normalized = normalizeLinkedInSearchUrl(rawUrl);
    if (seenUrls.has(normalized.url)) continue;
    seenUrls.add(normalized.url);
    const id = stableKey(normalized.url);
    requests.push({
      url: normalized.url,
      label: 'search',
      uniqueKey: `search-url-${id}-0`,
      userData: {
        keyword: normalized.keyword,
        location: normalized.location,
        start: 0,
        searchId: `url:${id}`,
        sourceSearchUrl: normalized.sourceSearchUrl,
      },
    });
  }

  return requests;
}

export function buildDirectJobRequests(input: Pick<ActorInput, 'jobUrls'>): DetailRequestSpec[] {
  const rawUrls = input.jobUrls ?? [];
  if (rawUrls.length > 100) throw new Error('jobUrls supports at most 100 URLs.');

  const requests: DetailRequestSpec[] = [];
  const seenIds = new Set<string>();
  for (const rawUrl of rawUrls) {
    const jobId = extractLinkedInJobId(rawUrl);
    if (seenIds.has(jobId)) continue;
    seenIds.add(jobId);
    requests.push({
      url: buildDetailUrl(jobId),
      label: 'job-detail',
      uniqueKey: `detail-${jobId}`,
      userData: {
        jobId,
        jobUrl: canonicalJobUrl(jobId),
        keyword: 'Direct job URL',
        location: '',
        searchId: `direct:${jobId}`,
        sourceSearchUrl: null,
        resultPosition: null,
      },
    });
  }
  return requests;
}

export function buildInitialRequests(input: ActorInput): Array<SearchRequestSpec | DetailRequestSpec> {
  return [...buildSearchRequests(input), ...buildDirectJobRequests(input)];
}

export type StopReason = 'max-results' | 'charge-limit' | null;

export interface RunBudget {
  maxResults: number;
  maxJobsPerSearch: number;
  /** Detail pages queued so far. Bounds navigation cost, not just charging. */
  enqueued: number;
  pushed: number;
  charged: number;
  perSearchEnqueued: Map<string, number>;
  /** Job ids already queued in this run, so an overlap never costs budget twice. */
  seenJobIds: Set<string>;
  stopReason: StopReason;
}

export function createBudget(limits: RunLimits): RunBudget {
  return {
    maxResults: limits.maxResults,
    maxJobsPerSearch: limits.maxJobsPerSearch,
    enqueued: 0,
    pushed: 0,
    charged: 0,
    perSearchEnqueued: new Map(),
    seenJobIds: new Set(),
    stopReason: null,
  };
}

export function globalRemaining(budget: RunBudget): number {
  return Math.max(0, budget.maxResults - budget.enqueued);
}

export function searchRemaining(budget: RunBudget, key: string): number {
  return Math.max(0, budget.maxJobsPerSearch - (budget.perSearchEnqueued.get(key) ?? 0));
}

/** How many more detail pages this search may queue right now. */
export function detailAllowance(budget: RunBudget, key: string): number {
  if (budget.stopReason) return 0;
  return Math.min(globalRemaining(budget), searchRemaining(budget, key));
}

/**
 * Claims one budget slot for a job id. Returns false for a job already queued in this
 * run, so cross-search overlap costs nothing.
 */
export function reserveJob(budget: RunBudget, key: string, jobId: string): boolean {
  if (!jobId || budget.seenJobIds.has(jobId)) return false;
  if (detailAllowance(budget, key) <= 0) return false;

  budget.seenJobIds.add(jobId);
  budget.enqueued += 1;
  budget.perSearchEnqueued.set(key, (budget.perSearchEnqueued.get(key) ?? 0) + 1);
  return true;
}

/** Returns a slot when a queued detail page cannot become a record. */
export function releaseEnqueued(budget: RunBudget, key: string): void {
  if (budget.enqueued > 0) budget.enqueued -= 1;
  const current = budget.perSearchEnqueued.get(key) ?? 0;
  if (current > 0) budget.perSearchEnqueued.set(key, current - 1);
}

/**
 * Reserves a save slot before any await, so concurrent workers can never overshoot
 * maxResults or keep charging after the spending limit is reached.
 */
export function reserveSave(budget: RunBudget): boolean {
  if (!canSaveMore(budget)) return false;

  budget.pushed += 1;
  if (budget.pushed >= budget.maxResults && !budget.stopReason) {
    budget.stopReason = 'max-results';
  }
  return true;
}

/** Rolls back a reserved slot when the save itself failed. */
export function releaseSave(budget: RunBudget): void {
  if (budget.pushed > 0) budget.pushed -= 1;
  if (budget.stopReason === 'max-results' && budget.pushed < budget.maxResults) {
    budget.stopReason = null;
  }
}

export function registerCharge(
  budget: RunBudget,
  chargedCount: number,
  limitReached: boolean,
): void {
  if (chargedCount > 0) budget.charged += chargedCount;
  if (limitReached) budget.stopReason = 'charge-limit';
}

/** Prefer richer detail-page data, but retain fields already present on search cards. */
export function detailOrCard<T>(detailValue: T | null | undefined, cardValue: T | null | undefined): T | null {
  return detailValue ?? cardValue ?? null;
}

export function isFinished(budget: RunBudget): boolean {
  return budget.stopReason !== null || budget.pushed >= budget.maxResults;
}

/** True while a job may still be saved and charged. */
export function canSaveMore(budget: RunBudget): boolean {
  return budget.stopReason === null && budget.pushed < budget.maxResults;
}

const BLOCK_URL_PATTERN = /\/authwall|\/uas\/login|\/checkpoint\/|\/login(?:\?|$)/i;

export function isBlockedUrl(url: string): boolean {
  return BLOCK_URL_PATTERN.test(url);
}

/** LinkedIn answers throttled guest traffic with 999, and challenges with 403/429. */
export function isBlockedStatus(status: number | null | undefined): boolean {
  if (typeof status !== 'number') return false;
  return status === 999 || status === 403 || status === 429 || status >= 500;
}

/**
 * Deliberately unambiguous phrases only. Generic sign-in prompts appear on ordinary
 * guest pages, so matching them would discard real listings.
 */
export const BLOCK_TEXT_MARKERS = [
  'authwall',
  'security verification',
  'unusual activity',
  'verify you are a human',
  'captcha',
];

export function looksBlockedText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BLOCK_TEXT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * A job is only saved and charged when it carries real content, so an authwall or a
 * LinkedIn layout change can never produce a paid record full of nulls.
 */
export function hasUsableJobData(record: {
  jobTitle: string | null;
  companyName: string | null;
  jobDescription: string | null;
}): boolean {
  if (!record.jobTitle) return false;
  return Boolean(record.companyName) || Boolean(record.jobDescription);
}

export interface SalaryParts {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}

export function parseSalaryRange(value: string | null | undefined): SalaryParts {
  if (!value) {
    return { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null };
  }

  const amounts = [...value.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/g)]
    .map((match) => {
      const base = Number(match[1].replace(/,/g, ''));
      if (!Number.isFinite(base)) return null;
      const suffix = match[2]?.toLowerCase();
      if (suffix === 'k') return Math.round(base * 1_000);
      if (suffix === 'm') return Math.round(base * 1_000_000);
      return Math.round(base);
    })
    .filter((amount): amount is number => amount !== null);

  const currency = value.match(/\b(?:USD|GBP|EUR|INR|AUD|CAD|SGD|AED|JPY)\b/i)?.[0]?.toUpperCase()
    ?? value.match(/[$£€₹]/)?.[0]
    ?? null;
  const periodMatch = value.match(
    /(?:\/|\bper\s+)?(year|yr|annum|annual|hour|hr|month|week|day)\b/i,
  )?.[1]?.toLowerCase();
  const periodMap: Record<string, string> = {
    year: 'YEAR',
    yr: 'YEAR',
    annum: 'YEAR',
    annual: 'YEAR',
    hour: 'HOUR',
    hr: 'HOUR',
    month: 'MONTH',
    week: 'WEEK',
    day: 'DAY',
  };

  return {
    salaryMin: amounts[0] ?? null,
    salaryMax: amounts[1] ?? null,
    salaryCurrency: currency,
    salaryPeriod: periodMatch ? periodMap[periodMatch] : null,
  };
}

export function normalizePostedAt(
  value: string | null | undefined,
  now = new Date(),
): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes('today')) return now.toISOString();
  if (lower.includes('yesterday')) {
    return new Date(now.getTime() - 86_400_000).toISOString();
  }

  const relative = lower.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (!relative) return null;
  const count = Number(relative[1]);
  const unitMs: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000,
  };
  return new Date(now.getTime() - count * unitMs[relative[2]]).toISOString();
}

export function mergeUniqueStrings(...groups: Array<Array<string | null | undefined> | null | undefined>): string[] {
  return [...new Set(
    groups
      .flatMap((group) => group ?? [])
      .map((value) => String(value ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  )];
}

export interface PushDataChargeResult {
  chargedCount: number;
  eventChargeLimitReached: boolean;
}

export function wasPushedRecordSaved(result: PushDataChargeResult): boolean {
  return result.chargedCount > 0 || !result.eventChargeLimitReached;
}

/** Skills inferred from free text must match whole tokens, not substrings. */
export const COMMON_SKILLS = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Kotlin', 'Swift', 'Golang', 'Rust',
  'C++', 'C#', '.NET', 'PHP', 'Ruby', 'Scala', 'MATLAB',
  'React', 'Vue', 'Angular', 'Node.js', 'Flutter', 'Dart', 'Sass',
  'SQL', 'MongoDB', 'PostgreSQL', 'Redis', 'Kafka', 'Spark', 'Hadoop',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Jenkins',
  'Linux', 'Git', 'CI/CD', 'REST', 'GraphQL',
  'Tableau', 'Power BI', 'TensorFlow', 'PyTorch',
  'Agile', 'Scrum', 'Machine Learning', 'Data Science', 'DevOps',
  'Figma', 'Sketch', 'Adobe XD',
];

export function skillPattern(skill: string): RegExp {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9+#.])${escaped}(?:$|[^A-Za-z0-9+#])`, 'i');
}

export function inferSkills(description: string | null, skills: string[] = COMMON_SKILLS): string[] {
  if (!description) return [];
  return skills.filter((skill) => skillPattern(skill).test(description));
}
