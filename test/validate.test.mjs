/**
 * validateTxn_ — the last line of defence against negative stock.
 *
 * Run:  node --test test/validate.test.mjs
 *
 * WHY THIS FILE EXISTS (X1, the top risk of S02)
 * ----------------------------------------------
 * Until now `validateTxn_` had ZERO tests. It is the only thing standing
 * between a mistyped quantity and a yard balance that goes below zero, and it
 * ends in a "deliberately redundant" post-state assertion that recomputes the
 * end state and refuses it if it is impossible.
 *
 * When `deltasFor_` changed from returning one object to returning a LIST, the
 * old line `var d = deltasFor_(...); var pTotal = total + d.dTotal;` read
 * `dTotal` off an ARRAY. That is `undefined`, so `pTotal` became `NaN` — and
 * `NaN < 0` is false, and `NaN > NaN` is false. The guard therefore returned
 * `null` for EVERY transaction, with no error, no log and no failing test.
 * A silent hole in the one check that cannot be allowed to have holes.
 *
 * Several tests below are written so that they can ONLY pass if the trailing
 * assertion iterates the delta list per entry. Delete that loop and they fail.
 *
 * HOW IT LOADS THE SERVER CODE
 * ----------------------------
 * gas/ is Apps Script: plain global `var`s and `function`s, not modules. So we
 * do what scripts/gas-harness.cjs does — build a `vm` context with the Google
 * globals stubbed, run the gas files into it, and call the function directly.
 * `validateTxn_` is pure: it is handed its snapshot, item map, user map and
 * facility map, and touches no Sheet. The SpreadsheetApp stub below THROWS to
 * keep it that way — if this file ever starts failing with "must not touch the
 * Sheet", validation has grown a read inside the lock that nobody intended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const gas = (f) => readFileSync(join(here, '..', 'gas', f), 'utf8');

function loadGas() {
  const ctx = {
    SpreadsheetApp: {
      openById() { throw new Error('validateTxn_ must not touch the Sheet'); }
    },
    LockService: { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } },
    CacheService: { getScriptCache() { return { get() { return null; }, getAll() { return {}; }, put() {}, putAll() {} }; } },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(s) { return { setMimeType() { return { _body: s }; } }; }
    },
    Logger: { log() {} },
    console
  };
  vm.createContext(ctx);
  for (const f of ['Code.js', 'Balance.js', 'Ledger.js']) {
    vm.runInContext(gas(f), ctx, { filename: f });
  }
  return ctx;
}

const ctx = loadGas();

/* ------------------------------- fixtures ------------------------------- */

const ITEMS = {
  'WIDGET-A': { sku: 'WIDGET-A', description: 'Widget A', uom: 'PCS', barcode: '', active: true, rev: 1 },
  'WIDGET-OLD': { sku: 'WIDGET-OLD', description: 'Retired widget', uom: 'PCS', barcode: '', active: false, rev: 1 }
};

const USERS = { HARISH: true };

const FACILITIES = {
  'YARD A': { facility: 'YARD A', description: 'Main yard', active: true, rev: 1 },
  'YARD B': { facility: 'YARD B', description: 'Overflow yard', active: true, rev: 1 },
  'YARD C': { facility: 'YARD C', description: 'Closed yard', active: false, rev: 1 }
};

/**
 * Build a snapshot map in the shape snapshotMap_() returns, using the REAL
 * balKey_ so this file cannot quietly disagree with the server about the key.
 */
function snapOf(entries) {
  const snap = {};
  let row = 2;
  for (const e of entries) {
    snap[ctx.balKey_(e.facility, e.sku)] = {
      facility: e.facility,
      sku: e.sku,
      total: e.total,
      damaged: e.damaged || 0,
      openingDone: !!e.openingDone,
      lastTxnTs: e.lastTxnTs || '',
      row: row++
    };
  }
  return snap;
}

/** Same shape as the in-batch `working` map submitTxnBatch_ carries. */
function workingOf(entries) {
  const w = {};
  for (const e of entries) {
    w[ctx.balKey_(e.facility, e.sku)] = {
      facility: e.facility,
      sku: e.sku,
      total: e.total,
      damaged: e.damaged || 0,
      openingDone: !!e.openingDone
    };
  }
  return w;
}

/** Call validateTxn_ the way submitTxnBatch_ does, normalising as it does. */
function validate(txn, opts = {}) {
  const t = Object.assign({ recordedBy: 'Harish' }, txn);
  return ctx.validateTxn_(
    t,
    String(t.type || '').toUpperCase(),
    ctx.normFacility_(t.facility),
    ctx.normFacility_(t.toFacility),
    ctx.normSku_(t.sku),
    opts.itemMap || ITEMS,
    opts.users || USERS,
    opts.facMap || FACILITIES,
    opts.snap || {},
    opts.working || {}
  );
}

