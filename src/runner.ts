import { Actor, log } from 'apify';
import { BasicCrawler, PlaywrightCrawler, type PlaywrightCrawlingContext } from 'crawlee';
import { router } from './routes.js';
import {
  buildInitialRequests,
  createBudget,
  maxRequestsForRun,
  releaseEnqueued,
  reserveJob,
  resolveLimits,
  searchKey,
  shouldAllowResource,
  validateInputModes,
} from './lib.js';
import { setBudget, setScan } from './state.js';
import { ScanTracker } from './scan.js';
import { finishWatchlist, projectWatchlistRecord, readWatchlistState, resolveWatchlistOptions, type WatchlistRecord } from './watchlist.js';
import { openWatchlistStorage } from './watchlist-storage.js';
import type { ActorInput } from './types.js';
import { staticHtmlPage } from './html-page.js';
import { HTTP_SOURCE_LIMIT_MS, SourceBudgetStop, SourceReadError, readGuestPage, resolveTransport } from './http-transport.js';
import { HttpSource, HTTP_HANDLER_TIMEOUT_SECS, type HttpSourceOptions } from './http-source.js';

export interface RunDependencies {
  readSource?: typeof readGuestPage;
  runCrawler?: (crawler: BasicCrawler<any>, requests: ReturnType<typeof buildInitialRequests>) => Promise<void>;
  openStorage?: typeof openWatchlistStorage;
  sourceTiming?: Pick<HttpSourceOptions, 'now' | 'wait'>;
}

