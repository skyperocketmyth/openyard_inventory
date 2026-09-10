/**
 * Open Yard Inventory — Apps Script backend (router + reads)
 * =========================================================
 * Sheet is the database. The `Ledger` tab is append-only and is the ONLY source
 * of truth; every balance is a fold over it. `Balance_Snapshot` is a derived
 * cache maintained inside the write lock and rebuildable at any time.
 *
 * Transport rules that are NOT negotiable (each has cost time before):
 *  - The client POSTs with Content-Type: text/plain. Apps Script cannot answer a
 *    CORS preflight, so no custom headers may ever be required.
 *  - HTTP status is always 200 (ContentService cannot set one). `error.retryable`
 *    in the body is the entire retry contract.
 *  - appsscript.json MUST keep its `webapp` block or `clasp push` republishes
 *    this project as a library and /exec dies.
 */

var SHEET_ID = '1eoS12tnEJ1YEjF3_89rxFjI9fu6b0yU-Cy9wVqB5RNo';

var T_ITEMS = 'Items';
var T_LEDGER = 'Ledger';
var T_USERS = 'Users';
var T_META = 'Meta';
var T_SNAP = 'Balance_Snapshot';
var T_REJ = 'Rejections';
var T_FAC = 'Facilities';

var H_ITEMS = ['sku', 'description', 'uom', 'barcode', 'active',
  'created_by', 'created_ts', 'updated_by', 'updated_ts', 'item_rev'];
var H_LEDGER = ['txn_id', 'idem_key', 'txn_type', 'facility', 'to_facility', 'sku',
  'qty', 'damaged_qty', 'condition', 'ref_no', 'vehicle_no', 'location', 'remarks',
  'recorded_by', 'client_ts', 'server_ts', 'device_id', 'app_version',
  'void_of_txn_id', 'void_of_type'];
var H_USERS = ['name', 'active', 'added_ts'];
var H_META = ['key', 'value'];
var H_SNAP = ['facility', 'sku', 'total_qty', 'damaged_qty', 'good_qty',
  'opening_done', 'last_txn_ts', 'updated_ts'];
var H_REJ = ['server_ts', 'idem_key', 'recorded_by', 'device_id',
  'payload_json', 'error_code', 'error_message'];
var H_FAC = ['facility', 'description', 'active', 'created_by', 'created_ts', 'facility_rev'];

/**
 * Header name -> zero-based column index.
 *
 * Every positional read in this project goes through one of these maps. The
 * numeric-SKU corruption fixed in commit 4856d64 came back the moment a column
 * was inserted ahead of a hardcoded index, so hardcoded indexes are now banned:
 * inserting a column can only ever move an index, never silently point at the
 * wrong data.
 */
function hIx_(header) {
  // Object.create(null), not {} — a prototype-less map. A plain object answers
  // LX.constructor and LX.toString with a FUNCTION, so a header that ever
  // acquires one of those names would resolve to a prototype member and the
  // read would land on column NaN. There is nothing on this object but the
  // columns.
  var m = Object.create(null);
  for (var i = 0; i < header.length; i++) m[header[i]] = i;
  return m;
}

/**
 * The width of a run of ADJACENT columns, with the adjacency asserted.
 *
 * A `setValues` over a window — description..active on Items, say — only
 * writes the right cells while those columns stay next to each other AND in
 * that order. A hardcoded width silently writes `uom` into `barcode` the day
 * a column is inserted between them, which is the same class of failure as
 * the hardcoded indexes banned above. So the caller names the columns it is
 * about to write, in order, and this refuses out loud if they have moved
 * apart.
 */
