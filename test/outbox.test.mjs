/**
 * Head-of-line ordering in the outbox.
 *
 * The file this tests documents per-(facility, SKU) head-of-line blocking as
 * load-bearing, and for a while it did not exist: `blocked` was declared,
 * checked, and never populated (PLAN-CORRECTIONS X10). A receive-then-issue
 * pair for the same item at the same yard could be applied in the wrong order,
 * which the server then either rejects or — worse — accepts against a stock
 * figure that never existed.
 *
 * `flush()` itself cannot be tested here: it needs IndexedDB and a live
 * `/exec`. The ordering logic is therefore extracted into two pure functions,
 * `entryKeys` and `selectBatch`, and those are what this file exercises. The
 * threading of the set THROUGH the recursion inside `flush()` — the actual
 * defect — is not reachable from Node and has to be read, or exercised
 * against the deployed app.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDb } from './fake-idb.mjs';

const fake = installFakeIndexedDb();

import {
  entryKeys, selectBatch, MAX_BATCH,
  drainPreWarehouseEntries, retryFailed, pendingItems, failedItems, NEEDS_WAREHOUSE
} from '../docs/lib/outbox.js';
import { balKey } from '../docs/lib/deltas.js';

/** An outbox record, with only the fields the batch builder reads. */
function rec(seq, type, sku, facility, extra = {}) {
  return { seq, type, sku, facility, payload: { qty: 1 }, ...extra };
}

test('entryKeys keys a plain entry on (facility, sku)', () => {
  assert.deepEqual(entryKeys(rec(1, 'INBOUND', 'steel-10', 'yard a')), ['YARD A|STEEL-10']);
});

test('entryKeys gives a TRANSFER both of its ends, source first', () => {
  const keys = entryKeys(rec(1, 'TRANSFER', 'STEEL', 'YARD A', { toFacility: 'YARD B' }));
  assert.deepEqual(keys, ['YARD A|STEEL', 'YARD B|STEEL']);
});

test('entryKeys collapses a TRANSFER whose ends are the same key', () => {
  // Callers iterate these and add them to a Set, so a duplicate is harmless —
  // but a two-element list here would misreport a same-yard transfer as
  // occupying two places.
  const keys = entryKeys(rec(1, 'TRANSFER', 'STEEL', 'YARD A', { toFacility: 'yard a' }));
  assert.deepEqual(keys, ['YARD A|STEEL']);
});

test('entryKeys falls back to payload facilities for entries from an older build', () => {
  // Schema-1 records queued before the facility moved to the top level.
  // `projectBalances` in deltas.js does the same fallback; the two must agree
  // or an old entry orders against a key nothing else uses.
  const legacy = {
    seq: 1, type: 'TRANSFER', sku: 'STEEL',
    payload: { qty: 5, facility: 'YARD A', toFacility: 'YARD B' }
  };
  assert.deepEqual(entryKeys(legacy), ['YARD A|STEEL', 'YARD B|STEEL']);
});

test('entryKeys keeps a numeric SKU of 0', () => {
  // This yard has live numeric item codes. `String(x || '')` turns 0 into ''
  // and merges it with the no-SKU key — the bug class commit 4856d64 exists
  // for. `normSku(0)` is '0'.
  assert.deepEqual(entryKeys(rec(1, 'INBOUND', 0, 'YARD A')), ['YARD A|0']);
  assert.notEqual(entryKeys(rec(1, 'INBOUND', 0, 'YARD A'))[0],
    entryKeys(rec(2, 'INBOUND', '', 'YARD A'))[0],
    'SKU 0 must not collide with a missing SKU');
});

test('entryKeys keys a legacy no-facility entry as "|SKU"', () => {
  assert.deepEqual(entryKeys({ seq: 1, type: 'INBOUND', sku: 'STEEL', payload: {} }), ['|STEEL']);
});

test('a blocked key at YARD A does not block the same SKU at YARD B', () => {
  const queue = [
    rec(1, 'OUTBOUND', 'STEEL', 'YARD B'),
    rec(2, 'OUTBOUND', 'CEMENT', 'YARD A')
  ];
  const blocked = new Set([balKey('YARD A', 'STEEL')]);
  const batch = selectBatch(queue, blocked, MAX_BATCH);
  assert.deepEqual(batch.map(it => it.seq), [1, 2]);
});

test('a blocked key holds back later entries at that same key', () => {
  const queue = [
    rec(1, 'OUTBOUND', 'STEEL', 'YARD A'),
    rec(2, 'INBOUND', 'STEEL', 'YARD A'),
    rec(3, 'INBOUND', 'STEEL', 'YARD B')
  ];
  const blocked = new Set([balKey('YARD A', 'STEEL')]);
  const batch = selectBatch(queue, blocked, MAX_BATCH);
  assert.deepEqual(batch.map(it => it.seq), [3]);
});

