/**
 * The adoption gate.
 *
 * This is a four-line function with its own test file because the bug it
 * prevents is invisible: a background refresh that adopts server state while
 * a write is still queued on the phone silently erases what the user just
 * recorded, and looks like nothing at all in a code review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDb } from './fake-idb.mjs';

installFakeIndexedDb();

import { canAdoptServerSnapshot, mergeBalances, state } from '../docs/lib/sync.js';

test('adopts only when nothing was pending before OR after the read', () => {
  assert.equal(canAdoptServerSnapshot(0, 0), true);
});

test('refuses when a write was already queued before the read', () => {
  assert.equal(canAdoptServerSnapshot(1, 0), false);
});

test('refuses when a write was enqueued WHILE the read was in flight', () => {
  // The response predates that write, so it cannot contain it. This is the
  // case a "before"-only check misses.
  assert.equal(canAdoptServerSnapshot(0, 1), false);
});

test('refuses when writes were pending throughout', () => {
  assert.equal(canAdoptServerSnapshot(2, 2), false);
});

test('the gate is not a truthiness check', () => {
  // Guards against someone "simplifying" this to !pendingBefore && !pendingAfter
  // and then passing undefined from a failed count.
  assert.equal(canAdoptServerSnapshot(undefined, undefined), false);
  assert.equal(canAdoptServerSnapshot(null, null), false);
});

/* ---------------------------- mergeBalances ----------------------------- */
/**
 * `mergeBalances` is how a WRITE's own reply lands on screen without a
 * follow-up read, which is the whole of the S01 reverting-stock fix. In S02 it
 * became a COMPOSITE-key merge — one row per (facility, sku) — and had no
 * coverage at all. A merge that keyed on the SKU alone would look completely
 * correct in review and would silently overwrite one yard's figure with
 * another's every time a write came back.
 */

function setBalances(rows) { state.balances = rows; }
const rowFor = (fac, sku) =>
  state.balances.find(b => b.facility === fac && b.sku === sku);

test('mergeBalances keeps the same SKU at two yards as two independent rows', async () => {
  setBalances([]);
  await mergeBalances([
    { facility: 'YARD A', sku: 'X', total: 100, damaged: 4, lastTxnTs: 'a' },
    { facility: 'YARD B', sku: 'X', total: 60, damaged: 0, lastTxnTs: 'b' }
  ]);
  assert.equal(state.balances.length, 2, 'the second yard overwrote the first');
  assert.equal(rowFor('YARD A', 'X').total, 100);
  assert.equal(rowFor('YARD A', 'X').damaged, 4);
  assert.equal(rowFor('YARD B', 'X').total, 60);
});

test('mergeBalances updating one yard leaves the other yard alone', async () => {
  setBalances([
    { facility: 'YARD A', sku: 'X', total: 100, damaged: 0, lastTxnTs: 'a' },
    { facility: 'YARD B', sku: 'X', total: 60, damaged: 0, lastTxnTs: 'b' }
  ]);
  await mergeBalances([{ facility: 'YARD B', sku: 'X', total: 35, damaged: 2, lastTxnTs: 'c' }]);
  assert.equal(state.balances.length, 2, 'the merge added a row instead of replacing one');
  assert.equal(rowFor('YARD A', 'X').total, 100, 'YARD A must not move when YARD B is written');
  assert.equal(rowFor('YARD A', 'X').lastTxnTs, 'a');
  assert.equal(rowFor('YARD B', 'X').total, 35);
  assert.equal(rowFor('YARD B', 'X').damaged, 2);
});

test('mergeBalances adds a yard it has never seen rather than dropping it', async () => {
  // The destination leg of a transfer arrives this way the first time stock
  // ever reaches that yard. Dropping it is the reverting-stock bug again.
  setBalances([{ facility: 'YARD A', sku: 'X', total: 70, damaged: 0, lastTxnTs: 'a' }]);
  await mergeBalances([{ facility: 'YARD B', sku: 'X', total: 30, damaged: 0, lastTxnTs: 'c' }]);
  assert.equal(state.balances.length, 2);
  assert.equal(rowFor('YARD B', 'X').total, 30);
});

test('mergeBalances normalises the pair, so casing and padding cannot fork a row', async () => {
  setBalances([{ facility: 'YARD A', sku: 'X', total: 100, damaged: 0, lastTxnTs: 'a' }]);
  await mergeBalances([{ facility: ' yard a ', sku: ' x ', total: 90, damaged: 0, lastTxnTs: 'c' }]);
  assert.equal(state.balances.length, 1, 'the same yard and item merged into two rows');
  assert.equal(rowFor('YARD A', 'X').total, 90);
});

test('mergeBalances keeps a SKU of 0, which this yard really has', async () => {
  // The numeric-SKU class of bug: `String(sku || '')` turns a code of 0 into
  // '', and the row is then filed under the empty key or lost. Live item
  // codes here include 0.99, 0.50 and 0.3, and commit 4856d64 exists for it.
  setBalances([]);
  await mergeBalances([{ facility: 'YARD A', sku: 0, total: 12, damaged: 0, lastTxnTs: 'a' }]);
  assert.equal(state.balances.length, 1);
  assert.equal(state.balances[0].sku, '0');
  assert.equal(state.balances[0].total, 12);
});

test('mergeBalances is sorted by yard then item, so the stock list is stable', async () => {
  setBalances([]);
  await mergeBalances([
    { facility: 'YARD B', sku: 'B', total: 1, damaged: 0, lastTxnTs: '' },
    { facility: 'YARD A', sku: 'Z', total: 1, damaged: 0, lastTxnTs: '' },
    { facility: 'YARD A', sku: 'A', total: 1, damaged: 0, lastTxnTs: '' }
  ]);
  assert.deepEqual(
    state.balances.map(b => b.facility + '|' + b.sku),
    ['YARD A|A', 'YARD A|Z', 'YARD B|B']
  );
});

test('mergeBalances ignores an empty reply instead of clearing what is on screen', async () => {
  setBalances([{ facility: 'YARD A', sku: 'X', total: 100, damaged: 0, lastTxnTs: 'a' }]);
  await mergeBalances([]);
  await mergeBalances(null);
  assert.equal(state.balances.length, 1);
  assert.equal(rowFor('YARD A', 'X').total, 100);
});
