/**
 * The delta contract, tested on both sides of the wire.
 *
 * Run:  node --test test/
 *
 * Four things are asserted here, and the third is the one that matters most:
 *   1. the CLIENT function (docs/lib/deltas.js) matches the fixtures
 *   2. folding is order-independent, which is what makes a late offline entry safe
 *   3. the SERVER's inline copy (gas/Setup.js runTests) has NOT drifted from
 *      the fixtures — parsed out of the file and compared case by case.
 *   4. the two-key TRANSFER cases fold and project correctly. (3) cannot cover
 *      these: it only compares case LISTS, so it proves the two deltasFor
 *      implementations agree, never that a fold over a multi-key list lands on
 *      the right pair of keys.
 *
 * (3) exists because Apps Script cannot read a JSON file from disk, so the
 * server keeps its own inline copy of the same list. Two lists that are
 * supposed to be identical, edited months apart, is exactly how the projected
 * balance silently stops matching the synced balance.
 *
 * SHAPE NOTE (S02): deltasFor now returns an ARRAY of
 * {facility, dTotal, dDamaged}, and every balance is keyed 'FACILITY|SKU'.
 * A TRANSFER returns two entries, source first, destination second.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { deltasFor, foldDeltas, projectBalances, balKey } from '../docs/lib/deltas.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'deltas.fixtures.json'), 'utf8'));

test('fixture file is non-trivial', () => {
  assert.ok(fixtures.length >= 19, `expected >=19 fixtures, got ${fixtures.length}`);
});

test('client deltasFor matches every fixture', () => {
  for (const f of fixtures) {
    assert.deepEqual(deltasFor(f.txn), f.deltas, f.label);
  }
});

test('balKey is the composite key both sides agree on', () => {
  // Not cosmetic: every map in the app is keyed with this, so a change in
  // trimming, casing or separator silently re-partitions every balance.
  assert.equal(balKey('yard a', 'widget-a'), 'YARD A|WIDGET-A');
  assert.equal(balKey('  Yard A  ', ' Widget-A '), 'YARD A|WIDGET-A');
  assert.equal(balKey('', 'X'), '|X', 'a blank facility must still produce a visible key');
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
  // This is also why no fixture facility name may contain "(".
  assert.ok(!/[A-Za-z_$][\w$]*\s*\(/.test(literal),
    'server case list contains a function call — refusing to evaluate it');
  const serverCases = Function(`"use strict"; return (${literal});`)();

  assert.equal(serverCases.length, fixtures.length,
    `server has ${serverCases.length} cases, fixtures have ${fixtures.length}`);

  for (let i = 0; i < fixtures.length; i++) {
    const [label, txn, deltas] = serverCases[i];
    const f = fixtures[i];
    assert.equal(label, f.label, `case ${i}: label`);
    assert.deepEqual(txn, f.txn, `case ${i} (${f.label}): txn payload`);
    assert.deepEqual(deltas, f.deltas, `case ${i} (${f.label}): delta list`);
  }
});

/* ------------------------------- folding ------------------------------- */

test('the brief\'s headline scenario folds to 80 total / 17 damaged / 63 good', () => {
  // Receive 100 of which 5 damaged, issue 20 good, then mark 12 damaged.
  const folded = foldDeltas([
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'X', qty: 20, condition: 'GOOD' },
    { type: 'DAMAGE', facility: 'YARD A', sku: 'X', qty: 12 }
  ]);
  assert.equal(folded['YARD A|X'].total, 80);
  assert.equal(folded['YARD A|X'].damaged, 17);
  assert.equal(folded['YARD A|X'].total - folded['YARD A|X'].damaged, 63);
});

test('THE TWIN TEST: a SKU of 0 makes a row on BOTH sides, not just the server', () => {
  // This is the drift the fixtures could never catch: they exercise
  // `deltasFor` only, and every fold test uses 'X'.
  //
  // The server normalises with normSku_ -> str_, which special-cases ONLY
  // null and undefined, so a SKU of 0 becomes '0' and gets a row. The client
  // used `String(t.sku || '')`, which turns 0 into '' — and foldDeltas then
  // `continue`d and DROPPED the row entirely. The phone would show no stock
  // for an item the Sheet had 5 of.
  //
  // Not hypothetical: this yard has live numeric item codes. 0.99, 0.50 and
  // 0.3 all appear in the codebase, and commit 4856d64 exists because of
  // exactly this class of bug.
  const folded = foldDeltas([
    { type: 'INBOUND', facility: 'YARD A', sku: 0, qty: 5, damagedQty: 0 }
  ]);
  assert.deepEqual(Object.keys(folded), ['YARD A|0'],
    'a SKU of 0 was dropped — the client is using String(sku || "") again');
  assert.equal(folded['YARD A|0'].sku, '0');
  assert.equal(folded['YARD A|0'].total, 5);
});

