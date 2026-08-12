import type { ActorInput } from './types.js';

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

/** Defaults mirror INPUT_SCHEMA.json so API callers and UI callers behave identically. */
export const DEFAULT_MAX_RESULTS = 50;
export const DEFAULT_MAX_JOBS_PER_SEARCH = 25;
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
}

export interface SearchRequestSpec {
  url: string;
  label: 'search';
  uniqueKey: string;
  userData: SearchUserData;
}

function filterCodes(values: string[] | undefined, map: Record<string, string>): string[] {
  if (!values?.length) return [];
  return values.map((value) => map[value.toLowerCase()]).filter((code): code is string => Boolean(code));
}

export function buildSearchUrl(
  input: Pick<ActorInput, 'workplaceType' | 'jobType' | 'experienceLevel'>,
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

  return `${GUEST_SEARCH_ENDPOINT}?${params.toString()}`;
}

export function buildDetailUrl(jobId: string): string {
  return `${GUEST_DETAIL_ENDPOINT}/${jobId}`;
}

/**
 * Every unique keyword x location pair is queued. The total budget limits how many jobs
 * are saved, so searches are never silently dropped from the plan.
 */
export function buildSearchRequests(input: ActorInput, _limits?: RunLimits): SearchRequestSpec[] {
  const requests: SearchRequestSpec[] = [];
  const seen = new Set<string>();

  for (const keyword of input.keywords) {
    for (const location of input.locations) {
      const key = searchKey(keyword, location);
      if (seen.has(key)) continue;
      seen.add(key);

      requests.push({
        url: buildSearchUrl(input, keyword, location, 0),
        label: 'search',
        uniqueKey: `search-${key}-0`,
        userData: { keyword, location, start: 0 },
      });
    }
  }

  return requests;
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