/** Injectable boundaries allow offline testing of the production entry point. */
export async function runActor(dependencies: RunDependencies = {}): Promise<void> {
await Actor.init();

const input = await Actor.getInput<ActorInput>();
if (!input) throw new Error('Input is required.');
validateInputModes(input);

const limits = resolveLimits(input);
const budget = createBudget(limits);
setBudget(budget);
const transport = resolveTransport(input);
if (transport === 'browser' && Actor.isAtHome() && (Actor.getEnv().memoryMbytes ?? 0) < 1024) {
  throw new Error('Browser transport requires at least 1024 MB. Select 1024 MB or more in Run options for browser/proxy mode.');
}
const canContinue = () => {
  const manager = Actor.getChargingManager();
  if (manager.getPricingInfo().isPayPerEvent && manager.calculateMaxEventChargeCountWithinLimit('job-scraped') < 1) {
    budget.stopReason = 'charge-limit';
  }
  return budget.stopReason === null && budget.pushed < budget.maxResults;
};
if (!canContinue()) {
  await Actor.setValue('RUN-SUMMARY', { transport, jobsSaved: 0, jobsCharged: 0, stopReason: 'charge-limit', boundedObservationComplete: false });
  await Actor.setValue('TRANSPORT-SUMMARY', { transport, automaticFallback: false, sourceRequests: 0, sourceAttempts: 0, explicitProxy: false });
  await Actor.setStatusMessage('Spending limit has no remaining job allowance; no source requests or watchlist setup.');
  await Actor.exit();
  return;
}

const startedAt = new Date().toISOString();
const plannedRequests = buildInitialRequests(input);
const scanTracker = new ScanTracker(plannedRequests, startedAt);
const watchlistOptions = resolveWatchlistOptions(input);
const watchlistStorage = watchlistOptions ? await (dependencies.openStorage ?? openWatchlistStorage)(watchlistOptions.name) : null;
// Reject scope changes/corruption before paying for any source navigation.
if (watchlistStorage && watchlistOptions) readWatchlistState(await watchlistStorage.read(), watchlistOptions.scopeId);
const observedJobs: WatchlistRecord[] = [];
setScan(scanTracker, watchlistOptions ? (record) => observedJobs.push(projectWatchlistRecord(record)) : null);

const proxyConfiguration = transport === 'browser' ? await Actor.createProxyConfiguration(
  input.proxyConfiguration ?? {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
  },
) : undefined;

if (transport === 'browser' && !proxyConfiguration) {
  log.warning(
    'Running without Apify Proxy. LinkedIn blocks datacenter IPs, so results are likely to be empty.',
  );
}

const initialRequests = plannedRequests.filter((request) => {
  if (request.label !== 'job-detail') return true;
  const reserved = reserveJob(budget, request.userData.searchId, request.userData.jobId);
  if (reserved) scanTracker.queueDetail(request.userData.searchId, request.userData.jobId);
  return reserved;
});
const searchCount = initialRequests.filter((request) => request.label === 'search').length;
const directJobCount = initialRequests.filter((request) => request.label === 'job-detail').length;

log.info('Starting LinkedIn jobs scrape', {
  searches: searchCount,
  directJobs: directJobCount,
  maxResults: limits.maxResults,
  maxJobsPerSearch: limits.maxJobsPerSearch,
  transport,
});

const sourceNow = dependencies.sourceTiming?.now ?? Date.now;
const httpDeadline = sourceNow() + HTTP_SOURCE_LIMIT_MS;
const httpSource = new HttpSource({ canContinue, deadline: httpDeadline, readSource: dependencies.readSource,
  ...dependencies.sourceTiming,
  onRetry: event => log.warning('Public source cooldown before one bounded retry; no proxy fallback.', event),
});
let handlerFailure: string | null = null;
const crawler = transport === 'http' ? new BasicCrawler({
  useSessionPool: false,
  maxConcurrency: 1,
  maxRequestsPerMinute: 40,
  sameDomainDelaySecs: 0,
  // The source controller owns pacing and the shared retry budget. Never stack crawler retries.
  maxRequestRetries: 0,
  maxRequestsPerCrawl: maxRequestsForRun(limits, searchCount),
  requestHandlerTimeoutSecs: HTTP_HANDLER_TIMEOUT_SECS,
  async requestHandler(context) {
    if (!canContinue()) { context.request.noRetry = true; context.crawler.stop('Spending/result bound'); return; }
    try {
      const source = await httpSource.read(context.request.url);
      await router.getHandler(context.request.label ?? '')({ ...context,
        page: staticHtmlPage(source.html, source.url), response: { status: () => source.status },
        session: { retire() {} },
      } as unknown as PlaywrightCrawlingContext);
    } catch (error) {
      if (error instanceof SourceBudgetStop) {
        context.request.noRetry = true;
        if ((error.reason === 'time' || sourceNow() >= httpDeadline) && budget.stopReason === null) budget.stopReason = 'time-limit';
        context.crawler.stop('Spending/time bound'); return;
      }
      if (error instanceof SourceReadError && !error.retryable) {
        context.request.noRetry = true;
        if (budget.stopReason === null) budget.stopReason = error.category === 'http_429' ? 'rate-limit' : 'source-unavailable';
        context.crawler.stop('Public source unavailable; no automatic paid fallback');
      }
      // Authwalls found by the shared extractor never justify a paid/browser fallback.
      if (!(error instanceof SourceReadError)) {
        context.request.noRetry = true;
        handlerFailure = 'handler_failed';
        if (budget.stopReason === null) budget.stopReason = 'source-unavailable';
        context.crawler.stop('Public source could not be parsed safely');
      }
      throw error;
    }
  },
  async failedRequestHandler({ request, log: ctxLog }) {
    scanTracker.fail(request.userData.searchId as string);
    ctxLog.error('A public job source request failed; no automatic browser/proxy fallback.');
  },
}) : new PlaywrightCrawler({
  requestHandler: router,
  proxyConfiguration,
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 20,
    sessionOptions: {
      maxUsageCount: 20,
    },
  },
  maxRequestRetries: 3,
  retryOnBlocked: true,
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 60,
  // Measured: five pages at 2 GB finished the same work in 26s versus 56s at 1 GB with
  // three pages, for the same cost. Overlapping the anti-bot delays is what pays off.
  maxConcurrency: 5,
  // Sized for real offset paging so Crawlee never silently drops queued requests.
  maxRequestsPerCrawl: maxRequestsForRun(limits, searchCount),
  preNavigationHooks: [
    async ({ page, request, crawler: activeCrawler }, gotoOptions) => {
      if (!canContinue()) { request.skipNavigation = true; activeCrawler.stop('Spending/result bound'); return; }
      // Only the server-rendered HTML is parsed, so there is nothing to wait for
      // after DOMContentLoaded. This cuts paid seconds off every navigation.
      if (gotoOptions) gotoOptions.waitUntil = 'domcontentloaded';

      // Fetch only the HTML document. Scripts and stylesheets are megabytes of
      // residential bandwidth per page and hold none of the extracted data.
      await page.route('**/*', async (route) => {
        if (shouldAllowResource(route.request().resourceType())) {
          await route.continue().catch(() => { /* navigation already settled */ });
        } else {
          await route.abort().catch(() => { /* navigation already settled */ });
        }
      }).catch(() => { /* best effort */ });

      await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 900));
    },
  ],
  failedRequestHandler: async ({ request, session, log: ctxLog }) => {
    session?.retire();
    const failedSearchId = request.userData.searchId as string | undefined;
    if (failedSearchId) scanTracker.fail(failedSearchId);

    // A detail page that never became a record must return its budget slot, so a
    // permanent failure does not quietly reduce the number of jobs delivered.
    if (request.label === 'job-detail') {
      const { keyword, location, searchId } = request.userData as {
        keyword?: string;
        location?: string;
        searchId?: string;
      };
      const key = searchId ?? (keyword && location ? searchKey(keyword, location) : null);
      if (key) releaseEnqueued(budget, key);
    }

    ctxLog.error('A public job source request failed after the bounded browser retries.');
  },
});

