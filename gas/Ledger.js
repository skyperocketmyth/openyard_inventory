/**
 * Open Yard Inventory — writes
 * ============================
 * Every write follows the wrapper proven in Web_Apps/Sub_Apps/General_Excess:
 *   1. build rows and open the Sheet BEFORE taking the lock (minimise hold time)
 *   2. LockService.tryLock(15000) — fail fast with a retryable SERVER_BUSY
 *   3. INSIDE the lock: re-check the idempotency key, derive the current
 *      balance, validate against THAT balance, assert the post-state
 *   4. one setValues() append
 *   5. releaseLock() in finally
 *
 * Step 3 is the part a naive port gets wrong. Validating before the lock is a
 * time-of-check/time-of-use bug: two phones each read "20 available", both
 * pass, both issue 20, and the yard goes to -20.
 */

var TYPES_FIELD = ['INBOUND', 'OUTBOUND', 'DAMAGE'];               // work offline
/**
 * The types a BATCH may carry. 'VOID' is deliberately NOT one of them.
 *
 * submitTxnBatch_ never validated a void at all: it did not look up
 * `voidOfTxnId`, did not check the original existed, did not check it had not
 * already been voided, and did not check `voidOfType` matched the original.
 * The client's txns mapper does not send those fields either, so the path had
 * no legitimate caller — but /exec is ANYONE_ANONYMOUS, so a hand-written POST
 * of {"type":"VOID","voidOfType":"OPENING",...} passed every check, deleted a
 * unit of stock and set opening_done back to false, re-opening the guard X5
 * exists to protect, one request at a time. It also skipped the TRANSFER
 * checks, which are gated on `type === 'TRANSFER'`: a VOID of a TRANSFER could
 * invent stock at the source and destroy it at an unrelated yard.
 *
 * Cancelling goes through voidTxn_, which does all of that properly and under
 * the lock. `deltasFor_` KEEPS its VOID case — voidTxn_ uses it and
 * rebuildSnapshot_ folds VOID rows out of the ledger. Only this entry point is
 * closed.
 */
var TYPES_ALL = ['OPENING', 'INBOUND', 'OUTBOUND', 'DAMAGE', 'REPAIR',
  'ADJUST_UP', 'ADJUST_DOWN', 'TRANSFER'];

/* ------------------------------------------------------------------ *
 * submitTxnBatch — the offline push endpoint
 * ------------------------------------------------------------------ */

