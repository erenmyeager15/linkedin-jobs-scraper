import { createHash } from 'node:crypto';
import { buildInitialRequests, canonicalJobUrl, hasUsableJobData, resolveLimits } from './lib.js';
import type { ActorInput, JobRecord } from './types.js';
import type { ScanSummary } from './scan.js';

export const WATCHLIST_STATE_KEY = 'LINKEDIN-JOBS-WATCHLIST';
export const CHANGE_REPORT_KEY = 'JOB-CHANGES';
export const CHANGE_CSV_KEY = 'JOB-CHANGES-CSV';
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_FIELD_LENGTH = 1000;
const MAX_SKILLS = 100;
const MAX_SKILL_CHARS = 4000;
export const TRACKED_FIELDS = [
  'jobTitle', 'companyName', 'jobLocation', 'workplaceType', 'jobType', 'experienceLevel',
  'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'requiredSkills', 'applyUrl',
] as const;
export type TrackedField = typeof TRACKED_FIELDS[number];
export type WatchlistRecord = Pick<JobRecord, TrackedField | 'jobId' | 'scrapedAt' | 'jobDescription'>;
export type FieldValue = string | number | string[];
type Values = Partial<Record<TrackedField, FieldValue>>;
type FieldTimes = Partial<Record<TrackedField, string>>;
const SALARY_FIELDS: TrackedField[] = ['salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod'];
const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const KNOWN_PAY_PERIODS = new Set(['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR']);

export interface WatchlistOptions {
  name: string;
  retentionDays: number;
  maxStoredJobs: number;
  scopeId: string;
}

interface JobSnapshot {
  jobId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  values: Values;
  fieldObservedAt: FieldTimes;
}

export interface FieldChange {
  field: TrackedField;
  previous: FieldValue;
  current: FieldValue;
  previousObservedAt: string;
  observedAt: string;
}

export interface JobObservation {
  jobId: string;
  jobUrl: string;
  jobTitle: string | null;
  companyName: string | null;
  status: 'baseline' | 'newly_observed' | 'updated' | 'unchanged';
  firstSeenAt: string;
  lastSeenAt: string;
  changes: FieldChange[];
  newlyAvailableFields: TrackedField[];
  unavailableFields: TrackedField[];
  incomparableFields: TrackedField[];
}

export interface ChangeReport {
  schemaVersion: 1;
  watchlistName: string;
  scopeId: string;
  runId: string;
  startedAt: string;
  generatedAt: string;
  status: 'initialized' | 'compared' | 'incomplete' | 'concurrent_run' | 'stale_scan' | 'storage_error' | 'commit_unknown' | 'prepared';
  baselineCommitted: boolean;
  replayed: boolean;
  reason: string | null;
  counts: { observed: number; newlyObserved: number; updated: number; unchanged: number; retained: number; evicted: number };
  retention: { days: number; maxStoredJobs: number };
  scan: ScanSummary;
  observations: JobObservation[];
}

export interface WatchlistState {
  schemaVersion: 1;
  scopeId: string;
  initializedAt: string;
  lastStartedAt: string;
  lastRunId: string;
  revision: number;
  jobs: JobSnapshot[];
  lastReport: ChangeReport;
}

export interface WatchlistStorage {
  read(): Promise<unknown>;
  acquireLock(): Promise<string | null>;
  assertLock(lockId: string): Promise<void>;
  releaseLock(lockId: string): Promise<void>;
  write(state: WatchlistState): Promise<void>;
  publish(report: ChangeReport): Promise<void>;
}

