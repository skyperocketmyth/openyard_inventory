/**
 * Open Yard Inventory — setup, diagnostics and self-tests
 * =======================================================
 * `ensureTabs_` is additive only. It creates tabs that are missing and writes
 * headers into a tab that has none. It never clears, renames or reorders
 * anything that is already in the Sheet — the Sheet may hold unrelated work.
 */

function ensureTabs_() {
  var book = ss_();
  var spec = [
    [T_ITEMS, H_ITEMS],
    [T_LEDGER, H_LEDGER],
    [T_USERS, H_USERS],
    [T_META, H_META],
    [T_SNAP, H_SNAP],
    [T_REJ, H_REJ]
  ];
  var created = [];
  var headed = [];
  var existing = [];

  for (var i = 0; i < spec.length; i++) {
    var name = spec[i][0];
    var headers = spec[i][1];
    var sh = book.getSheetByName(name);
    if (!sh) {
      sh = book.insertSheet(name);
      created.push(name);
    } else {
      existing.push(name);
    }
    var firstCell = sh.getRange(1, 1).getValue();
    if (String(firstCell || '').trim() === '') {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#002060')
        .setFontColor('#ffffff');
      sh.setFrozenRows(1);
      headed.push(name);
    }
  }

  // Force every column that holds a CODE to plain-text format.
  // Without this, a SKU like "0.3" is stored as the NUMBER 0.3 — and then
  // "0.50" silently becomes "0.5", two different codes collapse into one, and
  // the ledger stops matching the item master. Codes are identifiers, never
  // quantities, so they must never be coerced.
  var textCols = [
    [T_ITEMS, 1],   // sku
    [T_ITEMS, 4],   // barcode
    [T_LEDGER, 4],  // sku
    [T_SNAP, 1],    // sku
    [T_USERS, 1]    // name
  ];
  var formatted = [];
  for (var c = 0; c < textCols.length; c++) {
    var sh2 = book.getSheetByName(textCols[c][0]);
    if (!sh2) continue;
    var col = textCols[c][1];
    sh2.getRange(2, col, Math.max(sh2.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    formatted.push(textCols[c][0] + '!' + col);
  }

  // Meta defaults — only written when absent, so a live epoch is never reset.
  var meta = metaAll_();
  var defaults = {
    schema_version: 1,
    ledger_epoch: 1,
    items_epoch: 1,
    read_only: 'FALSE',
    min_client_version: '1.0.0'
  };
  var seeded = [];
  for (var k in defaults) {
    if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
    if (!Object.prototype.hasOwnProperty.call(meta, k)) {
      metaSet_(k, defaults[k]);
      seeded.push(k);
    }
  }

  return {
    created: created,
    alreadyThere: existing,
    headersWritten: headed,
    textFormatted: formatted,
    metaSeeded: seeded,
    allTabs: book.getSheets().map(function (s) { return s.getName(); })
  };
}

/**
 * Read-only inspection of the Sheet. Called first, before anything is created,
 * so we can see what is already in the book without touching it.
 */
function diag_() {
  var book = ss_();
  var sheets = book.getSheets();
  var tabs = [];
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    var header = [];
    if (lastRow >= 1 && lastCol >= 1) {
      header = sh.getRange(1, 1, 1, Math.min(lastCol, 20)).getValues()[0]
        .map(function (v) { return String(v || ''); });
    }
    tabs.push({
      name: sh.getName(),
      rows: Math.max(lastRow - 1, 0),
      cols: lastCol,
      header: header
    });
  }
  var expected = [T_ITEMS, T_LEDGER, T_USERS, T_META, T_SNAP, T_REJ];
  var have = tabs.map(function (t) { return t.name; });
  var missing = expected.filter(function (n) { return have.indexOf(n) === -1; });

  return {
    sheetName: book.getName(),
    sheetId: SHEET_ID,
    tabs: tabs,
    missingTabs: missing,
    ready: missing.length === 0,
    meta: missing.indexOf(T_META) === -1 ? metaAll_() : null
  };
}

/* ------------------------------------------------------------------ *
 * purgeTestData — removes ONLY the rows created by the test scripts.
 *
 * The scope is HARDCODED, deliberately. This endpoint is reachable by anyone
 * with the /exec URL (that is what removes the login), so it must not be able
 * to accept a target from the caller. It can only ever delete rows whose item
 * code starts with "ZZTEST-" or is exactly "0.99", and users named in the
 * fixed list below. Real yard data is unreachable from here by construction.
 * ------------------------------------------------------------------ */

var TEST_SKU_EXACT = ['0.99'];
var TEST_SKU_PREFIX = 'ZZTEST-';
var TEST_USERS = ['SMOKE TEST', 'TEMPCHECK'];

function isTestSku_(sku) {
  var s = normSku_(sku);
  if (!s) return false;
  if (s.indexOf(TEST_SKU_PREFIX) === 0) return true;
  return TEST_SKU_EXACT.indexOf(s) !== -1;
}

function purgeTestData_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return { error: 'Server busy, try again' };
  }
  try {
    var removed = { ledger: 0, items: 0, snapshot: 0, rejections: 0, users: 0 };

    // Delete bottom-up so earlier row indexes stay valid as we go.
    removed.ledger = deleteRowsWhere_(T_LEDGER, function (r) { return isTestSku_(r[3]); });
    removed.items = deleteRowsWhere_(T_ITEMS, function (r) { return isTestSku_(r[0]); });
    removed.snapshot = deleteRowsWhere_(T_SNAP, function (r) { return isTestSku_(r[0]); });

    // Every Rejections row so far came from a test run; a rejection is a log
    // entry, not stock, so clearing it loses no inventory truth.
    removed.rejections = deleteRowsWhere_(T_REJ, function () { return true; });

    removed.users = deleteRowsWhere_(T_USERS, function (r) {
      return TEST_USERS.indexOf(str_(r[0]).toUpperCase()) !== -1;
    });
    _users = null;      // rows just went away under readUsers_()'s memo

    // Google's default empty tab, if it is still there and still empty. Named
    // and emptiness-checked, so this cannot remove anything that holds data.
    var stray = ss_().getSheetByName('Sheet1');
    if (stray && stray.getLastRow() === 0 && stray.getLastColumn() === 0) {
      ss_().deleteSheet(stray);
      removed.defaultTab = true;
    }

    bumpEpoch_('ledger_epoch');
    bumpEpoch_('items_epoch');
    return removed;
  } finally {
    lock.releaseLock();
  }
}