/* ------------------------------ the signature ----------------------------- */

test('validateTxn_ still takes the ten arguments this file passes it', () => {
  // Every argument is positional. If the signature grows or loses one, every
  // other test in this file would start asserting against garbage — so fail
  // loudly here instead. Contract §4.5:
  // (t, type, facility, toFacility, sku, itemMap, users, facMap, snap, working)
  assert.equal(typeof ctx.validateTxn_, 'function');
  assert.equal(ctx.validateTxn_.length, 10,
    'validateTxn_ signature changed — re-read the call in submitTxnBatch_ before editing this file');
});

/* --------------------- X1: the post-state assertion ---------------------- */

const YARD_A_40 = snapOf([{ facility: 'YARD A', sku: 'WIDGET-A', total: 40, damaged: 3 }]);

test('X1: issuing far more than the yard holds is rejected, never silently allowed', () => {
  const err = validate(
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'WIDGET-A', qty: 9999 },
    { snap: YARD_A_40 }
  );
  assert.ok(err, 'validateTxn_ returned null for an issue of 9999 against 37 good');
  assert.ok(['INSUFFICIENT_GOOD_STOCK', 'WOULD_GO_NEGATIVE'].includes(err.code),
    `unexpected code ${err.code}`);
});

/**
 * A snapshot row that is already impossible: more DAMAGED than TOTAL.
 *
 * The trailing assertion exists precisely because the per-type guards each
 * check one thing in isolation and none of them look at the end state. A row
 * like this reaches them all intact — legacy pre-schema-2 data, a partial
 * migration, or somebody typing in the Sheet can all produce one — and the
 * only code that ever refuses it is the post-state loop.
 *
 * VOID used to be the canary here. It no longer can be: gas/Ledger.js now
 * refuses type VOID at the top of validateTxn_ (cancellations go through
 * voidTxn_), so a VOID never reaches the loop at all. These cases replace it
 * and test the same property — delete the loop and all three return null.
 */
const YARD_A_IMPOSSIBLE = snapOf([
  { facility: 'YARD A', sku: 'WIDGET-A', total: 5, damaged: 50 }
]);

test('X1: ONLY the trailing post-state loop catches an ADJUST_UP that leaves more damaged than total', () => {
  // ADJUST_UP has no per-type rule whatsoever — nothing above the trailing
  // assertion looks at it. If the loop is deleted, or goes back to reading
  // `d.dTotal` off the array, this returns null and the impossible row is
  // written back to the Sheet as if it were fine.
  const err = validate(
    { type: 'ADJUST_UP', facility: 'YARD A', sku: 'WIDGET-A', qty: 1 },
    { snap: YARD_A_IMPOSSIBLE }
  );
  assert.ok(err, 'the post-state assertion is inert — see the file header (X1)');
  assert.equal(err.code, 'WOULD_GO_NEGATIVE');
  assert.match(err.message, /YARD A/, 'the message must name the yard');
});

test('X1: ONLY the trailing post-state loop catches an issue that drives the total below zero', () => {
  // Issuing DAMAGED stock is gated on `qty > damaged`, and 10 <= 50 passes
  // it. The total is what goes negative: 5 - 10 = -5. `NaN < 0` is false too,
  // so this is the branch that went inert when deltasFor_ became a list.
  const err = validate(
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'WIDGET-A', qty: 10, condition: 'DAMAGED' },
    { snap: YARD_A_IMPOSSIBLE }
  );
  assert.ok(err, 'the post-state assertion is inert — see the file header (X1)');
  assert.equal(err.code, 'WOULD_GO_NEGATIVE');
});

test('X1: the trailing loop checks the DESTINATION leg of a transfer, not just the source', () => {
  // X2a/X2c. Every per-type rule for a TRANSFER is written against the
  // SOURCE: `qty > good` uses the source's balance and nothing else looks at
  // the far end. Only a PER-ENTRY post-state check ever evaluates what the
  // stock arriving at YARD B does to YARD B.
  const snap = snapOf([
    { facility: 'YARD A', sku: 'WIDGET-A', total: 100, damaged: 0 },
    { facility: 'YARD B', sku: 'WIDGET-A', total: 0, damaged: 50 }
  ]);
  const err = validate(
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', sku: 'WIDGET-A', qty: 10 },
    { snap }
  );
  assert.ok(err, 'the destination leg was never evaluated — the loop is single-entry again');
  assert.equal(err.code, 'WOULD_GO_NEGATIVE');
  assert.match(err.message, /YARD B/, 'the message must name the DESTINATION, not the source');
});

