/**
 * Open Yard Inventory — the delta contract (CLIENT half)
 * ======================================================
 * TWIN FILE: gas/Balance.js  ->  deltasFor_()
 * These two must behave identically. Both are exercised against the same
 * fixture list in test/deltas.fixtures.json (Node here, runTests() there).
 *
 * If they drift, the number the app shows BEFORE a sync differs from the
 * number that appears AFTER it. The user then stops trusting every figure in
 * the app, and every later "the stock is wrong" report becomes impossible to
 * tell apart from this bug. That is why this tiny function has its own file,
 * its own twin comment, and its own test.
 *
 * The damage model:
 *   TOTAL   = everything physically in the yard, damaged units included
 *   DAMAGED = the subset of TOTAL that is damaged
 *   GOOD    = TOTAL - DAMAGED   (never stored, always derived)
 * Recording damage moves units GOOD -> DAMAGED and leaves TOTAL alone.
 */

export function deltasFor(t) {
  const type = String(t.type || '').toUpperCase();
  const qty = Number(t.qty) || 0;
  const dmg = Number(t.damagedQty) || 0;
  const cond = String(t.condition || 'GOOD').toUpperCase();

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
      // A VOID row carries a copy of the original payload plus the original
      // type, so it is self-sufficient: negate the original's deltas and leave
      // the original row in the fold untouched.
      const d = deltasFor({
        type: t.voidOfType,
        qty,
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

/** Fold txn-shaped objects into { SKU: {total, damaged, lastTxnTs} }. */
export function foldDeltas(txns, into) {
  const acc = into || {};
  for (const t of txns) {
    const sku = String(t.sku || '').trim().toUpperCase();
    if (!sku) continue;
    if (!acc[sku]) acc[sku] = { total: 0, damaged: 0, lastTxnTs: '' };
    const d = deltasFor(t);
    acc[sku].total += d.dTotal;
    acc[sku].damaged += d.dDamaged;
    const ts = t.clientTs || '';
    if (ts && ts > acc[sku].lastTxnTs) acc[sku].lastTxnTs = ts;
  }
  return acc;
}

/**
 * The number the balance screen actually shows.
 *
 * Server snapshot, plus every entry still sitting in the outbox on this phone.
 * Never show the raw server figure: a user who has just recorded 20 out and
 * sees the old total assumes the app lost their entry.
 *
 * Entries with status 'failed' are excluded — the server refused them, so they
 * are not part of the stock; they live in the failures list awaiting the user.
 */
export function projectBalances(serverBalances, outboxItems) {
  const map = new Map();

  for (const b of serverBalances || []) {
    const sku = String(b.sku).toUpperCase();
    map.set(sku, {
      sku,
      total: Number(b.total) || 0,
      damaged: Number(b.damaged) || 0,
      lastTxnTs: b.lastTxnTs || '',
      pending: 0
    });
  }

  for (const it of outboxItems || []) {
    if (it.status === 'failed') continue;
    const sku = String(it.sku || '').trim().toUpperCase();
    if (!sku) continue;
    if (!map.has(sku)) {
      map.set(sku, { sku, total: 0, damaged: 0, lastTxnTs: '', pending: 0 });
    }
    const row = map.get(sku);
    const d = deltasFor({
      type: it.type,
      qty: it.payload?.qty,
      damagedQty: it.payload?.damagedQty,
      condition: it.payload?.condition,
      voidOfType: it.payload?.voidOfType
    });
    row.total += d.dTotal;
    row.damaged += d.dDamaged;
    row.pending += 1;
  }

  const out = [...map.values()].map(r => ({
    ...r,
    good: r.total - r.damaged
  }));
  out.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  return out;
}
