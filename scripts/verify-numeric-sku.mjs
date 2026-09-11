/**
 * Prove that a numeric-LOOKING item code survives the whole round trip.
 *
 * Run:  node scripts/verify-numeric-sku.mjs
 *
 * The real item codes in this yard are "0.3", "0.5" and "0.6". Google Sheets
 * stores an unformatted "0.3" as the NUMBER 0.3, which would mean "0.50" and
 * "0.5" collapse into one code and the ledger stops matching the item master.
 * ensureTabs_ now forces every code column to text format; this asserts that it
 * actually worked, against the live Sheet, using a throwaway 0.99.
 *
 * Requests retry: Apps Script intermittently answers with an HTML error page
 * instead of JSON, which is precisely why the app classifies non-JSON as
 * retryable rather than throwing.
 */

import { readFileSync } from 'node:fs';

const EXEC = readFileSync('.exec_url', 'utf8').trim();
const SKU = '0.99';
const USER = 'Harish';
/**
 * A throwaway warehouse, because every entry now needs one.
 *
 * Fixed, not minted per run: a warehouse can never be renamed or deleted
 * (9.A), so a unique name each time would leave a permanent trail of dead
 * yards in the real picker. It is reopened at the start and closed at the end,
 * and the ZZTEST- prefix is what lets purgeTestData_ remove it.
 */
const FAC = 'ZZTEST-NUMERIC';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uuid = () => 'numtest_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Retry on a non-JSON reply — Apps Script serves HTML error pages at 200. */
async function call(url, init, label) {
  let lastText = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const r = await fetch(url, { ...init, redirect: 'follow' });
      lastText = await r.text();
      const parsed = JSON.parse(lastText);
      // A retry whose body was dropped in transit reports EMPTY_BODY. Retry it:
      // the idempotency key means a re-send cannot double-post.
      if (parsed && parsed.ok === false && parsed.error
          && parsed.error.code === 'EMPTY_BODY') continue;
      return parsed;
    } catch {
      // Non-JSON (an HTML error page). Retry.
    }
  }
  throw new Error(`${label}: server never returned JSON (last: ${lastText.slice(0, 90)})`);
}

const get = (action, extra = '') =>
  call(`${EXEC}?action=${action}${extra}`, { method: 'GET' }, action);

