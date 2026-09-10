/**
 * The write path, round-tripped: what goes into a ledger row must be what
 * comes back out of it.
 *
 * Run:  node --test test/ledger-roundtrip.test.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * S02 reordered the Sheet headers — `Ledger` went from 17 columns to 20 with
 * `facility` and `to_facility` inserted at positions 4 and 5, `Balance_Snapshot`
 * from 6 to 8 — and NOTHING tested that a written row still lines up with its
 * header. `test/validate.test.mjs` never calls a write path at all, and
 * `scripts/gas-harness.cjs` only prints state for a human to eyeball.
 *
 * A slot swap in a 20-element positional literal does not throw. It returns a
 * NEIGHBOURING CELL: a vehicle number where the location should be, a
 * destination yard where the source should be. Every screen keeps working and
 * every number stays plausible, which is precisely why it would survive
 * review. This file is the control that makes it fail loudly instead.
 *
 * WHAT IT ASSERTS, and in three independent ways per row:
 *   1. the RAW grid cell, addressed by the header name in this file's OWN copy
 *      of the header — so a swap inside the positional literal fails even if
 *      H_LEDGER moved with it;
 *   2. what `getLedgerRead_` hands the phone;
 *   3. what `snapshotMap_` folds it into.
 *
 * Both 20-slot literals are covered: the one in `submitTxnBatch_`, and the
 * SEPARATE one in `voidTxn_`, which copies the original's facility, vehicle,
 * reference and location forward and is the easier of the two to get wrong.
 *
 * HOW IT LOADS THE SERVER CODE
 * ----------------------------
 * The same `vm` trick as test/validate.test.mjs and scripts/gas-harness.cjs:
 * gas/ is Apps Script, plain global `var`s and `function`s, so the files are
 * run into a context with the Google globals faked. Unlike validate.test.mjs,
 * this one DOES need a Sheet, so there is a small in-memory one below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const gas = (f) => readFileSync(join(here, '..', 'gas', f), 'utf8');

/* ------------------------------------------------------------------ *
 * The headers, written out by hand HERE.
 *
 * This is a second, independent copy on purpose. Addressing the grid
 * through gas/Code.js's own H_LEDGER would move with any reordering and
 * assert nothing. Keeping a copy means a column change has to be made
 * deliberately, in two places, by someone who has read both.
 * ------------------------------------------------------------------ */
const LEDGER_HEADER = ['txn_id', 'idem_key', 'txn_type', 'facility', 'to_facility', 'sku',
  'qty', 'damaged_qty', 'condition', 'ref_no', 'vehicle_no', 'location', 'remarks',
  'recorded_by', 'client_ts', 'server_ts', 'device_id', 'app_version',
  'void_of_txn_id', 'void_of_type'];

const SNAP_HEADER = ['facility', 'sku', 'total_qty', 'damaged_qty', 'good_qty',
  'opening_done', 'last_txn_ts', 'updated_ts'];

/* ---------------------------- the fake Sheet ---------------------------- */

function makeSheet(grid) {
  const sh = {
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getMaxRows: () => Math.max(grid.length, 100),
    getRange(r, c, nr, nc) {
      nr = nr === undefined ? 1 : nr;
      nc = nc === undefined ? 1 : nc;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = grid[r - 1 + i] || [];
            const o = [];
            for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            out.push(o);
          }
          return out;
        },
        getValue() { return this.getValues()[0][0]; },
        setValues(v) {
          for (let i = 0; i < v.length; i++) {
            const tr = r - 1 + i;
            while (grid.length <= tr) grid.push([]);
            for (let j = 0; j < v[i].length; j++) grid[tr][c - 1 + j] = v[i][j];
          }
          return this;
        },
        setValue(x) {
          while (grid.length < r) grid.push([]);
          grid[r - 1][c - 1] = x;
          return this;
        },
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setFontColor() { return this; },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            const tr = r - 1 + i;
            if (!grid[tr]) continue;
            for (let j = 0; j < nc; j++) grid[tr][c - 1 + j] = '';
          }
          return this;
        }
      };
    },
    appendRow(row) { grid.push(row.slice()); },
    setFrozenRows() {},
    deleteRow(i) { grid.splice(i - 1, 1); }
  };
  return sh;
}

