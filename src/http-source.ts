import { setTimeout as sleep } from 'node:timers/promises';
import { assertGuestUrl, readGuestPage, SourceBudgetStop, SourceReadError } from './http-transport.js';

export const HTTP_MIN_INTERVAL_MS = 1500;
export const HTTP_RATE_LIMIT_WAIT_MS = 12_000;
export const HTTP_MAX_RETRY_WAIT_MS = 20_000;
export const HTTP_MAX_RATE_LIMIT_RETRIES = 2;
export const HTTP_HANDLER_TIMEOUT_SECS = 75;

export interface HttpSourceOptions {
  canContinue: () => boolean;
  deadline: number;
  readSource?: typeof readGuestPage;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  onRetry?: (event: { category: string; waitMs: number }) => void;
}

export interface HttpSourceSummary {
  sourceAttempts: number;
  successfulSourceReads: number;
  decodedHtmlBytes: number;
  retries: number;
  rateLimitResponses: number;
  rateLimitRetries: number;
  recoveredRateLimits: number;
  transientRetries: number;
  recoveredTransientErrors: number;
  waitMs: number;
  terminalFailure: string | null;
  stopReason: string | null;
  policy: { minIntervalMs: number; maxRetriesPerRequest: number; maxRateLimitRetriesPerRun: number;
    defaultRateLimitWaitMs: number; maxRetryWaitMs: number };
}

/** One run-wide controller: paced requests, one retry per page, no proxy/IP rotation. */
export class HttpSource {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private nextAllowedAt = 0;
  private tail: Promise<void> = Promise.resolve();
  private terminalError: SourceReadError | null = null;
  private readonly stats: HttpSourceSummary = {
    sourceAttempts: 0, successfulSourceReads: 0, decodedHtmlBytes: 0, retries: 0,
    rateLimitResponses: 0, rateLimitRetries: 0, recoveredRateLimits: 0,
    transientRetries: 0, recoveredTransientErrors: 0, waitMs: 0,
    terminalFailure: null, stopReason: null,
    policy: { minIntervalMs: HTTP_MIN_INTERVAL_MS, maxRetriesPerRequest: 1,
      maxRateLimitRetriesPerRun: HTTP_MAX_RATE_LIMIT_RETRIES, defaultRateLimitWaitMs: HTTP_RATE_LIMIT_WAIT_MS,
      maxRetryWaitMs: HTTP_MAX_RETRY_WAIT_MS },
  };

  constructor(private readonly options: HttpSourceOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? (async ms => { await sleep(ms); });
  }

  summary(): HttpSourceSummary { return { ...this.stats, policy: { ...this.stats.policy } }; }

  async read(url: string): ReturnType<typeof readGuestPage> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await this.readSequential(url); }
    finally { release(); }
  }

  private assertActive(): void {
    if (this.terminalError) throw this.terminalError;
    if (!this.options.canContinue()) {
      this.stats.stopReason = 'spending_or_result_bound';
      throw new SourceBudgetStop();
    }
    if (this.now() >= this.options.deadline) {
      this.stats.stopReason = 'source_time_bound';
      throw new SourceBudgetStop('time');
    }
  }

  private async waitUntil(target: number): Promise<void> {
    this.assertActive();
    // Do not pay for a cooldown that leaves no time for even a short source read.
    if (target >= this.options.deadline - 1000) {
      this.stats.stopReason = 'source_time_bound';
      throw new SourceBudgetStop('time');
    }
    while (this.now() < target) {
      this.assertActive();
      const before = this.now();
      await this.wait(Math.min(250, target - before));
      this.stats.waitMs += Math.max(0, this.now() - before);
    }
    this.assertActive();
  }

  private stop(error: SourceReadError, reason: string): never {
    this.stats.terminalFailure = error.category;
    this.stats.stopReason = reason;
    // Retry policy lives here, not in Crawlee. A terminal failure cannot restart a loop.
    this.terminalError = new SourceReadError(error.category, false, error.retryAfterMs);
    throw this.terminalError;
  }

  private async readSequential(url: string): ReturnType<typeof readGuestPage> {
    assertGuestUrl(url);
    let retriedCategory: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.waitUntil(this.nextAllowedAt);
      this.stats.sourceAttempts++;
      try {
        const result = await (this.options.readSource ?? readGuestPage)(url, {
          canContinue: this.options.canContinue, deadline: this.options.deadline, now: this.now,
        });
        this.nextAllowedAt = this.now() + HTTP_MIN_INTERVAL_MS;
        this.stats.successfulSourceReads++;
        this.stats.decodedHtmlBytes += result.bytes;
        if (retriedCategory === 'http_429') this.stats.recoveredRateLimits++;
        else if (retriedCategory) this.stats.recoveredTransientErrors++;
        return result;
      } catch (error) {
        this.nextAllowedAt = this.now() + HTTP_MIN_INTERVAL_MS;
        if (error instanceof SourceBudgetStop) {
          this.stats.stopReason = error.reason === 'time' ? 'source_time_bound' : 'spending_or_result_bound';
          throw error;
        }
        const sourceError = error instanceof SourceReadError ? error : new SourceReadError('unexpected_source_error');
        const rateLimited = sourceError.category === 'http_429';
        if (rateLimited) this.stats.rateLimitResponses++;
        if (!rateLimited && !sourceError.retryable) this.stop(sourceError, 'source_unavailable');
        if (attempt === 1) this.stop(sourceError, rateLimited ? 'rate_limit_retry_exhausted' : 'source_retry_exhausted');
        if (rateLimited && this.stats.rateLimitRetries >= HTTP_MAX_RATE_LIMIT_RETRIES) {
          this.stop(sourceError, 'run_rate_limit_retry_bound');
        }
        const waitMs = Math.max(HTTP_MIN_INTERVAL_MS,
          sourceError.retryAfterMs ?? (rateLimited ? HTTP_RATE_LIMIT_WAIT_MS : 1000));
        // A long server-directed wait is not shortened to fit our budget.
        if (waitMs > HTTP_MAX_RETRY_WAIT_MS) this.stop(sourceError, 'retry_after_exceeds_bound');
        this.assertActive();
        const target = this.now() + waitMs;
        if (target >= this.options.deadline - 1000) {
          this.stats.stopReason = 'source_time_bound';
          throw new SourceBudgetStop('time');
        }
        this.options.onRetry?.({ category: sourceError.category, waitMs });
        await this.waitUntil(target);
        // Only count a retry once it is eligible to send; budget loss during wait sends none.
        this.stats.retries++;
        if (rateLimited) this.stats.rateLimitRetries++;
        else this.stats.transientRetries++;
        retriedCategory = sourceError.category;
      }
    }
    throw new Error('Unreachable source retry state.');
  }
}