export interface WatchlistScan {
  options: WatchlistOptions;
  runId: string;
  startedAt: string;
  now: string;
  records: WatchlistRecord[];
  summary: ScanSummary;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Keep descriptions, logos and other unmonitored content out of the in-memory watchlist. */
export function projectWatchlistRecord(record: JobRecord): WatchlistRecord {
  const projected: Record<string, unknown> = {
    jobId: record.jobId, scrapedAt: record.scrapedAt,
    jobDescription: record.jobDescription ? 'Public description was present.' : null,
  };
  for (const field of TRACKED_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') projected[field] = value.slice(0, MAX_FIELD_LENGTH + 1);
    else if (Array.isArray(value)) projected[field] = value.length > MAX_SKILLS || value.join('').length > MAX_SKILL_CHARS
      ? [] : [...value];
    else projected[field] = value;
  }
  return projected as unknown as WatchlistRecord;
}

export function resolveWatchlistOptions(input: ActorInput): WatchlistOptions | null {
  if (input.watchlistName === undefined || input.watchlistName === '') return null;
  if (typeof input.watchlistName !== 'string') throw new Error('watchlistName must be a string.');
  const name = input.watchlistName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('watchlistName must contain 1-64 letters, digits, underscores or hyphens, starting with a letter or digit.');
  }
  const integer = (value: unknown, fallback: number, maximum: number, field: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
      throw new Error(`${field} must be an integer between 1 and ${maximum}.`);
    }
    return Number(value);
  };
  const scope = {
    source: 'linkedin-public-jobs-v2-workplace-evidence',
    // Input order is retained because a global result cap can favour earlier searches.
    seeds: buildInitialRequests(input).map((request) => {
      const url = new URL(request.url);
      url.searchParams.sort();
      return { mode: request.label, url: url.toString() };
    }),
    limits: resolveLimits(input),
  };
  return {
    name, scopeId: hash(scope),
    retentionDays: integer(input.watchlistRetentionDays, 30, 90, 'watchlistRetentionDays'),
    maxStoredJobs: integer(input.watchlistMaxJobs, 1000, 5000, 'watchlistMaxJobs'),
  };
}

function normalizeValue(field: TrackedField, value: unknown): FieldValue | undefined {
  if (field === 'salaryMin' || field === 'salaryMax') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (field === 'requiredSkills') {
    if (!Array.isArray(value) || !value.length || value.length > MAX_SKILLS) return undefined;
    const values = value.map((item) => typeof item === 'string' ? item.replace(/\s+/g, ' ').trim() : '');
    if (values.some((item) => !item || item.length > MAX_FIELD_LENGTH) || values.join('').length > MAX_SKILL_CHARS) return undefined;
    return [...new Set(values.map((item) => item.toLowerCase()))].sort();
  }
  if (typeof value !== 'string') return undefined;
  let normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > MAX_FIELD_LENGTH) return undefined;
  // A dollar sign alone cannot distinguish USD, CAD, AUD and other currencies.
  if (field === 'salaryCurrency') return KNOWN_CURRENCIES.has(normalized.toUpperCase()) ? normalized.toUpperCase() : undefined;
  if (field === 'salaryPeriod') return KNOWN_PAY_PERIODS.has(normalized.toUpperCase()) ? normalized.toUpperCase() : undefined;
  if (field === 'applyUrl') {
    try {
      const url = new URL(normalized);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^utm_/i.test(key) || ['trk', 'trackingId', 'refId'].includes(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      normalized = url.toString();
    } catch { return undefined; }
  }
  return normalized.length <= MAX_FIELD_LENGTH ? normalized : undefined;
}

function snapshot(record: WatchlistRecord): JobSnapshot {
  const values: Values = {};
  const fieldObservedAt: FieldTimes = {};
  for (const field of TRACKED_FIELDS) {
    const value = normalizeValue(field, record[field]);
    if (value !== undefined) { values[field] = value; fieldObservedAt[field] = record.scrapedAt; }
  }
  // Numeric salary comparisons need both currency and period. Never attach a new
  // amount to a retained old currency/period when today's units are unavailable.
  if (values.salaryCurrency === undefined || values.salaryPeriod === undefined) {
    for (const field of SALARY_FIELDS) { delete values[field]; delete fieldObservedAt[field]; }
  }
  return { jobId: record.jobId, firstSeenAt: record.scrapedAt, lastSeenAt: record.scrapedAt, values, fieldObservedAt };
}