function colRun_(header, names) {
  var ix = hIx_(header);
  for (var i = 0; i < names.length; i++) {
    if (ix[names[i]] === undefined) {
      throw new Error('No such column: ' + names[i]);
    }
    if (i > 0 && ix[names[i]] !== ix[names[i - 1]] + 1) {
      throw new Error('Columns ' + names[i - 1] + ' and ' + names[i] +
        ' are no longer adjacent — this write would land in the wrong column');
    }
  }
  return names.length;
}
var LX = hIx_(H_LEDGER);
var SX = hIx_(H_SNAP);
var FX = hIx_(H_FAC);
var IX = hIx_(H_ITEMS);
var UX = hIx_(H_USERS);
var MX = hIx_(H_META);

var UOMS = ['PCS', 'KG', 'MT', 'BAG', 'BUNDLE', 'CBM', 'ROLL', 'LTR'];
var MAX_BATCH = 25;
var LOCK_MS = 15000;
var CACHE_TTL = 21600;   // CacheService maximum
// There is deliberately NO idempotency-key cache TTL here any more. X4:
// ledgerIdemKeys_ (a plain full read of the ledger's first two columns) is the
// ONLY source of truth for "have I seen this key". A cached key with no ledger
// row behind it makes the server answer `duplicate`, and the client then
// deletes the outbox entry without it ever having been written. Do not re-add.

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

function jsonOk_(data) {
  return _json({ ok: true, data: data || {}, meta: metaBlock_() });
}

function jsonErr_(code, message, retryable) {
  return _json({
    ok: false,
    error: { code: code, message: message, retryable: !!retryable }
  });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * The envelope must never be the thing that fails. Before `setup` has run there
 * is no Meta tab, and a throw here made even `diag` — the tool for finding out
 * what is missing — impossible to call.
 */
function metaBlock_() {
  var out = { epoch: 0, itemsEpoch: 0, facilitiesEpoch: 0, schemaVersion: 0,
              serverTs: new Date().toISOString() };
  try {
    out.epoch = Number(metaGet_('ledger_epoch') || 0);
    out.itemsEpoch = Number(metaGet_('items_epoch') || 0);
    out.facilitiesEpoch = Number(metaGet_('facilities_epoch') || 0);
    out.schemaVersion = Number(metaGet_('schema_version') || 1);
  } catch (err) {
    out.needsSetup = true;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || 'ping';
    return route_(action, p, null);
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  }
}

function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return jsonErr_('BAD_REQUEST', 'Body was not valid JSON', false);
  }
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || body.action || '';
    return route_(action, p, body);
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  }
}

/**
 * The three actions that MUST stay reachable on a book with the wrong shape:
 * `diag` is the tool for finding out what is wrong, `setup` is part of fixing
 * it, and `ping` must never depend on the Sheet at all.
 *
 * Everything else is gated — DENY BY DEFAULT, so an action added later cannot
 * forget to opt in. That includes the reads (a misread column returns a
 * confidently wrong number, which is worse than an error) and purgeTestData
 * (it decides what to DELETE from positional indexes).
 */
var SCHEMA_OPEN_ACTIONS = ['ping', 'diag', 'setup'];

function route_(action, p, body) {
  if (SCHEMA_OPEN_ACTIONS.indexOf(action) === -1) {
    var schemaErr = assertSchema_();
    // Retryable, always — see assertSchema_. A phone must hold its entries,
    // never bin them, while the Sheet is behind the app.
    if (schemaErr) return jsonErr_(schemaErr.code, schemaErr.message, true);
  }
  switch (action) {
    /* reads */
    case 'ping':          return jsonOk_({ pong: true });
    case 'diag':          return jsonOk_(diag_());
    case 'bootstrap':     return jsonOk_(bootstrap_());
    case 'getBalances':   return jsonOk_(getBalancesRead_(p.sinceEpoch));
    case 'getItems':      return jsonOk_(getItemsRead_(p.sinceEpoch));
    case 'getFacilities': return jsonOk_(getFacilitiesRead_(p.sinceEpoch));
    case 'getUsers':      return jsonOk_({ names: readUsers_() });
    case 'getLedger':     return jsonOk_(getLedgerRead_(p.sku, p.limit, p.facility));

    /* writes */
    case 'submitTxnBatch': return submitTxnBatch_(body);
    case 'upsertItem':     return upsertItem_(body);
    case 'upsertFacility': return upsertFacility_(body);
    case 'addUser':        return addUser_(body);
    case 'setUserActive':  return setUserActive_(body);
    case 'voidTxn':        return voidTxn_(body);

    /* maintenance */
    case 'setup':           return jsonOk_(ensureTabs_());
    case 'rebuildSnapshot': return jsonOk_(rebuildSnapshot_());
    case 'purgeTestData':  return jsonOk_(purgeTestData_());

    default:
      return jsonErr_('UNKNOWN_ACTION', 'Unknown action: ' + action, false);
  }
}

