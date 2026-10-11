// OFFLINE only: compare previously captured public HTML with both DOM parsers.
// No HTTP request, Actor run, credentials, proxy, SDK storage or watchlist state.
import fs from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';
import { BLOCK_TEXT_MARKERS } from '../dist/lib.js';
import { extractLinkedInDom } from '../dist/extractors.js';
import { staticHtmlPage } from '../dist/html-page.js';

const folder = resolve('E:/APIFY PROJECT/outputs/portfolio-review-2026-09-30');
const sources = ['linkedin-http-ordinary-local.json', 'linkedin-http-title-local.json',
  'linkedin-http-title-explicit-query-local.json'];
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9);
if (output) {
  const rel = relative(resolve('E:/APIFY PROJECT'), resolve(output));
  if (!rel || rel.startsWith('..') || /^(?:[A-Z]:|\/|\\)/i.test(rel)) throw new Error('Receipt must be inside the named workspace.');
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
let attemptedNetworkRequests = 0;
await context.route('**/*', async route => { attemptedNetworkRequests += 1; await route.abort(); });
const comparisons = [];
try {
  for (const source of sources) {
    const observation = JSON.parse(await fs.readFile(resolve(folder, source), 'utf8'));
    for (const capture of observation.captures) {
      const kind = capture.spec.label === 'search' ? 'search' : 'detail';
      const input = { kind, pageUrl: capture.pageUrl, blockMarkers: BLOCK_TEXT_MARKERS };
      const staticResult = await staticHtmlPage(capture.html, capture.pageUrl).evaluate(extractLinkedInDom, input);
      const page = await context.newPage();
      try {
        await page.setContent(capture.html, { waitUntil: 'domcontentloaded' });
        const browserResult = await page.evaluate(extractLinkedInDom, input);
        const differingFields = [...new Set([...Object.keys(staticResult), ...Object.keys(browserResult)])]
          .filter(field => !isDeepStrictEqual(staticResult[field], browserResult[field]));
        comparisons.push({ source, kind, statusCode: capture.statusCode,
          jobId: capture.spec.userData.jobId ?? null, passed: differingFields.length === 0, differingFields });
      } finally { await page.close(); }
    }
  }
} finally { await context.close(); await browser.close(); }
const failures = comparisons.filter(value => !value.passed);
const result = { checkedAt: new Date().toISOString(),
  note: 'Offline shared-extractor parity on captured HTML. Network disabled and scripts not executed. This is not a browser-rendering or production transport-reliability test. HTTP error captures are not valid job rows.',
  capturesCompared: comparisons.length, passed: comparisons.length - failures.length, failed: failures.length,
  searchCaptures: comparisons.filter(value => value.kind === 'search').length,
  detailCaptures: comparisons.filter(value => value.kind === 'detail').length,
  httpErrorCaptures: comparisons.filter(value => value.statusCode >= 400).length,
  attemptedNetworkRequests, comparisons };
if (output) await fs.writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, comparisons: undefined }, null, 2));
if (failures.length) process.exitCode = 1;