test('a TRANSFER is skipped when EITHER end is blocked', () => {
  const transfer = rec(1, 'TRANSFER', 'STEEL', 'YARD A', { toFacility: 'YARD B' });

  const bySource = selectBatch([transfer], new Set([balKey('YARD A', 'STEEL')]), MAX_BATCH);
  assert.deepEqual(bySource, [], 'blocked at the source');

  const byDest = selectBatch([transfer], new Set([balKey('YARD B', 'STEEL')]), MAX_BATCH);
  assert.deepEqual(byDest, [], 'blocked at the destination');

  const neither = selectBatch([transfer], new Set([balKey('YARD C', 'STEEL')]), MAX_BATCH);
  assert.deepEqual(neither.map(it => it.seq), [1], 'an unrelated yard must not block it');
});

test('a skipped TRANSFER blocks BOTH of its keys', () => {
  // The one that actually bites: the transfer is held at its source, and the
  // later entry at its DESTINATION would otherwise sail past it and land
  // before the incoming stock did.
  const queue = [
    rec(1, 'TRANSFER', 'STEEL', 'YARD A', { toFacility: 'YARD B' }),
    rec(2, 'OUTBOUND', 'STEEL', 'YARD B'),
    rec(3, 'OUTBOUND', 'STEEL', 'YARD C')
  ];
  const blocked = new Set([balKey('YARD A', 'STEEL')]);
  const batch = selectBatch(queue, blocked, MAX_BATCH);

  assert.deepEqual(batch.map(it => it.seq), [3]);
  assert.ok(blocked.has(balKey('YARD B', 'STEEL')), 'the destination key must now be blocked');
});

test('a skipped plain entry blocks its own successors', () => {
  const queue = [
    rec(1, 'INBOUND', 'STEEL', 'YARD A'),   // skipped: key already blocked
    rec(2, 'OUTBOUND', 'STEEL', 'YARD A')   // must not overtake it
  ];
  const blocked = new Set([balKey('YARD A', 'STEEL')]);
  assert.deepEqual(selectBatch(queue, blocked, MAX_BATCH), []);
});

test('legacy no-facility entries still order among themselves', () => {
  const legacyIn = { seq: 1, type: 'INBOUND', sku: 'STEEL', payload: { qty: 5 } };
  const legacyOut = { seq: 2, type: 'OUTBOUND', sku: 'STEEL', payload: { qty: 5 } };
  const withFac = rec(3, 'OUTBOUND', 'STEEL', 'YARD A');

  const blocked = new Set(['|STEEL']);
  const batch = selectBatch([legacyIn, legacyOut, withFac], blocked, MAX_BATCH);
  assert.deepEqual(batch.map(it => it.seq), [3],
    'a blank facility is its own key — it blocks other blank ones, not YARD A');
});

test('the MAX_BATCH cap still stops the batch at the right size', () => {
  const queue = [];
  for (let i = 1; i <= MAX_BATCH + 5; i++) queue.push(rec(i, 'INBOUND', 'SKU-' + i, 'YARD A'));
  const batch = selectBatch(queue, new Set(), MAX_BATCH);
  assert.equal(batch.length, MAX_BATCH);
  assert.equal(batch[batch.length - 1].seq, MAX_BATCH, 'the cap must cut in queue order');
});

test('skipped entries do not consume batch slots', () => {
  // A skip is a `continue`, not a slot: a queue full of blocked entries must
  // still fill the batch from the entries behind them.
  const queue = [rec(1, 'INBOUND', 'STEEL', 'YARD A')];
  for (let i = 2; i <= MAX_BATCH + 1; i++) queue.push(rec(i, 'INBOUND', 'SKU-' + i, 'YARD B'));
  const batch = selectBatch(queue, new Set([balKey('YARD A', 'STEEL')]), MAX_BATCH);
  assert.equal(batch.length, MAX_BATCH);
  assert.ok(!batch.some(it => it.seq === 1));
});

test('selectBatch does not touch `blocked` for entries it sends', () => {
  // Only a NON-success blocks a key. If selection itself blocked, one entry
  // per key per flush would be the most that ever went out.
  const blocked = new Set();
  const queue = [rec(1, 'INBOUND', 'STEEL', 'YARD A'), rec(2, 'OUTBOUND', 'STEEL', 'YARD A')];
  const batch = selectBatch(queue, blocked, MAX_BATCH);
  assert.deepEqual(batch.map(it => it.seq), [1, 2]);
  assert.equal(blocked.size, 0);
});

/* ================= the pre-warehouse drain (PLAN A7) ================= */
/**
 * The migration leaves a phone able to hold entries it can never send: queued
 * by the old build, carrying no warehouse, and nothing in the retry path can
 * add one. Left in the queue they are re-sent on every enqueue, every poll and
 * every visibilitychange — and the head-of-line rule then holds back the good
 * entries queued behind them at the same item.
 *
 * These tests exist because this is the one place in the app that takes work
 * OUT of a user's queue without being asked. Draining one entry too many loses
 * a movement that physically happened, which is the failure the whole outbox
 * is built to prevent.
 */