/* ------------------------------------------------------------------ *
 * Sheet helpers
 * ------------------------------------------------------------------ */

/* ---------------------------------------------------------------- *
 * Per-request memos.
 *
 * Every Apps Script HTTP request runs in a FRESH JS context, so a
 * module-level variable is born and dies inside one request. That is what
 * makes these memos safe by construction: they CANNOT go stale across
 * requests — there is nothing to invalidate between two calls — and within
 * a single request the only writer is us. Where we do write, the memo is
 * kept coherent explicitly (see metaSet_ / addUser_ / setUserActive_).
 *
 * The reason this matters: every response builds metaBlock_, `tab_` used to
 * re-open the Spreadsheet on every single call, and `metaGet_` re-read the
 * whole Meta tab per key. A one-line write cost ~30 Sheet round trips.
 * ---------------------------------------------------------------- */

var _ss = null;         // the Spreadsheet, opened at most once per request
var _tabs = {};         // tab name -> Sheet
var _meta = null;       // the whole Meta tab as a map, or null when unread
var _metaRows = {};     // Meta key -> its Sheet row, learned by the same read
var _users = null;      // readUsers_() result, or null when unread

function ss_() {
  if (!_ss) _ss = SpreadsheetApp.openById(SHEET_ID);
  return _ss;
}

function tab_(name) {
  if (Object.prototype.hasOwnProperty.call(_tabs, name)) return _tabs[name];
  var sh = ss_().getSheetByName(name);
  // Only a HIT is memoised: a miss must keep throwing every time, because
  // action=setup can create the tab later in this same request.
  if (!sh) throw new Error('Missing tab: ' + name + ' — run action=setup');
  _tabs[name] = sh;
  return sh;
}

/** All data rows of a tab as arrays (header stripped). Empty tab -> []. */
function rows_(name) {
  var sh = tab_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
}

function metaGet_(key) {
  var m = metaAll_();
  return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
}

function metaAll_() {
  if (_meta) return _meta;
  var out = {};
  var rowOf = {};
  var vals = rows_(T_META);
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var k = String(row[MX.key] || '').trim();
    // The row number is free here and saves metaSet_ re-reading the key column
    // to find it. Safe because nothing in this project ever deletes or reorders
    // a Meta row — metaSet_ only overwrites in place or appends.
    if (k) { out[k] = row[MX.value]; rowOf[k] = i + 2; }
  }
  // Assigned only on success — a throw here (no Meta tab yet) must stay a
  // throw on the next call, which is what lets metaBlock_ report needsSetup.
  _meta = out;
  _metaRows = rowOf;
  return out;
}

/** Write a Meta key. Caller is expected to hold the lock for write paths. */
function metaSet_(key, value) {
  var sh = tab_(T_META);
  var row = Object.prototype.hasOwnProperty.call(_metaRows, key)
    ? _metaRows[key]
    : 0;

  if (!row) {
    // Not learned yet (no metaAll_ this request) — fall back to the scan.
    var last = sh.getLastRow();
    if (last >= 2) {
      // One column wide, so the inner index is 0 by construction, not a guess
      // at where `key` lives — that is what MX.key + 1 on the range pins down.
      var keys = sh.getRange(2, MX.key + 1, last - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i][0] || '').trim() === key) { row = i + 2; break; }
      }
    }
  }

  if (row) {
    sh.getRange(row, MX.value + 1).setValue(value);
  } else {
    sh.appendRow([key, value]);
    _metaRows[key] = sh.getLastRow();
  }
  // Keep the memo coherent AFTER the Sheet write has succeeded, so a failed
  // write never leaves a value in memory that is not in the Sheet. Writing
  // through rather than dropping the memo also means the three metaGet_ calls
  // metaBlock_ makes on the way out cost nothing.
  if (_meta) _meta[key] = value;
}

