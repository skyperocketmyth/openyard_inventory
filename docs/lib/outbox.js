/**
 * The offline outbox.
 *
 * Every submit lands here FIRST and the UI reports success immediately. The
 * network attempt happens afterwards. A yard worker must never wait on a
 * round-trip, and must never lose an entry because signal dropped mid-tap.
 *
 * Design rules, each one load-bearing:
 *
 *  - `idemKey` is minted ONCE at enqueue and never regenerated. The dangerous
 *    case is a request that reaches the server, commits, and whose response is
 *    lost: the phone cannot tell that apart from "never arrived" and must
 *    retry. Same key means the server replays its answer instead of writing a
 *    second row. Minting the key server-side would silently turn every retry
 *    into a double-post.
 *
 *  - Head-of-line blocking is PER (FACILITY, SKU), not global and not per SKU.
 *    Entries for different items — or for the same item at different yards —
 *    are independent; within one item at one yard, order matters
 *    (receive-then-issue validates, the reverse does not). So one bad steel
 *    entry at YARD A must not freeze every cement entry queued behind it, nor
 *    the steel entries at YARD B. A TRANSFER occupies BOTH of its ends: it
 *    orders against later entries at its source and at its destination.
 *
 *    The `blocked` set is threaded THROUGH the self-recursive call at the end
 *    of `flush()`. It has to be: the recursion is taken while retryable
 *    rejections are still sitting in the queue, so a set that started empty
 *    there would send the very entries the first pass held back, out of order,
 *    seconds later. That is the bug this set exists to prevent.
 *
 *  - A retryable failure is NEVER dropped. A permanent rejection is never
 *    silently dropped either — it moves to `failures` and raises a banner the
 *    user has to act on. The entry represents a real physical movement.
 *
 *  - `sending` is a UI hint, not a lock. On startup every `sending` is reset to
 *    `pending`: a reload mid-flight *should* re-send, and the idemKey makes
 *    that safe. Treating it as a lock is how a committed-but-unacknowledged
 *    entry gets lost.
 */

import { idb, STORE_OUTBOX, STORE_FAILURES, prefs } from './idb.js';
import { apiPost, ApiError } from './api.js';
import { balKey, normSku, normFacility } from './deltas.js';

export const MAX_BATCH = 25;
const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000, 120000];
const MAX_ATTEMPTS_BEFORE_STUCK = 6;

let flushing = false;
let backoffTimer = null;
const listeners = new Set();

/**
 * Bumped on every change to the queue. Read by the balance projection to know
 * when its memoised result is stale.
 *
 * A counter rather than a listener because `emit()` is synchronous and fires
 * several times per flush; anything doing real work in a listener would run it
 * five times per upload. A version number is free to read and impossible to
 * miss.
 */
let version = 0;
export function outboxVersion() { return version; }

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  version += 1;
  for (const fn of listeners) {
    try { fn(); } catch { /* a bad listener must not break the queue */ }
  }
}

function newIdemKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'k_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
}

/* ------------------------------------------------------------------ *
 * Queue state
 * ------------------------------------------------------------------ */

export async function pendingItems() {
  const all = await idb.all(STORE_OUTBOX);
  return all.sort((a, b) => a.seq - b.seq);
}

export async function pendingCount() {
  return idb.count(STORE_OUTBOX);
}

export async function failedItems() {
  const all = await idb.all(STORE_FAILURES);
  return all.sort((a, b) => a.seq - b.seq);
}

export async function failedCount() {
  return idb.count(STORE_FAILURES);
}

/**
 * Both queue counts in one call, memoised on the queue version.
 *
 * The sync pill needs both, and it repaints on every `render()` AND on every
 * `emit()` — which fires five or more times per upload. That was ten
 * IndexedDB transactions per save for two small integers that had not changed.
 */
let countMemo = { key: -1, pending: 0, failed: 0 };

export async function counts() {
  if (countMemo.key === version) return countMemo;
  const key = version;
  const [pending, failed] = await Promise.all([
    idb.count(STORE_OUTBOX), idb.count(STORE_FAILURES)
  ]);
  // Guard against a concurrent change while both counts were in flight: if the
  // queue moved under us, leave the memo cold rather than caching a torn read.
  if (version === key) countMemo = { key, pending, failed };
  return { key, pending, failed };
}

/** Reset any 'sending' left behind by a reload or an app kill. */
export async function recoverInFlight() {
  const all = await idb.all(STORE_OUTBOX);
  for (const it of all) {
    if (it.status === 'sending') {
      await idb.put(STORE_OUTBOX, { ...it, status: 'pending' });
    }
  }
  emit();
}

/* ------------------------------------------------------------------ *
 * Enqueue
 * ------------------------------------------------------------------ */