test('a genuinely absent SKU is still skipped', () => {
  // The other half of the same rule: 0 is a value, '' / null / undefined are
  // not. Widening the normaliser far enough to keep 0 must not also start
  // folding rows that have no item on them at all.
  assert.deepEqual(foldDeltas([
    { type: 'INBOUND', facility: 'YARD A', sku: '', qty: 5 },
    { type: 'INBOUND', facility: 'YARD A', sku: null, qty: 5 },
    { type: 'INBOUND', facility: 'YARD A', qty: 5 },
    { type: 'INBOUND', facility: 'YARD A', sku: '   ', qty: 5 }
  ]), {});
});

test('a SKU of 0 survives the projection too, server row and outbox entry alike', () => {
  const rows = projectBalances(
    [{ facility: 'YARD A', sku: 0, total: 40, damaged: 0, lastTxnTs: 'a' }],
    [{ facility: 'YARD A', sku: 0, type: 'INBOUND', status: 'pending', payload: { qty: 10, damagedQty: 0 } }]
  );
  assert.equal(rows.length, 1, 'the server row and the pending entry landed on different keys');
  assert.equal(rows[0].sku, '0');
  assert.equal(rows[0].total, 50);
  assert.equal(rows[0].pending, 1);
});

test('a zero-quantity entry produces 0, never -0', () => {
  // `-qty` on a qty of 0 yields -0. The server's own comparisons cannot tell
  // -0 from 0, but node:assert/strict deepEqual can — so a twin pair that
  // disagreed only here would pass every server check and fail only in a
  // test, which is the most confusing possible place to find out.
  for (const t of [
    { type: 'OUTBOUND', facility: 'YARD A', qty: 0 },
    { type: 'OUTBOUND', facility: 'YARD A', qty: 0, condition: 'DAMAGED' },
    { type: 'ADJUST_DOWN', facility: 'YARD A', qty: 0 },
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', qty: 0 }
  ]) {
    for (const d of deltasFor(t)) {
      assert.ok(!Object.is(d.dTotal, -0), `${t.type}: dTotal is -0`);
      assert.ok(!Object.is(d.dDamaged, -0), `${t.type}: dDamaged is -0`);
    }
  }
});

test('a folded row carries its facility and sku, so nothing ever splits the key', () => {
  // X3: facility names are near-free text. A name containing "|" would corrupt
  // any code that parsed the key back apart, so the pair lives on the VALUE.
  const folded = foldDeltas([
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 10, damagedQty: 0 }
  ]);
  assert.equal(folded['YARD A|X'].facility, 'YARD A');
  assert.equal(folded['YARD A|X'].sku, 'X');
});

test('recording damage never changes the total', () => {
  const before = foldDeltas([{ type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 0 }]);
  const after = foldDeltas([{ type: 'DAMAGE', facility: 'YARD A', sku: 'X', qty: 40 }], structuredClone(before));
  assert.equal(after['YARD A|X'].total, before['YARD A|X'].total, 'total must be untouched by DAMAGE');
  assert.equal(after['YARD A|X'].damaged, 40);
  assert.equal(after['YARD A|X'].total - after['YARD A|X'].damaged, 60);
});

test('folding is order-independent', () => {
  const forward = foldDeltas([
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'X', qty: 20 },
    { type: 'DAMAGE', facility: 'YARD A', sku: 'X', qty: 12 }
  ]);
  const backward = foldDeltas([
    { type: 'DAMAGE', facility: 'YARD A', sku: 'X', qty: 12 },
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'X', qty: 20 },
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 5 }
  ]);
  assert.deepEqual(
    { t: backward['YARD A|X'].total, d: backward['YARD A|X'].damaged },
    { t: forward['YARD A|X'].total, d: forward['YARD A|X'].damaged }
  );
});

test('a void cancels its original exactly', () => {
  const net = foldDeltas([
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'VOID', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 5, voidOfType: 'INBOUND' }
  ]);
  assert.equal(net['YARD A|X'].total, 0);
  assert.equal(net['YARD A|X'].damaged, 0);
});