/**
 * The read feeding the increment must be FRESH. Epochs are the client's only
 * "has anything changed?" signal, and in the write paths metaAll_ was first
 * populated BEFORE the lock was taken (the read_only check) — by the time we
 * hold the lock another execution may already have bumped the epoch. Reusing
 * the pre-lock value would rewrite an epoch a phone has already seen, i.e.
 * silently tell every device that this write never happened. So drop the memo
 * and re-read under the caller's lock.
 */
function bumpEpoch_(key) {
  _meta = null;
  _metaRows = {};      // dropped together: metaAll_ repopulates both or neither
  var next = Number(metaGet_(key) || 0) + 1;
  metaSet_(key, next);
  return next;
}

/* ---------------------------------------------------------------- *
 * The schema gate.
 *
 * The Ledger went 17 -> 20 columns and Balance_Snapshot 6 -> 8, but
 * ensureTabs_ is ADDITIVE by design (it must never rewrite an existing header
 * row — action=setup is an unauthenticated GET) and migrateToV2 is S04's job.
 * So this code can be pointed at a book that still has the old shape, and the
 * damage is entirely silent: LX.facility (3) reads the old `sku`, LX.sku (5)
 * reads the old `damaged_qty`, and a 20-cell setValues append SUCCEEDS into a
 * 17-column tab because a Sheets grid is 26 columns wide by default. The
 * result is an append-only ledger holding two different row shapes with no
 * marker to tell them apart, and rebuildSnapshot_ — routed UNAUTHENTICATED —
 * folding that into the snapshot. Nothing anywhere throws.
 *
 * So: refuse, before anything positional runs.
 *
 * The version number alone is not enough — a book can say 2 and not have been
 * widened, and S04 has to set the flag and move the columns in some order — so
 * the header row itself is compared BY NAME. Names are compared case- and
 * whitespace-insensitively on purpose: a human recapitalising a header is
 * cosmetic (every index comes from H_*, never from the Sheet) and a false
 * positive here stops the entire yard from uploading.
 *
 * THE ERROR IS RETRYABLE, and that word is load-bearing. A non-retryable
 * rejection makes docs/lib/outbox.js move the entry to `failures` and DELETE
 * it from the queue — losing a movement that physically happened, the exact
 * failure the EMPTY_BODY handling in gas/Ledger.js was hardened against.
 * Retryable means the phone simply holds its entries and the pill says
 * pending until the Sheet has been migrated.
 * ---------------------------------------------------------------- */

var SCHEMA_VERSION_REQUIRED = 2;

var _schemaErr;   // undefined = not checked yet; null = fine; object = the problem

function assertSchema_() {
  // Memoised per request exactly like _ss / _meta / _users above, and safe for
  // the same reason: a fresh JS context per HTTP request means there is
  // nothing to invalidate between two calls. A THROW is deliberately NOT
  // memoised (the memo is only assigned on a clean return) — a missing tab can
  // still be created by action=setup later in this same request.
  if (_schemaErr !== undefined) return _schemaErr;
  _schemaErr = schemaProblem_();
  return _schemaErr;
}

function schemaProblem_() {
  if (Number(metaGet_('schema_version') || 0) < SCHEMA_VERSION_REQUIRED) {
    return schemaMismatch_();
  }
  // Checked only once the version claims to be current, so an un-migrated book
  // costs no extra Sheet reads at all — it fails on the Meta value already in
  // the per-request memo.
  if (!headerMatches_(T_LEDGER, H_LEDGER)) return schemaMismatch_();
  if (!headerMatches_(T_SNAP, H_SNAP)) return schemaMismatch_();
  return null;
}