/**
 * @param {{type:string, sku:string, payload:object, recordedBy:string}} entry
 * @return {Promise<{rec:object, settled:Promise<object>}>}
 *
 * `settled` is the upload attempt this enqueue kicked off, HANDED BACK rather
 * than swallowed. It has to be, and the reason is a bug that shipped:
 *
 * on success the flush DELETES the entry from the queue, and the balances the
 * server replied with are the only post-write figures anything receives. Drop
 * them and the screen falls back to `state.balances`, which still holds the
 * PRE-write number — so the correct figure appears for a moment (while the
 * entry is still queued and counted) and then jumps BACKWARDS when the upload
 * succeeds. It reads exactly like the app losing the entry.
 *
 * The caller must NOT await it. The whole point of this file (see the header)
 * is that a yard worker never waits on a round trip.
 */
export async function enqueue(entry) {
  const rec = {
    idemKey: newIdemKey(),
    type: entry.type,
    // normSku, not `String(entry.sku || '')`. This yard has live numeric item
    // codes and a SKU of 0 is real: the obvious-looking version turns it into
    // '' at queue time, which is the class of bug commit 4856d64 exists for.
    sku: normSku(entry.sku),
    // Top level, NOT inside `payload`: the txns mapper below reads them
    // directly, and so does `entryKeys` when it keys the head-of-line
    // `blocked` set onto (facility, sku).
    facility: String(entry.facility || '').trim().toUpperCase(),
    toFacility: String(entry.toFacility || '').trim().toUpperCase(),
    payload: entry.payload || {},
    recordedBy: entry.recordedBy || prefs.getUser() || '',
    clientTs: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    lastAttemptTs: null,
    lastError: null
  };
  await idb.add(STORE_OUTBOX, rec);
  emit();
  // `flush()` never throws (it returns a summary carrying `error`), but a
  // rejection here must still not become an unhandled one — the entry stays in
  // the queue either way and backoff retries it.
  const settled = flush().catch(err => (
    { sent: 0, applied: 0, rejected: 0, balances: [], error: err }
  ));
  return { rec, settled };
}

/* ------------------------------------------------------------------ *
 * Flush
 * ------------------------------------------------------------------ */

/**
 * The balance keys one outbox entry occupies, for head-of-line ordering.
 *
 * One key for every type but TRANSFER, which occupies BOTH ends — a move out
 * of YARD A into YARD B has to order against later entries at A *and* at B.
 *
 * `normSku`/`normFacility` first, then `balKey` — the same pairing `foldDeltas`
 * uses, and not decoration: `balKey` normalises with `String(v || '')`, which
 * turns a live numeric SKU of 0 into '' and quietly merges it with the
 * no-SKU key. `normSku(0)` is '0'. (Same class of bug as commit 4856d64.)
 *
 * The `payload` fallback covers entries queued by an older build, before the
 * facility moved to the top level of the record — `projectBalances` in
 * deltas.js does exactly this.
 *
 * @param {object} it an outbox record
 * @return {string[]} one or two 'FACILITY|SKU' keys
 */
export function entryKeys(it) {
  const sku = normSku(it.sku);
  const from = balKey(normFacility(it.facility ?? it.payload?.facility ?? ''), sku);
  if (String(it.type || '').toUpperCase() !== 'TRANSFER') return [from];
  const to = balKey(normFacility(it.toFacility ?? it.payload?.toFacility ?? ''), sku);
  // A transfer whose two ends collapse to one key (same yard, or both blank)
  // must not report a duplicate — callers iterate these.
  return to === from ? [from] : [from, to];
}

/**
 * Choose the entries to send this pass, in queue order, skipping anything
 * behind a blocked key. MUTATES `blocked`: a skipped entry adds its OWN keys,
 * because it is now the head of the line for them — otherwise a TRANSFER held
 * back at its source would still let a later entry at its destination through
 * and apply the pair out of order.
 *
 * Pure, and exported, because `flush()` cannot be unit-tested (no IndexedDB in
 * Node) and this is the part with the ordering logic in it.
 *
 * @param {object[]} queue pending entries, already sorted by seq
 * @param {Set<string>} blocked keys held back this flush; mutated
 * @param {number} max batch cap
 * @return {object[]} the entries to send
 */
export function selectBatch(queue, blocked, max) {
  const batch = [];
  for (const it of queue) {
    if (batch.length >= max) break;
    const keys = entryKeys(it);
    if (keys.some(k => blocked.has(k))) {
      for (const k of keys) blocked.add(k);
      continue;
    }
    batch.push(it);
  }
  return batch;
}

/**
 * Push the queue. Returns a summary; never throws.
 *
 * @param {Set<string>} [blocked] head-of-line keys already held back. Defaults
 *   to a fresh set, so every existing caller keeps calling `flush()` with no
 *   arguments; the self-recursive call at the bottom passes its own set down,
 *   which is the whole point (see the file header).
 * @return {Promise<{sent:number, applied:number, rejected:number, balances:Array, error:?ApiError}>}
 */