function submitTxnBatch_(body) {
  body = body || {};
  var txns = body.txns;

  // An ABSENT body is a transport failure wearing a validation failure's
  // clothes. Observed live: a POST committed, the reply was lost, and the retry
  // arrived with no body at all — so the server said "no transactions", the
  // client filed a perfectly good entry as permanently rejected, and the yard
  // silently lost a real movement.
  //
  // The server can tell the two apart, so it must: nothing recognisable at all
  // means the request did not arrive intact -> RETRYABLE. The idempotency key
  // makes the retry safe even if the original did commit.
  if (!body || Object.keys(body).length === 0) {
    return jsonErr_('EMPTY_BODY',
      'The request did not arrive complete. Your entries are safe and will retry.', true);
  }
  if (!txns) {
    return jsonErr_('EMPTY_BODY',
      'The request arrived without its entries. It will retry.', true);
  }
  if (!txns.length) {
    // A body that genuinely says "zero transactions" is a client bug, not
    // transport, so retrying it forever would be pointless.
    return jsonErr_('BAD_REQUEST', 'No transactions supplied', false);
  }
  if (txns.length > MAX_BATCH) {
    return jsonErr_('BAD_REQUEST', 'Batch too large — max ' + MAX_BATCH, false);
  }
  if (String(metaGet_('read_only') || '') === 'TRUE') {
    // Deliberately retryable: a maintenance window must never destroy field work.
    return jsonErr_('READ_ONLY', 'The app is in maintenance mode. Your entries are safe and will upload later.', true);
  }
  // The schema gate, checked here as well as in route_ because this function
  // is also reachable directly — from the Apps Script editor and from
  // scripts/gas-harness.cjs. Appending a 20-cell row into a 17-column tab
  // SUCCEEDS (a Sheets grid is 26 wide by default), so without this the
  // ledger silently ends up holding two different row shapes. Retryable, so
  // the phone holds its entries instead of filing them as failures.
  var schemaErr = assertSchema_();
  if (schemaErr) return jsonErr_(schemaErr.code, schemaErr.message, true);

  var deviceId = str_(body.deviceId);
  var appVersion = str_(body.appVersion);

  // Cheap pre-check outside the lock: if every key is already known, we can
  // answer without touching the Sheet at all.
  var itemMap = itemMapBySku_();
  var facMap = facilityMap_();
  var users = {};
  var userList = readUsers_();
  for (var u = 0; u < userList.length; u++) users[userList[u].toUpperCase()] = true;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return jsonErr_('SERVER_BUSY', 'Server busy, please retry', true);
  }

  try {
    var seen = ledgerIdemKeys_();          // authoritative; cache can expire
    var snap = snapshotMap_();
    // Everything below is keyed 'FACILITY|SKU'. The same SKU at two yards is
    // two independent balances, so a SKU-only key would let stock at YARD B
    // validate against stock at YARD A.
    var working = {};    // key -> {facility, sku, total, damaged, openingDone}
    var results = [];
    var appendRows = [];
    var rejects = [];
    var deltaMap = {};   // key -> {facility, sku, total, damaged, lastTxnTs, openingSet}
    var touched = {};    // key -> {facility, sku}   (X3 — never split the key)
    var now = new Date();

    for (var i = 0; i < txns.length; i++) {
      var t = txns[i] || {};
      var idem = str_(t.idemKey);
      var sku = normSku_(t.sku);
      var facility = normFacility_(t.facility);
      var toFacility = normFacility_(t.toFacility);
      var type = String(t.type || '').toUpperCase();

      if (!idem || idem.length < 8 || idem.length > 64) {
        results.push(rejected_(idem, 'BAD_REQUEST', 'Missing or malformed idempotency key', false));
        continue;
      }
      if (seen[idem]) {
        // Committed on an earlier attempt whose response never made it back.
        // Identical to "applied" from the client's point of view.
        results.push({ idemKey: idem, status: 'duplicate', txnId: seen[idem] });
        // X2d — BOTH ends, not just the source. A replayed TRANSFER that
        // returned no destination balance would make the phone delete the
        // outbox entry with the destination figure never updated: the
        // reverting-stock bug, re-created inside its own fix.
        if (sku && facility) touched[balKey_(facility, sku)] = { facility: facility, sku: sku };
        if (sku && toFacility) touched[balKey_(toFacility, sku)] = { facility: toFacility, sku: sku };
        continue;
      }

      var err = validateTxn_(t, type, facility, toFacility, sku,
        itemMap, users, facMap, snap, working);
      if (err) {
        results.push(rejected_(idem, err.code, err.message, false));
        rejects.push([now, idem, str_(t.recordedBy), deviceId,
          JSON.stringify(t).slice(0, 4000), err.code, err.message]);
        continue;
      }

      // Accepted — advance the working balance so later txns in the same batch
      // validate against the state their predecessors created.
      //
      // X1/X2c — deltasFor_ returns a LIST and EVERY entry is applied. The
      // destination leg landing in `working` is the point: an offline
      // TRANSFER A->B followed by an OUTBOUND at B, in the SAME batch, is the
      // ordinary yard sequence. Without it the OUTBOUND takes a
      // NON-retryable INSUFFICIENT_GOOD_STOCK and the movement is lost.
      var cts = str_(t.clientTs);
      var list = deltasFor_({
        type: type, facility: facility, toFacility: toFacility,
        qty: num_(t.qty), damagedQty: num_(t.damagedQty),
        condition: str_(t.condition), voidOfType: str_(t.voidOfType)
      });
      for (var e = 0; e < list.length; e++) {
        var leg = list[e];
        var w = workingFor_(working, snap, leg.facility, sku);
        w.total += leg.dTotal;
        w.damaged += leg.dDamaged;
        var k = balKey_(leg.facility, sku);
        if (!deltaMap[k]) {
          deltaMap[k] = { facility: leg.facility, sku: sku, total: 0, damaged: 0,
            lastTxnTs: '', openingSet: undefined };
        }
        deltaMap[k].total += leg.dTotal;
        deltaMap[k].damaged += leg.dDamaged;
        if (cts > deltaMap[k].lastTxnTs) deltaMap[k].lastTxnTs = cts;
        touched[k] = { facility: leg.facility, sku: sku };
      }

      // X5.1 — the opening flag moves with the batch, not only with the Sheet.
      // It is carried on the SOURCE key, which is the only key an OPENING has.
      //
      // There is no VOID branch here any more: a batch cannot carry a VOID
      // (see TYPES_ALL). The live X5.2 fix — cancelling an OPENING clears the
      // flag so the yard can record one again — is the one in voidTxn_.
      var srcKey = balKey_(facility, sku);
      if (type === 'OPENING') {
        working[srcKey].openingDone = true;      // blocks a second OPENING in this same batch
        deltaMap[srcKey].openingSet = true;
      }

      // A8/X12 — an INACTIVE warehouse is ACCEPTED and FLAGGED, at either end.
      // The stock has already physically moved by the time the phone uploads;
      // rejecting makes the app confidently wrong about where it is. This is
      // deliberately NOT the INACTIVE_SKU rule — do not copy that here.
      var flags = [];
      if (facility && facMap[facility] && !facMap[facility].active) flags.push(facility);
      if (toFacility && facMap[toFacility] && !facMap[toFacility].active) flags.push(toFacility);
      var remarks = str_(t.remarks);
      if (flags.length) {
        remarks = (remarks ? remarks + ' ' : '') +
          '[facility inactive at upload: ' + flags.join(', ') + ']';
      }

      var txnId = newTxnId_();
      seen[idem] = txnId;
      appendRows.push([
        txnId, idem, type, facility,
        // Only a movement BETWEEN yards carries a destination. A VOID of a
        // transfer must keep BOTH ends too, but a VOID cannot come through
        // here at all any more — voidTxn_ writes its own row and copies both
        // facilities off the original.
        type === 'TRANSFER' ? toFacility : '',
        sku, num_(t.qty), num_(t.damagedQty), str_(t.condition),
        str_(t.refNo), normVehicle_(t.vehicleNo), str_(t.location), remarks,
        str_(t.recordedBy), cts, now, deviceId, appVersion,
        // Always blank from this path, never echoed from the request. A batch
        // cannot carry a VOID any more, so these two are meaningless here —
        // and echoing them was quietly exploitable: voidTxn_ decides
        // ALREADY_VOIDED by scanning for a row whose void_of_txn_id matches,
        // so a crafted INBOUND naming a real txn id would permanently block
        // that entry from ever being cancelled.
        '', ''
      ]);
      results.push({ idemKey: idem, status: 'applied', txnId: txnId });
    }

    // `snap` is read once above and threaded from here on. applySnapshotDeltas_
    // advances it to the post-write figures in place, so the balances we reply
    // with below are the ones actually now in the Sheet. When nothing was
    // appended it is untouched, and therefore still correct.
    if (appendRows.length) {
      var sh = tab_(T_LEDGER);
      sh.getRange(sh.getLastRow() + 1, 1, appendRows.length, H_LEDGER.length)
        .setValues(appendRows);
      snap = applySnapshotDeltas_(deltaMap, snap);
      bumpEpoch_('ledger_epoch');
      // Nothing caches idempotency keys, deliberately — X4. ledgerIdemKeys_ is
      // the only source of truth and the only reader; the cache entries this
      // loop used to write were read by nobody. Do not re-add them.
    }

    if (rejects.length) {
      // A refused entry is still a real physical movement somebody tried to
      // record. Logging it means a supervisor can see the attempt.
      var rj = tab_(T_REJ);
      rj.getRange(rj.getLastRow() + 1, 1, rejects.length, H_REJ.length).setValues(rejects);
    }

    return jsonOk_({
      results: results,
      balances: balancesForTouched_(touched, snap)
    });
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  } finally {
    lock.releaseLock();
  }
}

