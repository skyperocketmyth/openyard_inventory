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
var TYPES_ALL = ['OPENING', 'INBOUND', 'OUTBOUND', 'DAMAGE', 'REPAIR',
  'ADJUST_UP', 'ADJUST_DOWN', 'VOID'];

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

  var cache = CacheService.getScriptCache();
  var deviceId = str_(body.deviceId);
  var appVersion = str_(body.appVersion);

  // Cheap pre-check outside the lock: if every key is already known, we can
  // answer without touching the Sheet at all.
  var itemMap = itemMapBySku_();
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
    var working = {};                      // sku -> {total, damaged} as we go
    var results = [];
    var appendRows = [];
    var rejects = [];
    var deltaMap = {};
    var touched = {};
    var now = new Date();

    for (var i = 0; i < txns.length; i++) {
      var t = txns[i] || {};
      var idem = str_(t.idemKey);
      var sku = normSku_(t.sku);
      var type = String(t.type || '').toUpperCase();

      if (!idem || idem.length < 8 || idem.length > 64) {
        results.push(rejected_(idem, 'BAD_REQUEST', 'Missing or malformed idempotency key', false));
        continue;
      }
      if (seen[idem]) {
        // Committed on an earlier attempt whose response never made it back.
        // Identical to "applied" from the client's point of view.
        results.push({ idemKey: idem, status: 'duplicate', txnId: seen[idem] });
        if (sku) touched[sku] = true;
        continue;
      }

      var err = validateTxn_(t, type, sku, itemMap, users, snap, working);
      if (err) {
        results.push(rejected_(idem, err.code, err.message, false));
        rejects.push([now, idem, str_(t.recordedBy), deviceId,
          JSON.stringify(t).slice(0, 4000), err.code, err.message]);
        continue;
      }

      // Accepted — advance the working balance so later txns in the same batch
      // validate against the state their predecessors created.
      var d = deltasFor_({
        type: type, qty: num_(t.qty), damagedQty: num_(t.damagedQty),
        condition: str_(t.condition), voidOfType: str_(t.voidOfType)
      });
      var w = workingFor_(working, snap, sku);
      w.total += d.dTotal;
      w.damaged += d.dDamaged;

      if (!deltaMap[sku]) deltaMap[sku] = { total: 0, damaged: 0, lastTxnTs: '' };
      deltaMap[sku].total += d.dTotal;
      deltaMap[sku].damaged += d.dDamaged;
      var cts = str_(t.clientTs);
      if (cts > deltaMap[sku].lastTxnTs) deltaMap[sku].lastTxnTs = cts;
      touched[sku] = true;

      var txnId = newTxnId_();
      seen[idem] = txnId;
      appendRows.push([
        txnId, idem, type, sku,
        num_(t.qty), num_(t.damagedQty), str_(t.condition),
        str_(t.refNo), str_(t.location), str_(t.remarks),
        str_(t.recordedBy), cts, now, deviceId, appVersion,
        str_(t.voidOfTxnId), str_(t.voidOfType)
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
      for (var k = 0; k < appendRows.length; k++) {
        try { cache.put('idem_' + appendRows[k][1], appendRows[k][0], IDEM_TTL); } catch (e2) {}
      }
    }

    if (rejects.length) {
      // A refused entry is still a real physical movement somebody tried to
      // record. Logging it means a supervisor can see the attempt.
      var rj = tab_(T_REJ);
      rj.getRange(rj.getLastRow() + 1, 1, rejects.length, H_REJ.length).setValues(rejects);
    }

    return jsonOk_({
      results: results,
      balances: balancesForTouched_(Object.keys(touched), snap)
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

function workingFor_(working, snap, sku) {
  if (!working[sku]) {
    var b = balanceOf_(snap, sku);
    working[sku] = { total: b.total, damaged: b.damaged };
  }
  return working[sku];
}

/* ------------------------------------------------------------------ *
 * Validation — authoritative, runs inside the lock
 * ------------------------------------------------------------------ */

function validateTxn_(t, type, sku, itemMap, users, snap, working) {
  if (TYPES_ALL.indexOf(type) === -1) {
    return { code: 'BAD_REQUEST', message: 'Unknown transaction type: ' + type };
  }
  if (!sku) return { code: 'UNKNOWN_SKU', message: 'No item code supplied' };

  var item = itemMap[sku];
  if (!item) return { code: 'UNKNOWN_SKU', message: 'Item ' + sku + ' is not in the item list' };
  if (!item.active) return { code: 'INACTIVE_SKU', message: 'Item ' + sku + ' is no longer active' };

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

  var w = workingFor_(working, snap, sku);
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
    // Once per SKU, permanently. An absolute "set to X" recorded offline at
    // 08:00 and landing at 17:00 would wipe out entries made at 10:00 that
    // already arrived. Forbidding a second OPENING makes it just a +delta.
    if (snap[sku] || (total !== 0 || damaged !== 0)) {
      return {
        code: 'OPENING_EXISTS',
        message: 'Opening stock is already set for ' + sku + '. Use a receipt or an adjustment instead.'
      };
    }
  }

  if (type === 'OUTBOUND') {
    var cond = String(t.condition || 'GOOD').toUpperCase();
    if (cond === 'DAMAGED') {
      if (qty > damaged) {
        return {
          code: 'INSUFFICIENT_DAMAGED_STOCK',
          message: 'Only ' + damaged + ' damaged in stock — cannot issue ' + qty
        };
      }
    } else if (qty > good) {
      return {
        code: 'INSUFFICIENT_GOOD_STOCK',
        message: 'Only ' + good + ' good in stock — cannot issue ' + qty
      };
    }
  }

  if (type === 'DAMAGE' && qty > good) {
    return {
      code: 'DAMAGE_EXCEEDS_GOOD',
      message: 'Only ' + good + ' good in stock — cannot mark ' + qty + ' as damaged'
    };
  }

  if (type === 'REPAIR' && qty > damaged) {
    return {
      code: 'REPAIR_EXCEEDS_DAMAGED',
      message: 'Only ' + damaged + ' damaged in stock — cannot repair ' + qty
    };
  }

  if (type === 'ADJUST_DOWN' && qty > good) {
    return {
      code: 'INSUFFICIENT_GOOD_STOCK',
      message: 'Only ' + good + ' good in stock — cannot reduce by ' + qty
    };
  }

  // Single trailing reconciliation on the computed post-state. Deliberately
  // redundant with the per-type rules above: don't trust a chain of guards each
  // checking in isolation, compute the end state and assert on it.
  var d = deltasFor_({
    type: type, qty: qty, damagedQty: dmg,
    condition: str_(t.condition), voidOfType: str_(t.voidOfType)
  });
  var pTotal = total + d.dTotal;
  var pDamaged = damaged + d.dDamaged;
  if (pTotal < 0) {
    return { code: 'WOULD_GO_NEGATIVE', message: 'This would take ' + sku + ' below zero (' + pTotal + ')' };
  }
  if (pDamaged < 0 || pDamaged > pTotal) {
    return {
      code: 'WOULD_GO_NEGATIVE',
      message: 'This would leave ' + sku + ' with ' + pDamaged + ' damaged out of ' + pTotal + ' total'
    };
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

/** idem_key -> txn_id for every ledger row. One column read. */
function ledgerIdemKeys_() {
  var sh = tab_(T_LEDGER);
  var last = sh.getLastRow();
  var out = {};
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, 2).getValues();   // txn_id, idem_key
  for (var i = 0; i < vals.length; i++) {
    var k = str_(vals[i][1]);
    if (k) out[k] = str_(vals[i][0]);
  }
  return out;
}

/**
 * Post-commit balances for the SKUs a batch touched. Returning these means the
 * client is TOLD the new state rather than having to do a reconciling read
 * that could clobber writes still pending on the phone.
 *
 * `snap` MUST be the map applySnapshotDeltas_ returned, i.e. post-write. It is
 * only re-read here when a caller has none — passing a pre-write map would
 * reply to the phone with the balances from before its own entry landed.
 */
function balancesForTouched_(skus, snap) {
  snap = snap || snapshotMap_();
  var out = [];
  for (var i = 0; i < skus.length; i++) {
    var b = balanceOf_(snap, skus[i]);
    out.push({
      sku: skus[i],
      total: b.total,
      damaged: b.damaged,
      good: b.good,
      lastTxnTs: (snap[skus[i]] && snap[skus[i]].lastTxnTs) || ''
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
        if (normSku_(vals[i][0]) === sku) {
          found = i + 2;
          curRev = num_(vals[i][9]);
          curActive = !(vals[i][4] === false || String(vals[i][4]).toUpperCase() === 'FALSE');
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
      // editing a description silently reactivate a retired item.
      var active = body.active === undefined ? curActive : !!body.active;
      // The SKU itself is never rewritten — the ledger is keyed on it.
      sh.getRange(found, 2, 1, 4).setValues([[description, uom, barcode, active]]);
      sh.getRange(found, 8, 1, 3).setValues([[by, now, curRev + 1]]);
    }
    bumpEpoch_('items_epoch');
    return jsonOk_({ sku: sku, created: !found });
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
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (str_(vals[i][0]).toUpperCase() === name.toUpperCase()) {
        sh.getRange(i + 2, 2).setValue(active);
        _users = null;    // the active flag decides who readUsers_() returns
        return jsonOk_({ name: str_(vals[i][0]), active: active });
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
      if (str_(vals[i][0]) === txnId) { orig = vals[i]; }
      if (str_(vals[i][15]) === txnId) {
        return jsonErr_('ALREADY_VOIDED', 'That entry has already been cancelled', false);
      }
    }
    if (!orig) return jsonErr_('BAD_REQUEST', 'Entry ' + txnId + ' not found', false);
    if (str_(orig[2]).toUpperCase() === 'VOID') {
      return jsonErr_('BAD_REQUEST', 'A cancellation cannot itself be cancelled', false);
    }

    var sku = normSku_(orig[3]);
    var origType = str_(orig[2]);
    var qty = num_(orig[4]);
    var dmg = num_(orig[5]);
    var cond = str_(orig[6]);

    var snap = snapshotMap_();
    var b = balanceOf_(snap, sku);
    var d = deltasFor_({
      type: 'VOID', qty: qty, damagedQty: dmg, condition: cond, voidOfType: origType
    });
    var pTotal = b.total + d.dTotal;
    var pDamaged = b.damaged + d.dDamaged;
    if (pTotal < 0 || pDamaged < 0 || pDamaged > pTotal) {
      return jsonErr_('WOULD_GO_NEGATIVE',
        'Cancelling this would leave ' + sku + ' at ' + pTotal + ' total / ' +
        pDamaged + ' damaged. The stock has already moved — record an adjustment instead.', false);
    }

    var now = new Date();
    var newId = newTxnId_();
    var sh = tab_(T_LEDGER);
    sh.getRange(sh.getLastRow() + 1, 1, 1, H_LEDGER.length).setValues([[
      newId, idem, 'VOID', sku, qty, dmg, cond,
      str_(orig[7]), str_(orig[8]),
      'Cancelled ' + txnId + (reason ? ': ' + reason : ''),
      by, now.toISOString(), now, str_(body.deviceId), str_(body.appVersion),
      txnId, origType
    ]]);

    var deltaMap = {};
    deltaMap[sku] = { total: d.dTotal, damaged: d.dDamaged, lastTxnTs: now.toISOString() };
    // Reuse the map read above, and reply from the post-write one it returns.
    snap = applySnapshotDeltas_(deltaMap, snap);
    bumpEpoch_('ledger_epoch');

    return jsonOk_({
      txnId: newId, status: 'applied', voidOf: txnId,
      balances: balancesForTouched_([sku], snap)
    });
  } catch (err) {
    return jsonErr_('SHEET_ERROR', String(err && err.message || err), true);
  } finally {
    lock.releaseLock();
  }
}