export async function flush(blocked = new Set()) {
  if (flushing) return { sent: 0, applied: 0, rejected: 0, balances: [], error: null };
  flushing = true;
  emit();

  const summary = { sent: 0, applied: 0, rejected: 0, balances: [], error: null };

  try {
    const queue = await pendingItems();
    if (!queue.length) return summary;

    // Per-(facility, SKU) head-of-line: once a key has an entry that did not
    // apply this pass, skip its later entries so we don't apply them out of
    // order. `blocked` arrives from the caller and carries across the
    // recursion at the bottom.
    const batch = selectBatch(queue, blocked, MAX_BATCH);
    if (!batch.length) return summary;

    for (const it of batch) {
      await idb.put(STORE_OUTBOX, { ...it, status: 'sending', lastAttemptTs: new Date().toISOString() });
    }
    emit();

    let res;
    try {
      res = await apiPost('submitTxnBatch', {
        deviceId: prefs.getDeviceId(),
        appVersion: window.OY_APP_VERSION || '1.0.0',
        txns: batch.map(it => ({
          idemKey: it.idemKey,
          type: it.type,
          sku: it.sku,
          // Without these the server sees no facility on any entry and every
          // one of them comes back UNKNOWN_FACILITY. The record carries them,
          // but nothing was putting them on the wire.
          facility: it.facility || '',
          toFacility: it.toFacility || '',
          qty: it.payload.qty,
          damagedQty: it.payload.damagedQty || 0,
          condition: it.payload.condition || '',
          refNo: it.payload.refNo || '',
          vehicleNo: it.payload.vehicleNo || '',
          location: it.payload.location || '',
          remarks: it.payload.remarks || '',
          recordedBy: it.recordedBy,
          clientTs: it.clientTs
        }))
      });
    } catch (err) {
      // Transport or server-wide failure: put everything back, count an
      // attempt, schedule a jittered retry. Nothing is ever discarded here.
      const apiErr = err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err), true);
      for (const it of batch) {
        // The whole batch went nowhere, so every entry in it is still the head
        // of the line for its keys. Block them before returning: this call
        // does not reach the recursion, but `blocked` is the caller's set now
        // and a later pass reusing it must not overtake them.
        for (const k of entryKeys(it)) blocked.add(k);
        const attempts = it.attempts + 1;
        await idb.put(STORE_OUTBOX, {
          ...it,
          status: attempts >= MAX_ATTEMPTS_BEFORE_STUCK ? 'stuck' : 'pending',
          attempts,
          lastError: { code: apiErr.code, message: apiErr.message }
        });
      }
      summary.error = apiErr;
      scheduleRetry(batch[0].attempts + 1);
      emit();
      return summary;
    }

    summary.sent = batch.length;
    const results = (res.data && res.data.results) || [];
    const byKey = new Map(results.map(r => [r.idemKey, r]));

    for (const it of batch) {
      const r = byKey.get(it.idemKey);

      if (!r) {
        // The server did not mention it. Treat as unsent, not as lost.
        for (const k of entryKeys(it)) blocked.add(k);
        await idb.put(STORE_OUTBOX, { ...it, status: 'pending', attempts: it.attempts + 1 });
        continue;
      }

      if (r.status === 'applied' || r.status === 'duplicate') {
        // 'duplicate' means an earlier attempt already committed and its
        // response was lost. Identical outcome — the server has it.
        await idb.del(STORE_OUTBOX, it.seq);
        summary.applied += 1;
        continue;
      }

      // rejected — either way this entry did not apply, so nothing later at
      // its keys may apply during this flush.
      for (const k of entryKeys(it)) blocked.add(k);

      const err = r.error || { code: 'UNKNOWN', message: 'Rejected' };
      if (err.retryable) {
        await idb.put(STORE_OUTBOX, {
          ...it, status: 'pending', attempts: it.attempts + 1, lastError: err
        });
        continue;
      }
      // Blocking on a PERMANENT rejection too is deliberate. The entry leaves
      // the queue here, so its successors are no longer strictly out of order
      // — but it is gone pending a decision the user has to make on the
      // failures banner (retry it, or discard it), and applying the entries
      // that were queued behind it seconds later, inside the same flush, is
      // still the wrong call. The key clears by itself on the next flush.
      await idb.put(STORE_FAILURES, {
        ...it, status: 'failed', error: err, failedTs: new Date().toISOString()
      });
      await idb.del(STORE_OUTBOX, it.seq);
      summary.rejected += 1;
    }

    summary.balances = (res.data && res.data.balances) || [];
    if (res.meta && res.meta.epoch) prefs.setLastEpoch(res.meta.epoch);
    emit();

    // More waiting and nothing blocking? Keep going.
    if (await pendingCount() > 0 && summary.applied > 0) {
      flushing = false;
      // `blocked`, not a fresh set: everything held back above must stay held
      // back on the next pass, or this recursion sends it out of order.
      const more = await flush(blocked);
      summary.applied += more.applied;
      summary.rejected += more.rejected;
      summary.balances = summary.balances.concat(more.balances);
      summary.error = summary.error || more.error;
      return summary;
    }

    return summary;
  } finally {
    flushing = false;
    emit();
  }
}