/** One request = one fresh vm context, exactly as a real /exec call is. */
function request(book) {
  const sheets = {};
  for (const k in book) sheets[k] = makeSheet(book[k]);
  const ctx = {
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName(n) { return sheets[n] || null; },
          getSheets() { return Object.keys(sheets).map(k => sheets[k]); },
          getName() { return 'fake'; },
          insertSheet(n) { book[n] = []; sheets[n] = makeSheet(book[n]); return sheets[n]; },
          deleteSheet() {}
        };
      }
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

/** Unwrap the ContentService envelope the write paths return. */
const payload = (out) => JSON.parse(out._body);

/* ------------------------------- the book ------------------------------- */

function book() {
  return {
    Items: [['sku', 'description', 'uom', 'barcode', 'active', 'cb', 'ct', 'ub', 'ut', 'item_rev'],
      ['WIDGET-A', 'Widget A', 'PCS', '', true, 'x', 't', 'x', 't', 1]],
    Ledger: [LEDGER_HEADER.slice()],
    Users: [['name', 'active', 'added_ts'], ['Harish', true, 't']],
    // schema_version 2: the write paths refuse a book that still says 1.
    Meta: [['key', 'value'], ['schema_version', 2], ['ledger_epoch', 7],
      ['items_epoch', 3], ['read_only', 'FALSE'], ['facilities_epoch', 1]],
    Balance_Snapshot: [SNAP_HEADER.slice(),
      ['YARD A', 'WIDGET-A', 40, 3, 37, false, '2026-09-01T00:00:00.000Z', 't']],
    Facilities: [['facility', 'description', 'active', 'created_by', 'created_ts', 'facility_rev'],
      ['YARD A', 'Main yard', true, 'Harish', 't', 1],
      ['YARD B', 'Overflow yard', true, 'Harish', 't', 1]],
    Rejections: [['server_ts', 'idem_key', 'recorded_by', 'device_id', 'payload_json', 'error_code', 'error_message']]
  };
}

/** Read one cell of a grid row BY HEADER NAME, using this file's own header. */
const cell = (row, name) => row[LEDGER_HEADER.indexOf(name)];

/**
 * A cross-realm date check. The plain `x instanceof Date` test is FALSE for a
 * Date built inside the vm, because a different realm has a different Date
 * constructor. The brand string does not care which realm made it.
 *
 * Worth checking at all because the Sheet stores a real Date in server_ts: a
 * path that quietly wrote an ISO string instead would still read back fine
 * through getLedgerRead_ while breaking any date filter in the Sheet itself.
 */
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

/* ------------------------- the header itself ---------------------------- */

test('the Sheet headers gas/ writes against are the ones this file asserts on', () => {
  // If this fails, a column was added, removed or moved. That is allowed —
  // but every positional literal in gas/Ledger.js has to move with it, so
  // update this file DELIBERATELY rather than to make the suite go green.
  const ctx = request(book());
  // Array.from: these come out of the vm realm, so their prototype is not
  // this realm's Array.prototype and deepEqual would fail on that alone.
  assert.deepEqual(Array.from(ctx.H_LEDGER), LEDGER_HEADER,
    'H_LEDGER moved — re-check both 20-slot literals in gas/Ledger.js');
  assert.deepEqual(Array.from(ctx.H_SNAP), SNAP_HEADER,
    'H_SNAP moved — re-check applySnapshotDeltas_ and rebuildSnapshot_');
});

/* ---------------------- submitTxnBatch_, one receipt --------------------- */