test('the same SKU at two yards folds to two independent keys', () => {
  const folded = foldDeltas([
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 0 },
    { type: 'INBOUND', facility: 'YARD B', sku: 'X', qty: 60, damagedQty: 0 },
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'X', qty: 20 }
  ]);
  assert.equal(folded['YARD A|X'].total, 80);
  assert.equal(folded['YARD B|X'].total, 60, 'issuing at YARD A must not touch YARD B');
});

/* --------------------------- transfers (S02) --------------------------- */

test('a transfer takes stock out of one yard and puts it in the other', () => {
  // The case the drift detector cannot reach: it compares case lists, so it
  // proves the two deltasFor agree — never that a FOLD lands on both keys.
  const folded = foldDeltas([
    { type: 'OPENING', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 0 },
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', sku: 'X', qty: 30 }
  ]);
  assert.equal(folded['YARD A|X'].total, 70);
  assert.equal(folded['YARD B|X'].total, 30);
  assert.equal(folded['YARD A|X'].total + folded['YARD B|X'].total, 100,
    'a transfer must conserve stock across the two yards');
});

test('a transfer never moves damaged units, whatever the condition says', () => {
  const folded = foldDeltas([
    { type: 'OPENING', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 20 },
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', sku: 'X', qty: 30, condition: 'DAMAGED' }
  ]);
  assert.equal(folded['YARD A|X'].damaged, 20, 'the damaged units stay where they were');
  assert.equal(folded['YARD B|X'].damaged, 0);
});

test('voiding a transfer nets both yards back to where they started', () => {
  const folded = foldDeltas([
    { type: 'OPENING', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 0 },
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', sku: 'X', qty: 30 },
    { type: 'VOID', facility: 'YARD A', toFacility: 'YARD B', sku: 'X', qty: 30, voidOfType: 'TRANSFER' }
  ]);
  assert.equal(folded['YARD A|X'].total, 100);
  assert.equal(folded['YARD B|X'].total, 0);
});

/* ---------------- projected balances (the offline display) ---------------- */

const server = [{ facility: 'YARD A', sku: 'TMT-12MM', total: 350, damaged: 12, lastTxnTs: '2026-09-08T10:00:00.000Z' }];

test('projection shows the server figure when the outbox is empty', () => {
  const [row] = projectBalances(server, []);
  assert.deepEqual(
    { facility: row.facility, total: row.total, damaged: row.damaged, good: row.good, pending: row.pending },
    { facility: 'YARD A', total: 350, damaged: 12, good: 338, pending: 0 }
  );
});

test('projection layers pending entries on top of the server figure', () => {
  const [row] = projectBalances(server, [
    { sku: 'TMT-12MM', facility: 'YARD A', type: 'INBOUND', status: 'pending', payload: { qty: 100, damagedQty: 6 } },
    { sku: 'TMT-12MM', facility: 'YARD A', type: 'OUTBOUND', status: 'pending', payload: { qty: 20, condition: 'GOOD' } }
  ]);
  assert.equal(row.total, 430);      // 350 + 100 - 20
  assert.equal(row.damaged, 18);     // 12 + 6
  assert.equal(row.good, 412);
  assert.equal(row.pending, 2);
});

test('a failed entry is excluded from the projection but the server figure stands', () => {
  const [row] = projectBalances(server, [
    { sku: 'TMT-12MM', facility: 'YARD A', type: 'OUTBOUND', status: 'failed', payload: { qty: 20 } }
  ]);
  assert.equal(row.total, 350, 'a rejected entry must not move the balance');
  assert.equal(row.pending, 0);
});

test('a pending entry for an unknown SKU still appears', () => {
  const rows = projectBalances(server, [
    { sku: 'NEW-SKU', facility: 'YARD A', type: 'INBOUND', status: 'pending', payload: { qty: 40, damagedQty: 0 } }
  ]);
  const row = rows.find(r => r.sku === 'NEW-SKU');
  assert.ok(row, 'new SKU should be projected even with no server row');
  assert.equal(row.total, 40);
});

test('an entry queued by an older build, with the facility only in the payload, still projects', () => {
  // outbox.js now stores facility at the TOP level, but a phone that has been
  // offline since S01 has entries that predate that. Dropping them from the
  // projection would make the stock screen quietly disagree with the outbox.
  const rows = projectBalances(server, [
    { sku: 'TMT-12MM', type: 'INBOUND', status: 'pending', payload: { facility: 'YARD A', qty: 10, damagedQty: 0 } }
  ]);
  const row = rows.find(r => r.facility === 'YARD A' && r.sku === 'TMT-12MM');
  assert.equal(row.total, 360);
});