/**
 * For the raw-data readers, which return a plain object and so have no
 * envelope of their own to fail into. Through HTTP the gate in route_ has
 * already answered properly with SCHEMA_MISMATCH, so this only ever fires on
 * a direct call — from the Apps Script editor, or from
 * scripts/gas-harness.cjs, both of which bypass the router entirely.
 */
function assertSchemaOrThrow_() {
  var bad = assertSchema_();
  if (bad) throw new Error(bad.message);
}

/** Plain English, because a yard worker reads it on a phone in the sun. */
function schemaMismatch_() {
  return {
    code: 'SCHEMA_MISMATCH',
    message: 'The app has been updated but the sheet has not. Your entries are ' +
      'safe and will upload once this is finished.'
  };
}

function headerMatches_(name, header) {
  var got = tab_(name).getRange(1, 1, 1, header.length).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    var cell = got[i] === undefined || got[i] === null ? '' : got[i];
    if (String(cell).trim().toLowerCase() !== String(header[i]).toLowerCase()) {
      return false;
    }
  }
  return true;
}

function newTxnId_() {
  return 'OY-' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * A boolean field on an UPDATE, where "not supplied" must mean "leave it as
 * it is" rather than "false".
 *
 * `undefined`, `null` AND `''` all count as not supplied. JSON round trips and
 * form serialisers turn an absent field into any of the three, and the
 * difference decides whether a warehouse stays open: `{"active": null}` read
 * as `!!null` deactivates a live yard while its owner thought they were
 * editing the description. That is the silent-reactivation bug of e6b8cd8 in
 * reverse, and the `rev` guards two lines from each call site already spell
 * all three out — these did not.
 */
function boolOrKeep_(v, current) {
  if (v === undefined || v === null || v === '') return !!current;
  return !!v;
}

function normSku_(v) {
  return str_(v).toUpperCase();
}

/** The stored form of a warehouse name. Trimmed and uppercased, nothing else. */
function normFacility_(v) {
  return str_(v).toUpperCase();
}

/**
 * The NEAR-DUPLICATE normal form. "Yard A", "yard a", "Yard-A" and "YardA" all
 * fold to YARDA, so upsertFacility_ can refuse the second of them. Two yards
 * that differ only by a space would otherwise each hold half the stock, and no
 * screen in the app would show them as the same place.
 *
 * This is a comparison key ONLY. It is never stored and never used as a
 * balance key — normFacility_ is what the Sheet and 'FACILITY|SKU' carry.
 */
function facilityFold_(v) {
  return normFacility_(v).replace(/[^A-Z0-9]/g, '');
}

/** Vehicle numbers are written on a plate, so uppercase; 20 chars is the column. */
function normVehicle_(v) {
  return str_(v).toUpperCase().slice(0, 20);
}

/* ------------------------------------------------------------------ *
 * Chunked cache — CacheService caps a single entry at 100KB.
 * Copied from Stock_Take_Webapp/Code.js, which already solved this.
 * ------------------------------------------------------------------ */

function setCacheChunked_(key, obj) {
  var cache = CacheService.getScriptCache();
  var s = JSON.stringify(obj);
  var size = 90000;
  var n = Math.ceil(s.length / size);
  var put = {};
  for (var i = 0; i < n; i++) {
    put[key + '_' + i] = s.substr(i * size, size);
  }
  put[key + '_chunks'] = String(n);
  try {
    cache.putAll(put, CACHE_TTL);
  } catch (err) {
    // A cache write failure must never fail the request.
  }
}

function getCacheChunked_(key) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key + '_chunks') || 0);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys);
  var s = '';
  for (var j = 0; j < n; j++) {
    var part = got[key + '_' + j];
    if (part === null || part === undefined) return null;  // a missing chunk = invalid
    s += part;
  }
  try {
    return JSON.parse(s);
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

function bootstrap_() {
  assertSchemaOrThrow_();
  var meta = metaBlock_();
  return {
    users: readUsers_(),
    items: readItems_(),
    facilities: readFacilities_(),
    balances: readBalances_(),
    meta: {
      epoch: meta.epoch,
      itemsEpoch: meta.itemsEpoch,
      facilitiesEpoch: meta.facilitiesEpoch,
      serverTs: meta.serverTs,
      schemaVersion: meta.schemaVersion,
      uoms: UOMS,
      readOnly: String(metaGet_('read_only') || '') === 'TRUE'
    }
  };
}

/**
 * `sinceEpoch` lets a poll cost 40 bytes instead of 60KB on a weak signal.
 * If the client's epoch matches ours, nothing has been written since.
 */
function getBalancesRead_(sinceEpoch) {
  var epoch = Number(metaGet_('ledger_epoch') || 0);
  if (sinceEpoch !== undefined && sinceEpoch !== null && sinceEpoch !== '' &&
      Number(sinceEpoch) === epoch) {
    return { unchanged: true, epoch: epoch };
  }
  return { unchanged: false, epoch: epoch, balances: readBalances_() };
}

function getItemsRead_(sinceEpoch) {
  var epoch = Number(metaGet_('items_epoch') || 0);
  if (sinceEpoch !== undefined && sinceEpoch !== null && sinceEpoch !== '' &&
      Number(sinceEpoch) === epoch) {
    return { unchanged: true, itemsEpoch: epoch };
  }
  return { unchanged: false, itemsEpoch: epoch, items: readItems_() };
}

function getFacilitiesRead_(sinceEpoch) {
  var epoch = Number(metaGet_('facilities_epoch') || 0);
  if (sinceEpoch !== undefined && sinceEpoch !== null && sinceEpoch !== '' &&
      Number(sinceEpoch) === epoch) {
    return { unchanged: true, facilitiesEpoch: epoch };
  }
  return { unchanged: false, facilitiesEpoch: epoch, facilities: readFacilities_() };
}

function readUsers_() {
  if (_users) return _users;
  var out = [];
  var vals = rows_(T_USERS);
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var name = str_(row[UX.name]);
    var active = row[UX.active];
    if (name && active !== false && String(active).toUpperCase() !== 'FALSE') {
      out.push(name);
    }
  }
  _users = out;
  return out;
}

