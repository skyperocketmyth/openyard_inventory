/**
 * The Activity date filter, server side: `getLedger`'s `since`/`until` window.
 *
 * Run:  node --test test/ledger-window.test.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two separate things here are easy to get wrong and impossible to notice:
 *
 * 1. WHICH DAY AN OFFLINE ENTRY BELONGS TO. A movement recorded in the yard at
 *    23:00 and uploaded at 08:00 the next morning happened YESTERDAY. Filter on
 *    the moment it ARRIVED and it shows up under today, the yard's own day
 *    totals stop matching the paperwork, and every number on screen still looks
 *    perfectly reasonable. The window is therefore compared against
 *    `client_ts`, and the test below is built around exactly that row.
 *
 * 2. THE EARLY STOP. `ledgerRowsSince_` reads the tab backwards in blocks and
 *    stops once a block predates the cutoff — which is the only reason "today"
 *    is cheaper than "all time". Stopping one block too soon silently drops
 *    real movements off the end of the list. So this asserts BOTH that the read
 *    is bounded (by counting the ranges actually requested) and that nothing
 *    inside the window went missing.
 *
 * Dates are FIXED INSTANTS, never derived from `new Date()`. A window test
 * written against "now" passes at 10:00 and fails at 00:30, and Dubai is
 * UTC+4, so a test that computes its own midnight is testing the test.
 *
 * Dubai is UTC+4 with no DST, ever — so 00:00 Dubai is 20:00 UTC the day
 * before. Every boundary below is written as the UTC instant to make that
 * arithmetic visible rather than implied.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const gas = (f) => readFileSync(join(here, '..', 'gas', f), 'utf8');

/* An independent copy of the header, for the same reason as
 * test/ledger-roundtrip.test.mjs: addressing the grid through gas/'s own
 * H_LEDGER would move with a reordering and assert nothing. */
const LEDGER_HEADER = ['txn_id', 'idem_key', 'txn_type', 'facility', 'to_facility', 'sku',
  'qty', 'damaged_qty', 'condition', 'ref_no', 'vehicle_no', 'location', 'remarks',
  'recorded_by', 'client_ts', 'server_ts', 'device_id', 'app_version',
  'void_of_txn_id', 'void_of_type'];
const SNAP_HEADER = ['facility', 'sku', 'total_qty', 'damaged_qty', 'good_qty',
  'opening_done', 'last_txn_ts', 'updated_ts'];

/* ---- the Dubai day boundaries this file works in, as UTC instants ---- */
const DUBAI = {
  // 2026-09-21 00:00 +04:00
  todayStart: '2026-09-20T20:00:00.000Z',
  // 2026-09-20 00:00 +04:00
  yestStart: '2026-09-19T20:00:00.000Z',
  // 2026-09-14 00:00 +04:00  (7 days back)
  weekStart: '2026-09-13T20:00:00.000Z'
};

/** A minimal Sheet that RECORDS every range it was asked for. */
function makeSheet(grid, log, name) {
  return {
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getMaxRows: () => Math.max(grid.length, 100),
    getRange(r, c, nr, nc) {
      nr = nr === undefined ? 1 : nr;
      nc = nc === undefined ? 1 : nc;
      log.push({ tab: name, row: r, rows: nr });
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
        setValues() { return this; },
        setValue() { return this; },
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setFontColor() { return this; }
      };
    },
    appendRow(row) { grid.push(row.slice()); },
    setFrozenRows() {}
  };
}

function request(book) {
  const log = [];
  const sheets = {};
  for (const k in book) sheets[k] = makeSheet(book[k], log, k);
  const ctx = {
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName(n) { return sheets[n] || null; },
          getSheets() { return Object.keys(sheets).map(k => sheets[k]); },
          getName() { return 'fake'; }
        };
      }
    },
    LockService: { getScriptLock() { return { tryLock: () => true, releaseLock() {} }; } },
    CacheService: {
      getScriptCache() {
        return { get: () => null, getAll: () => ({}), put() {}, putAll() {} };
      }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(t) { return { setMimeType() { return { getContent: () => t }; } }; }
    },
    Utilities: { sleep() {} },
    Logger: { log() {} },
    console
  };
  vm.createContext(ctx);
  for (const f of ['Code.js', 'Balance.js', 'Ledger.js', 'Setup.js']) {
    vm.runInContext(gas(f), ctx, { filename: f });
  }
  ctx.__log = log;
  return ctx;
}

/** A row. `clientTs`/`serverTs` may be a Date OR an ISO string, on purpose. */
function row(txnId, sku, qty, clientTs, serverTs) {
  const r = new Array(LEDGER_HEADER.length).fill('');
  const at = (name, v) => { r[LEDGER_HEADER.indexOf(name)] = v; };
  at('txn_id', txnId);
  at('idem_key', 'idem_' + txnId);
  at('txn_type', 'INBOUND');
  at('facility', 'YARD A');
  at('sku', sku);
  at('qty', qty);
  at('damaged_qty', 0);
  at('recorded_by', 'Harish');
  at('client_ts', clientTs);
  at('server_ts', serverTs);
  return r;
}

