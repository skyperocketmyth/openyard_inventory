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

var H_ITEMS = ['sku', 'description', 'uom', 'barcode', 'active',
  'created_by', 'created_ts', 'updated_by', 'updated_ts', 'item_rev'];
var H_LEDGER = ['txn_id', 'idem_key', 'txn_type', 'sku', 'qty', 'damaged_qty',
  'condition', 'ref_no', 'location', 'remarks', 'recorded_by',
  'client_ts', 'server_ts', 'device_id', 'app_version',
  'void_of_txn_id', 'void_of_type'];
var H_USERS = ['name', 'active', 'added_ts'];
var H_META = ['key', 'value'];
var H_SNAP = ['sku', 'total_qty', 'damaged_qty', 'good_qty', 'last_txn_ts', 'updated_ts'];
var H_REJ = ['server_ts', 'idem_key', 'recorded_by', 'device_id',
  'payload_json', 'error_code', 'error_message'];

var UOMS = ['PCS', 'KG', 'MT', 'BAG', 'BUNDLE', 'CBM', 'ROLL', 'LTR'];
var MAX_BATCH = 25;
var LOCK_MS = 15000;
var CACHE_TTL = 21600;   // CacheService maximum
var IDEM_TTL = 21600;

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
  var out = { epoch: 0, itemsEpoch: 0, schemaVersion: 0,
              serverTs: new Date().toISOString() };
  try {
    out.epoch = Number(metaGet_('ledger_epoch') || 0);
    out.itemsEpoch = Number(metaGet_('items_epoch') || 0);
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

function route_(action, p, body) {
  switch (action) {
    /* reads */
    case 'ping':          return jsonOk_({ pong: true });
    case 'diag':          return jsonOk_(diag_());
    case 'bootstrap':     return jsonOk_(bootstrap_());
    case 'getBalances':   return jsonOk_(getBalancesRead_(p.sinceEpoch));
    case 'getItems':      return jsonOk_(getItemsRead_(p.sinceEpoch));
    case 'getUsers':      return jsonOk_({ names: readUsers_() });
    case 'getLedger':     return jsonOk_(getLedgerRead_(p.sku, p.limit));

    /* writes */
    case 'submitTxnBatch': return submitTxnBatch_(body);
    case 'upsertItem':     return upsertItem_(body);
    case 'addUser':        return addUser_(body);
    case 'setUserActive':  return setUserActive_(body);
    case 'voidTxn':        return voidTxn_(body);

    /* maintenance */
    case 'setup':           return jsonOk_(ensureTabs_());
    case 'rebuildSnapshot': return jsonOk_(rebuildSnapshot_());

    default:
      return jsonErr_('UNKNOWN_ACTION', 'Unknown action: ' + action, false);
  }
}

/* ------------------------------------------------------------------ *
 * Sheet helpers
 * ------------------------------------------------------------------ */

function ss_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function tab_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name + ' — run action=setup');
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
  var out = {};
  var vals = rows_(T_META);
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0] || '').trim();
    if (k) out[k] = vals[i][1];
  }
  return out;
}

/** Write a Meta key. Caller is expected to hold the lock for write paths. */
function metaSet_(key, value) {
  var sh = tab_(T_META);
  var last = sh.getLastRow();
  if (last >= 2) {
    var keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0] || '').trim() === key) {
        sh.getRange(i + 2, 2).setValue(value);
        return;
      }
    }
  }
  sh.appendRow([key, value]);
}

function bumpEpoch_(key) {
  var next = Number(metaGet_(key) || 0) + 1;
  metaSet_(key, next);
  return next;
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

function normSku_(v) {
  return str_(v).toUpperCase();
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
  var meta = metaBlock_();
  return {
    users: readUsers_(),
    items: readItems_(),
    balances: readBalances_(),
    meta: {
      epoch: meta.epoch,
      itemsEpoch: meta.itemsEpoch,
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

function readUsers_() {
  var out = [];
  var vals = rows_(T_USERS);
  for (var i = 0; i < vals.length; i++) {
    var name = str_(vals[i][0]);
    var active = vals[i][1];
    if (name && active !== false && String(active).toUpperCase() !== 'FALSE') {
      out.push(name);
    }
  }
  return out;
}

function readItems_() {
  var key = 'oy_items_v1_' + Number(metaGet_('items_epoch') || 0);
  var hit = getCacheChunked_(key);
  if (hit) return hit;

  var out = [];
  var vals = rows_(T_ITEMS);
  for (var i = 0; i < vals.length; i++) {
    var sku = normSku_(vals[i][0]);
    if (!sku) continue;
    var active = vals[i][4];
    out.push({
      sku: sku,
      description: str_(vals[i][1]),
      uom: str_(vals[i][2]) || 'PCS',
      barcode: str_(vals[i][3]),
      active: !(active === false || String(active).toUpperCase() === 'FALSE'),
      rev: num_(vals[i][9])
    });
  }
  out.sort(function (a, b) { return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0; });
  setCacheChunked_(key, out);
  return out;
}

/** Balances come from the snapshot tab, cached under the ledger epoch. */
function readBalances_() {
  var key = 'oy_bal_v1_' + Number(metaGet_('ledger_epoch') || 0);
  var hit = getCacheChunked_(key);
  if (hit) return hit;

  var map = snapshotMap_();
  var out = [];
  for (var sku in map) {
    if (!Object.prototype.hasOwnProperty.call(map, sku)) continue;
    var b = map[sku];
    out.push({
      sku: sku,
      total: b.total,
      damaged: b.damaged,
      good: b.total - b.damaged,
      lastTxnTs: b.lastTxnTs || ''
    });
  }
  out.sort(function (a, b) { return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0; });
  setCacheChunked_(key, out);
  return out;
}

function getLedgerRead_(sku, limit) {
  var want = normSku_(sku);
  var cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  var vals = rows_(T_LEDGER);
  var out = [];
  for (var i = vals.length - 1; i >= 0 && out.length < cap; i--) {
    var r = vals[i];
    if (want && normSku_(r[3]) !== want) continue;
    out.push({
      txnId: str_(r[0]),
      type: str_(r[2]),
      sku: normSku_(r[3]),
      qty: num_(r[4]),
      damagedQty: num_(r[5]),
      condition: str_(r[6]),
      refNo: str_(r[7]),
      location: str_(r[8]),
      remarks: str_(r[9]),
      recordedBy: str_(r[10]),
      clientTs: r[11] instanceof Date ? r[11].toISOString() : str_(r[11]),
      serverTs: r[12] instanceof Date ? r[12].toISOString() : str_(r[12]),
      voidOf: str_(r[15]),
      voidOfType: str_(r[16])
    });
  }
  return { sku: want, rows: out };
}
