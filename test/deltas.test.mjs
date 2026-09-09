/**
 * The delta contract, tested on both sides of the wire.
 *
 * Run:  node --test test/
 *
 * Three things are asserted here, and the third is the one that matters most:
 *   1. the CLIENT function (docs/lib/deltas.js) matches the fixtures
 *   2. folding is order-independent, which is what makes a late offline entry safe
 *   3. the SERVER's inline copy (gas/Setup.js runTests) has NOT drifted from
 *      the fixtures — parsed out of the file and compared case by case.
 *
 * (3) exists because Apps Script cannot read a JSON file from disk, so the
 * server keeps its own inline copy of the same list. Two lists that are
 * supposed to be identical, edited months apart, is exactly how the projected
 * balance silently stops matching the synced balance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { deltasFor, foldDeltas, projectBalances } from '../docs/lib/deltas.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'deltas.fixtures.json'), 'utf8'));

test('fixture file is non-trivial', () => {
  assert.ok(fixtures.length >= 15, `expected >=15 fixtures, got ${fixtures.length}`);
});

test('client deltasFor matches every fixture', () => {
  for (const f of fixtures) {
    const d = deltasFor(f.txn);
    assert.equal(d.dTotal, f.dTotal, `${f.label}: dTotal`);
    assert.equal(d.dDamaged, f.dDamaged, `${f.label}: dDamaged`);
  }
});

test('server inline case list has not drifted from the fixtures', () => {
  const src = readFileSync(join(here, '..', 'gas', 'Setup.js'), 'utf8');

  const start = src.indexOf('var cases = [');
  assert.notEqual(start, -1, 'could not find "var cases = [" in gas/Setup.js');
  const open = src.indexOf('[', start);

  // Walk to the matching bracket so a nested array/object cannot truncate us.
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, 'unbalanced brackets in the gas/Setup.js case list');

  const literal = src.slice(open, end + 1);
  // Plain array-of-array literal with no identifiers — safe to evaluate.
  assert.ok(!/[A-Za-z_$][\w$]*\s*\(/.test(literal),
    'server case list contains a function call — refusing to evaluate it');
  const serverCases = Function(`"use strict"; return (${literal});`)();

  assert.equal(serverCases.length, fixtures.length,
    `server has ${serverCases.length} cases, fixtures have ${fixtures.length}`);

  for (let i = 0; i < fixtures.length; i++) {
    const [label, txn, dTotal, dDamaged] = serverCases[i];
    const f = fixtures[i];
    assert.equal(label, f.label, `case ${i}: label`);
    assert.deepEqual(txn, f.txn, `case ${i} (${f.label}): txn payload`);
    assert.equal(dTotal, f.dTotal, `case ${i} (${f.label}): dTotal`);
    assert.equal(dDamaged, f.dDamaged, `case ${i} (${f.label}): dDamaged`);
  }
});

test('the brief\'s headline scenario folds to 80 total / 17 damaged / 63 good', () => {
  // Receive 100 of which 5 damaged, issue 20 good, then mark 12 damaged.
  const folded = foldDeltas([
    { type: 'INBOUND', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'OUTBOUND', sku: 'X', qty: 20, condition: 'GOOD' },
    { type: 'DAMAGE', sku: 'X', qty: 12 }
  ]);
  assert.equal(folded.X.total, 80);
  assert.equal(folded.X.damaged, 17);
  assert.equal(folded.X.total - folded.X.damaged, 63);
});

test('recording damage never changes the total', () => {
  const before = foldDeltas([{ type: 'INBOUND', sku: 'X', qty: 100, damagedQty: 0 }]);
  const after = foldDeltas([{ type: 'DAMAGE', sku: 'X', qty: 40 }], structuredClone(before));
  assert.equal(after.X.total, before.X.total, 'total must be untouched by DAMAGE');
  assert.equal(after.X.damaged, 40);
  assert.equal(after.X.total - after.X.damaged, 60);
});

test('folding is order-independent', () => {
  const forward = foldDeltas([
    { type: 'INBOUND', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'OUTBOUND', sku: 'X', qty: 20 },
    { type: 'DAMAGE', sku: 'X', qty: 12 }
  ]);
  const backward = foldDeltas([
    { type: 'DAMAGE', sku: 'X', qty: 12 },
    { type: 'OUTBOUND', sku: 'X', qty: 20 },
    { type: 'INBOUND', sku: 'X', qty: 100, damagedQty: 5 }
  ]);
  assert.deepEqual(
    { t: backward.X.total, d: backward.X.damaged },
    { t: forward.X.total, d: forward.X.damaged }
  );
});

test('a void cancels its original exactly', () => {
  const net = foldDeltas([
    { type: 'INBOUND', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'VOID', sku: 'X', qty: 100, damagedQty: 5, voidOfType: 'INBOUND' }
  ]);
  assert.equal(net.X.total, 0);
  assert.equal(net.X.damaged, 0);
});

/* ---------------- projected balances (the offline display) ---------------- */

const server = [{ sku: 'TMT-12MM', total: 350, damaged: 12, lastTxnTs: '2026-09-08T10:00:00.000Z' }];

test('projection shows the server figure when the outbox is empty', () => {
  const [row] = projectBalances(server, []);
  assert.deepEqual(
    { total: row.total, damaged: row.damaged, good: row.good, pending: row.pending },
    { total: 350, damaged: 12, good: 338, pending: 0 }
  );
});

test('projection layers pending entries on top of the server figure', () => {
  const [row] = projectBalances(server, [
    { sku: 'TMT-12MM', type: 'INBOUND', status: 'pending', payload: { qty: 100, damagedQty: 6 } },
    { sku: 'TMT-12MM', type: 'OUTBOUND', status: 'pending', payload: { qty: 20, condition: 'GOOD' } }
  ]);
  assert.equal(row.total, 430);      // 350 + 100 - 20
  assert.equal(row.damaged, 18);     // 12 + 6
  assert.equal(row.good, 412);
  assert.equal(row.pending, 2);
});

test('a failed entry is excluded from the projection but the server figure stands', () => {
  const [row] = projectBalances(server, [
    { sku: 'TMT-12MM', type: 'OUTBOUND', status: 'failed', payload: { qty: 20 } }
  ]);
  assert.equal(row.total, 350, 'a rejected entry must not move the balance');
  assert.equal(row.pending, 0);
});

test('a pending entry for an unknown SKU still appears', () => {
  const rows = projectBalances(server, [
    { sku: 'NEW-SKU', type: 'INBOUND', status: 'pending', payload: { qty: 40, damagedQty: 0 } }
  ]);
  const row = rows.find(r => r.sku === 'NEW-SKU');
  assert.ok(row, 'new SKU should be projected even with no server row');
  assert.equal(row.total, 40);
});

test('THE KEY INVARIANT: a successful flush must not move the projected total', () => {
  // Before the flush: server has the old figure, the entry sits in the outbox.
  const pendingItem = {
    sku: 'TMT-12MM', type: 'INBOUND', status: 'pending',
    payload: { qty: 100, damagedQty: 6 }
  };
  const [before] = projectBalances(server, [pendingItem]);

  // After the flush: the server's post-commit figure replaces it, outbox empty.
  // This is what the flush RESPONSE carries back, not a separate read.
  const serverAfter = [{ sku: 'TMT-12MM', total: 450, damaged: 18, lastTxnTs: 'x' }];
  const [after] = projectBalances(serverAfter, []);

  assert.equal(after.total, before.total, 'total jumped across the flush');
  assert.equal(after.damaged, before.damaged, 'damaged jumped across the flush');
  assert.equal(after.good, before.good, 'good jumped across the flush');
});