function baseBook(ledgerRows) {
  return {
    Meta: [['key', 'value'], ['schema_version', 2], ['ledger_epoch', 5],
      ['items_epoch', 2], ['facilities_epoch', 1], ['read_only', 'FALSE']],
    Ledger: [LEDGER_HEADER.slice()].concat(ledgerRows),
    Balance_Snapshot: [SNAP_HEADER.slice()]
  };
}

/*
 * The fixture. Sheet order is append order, which is server_ts order — the
 * invariant the early stop depends on, so the fixture must respect it.
 *
 * OLD    recorded and uploaded a week ago
 * LATE   recorded 23:00 YESTERDAY Dubai, uploaded 08:00 TODAY  <- the one that matters
 * TODAY1 recorded and uploaded this morning, stored as real Dates
 * TODAY2 same, but stored as legacy ISO STRINGS, to prove both shapes filter
 */
const FIXTURE = [
  // Far outside every bounded window, so the week/month cutoffs are tested
  // against something rather than just against each other.
  row('OY-ANCIENT', 'WIDGET-Z', 5,
    new Date('2026-08-02T06:00:00.000Z'), new Date('2026-08-02T06:00:00.000Z')),
  row('OY-OLD', 'WIDGET-A', 11,
    new Date('2026-09-15T06:00:00.000Z'), new Date('2026-09-15T06:00:00.000Z')),
  row('OY-LATE', 'WIDGET-B', 22,
    new Date('2026-09-20T19:00:00.000Z'), new Date('2026-09-21T04:00:00.000Z')),
  row('OY-TODAY1', 'WIDGET-C', 33,
    new Date('2026-09-21T05:05:00.000Z'), new Date('2026-09-21T05:05:00.000Z')),
  row('OY-TODAY2', 'WIDGET-D', 44,
    '2026-09-21T06:30:00.000Z', '2026-09-21T06:30:00.000Z')
];

/**
 * `Array.from`, not `res.rows.map(...)`, and the difference is not style.
 *
 * `res.rows` was built inside the vm context, so it is an Array from THAT
 * realm with that realm's prototype. `assert.deepStrictEqual` compares
 * prototypes, so a vm-realm array never equals a host-realm literal — and it
 * fails by printing `actual` and `expected` as two IDENTICAL-looking lists,
 * which is a genuinely baffling half hour if you do not know. Array.from
 * rebuilds the list in this realm; String() does the same for each element.
 *
 * test/ledger-roundtrip.test.mjs avoids this by accident, because its
 * `payload()` helper JSON round-trips every response back into the host realm.
 */
const ids = res => Array.from(res.rows, r => String(r.txnId));

test('no window at all returns every movement, exactly as before', () => {
  const ctx = request(baseBook(FIXTURE));
  const res = ctx.getLedgerRead_('', '200', '', '', '');
  assert.deepEqual(ids(res), ['OY-TODAY2', 'OY-TODAY1', 'OY-LATE', 'OY-OLD', 'OY-ANCIENT'],
    'newest first, nothing dropped');
  assert.equal(res.more, false);
});

test("today shows only what was recorded today, in the yard's own time", () => {
  const ctx = request(baseBook(FIXTURE));
  const res = ctx.getLedgerRead_('', '200', '', DUBAI.todayStart, '');
  assert.deepEqual(ids(res), ['OY-TODAY2', 'OY-TODAY1'],
    'a real Date row and a legacy string row both filter the same way');
});

test('an entry recorded last night and uploaded this morning is NOT today', () => {
  // THE ONE THAT MATTERS. OY-LATE arrived at 08:00 Dubai today, so filtering on
  // arrival would put it in today's list. It was recorded at 23:00 last night
  // and belongs to yesterday.
  const ctx = request(baseBook(FIXTURE));
  const today = ctx.getLedgerRead_('', '200', '', DUBAI.todayStart, '');
  assert.ok(!ids(today).includes('OY-LATE'),
    'a movement that happened yesterday must not be counted under today');
});

test('...and it DOES show under yesterday, the day it actually happened', () => {
  const ctx = request(baseBook(FIXTURE));
  const res = ctx.getLedgerRead_('', '200', '', DUBAI.yestStart, DUBAI.todayStart);
  assert.deepEqual(ids(res), ['OY-LATE'],
    'yesterday is a closed window: today is excluded by `until`, the week before by `since`');
});