const RECEIPT = {
  idemKey: 'roundtrip01',
  type: 'INBOUND',
  facility: 'YARD A',
  sku: 'WIDGET-A',
  qty: 137,
  damagedQty: 11,
  condition: 'GOOD',
  refNo: 'GRN-4471',
  vehicleNo: 'dxb 90210',
  location: 'BAY 7',
  remarks: 'unloaded at the north gate',
  recordedBy: 'Harish',
  clientTs: '2026-09-07T06:15:00.000Z'
};

test('every field of a receipt survives the write: the RAW row matches its header', () => {
  // Deliberately picked so no two values could be confused for each other:
  // swapping any pair of these cells changes what this test sees.
  const b = book();
  const ctx = request(b);
  const res = payload(ctx.submitTxnBatch_({
    txns: [RECEIPT], deviceId: 'dev_abc123', appVersion: '1.2.3'
  }));

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.results[0].status, 'applied', JSON.stringify(res.data.results[0]));
  const txnId = res.data.results[0].txnId;

  const row = b.Ledger[b.Ledger.length - 1];
  assert.equal(row.length, LEDGER_HEADER.length, 'the appended row is not as wide as the header');

  assert.equal(cell(row, 'txn_id'), txnId);
  assert.equal(cell(row, 'idem_key'), 'roundtrip01');
  assert.equal(cell(row, 'txn_type'), 'INBOUND');
  assert.equal(cell(row, 'facility'), 'YARD A');
  assert.equal(cell(row, 'to_facility'), '', 'only a movement BETWEEN yards carries a destination');
  assert.equal(cell(row, 'sku'), 'WIDGET-A');
  assert.equal(cell(row, 'qty'), 137);
  assert.equal(cell(row, 'damaged_qty'), 11);
  assert.equal(cell(row, 'condition'), 'GOOD');
  assert.equal(cell(row, 'ref_no'), 'GRN-4471');
  assert.equal(cell(row, 'vehicle_no'), 'DXB 90210', 'normVehicle_ uppercases and caps at 20');
  assert.equal(cell(row, 'location'), 'BAY 7');
  assert.equal(cell(row, 'remarks'), 'unloaded at the north gate');
  assert.equal(cell(row, 'recorded_by'), 'Harish');
  assert.equal(cell(row, 'client_ts'), '2026-09-07T06:15:00.000Z', 'the PHONE\'s time, kept verbatim');
  assert.ok(isDate(cell(row, 'server_ts')), 'server_ts must be the server\'s own clock');
  assert.equal(cell(row, 'device_id'), 'dev_abc123');
  assert.equal(cell(row, 'app_version'), '1.2.3');
  assert.equal(cell(row, 'void_of_txn_id'), '');
  assert.equal(cell(row, 'void_of_type'), '');
});

test('every field of a receipt comes back out of getLedgerRead_ unchanged', () => {
  const b = book();
  const ctx = request(b);
  const res = payload(ctx.submitTxnBatch_({
    txns: [RECEIPT], deviceId: 'dev_abc123', appVersion: '1.2.3'
  }));
  const txnId = res.data.results[0].txnId;

  const read = ctx.getLedgerRead_('WIDGET-A', 50, 'YARD A');
  const got = read.rows[0];                       // newest first
  assert.ok(got, 'the row just written is not visible to the reader');

  assert.deepEqual({
    txnId: got.txnId, type: got.type, facility: got.facility, toFacility: got.toFacility,
    sku: got.sku, qty: got.qty, damagedQty: got.damagedQty, condition: got.condition,
    refNo: got.refNo, vehicleNo: got.vehicleNo, location: got.location,
    remarks: got.remarks, recordedBy: got.recordedBy, clientTs: got.clientTs,
    voidOf: got.voidOf, voidOfType: got.voidOfType
  }, {
    txnId: txnId, type: 'INBOUND', facility: 'YARD A', toFacility: '',
    sku: 'WIDGET-A', qty: 137, damagedQty: 11, condition: 'GOOD',
    refNo: 'GRN-4471', vehicleNo: 'DXB 90210', location: 'BAY 7',
    remarks: 'unloaded at the north gate', recordedBy: 'Harish',
    clientTs: '2026-09-07T06:15:00.000Z',
    voidOf: '', voidOfType: ''
  });
  // serverTs is the server's own clock, so it can only be checked for shape.
  assert.match(got.serverTs, /^\d{4}-\d{2}-\d{2}T/, 'serverTs must read back as an ISO timestamp');
});

