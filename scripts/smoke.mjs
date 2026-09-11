/**
 * Live end-to-end smoke test against the deployed Apps Script web app.
 *
 * Run:  node scripts/smoke.mjs
 *
 * This talks to the REAL Sheet, so it uses a throwaway SKU prefixed ZZTEST- and
 * cleans up after itself by voiding what it wrote. It asserts on response
 * BODIES, never on HTTP status: Apps Script serves its own error pages at 200.
 *
 * What it proves, in order:
 *   1. anonymous access works with no credentials at all
 *   2. an item can be created
 *   3. a receipt with damages moves the balance the way the brief describes
 *   4. re-posting the SAME idempotency key does NOT create a second row
 *   5. issuing more than the good stock is refused BY THE SERVER
 *   6. recording damage does not change the total
 *   7. a batch commits its valid entries even when one entry in it is invalid
 *   8. attribution is enforced server-side
 *   9. stock is held PER WAREHOUSE and a transfer moves it between two
 *
 * The warehouse names are FIXED, not minted per run. A warehouse can never be
 * renamed or deleted (9.A), so a unique name per run would leave a permanent
 * trail of dead yards in the real picker. These two are reused, reactivated at
 * the start and deactivated at the end, and carry the ZZTEST- prefix that
 * purgeTestData_ is allowed to remove.
 */

import { readFileSync } from 'node:fs';

const EXEC = readFileSync('.exec_url', 'utf8').trim();
const SKU = 'ZZTEST-' + Date.now().toString(36).toUpperCase();
const USER = 'Smoke Test';
const FAC = 'ZZTEST-SMOKE A';
const FAC_B = 'ZZTEST-SMOKE B';

let pass = 0, fail = 0;
const cleanup = [];

function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
}

function uuid() {
  return 'smoke_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function get(action, params = {}) {
  const q = new URLSearchParams({ action, ...params });
  const r = await fetch(`${EXEC}?${q}`, { redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`non-JSON reply for ${action}: ${text.slice(0, 200)}`); }
}