test('a week back reaches the older rows but still stops before the oldest', () => {
  const ctx = request(baseBook(FIXTURE));
  const res = ctx.getLedgerRead_('', '200', '', DUBAI.weekStart, '');
  // 15 Sep IS inside a 14 Sep cutoff — the first version of this test expected
  // it out and was simply wrong about its own arithmetic. August is what a
  // 7-day window has to exclude.
  assert.deepEqual(ids(res), ['OY-TODAY2', 'OY-TODAY1', 'OY-LATE', 'OY-OLD'],
    'the whole week, and nothing older');
  assert.ok(!ids(res).includes('OY-ANCIENT'), 'August is not in the last 7 days');
});

test('the window composes with the SKU filter rather than replacing it', () => {
  const ctx = request(baseBook(FIXTURE));
  const res = ctx.getLedgerRead_('WIDGET-D', '200', '', DUBAI.todayStart, '');
  assert.deepEqual(ids(res), ['OY-TODAY2']);
});

test('a blank timestamp does not silently fall inside the window', () => {
  // `tsMs_` returns null for a blank, and a null compared with `<` would be
  // coerced to 0 and read as "very old" — or, worse, pass a `>=` check. An
  // unstamped row must be excluded from a bounded window, not guessed into it.
  const odd = FIXTURE.concat([row('OY-BLANK', 'WIDGET-E', 55, '', '')]);
  const ctx = request(baseBook(odd));
  const res = ctx.getLedgerRead_('', '200', '', DUBAI.todayStart, '');
  assert.ok(!ids(res).includes('OY-BLANK'), 'no timestamp means no place in a window');
  const all = ctx.getLedgerRead_('', '200', '', '', '');
  assert.ok(ids(all).includes('OY-BLANK'), 'but it is still part of the full history');
});

test('hitting the cap says so instead of presenting a truncated list as complete', () => {
  const many = [];
  for (let i = 0; i < 30; i++) {
    const t = new Date(Date.parse('2026-09-21T05:00:00.000Z') + i * 60000);
    many.push(row('OY-' + i, 'WIDGET-A', i + 1, t, t));
  }
  const ctx = request(baseBook(many));
  const res = ctx.getLedgerRead_('', '10', '', DUBAI.todayStart, '');
  assert.equal(res.rows.length, 10);
  assert.equal(res.more, true, 'more must be true when the cap cut the list short');

  const ctx2 = request(baseBook(many));
  const all = ctx2.getLedgerRead_('', '200', '', DUBAI.todayStart, '');
  assert.equal(all.rows.length, 30);
  assert.equal(all.more, false, 'and false when the whole window fitted');
});

test('reading today does not read the whole tab', () => {
  // The actual "loads faster" claim, asserted rather than assumed. 900 rows of
  // history with 3 rows from today: a windowed read must request far fewer than
  // 900 rows. Without the early stop this reads all of them and the numbers
  // below are ~900 vs ~900.
  const many = [];
  for (let i = 0; i < 900; i++) {
    const t = new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 3600000);
    many.push(row('OLD-' + i, 'WIDGET-A', 1, t, t));
  }
  for (let i = 0; i < 3; i++) {
    const t = new Date(Date.parse('2026-09-21T05:00:00.000Z') + i * 60000);
    many.push(row('NEW-' + i, 'WIDGET-A', 9, t, t));
  }

  const ctx = request(baseBook(many));
  const res = ctx.getLedgerRead_('', '200', '', DUBAI.todayStart, '');
  const windowed = ctx.__log
    .filter(g => g.tab === 'Ledger')
    .reduce((s, g) => s + g.rows, 0);

  assert.deepEqual(ids(res), ['NEW-2', 'NEW-1', 'NEW-0'],
    'the early stop must not drop anything inside the window');

  const ctx2 = request(baseBook(many));
  ctx2.getLedgerRead_('', '200', '', '', '');
  const full = ctx2.__log
    .filter(g => g.tab === 'Ledger')
    .reduce((s, g) => s + g.rows, 0);

  assert.ok(windowed < full / 2,
    `a windowed read should be far smaller than a full one — read ${windowed} rows vs ${full}`);
  assert.ok(full >= 900, `the unwindowed control must really read everything (read ${full})`);
});

test('the early stop survives an unreadable timestamp mid-history', () => {
  // A single corrupt server_ts must not truncate the read. The rule is
  // "stop only on a timestamp that parses AND predates the cutoff" — a
  // garbage cell keeps the scan going rather than silently ending the list.
  const many = [];
  for (let i = 0; i < 5; i++) {
    const t = new Date(Date.parse('2026-09-21T05:00:00.000Z') + i * 60000);
    many.push(row('NEW-' + i, 'WIDGET-A', 1, t, t));
  }
  many.splice(2, 0, row('OY-JUNK', 'WIDGET-Z', 7,
    'not a date at all', 'not a date at all'));

  const ctx = request(baseBook(many));
  const res = ctx.getLedgerRead_('', '200', '', DUBAI.todayStart, '');
  assert.equal(res.rows.length, 5, 'all five real rows still come back');
  assert.ok(!ids(res).includes('OY-JUNK'), 'and the junk row is not in the window');
});
