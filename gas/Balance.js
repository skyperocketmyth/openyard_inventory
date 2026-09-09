/**
 * Open Yard Inventory — balance maths
 * ==================================
 * THE CONTRACT. `deltasFor_` below is one contract living in two files:
 *   server : gas/Balance.js        (this file)
 *   client : docs/lib/deltas.js
 * They must stay byte-identical in behaviour, and both are exercised against
 * the same fixture file test/deltas.fixtures.json. If they drift, the number
 * the app shows before a sync differs from the number after it — and every
 * later "the stock is wrong" report becomes impossible to falsify.
 *
 * The damage model Harish confirmed:
 *   TOTAL   = everything physically in the yard, damaged units included
 *   DAMAGED = the subset of TOTAL that is damaged
 *   GOOD    = TOTAL - DAMAGED     (never stored, always derived)
 * Recording damage therefore moves units GOOD -> DAMAGED and leaves TOTAL alone.
 */

/**
 * Every ledger row is a commutative delta. Nothing is an absolute "set to X",
 * which is what makes a late-arriving offline entry land on the right total
 * regardless of the order it reaches the server in.
 *
 * @param {{type:string, qty:number, damagedQty:number, condition:string}} t
 * @return {{dTotal:number, dDamaged:number}}
 */
function deltasFor_(t) {
  var type = String(t.type || '').toUpperCase();
  var qty = Number(t.qty) || 0;
  var dmg = Number(t.damagedQty) || 0;
  var cond = String(t.condition || 'GOOD').toUpperCase();

  switch (type) {
    case 'OPENING':
    case 'INBOUND':
      return { dTotal: qty, dDamaged: dmg };

    case 'OUTBOUND':
      // Issuing damaged stock must decrement BOTH, or damaged eventually
      // exceeds total and the screen shows negative good stock.
      return cond === 'DAMAGED'
        ? { dTotal: -qty, dDamaged: -qty }
        : { dTotal: -qty, dDamaged: 0 };

    case 'DAMAGE':
      return { dTotal: 0, dDamaged: qty };    // good -> damaged, still in the yard

    case 'REPAIR':
      return { dTotal: 0, dDamaged: -qty };   // damaged -> good

    case 'ADJUST_UP':
      return { dTotal: qty, dDamaged: 0 };

    case 'ADJUST_DOWN':
      return { dTotal: -qty, dDamaged: 0 };

    case 'VOID': {
      // A VOID row carries a copy of the original's payload plus the original
      // type, so it is self-sufficient: negate the original's deltas and leave
      // the original row in the fold untouched. One rule, no double-counting.
      var d = deltasFor_({
        type: t.voidOfType,
        qty: qty,
        damagedQty: dmg,
        condition: cond
      });
      // `0 - x` not `-x`: negating 0 yields -0, which then leaks into totals.
      return { dTotal: 0 - d.dTotal, dDamaged: 0 - d.dDamaged };
    }

    default:
      return { dTotal: 0, dDamaged: 0 };
  }
}

/** Fold a list of txn-shaped objects into {sku: {total, damaged, lastTxnTs}}. */
function foldDeltas_(txns, into) {
  var acc = into || {};
  for (var i = 0; i < txns.length; i++) {
    var t = txns[i];
    var sku = normSku_(t.sku);
    if (!sku) continue;
    if (!acc[sku]) acc[sku] = { total: 0, damaged: 0, lastTxnTs: '' };
    var d = deltasFor_(t);
    acc[sku].total += d.dTotal;
    acc[sku].damaged += d.dDamaged;
    var ts = t.clientTs || '';
    if (ts && ts > acc[sku].lastTxnTs) acc[sku].lastTxnTs = ts;
  }
  return acc;
}

/* ------------------------------------------------------------------ *
 * Snapshot — a derived cache of the ledger, maintained INSIDE the write
 * lock. Reading it is O(items) instead of O(ledger rows), which is what
 * keeps a write off the 30-second execution limit during a sync rush.
 * It is rebuildable from the ledger at any time (action=rebuildSnapshot).
 * ------------------------------------------------------------------ */

/** @return {Object} {sku: {total, damaged, lastTxnTs, row}} */
function snapshotMap_() {
  var out = {};
  var vals = rows_(T_SNAP);
  for (var i = 0; i < vals.length; i++) {
    var sku = normSku_(vals[i][0]);
    if (!sku) continue;
    out[sku] = {
      total: num_(vals[i][1]),
      damaged: num_(vals[i][2]),
      lastTxnTs: vals[i][4] instanceof Date
        ? vals[i][4].toISOString()
        : str_(vals[i][4]),
      row: i + 2
    };
  }
  return out;
}

/** Balance of one SKU from the snapshot. Zeroed when the SKU is unseen. */
function balanceOf_(snap, sku) {
  var b = snap[normSku_(sku)];
  if (!b) return { total: 0, damaged: 0, good: 0 };
  return { total: b.total, damaged: b.damaged, good: b.total - b.damaged };
}

/**
 * Apply folded deltas to the snapshot tab. Must be called while holding the
 * script lock — it is a read-modify-write, which is only safe under the lock.
 */
function applySnapshotDeltas_(deltaMap) {
  var sh = tab_(T_SNAP);
  var snap = snapshotMap_();
  var now = new Date();
  var appends = [];

  for (var sku in deltaMap) {
    if (!Object.prototype.hasOwnProperty.call(deltaMap, sku)) continue;
    var d = deltaMap[sku];
    var cur = snap[sku];
    if (cur) {
      var total = cur.total + d.total;
      var damaged = cur.damaged + d.damaged;
      var ts = d.lastTxnTs && d.lastTxnTs > cur.lastTxnTs ? d.lastTxnTs : cur.lastTxnTs;
      sh.getRange(cur.row, 1, 1, H_SNAP.length)
        .setValues([[sku, total, damaged, total - damaged, ts, now]]);
    } else {
      appends.push([sku, d.total, d.damaged, d.total - d.damaged, d.lastTxnTs || '', now]);
    }
  }
  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, H_SNAP.length).setValues(appends);
  }
}

/**
 * Recompute the whole snapshot from the ledger. This is the repair tool: it
 * proves the snapshot is only ever a cache, so a hand-edited or corrupted
 * snapshot is never a data loss — the ledger is the truth.
 */
function rebuildSnapshot_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    throw new Error('Server busy — could not acquire lock to rebuild');
  }
  try {
    var vals = rows_(T_LEDGER);
    var txns = [];
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      if (!normSku_(r[3])) continue;
      txns.push({
        type: str_(r[2]),
        sku: normSku_(r[3]),
        qty: num_(r[4]),
        damagedQty: num_(r[5]),
        condition: str_(r[6]),
        clientTs: r[11] instanceof Date ? r[11].toISOString() : str_(r[11]),
        voidOfType: str_(r[16])
      });
    }
    var folded = foldDeltas_(txns);

    var sh = tab_(T_SNAP);
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, H_SNAP.length).clearContent();
    }
    var now = new Date();
    var out = [];
    var skus = Object.keys(folded).sort();
    for (var j = 0; j < skus.length; j++) {
      var b = folded[skus[j]];
      out.push([skus[j], b.total, b.damaged, b.total - b.damaged, b.lastTxnTs || '', now]);
    }
    if (out.length) {
      sh.getRange(2, 1, out.length, H_SNAP.length).setValues(out);
    }
    bumpEpoch_('ledger_epoch');
    return { rebuilt: out.length, ledgerRows: txns.length };
  } finally {
    lock.releaseLock();
  }
}
