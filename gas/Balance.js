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
 *
 * Stock lives at a WAREHOUSE, so the unit of balance is the pair
 * (facility, sku) — see balKey_. deltasFor_ therefore returns a LIST of
 * per-facility entries rather than one {dTotal, dDamaged}: a TRANSFER moves
 * stock between two yards and is a single ledger row with two effects.
 */

/**
 * The balance key. One string so a plain object can index it, and the ONLY
 * place the two parts are ever joined.
 *
 * X3 — NOTHING MAY EVER SPLIT THIS. Warehouse names are near-free text, so a
 * '|' inside one would split into a facility that does not exist and silently
 * move stock to it. Every map keyed this way carries {facility, sku} on the
 * VALUE and callers read those; upsertFacility_ rejects '|' as the second
 * defence.
 */
function balKey_(facility, sku) {
  return String(facility || '').trim().toUpperCase() + '|' +
         String(sku || '').trim().toUpperCase();
}

/**
 * Every ledger row is a commutative delta. Nothing is an absolute "set to X",
 * which is what makes a late-arriving offline entry land on the right total
 * regardless of the order it reaches the server in.
 *
 * Returns a LIST. Every type but TRANSFER returns exactly one entry, at
 * `facility`; TRANSFER returns two, source first then destination. Callers
 * MUST iterate — reading `.dTotal` off the array yields undefined, and
 * `NaN < 0` is false, which is how a negative-stock guard can go inert
 * without erroring (see validateTxn_).
 *
 * @param {{type:string, facility:string, toFacility:string, qty:number,
 *          damagedQty:number, condition:string, voidOfType:string}} t
 * @return {Array<{facility:string, dTotal:number, dDamaged:number}>}
 */
function deltasFor_(t) {
  var type = String(t.type || '').toUpperCase();
  var fac = String(t.facility || '').trim().toUpperCase();
  var toF = String(t.toFacility || '').trim().toUpperCase();
  var qty = Number(t.qty) || 0;
  var dmg = Number(t.damagedQty) || 0;
  var cond = String(t.condition || 'GOOD').toUpperCase();

  switch (type) {
    case 'OPENING':
    case 'INBOUND':
      return [{ facility: fac, dTotal: qty, dDamaged: dmg }];

    case 'OUTBOUND':
      // Issuing damaged stock must decrement BOTH, or damaged eventually
      // exceeds total and the screen shows negative good stock.
      //
      // `0 - qty`, never `-qty`, everywhere a quantity is negated in this
      // file: `-0` is what `-qty` yields when qty is 0, and the two halves of
      // this contract disagree about it — gas/Setup.js:runTests compares with
      // `!==` (where -0 === 0) while test/deltas.test.mjs uses node:assert
      // strict deepEqual (where -0 !== 0). One of them would pass a drifted
      // implementation.
      return cond === 'DAMAGED'
        ? [{ facility: fac, dTotal: 0 - qty, dDamaged: 0 - qty }]
        : [{ facility: fac, dTotal: 0 - qty, dDamaged: 0 }];

    case 'DAMAGE':
      // good -> damaged, still in the yard
      return [{ facility: fac, dTotal: 0, dDamaged: qty }];

    case 'REPAIR':
      // damaged -> good
      return [{ facility: fac, dTotal: 0, dDamaged: 0 - qty }];

    case 'ADJUST_UP':
      return [{ facility: fac, dTotal: qty, dDamaged: 0 }];

    case 'ADJUST_DOWN':
      return [{ facility: fac, dTotal: 0 - qty, dDamaged: 0 }];

    case 'TRANSFER':
      // A transfer moves GOOD stock only, so dDamaged is 0 on BOTH legs
      // whatever `condition` says. Moving damaged stock between yards is out
      // of scope, and a stray condition:'DAMAGED' arriving from an older
      // client must not be allowed to change the maths.
      return [
        { facility: fac, dTotal: 0 - qty, dDamaged: 0 },
        { facility: toF, dTotal: qty, dDamaged: 0 }
      ];

    case 'VOID': {
      // A VOID row carries a copy of the original's payload plus the original
      // type, so it is self-sufficient: negate the original's deltas and leave
      // the original row in the fold untouched. One rule, no double-counting.
      //
      // X2b — facility AND toFacility must be forwarded into the recursion.
      // Without them a voided TRANSFER came back with both legs keyed
      // 'undefined', i.e. the stock was reversed at a yard that does not exist.
      var inner = deltasFor_({
        type: t.voidOfType,
        facility: t.facility,
        toFacility: t.toFacility,
        qty: qty,
        damagedQty: dmg,
        condition: cond
      });
      var out = [];
      for (var i = 0; i < inner.length; i++) {
        // `0 - x` not `-x`: negating 0 yields -0, which then leaks into totals.
        out.push({
          facility: inner[i].facility,
          dTotal: 0 - inner[i].dTotal,
          dDamaged: 0 - inner[i].dDamaged
        });
      }
      return out;
    }

    default:
      // A one-element ZERO entry, never []. An unrecognised type must still
      // create the row in a fold — a key that vanishes reads as "no stock",
      // which is worse than an obviously inert row somebody can look at.
      return [{ facility: fac, dTotal: 0, dDamaged: 0 }];
  }
}