test('the receipt lands on the right snapshot row, in the right columns', () => {
  const b = book();
  const ctx = request(b);
  ctx.submitTxnBatch_({ txns: [RECEIPT], deviceId: 'dev_abc123', appVersion: '1.2.3' });

  // Re-read from the Sheet rather than trusting the in-memory map the write
  // path advanced: that is the half of the round trip a column slip breaks.
  const snap = ctx.snapshotMap_();
  const b1 = snap[ctx.balKey_('YARD A', 'WIDGET-A')];
  assert.ok(b1, 'the snapshot row for YARD A|WIDGET-A disappeared');
  assert.equal(b1.facility, 'YARD A');
  assert.equal(b1.sku, 'WIDGET-A');
  assert.equal(b1.total, 177);            // 40 + 137
  assert.equal(b1.damaged, 14);           // 3 + 11
  assert.equal(b1.openingDone, false, 'a receipt must not set the opening flag');

  const srow = b.Balance_Snapshot[1];
  assert.equal(srow[SNAP_HEADER.indexOf('good_qty')], 163,
    'good_qty is stored, and must be total - damaged');
  assert.equal(srow.length, SNAP_HEADER.length, 'the snapshot row is not as wide as its header');
});

/* ------------------- submitTxnBatch_, a transfer (2 yards) --------------- */

test('a transfer writes its SOURCE and DESTINATION into the right two columns', () => {
  // facility and to_facility are adjacent, same type, same shape. Swapping
  // them sends the stock the wrong way and nothing anywhere throws.
  const b = book();
  const ctx = request(b);
  const res = payload(ctx.submitTxnBatch_({
    txns: [{
      idemKey: 'roundtrip02', type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B',
      sku: 'WIDGET-A', qty: 10, recordedBy: 'Harish', clientTs: '2026-09-07T07:00:00.000Z'
    }],
    deviceId: 'dev_abc123', appVersion: '1.2.3'
  }));
  assert.equal(res.data.results[0].status, 'applied', JSON.stringify(res.data.results[0]));

  const row = b.Ledger[b.Ledger.length - 1];
  assert.equal(cell(row, 'facility'), 'YARD A', 'the source yard is column "facility"');
  assert.equal(cell(row, 'to_facility'), 'YARD B', 'the destination yard is column "to_facility"');
  assert.equal(cell(row, 'qty'), 10);

  const read = ctx.getLedgerRead_('WIDGET-A', 50, 'YARD B');
  assert.equal(read.rows.length, 1, 'a transfer is history at the yard it arrived at too');
  assert.equal(read.rows[0].facility, 'YARD A');
  assert.equal(read.rows[0].toFacility, 'YARD B');

  const snap = ctx.snapshotMap_();
  assert.equal(snap[ctx.balKey_('YARD A', 'WIDGET-A')].total, 30);
  assert.equal(snap[ctx.balKey_('YARD B', 'WIDGET-A')].total, 10);
});

/* ------------------------------- voidTxn_ -------------------------------- */