function rejected_(idem, code, message, retryable) {
  return {
    idemKey: idem,
    status: 'rejected',
    error: { code: code, message: message, retryable: !!retryable }
  };
}

/**
 * The in-batch running balance for ONE (facility, sku) pair.
 *
 * Keyed on the pair, never on the sku alone. Two yards holding the same item
 * sharing one working balance is the single worst thing that could happen in
 * this refactor: in-lock validation would then approve an issue at YARD B
 * against stock that is physically at YARD A.
 */
function workingFor_(working, snap, facility, sku) {
  var k = balKey_(facility, sku);
  if (!working[k]) {
    var b = balanceOf_(snap, facility, sku);
    working[k] = {
      facility: normFacility_(facility),
      sku: normSku_(sku),
      total: b.total,
      damaged: b.damaged,
      openingDone: b.openingDone
    };
  }
  return working[k];
}

/* ------------------------------------------------------------------ *
 * Validation — authoritative, runs inside the lock
 * ------------------------------------------------------------------ */

function validateTxn_(t, type, facility, toFacility, sku, itemMap, users, facMap, snap, working) {
  // Checked before the type list so the message says what to do instead of
  // "Unknown transaction type: VOID". Non-retryable on purpose: a batch will
  // never be the right way to send this, so retrying it forever is pointless.
  // See the TYPES_ALL comment for what this closes.
  if (type === 'VOID') {
    return { code: 'BAD_REQUEST', message: 'Cancellations go through the cancel action, not a batch' };
  }
  if (TYPES_ALL.indexOf(type) === -1) {
    return { code: 'BAD_REQUEST', message: 'Unknown transaction type: ' + type };
  }
  if (!sku) return { code: 'UNKNOWN_SKU', message: 'No item code supplied' };

  var item = itemMap[sku];
  if (!item) return { code: 'UNKNOWN_SKU', message: 'Item ' + sku + ' is not in the item list' };
  if (!item.active) return { code: 'INACTIVE_SKU', message: 'Item ' + sku + ' is no longer active' };

  // Stock lives somewhere. An entry with no warehouse cannot be folded into
  // any balance, so it is refused here rather than landing on a '|SKU' row.
  if (!facility) {
    return { code: 'UNKNOWN_FACILITY', message: 'No warehouse recorded against this entry' };
  }
  // An INACTIVE facility is deliberately NOT rejected (11.A) — the movement
  // has already happened. submitTxnBatch_ flags it in remarks instead.
  if (!facMap[facility]) {
    return { code: 'UNKNOWN_FACILITY', message: 'Warehouse "' + facility + '" is not in the list' };
  }

  if (type === 'TRANSFER') {
    if (!toFacility) {
      return { code: 'BAD_REQUEST', message: 'Choose a warehouse to move the stock to' };
    }
    if (!facMap[toFacility]) {
      return { code: 'UNKNOWN_FACILITY', message: 'Warehouse "' + toFacility + '" is not in the list' };
    }
    if (toFacility === facility) {
      return { code: 'BAD_REQUEST', message: 'Choose a different warehouse to move to' };
    }
  }

  var recordedBy = str_(t.recordedBy);
  if (!recordedBy) return { code: 'NO_USER', message: 'No name recorded against this entry' };
  // A client-only attribution guard guards nothing — re-check server-side.
  if (!users[recordedBy.toUpperCase()]) {
    return { code: 'NO_USER', message: '"' + recordedBy + '" is not in the user list' };
  }

  var qty = num_(t.qty);
  var dmg = num_(t.damagedQty);
  if (!(qty > 0)) return { code: 'QTY_NOT_POSITIVE', message: 'Quantity must be at least 1' };
  if (qty !== Math.floor(qty) || dmg !== Math.floor(dmg)) {
    return { code: 'BAD_REQUEST', message: 'Quantities must be whole numbers' };
  }
  if (qty > 999999) return { code: 'BAD_REQUEST', message: "That's too large. Maximum 999,999" };

  var w = workingFor_(working, snap, facility, sku);
  var total = w.total;
  var damaged = w.damaged;
  var good = total - damaged;

  if (type === 'OPENING' || type === 'INBOUND') {
    if (dmg < 0) return { code: 'BAD_REQUEST', message: 'Damaged quantity cannot be negative' };
    if (dmg > qty) {
      return {
        code: 'DAMAGED_EXCEEDS_QTY',
        message: 'Damaged (' + dmg + ') cannot be more than the ' + qty + ' received'
      };
    }
  }

  if (type === 'OPENING') {
    // Once per (warehouse, SKU), permanently. An absolute "set to X" recorded
    // offline at 08:00 and landing at 17:00 would wipe out entries made at
    // 10:00 that already arrived. Forbidding a second OPENING makes it just a
    // +delta.
    //
    // X5/12.A — the FLAG decides, not the balance. The old test was
    // `snap[sku] || total !== 0 || damaged !== 0`, which refused an opening on
    // a key that merely had a receipt against it and told the user "opening
    // stock is already set" — a lie, and no way past it. Reading w.openingDone
    // (off the working balance, not off snap) is also what catches a SECOND
    // OPENING inside the same batch.
    if (w.openingDone) {
      return {
        code: 'OPENING_EXISTS',
        message: 'Opening stock for ' + sku + ' at ' + facility + ' has already been recorded.'
      };
    }
  }

  if (type === 'OUTBOUND') {
    var cond = String(t.condition || 'GOOD').toUpperCase();
    if (cond === 'DAMAGED') {
      if (qty > damaged) {
        return {
          code: 'INSUFFICIENT_DAMAGED_STOCK',
          message: 'Only ' + damaged + ' damaged in stock at ' + facility + ' — cannot issue ' + qty
        };
      }
    } else if (qty > good) {
      return {
        code: 'INSUFFICIENT_GOOD_STOCK',
        message: 'Only ' + good + ' good in stock at ' + facility + ' — cannot issue ' + qty
      };
    }
  }

  if (type === 'DAMAGE' && qty > good) {
    return {
      code: 'DAMAGE_EXCEEDS_GOOD',
      message: 'Only ' + good + ' good in stock at ' + facility + ' — cannot mark ' + qty + ' as damaged'
    };
  }

  if (type === 'REPAIR' && qty > damaged) {
    return {
      code: 'REPAIR_EXCEEDS_DAMAGED',
      message: 'Only ' + damaged + ' damaged in stock at ' + facility + ' — cannot repair ' + qty
    };
  }

  if (type === 'ADJUST_DOWN' && qty > good) {
    return {
      code: 'INSUFFICIENT_GOOD_STOCK',
      message: 'Only ' + good + ' good in stock at ' + facility + ' — cannot reduce by ' + qty
    };
  }

  if (type === 'TRANSFER' && qty > good) {
    // X13 — the message states the residual risk on purpose. A transfer's
    // DESTINATION legitimately holds physical stock the server believes is
    // zero whenever the inbound leg is still sitting in somebody's outbox, so
    // "you don't have it" can be wrong in a way the yard can actually check.
    return {
      code: 'INSUFFICIENT_GOOD_STOCK',
      message: 'Only ' + good + ' good in stock at ' + facility + ' — cannot move ' + qty +
        '. The transfer for this item may not have uploaded yet — check pending uploads.'
    };
  }

  // Single trailing reconciliation on the computed post-state. Deliberately
  // redundant with the per-type rules above: don't trust a chain of guards each
  // checking in isolation, compute the end state and assert on it.
  //
  // This loop is the last line of defence against negative stock. When
  // deltasFor_ began returning a LIST, reading `d.dTotal` off it silently
  // produced NaN — and `NaN < 0` is false, so the guard returned null for
  // EVERYTHING with no error at all. It now iterates, and test/validate.test.mjs
  // covers it.
  var post = deltasFor_({
    type: type, facility: facility, toFacility: toFacility,
    qty: qty, damagedQty: dmg, condition: str_(t.condition), voidOfType: str_(t.voidOfType)
  });
  // The legs ACCUMULATE across the list, in a scratch of our own.
  //
  // Two things are load-bearing here. (1) It accumulates: today the only way
  // two legs land on one key is a transfer whose source and destination are
  // the same, which is refused above and nets to zero anyway — so without
  // this the worst case is a false rejection. But a future two-leg type
  // would make validate and apply disagree about the post-state, and this
  // guard is the one that is supposed to be right. (2) It does NOT write back
  // into `working`: submitTxnBatch_ advances `working` itself once this
  // returns null, so writing here would apply every delta twice and the next
  // entry in the batch would validate against a balance that never existed.
  var scratch = {};
  for (var p = 0; p < post.length; p++) {
    var leg = post[p];
    var pk = balKey_(leg.facility, sku);
    if (!scratch[pk]) {
      var lw = workingFor_(working, snap, leg.facility, sku);
      scratch[pk] = { total: lw.total, damaged: lw.damaged };
    }
    var pTotal = scratch[pk].total + leg.dTotal;
    var pDamaged = scratch[pk].damaged + leg.dDamaged;
    scratch[pk].total = pTotal;
    scratch[pk].damaged = pDamaged;
    if (pTotal < 0) {
      return {
        code: 'WOULD_GO_NEGATIVE',
        message: 'This would take ' + sku + ' at ' + leg.facility + ' below zero (' + pTotal + ')'
      };
    }
    if (pDamaged < 0 || pDamaged > pTotal) {
      return {
        code: 'WOULD_GO_NEGATIVE',
        message: 'This would leave ' + sku + ' at ' + leg.facility + ' with ' + pDamaged +
          ' damaged out of ' + pTotal + ' total'
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

function itemMapBySku_() {
  var items = readItems_();
  var m = {};
  for (var i = 0; i < items.length; i++) m[items[i].sku] = items[i];
  return m;
}

/**
 * idem_key -> txn_id for every ledger row. A plain read of the first two
 * columns, every time.
 *
 * X4 — this deliberately has NO chunked cache, unlike readItems_ /
 * readFacilities_. An EXTRA key in a cached map is catastrophic in a way a
 * missing one is not: an idem_key present with no ledger row behind it makes
 * the server answer `duplicate`, and the client then DELETES the outbox entry
 * without it ever having been written. A real physical movement disappears,
 * silently. The full read is the cheap half of a write path that already
 * holds the lock — leave it alone.
 */
function ledgerIdemKeys_() {
  var sh = tab_(T_LEDGER);
  var last = sh.getLastRow();
  var out = {};
  if (last < 2) return out;
  // Only as wide as the two columns actually needed, derived so an inserted
  // column moves the window instead of shifting what lands in it.
  var width = Math.max(LX.txn_id, LX.idem_key) + 1;
  var vals = sh.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var k = str_(row[LX.idem_key]);
    if (k) out[k] = str_(row[LX.txn_id]);
  }
  return out;
}

/**
 * Post-commit balances for the (warehouse, SKU) pairs a batch touched.
 * Returning these means the client is TOLD the new state rather than having
 * to do a reconciling read that could clobber writes still pending on the
 * phone.
 *
 * `touched` is the MAP, not a list of skus: its values carry {facility, sku}
 * so nothing here ever has to split the composite key (X3).
 *
 * `snap` MUST be the map applySnapshotDeltas_ returned, i.e. post-write. It is
 * only re-read here when a caller has none — passing a pre-write map would
 * reply to the phone with the balances from before its own entry landed.
 */
function balancesForTouched_(touched, snap) {
  snap = snap || snapshotMap_();
  var out = [];
  for (var k in touched) {
    if (!Object.prototype.hasOwnProperty.call(touched, k)) continue;
    var ref = touched[k];
    var b = balanceOf_(snap, ref.facility, ref.sku);
    out.push({
      facility: ref.facility,
      sku: ref.sku,
      total: b.total,
      damaged: b.damaged,
      good: b.good,
      lastTxnTs: (snap[k] && snap[k].lastTxnTs) || ''
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Item master (online only)
 * ------------------------------------------------------------------ */

function upsertItem_(body) {
  body = body || {};
  var sku = normSku_(body.sku);
  var description = str_(body.description);
  var uom = str_(body.uom).toUpperCase() || 'PCS';
  var barcode = str_(body.barcode);
  var by = str_(body.recordedBy);

  if (!sku) return jsonErr_('BAD_REQUEST', 'Enter a SKU code', false);
  if (!/^[A-Z0-9][A-Z0-9\-_.\/]{1,23}$/.test(sku)) {
    return jsonErr_('BAD_REQUEST', 'Use only letters, numbers and dashes in the SKU code', false);
  }
  if (description.length < 3) {
    return jsonErr_('BAD_REQUEST', 'Description must be at least 3 characters', false);
  }
  if (UOMS.indexOf(uom) === -1) {
    return jsonErr_('BAD_REQUEST', 'Unknown unit: ' + uom, false);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return jsonErr_('SERVER_BUSY', 'Server busy, please retry', true);
  }
  try {
    var sh = tab_(T_ITEMS);
    var last = sh.getLastRow();
    var found = 0;
    var curRev = 0;
    var curActive = true;
    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, H_ITEMS.length).getValues();
      for (var i = 0; i < vals.length; i++) {
        var row = vals[i];
        if (normSku_(row[IX.sku]) === sku) {
          found = i + 2;
          curRev = num_(row[IX.item_rev]);
          curActive = !(row[IX.active] === false ||
            String(row[IX.active]).toUpperCase() === 'FALSE');
          break;
        }
      }
    }
    var now = new Date();

    if (!found) {
      sh.getRange(last + 1, 1, 1, H_ITEMS.length).setValues([[
        sku, description, uom, barcode, true, by, now, by, now, 1
      ]]);
    } else {
      if (body.rev !== undefined && body.rev !== null && body.rev !== '' &&
          Number(body.rev) !== curRev) {
        return jsonErr_('STALE_ITEM_REV',
          'Someone else changed ' + sku + ' while you were editing. Reload and try again.', false);
      }
      // An ABSENT field means "leave it as it is". Defaulting to true here made
      // editing a description silently reactivate a retired item; defaulting a
      // null to false is the same bug pointing the other way — see boolOrKeep_.
      var active = boolOrKeep_(body.active, curActive);
      // The SKU itself is never rewritten — the ledger is keyed on it.
      // Both windows are derived from H_ITEMS, and colRun_ asserts the columns
      // named are still adjacent and in that order — the width is no longer a
      // hardcoded 4 and 3 that an inserted column would silently misalign.
      sh.getRange(found, IX.description + 1, 1,
        colRun_(H_ITEMS, ['description', 'uom', 'barcode', 'active']))
        .setValues([[description, uom, barcode, active]]);
      sh.getRange(found, IX.updated_by + 1, 1,
        colRun_(H_ITEMS, ['updated_by', 'updated_ts', 'item_rev']))
        .setValues([[by, now, curRev + 1]]);
    }
    bumpEpoch_('items_epoch');
    return jsonOk_({ sku: sku, created: !found });
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * Warehouse master (online only)
 *
 * There is NO delete and NO rename here, deliberately (9.A). Every ledger row
 * and every snapshot row is keyed on the facility NAME, so a rename would
 * orphan the history and a delete would leave stock with nowhere to live. A
 * yard that closes is flagged INACTIVE instead: it drops out of the picker
 * while its history and its balances stay exactly where they are.
 * ------------------------------------------------------------------ */

function upsertFacility_(body) {
  body = body || {};
  var name = normFacility_(body.facility);
  var description = str_(body.description);
  var by = str_(body.recordedBy);

  if (!name) return jsonErr_('BAD_REQUEST', 'Enter a warehouse name', false);
  // Checked separately from the charset rule so the message can say WHY. The
  // balance key is the string 'FACILITY|SKU', and X3 forbids anything ever
  // splitting it — a pipe inside a name is the one input that would make a
  // split produce a facility nobody has ever heard of.
  if (name.indexOf('|') !== -1) {
    return jsonErr_('BAD_REQUEST', 'A warehouse name cannot contain the | character', false);
  }
  // 2 to 40 characters, starting with a letter or a digit.
  //
  // Brackets, commas, apostrophes, + and # ARE allowed. The rule that banned
  // them was imported from a test-harness limitation — test/deltas.test.mjs
  // refuses to evaluate a `cases` literal containing `word(`, so no FIXTURE
  // facility may contain a bracket. That constraint belongs to the fixtures,
  // not to what a yard supervisor is allowed to type: JEBEL ALI (SOUTH),
  // DP WORLD, JAFZA, AL QUOZ PLOT #3, YARD 1 + 2 and SITE 'B' are all real
  // names, and since a facility can NEVER be renamed (9.A) a name typed
  // around the restriction would be permanent.
  //
  // '|' is still refused, separately and above, because it is the balance-key
  // separator — that is a data-integrity rule, not a typography one.
  if (!/^[A-Z0-9][A-Z0-9 \-_.\/&(),'+#]{1,39}$/.test(name)) {
    return jsonErr_('BAD_REQUEST',
      "Use letters, numbers, spaces and - _ . / & ( ) , ' + # only, " +
      '2 to 40 characters', false);
  }
  if (description.length > 120) {
    return jsonErr_('BAD_REQUEST', 'Description must be 120 characters or fewer', false);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return jsonErr_('SERVER_BUSY', 'Server busy, please retry', true);
  }
  try {
    var sh = tab_(T_FAC);
    var last = sh.getLastRow();
    var found = 0;
    var curRev = 0;
    var curActive = true;
    var curDesc = '';
    var clash = '';
    var fold = facilityFold_(name);
    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, H_FAC.length).getValues();
      for (var i = 0; i < vals.length; i++) {
        var row = vals[i];
        var existing = normFacility_(row[FX.facility]);
        if (!existing) continue;
        if (existing === name) {
          found = i + 2;
          curRev = num_(row[FX.facility_rev]);
          curDesc = str_(row[FX.description]);
          curActive = !(row[FX.active] === false ||
            String(row[FX.active]).toUpperCase() === 'FALSE');
          break;
        }
        // Not an exact match, but the same place spelled differently. Two
        // yards that differ only by a space or a dash would each hold half
        // the stock and no screen would ever show them as one.
        if (!clash && facilityFold_(existing) === fold) clash = existing;
      }
    }
    var now = new Date();

    if (!found) {
      if (clash) {
        return jsonErr_('DUPLICATE_FACILITY',
          'There is already a warehouse called "' + clash + '". Names that differ only by ' +
          'spacing or case are treated as the same warehouse.', false);
      }
      sh.getRange(last + 1, 1, 1, H_FAC.length)
        .setValues([[name, description, true, by, now, 1]]);
      bumpEpoch_('facilities_epoch');
      // The FULL saved record, so the client can merge it locally without a
      // second round trip — the upsertItem_ lesson from C3.
      return jsonOk_({
        facility: name, description: description, active: true, rev: 1, created: true
      });
    }

    if (body.rev !== undefined && body.rev !== null && body.rev !== '' &&
        Number(body.rev) !== curRev) {
      return jsonErr_('STALE_FACILITY_REV',
        'Someone else changed ' + name + ' while you were editing. Reload and try again.', false);
    }
    // An ABSENT field means "leave it as it is". Defaulting active to true
    // here is the silent-reactivation bug fixed in e6b8cd8 — editing a
    // description would quietly bring a closed yard back into the picker.
    // `null` and `''` count as absent too: a stray {"active": null} closing a
    // working yard is the same bug in reverse. See boolOrKeep_.
    var active = boolOrKeep_(body.active, curActive);
    var desc = body.description === undefined ? curDesc : description;
    // The name itself is NEVER rewritten — the ledger is keyed on it. Same
    // rule, and the same reason, as the SKU in upsertItem_ above. The window
    // width is derived and its adjacency asserted, never a hardcoded 2.
    sh.getRange(found, FX.description + 1, 1, colRun_(H_FAC, ['description', 'active']))
      .setValues([[desc, active]]);
    sh.getRange(found, FX.facility_rev + 1).setValue(curRev + 1);
    bumpEpoch_('facilities_epoch');
    return jsonOk_({
      facility: name, description: desc, active: active, rev: curRev + 1, created: false
    });
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  } finally {
    lock.releaseLock();
  }
}

function addUser_(body) {
  var name = str_((body || {}).name);
  if (name.length < 2) return jsonErr_('BAD_REQUEST', 'Name must be at least 2 characters', false);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return jsonErr_('SERVER_BUSY', 'Server busy, please retry', true);
  }
  try {
    var existing = readUsers_();
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].toUpperCase() === name.toUpperCase()) {
        return jsonOk_({ name: existing[i], created: false });   // idempotent
      }
    }
    tab_(T_USERS).appendRow([name, true, new Date()]);
    _users = null;      // the memo populated by readUsers_() above is now short a name
    return jsonOk_({ name: name, created: true });
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Deactivate or reactivate a name. Staff leave; the ledger rows they wrote must
 * stay, so a user is never deleted — only flagged inactive, which drops them
 * from the picker while their history keeps its attribution.
 */
function setUserActive_(body) {
  body = body || {};
  var name = str_(body.name);
  var active = body.active === undefined ? false : !!body.active;
  if (!name) return jsonErr_('BAD_REQUEST', 'No name supplied', false);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return jsonErr_('SERVER_BUSY', 'Server busy, please retry', true);
  }
  try {
    var sh = tab_(T_USERS);
    var last = sh.getLastRow();
    if (last < 2) return jsonErr_('BAD_REQUEST', 'No users yet', false);
    // One column wide, pinned to UX.name — so the inner index is 0 by
    // construction rather than a guess at which column the name is in.
    var names = sh.getRange(2, UX.name + 1, last - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (str_(names[i][0]).toUpperCase() === name.toUpperCase()) {
        sh.getRange(i + 2, UX.active + 1).setValue(active);
        _users = null;    // the active flag decides who readUsers_() returns
        return jsonOk_({ name: str_(names[i][0]), active: active });
      }
    }
    return jsonErr_('BAD_REQUEST', 'No user called "' + name + '"', false);
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * voidTxn — the only way to correct a mistake in an append-only ledger
 * ------------------------------------------------------------------ */

function voidTxn_(body) {
  body = body || {};
  var txnId = str_(body.txnId);
  var idem = str_(body.idemKey);
  var by = str_(body.recordedBy);
  var reason = str_(body.reason);

  if (!txnId) return jsonErr_('BAD_REQUEST', 'No transaction to cancel', false);
  if (!idem) return jsonErr_('BAD_REQUEST', 'Missing idempotency key', false);
  // Same gate, same reason, as submitTxnBatch_ — every read below is by
  // LX.*, and on an un-migrated book LX.facility reads the old `sku`.
  var schemaErr = assertSchema_();
  if (schemaErr) return jsonErr_(schemaErr.code, schemaErr.message, true);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    return jsonErr_('SERVER_BUSY', 'Server busy, please retry', true);
  }
  try {
    var seen = ledgerIdemKeys_();
    if (seen[idem]) return jsonOk_({ txnId: seen[idem], status: 'duplicate' });

    var vals = rows_(T_LEDGER);
    var orig = null;
    for (var i = 0; i < vals.length; i++) {
      var scan = vals[i];
      if (str_(scan[LX.txn_id]) === txnId) { orig = scan; }
      if (str_(scan[LX.void_of_txn_id]) === txnId) {
        return jsonErr_('ALREADY_VOIDED', 'That entry has already been cancelled', false);
      }
    }
    if (!orig) return jsonErr_('BAD_REQUEST', 'Entry ' + txnId + ' not found', false);
    if (str_(orig[LX.txn_type]).toUpperCase() === 'VOID') {
      return jsonErr_('BAD_REQUEST', 'A cancellation cannot itself be cancelled', false);
    }

    var sku = normSku_(orig[LX.sku]);
    var facility = normFacility_(orig[LX.facility]);
    var toFacility = normFacility_(orig[LX.to_facility]);
    var origType = str_(orig[LX.txn_type]);
    var qty = num_(orig[LX.qty]);
    var dmg = num_(orig[LX.damaged_qty]);
    var cond = str_(orig[LX.condition]);

    // PLAN.md A4 claims voidTxn_ "needs no change beyond re-indexing". That is
    // WRONG, and re-simplifying it back would reintroduce three bugs at once
    // (X2a): a void is now MULTI-KEY. Cancelling a TRANSFER reverses two
    // balances at two different yards, so the post-state has to be checked at
    // BOTH, the delta map needs an entry for each, and the reply has to carry
    // both. A single-key check never looks at the destination — and a transfer
    // whose stock has since been ISSUED at the destination would be cancelled
    // happily, driving that yard negative.
    var snap = snapshotMap_();
    var working = {};
    var list = deltasFor_({
      type: 'VOID', facility: facility, toFacility: toFacility,
      qty: qty, damagedQty: dmg, condition: cond, voidOfType: origType
    });

    var now = new Date();
    var nowIso = now.toISOString();
    var deltaMap = {};
    var touched = {};
    for (var L = 0; L < list.length; L++) {
      var leg = list[L];
      // Accumulated THROUGH workingFor_ so two legs that landed on the same
      // key could not each check against the pre-void figure.
      var w = workingFor_(working, snap, leg.facility, sku);
      var pTotal = w.total + leg.dTotal;
      var pDamaged = w.damaged + leg.dDamaged;
      if (pTotal < 0 || pDamaged < 0 || pDamaged > pTotal) {
        return jsonErr_('WOULD_GO_NEGATIVE',
          'Cancelling this would leave ' + sku + ' at ' + leg.facility + ' on ' + pTotal +
          ' total / ' + pDamaged +
          ' damaged. The stock has already moved — record an adjustment instead.', false);
      }
      w.total = pTotal;
      w.damaged = pDamaged;
      var k = balKey_(leg.facility, sku);
      if (!deltaMap[k]) {
        deltaMap[k] = { facility: leg.facility, sku: sku, total: 0, damaged: 0,
          lastTxnTs: nowIso, openingSet: undefined };
      }
      deltaMap[k].total += leg.dTotal;
      deltaMap[k].damaged += leg.dDamaged;
      touched[k] = { facility: leg.facility, sku: sku };
    }

    // X5.2 — cancelling an OPENING must clear the flag on the key it was
    // recorded at, or the yard can never record the opening balance again.
    if (String(origType).toUpperCase() === 'OPENING') {
      var srcKey = balKey_(facility, sku);
      if (deltaMap[srcKey]) deltaMap[srcKey].openingSet = false;
    }

    // X12, documented rather than fixed: voidTxn_ does NO facility-active
    // check, so a void involving a closed yard is not flagged in remarks the
    // way submitTxnBatch_ flags one. Cancelling a movement at a yard that has
    // since closed is legitimate, and refusing it would strand the mistake.
    var newId = newTxnId_();
    var sh = tab_(T_LEDGER);
    sh.getRange(sh.getLastRow() + 1, 1, 1, H_LEDGER.length).setValues([[
      newId, idem, 'VOID', facility, toFacility, sku, qty, dmg, cond,
      str_(orig[LX.ref_no]), normVehicle_(orig[LX.vehicle_no]), str_(orig[LX.location]),
      'Cancelled ' + txnId + (reason ? ': ' + reason : ''),
      by, nowIso, now, str_(body.deviceId), str_(body.appVersion),
      txnId, origType
    ]]);

    // Reuse the map read above, and reply from the post-write one it returns.
    snap = applySnapshotDeltas_(deltaMap, snap);
    bumpEpoch_('ledger_epoch');

    return jsonOk_({
      txnId: newId, status: 'applied', voidOf: txnId,
      balances: balancesForTouched_(touched, snap)
    });
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  } finally {
    lock.releaseLock();
  }
}
