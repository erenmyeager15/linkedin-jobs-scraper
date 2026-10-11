import { matchesWorkplace, resolveWorkplace, type WorkplaceType } from './workplace.js';

export interface TitleDiscovery {
  strategy: 'title-supported-workplace';
  maxSearchPages: number;
  pageNumber: number;
}

/** Experimental/local only. The normal Actor input does not enable this strategy. */
export function titleDiscovery(maxSearchPages: number): TitleDiscovery {
  if (!Number.isInteger(maxSearchPages) || maxSearchPages < 1 || maxSearchPages > 50) {
    throw new Error('Title-supported discovery permits 1-50 search pages.');
  }
  return { strategy: 'title-supported-workplace', maxSearchPages, pageNumber: 1 };
}

export function validateDiscovery(value: TitleDiscovery, requested: WorkplaceType[]): void {
  if (value.strategy !== 'title-supported-workplace' || !requested.length) throw new Error('Title discovery requires an explicit workplace filter.');
  titleDiscovery(value.maxSearchPages);
  if (!Number.isInteger(value.pageNumber) || value.pageNumber < 1 || value.pageNumber > value.maxSearchPages) throw new Error('Invalid discovery page number.');
}

export function titleSupportsWorkplace(card: { jobTitle: string | null; jobLocation: string | null }, requested: WorkplaceType[]): boolean {
  return requested.length > 0 && matchesWorkplace(resolveWorkplace({ title: card.jobTitle, location: card.jobLocation }), requested);
}

export function nextDiscovery(value: TitleDiscovery): TitleDiscovery | null {
  return value.pageNumber < value.maxSearchPages ? { ...value, pageNumber: value.pageNumber + 1 } : null;
}
