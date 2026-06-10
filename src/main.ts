import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { router } from './routes.js';
import type { ActorInput } from './types.js';

const WORKPLACE_MAP: Record<string, string> = {
  remote: '2',
  hybrid: '3',
  onsite: '1',
};

const JOB_TYPE_MAP: Record<string, string> = {
  'full-time': 'F',
  'part-time': 'P',
  contract: 'C',
  internship: 'I',
  temporary: 'T',
  volunteer: 'V',
};

const EXP_LEVEL_MAP: Record<string, string> = {
  internship: '1',
  entry: '2',
  associate: '3',
  'mid-senior': '4',
  director: '5',
  executive: '6',
};

function buildSearchRequests(input: ActorInput) {
  const maxPerSearch = input.maxJobsPerSearch ?? 50;

  const requests: Array<{
    url: string;
    label: string;
    userData: Record<string, unknown>;
  }> = [];

  for (const keyword of input.keywords) {
    for (const location of input.locations) {
      const params = new URLSearchParams();
      params.set('keywords', keyword);
      params.set('location', location);
      params.set('start', '0');

      if (input.workplaceType?.length) {
        const codes = input.workplaceType
          .map((w) => WORKPLACE_MAP[w.toLowerCase()])
          .filter(Boolean);
        if (codes.length) params.set('f_WT', codes.join(','));
      }

      if (input.jobType?.length) {
        const codes = input.jobType
          .map((j) => JOB_TYPE_MAP[j.toLowerCase()])
          .filter(Boolean);
        if (codes.length) params.set('f_JT', codes.join(','));
      }

      if (input.experienceLevel?.length) {
        const codes = input.experienceLevel
          .map((e) => EXP_LEVEL_MAP[e.toLowerCase()])
          .filter(Boolean);
        if (codes.length) params.set('f_E', codes.join(','));
      }

      // LinkedIn's public guest endpoint returns job-card HTML without login.
      requests.push({
        url: `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`,
        label: 'search',
        userData: {
          keyword,
          location,
          maxResults: maxPerSearch,
          start: 0,
        },
      });
    }
  }

  return requests;
}

await Actor.init();

const input = await Actor.getInput<ActorInput>();
if (!input) throw new Error('Input is required');

const { maxResults = 500 } = input;

const proxyConfig = await Actor.createProxyConfiguration({
  ...(input.proxyConfiguration ?? {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
  }),
});

const crawler = new PlaywrightCrawler({
  requestHandler: router,
  proxyConfiguration: proxyConfig,
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
  maxRequestsPerCrawl: maxResults * 2 + input.keywords.length * input.locations.length,
  preNavigationHooks: [
    async ({ page }) => {
      const delay = 1500 + Math.random() * 2500;
      await new Promise((r) => setTimeout(r, delay));
    },
  ],
  postNavigationHooks: [
    async ({ page }) => {
      // Guest API fragments have no cookie banner; keep this fast and best-effort.
      try {
        const btn = await page.waitForSelector(
          'button:has-text("Accept all"), button:has-text("Accept")',
          { timeout: 1500 }
        );
        if (btn) {
          await btn.click();
          await page.waitForTimeout(500);
        }
      } catch {
        /* cookie banner may not appear */
      }
    },
  ],
  failedRequestHandler: async ({ request, log }) => {
    log.error(`Request failed after retries: ${request.url}`, {
      errors: request.errorMessages,
    });
  },
});

const initialRequests = buildSearchRequests(input);
await crawler.run(initialRequests);

log.info('Scraping complete.');

await Actor.exit();