const post = (action, payload) =>
  call(`${EXEC}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }, action);

const txn = (type, extra) => ({
  idemKey: uuid(), type, sku: SKU, facility: FAC, recordedBy: USER,
  clientTs: new Date().toISOString(), ...extra
});

/** Reopen the throwaway warehouse, reading its current rev first. */
async function ensureFacility() {
  const list = await get('getFacilities');
  const cur = (list.data.facilities || []).find(f => f.facility === FAC);
  return post('upsertFacility', {
    facility: FAC, description: 'Numeric-code test warehouse — safe to ignore',
    active: true, rev: cur ? cur.rev : undefined, recordedBy: USER
  });
}

/**
 * Matched on the warehouse as well as the code. Matching on the code alone
 * would pick whichever yard sorted first — and since the point of this file is
 * that "0.5" and "0.50" must stay different keys, a lookup that can silently
 * return a DIFFERENT row than the one asked for defeats it.
 */
async function balance() {
  const b = await get('getBalances');
  return (b.data.balances || []).find(x => x.sku === SKU && x.facility === FAC)
    || { total: 0, damaged: 0, good: 0 };
}

console.log(`\nNumeric-code round trip, using throwaway SKU "${SKU}"\n`);
const cleanup = [];
let baseline = { total: 0, damaged: 0, good: 0 };

try {
  await ensureFacility();
  await post('upsertItem', {
    sku: SKU, description: 'Numeric-code round-trip test', uom: 'PCS', recordedBy: USER
  });
  const items = await get('getItems');
  const it = (items.data.items || []).find(x => x.sku === SKU);
  ok(`a numeric-looking code comes back as the exact string "${SKU}"`,
    !!it && it.sku === SKU, JSON.stringify(it));

  baseline = await balance();
  console.log(`  (baseline: total ${baseline.total} / damaged ${baseline.damaged})`);

  const r = await post('submitTxnBatch', {
    deviceId: 'numtest', appVersion: 'test',
    txns: [txn('INBOUND', { qty: 100, damagedQty: 5 })]
  });
  ok('a receipt against it is accepted',
    r.ok && r.data.results[0].status === 'applied',
    JSON.stringify(r.data ? r.data.results : r.error));
  if (r.ok && r.data.results[0].txnId) cleanup.push(r.data.results[0].txnId);

  const b1 = await balance();
  ok('the balance keys off the same code (+100 total, +5 damaged, +95 good)',
    b1.total - baseline.total === 100 && b1.damaged - baseline.damaged === 5
      && b1.good - baseline.good === 95,
    `from ${JSON.stringify(baseline)} to ${JSON.stringify(b1)}`);

  const d = await post('submitTxnBatch', {
    deviceId: 'numtest', appVersion: 'test',
    txns: [txn('DAMAGE', { qty: 12, remarks: 'numeric code test' })]
  });
  if (d.ok && d.data.results[0].txnId) cleanup.push(d.data.results[0].txnId);

  const b2 = await balance();
  ok('damage leaves the TOTAL alone and moves 12 from good to damaged',
    b2.total === b1.total && b2.damaged - b1.damaged === 12
      && b1.good - b2.good === 12,
    `from ${JSON.stringify(b1)} to ${JSON.stringify(b2)}`);

  const led = await get('getLedger',
    `&sku=${encodeURIComponent(SKU)}&facility=${encodeURIComponent(FAC)}&limit=10`);
  const skus = (led.data.rows || []).map(x => x.sku);
  ok('every ledger row reads back under the same code',
    skus.length > 0 && skus.every(x => x === SKU), JSON.stringify(skus));

  ok('a trailing-zero variant is NOT treated as the same item',
    !(items.data.items || []).some(x => x.sku === '0.990'),
    'text formatting is what prevents 0.99 and 0.990 colliding');

} catch (err) {
  fail++;
  console.log(`\n  ERROR  ${err.message}`);
} finally {
  for (const txnId of cleanup.reverse()) {
    try {
      await post('voidTxn', {
        txnId, idemKey: uuid(), recordedBy: USER, reason: 'numeric code test cleanup'
      });
    } catch { /* best effort */ }
  }
  try {
    const b = await balance();
    console.log(`\n  cleanup: ${SKU} back to total ${b.total} / damaged ${b.damaged}`);
    ok('cleanup returns the item to exactly where it started',
      b.total === baseline.total && b.damaged === baseline.damaged,
      `baseline ${JSON.stringify(baseline)} vs now ${JSON.stringify(b)}`);
    // Read the CURRENT rev — hardcoding rev:1 meant every run after the first
    // hit STALE_ITEM_REV and silently left the test item in the real picker.
    const fresh = await get('getItems');
    const cur = (fresh.data.items || []).find(x => x.sku === SKU);
    const off = await post('upsertItem', {
      sku: SKU, description: 'Numeric-code round-trip test', uom: 'PCS',
      active: false, rev: cur ? cur.rev : undefined, recordedBy: USER
    });
    ok(`${SKU} is deactivated so it stays out of the real picker`,
      off.ok === true, JSON.stringify(off.error || off.data));
    const check = await get('getItems');
    ok(`${SKU} no longer appears as an active item`,
      !(check.data.items || []).some(x => x.sku === SKU && x.active),
      'it would show up in the yard picker');

    // Close the throwaway warehouse. It cannot be deleted (9.A), so closing it
    // is the whole of the cleanup — and it is what keeps it out of the real
    // picker until the next run reopens it.
    const facs = await get('getFacilities');
    const cur = (facs.data.facilities || []).find(f => f.facility === FAC);
    if (cur) {
      await post('upsertFacility', {
        facility: FAC, active: false, rev: cur.rev, recordedBy: USER
      });
    }
    const closed = await get('getFacilities');
    ok(`${FAC} is closed so it stays out of the real warehouse picker`,
      !(closed.data.facilities || []).some(f => f.facility === FAC && f.active),
      JSON.stringify((closed.data.facilities || []).find(f => f.facility === FAC)));
  } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