async function post(action, payload) {
  const r = await fetch(`${EXEC}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`non-JSON reply for ${action}: ${text.slice(0, 200)}`); }
}

/** Every entry names a warehouse; `extra` can override it for the transfer. */
const txn = (type, extra) => ({
  idemKey: uuid(), type, sku: SKU, facility: FAC, recordedBy: USER,
  clientTs: new Date().toISOString(), ...extra
});

/**
 * Make a throwaway warehouse exist and be open.
 *
 * Reads the current `rev` first. Hardcoding one would take STALE_FACILITY_REV
 * on the second run of the day — the same trap verify-numeric-sku.mjs hit with
 * items, where it silently left the test item in the real picker.
 */
async function ensureFacility(name) {
  const list = await get('getFacilities');
  const cur = ((list.data && list.data.facilities) || [])
    .find(f => f.facility === name.toUpperCase());
  return post('upsertFacility', {
    facility: name, description: 'Smoke test warehouse — safe to ignore',
    active: true, rev: cur ? cur.rev : undefined, recordedBy: USER
  });
}

/**
 * The balance for one item AT ONE WAREHOUSE.
 *
 * Matching on the SKU alone would return whichever yard happened to sort
 * first, so a figure landing at the WRONG warehouse would read as a pass —
 * which is the single thing this whole session changed and therefore the
 * single thing these assertions most need to be able to see.
 */
async function balance(facility = FAC) {
  const res = await get('getBalances');
  const rows = (res.data && res.data.balances) || [];
  return rows.find(b => b.sku === SKU && b.facility === facility.toUpperCase())
    || { total: 0, damaged: 0, good: 0 };
}

async function ledgerCount(facility = FAC) {
  const res = await get('getLedger', { sku: SKU, facility, limit: 500 });
  return ((res.data && res.data.rows) || []).length;
}

console.log(`\nSmoke test against ${EXEC.slice(0, 60)}...`);
console.log(`Throwaway SKU: ${SKU}  ·  warehouses: ${FAC} / ${FAC_B}\n`);

try {
  /* 1 -------------------------------------------------------------- */
  const ping = await get('ping');
  ok('anonymous access with no credentials', ping.ok === true, JSON.stringify(ping));

  /* 2 -------------------------------------------------------------- */
  await post('addUser', { name: USER });
  const item = await post('upsertItem', {
    sku: SKU, description: 'Smoke test item', uom: 'PCS', recordedBy: USER
  });
  ok('item created', item.ok === true, JSON.stringify(item.error || ''));

  const fac = await ensureFacility(FAC);
  await ensureFacility(FAC_B);
  ok('a warehouse can be created', fac.ok === true, JSON.stringify(fac.error || ''));

  // Writing to an existing warehouse must EDIT it, never make a second one.
  // The balance key is the name (9.A), so a second row under the same name
  // would split one yard's stock in two with nothing on screen to show it.
  const edit = await post('upsertFacility', {
    facility: FAC, description: 'Smoke test warehouse — edited', recordedBy: USER
  });
  const facList = await get('getFacilities');
  const sameName = ((facList.data && facList.data.facilities) || [])
    .filter(f => f.facility === FAC.toUpperCase());
  ok('editing a warehouse updates the one that is there, it does not add another',
    edit.ok === true && edit.data.created === false && sameName.length === 1,
    JSON.stringify({ created: edit.data && edit.data.created, rows: sameName.length }));

  // "ZZTEST-SMOKE A" and "zztestsmokea" are the same place. Two yards that
  // differ only by punctuation would each hold half the stock.
  const dupe = await post('upsertFacility', {
    facility: FAC.toLowerCase().replace(/[^a-z]/g, ''), description: 'near duplicate',
    recordedBy: USER
  });
  ok('a near-duplicate warehouse name is refused',
    dupe.ok === false && dupe.error.code === 'DUPLICATE_FACILITY',
    JSON.stringify(dupe.error || dupe.data));

  const noFac = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [{ ...txn('INBOUND', { qty: 1 }), facility: '' }]
  });
  const nf = noFac.data && noFac.data.results && noFac.data.results[0];
  ok('an entry with no warehouse on it is refused',
    nf && nf.status === 'rejected' && nf.error.code === 'UNKNOWN_FACILITY',
    JSON.stringify(nf));

  /* 3 --- receive 100 of which 5 damaged --------------------------- */
  const recv = txn('INBOUND', { qty: 100, damagedQty: 5, refNo: 'SMOKE-GRN' });
  const r1 = await post('submitTxnBatch', { deviceId: 'smoke', appVersion: 'test', txns: [recv] });
  ok('receipt accepted', r1.ok === true && r1.data.results[0].status === 'applied',
    JSON.stringify(r1.data ? r1.data.results : r1.error));
  if (r1.ok && r1.data.results[0].txnId) cleanup.push(r1.data.results[0].txnId);

  let b = await balance();
  ok('receipt gives total 100 / damaged 5 / good 95',
    b.total === 100 && b.damaged === 5 && b.good === 95, JSON.stringify(b));

  /* 4 --- THE IDEMPOTENCY TEST ------------------------------------- */
  const before = await ledgerCount();
  const r2 = await post('submitTxnBatch', { deviceId: 'smoke', appVersion: 'test', txns: [recv] });
  const after = await ledgerCount();
  ok('re-posting the same key reports duplicate, not applied',
    r2.ok === true && r2.data.results[0].status === 'duplicate',
    JSON.stringify(r2.data ? r2.data.results : r2.error));
  ok('re-posting the same key adds NO second row',
    after === before, `rows before=${before} after=${after}`);
  const b2 = await balance();
  ok('re-posting the same key does not move the balance',
    b2.total === 100 && b2.damaged === 5, JSON.stringify(b2));

  /* 5 --- server-side negative stock guard ------------------------- */
  const over = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [txn('OUTBOUND', { qty: 9999, condition: 'GOOD' })]
  });
  const overRes = over.data && over.data.results && over.data.results[0];
  ok('issuing more than the good stock is refused by the SERVER',
    overRes && overRes.status === 'rejected' &&
    overRes.error.code === 'INSUFFICIENT_GOOD_STOCK',
    JSON.stringify(overRes));
  ok('a refused entry is marked non-retryable (so it surfaces, not loops)',
    overRes && overRes.error.retryable === false, JSON.stringify(overRes && overRes.error));

  /* 6 --- issue 20, then damage 12 --------------------------------- */
  const r3 = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [txn('OUTBOUND', { qty: 20, condition: 'GOOD', refNo: 'SMOKE-DO' })]
  });
  if (r3.ok && r3.data.results[0].txnId) cleanup.push(r3.data.results[0].txnId);
  const b3 = await balance();
  ok('after issuing 20: total 80 / damaged 5 / good 75',
    b3.total === 80 && b3.damaged === 5 && b3.good === 75, JSON.stringify(b3));

  const totalBeforeDamage = b3.total;
  const r4 = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [txn('DAMAGE', { qty: 12, remarks: 'Rain damage' })]
  });
  if (r4.ok && r4.data.results[0].txnId) cleanup.push(r4.data.results[0].txnId);
  const b4 = await balance();
  ok('recording damage does NOT change the total',
    b4.total === totalBeforeDamage, `${totalBeforeDamage} -> ${b4.total}`);
  ok('recording damage moves good -> damaged (80 / 17 / 63)',
    b4.total === 80 && b4.damaged === 17 && b4.good === 63, JSON.stringify(b4));

  /* 7 --- a mixed batch must commit its valid half ----------------- */
  const good = txn('INBOUND', { qty: 10, damagedQty: 0 });
  const bad = txn('INBOUND', { qty: 10, damagedQty: 99 });   // damaged > qty
  const mixed = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test', txns: [bad, good]
  });
  const byKey = {};
  for (const r of (mixed.data && mixed.data.results) || []) byKey[r.idemKey] = r;
  ok('the invalid entry in a mixed batch is rejected',
    byKey[bad.idemKey] && byKey[bad.idemKey].status === 'rejected' &&
    byKey[bad.idemKey].error.code === 'DAMAGED_EXCEEDS_QTY',
    JSON.stringify(byKey[bad.idemKey]));
  ok('the valid entry in the SAME batch still commits',
    byKey[good.idemKey] && byKey[good.idemKey].status === 'applied',
    JSON.stringify(byKey[good.idemKey]));
  if (byKey[good.idemKey] && byKey[good.idemKey].txnId) cleanup.push(byKey[good.idemKey].txnId);

  ok('the batch response carries the new balance back',
    mixed.data && mixed.data.balances && mixed.data.balances.length > 0,
    JSON.stringify(mixed.data && mixed.data.balances));

  /* 8 --- attribution is enforced server-side ---------------------- */
  const noUser = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [{ ...txn('INBOUND', { qty: 5 }), recordedBy: 'Nobody Real' }]
  });
  const nu = noUser.data && noUser.data.results && noUser.data.results[0];
  ok('an unknown user name is refused (the name picker is not decoration)',
    nu && nu.status === 'rejected' && nu.error.code === 'NO_USER', JSON.stringify(nu));

  /* 9 --- stock is PER WAREHOUSE, and a transfer moves it ---------- */
  // The point of the whole session, asserted against the real deployment.
  const beforeA = await balance();
  const beforeB = await balance(FAC_B);
  const moved = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [txn('TRANSFER', { toFacility: FAC_B, qty: 10, vehicleNo: 'smoke-1' })]
  });
  const mv = moved.data && moved.data.results && moved.data.results[0];
  ok('a transfer between two warehouses is accepted',
    mv && mv.status === 'applied', JSON.stringify(mv));
  if (mv && mv.txnId) cleanup.push(mv.txnId);

  const afterA = await balance();
  const afterB = await balance(FAC_B);
  ok('the transfer takes 10 out of the source warehouse',
    beforeA.total - afterA.total === 10,
    `${JSON.stringify(beforeA)} -> ${JSON.stringify(afterA)}`);
  ok('the transfer puts the same 10 into the destination warehouse',
    afterB.total - beforeB.total === 10,
    `${JSON.stringify(beforeB)} -> ${JSON.stringify(afterB)}`);
  // ONE row, not two. Two rows would double-count on a rebuildSnapshot, which
  // folds every row independently — the source would go -2x the quantity.
  const rowsA = await get('getLedger', { sku: SKU, facility: FAC, limit: 500 });
  const rowsB = await get('getLedger', { sku: SKU, facility: FAC_B, limit: 500 });
  const inA = ((rowsA.data && rowsA.data.rows) || []).filter(r => r.txnId === (mv && mv.txnId));
  const inB = ((rowsB.data && rowsB.data.rows) || []).filter(r => r.txnId === (mv && mv.txnId));
  ok('the transfer is ONE ledger row, and it shows in the history of BOTH yards',
    inA.length === 1 && inB.length === 1 && inA[0].toFacility === FAC_B.toUpperCase(),
    JSON.stringify({ atSource: inA.length, atDestination: inB.length }));
  ok('the vehicle number survives the round trip',
    inA.length === 1 && inA[0].vehicleNo === 'SMOKE-1',
    JSON.stringify(inA[0] && inA[0].vehicleNo));

  // The failure that separates "per warehouse" from "one pool with labels":
  // the destination holds 10, so issuing the ACROSS-yard total from it must be
  // refused. If this ever passes, stock is being summed somewhere it must not be.
  const overAtB = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [txn('OUTBOUND', { facility: FAC_B, qty: afterA.total + afterB.total, condition: 'GOOD' })]
  });
  const ob = overAtB.data && overAtB.data.results && overAtB.data.results[0];
  ok('issuing the across-warehouse total from ONE warehouse is refused',
    ob && ob.status === 'rejected' && ob.error.code === 'INSUFFICIENT_GOOD_STOCK',
    JSON.stringify(ob));

  const toNowhere = await post('submitTxnBatch', {
    deviceId: 'smoke', appVersion: 'test',
    txns: [txn('TRANSFER', { toFacility: 'ZZTEST-NO SUCH YARD', qty: 1 })]
  });
  const tn = toNowhere.data && toNowhere.data.results && toNowhere.data.results[0];
  ok('a transfer to a warehouse that does not exist is refused',
    tn && tn.status === 'rejected' && tn.error.code === 'UNKNOWN_FACILITY',
    JSON.stringify(tn));

} catch (err) {
  fail++;
  console.log(`\n  ERROR  ${err.message}`);
} finally {
  /* clean up: void every row this test wrote, so the Sheet is left tidy */
  for (const txnId of cleanup.reverse()) {
    try {
      await post('voidTxn', {
        txnId, idemKey: uuid(), recordedBy: USER, reason: 'smoke test cleanup',
        deviceId: 'smoke', appVersion: 'test'
      });
    } catch { /* best effort */ }
  }
  // Deactivate the throwaway ITEM too, or it lingers in the real item list.
  try {
    await post('upsertItem', {
      sku: SKU, description: 'Smoke test item', uom: 'PCS',
      active: false, recordedBy: USER
    });
  } catch { /* best effort */ }

  // Deactivate the throwaway user so it never shows up in the real picker.
  try { await post('setUserActive', { name: USER, active: false }); } catch { /* best effort */ }

  // Close the throwaway warehouses. They cannot be DELETED — a warehouse is
  // permanent by design (9.A) — so closing them is the whole of the cleanup,
  // and it is what keeps them out of the yard's picker between runs. The rev
  // is read fresh: this run has already edited them.
  try {
    const list = await get('getFacilities');
    for (const name of [FAC, FAC_B]) {
      const cur = ((list.data && list.data.facilities) || [])
        .find(f => f.facility === name.toUpperCase());
      if (!cur) continue;
      await post('upsertFacility', {
        facility: name, active: false, rev: cur.rev, recordedBy: USER
      });
    }
  } catch { /* best effort */ }

  const end = await balance().catch(() => null);
  console.log(`\n  cleanup: voided ${cleanup.length} rows; ${SKU} now at ` +
    (end ? `total ${end.total} / damaged ${end.damaged}` : 'unknown'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