function readItems_() {
  var key = 'oy_items_v1_' + Number(metaGet_('items_epoch') || 0);
  var hit = getCacheChunked_(key);
  if (hit) return hit;

  var out = [];
  var vals = rows_(T_ITEMS);
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var sku = normSku_(row[IX.sku]);
    if (!sku) continue;
    var active = row[IX.active];
    out.push({
      sku: sku,
      description: str_(row[IX.description]),
      uom: str_(row[IX.uom]) || 'PCS',
      barcode: str_(row[IX.barcode]),
      active: !(active === false || String(active).toUpperCase() === 'FALSE'),
      rev: num_(row[IX.item_rev])
    });
  }
  out.sort(function (a, b) { return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0; });
  setCacheChunked_(key, out);
  return out;
}

/**
 * The warehouse list. Cached under its own epoch exactly as readItems_ is —
 * it is reference data that changes a handful of times a year and is read on
 * every bootstrap.
 */
function readFacilities_() {
  var key = 'oy_fac_v1_' + Number(metaGet_('facilities_epoch') || 0);
  var hit = getCacheChunked_(key);
  if (hit) return hit;

  var out = [];
  var vals = rows_(T_FAC);
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var facility = normFacility_(row[FX.facility]);
    if (!facility) continue;
    var active = row[FX.active];
    out.push({
      facility: facility,
      description: str_(row[FX.description]),
      active: !(active === false || String(active).toUpperCase() === 'FALSE'),
      rev: num_(row[FX.facility_rev])
    });
  }
  out.sort(function (a, b) {
    return a.facility < b.facility ? -1 : a.facility > b.facility ? 1 : 0;
  });
  setCacheChunked_(key, out);
  return out;
}

