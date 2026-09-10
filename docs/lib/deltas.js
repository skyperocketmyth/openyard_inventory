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
 *
 * THE SHAPE: `deltasFor` returns a LIST, not a single {dTotal, dDamaged}.
 * Every pre-existing type returns exactly ONE entry, at the txn's own
 * facility. TRANSFER returns TWO — source first, destination second — because
 * one movement now changes the balance at two places at once. Callers MUST
 * iterate; reading `.dTotal` straight off the returned value yields
 * `undefined`, and `NaN < 0` is false, so a guard written that way goes inert
 * with no error at all.
 *
 * THE KEY: a balance is no longer keyed by SKU but by `balKey(facility, sku)`
 * — 'YARD A|STEEL-10'. Facility names are near-free text, so NOTHING may ever
 * split that key back apart: every map keyed this way carries {facility, sku}
 * on the VALUE and callers read those fields instead. The server refuses a
 * facility name containing '|' as the other half of that defence.
 */

/**
 * TWIN of `str_` in gas/Code.js. It special-cases ONLY null and undefined, so
 * a falsy-but-real value survives: `str_(0)` is '0', not ''.
 *
 * `String(v || '')` is the obvious-looking version and it is WRONG here. This
 * yard has live numeric item codes — 0.99, 0.50, 0.3 — and commit 4856d64
 * exists because of that class of bug. The server kept the row for a SKU of 0
 * and the client DROPPED it, so the phone and the Sheet disagreed about
 * whether the stock existed at all.
 */
function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** TWIN of `normSku_` in gas/Code.js. */
export function normSku(v) {
  return str_(v).toUpperCase();
}

/** TWIN of `normFacility_` in gas/Code.js. */
export function normFacility(v) {
  return str_(v).toUpperCase();
}

/** 'YARD A' + 'steel-10' -> 'YARD A|STEEL-10'. Never split the result. */
export function balKey(facility, sku) {
  return String(facility || '').trim().toUpperCase() + '|' +
         String(sku || '').trim().toUpperCase();
}

export function deltasFor(t) {
  const type = String(t.type || '').toUpperCase();
  const fac = String(t.facility || '').trim().toUpperCase();
  const toF = String(t.toFacility || '').trim().toUpperCase();
  const qty = Number(t.qty) || 0;
  const dmg = Number(t.damagedQty) || 0;
  const cond = String(t.condition || 'GOOD').toUpperCase();

  switch (type) {
    case 'OPENING':
    case 'INBOUND':
      return [{ facility: fac, dTotal: qty, dDamaged: dmg }];

    case 'OUTBOUND':
      // Issuing damaged stock must decrement BOTH, or damaged eventually
      // exceeds total and the screen shows negative good stock.
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
      return [{ facility: fac, dTotal: 0, dDamaged: qty }];   // good -> damaged, still in the yard

    case 'REPAIR':
      return [{ facility: fac, dTotal: 0, dDamaged: 0 - qty }];  // damaged -> good

    case 'ADJUST_UP':
      return [{ facility: fac, dTotal: qty, dDamaged: 0 }];

    case 'ADJUST_DOWN':
      return [{ facility: fac, dTotal: 0 - qty, dDamaged: 0 }];

    case 'TRANSFER':
      // A transfer moves GOOD stock only, so dDamaged is 0 on BOTH legs
      // whatever `condition` says. Moving damaged stock between yards is out
      // of scope, and a stray condition: 'DAMAGED' arriving from an older
      // build must not quietly change the maths at either end.
      return [
        { facility: fac, dTotal: 0 - qty, dDamaged: 0 },
        { facility: toF, dTotal: qty, dDamaged: 0 }
      ];

    case 'VOID': {
      // A VOID row carries a copy of the original payload plus the original
      // type, so it is self-sufficient: negate the original's deltas and leave
      // the original row in the fold untouched.
      //
      // `facility` and `toFacility` MUST be forwarded into the recursion. They
      // were not, at first, and a voided TRANSFER then came back with both
      // entries keyed `undefined` — the stock vanished from both yards.
      const inner = deltasFor({
        type: t.voidOfType,
        // The RAW fields, not the normalised locals — gas/Balance.js forwards
        // `t.facility`/`t.toFacility` and the normalisation happens again on
        // the way in. Identical results today, because normalising twice is
        // idempotent, but "identical by coincidence" is how twins drift.
        facility: t.facility,
        toFacility: t.toFacility,
        qty,
        damagedQty: dmg,
        condition: cond
      });
      // `0 - x` not `-x`: negating 0 yields -0, which then leaks into totals.
      // Voiding a TRANSFER reverses BOTH legs, in the same order.
      return inner.map(d => ({
        facility: d.facility,
        dTotal: 0 - d.dTotal,
        dDamaged: 0 - d.dDamaged
      }));
    }

    default:
      // A one-element ZERO list, never an empty one: an unknown type still has
      // to create its balance row, exactly as it did before the shape change.
      return [{ facility: fac, dTotal: 0, dDamaged: 0 }];
  }
}