test('a VOID sent through a BATCH is refused — cancelling goes through voidTxn_', () => {
  // Pinning gas/Ledger.js's TYPES_ALL decision. /exec is ANYONE_ANONYMOUS, so
  // a hand-written POST of {"type":"VOID","voidOfType":"OPENING"} used to pass
  // every check, destroy a unit of stock and clear opening_done — re-opening
  // the guard X5 exists for, one request at a time. deltasFor_ KEEPS its VOID
  // case; only this entry point is closed.
  const err = validate(
    { type: 'VOID', facility: 'YARD A', sku: 'WIDGET-A', qty: 100, damagedQty: 0, voidOfType: 'INBOUND' },
    { snap: YARD_A_40 }
  );
  assert.ok(err, 'a VOID in a batch is not validated at all — it must be refused outright');
  assert.equal(err.code, 'BAD_REQUEST');
  assert.match(err.message, /cancel/i, 'the message must say where cancellations DO go');
});

/* -------------------------------- transfers ------------------------------- */

test('a transfer the source can cover is accepted', () => {
  assert.equal(
    validate(
      { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', sku: 'WIDGET-A', qty: 30 },
      { snap: YARD_A_40 }
    ),
    null
  );
});

test('a transfer the source cannot cover is rejected, and says the transfer may not have uploaded', () => {
  // X13. The destination of a transfer legitimately holds physical stock the
  // server believes is zero, so this rejection will happen to real people who
  // have done nothing wrong. The message has to tell them what to look at.
  const err = validate(
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', sku: 'WIDGET-A', qty: 500 },
    { snap: YARD_A_40 }
  );
  assert.ok(err);
  assert.equal(err.code, 'INSUFFICIENT_GOOD_STOCK');
  assert.match(err.message, /YARD A/);
  assert.match(err.message, /pending uploads/i,
    'X13: the message must point at pending uploads, not just say "not enough stock"');
});

test('a transfer to the same warehouse is rejected', () => {
  const err = validate(
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'yard a', sku: 'WIDGET-A', qty: 5 },
    { snap: YARD_A_40 }
  );
  assert.ok(err, 'a same-yard transfer is a no-op that would still write a ledger row');
  assert.equal(err.code, 'BAD_REQUEST');
});

test('a transfer with no destination is rejected', () => {
  const err = validate(
    { type: 'TRANSFER', facility: 'YARD A', sku: 'WIDGET-A', qty: 5 },
    { snap: YARD_A_40 }
  );
  assert.ok(err);
  assert.equal(err.code, 'BAD_REQUEST');
});

test('a transfer to a warehouse that is not in the list is rejected', () => {
  const err = validate(
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD Z', sku: 'WIDGET-A', qty: 5 },
    { snap: YARD_A_40 }
  );
  assert.ok(err);
  assert.equal(err.code, 'UNKNOWN_FACILITY');
  assert.match(err.message, /YARD Z/);
});

