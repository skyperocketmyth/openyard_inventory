/**
 * Open Yard Inventory — setup, diagnostics and self-tests
 * =======================================================
 * `ensureTabs_` is additive only. It creates tabs that are missing and writes
 * headers into a tab that has none. It never clears, renames or reorders
 * anything that is already in the Sheet — the Sheet may hold unrelated work.
 *
 * That is not tidiness, it is a security property: `action=setup` is an
 * UNAUTHENTICATED GET on an ANYONE_ANONYMOUS deployment, so anything
 * destructive in here would be a public wipe button for the whole yard.
 *
 * The consequence, deliberately accepted: a Ledger tab that already carries
 * the old 17-column header keeps it. Widening an existing book to the
 * 20-column shape is migrateToV2's job, not this function's.
 */

function ensureTabs_() {
  var book = ss_();
  var spec = [
    [T_ITEMS, H_ITEMS],
    [T_LEDGER, H_LEDGER],
    [T_USERS, H_USERS],
    [T_META, H_META],
    [T_SNAP, H_SNAP],
    [T_REJ, H_REJ],
    [T_FAC, H_FAC]
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
  // Derived from the H_* maps, never written out by hand: a column inserted
  // ahead of one of these must move the format with it, or the very
  // coercion this exists to prevent lands on whatever moved into slot 4.
  // Each entry carries the header name it EXPECTS to find at that column, and
  // the format is only applied when the live header agrees. Deriving the
  // column from H_* is not enough on its own here: this function runs against
  // whatever tab already exists, so on an un-migrated 17-column Ledger
  // LX.sku + 1 is 6 — which is the OLD `damaged_qty`. Formatting a quantity
  // column as text while leaving the real SKU column General-formatted is
  // precisely the numeric-SKU corruption of 4856d64, applied by the function
  // that exists to prevent it.
  var textCols = [
    [T_ITEMS, IX.sku + 1, 'sku'], [T_ITEMS, IX.barcode + 1, 'barcode'],
    [T_LEDGER, LX.sku + 1, 'sku'], [T_LEDGER, LX.facility + 1, 'facility'],
    [T_LEDGER, LX.to_facility + 1, 'to_facility'],
    [T_SNAP, SX.sku + 1, 'sku'], [T_SNAP, SX.facility + 1, 'facility'],
    [T_USERS, UX.name + 1, 'name'],
    [T_FAC, FX.facility + 1, 'facility']
  ];
  var formatted = [];
  var skipped = [];
  var headerRows = {};
  for (var c = 0; c < textCols.length; c++) {
    var tName = textCols[c][0];
    var col = textCols[c][1];
    var want = textCols[c][2];
    var sh2 = book.getSheetByName(tName);
    if (!sh2) continue;
    if (!Object.prototype.hasOwnProperty.call(headerRows, tName)) {
      var wide = sh2.getLastColumn();
      headerRows[tName] = wide >= 1 ? sh2.getRange(1, 1, 1, wide).getValues()[0] : [];
    }
    var cell = headerRows[tName][col - 1];
    var at = String(cell === undefined || cell === null ? '' : cell).trim().toLowerCase();
    if (at !== want) {
      // Reported, not swallowed: `setup` is a diagnostic as well as a fix, and
      // a silently skipped column would look identical to a healthy run.
      skipped.push(tName + '!' + col + ' expected "' + want + '", found "' + at + '"');
      continue;
    }
    sh2.getRange(2, col, Math.max(sh2.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    formatted.push(tName + '!' + col);
  }

  // Meta defaults — only written when absent, so a live epoch is never reset.
  var meta = metaAll_();
  var defaults = {
    // 2, not 1 — and the two cases really are different. A BRAND NEW book has
    // just been given the CURRENT headers by the loop above, so it is at v2
    // the moment it is created and saying 1 would lock it out through the
    // schema gate for no reason. An EXISTING book is not touched here (a
    // default is only written when the key is ABSENT) and keeps whatever it
    // has until S04's migrateToV2 widens it and sets the flag.
    //
    // The one gap this leaves — an old book that somehow has no
    // schema_version key at all, which would be seeded 2 while still holding
    // 17-column headers — is caught by assertSchema_ comparing the header row
    // itself, not just this number.
    schema_version: 2,
    ledger_epoch: 1,
    items_epoch: 1,
    facilities_epoch: 1,
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
    textSkipped: skipped,
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
      // The WHOLE header, never a truncated window. `diag` is how a human
      // confirms a migration landed, and the old cap of 20 happened to equal
      // H_LEDGER's width by coincidence — a 21st column would have been
      // invisible in the one tool built to show it.
      header = sh.getRange(1, 1, 1, lastCol).getValues()[0]
        .map(function (v) { return String(v || ''); });
    }
    tabs.push({
      name: sh.getName(),
      rows: Math.max(lastRow - 1, 0),
      cols: lastCol,
      header: header
    });
  }
  var expected = [T_ITEMS, T_LEDGER, T_USERS, T_META, T_SNAP, T_REJ, T_FAC];
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
 * code starts with "ZZTEST-" or is exactly "0.99", rows whose warehouse starts
 * with "ZZTEST-", and users named in the fixed list below. Real yard data is
 * unreachable from here by construction — every prefix below is a constant in
 * this file, never a caller input.
 * ------------------------------------------------------------------ */

var TEST_SKU_EXACT = ['0.99'];
var TEST_SKU_PREFIX = 'ZZTEST-';
var TEST_FACILITY_PREFIX = 'ZZTEST-';
var TEST_USERS = ['SMOKE TEST', 'TEMPCHECK'];

function isTestSku_(sku) {
  var s = normSku_(sku);
  if (!s) return false;
  if (s.indexOf(TEST_SKU_PREFIX) === 0) return true;
  return TEST_SKU_EXACT.indexOf(s) !== -1;
}

function isTestFacility_(f) {
  var s = normFacility_(f);
  return !!s && s.indexOf(TEST_FACILITY_PREFIX) === 0;
}

function purgeTestData_() {
  // Gated on the schema like the writes, and for a sharper reason than they
  // have: this decides what to DELETE from positional indexes. On a book that
  // still has the 17-column Ledger, isTestFacility_(r[LX.facility]) is really
  // reading the old `sku` column — so what gets deleted is decided by the
  // wrong data entirely. Same shape of return as the busy-lock path.
  var schemaErr = assertSchema_();
  if (schemaErr) return { error: schemaErr.message, code: schemaErr.code };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return { error: 'Server busy, try again' };
  }
  try {
    var removed = { ledger: 0, items: 0, snapshot: 0, rejections: 0, users: 0, facilities: 0 };

    // Delete bottom-up so earlier row indexes stay valid as we go.
    // A ledger row is test data if EITHER end of it is: a transfer into a test
    // yard is test data even when the item is real.
    removed.ledger = deleteRowsWhere_(T_LEDGER, function (r) {
      return isTestSku_(r[LX.sku]) || isTestFacility_(r[LX.facility]) ||
             isTestFacility_(r[LX.to_facility]);
    });
    removed.items = deleteRowsWhere_(T_ITEMS, function (r) { return isTestSku_(r[IX.sku]); });
    removed.snapshot = deleteRowsWhere_(T_SNAP, function (r) {
      return isTestSku_(r[SX.sku]) || isTestFacility_(r[SX.facility]);
    });

    // Every Rejections row so far came from a test run; a rejection is a log
    // entry, not stock, so clearing it loses no inventory truth.
    removed.rejections = deleteRowsWhere_(T_REJ, function () { return true; });

    removed.users = deleteRowsWhere_(T_USERS, function (r) {
      return TEST_USERS.indexOf(str_(r[UX.name]).toUpperCase()) !== -1;
    });
    _users = null;      // rows just went away under readUsers_()'s memo

    // Guarded on the tab existing: a book set up before the facilities work
    // has no Facilities tab, and tab_() throws on a miss by design.
    if (ss_().getSheetByName(T_FAC)) {
      removed.facilities = deleteRowsWhere_(T_FAC, function (r) {
        return isTestFacility_(r[FX.facility]);
      });
    }

    // Google's default empty tab, if it is still there and still empty. Named
    // and emptiness-checked, so this cannot remove anything that holds data.
    var stray = ss_().getSheetByName('Sheet1');
    if (stray && stray.getLastRow() === 0 && stray.getLastColumn() === 0) {
      ss_().deleteSheet(stray);
      removed.defaultTab = true;
    }

    bumpEpoch_('ledger_epoch');
    bumpEpoch_('items_epoch');
    bumpEpoch_('facilities_epoch');
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

/* ------------------------------------------------------------------ *
 * migrateToV2 — the one-way door.
 *
 * NOT IN route_, and that is the whole point. `action=setup` is an
 * UNAUTHENTICATED GET on an ANYONE_ANONYMOUS deployment; routing anything
 * that CLEARS tabs would publish a one-click wipe button for the entire yard
 * to anyone who has ever seen the /exec URL. This runs from the Apps Script
 * editor, by a human, once. Do not add a case for it.
 *
 * What it does, in an order where every step is safe to stop at:
 *   1. refuse if the book is already v2 — see below, this is the guard that
 *      stops a second run destroying real stock
 *   2. delete every data row from Ledger / Balance_Snapshot / Rejections
 *   3. rewrite those two header rows to the 20- and 8-column shapes
 *   4. ensureTabs_ — creates Facilities, and RE-APPLIES the plain-text column
 *      formats (X8: `sku` moved Ledger 4 -> 6 and Snapshot 1 -> 2, and the '@'
 *      format is only ever applied here, so without this step the first "0.50"
 *      code silently becomes 0.5 again — the corruption fixed in 4856d64)
 *   5. bump ledger_epoch, items_epoch AND facilities_epoch
 *   6. set schema_version = 2 — LAST
 *
 * Why the order matters, both ways round:
 *  - schema_version LAST because the gate checks the header row as well as the
 *    number (assertSchema_). Setting the number first, then failing partway
 *    through, opens the gate onto a half-migrated book — every positional read
 *    would then land on the wrong column and nothing would throw.
 *  - the epochs are bumped EXPLICITLY because ensureTabs_ only seeds ABSENT
 *    Meta keys. Without a bump, getBalancesRead_ answers `unchanged:true` to
 *    every phone and readBalances_/readItems_ keep serving the PRE-wipe rows
 *    out of the epoch-keyed CacheService entry. The deleted numbers would live
 *    on every device forever, with nothing to show they had been deleted.
 *
 * Items and Users are deliberately NOT touched. They are real reference data;
 * it is the stock history that has no warehouse on it and has to go (3.C).
 * ------------------------------------------------------------------ */

function migrateToV2() {
  // A SECOND RUN IS THE DANGEROUS ONE. The first run deletes trial data that
  // is already known to be worthless. By the time anyone runs this again the
  // book holds real opening stock, typed in by hand from a physical count, in
  // an append-only ledger with no backup (13.A). So: if the book is already at
  // v2 with the right headers, this does nothing at all and says so.
  var already = schemaProblem_();
  if (!already) {
    return {
      alreadyDone: true,
      message: 'This sheet is already migrated (schema 2, headers correct). ' +
        'Nothing was changed. Running this again would DELETE live stock.'
    };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return { error: 'Server busy — a write is in progress. Try again in a moment.' };
  }
  try {
    var before = {
      ledger: dataRowCount_(T_LEDGER),
      snapshot: dataRowCount_(T_SNAP),
      rejections: dataRowCount_(T_REJ),
      items: dataRowCount_(T_ITEMS),
      users: dataRowCount_(T_USERS)
    };

    var cleared = {
      ledger: clearDataRows_(T_LEDGER),
      snapshot: clearDataRows_(T_SNAP),
      rejections: clearDataRows_(T_REJ)
    };

    writeHeaderRow_(T_LEDGER, H_LEDGER);
    writeHeaderRow_(T_SNAP, H_SNAP);
    SpreadsheetApp.flush();

    var setup = ensureTabs_();

    var epochs = {
      ledger: bumpEpoch_('ledger_epoch'),
      items: bumpEpoch_('items_epoch'),
      facilities: bumpEpoch_('facilities_epoch')
    };

    metaSet_('schema_version', SCHEMA_VERSION_REQUIRED);
    SpreadsheetApp.flush();

    // The gate memoises its verdict per execution, and this execution has just
    // made that verdict wrong. Drop it so the check below reads the Sheet.
    _schemaErr = undefined;
    var remaining = schemaProblem_();

    var result = {
      ok: !remaining,
      rowsBefore: before,
      rowsDeleted: cleared,
      keptItems: before.items,
      keptUsers: before.users,
      epochs: epochs,
      schemaVersion: SCHEMA_VERSION_REQUIRED,
      textFormatted: setup.textFormatted,
      textSkipped: setup.textSkipped,
      facilitiesTab: setup.created.indexOf(T_FAC) !== -1 ? 'created' : 'already there',
      schemaGate: remaining ? remaining.message : 'open — the app may now write'
    };
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Read-only. Says exactly what migrateToV2 would delete and what it would
 * keep, without touching anything — so the irreversible step can be confirmed
 * against real numbers rather than a promise. Safe to run any number of times.
 */
function migrateToV2Preview() {
  var problem = schemaProblem_();
  var out = {
    alreadyMigrated: !problem,
    wouldDelete: {
      ledgerRows: dataRowCount_(T_LEDGER),
      snapshotRows: dataRowCount_(T_SNAP),
      rejectionRows: dataRowCount_(T_REJ)
    },
    wouldKeep: {
      items: dataRowCount_(T_ITEMS),
      users: dataRowCount_(T_USERS)
    },
    meta: metaAll_()
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Data rows (header excluded) in a tab that may not exist yet. */
function dataRowCount_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return 0;
  return Math.max(sh.getLastRow() - 1, 0);
}

/** Delete every row below the header, in one call. Returns the count. */
function clearDataRows_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var n = last - 1;
  sh.deleteRows(2, n);
  return n;
}

/**
 * Replace a header row wholesale, widening the grid if the new header does not
 * fit. The old row is cleared first: a 20-column header written over a
 * 17-column one leaves nothing behind, but a header that ever SHRANK would
 * strand its last cells to the right of the new one, where headerMatches_
 * cannot see them and a human reading the tab would be misled.
 */
function writeHeaderRow_(name, header) {
  var sh = tab_(name);
  if (sh.getMaxColumns() < header.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, sh.getMaxColumns()).clearContent();
  var range = sh.getRange(1, 1, 1, header.length);
  range.setValues([header]);
  range.setFontWeight('bold').setBackground('#002060').setFontColor('#ffffff');
  sh.setFrozenRows(1);
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
      // [label, txn, expected delta list]
      ['opening plain', { type: 'OPENING', facility: 'YARD A', qty: 250, damagedQty: 0 }, [{ facility: 'YARD A', dTotal: 250, dDamaged: 0 }]],
      ['opening with damage', { type: 'OPENING', facility: 'YARD A', qty: 250, damagedQty: 6 }, [{ facility: 'YARD A', dTotal: 250, dDamaged: 6 }]],
      ['inbound clean', { type: 'INBOUND', facility: 'YARD A', qty: 100, damagedQty: 0 }, [{ facility: 'YARD A', dTotal: 100, dDamaged: 0 }]],
      ['inbound 100 of which 5 damaged', { type: 'INBOUND', facility: 'YARD A', qty: 100, damagedQty: 5 }, [{ facility: 'YARD A', dTotal: 100, dDamaged: 5 }]],
      ['outbound good', { type: 'OUTBOUND', facility: 'YARD A', qty: 20, condition: 'GOOD' }, [{ facility: 'YARD A', dTotal: -20, dDamaged: 0 }]],
      ['outbound default is good', { type: 'OUTBOUND', facility: 'YARD A', qty: 20 }, [{ facility: 'YARD A', dTotal: -20, dDamaged: 0 }]],
      ['outbound damaged hits both', { type: 'OUTBOUND', facility: 'YARD A', qty: 5, condition: 'DAMAGED' }, [{ facility: 'YARD A', dTotal: -5, dDamaged: -5 }]],
      ['damage keeps total', { type: 'DAMAGE', facility: 'YARD A', qty: 12 }, [{ facility: 'YARD A', dTotal: 0, dDamaged: 12 }]],
      ['repair keeps total', { type: 'REPAIR', facility: 'YARD A', qty: 4 }, [{ facility: 'YARD A', dTotal: 0, dDamaged: -4 }]],
      ['adjust up', { type: 'ADJUST_UP', facility: 'YARD A', qty: 7 }, [{ facility: 'YARD A', dTotal: 7, dDamaged: 0 }]],
      ['adjust down', { type: 'ADJUST_DOWN', facility: 'YARD A', qty: 7 }, [{ facility: 'YARD A', dTotal: -7, dDamaged: 0 }]],
      ['void of inbound', { type: 'VOID', facility: 'YARD A', qty: 100, damagedQty: 5, voidOfType: 'INBOUND' }, [{ facility: 'YARD A', dTotal: -100, dDamaged: -5 }]],
      ['void of outbound good', { type: 'VOID', facility: 'YARD A', qty: 20, condition: 'GOOD', voidOfType: 'OUTBOUND' }, [{ facility: 'YARD A', dTotal: 20, dDamaged: 0 }]],
      ['void of damage', { type: 'VOID', facility: 'YARD A', qty: 12, voidOfType: 'DAMAGE' }, [{ facility: 'YARD A', dTotal: 0, dDamaged: -12 }]],
      ['unknown type is inert', { type: 'NONSENSE', facility: 'YARD A', qty: 50 }, [{ facility: 'YARD A', dTotal: 0, dDamaged: 0 }]],
      ['transfer moves good out of one yard and into the other', { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', qty: 30 }, [{ facility: 'YARD A', dTotal: -30, dDamaged: 0 }, { facility: 'YARD B', dTotal: 30, dDamaged: 0 }]],
      ['transfer never moves damaged, whatever the condition says', { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', qty: 10, condition: 'DAMAGED' }, [{ facility: 'YARD A', dTotal: -10, dDamaged: 0 }, { facility: 'YARD B', dTotal: 10, dDamaged: 0 }]],
      ['void of transfer reverses both legs', { type: 'VOID', facility: 'YARD A', toFacility: 'YARD B', qty: 30, voidOfType: 'TRANSFER' }, [{ facility: 'YARD A', dTotal: 30, dDamaged: 0 }, { facility: 'YARD B', dTotal: -30, dDamaged: 0 }]],
      ['the same item at a second yard is a separate key', { type: 'INBOUND', facility: 'YARD B', qty: 60, damagedQty: 0 }, [{ facility: 'YARD B', dTotal: 60, dDamaged: 0 }]]
    ];

  var failures = [];
  for (var i = 0; i < cases.length; i++) {
    var label = cases[i][0];
    var got = deltasFor_(cases[i][1]);
    var want = cases[i][2];
    if (got.length !== want.length) {
      failures.push(label + ': got ' + got.length + ' entries, want ' + want.length);
      continue;
    }
    for (var j = 0; j < want.length; j++) {
      if (got[j].facility !== want[j].facility ||
          got[j].dTotal !== want[j].dTotal ||
          got[j].dDamaged !== want[j].dDamaged) {
        failures.push(label + ' [' + j + ']: got {' + got[j].facility + ',' +
          got[j].dTotal + ',' + got[j].dDamaged + '} want {' + want[j].facility + ',' +
          want[j].dTotal + ',' + want[j].dDamaged + '}');
      }
    }
  }

  // The headline scenario from the brief, folded end to end:
  // receive 100 of which 5 damaged, issue 20 good, mark 12 damaged.
  var folded = foldDeltas_([
    { type: 'OPENING', facility: 'YARD A', sku: 'X', qty: 0, damagedQty: 0 },
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 5 },
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'X', qty: 20, condition: 'GOOD' },
    { type: 'DAMAGE', facility: 'YARD A', sku: 'X', qty: 12 }
  ]);
  var b = folded['YARD A|X'];
  if (b.total !== 80 || b.damaged !== 17 || (b.total - b.damaged) !== 63) {
    failures.push('scenario fold: got total ' + b.total + ' damaged ' + b.damaged +
      ' good ' + (b.total - b.damaged) + ' want 80/17/63');
  }

  // Order must not matter — the whole reason every row is a commutative delta.
  var reversed = foldDeltas_([
    { type: 'DAMAGE', facility: 'YARD A', sku: 'X', qty: 12 },
    { type: 'OUTBOUND', facility: 'YARD A', sku: 'X', qty: 20, condition: 'GOOD' },
    { type: 'INBOUND', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 5 }
  ]);
  if (reversed['YARD A|X'].total !== b.total || reversed['YARD A|X'].damaged !== b.damaged) {
    failures.push('fold is not order-independent');
  }

  // The two-key fold. The case list above compares one txn at a time, so it
  // cannot show that a TRANSFER lands on two DIFFERENT keys — which is the
  // whole point of the composite key.
  var moved = foldDeltas_([
    { type: 'OPENING', facility: 'YARD A', sku: 'X', qty: 100, damagedQty: 0 },
    { type: 'TRANSFER', facility: 'YARD A', toFacility: 'YARD B', sku: 'X', qty: 30 }
  ]);
  if (!moved['YARD A|X'] || moved['YARD A|X'].total !== 70 ||
      !moved['YARD B|X'] || moved['YARD B|X'].total !== 30) {
    failures.push('transfer fold: got ' +
      ((moved['YARD A|X'] && moved['YARD A|X'].total) + '/' +
       (moved['YARD B|X'] && moved['YARD B|X'].total)) + ' want 70/30');
  }

  var result = failures.length
    ? { pass: false, failures: failures, ran: cases.length + 3 }
    : { pass: true, ran: cases.length + 3 };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
