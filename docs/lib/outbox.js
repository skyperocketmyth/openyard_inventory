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
 *  - Head-of-line blocking is PER SKU, not global. Entries for different items
 *    are independent; within one item, order matters (receive-then-issue
 *    validates, the reverse does not). So one bad steel entry must not freeze
 *    every cement entry queued behind it.
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
    sku: String(entry.sku || '').trim().toUpperCase(),
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
 * Push the queue. Returns a summary; never throws.
 * @return {Promise<{sent:number, applied:number, rejected:number, balances:Array, error:?ApiError}>}
 */
export async function flush() {
  if (flushing) return { sent: 0, applied: 0, rejected: 0, balances: [], error: null };
  flushing = true;
  emit();

  const summary = { sent: 0, applied: 0, rejected: 0, balances: [], error: null };

  try {
    const queue = await pendingItems();
    if (!queue.length) return summary;

    // Per-SKU head-of-line: once a SKU has a rejected entry this pass, skip
    // its later entries so we don't apply them out of order.
    const blocked = new Set();
    const batch = [];
    for (const it of queue) {
      if (batch.length >= MAX_BATCH) break;
      if (blocked.has(it.sku)) continue;
      batch.push(it);
    }
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
          qty: it.payload.qty,
          damagedQty: it.payload.damagedQty || 0,
          condition: it.payload.condition || '',
          refNo: it.payload.refNo || '',
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

      // rejected
      const err = r.error || { code: 'UNKNOWN', message: 'Rejected' };
      if (err.retryable) {
        await idb.put(STORE_OUTBOX, {
          ...it, status: 'pending', attempts: it.attempts + 1, lastError: err
        });
        continue;
      }
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
      const more = await flush();
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

/** Put a failed entry back in the queue with a NEW key (the old one may have committed). */
export async function retryFailed(seq, patch = {}) {
  const it = await idb.get(STORE_FAILURES, seq);
  if (!it) return null;
  const rec = {
    idemKey: newIdemKey(),
    type: patch.type || it.type,
    sku: patch.sku || it.sku,
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