test('a transfer to an INACTIVE warehouse is ACCEPTED', () => {
  // 11.A / A8. The stock has already physically moved. Rejecting it makes the
  // app confidently wrong about where the stock is; the entry is accepted and
  // flagged in remarks by submitTxnBatch_ instead.
  assert.equal(
    validate(
      { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD C', sku: 'WIDGET-A', qty: 5 },
      { snap: YARD_A_40 }
    ),
    null
  );
});

test('an entry AT an inactive warehouse is accepted too', () => {
  // X12: an entry sitting in the outbox when its SOURCE yard is deactivated
  // has an inactive `facility`, not `to_facility`. Same rule.
  assert.equal(
    validate({ type: 'INBOUND', facility: 'YARD C', sku: 'WIDGET-A', qty: 5, damagedQty: 0 }),
    null
  );
});

/* ------------------------------- facilities ------------------------------- */

test('an entry with no warehouse is rejected', () => {
  const err = validate({ type: 'INBOUND', sku: 'WIDGET-A', qty: 5, damagedQty: 0 });
  assert.ok(err, 'an entry with no facility would fold into the "|SKU" orphan key');
  assert.equal(err.code, 'UNKNOWN_FACILITY');
});

test('an entry naming a warehouse that is not in the list is rejected', () => {
  const err = validate({ type: 'INBOUND', facility: 'YARD Z', sku: 'WIDGET-A', qty: 5, damagedQty: 0 });
  assert.ok(err);
  assert.equal(err.code, 'UNKNOWN_FACILITY');
  assert.match(err.message, /YARD Z/);
});

/* ---------------------------- the composite key --------------------------- */

test('THE COMPOSITE KEY: stock at YARD A does not cover an issue at YARD B', () => {
  // PLAN A3's highest-consequence re-key. With a SKU-only working balance the
  // two yards share one figure, so this issue would pass validation and the
  // in-lock post-state would be computed against the wrong yard entirely.
  const err = validate(
    { type: 'OUTBOUND', facility: 'YARD B', sku: 'WIDGET-A', qty: 40 },
    { snap: YARD_A_40 }
  );
  assert.ok(err, 'YARD B holds nothing — issuing 40 there must be refused');
  assert.match(err.message, /YARD B/, 'the message must name the yard that is short');
});

test('THE COMPOSITE KEY: the same SKU at its own yard still passes', () => {
  assert.equal(
    validate({ type: 'OUTBOUND', facility: 'YARD A', sku: 'WIDGET-A', qty: 30 }, { snap: YARD_A_40 }),
    null
  );
});

/* --------------------------- OPENING, the X5 set -------------------------- */

test('a second OPENING at the same warehouse and SKU is refused', () => {
  const snap = snapOf([
    { facility: 'YARD A', sku: 'WIDGET-A', total: 40, damaged: 3, openingDone: true }
  ]);
  const err = validate({ type: 'OPENING', facility: 'YARD A', sku: 'WIDGET-A', qty: 100, damagedQty: 0 }, { snap });
  assert.ok(err);
  assert.equal(err.code, 'OPENING_EXISTS');
  assert.match(err.message, /YARD A/, 'the message must say WHICH yard already has an opening');
});

test('an OPENING at a different warehouse for the same SKU is allowed', () => {
  // The old guard was keyed on the SKU alone, so opening the second yard of a
  // multi-yard setup was impossible.
  const snap = snapOf([
    { facility: 'YARD A', sku: 'WIDGET-A', total: 40, damaged: 3, openingDone: true }
  ]);
  assert.equal(
    validate({ type: 'OPENING', facility: 'YARD B', sku: 'WIDGET-A', qty: 100, damagedQty: 0 }, { snap }),
    null
  );
});

test('an OPENING is allowed on a key that merely has stock from a receipt', () => {
  // 12.A. The old test was `snap[sku] || (total !== 0 || damaged !== 0)`, so a
  // key that had only ever seen an INBOUND was refused with the message
  // "Opening stock is already set" — which was simply untrue. The flag, not
  // the balance, is what says an opening happened.
  assert.equal(
    validate(
      { type: 'OPENING', facility: 'YARD A', sku: 'WIDGET-A', qty: 100, damagedQty: 0 },
      { snap: YARD_A_40 }        // openingDone is false on this fixture
    ),
    null
  );
});

test('X5.1: a second OPENING in the SAME batch is refused via the working balance', () => {
  // Nothing is in the Sheet yet — the first OPENING of the batch has only
  // touched `working`. Reading the flag off `w` rather than off `snap` is what
  // makes this catch, and two openings committing together is exactly the
  // large-absolute-number error the guard exists for.
  const working = workingOf([
    { facility: 'YARD A', sku: 'WIDGET-A', total: 100, damaged: 0, openingDone: true }
  ]);
  const err = validate(
    { type: 'OPENING', facility: 'YARD A', sku: 'WIDGET-A', qty: 5, damagedQty: 0 },
    { snap: {}, working }
  );
  assert.ok(err, 'the in-batch opening flag is not being read');
  assert.equal(err.code, 'OPENING_EXISTS');
});

/* ------------------------- unchanged behaviour ---------------------------- */

test('an inactive item is still rejected', () => {
  const err = validate({ type: 'INBOUND', facility: 'YARD A', sku: 'WIDGET-OLD', qty: 5, damagedQty: 0 });
  assert.ok(err);
  assert.equal(err.code, 'INACTIVE_SKU');
});

test('an item that is not in the list is still rejected', () => {
  const err = validate({ type: 'INBOUND', facility: 'YARD A', sku: 'WIDGET-Z', qty: 5, damagedQty: 0 });
  assert.ok(err);
  assert.equal(err.code, 'UNKNOWN_SKU');
});

test('an unknown transaction type is still rejected', () => {
  const err = validate({ type: 'NONSENSE', facility: 'YARD A', sku: 'WIDGET-A', qty: 5 });
  assert.ok(err);
  assert.equal(err.code, 'BAD_REQUEST');
});

test('a name that is not in the user list is still rejected', () => {
  const err = validate({ type: 'INBOUND', facility: 'YARD A', sku: 'WIDGET-A', qty: 5, damagedQty: 0, recordedBy: 'Nobody' });
  assert.ok(err);
  assert.equal(err.code, 'NO_USER');
});

test('receiving more damaged than received is still rejected', () => {
  const err = validate({ type: 'INBOUND', facility: 'YARD A', sku: 'WIDGET-A', qty: 5, damagedQty: 9 });
  assert.ok(err);
  assert.equal(err.code, 'DAMAGED_EXCEEDS_QTY');
});