test('the same SKU at two facilities projects as two independent rows', () => {
  const rows = projectBalances(
    [
      { facility: 'YARD A', sku: 'X', total: 100, damaged: 0, lastTxnTs: 'a' },
      { facility: 'YARD B', sku: 'X', total: 60, damaged: 0, lastTxnTs: 'b' }
    ],
    [{ sku: 'X', facility: 'YARD A', type: 'OUTBOUND', status: 'pending', payload: { qty: 20 } }]
  );
  assert.equal(rows.length, 2);
  const a = rows.find(r => r.facility === 'YARD A');
  const b = rows.find(r => r.facility === 'YARD B');
  assert.equal(a.total, 80);
  assert.equal(a.pending, 1);
  assert.equal(b.total, 60, 'an entry at YARD A must not move YARD B');
  assert.equal(b.pending, 0);
});

test('a pending transfer shows the source down, the destination up, and pending at BOTH ends', () => {
  const rows = projectBalances(
    [
      { facility: 'YARD A', sku: 'X', total: 100, damaged: 0, lastTxnTs: 'a' },
      { facility: 'YARD B', sku: 'X', total: 5, damaged: 0, lastTxnTs: 'b' }
    ],
    [{
      sku: 'X', facility: 'YARD A', toFacility: 'YARD B',
      type: 'TRANSFER', status: 'pending', payload: { qty: 30 }
    }]
  );
  const a = rows.find(r => r.facility === 'YARD A');
  const b = rows.find(r => r.facility === 'YARD B');
  assert.equal(a.total, 70);
  assert.equal(b.total, 35);
  // Both figures are provisional until the transfer uploads, so both must say so.
  assert.equal(a.pending, 1, 'the source figure is provisional');
  assert.equal(b.pending, 1, 'the destination figure is provisional too');
});

test('THE KEY INVARIANT: a successful flush must not move the projected total', () => {
  // Before the flush: server has the old figure, the entry sits in the outbox.
  const pendingItem = {
    sku: 'TMT-12MM', facility: 'YARD A', type: 'INBOUND', status: 'pending',
    payload: { qty: 100, damagedQty: 6 }
  };
  const [before] = projectBalances(server, [pendingItem]);

  // After the flush: the server's post-commit figure replaces it, outbox empty.
  // This is what the flush RESPONSE carries back, not a separate read.
  const serverAfter = [{ facility: 'YARD A', sku: 'TMT-12MM', total: 450, damaged: 18, lastTxnTs: 'x' }];
  const [after] = projectBalances(serverAfter, []);

  assert.equal(after.total, before.total, 'total jumped across the flush');
  assert.equal(after.damaged, before.damaged, 'damaged jumped across the flush');
  assert.equal(after.good, before.good, 'good jumped across the flush');
});

test('THE KEY INVARIANT, for a transfer: neither end may jump across the flush', () => {
  // The reverting-stock bug (C1) with two keys instead of one. If the flush
  // reply omits the DESTINATION balance, the phone drops the outbox entry and
  // the destination figure snaps back to its pre-transfer value.
  const serverBefore = [
    { facility: 'YARD A', sku: 'X', total: 100, damaged: 0, lastTxnTs: 'a' },
    { facility: 'YARD B', sku: 'X', total: 5, damaged: 0, lastTxnTs: 'b' }
  ];
  const before = projectBalances(serverBefore, [{
    sku: 'X', facility: 'YARD A', toFacility: 'YARD B',
    type: 'TRANSFER', status: 'pending', payload: { qty: 30 }
  }]);

  const serverAfter = [
    { facility: 'YARD A', sku: 'X', total: 70, damaged: 0, lastTxnTs: 'c' },
    { facility: 'YARD B', sku: 'X', total: 35, damaged: 0, lastTxnTs: 'c' }
  ];
  const after = projectBalances(serverAfter, []);

  for (const fac of ['YARD A', 'YARD B']) {
    const b4 = before.find(r => r.facility === fac);
    const af = after.find(r => r.facility === fac);
    assert.equal(af.total, b4.total, `${fac} total jumped across the flush`);
    assert.equal(af.good, b4.good, `${fac} good jumped across the flush`);
  }
});