/** The book with a committed TRANSFER of 10 WIDGET-A, YARD A -> YARD B. */
function transferredBook() {
  const b = book();
  b.Ledger.push(['OY-TRF1', 'idemtrf1', 'TRANSFER', 'YARD A', 'YARD B', 'WIDGET-A', 10, 0, 'GOOD',
    'GRN-9911', 'DXB 555', 'BAY 2', 'moved to overflow', 'Harish',
    '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 'd', '1.0.0', '', '']);
  b.Balance_Snapshot[1] = ['YARD A', 'WIDGET-A', 30, 3, 27, false, '2026-09-03T00:00:00.000Z', 't'];
  b.Balance_Snapshot.push(['YARD B', 'WIDGET-A', 10, 0, 10, false, '2026-09-03T00:00:00.000Z', 't']);
  return b;
}

test('the VOID row voidTxn_ writes is a SECOND 20-slot literal, and it lines up too', () => {
  // voidTxn_ builds its own positional array, separate from submitTxnBatch_'s.
  // It copies the original's facility, destination, reference, vehicle and
  // location forward — five adjacent string columns, which is as easy to get
  // one out of step as it sounds.
  const b = transferredBook();
  const ctx = request(b);
  const res = payload(ctx.voidTxn_({
    txnId: 'OY-TRF1', idemKey: 'voidtrf12345', recordedBy: 'Harish',
    reason: 'wrong yard', deviceId: 'dev_abc123', appVersion: '1.2.3'
  }));
  assert.equal(res.ok, true, JSON.stringify(res));

  const row = b.Ledger[b.Ledger.length - 1];
  assert.equal(row.length, LEDGER_HEADER.length, 'the VOID row is not as wide as the header');
  assert.equal(cell(row, 'idem_key'), 'voidtrf12345');
  assert.equal(cell(row, 'txn_type'), 'VOID');
  assert.equal(cell(row, 'facility'), 'YARD A', 'the void must carry the original SOURCE yard');
  assert.equal(cell(row, 'to_facility'), 'YARD B', 'and its DESTINATION, or the reversal loses a leg');
  assert.equal(cell(row, 'sku'), 'WIDGET-A');
  assert.equal(cell(row, 'qty'), 10);
  assert.equal(cell(row, 'damaged_qty'), 0);
  assert.equal(cell(row, 'condition'), 'GOOD');
  assert.equal(cell(row, 'ref_no'), 'GRN-9911', 'copied forward from the original');
  assert.equal(cell(row, 'vehicle_no'), 'DXB 555', 'copied forward from the original');
  assert.equal(cell(row, 'location'), 'BAY 2', 'copied forward from the original');
  assert.match(String(cell(row, 'remarks')), /Cancelled OY-TRF1.*wrong yard/);
  assert.equal(cell(row, 'recorded_by'), 'Harish');
  assert.match(String(cell(row, 'client_ts')), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(isDate(cell(row, 'server_ts')), 'server_ts must be the server\'s own clock');
  assert.equal(cell(row, 'device_id'), 'dev_abc123');
  assert.equal(cell(row, 'app_version'), '1.2.3');
  assert.equal(cell(row, 'void_of_txn_id'), 'OY-TRF1');
  assert.equal(cell(row, 'void_of_type'), 'TRANSFER');
});

test('the VOID row reads back through getLedgerRead_ and reverses BOTH yards', () => {
  const b = transferredBook();
  const ctx = request(b);
  ctx.voidTxn_({
    txnId: 'OY-TRF1', idemKey: 'voidtrf12345', recordedBy: 'Harish',
    reason: 'wrong yard', deviceId: 'dev_abc123', appVersion: '1.2.3'
  });

  const got = ctx.getLedgerRead_('WIDGET-A', 50, '').rows[0];
  assert.equal(got.type, 'VOID');
  assert.equal(got.facility, 'YARD A');
  assert.equal(got.toFacility, 'YARD B');
  assert.equal(got.vehicleNo, 'DXB 555');
  assert.equal(got.refNo, 'GRN-9911');
  assert.equal(got.location, 'BAY 2');
  assert.equal(got.voidOf, 'OY-TRF1');
  assert.equal(got.voidOfType, 'TRANSFER');

  const snap = ctx.snapshotMap_();
  assert.equal(snap[ctx.balKey_('YARD A', 'WIDGET-A')].total, 40, 'the source gets its stock back');
  assert.equal(snap[ctx.balKey_('YARD B', 'WIDGET-A')].total, 0, 'the destination gives it up');
});
