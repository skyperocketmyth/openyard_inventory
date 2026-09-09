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
 */

import { readFileSync } from 'node:fs';

const EXEC = readFileSync('.exec_url', 'utf8').trim();
const SKU = 'ZZTEST-' + Date.now().toString(36).toUpperCase();
const USER = 'Smoke Test';

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

const txn = (type, extra) => ({
  idemKey: uuid(), type, sku: SKU, recordedBy: USER,
  clientTs: new Date().toISOString(), ...extra
});

async function balance() {
  const res = await get('getBalances');
  const rows = (res.data && res.data.balances) || [];
  return rows.find(b => b.sku === SKU) || { total: 0, damaged: 0, good: 0 };
}

async function ledgerCount() {
  const res = await get('getLedger', { sku: SKU, limit: 500 });
  return ((res.data && res.data.rows) || []).length;
}

console.log(`\nSmoke test against ${EXEC.slice(0, 60)}...`);
console.log(`Throwaway SKU: ${SKU}\n`);

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
  const end = await balance().catch(() => null);
  console.log(`\n  cleanup: voided ${cleanup.length} rows; ${SKU} now at ` +
    (end ? `total ${end.total} / damaged ${end.damaged}` : 'unknown'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
