import { DOMParser } from 'linkedom';
import type { Page } from 'playwright';
import { extractLinkedInDom, type DomExtractionInput } from './extractors.js';

export const MAX_STATIC_HTML_BYTES = 2 * 1024 * 1024;

/** Narrow adapter for the two shared read-only extractors, not a browser emulator. */
export function staticHtmlPage(html: string, pageUrl: string): Pick<Page, 'url' | 'evaluate'> {
  if (Buffer.byteLength(html, 'utf8') > MAX_STATIC_HTML_BYTES) throw new Error('Static HTML exceeds the parsing limit.');
  if (!/^https?:$/.test(new URL(pageUrl).protocol)) throw new Error('Static HTML needs an HTTP(S) source URL.');
  const fullHtml = /<html(?:\s|>)/i.test(html) ? html : `<html><body>${html}</body></html>`;
  const document = new DOMParser().parseFromString(fullHtml, 'text/html') as unknown as Document;
  return {
    url: () => pageUrl,
    evaluate: async (fn: unknown, argument: DomExtractionInput) => {
      if (fn !== extractLinkedInDom) throw new Error('Static HTML adapter supports only the shared job extractor.');
      return extractLinkedInDom({ ...argument, pageUrl, document,
        DOMParser: DOMParser as unknown as typeof globalThis.DOMParser });
    },
  } as unknown as Pick<Page, 'url' | 'evaluate'>;
}