/** Fold txn-shaped objects into { 'FAC|SKU': {facility, sku, total, damaged, lastTxnTs} }. */
export function foldDeltas(txns, into) {
  const acc = into || {};
  for (const t of txns) {
    const sku = normSku(t.sku);       // NOT String(t.sku || '') — see str_ above
    if (!sku) continue;
    const list = deltasFor(t);
    const ts = t.clientTs || '';
    for (const e of list) {
      const k = balKey(e.facility, sku);
      // A blank facility is legacy (pre-schema-2) data. It is kept as its own
      // visible '|SKU' row rather than dropped — losing stock silently is
      // worse than showing an obviously wrong row a supervisor can act on.
      if (!acc[k]) acc[k] = { facility: e.facility, sku, total: 0, damaged: 0, lastTxnTs: '' };
      acc[k].total += e.dTotal;
      acc[k].damaged += e.dDamaged;
      if (ts && ts > acc[k].lastTxnTs) acc[k].lastTxnTs = ts;
    }
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
    const facility = normFacility(b.facility);
    const sku = normSku(b.sku);
    map.set(balKey(facility, sku), {
      facility,
      sku,
      total: Number(b.total) || 0,
      damaged: Number(b.damaged) || 0,
      lastTxnTs: b.lastTxnTs || '',
      pending: 0
    });
  }

  for (const it of outboxItems || []) {
    if (it.status === 'failed') continue;
    const sku = normSku(it.sku);      // same reason as foldDeltas above
    if (!sku) continue;
    // The `payload` fallback covers entries queued by an older build, before
    // the facility moved to the top level of the outbox record.
    const fac = it.facility ?? it.payload?.facility ?? '';
    const toFac = it.toFacility ?? it.payload?.toFacility ?? '';
    const list = deltasFor({
      type: it.type,
      facility: fac,
      toFacility: toFac,
      qty: it.payload?.qty,
      damagedQty: it.payload?.damagedQty,
      condition: it.payload?.condition,
      voidOfType: it.payload?.voidOfType
    });
    for (const d of list) {
      const k = balKey(d.facility, sku);
      if (!map.has(k)) {
        map.set(k, { facility: d.facility, sku, total: 0, damaged: 0, lastTxnTs: '', pending: 0 });
      }
      const row = map.get(k);
      row.total += d.dTotal;
      row.damaged += d.dDamaged;
      // A pending transfer counts as pending at BOTH ends. That is correct:
      // the figure at the destination is just as provisional as the source's.
      row.pending += 1;
    }
  }

  const out = [...map.values()].map(r => ({
    ...r,
    good: r.total - r.damaged
  }));
  out.sort((a, b) =>
    a.facility < b.facility ? -1 : a.facility > b.facility ? 1
      : a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  return out;
}
