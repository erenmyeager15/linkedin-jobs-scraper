import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { router } from './routes.js';
import {
  buildSearchRequests,
  createBudget,
  maxRequestsForRun,
  releaseEnqueued,
  resolveLimits,
  searchKey,
  shouldAllowResource,
} from './lib.js';
import { setBudget } from './state.js';
import type { ActorInput } from './types.js';

await Actor.init();

const input = await Actor.getInput<ActorInput>();
if (!input) throw new Error('Input is required.');
if (!input.keywords?.length) throw new Error('At least one job keyword is required.');
if (!input.locations?.length) throw new Error('At least one location is required.');

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

const searchRequests = buildSearchRequests(input, limits);

log.info('Starting LinkedIn jobs scrape', {
  searches: searchRequests.length,
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
  maxConcurrency: 5,
  // Sized for real offset paging so Crawlee never silently drops queued requests.
  maxRequestsPerCrawl: maxRequestsForRun(limits, searchRequests.length),
  preNavigationHooks: [
    async ({ page }) => {
      // Fetch only the HTML document. Scripts and stylesheets are megabytes of
      // residential bandwidth per page and hold none of the extracted data.
      await page.route('**/*', async (route) => {
        if (shouldAllowResource(route.request().resourceType())) {
          await route.continue().catch(() => { /* navigation already settled */ });
        } else {
          await route.abort().catch(() => { /* navigation already settled */ });
        }
      }).catch(() => { /* best effort */ });
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 900));
    },
  ],
  failedRequestHandler: async ({ request, session, log: ctxLog }) => {
    session?.retire();

    // A detail page that never became a record must return its budget slot, so a
    // permanent failure does not quietly reduce the number of jobs delivered.
    if (request.label === 'job-detail') {
      const { keyword, location } = request.userData as { keyword?: string; location?: string };
      if (keyword && location) releaseEnqueued(budget, searchKey(keyword, location));
    }

    ctxLog.error(`Request failed after retries: ${request.url}`, {
      errors: request.errorMessages,
    });
  },
});

await crawler.run(searchRequests);

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
    'No job listings matched this search. Try broader keywords or locations, or enable Apify Proxy (residential).',
  );
} else {
  await Actor.setStatusMessage(`Saved ${budget.pushed} LinkedIn job listings.`);
}

await Actor.exit();
