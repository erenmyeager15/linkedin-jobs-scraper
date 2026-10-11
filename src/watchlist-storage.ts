import { Actor } from 'apify';
import { createHash, randomUUID } from 'node:crypto';
import { CHANGE_CSV_KEY, CHANGE_REPORT_KEY, WATCHLIST_STATE_KEY, changeReportCsv, type WatchlistStorage } from './watchlist.js';

/** API-owned queue lease serializes state writers; its dummy URL is never crawled. */
export async function openWatchlistStorage(name: string): Promise<WatchlistStorage> {
  if (!Actor.isAtHome()) {
    throw new Error('Saved job watchlists require an Apify platform run. Omit watchlistName for local scraping; local watchlist tests use injected storage.');
  }
  const client = Actor.newClient({ maxRetries: 0, timeoutSecs: 30 });
  const suffix = createHash('sha256').update(name).digest('hex').slice(0, 32);
  const store = await client.keyValueStores().getOrCreate(`linkedin-jobs-watch-${suffix}`);
  const queue = await client.requestQueues().getOrCreate(`linkedin-jobs-watch-lock-${suffix}`);
  const queueClient = client.requestQueue(queue.id, { clientKey: randomUUID().replace(/-/g, '') });
  const item = await queueClient.addRequest({ uniqueKey: 'linkedin-jobs-watch-writer-v1', url: 'https://www.linkedin.com/jobs/' });
  if (item.wasAlreadyHandled) throw new Error('Watchlist lock item was marked handled. Use a new watchlistName or restore its pending state.');
  const storeClient = client.keyValueStore(store.id);
  const defaultStoreId = Actor.getEnv().defaultKeyValueStoreId;
  if (!defaultStoreId) throw new Error('Run output store is unavailable.');
  const outputClient = client.keyValueStore(defaultStoreId);
  return {
    async read() { return (await storeClient.getRecord(WATCHLIST_STATE_KEY))?.value ?? null; },
    async acquireLock() {
      const result = await queueClient.listAndLockHead({ lockSecs: 300, limit: 1 });
      return result.items.find((entry) => entry.id === item.requestId)?.id ?? null;
    },
    async assertLock(lockId) { await queueClient.prolongRequestLock(lockId, { lockSecs: 300 }); },
    async releaseLock(lockId) { await queueClient.deleteRequestLock(lockId); },
    async write(state) {
      await storeClient.setRecord({ key: WATCHLIST_STATE_KEY, value: JSON.stringify(state), contentType: 'application/json' },
        { timeoutSecs: 30, doNotRetryTimeouts: true });
    },
    async publish(report) {
      // CSV first: a successful JSON status is only published after both outputs exist.
      await outputClient.setRecord({ key: CHANGE_CSV_KEY, value: changeReportCsv(report), contentType: 'text/csv; charset=utf-8' },
        { timeoutSecs: 30, doNotRetryTimeouts: true });
      await outputClient.setRecord({ key: CHANGE_REPORT_KEY, value: JSON.stringify(report), contentType: 'application/json' },
        { timeoutSecs: 30, doNotRetryTimeouts: true });
    },
  };
}