function equal(field: TrackedField, left: FieldValue, right: FieldValue): boolean {
  if (typeof left === 'string' && typeof right === 'string' && field !== 'applyUrl') return left.toLowerCase() === right.toLowerCase();
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Invalid or incompatible state fails closed instead of silently resetting a baseline. */
export function readWatchlistState(value: unknown, scopeId: string): WatchlistState | null {
  if (value === null || value === undefined) return null;
  const invalid = (): never => { throw new Error('Saved job watchlist state is invalid. Restore it or use a new watchlistName.'); };
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES) invalid();
  const state = value as WatchlistState;
  if (state.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(state.scopeId)) invalid();
  if (state.scopeId !== scopeId) throw new Error('Watchlist search inputs or limits changed. Use a new watchlistName to start a separate baseline.');
  if (!iso(state.initializedAt) || !iso(state.lastStartedAt) || !state.lastRunId
    || !Number.isInteger(state.revision) || state.revision < 1 || !Array.isArray(state.jobs) || state.jobs.length > 5000
    || state.lastReport?.schemaVersion !== 1 || state.lastReport.scopeId !== scopeId
    || state.lastReport.runId !== state.lastRunId || !state.lastReport.baselineCommitted
    || !['initialized', 'compared'].includes(state.lastReport.status) || !Array.isArray(state.lastReport.observations)
    || state.lastReport.observations.length > 5000 || !iso(state.lastReport.generatedAt)
    || state.lastReport.startedAt !== state.lastStartedAt || state.lastStartedAt > state.lastReport.generatedAt) invalid();
  const ids = new Set<string>();
  for (const job of state.jobs) {
    if (!job || !/^\d{6,}$/.test(job.jobId) || ids.has(job.jobId) || !iso(job.firstSeenAt)
      || !iso(job.lastSeenAt) || job.firstSeenAt > job.lastSeenAt || job.lastSeenAt > state.lastReport.generatedAt
      || !job.values || !job.fieldObservedAt) invalid();
    ids.add(job.jobId);
    for (const [field, fieldValue] of Object.entries(job.values)) {
      if (!TRACKED_FIELDS.includes(field as TrackedField)
        || normalizeValue(field as TrackedField, fieldValue) === undefined
        || !iso(job.fieldObservedAt[field as TrackedField])
        || job.fieldObservedAt[field as TrackedField]! < job.firstSeenAt
        || job.fieldObservedAt[field as TrackedField]! > job.lastSeenAt) invalid();
    }
    if ((job.values.salaryMin !== undefined || job.values.salaryMax !== undefined)
      && (job.values.salaryCurrency === undefined || job.values.salaryPeriod === undefined)) invalid();
  }
  const observationIds = new Set<string>();
  for (const observation of state.lastReport.observations) {
    if (!observation || !/^\d{6,}$/.test(observation.jobId) || observationIds.has(observation.jobId)
      || observation.jobUrl !== canonicalJobUrl(observation.jobId)
      || !iso(observation.firstSeenAt) || !iso(observation.lastSeenAt)
      || observation.firstSeenAt > observation.lastSeenAt || observation.lastSeenAt > state.lastReport.generatedAt
      || !['baseline', 'newly_observed', 'updated', 'unchanged'].includes(observation.status)
      || !Array.isArray(observation.changes) || observation.changes.length > TRACKED_FIELDS.length) invalid();
    observationIds.add(observation.jobId);
    for (const change of observation.changes) {
      if (!TRACKED_FIELDS.includes(change.field) || normalizeValue(change.field, change.previous) === undefined
        || normalizeValue(change.field, change.current) === undefined || !iso(change.previousObservedAt) || !iso(change.observedAt)
        || change.previousObservedAt > change.observedAt || change.observedAt > observation.lastSeenAt) invalid();
    }
    for (const fields of [observation.newlyAvailableFields, observation.unavailableFields, observation.incomparableFields]) {
      if (!Array.isArray(fields) || fields.length > TRACKED_FIELDS.length || fields.some((field) => !TRACKED_FIELDS.includes(field))) invalid();
    }
  }
  return state;
}

export function emptyReport(scan: WatchlistScan, status: ChangeReport['status'], reason: string | null = null): ChangeReport {
  return {
    schemaVersion: 1, watchlistName: scan.options.name, scopeId: scan.options.scopeId,
    runId: scan.runId, startedAt: scan.startedAt, generatedAt: scan.now,
    status, baselineCommitted: false, replayed: false, reason,
    counts: { observed: scan.records.length, newlyObserved: 0, updated: 0, unchanged: 0, retained: 0, evicted: 0 },
    retention: { days: scan.options.retentionDays, maxStoredJobs: scan.options.maxStoredJobs },
    scan: structuredClone(scan.summary), observations: [],
  };
}

