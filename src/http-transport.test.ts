import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_STATIC_HTML_BYTES } from './html-page.js';
import { assertGuestUrl, parseRetryAfter, readGuestPage, resolveTransport, SourceBudgetStop, SourceReadError } from './http-transport.js';

const url = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1234567890';
const options = { canContinue: () => true, deadline: Date.now() + 60_000 };
const fetchResponse = (response: Response): typeof fetch => async () => response;
const htmlResponse = (body: string, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

test('direct HTTP defaults do not silently consume a paid proxy; explicit legacy proxy selects browser', () => {
  assert.equal(resolveTransport({}), 'http');
  assert.equal(resolveTransport({ proxyConfiguration: { useApifyProxy: false } }), 'http');
  assert.equal(resolveTransport({ proxyConfiguration: { useApifyProxy: true } }), 'browser');
  assert.equal(resolveTransport({ proxyConfiguration: { proxyUrls: ['http://example.test:1234'] } }), 'browser');
  assert.throws(() => resolveTransport({ transport: 'http', proxyConfiguration: { useApifyProxy: true } }), /direct access only/);
  assert.throws(() => resolveTransport({ transport: 'http', proxyConfiguration: { proxyUrls: ['http://example.test:1234'] } }), /direct access only/);
  assert.throws(() => resolveTransport({ transport: 'other' as 'http' }), /must be/);
});

test('source reader only accepts canonical public guest job endpoints', () => {
  assert.doesNotThrow(() => assertGuestUrl(url));
  assert.doesNotThrow(() => assertGuestUrl('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=engineer&start=10'));
  for (const value of ['http://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1', 'https://linkedin.com.evil.test/jobs-guest/jobs/api/jobPosting/1',
    'https://user:password@www.linkedin.com/jobs-guest/jobs/api/jobPosting/1', 'https://www.linkedin.com/voyager/api/me', 'file:///etc/passwd']) {
    assert.throws(() => assertGuestUrl(value), SourceReadError);
  }
});

test('HTML read disables redirects and cookies and accurately counts multibyte HTML', async () => {
  const body = '<h1>Engineer – US</h1>';
  const result = await readGuestPage(url, { ...options, fetcher: async (requested, init) => {
    assert.equal(requested, url); assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).cookie, undefined);
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    assert.ok(init?.signal); return htmlResponse(body);
  } });
  assert.equal(result.html, body); assert.equal(result.bytes, Buffer.byteLength(body)); assert.equal(result.status, 200);
});

test('exhausted spending and expired source time prevent even one fetch', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return htmlResponse('unused'); };
  await assert.rejects(readGuestPage(url, { ...options, canContinue: () => false, fetcher }), SourceBudgetStop);
  await assert.rejects(readGuestPage(url, { ...options, deadline: 10, now: () => 10, fetcher }), SourceBudgetStop);
  assert.equal(calls, 0);
});

test('spending allowance lost while fetching cancels the body before parsing', async () => {
  let allowed = true; let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } });
  await assert.rejects(readGuestPage(url, { ...options, canContinue: () => allowed,
    fetcher: async () => { allowed = false; return response; } }), SourceBudgetStop);
  assert.equal(cancelled, true);
});

test('redirects, rate limits and blocked statuses have no automatic retry/fallback', async () => {
  for (const status of [302, 401, 403, 429, 999]) {
    const response = new Response('blocked', { status: status === 999 ? 403 : status });
    if (status === 999) Object.defineProperty(response, 'status', { value: 999 });
    await assert.rejects(readGuestPage(url, { ...options, fetcher: fetchResponse(response) }),
      (error: unknown) => error instanceof SourceReadError && error.category === `http_${status}` && !error.retryable);
  }
  await assert.rejects(readGuestPage(url, { ...options, fetcher: fetchResponse(new Response('temporary', { status: 503 })) }),
    (error: unknown) => error instanceof SourceReadError && error.retryable);
});

test('untrusted content type, declared oversize and streamed oversize are rejected', async () => {
  await assert.rejects(readGuestPage(url, { ...options, fetcher: fetchResponse(new Response('{}', { headers: { 'content-type': 'application/json' } })) }), /unexpected_content_type/);
  await assert.rejects(readGuestPage(url, { ...options, fetcher: fetchResponse(htmlResponse('tiny', { 'content-length': String(MAX_STATIC_HTML_BYTES + 1) })) }), /html_size_limit/);
  await assert.rejects(readGuestPage(url, { ...options, fetcher: fetchResponse(htmlResponse('x'.repeat(MAX_STATIC_HTML_BYTES + 1))) }), /html_size_limit/);
});

test('network failure messages never expose request secrets', async () => {
  await assert.rejects(readGuestPage(url, { ...options, fetcher: async () => { throw new Error('secret token in raw connection error'); } }),
    (error: unknown) => error instanceof SourceReadError && error.message === 'Public job source: transport_failed' && error.retryable);
});

test('Retry-After accepts integer seconds and all HTTP date formats, not arbitrary numeric dates', () => {
  const now = Date.parse('Sun, 06 Nov 1994 08:49:00 GMT');
  for (const header of ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) {
    assert.equal(parseRetryAfter(header, now), 37_000);
  }
  assert.equal(parseRetryAfter(' 12 ', now), 12_000);
  assert.equal(parseRetryAfter('0', now), 0);
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:48:00 GMT', now), 0);
  for (const header of [null, '', '-1', '1.5', '1e3', 'secret-token', '12, 30']) {
    assert.equal(parseRetryAfter(header, now), null);
  }
  assert.equal(parseRetryAfter('9'.repeat(400), now), Number.MAX_SAFE_INTEGER, 'Oversized delays must not be ignored and retried early.');
});

test('rate-limit and service-unavailable responses retain safe retry timing and discard bodies', async () => {
  for (const status of [429, 503]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status, headers: { 'retry-after': '12', 'content-type': 'text/html' },
    });
    await assert.rejects(readGuestPage(url, { ...options, fetcher: fetchResponse(response) }),
      (error: unknown) => error instanceof SourceReadError && error.category === `http_${status}` && error.retryAfterMs === 12_000);
    assert.equal(cancelled, true);
  }
});
