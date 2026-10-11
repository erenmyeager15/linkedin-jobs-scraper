import type { RunBudget } from './lib.js';
import type { ScanTracker } from './scan.js';
import type { JobRecord } from './types.js';

let activeBudget: RunBudget | null = null;
let activeScan: ScanTracker | null = null;
let savedObserver: ((record: JobRecord) => void) | null = null;

export function setScan(scan: ScanTracker, observer: ((record: JobRecord) => void) | null = null): void {
  activeScan = scan;
  savedObserver = observer;
}

export function getScan(): ScanTracker {
  if (!activeScan) throw new Error('Scan tracker was not initialised.');
  return activeScan;
}

export function observeSavedJob(record: JobRecord): void {
  savedObserver?.(record);
}

export function setBudget(budget: RunBudget): void {
  activeBudget = budget;
}

export function getBudget(): RunBudget {
  if (!activeBudget) throw new Error('Run budget was not initialised before crawling started.');
  return activeBudget;
}