export function compareWatchlist(scan: WatchlistScan, previous: WatchlistState | null): { state: WatchlistState; report: ChangeReport } {
  if (!iso(scan.startedAt) || !iso(scan.now) || scan.startedAt > scan.now) throw new Error('Invalid watchlist scan times.');
  if (previous && previous.scopeId !== scan.options.scopeId) throw new Error('Watchlist scope mismatch.');
  const cutoff = new Date(Date.parse(scan.now) - scan.options.retentionDays * 86_400_000).toISOString();
  const retained = (previous?.jobs ?? []).filter((job) => job.lastSeenAt >= cutoff).map((job) => structuredClone(job));
  for (const job of retained) {
    for (const field of TRACKED_FIELDS) {
      if ((job.fieldObservedAt[field] ?? '') < cutoff) { delete job.values[field]; delete job.fieldObservedAt[field]; }
    }
  }
  const jobs = new Map(retained.map((job) => [job.jobId, job]));
  const report = emptyReport(scan, previous ? 'compared' : 'initialized');
  const currentIds = new Set<string>();
  for (const record of [...scan.records].sort((a, b) => a.jobId.localeCompare(b.jobId))) {
    if (!/^\d{6,}$/.test(record.jobId) || !iso(record.scrapedAt) || record.scrapedAt < scan.startedAt
      || record.scrapedAt > scan.now || !hasUsableJobData(record) || currentIds.has(record.jobId)) {
      throw new Error('Invalid or duplicate watchlist observation.');
    }
    currentIds.add(record.jobId);
    const current = snapshot(record);
    const old = jobs.get(record.jobId);
    const changes: FieldChange[] = [];
    const newlyAvailableFields: TrackedField[] = [];
    const incomparableFields: TrackedField[] = [];
    const salaryComparable = old && old.values.salaryCurrency !== undefined && old.values.salaryPeriod !== undefined
      && current.values.salaryCurrency !== undefined && current.values.salaryPeriod !== undefined
      && equal('salaryCurrency', old.values.salaryCurrency, current.values.salaryCurrency)
      && equal('salaryPeriod', old.values.salaryPeriod, current.values.salaryPeriod);
    for (const field of TRACKED_FIELDS) {
      const before = old?.values[field];
      const after = current.values[field];
      if (after === undefined) continue;
      if (before === undefined) { if (old) newlyAvailableFields.push(field); continue; }
      if ((field === 'salaryMin' || field === 'salaryMax') && !salaryComparable) { incomparableFields.push(field); continue; }
      if (!equal(field, before, after)) changes.push({ field, previous: before, current: after,
        previousObservedAt: old!.fieldObservedAt[field]!, observedAt: record.scrapedAt });
    }
    const status: JobObservation['status'] = !previous ? 'baseline' : !old ? 'newly_observed' : changes.length ? 'updated' : 'unchanged';
    if (status === 'newly_observed') report.counts.newlyObserved += 1;
    if (status === 'updated') report.counts.updated += 1;
    if (status === 'unchanged') report.counts.unchanged += 1;
    report.observations.push({ jobId: record.jobId, jobUrl: canonicalJobUrl(record.jobId),
      jobTitle: record.jobTitle, companyName: record.companyName, status,
      firstSeenAt: old?.firstSeenAt ?? record.scrapedAt, lastSeenAt: record.scrapedAt, changes,
      newlyAvailableFields, unavailableFields: TRACKED_FIELDS.filter((field) => current.values[field] === undefined), incomparableFields });
    const carriedValues = { ...old?.values };
    const carriedTimes = { ...old?.fieldObservedAt };
    if (current.values.salaryCurrency !== undefined && current.values.salaryPeriod !== undefined && !salaryComparable) {
      for (const field of SALARY_FIELDS) { delete carriedValues[field]; delete carriedTimes[field]; }
    }
    jobs.set(record.jobId, { ...current, firstSeenAt: old?.firstSeenAt ?? current.firstSeenAt,
      values: { ...carriedValues, ...current.values }, fieldObservedAt: { ...carriedTimes, ...current.fieldObservedAt } });
  }
  const candidates = [...jobs.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.jobId.localeCompare(b.jobId));
  const savedJobs = candidates.slice(0, scan.options.maxStoredJobs);
  report.counts.retained = savedJobs.length;
  report.counts.evicted = (previous?.jobs.length ?? 0) - retained.length + candidates.length - savedJobs.length;
  report.baselineCommitted = true;
  const state: WatchlistState = { schemaVersion: 1, scopeId: scan.options.scopeId,
    initializedAt: previous?.initializedAt ?? scan.now, lastStartedAt: scan.startedAt, lastRunId: scan.runId,
    revision: (previous?.revision ?? 0) + 1, jobs: savedJobs, lastReport: report };
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw new Error('Watchlist exceeds its state-size limit.');
  return { state, report };
}