function seedOutbox(rows) {
  fake.reset();
  const store = fake.store('outbox');
  for (const r of rows) store.set(r.seq, r);
}

const drained = async () => (await failedItems()).map(f => f.seq).sort((a, b) => a - b);
const kept = async () => (await pendingItems()).map(f => f.seq).sort((a, b) => a - b);

test('an entry with no warehouse is moved out of the queue', async () => {
  seedOutbox([rec(1, 'INBOUND', 'STEEL', '')]);
  assert.equal(await drainPreWarehouseEntries(), 1);
  assert.deepEqual(await kept(), []);
  assert.deepEqual(await drained(), [1]);
});

test('a drained entry is marked so the UI cannot offer "Try again"', async () => {
  // A retry copies the old payload forward, so a retry button on one of these
  // is an infinite re-rejection loop the user has no way to escape.
  seedOutbox([rec(1, 'INBOUND', 'STEEL', '')]);
  await drainPreWarehouseEntries();
  const [f] = await failedItems();
  assert.equal(f.noRetry, true);
  assert.equal(f.error.code, NEEDS_WAREHOUSE);
  assert.equal(f.error.retryable, false);
  assert.match(f.error.message, /warehouse/i);
});

test('retryFailed refuses a drained entry even if the UI asks it to', async () => {
  seedOutbox([rec(1, 'INBOUND', 'STEEL', '')]);
  await drainPreWarehouseEntries();
  assert.equal(await retryFailed(1), null, 're-queued an entry that can never send');
  assert.deepEqual(await kept(), []);
});

test('an entry that DOES name a warehouse is left alone', async () => {
  // The one that matters. This is a real movement someone recorded.
  seedOutbox([rec(1, 'INBOUND', 'STEEL', 'YARD A')]);
  assert.equal(await drainPreWarehouseEntries(), 0);
  assert.deepEqual(await kept(), [1]);
  assert.deepEqual(await drained(), []);
});

test('a TRANSFER missing only its DESTINATION is drained too', async () => {
  // Half a transfer is not a usable entry: the server needs both ends, and
  // checking `facility` alone would let it sit in the queue being rejected.
  seedOutbox([rec(1, 'TRANSFER', 'STEEL', 'YARD A', { toFacility: '' })]);
  assert.equal(await drainPreWarehouseEntries(), 1);
  assert.deepEqual(await drained(), [1]);
});

test('a complete TRANSFER is left alone', async () => {
  seedOutbox([rec(1, 'TRANSFER', 'STEEL', 'YARD A', { toFacility: 'YARD B' })]);
  assert.equal(await drainPreWarehouseEntries(), 0);
  assert.deepEqual(await kept(), [1]);
});

test('a warehouse carried in the payload by an older build still counts', async () => {
  // `entryKeys` already reads through to the payload for these; the drain has
  // to agree with it, or it throws away entries the flush could have sent.
  seedOutbox([{ seq: 1, type: 'INBOUND', sku: 'STEEL', payload: { qty: 1, facility: 'YARD A' } }]);
  assert.equal(await drainPreWarehouseEntries(), 0);
  assert.deepEqual(await kept(), [1]);
});

test('only the stranded entries go, from a mixed queue', async () => {
  seedOutbox([
    rec(1, 'INBOUND', 'STEEL', 'YARD A'),
    rec(2, 'OUTBOUND', 'STEEL', ''),
    rec(3, 'TRANSFER', 'STEEL', 'YARD A', { toFacility: 'YARD B' }),
    rec(4, 'DAMAGE', 'CEMENT', '')
  ]);
  assert.equal(await drainPreWarehouseEntries(), 2);
  assert.deepEqual(await kept(), [1, 3]);
  assert.deepEqual(await drained(), [2, 4]);
});

test('draining twice does not move anything the second time', async () => {
  // It runs on every launch, so it has to be idempotent — a second pass that
  // found more work would mean it was eating real entries.
  seedOutbox([rec(1, 'INBOUND', 'STEEL', ''), rec(2, 'INBOUND', 'STEEL', 'YARD A')]);
  assert.equal(await drainPreWarehouseEntries(), 1);
  assert.equal(await drainPreWarehouseEntries(), 0);
  assert.deepEqual(await kept(), [2]);
});

test('a whitespace-only warehouse is not a warehouse', async () => {
  seedOutbox([rec(1, 'INBOUND', 'STEEL', '   ')]);
  assert.equal(await drainPreWarehouseEntries(), 1);
});

test('a numeric SKU of 0 is not mistaken for a missing warehouse', async () => {
  // The 4856d64 class of bug, in the one function that decides what to delete.
  seedOutbox([rec(1, 'INBOUND', 0, 'YARD A')]);
  assert.equal(await drainPreWarehouseEntries(), 0);
  assert.deepEqual(await kept(), [1]);
});