/** Delete data rows matching a predicate, bottom-up. Returns the count. */
function deleteRowsWhere_(tabName, predicate) {
  var sh = tab_(tabName);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  var n = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    if (predicate(vals[i])) {
      sh.deleteRow(i + 2);
      n++;
    }
  }
  return n;
}

/** Seed the user list. Safe to re-run — addUser_ is idempotent by name. */
function seedUsers(names) {
  var list = names || ['Harish'];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    addUser_({ name: list[i] });
    out.push(list[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Self-tests — the SERVER half of the shared delta contract.
 * The client half (docs/lib/deltas.js) runs the same cases in Node against
 * test/deltas.fixtures.json. Keep the two lists in step.
 * ------------------------------------------------------------------ */

function runTests() {
  var cases = [
    // [label, txn, expected dTotal, expected dDamaged]
    ['opening plain', { type: 'OPENING', qty: 250, damagedQty: 0 }, 250, 0],
    ['opening with damage', { type: 'OPENING', qty: 250, damagedQty: 6 }, 250, 6],
    ['inbound clean', { type: 'INBOUND', qty: 100, damagedQty: 0 }, 100, 0],
    ['inbound 100 of which 5 damaged', { type: 'INBOUND', qty: 100, damagedQty: 5 }, 100, 5],
    ['outbound good', { type: 'OUTBOUND', qty: 20, condition: 'GOOD' }, -20, 0],
    ['outbound default is good', { type: 'OUTBOUND', qty: 20 }, -20, 0],
    ['outbound damaged hits both', { type: 'OUTBOUND', qty: 5, condition: 'DAMAGED' }, -5, -5],
    ['damage keeps total', { type: 'DAMAGE', qty: 12 }, 0, 12],
    ['repair keeps total', { type: 'REPAIR', qty: 4 }, 0, -4],
    ['adjust up', { type: 'ADJUST_UP', qty: 7 }, 7, 0],
    ['adjust down', { type: 'ADJUST_DOWN', qty: 7 }, -7, 0],
    ['void of inbound', { type: 'VOID', qty: 100, damagedQty: 5, voidOfType: 'INBOUND' }, -100, -5],
    ['void of outbound good', { type: 'VOID', qty: 20, condition: 'GOOD', voidOfType: 'OUTBOUND' }, 20, 0],
    ['void of damage', { type: 'VOID', qty: 12, voidOfType: 'DAMAGE' }, 0, -12],
    ['unknown type is inert', { type: 'NONSENSE', qty: 50 }, 0, 0]
  ];

  var failures = [];
  for (var i = 0; i < cases.length; i++) {
    var label = cases[i][0];
    var d = deltasFor_(cases[i][1]);
    if (d.dTotal !== cases[i][2] || d.dDamaged !== cases[i][3]) {
      failures.push(label + ': got {' + d.dTotal + ',' + d.dDamaged + '} want {' +
        cases[i][2] + ',' + cases[i][3] + '}');
    }
  }

  // The headline scenario from the brief, folded end to end:
  // receive 100 of which 5 damaged, issue 20 good, mark 12 damaged.
  var folded = foldDeltas_([
    { type: 'OPENING', sku: 'X', qty: 0, damagedQty: 0 },
    { type: 'INBOUND', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'OUTBOUND', sku: 'X', qty: 20, condition: 'GOOD' },
    { type: 'DAMAGE', sku: 'X', qty: 12 }
  ]);
  var b = folded['X'];
  if (b.total !== 80 || b.damaged !== 17 || (b.total - b.damaged) !== 63) {
    failures.push('scenario fold: got total ' + b.total + ' damaged ' + b.damaged +
      ' good ' + (b.total - b.damaged) + ' want 80/17/63');
  }

  // Order must not matter — the whole reason every row is a commutative delta.
  var reversed = foldDeltas_([
    { type: 'DAMAGE', sku: 'X', qty: 12 },
    { type: 'OUTBOUND', sku: 'X', qty: 20, condition: 'GOOD' },
    { type: 'INBOUND', sku: 'X', qty: 100, damagedQty: 5 }
  ]);
  if (reversed['X'].total !== b.total || reversed['X'].damaged !== b.damaged) {
    failures.push('fold is not order-independent');
  }

  var result = failures.length
    ? { pass: false, failures: failures, ran: cases.length + 2 }
    : { pass: true, ran: cases.length + 2 };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