/**
 * Fold a list of txn-shaped objects into
 * {'FACILITY|SKU': {facility, sku, total, damaged, lastTxnTs}}.
 */
function foldDeltas_(txns, into) {
  var acc = into || {};
  for (var i = 0; i < txns.length; i++) {
    var t = txns[i];
    var sku = normSku_(t.sku);
    if (!sku) continue;
    var list = deltasFor_(t);
    var ts = t.clientTs || '';
    for (var j = 0; j < list.length; j++) {
      var e = list[j];
      var k = balKey_(e.facility, sku);
      // A blank facility is legacy (pre-schema-2) data. It is kept as its own
      // visible '|SKU' row rather than dropped — losing stock silently is worse
      // than showing an obviously wrong row a supervisor can act on.
      if (!acc[k]) acc[k] = { facility: e.facility, sku: sku, total: 0, damaged: 0, lastTxnTs: '' };
      acc[k].total += e.dTotal;
      acc[k].damaged += e.dDamaged;
      if (ts && ts > acc[k].lastTxnTs) acc[k].lastTxnTs = ts;
    }
  }
  return acc;
}

/* ------------------------------------------------------------------ *
 * Snapshot — a derived cache of the ledger, maintained INSIDE the write
 * lock. Reading it is O(items) instead of O(ledger rows), which is what
 * keeps a write off the 30-second execution limit during a sync rush.
 * It is rebuildable from the ledger at any time (action=rebuildSnapshot).
 * ------------------------------------------------------------------ */

/**
 * @return {Object} {'FACILITY|SKU': {facility, sku, total, damaged,
 *                                    openingDone, lastTxnTs, row}}
 */
function snapshotMap_() {
  var out = {};
  var vals = rows_(T_SNAP);
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var sku = normSku_(row[SX.sku]);
    if (!sku) continue;
    // A row with a SKU but NO facility is legacy data and is kept under its
    // own '|SKU' key, matching foldDeltas_. Only a missing sku is skipped.
    var od = row[SX.opening_done];
    var ts = row[SX.last_txn_ts];
    var fac = normFacility_(row[SX.facility]);
    out[balKey_(fac, sku)] = {
      facility: fac,
      sku: sku,
      total: num_(row[SX.total_qty]),
      damaged: num_(row[SX.damaged_qty]),
      // The Sheet gives a real boolean when a checkbox wrote it and the string
      // "TRUE" when a human typed it. Both must count.
      openingDone: od === true || String(od).toUpperCase() === 'TRUE',
      lastTxnTs: ts instanceof Date ? ts.toISOString() : str_(ts),
      row: i + 2
    };
  }
  return out;
}

/**
 * Balance of one SKU AT ONE WAREHOUSE. Zeroed, and not yet opened, when the
 * pair is unseen.
 */
function balanceOf_(snap, facility, sku) {
  var b = snap[balKey_(facility, sku)];
  if (!b) return { total: 0, damaged: 0, good: 0, openingDone: false };
  return {
    total: b.total,
    damaged: b.damaged,
    good: b.total - b.damaged,
    openingDone: !!b.openingDone
  };
}

/**
 * Apply folded deltas to the snapshot tab. Must be called while holding the
 * script lock — it is a read-modify-write, which is only safe under the lock.
 *
 * `snap` is the caller's already-read snapshotMap_(). Passing it in matters:
 * a write path needs the map three times (validate, apply, reply) and each
 * re-read was a full pass over the tab inside the lock.
 *
 * It is mutated in place to the POST-write figures and returned, so the caller
 * can hand it straight to balancesForTouched_ — the balances we reply with must
 * be the ones we just wrote, never the pre-write map.
 *
 * The tab is touched at most twice regardless of how many keys moved: one read
 * of the existing rows, one write of the (contiguous) window they live in, and
 * one append for keys the snapshot has never seen. The previous shape issued a
 * setValues() PER KEY, so a 25-line batch cost 25 round trips under the lock.
 *
 * `deltaMap` is keyed 'FACILITY|SKU' and each value carries
 * {facility, sku, total, damaged, lastTxnTs, openingSet}.
 *
 * @return {Object} the same map, at post-write values
 */
