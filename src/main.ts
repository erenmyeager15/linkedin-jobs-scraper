import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
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
import { setBudget } from './state.js';
import type { ActorInput } from './types.js';

await Actor.init();

const input = await Actor.getInput<ActorInput>();
if (!input) throw new Error('Input is required.');
validateInputModes(input);

const limits = resolveLimits(input);
const budget = createBudget(limits);
setBudget(budget);

const proxyConfiguration = await Actor.createProxyConfiguration(
  input.proxyConfiguration ?? {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
  },
);

if (!proxyConfiguration) {
  log.warning(
    'Running without Apify Proxy. LinkedIn blocks datacenter IPs, so results are likely to be empty.',
  );
}

const plannedRequests = buildInitialRequests(input);
const initialRequests = plannedRequests.filter((request) => {
  if (request.label !== 'job-detail') return true;
  return reserveJob(budget, request.userData.searchId, request.userData.jobId);
});
const searchCount = initialRequests.filter((request) => request.label === 'search').length;
const directJobCount = initialRequests.filter((request) => request.label === 'job-detail').length;

log.info('Starting LinkedIn jobs scrape', {
  searches: searchCount,
  directJobs: directJobCount,
  maxResults: limits.maxResults,
  maxJobsPerSearch: limits.maxJobsPerSearch,
});

const crawler = new PlaywrightCrawler({
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
    async ({ page }, gotoOptions) => {
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

    ctxLog.error(`Request failed after retries: ${request.url}`, {
      errors: request.errorMessages,
    });
  },
});

await crawler.run(initialRequests);

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

if (budget.stopReason === 'charge-limit') {
  await Actor.setStatusMessage(
    `Stopped at the run's spending limit after saving ${budget.pushed} jobs.`,
  );
} else if (budget.pushed === 0) {
  await Actor.setStatusMessage(
    'No job listings were saved. Try broader search terms or URLs, or enable Apify Proxy (residential).',
  );
} else {
  await Actor.setStatusMessage(`Saved ${budget.pushed} LinkedIn job listings.`);
}

await Actor.exit();