export function isFlushing() { return flushing; }

function scheduleRetry(attempt) {
  if (backoffTimer) return;
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  // Jitter matters: ten phones regaining signal at shift start must not
  // resynchronise onto the same script lock.
  const wait = base + Math.floor(Math.random() * base * 0.4);
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    flush().catch(() => {});
  }, wait);
}

/* ------------------------------------------------------------------ *
 * Failure handling — a rejected entry must never just vanish
 * ------------------------------------------------------------------ */

/**
 * The one failure a retry can never fix. PLAN A7.
 *
 * An entry queued by the pre-warehouse build carries no warehouse, and there
 * is nowhere to put one: `retryFailed` copies the old payload forward, so a
 * "Try again" button on one of these is an infinite re-rejection loop — the
 * server answers UNKNOWN_FACILITY, it lands back in failures, and the user
 * taps it again. The entry has to be re-recorded against a real warehouse and
 * this one discarded, so Discard is the only honest button to offer.
 */
export const NEEDS_WAREHOUSE = 'NEEDS_WAREHOUSE';

/** Does this entry name every warehouse its type requires? */
function hasWarehouses(it) {
  const from = normFacility(it.facility ?? it.payload?.facility ?? '');
  if (!from) return false;
  if (String(it.type || '').toUpperCase() !== 'TRANSFER') return true;
  return !!normFacility(it.toFacility ?? it.payload?.toFacility ?? '');
}

/**
 * Move any entry queued before warehouses existed out of the queue.
 *
 * Run at startup, unconditionally rather than only on a schema change. Every
 * enqueue path in the app now refuses to queue an entry without a warehouse,
 * so anything in here missing one can only have come from the old build — and
 * keying this on the schema version instead would miss the phone whose cached
 * meta was lost, which is precisely the phone in the worst state.
 *
 * Left in the queue these are not harmless: `flush` sends them on every
 * enqueue, every poll and every visibilitychange, each one a rejected batch
 * entry, and the head-of-line rule then holds back the good entries queued
 * behind them at the same item.
 *
 * @return {Promise<number>} how many were moved
 */
export async function drainPreWarehouseEntries() {
  const queue = await pendingItems();
  let moved = 0;
  for (const it of queue) {
    if (hasWarehouses(it)) continue;
    await idb.put(STORE_FAILURES, {
      ...it,
      status: 'failed',
      // Read by the failures sheet to drop the "Try again" button. A flag on
      // the record, not a check on the code string, so a future failure of the
      // same kind only has to set it.
      noRetry: true,
      error: {
        code: NEEDS_WAREHOUSE,
        message: 'This entry was saved before the app tracked warehouses, so it '
          + 'does not say which yard it happened at. Record it again against the '
          + 'right warehouse, then discard this one.',
        retryable: false
      },
      failedTs: new Date().toISOString()
    });
    await idb.del(STORE_OUTBOX, it.seq);
    moved += 1;
  }
  if (moved) emit();
  return moved;
}

/** Put a failed entry back in the queue with a NEW key (the old one may have committed). */
export async function retryFailed(seq, patch = {}) {
  const it = await idb.get(STORE_FAILURES, seq);
  if (!it) return null;
  // Belt and braces against the UI. The failures sheet does not draw a retry
  // button for these, but re-queueing one would send it straight back to
  // failures on the next flush, and the user would have no way to tell that
  // their tap did nothing.
  if (it.noRetry && !patch.facility) return null;
  const rec = {
    idemKey: newIdemKey(),
    type: patch.type || it.type,
    sku: patch.sku || it.sku,
    facility: patch.facility || it.facility || '',
    toFacility: patch.toFacility || it.toFacility || '',
    payload: { ...it.payload, ...(patch.payload || {}) },
    recordedBy: it.recordedBy,
    clientTs: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    lastAttemptTs: null,
    lastError: null
  };
  await idb.add(STORE_OUTBOX, rec);
  await idb.del(STORE_FAILURES, seq);
  emit();
  // Same contract as `enqueue`: hand the attempt back so its balances land.
  const settled = flush().catch(err => (
    { sent: 0, applied: 0, rejected: 0, balances: [], error: err }
  ));
  return { rec, settled };
}

export async function discardFailed(seq) {
  await idb.del(STORE_FAILURES, seq);
  emit();
}