/** Prepare outputs before committing, serialize writers, and preserve ambiguous write outcomes. */
export async function finishWatchlist(scan: WatchlistScan, storage: WatchlistStorage): Promise<ChangeReport> {
  let lockId: string | null = null;
  let writeStarted = false;
  let committedReport: ChangeReport | null = null;
  try {
    lockId = await storage.acquireLock();
    if (!lockId) {
      const report = emptyReport(scan, 'concurrent_run', 'Another run owns the watchlist writer lease.');
      await storage.publish(report);
      return report;
    }
    const previous = readWatchlistState(await storage.read(), scan.options.scopeId);
    if (previous?.lastRunId === scan.runId) {
      const report = { ...structuredClone(previous.lastReport), replayed: true };
      await storage.publish(report);
      return report;
    }
    if (!scan.summary.boundedObservationComplete || !scan.records.length || scan.records.length !== scan.summary.jobsSaved) {
      const report = emptyReport(scan, 'incomplete', 'Observation batch was incomplete; no baseline advancement.');
      await storage.publish(report);
      return report;
    }
    if (previous && scan.startedAt <= previous.lastStartedAt) {
      const report = emptyReport(scan, 'stale_scan', 'A newer or equally dated scan is already committed.');
      await storage.publish(report);
      return report;
    }
    const { state, report } = compareWatchlist(scan, previous);
    await storage.assertLock(lockId);
    await storage.publish({ ...report, status: 'prepared', baselineCommitted: false });
    await storage.assertLock(lockId);
    writeStarted = true;
    await storage.write(state);
    committedReport = report;
    await storage.publish(report);
    return report;
  } catch {
    if (committedReport) {
      // The committed state retains the report for replay if final output publishing fails.
      const report = { ...committedReport, reason: 'Baseline committed; final report publishing needs replay.' };
      await storage.publish(report).catch(() => undefined);
      return report;
    }
    const report = emptyReport(scan, writeStarted ? 'commit_unknown' : 'storage_error',
      writeStarted ? 'State write outcome is unknown. Retry this run or inspect saved state before scheduling another.'
        : 'Watchlist storage or validation failed; no state write was attempted.');
    await storage.publish(report).catch(() => undefined);
    return report;
  } finally {
    if (lockId) await storage.releaseLock(lockId).catch(() => undefined);
  }
}

/** Fixed columns, proper quoting, and formula-neutralization for spreadsheet imports. */
export function changeReportCsv(report: ChangeReport): string {
  const columns = ['reportStatus', 'baselineCommitted', 'jobId', 'jobUrl', 'jobTitle', 'companyName', 'observationStatus',
    'firstSeenAt', 'lastSeenAt', 'field', 'previous', 'current', 'previousObservedAt', 'observedAt',
    'newlyAvailableFields', 'unavailableFields', 'incomparableFields'];
  const cell = (value: unknown): string => {
    let text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = report.observations.flatMap((item) => (item.changes.length ? item.changes : [null]).map((change) => [
    report.status, report.baselineCommitted, item.jobId, item.jobUrl, item.jobTitle, item.companyName, item.status,
    item.firstSeenAt, item.lastSeenAt, change?.field, change?.previous, change?.current,
    change?.previousObservedAt, change?.observedAt, item.newlyAvailableFields, item.unavailableFields, item.incomparableFields,
  ].map(cell).join(',')));
  return [columns.join(','), ...rows].join('\r\n') + '\r\n';
}
