// Read-only, direct-public-source diagnostic: at most one search plus one detail.
// No Actor initialization, proxy, login, credentials, browser or queue.
import fs from 'node:fs/promises';
import { buildInitialRequests, BLOCK_TEXT_MARKERS } from '../dist/lib.js';
import { readGuestPage } from '../dist/http-transport.js';
import { staticHtmlPage } from '../dist/html-page.js';
import { extractLinkedInDom } from '../dist/extractors.js';
const started = Date.now();
const deadline = started + 45_000;
const receipt = { checkedAt: new Date().toISOString(), mode: 'direct-public-http', maximumRequests: 2,
  credentialsSent: false, proxyUsed: false, requests: [], currentAccessVerified: false };
async function check(url, kind) {
  if (receipt.requests.length >= 2) throw new Error('Diagnostic request bound reached');
  const entry = { kind, status: null, bytes: null, usable: false }; receipt.requests.push(entry);
  const source = await readGuestPage(url, { canContinue: () => true, deadline, timeoutMs: 20_000 });
  entry.status = source.status; entry.bytes = source.bytes;
  const parsed = await staticHtmlPage(source.html, url).evaluate(extractLinkedInDom, { kind, pageUrl: url, blockMarkers: BLOCK_TEXT_MARKERS });
  entry.blocked = parsed.blocked;
  entry.usable = !parsed.blocked && (kind === 'search' ? parsed.results.length > 0 : Boolean(parsed.jobTitle && (parsed.companyName || parsed.jobDescription)));
  return parsed;
}
try {
  const [search] = buildInitialRequests({ keywords: ['software engineer'], locations: ['United States'], workplaceType: [], maxResults: 1, maxJobsPerSearch: 1 });
  const parsed = await check(search.url, 'search');
  const first = parsed.results?.find(row => /^\d+$/.test(row.jobId));
  if (receipt.requests[0].usable && first) {
    await check(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${first.jobId}`, 'detail');
    receipt.currentAccessVerified = receipt.requests.every(row => row.usable);
  }
} catch (error) {
  receipt.failureCategory = typeof error.category === 'string' ? error.category : 'direct_access_unavailable';
}
receipt.elapsedSeconds = (Date.now() - started) / 1000;
await fs.writeFile('E:/APIFY PROJECT/outputs/linkedin-jobs-us-monitor-2026-10-11/direct-access.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
