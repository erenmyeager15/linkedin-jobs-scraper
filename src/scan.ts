import type { DetailRequestSpec, RunBudget, SearchRequestSpec } from './lib.js';

export type CoverageStatus = 'unscanned' | 'scanning' | 'exhausted' | 'capped' | 'observed' | 'unverified_empty' | 'incomplete' | 'failed';

export interface SearchCoverage {
  searchId: string;
  mode: 'search' | 'direct';
  keyword: string;
  location: string;
  status: CoverageStatus;
  pagesScanned: number;
  jobIdsSeen: number;
  detailsQueued: number;
  detailsSaved: number;
  detailsFiltered: number;
  workplaceUnverified: number;
  discoveryStrategy: 'ordinary' | 'title-supported-workplace';
  discoveryPageLimit: number | null;
  titlesSkipped: number;
  failedRequests: number;
}

export interface ScanSummary {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  jobsSaved: number;
  jobsCharged: number;
  stopReason: string;
  boundedObservationComplete: boolean;
  fullSearchCoverage: boolean;
  reasons: string[];
  coverage: SearchCoverage[];
}

/** Coverage is separate from billing: a successful dataset write is not a complete search. */
export class ScanTracker {
  private readonly entries = new Map<string, SearchCoverage>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly queued = new Set<string>();
  private readonly saved = new Set<string>();
  private readonly filtered = new Set<string>();
  private readonly problems = new Set<string>();

  constructor(requests: Array<SearchRequestSpec | DetailRequestSpec>, readonly startedAt: string) {
    for (const request of requests) {
      const { searchId, keyword, location } = request.userData;
      this.entries.set(searchId, {
        searchId, keyword, location, mode: request.label === 'search' ? 'search' : 'direct',
        status: 'unscanned', pagesScanned: 0, jobIdsSeen: 0, detailsQueued: 0,
        detailsSaved: 0, detailsFiltered: 0, workplaceUnverified: 0, failedRequests: 0,
        discoveryStrategy: 'ordinary', discoveryPageLimit: null, titlesSkipped: 0,
      });
      this.seen.set(searchId, new Set());
    }
  }

  searchPage(searchId: string, ids: string[], cardCount: number, emptyRecognized = true): void {
    const entry = this.entries.get(searchId);
    if (!entry) throw new Error('Unplanned search coverage key.');
    entry.pagesScanned += 1;
    const seen = this.seen.get(searchId)!;
    ids.forEach((id) => seen.add(id));
    entry.jobIdsSeen = seen.size;
    if (cardCount > ids.length) {
      this.problems.add('unparsed-search-cards');
      entry.status = 'failed';
    } else if (entry.status !== 'failed') {
      // An empty initial fragment is not proof of a genuinely empty search.
      entry.status = ids.length ? 'scanning' : seen.size && emptyRecognized ? 'exhausted' : 'unverified_empty';
    }
  }

  cap(searchId: string): void {
    const entry = this.entries.get(searchId);
    if (entry && !['failed', 'unverified_empty', 'exhausted'].includes(entry.status)) entry.status = 'capped';
  }

  queueDetail(searchId: string, jobId: string): void {
    if (this.queued.has(jobId)) return;
    const entry = this.entries.get(searchId);
    if (!entry) throw new Error('Unplanned detail coverage key.');
    this.queued.add(jobId);
    entry.detailsQueued += 1;
    if (entry.mode === 'direct') entry.status = 'scanning';
  }

  saveDetail(searchId: string, jobId: string): void {
    if (this.saved.has(jobId)) return;
    const entry = this.entries.get(searchId);
    if (!entry || !this.queued.has(jobId)) throw new Error('Saved detail was not queued.');
    this.saved.add(jobId);
    entry.detailsSaved += 1;
    if (entry.mode === 'direct') entry.status = 'observed';
  }

  unusableDetail(searchId: string): void {
    this.problems.add('unusable-job-detail');
    const entry = this.entries.get(searchId);
    if (entry) entry.status = 'failed';
  }

  filterDetail(searchId: string, jobId: string, reason: 'nonmatching' | 'unverified'): void {
    if (this.filtered.has(jobId)) return;
    const entry = this.entries.get(searchId);
    if (!entry || !this.queued.has(jobId) || this.saved.has(jobId)) throw new Error('Filtered detail was not an unsaved queued job.');
    this.filtered.add(jobId);
    entry.detailsFiltered += 1;
    if (reason === 'unverified') {
      entry.workplaceUnverified += 1;
      this.problems.add('workplace-filter-unverified');
    }
  }

  titleDiscovery(searchId: string, pageLimit: number, skipped: number): void {
    const entry = this.entries.get(searchId);
    if (!entry) throw new Error('Unplanned title-discovery coverage key.');
    entry.discoveryStrategy = 'title-supported-workplace';
    entry.discoveryPageLimit = pageLimit;
    entry.titlesSkipped += skipped;
  }

  fail(searchId: string): void {
    this.problems.add('request-failed');
    const entry = this.entries.get(searchId);
    if (entry) {
      entry.failedRequests += 1;
      entry.status = 'failed';
    }
  }

  finish(budget: RunBudget, finishedAt: string, crawlerFailed = false): ScanSummary {
    const reasons = new Set(this.problems);
    const coverage = [...this.entries.values()].map((entry) => ({ ...entry }));
    for (const entry of coverage) {
      if (['unscanned', 'scanning'].includes(entry.status)) {
        entry.status = budget.stopReason === 'max-results' ? 'capped' : 'incomplete';
      }
      if (['unverified_empty', 'incomplete', 'failed'].includes(entry.status)) reasons.add(entry.status);
    }
    if (crawlerFailed) reasons.add('crawler-failed');
    if (budget.stopReason === 'charge-limit') reasons.add('charge-limit');
    if (budget.stopReason === 'time-limit') reasons.add('time-limit');
    if (budget.stopReason === 'rate-limit') reasons.add('rate-limit');
    if (budget.stopReason === 'source-unavailable') reasons.add('source-unavailable');
    if (this.saved.size + this.filtered.size !== this.queued.size) reasons.add('unfinished-job-details');
    if (this.saved.size !== budget.pushed) reasons.add('saved-count-mismatch');
    if (!this.saved.size) reasons.add('no-observations');
    return {
      schemaVersion: 1, startedAt: this.startedAt, finishedAt,
      jobsSaved: budget.pushed, jobsCharged: budget.charged,
      stopReason: budget.stopReason ?? (crawlerFailed ? 'crawler-failed' : 'queue-finished'),
      boundedObservationComplete: reasons.size === 0,
      fullSearchCoverage: reasons.size === 0 && coverage.every((entry) => entry.discoveryStrategy === 'ordinary' && ['exhausted', 'observed'].includes(entry.status)),
      reasons: [...reasons].sort(), coverage,
    };
  }
}