let crawlerError: unknown;
try {
  if (dependencies.runCrawler) await dependencies.runCrawler(crawler, initialRequests);
  else await crawler.run(initialRequests);
} catch (error) {
  crawlerError = error;
}
const scanSummary = scanTracker.finish(budget, new Date().toISOString(), Boolean(crawlerError));
await Actor.setValue('RUN-SUMMARY', scanSummary);
await Actor.setValue('TRANSPORT-SUMMARY', { transport, automaticFallback: false,
  sourceTimeLimitSecs: transport === 'http' ? HTTP_SOURCE_LIMIT_MS / 1000 : null,
  explicitProxy: transport === 'browser' && Boolean(proxyConfiguration),
  ...(transport === 'http' ? { ...httpSource.summary(), handlerFailure } : {}) });
const watchlistReport = watchlistOptions && watchlistStorage ? await finishWatchlist({
  options: watchlistOptions, runId: Actor.getEnv().actorRunId ?? `local-${startedAt}`,
  startedAt, now: new Date().toISOString(), records: observedJobs, summary: scanSummary,
}, watchlistStorage) : null;
if (watchlistReport) {
  log.info('Job watchlist report', { status: watchlistReport.status, baselineCommitted: watchlistReport.baselineCommitted, counts: watchlistReport.counts });
  if (watchlistReport.reason) log.warning(watchlistReport.reason);
}
if (crawlerError) throw crawlerError;
if (budget.pushed === 0 && scanSummary.reasons.some(reason => ['crawler-failed', 'request-failed', 'unusable-job-detail', 'unverified_empty', 'time-limit'].includes(reason))) {
  throw new Error('No usable jobs were saved from a blocked, unavailable or unverified source. Inspect RUN-SUMMARY; no job events were charged.');
}

log.info('Scraping complete.', {
  jobsSaved: budget.pushed,
  jobsCharged: budget.charged,
  stopReason: budget.stopReason ?? 'search-exhausted',
});

if (budget.charged < budget.pushed) {
  log.warning(
    `${budget.pushed - budget.charged} job(s) were saved without a successful charge.`,
  );
}

if (watchlistReport?.baselineCommitted && watchlistReport.reason) {
  await Actor.setStatusMessage(`Saved ${budget.pushed} jobs; watchlist baseline committed but report output needs replay. See logs.`);
} else if (watchlistReport && !watchlistReport.baselineCommitted) {
  await Actor.setStatusMessage(`Saved ${budget.pushed} jobs; watchlist not committed (${watchlistReport.status}). See JOB-CHANGES.`);
} else if (budget.stopReason === 'charge-limit') {
  await Actor.setStatusMessage(
    `Stopped at the run's spending limit after saving ${budget.pushed} jobs.`,
  );
} else if (budget.pushed === 0) {
  await Actor.setStatusMessage(
    'No job listings were saved. Inspect RUN-SUMMARY and try broader filters. No paid fallback was started.',
  );
} else if (!scanSummary.boundedObservationComplete) {
  await Actor.setStatusMessage(`Saved ${budget.pushed} jobs, but this bounded scan is incomplete. Inspect RUN-SUMMARY.`);
} else {
  await Actor.setStatusMessage(`Saved ${budget.pushed} LinkedIn job listings.`);
}

await Actor.exit();
}
