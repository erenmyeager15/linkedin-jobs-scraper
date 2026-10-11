import assert from 'node:assert/strict';
import test from 'node:test';
import { Actor } from 'apify';
import { openWatchlistStorage } from './watchlist-storage.js';
import { CHANGE_CSV_KEY, CHANGE_REPORT_KEY, WATCHLIST_STATE_KEY, type ChangeReport, type WatchlistState } from './watchlist.js';

test('platform storage uses a persistent named store, an API-owned writer lease and separate CSV/JSON outputs', async (t) => {
  const created: string[] = [];
  const renewals: unknown[] = [];
  const written: Array<{ storeId: string; record: { key: string; value: string; contentType: string }; options: unknown }> = [];
  let clientKey = '';
  let added: unknown;
  const client = {
    keyValueStores: () => ({ async getOrCreate(name: string) { created.push(name); return { id: 'saved-store' }; } }),
    requestQueues: () => ({ async getOrCreate(name: string) { created.push(name); return { id: 'writer-queue' }; } }),
    requestQueue: (id: string, options: { clientKey: string }) => {
      assert.equal(id, 'writer-queue'); clientKey = options.clientKey;
      return {
        async addRequest(request: unknown) { added = request; return { requestId: 'writer', wasAlreadyHandled: false }; },
        async listAndLockHead(options: unknown) { assert.deepEqual(options, { lockSecs: 300, limit: 1 }); return { items: [{ id: 'writer' }] }; },
        async prolongRequestLock(id: string, options: unknown) { renewals.push({ id, options }); },
        async deleteRequestLock(id: string) { assert.equal(id, 'writer'); },
      };
    },
    keyValueStore: (storeId: string) => ({
      async getRecord(key: string) { assert.equal(key, WATCHLIST_STATE_KEY); return { value: { schemaVersion: 1 } }; },
      async setRecord(record: { key: string; value: string; contentType: string }, options: unknown) { written.push({ storeId, record, options }); },
    }),
  };
  t.mock.method(Actor, 'isAtHome', () => true);
  t.mock.method(Actor, 'getEnv', () => ({ defaultKeyValueStoreId: 'run-output' }));
  t.mock.method(Actor, 'newClient', (options: unknown) => { assert.deepEqual(options, { maxRetries: 0, timeoutSecs: 30 }); return client; });
  const storage = await openWatchlistStorage('test-jobs');
  assert.equal(created.length, 2);
  assert.ok(created.every((name) => name.length <= 63 && !name.includes('test-jobs')));
  assert.match(clientKey, /^[a-f0-9]{32}$/);
  assert.deepEqual(added, { uniqueKey: 'linkedin-jobs-watch-writer-v1', url: 'https://www.linkedin.com/jobs/' });
  assert.deepEqual(await storage.read(), { schemaVersion: 1 });
  assert.equal(await storage.acquireLock(), 'writer');
  await storage.assertLock('writer');
  assert.deepEqual(renewals, [{ id: 'writer', options: { lockSecs: 300 } }]);
  await storage.write({ schemaVersion: 1 } as WatchlistState);
  await storage.publish({ status: 'incomplete', baselineCommitted: false, observations: [] } as unknown as ChangeReport);
  assert.deepEqual(written.map((entry) => entry.record.key), [WATCHLIST_STATE_KEY, CHANGE_CSV_KEY, CHANGE_REPORT_KEY]);
  assert.equal(written[0].storeId, 'saved-store');
  assert.equal(written[1].storeId, 'run-output');
  assert.ok(written.every((entry) => JSON.stringify(entry.options) === JSON.stringify({ timeoutSecs: 30, doNotRetryTimeouts: true })));
  await storage.releaseLock('writer');
});

test('local use cannot silently create an ephemeral baseline pretending to persist across platform runs', async (t) => {
  t.mock.method(Actor, 'isAtHome', () => false);
  await assert.rejects(() => openWatchlistStorage('test-jobs'), /Apify platform run/);
});