/** FACILITY -> the record, for the validation path. Mirrors itemMapBySku_. */
function facilityMap_() {
  var list = readFacilities_();
  var m = {};
  for (var i = 0; i < list.length; i++) m[list[i].facility] = list[i];
  return m;
}

/**
 * Balances come from the snapshot tab, cached under the ledger epoch.
 *
 * The cache key is v2, not v1: a balance row gained a `facility` and the map
 * gained a composite key. A v1 entry still sitting in CacheService from the
 * pre-facilities build would deserialise into the new reader as a list of
 * facility-less rows, which the phone would then merge as if they were real.
 */
function readBalances_() {
  // Before the cache lookup: a wrong-shaped Snapshot must never be read, and
  // must certainly never be CACHED under a key a later, migrated request
  // would hit.
  assertSchemaOrThrow_();
  var key = 'oy_bal_v2_' + Number(metaGet_('ledger_epoch') || 0);
  var hit = getCacheChunked_(key);
  if (hit) return hit;

  var map = snapshotMap_();
  var out = [];
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    var b = map[k];
    // X3 — the facility and the sku are read off the VALUE, never by splitting
    // the 'FACILITY|SKU' key. Warehouse names are near-free text, so one
    // containing a '|' would split into a different facility entirely.
    out.push({
      facility: b.facility,
      sku: b.sku,
      total: b.total,
      damaged: b.damaged,
      good: b.total - b.damaged,
      lastTxnTs: b.lastTxnTs || ''
    });
  }
  out.sort(balanceRowOrder_);
  setCacheChunked_(key, out);
  return out;
}

/** Facility, then SKU. One comparator so every list is in the same order. */
function balanceRowOrder_(a, b) {
  if (a.facility !== b.facility) return a.facility < b.facility ? -1 : 1;
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

function getLedgerRead_(sku, limit, facility) {
  assertSchemaOrThrow_();
  var want = normSku_(sku);
  var wantFac = normFacility_(facility);
  var cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  var vals = rows_(T_LEDGER);
  var out = [];
  for (var i = vals.length - 1; i >= 0 && out.length < cap; i--) {
    var r = vals[i];
    if (want && normSku_(r[LX.sku]) !== want) continue;
    // Either end matches: a transfer is history at the yard it left AND at the
    // yard it arrived at, and a supervisor looking at one of them must see it.
    if (wantFac && normFacility_(r[LX.facility]) !== wantFac &&
        normFacility_(r[LX.to_facility]) !== wantFac) continue;
    out.push({
      txnId: str_(r[LX.txn_id]),
      type: str_(r[LX.txn_type]),
      facility: normFacility_(r[LX.facility]),
      toFacility: normFacility_(r[LX.to_facility]),
      sku: normSku_(r[LX.sku]),
      qty: num_(r[LX.qty]),
      damagedQty: num_(r[LX.damaged_qty]),
      condition: str_(r[LX.condition]),
      refNo: str_(r[LX.ref_no]),
      vehicleNo: str_(r[LX.vehicle_no]),
      location: str_(r[LX.location]),
      remarks: str_(r[LX.remarks]),
      recordedBy: str_(r[LX.recorded_by]),
      clientTs: r[LX.client_ts] instanceof Date
        ? r[LX.client_ts].toISOString() : str_(r[LX.client_ts]),
      serverTs: r[LX.server_ts] instanceof Date
        ? r[LX.server_ts].toISOString() : str_(r[LX.server_ts]),
      voidOf: str_(r[LX.void_of_txn_id]),
      voidOfType: str_(r[LX.void_of_type])
    });
  }
  return { sku: want, facility: wantFac, rows: out };
}
