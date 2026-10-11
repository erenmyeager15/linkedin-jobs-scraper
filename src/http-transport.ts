import type { ActorInput } from './types.js';
import { MAX_STATIC_HTML_BYTES } from './html-page.js';

export const HTTP_SOURCE_LIMIT_MS = 180_000;
export class SourceReadError extends Error {
  constructor(readonly category: string, readonly retryable = false, readonly retryAfterMs: number | null = null) {
    super(`Public job source: ${category}`);
  }
}
export class SourceBudgetStop extends Error {
  constructor(readonly reason: 'budget' | 'time' = 'budget') { super('Source work stopped at the spending/time bound.'); }
}

/** RFC 9110: non-negative integer seconds or an HTTP-date, never raw error text. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number.MAX_SAFE_INTEGER, Number(text) * 1000);
  const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  const obsoleteDate = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
  const asctimeDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
  if (!httpDate.test(text) && !obsoleteDate.test(text) && !asctimeDate.test(text)) return null;
  // HTTP asctime dates are UTC even though their wire format omits the timezone.
  const parsed = Date.parse(asctimeDate.test(text) ? `${text} GMT` : text);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}

/** An explicit paid proxy keeps legacy browser behavior unless HTTP was requested. */
export function resolveTransport(input: ActorInput): 'http' | 'browser' {
  if (input.transport !== undefined && !['http', 'browser'].includes(input.transport)) throw new Error('transport must be http or browser.');
  const proxy = input.proxyConfiguration;
  const explicitProxy = Boolean(proxy?.useApifyProxy || proxy?.proxyUrls?.length);
  const transport = input.transport ?? (explicitProxy ? 'browser' : 'http');
  if (transport === 'http' && explicitProxy) {
    throw new Error('Public HTTP uses direct access only. Select browser for explicit proxy use; no automatic paid fallback is enabled.');
  }
  return transport;
}

export function assertGuestUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || url.username || url.password || url.port
      || !/^\/jobs-guest\/jobs\/api\/(?:seeMoreJobPostings\/search|jobPosting\/\d+)\/?$/.test(url.pathname)) {
    throw new SourceReadError('unsupported_guest_url');
  }
}

export interface GuestReadOptions {
  canContinue: () => boolean;
  deadline: number;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Only public HTML, no cookies, scripts, redirects or proxy credentials. */
export async function readGuestPage(url: string, options: GuestReadOptions): Promise<{ html: string; url: string; status: number; bytes: number }> {
  assertGuestUrl(url);
  const now = options.now ?? Date.now;
  const allowed = () => options.canContinue() && now() < options.deadline;
  const stopped = () => new SourceBudgetStop(now() >= options.deadline ? 'time' : 'budget');
  if (!allowed()) throw stopped();
  const timeoutMs = Math.min(options.timeoutMs ?? 20_000, Math.max(1, options.deadline - now()));
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, { redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PublicJobsMonitor/1.3; +https://apify.com/fascinating_lentil/linkedin-jobs-scraper)', accept: 'text/html,application/xhtml+xml' } });
  } catch { throw allowed() ? new SourceReadError('transport_failed', true) : stopped(); }
  const cancel = async () => { await response.body?.cancel().catch(() => {}); };
  if (!allowed()) { await cancel(); throw stopped(); }
  if (response.status >= 300 || response.status < 200) {
    const retryAfterMs = response.status === 429 || response.status === 503
      ? parseRetryAfter(response.headers.get('retry-after'), now()) : null;
    await cancel(); throw new SourceReadError(`http_${response.status}`, response.status >= 500 && response.status !== 999, retryAfterMs);
  }
  if (!/^text\/html|^application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '')) {
    await cancel(); throw new SourceReadError('unexpected_content_type');
  }
  if (Number(response.headers.get('content-length')) > MAX_STATIC_HTML_BYTES) {
    await cancel(); throw new SourceReadError('html_size_limit');
  }
  if (!response.body) throw new SourceReadError('empty_response_body');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      if (!allowed()) throw stopped();
      const { value, done } = await reader.read();
      if (!allowed()) throw stopped();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_STATIC_HTML_BYTES) throw new SourceReadError('html_size_limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SourceReadError || error instanceof SourceBudgetStop) throw error;
    throw allowed() ? new SourceReadError('body_read_failed', true) : stopped();
  } finally { reader.releaseLock(); }
  return { html: Buffer.concat(chunks).toString('utf8'), url, status: response.status, bytes };
}