function applySnapshotDeltas_(deltaMap, snap) {
  var sh = tab_(T_SNAP);
  snap = snap || snapshotMap_();
  var now = new Date();
  var last = sh.getLastRow();
  var grid = last >= 2 ? sh.getRange(2, 1, last - 1, H_SNAP.length).getValues() : [];
  var appends = [];
  var lo = -1;
  var hi = -1;

  for (var k in deltaMap) {
    if (!Object.prototype.hasOwnProperty.call(deltaMap, k)) continue;
    var d = deltaMap[k];
    var cur = snap[k];
    if (cur) {
      var total = cur.total + d.total;
      var damaged = cur.damaged + d.damaged;
      var ts = d.lastTxnTs && d.lastTxnTs > cur.lastTxnTs ? d.lastTxnTs : cur.lastTxnTs;
      // X5.4 — `openingSet` is tri-state: true (an OPENING landed here), false
      // (an OPENING was voided here) and undefined (neither, leave it alone).
      // The row below is rewritten positionally IN FULL, so an undefined that
      // defaulted to false would let every ordinary receipt wipe the
      // once-per-key opening guard.
      var od = d.openingSet === undefined ? !!cur.openingDone : !!d.openingSet;
      // snapshotMap_ records `row` as a 1-based Sheet row starting at 2, and
      // `grid` is that same range — so the offset is always row - 2.
      var gi = cur.row - 2;
      grid[gi] = [d.facility, d.sku, total, damaged, total - damaged, od, ts, now];
      if (lo === -1 || gi < lo) lo = gi;
      if (gi > hi) hi = gi;
      cur.total = total;
      cur.damaged = damaged;
      cur.lastTxnTs = ts;
      cur.openingDone = od;
    } else {
      appends.push([d.facility, d.sku, d.total, d.damaged, d.total - d.damaged,
        !!d.openingSet, d.lastTxnTs || '', now]);
      snap[k] = {
        facility: d.facility,
        sku: d.sku,
        total: d.total,
        damaged: d.damaged,
        openingDone: !!d.openingSet,
        lastTxnTs: d.lastTxnTs || '',
        row: last + appends.length      // where this row is about to land
      };
    }
  }
  if (lo !== -1) {
    // Only the window that actually changed is written back. Rewriting the
    // whole grid would work, but it would also rewrite untouched rows with
    // values we merely read — pointless risk on the one tab a human might
    // have poked at.
    sh.getRange(lo + 2, 1, hi - lo + 1, H_SNAP.length)
      .setValues(grid.slice(lo, hi + 1));
  }
  if (appends.length) {
    sh.getRange(last + 1, 1, appends.length, H_SNAP.length).setValues(appends);
  }
  return snap;
}

/**
 * Recompute the whole snapshot from the ledger. This is the repair tool: it
 * proves the snapshot is only ever a cache, so a hand-edited or corrupted
 * snapshot is never a data loss — the ledger is the truth.
 */
function rebuildSnapshot_() {
  // Belt and braces on top of the gate in route_: this is the one destructive
  // function in the project that takes no arguments, so it can also be run by
  // hand from the Apps Script editor, where route_ never sees it. On a book
  // that still has the 17-column Ledger every LX.* read below is off by two
  // and the fold would be garbage — written over the real snapshot.
  var schemaErr = assertSchema_();
  if (schemaErr) throw new Error(schemaErr.message);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    throw new Error('Server busy — could not acquire lock to rebuild');
  }
  try {
    var vals = rows_(T_LEDGER);
    var txns = [];
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      if (!normSku_(r[LX.sku])) continue;
      txns.push({
        type: str_(r[LX.txn_type]),
        facility: normFacility_(r[LX.facility]),
        toFacility: normFacility_(r[LX.to_facility]),
        sku: normSku_(r[LX.sku]),
        qty: num_(r[LX.qty]),
        damagedQty: num_(r[LX.damaged_qty]),
        condition: str_(r[LX.condition]),
        clientTs: r[LX.client_ts] instanceof Date
          ? r[LX.client_ts].toISOString() : str_(r[LX.client_ts]),
        voidOfType: str_(r[LX.void_of_type])
      });
    }
    var folded = foldDeltas_(txns);

    // X5.3 — a rebuild must NOT blank opening_done. It is a FLAG, not a delta,
    // so the fold cannot carry it and a second pass over the same in-memory
    // rows derives it: forward order, because the ledger is appended
    // chronologically and the last write on a key wins. Getting this wrong
    // matters more than it looks — rebuildSnapshot is routed unauthenticated
    // on an ANYONE_ANONYMOUS deployment, so a blank-it rebuild would be a
    // one-click way to re-open every opening balance in the yard.
    var openingAt = {};
    for (var m = 0; m < txns.length; m++) {
      var tx = txns[m];
      var ok = balKey_(tx.facility, tx.sku);
      var ty = String(tx.type || '').toUpperCase();
      if (ty === 'OPENING') {
        openingAt[ok] = true;
      } else if (ty === 'VOID' && String(tx.voidOfType || '').toUpperCase() === 'OPENING') {
        openingAt[ok] = false;
      }
    }

    var sh = tab_(T_SNAP);
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, H_SNAP.length).clearContent();
    }
    var now = new Date();
    var out = [];
    var keys = Object.keys(folded).sort();
    for (var j = 0; j < keys.length; j++) {
      var b = folded[keys[j]];
      out.push([b.facility, b.sku, b.total, b.damaged, b.total - b.damaged,
        !!openingAt[keys[j]], b.lastTxnTs || '', now]);
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
