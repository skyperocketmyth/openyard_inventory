/**
 * Sync orchestration — the layer that decides when a server reply is allowed
 * to replace what is on screen.
 *
 * The one rule this file exists to enforce:
 *
 *   A read from the server must NEVER adopt server state while local writes are
 *   still pending. Doing so silently resets what the user just recorded.
 *
 * `canAdoptServerSnapshot` is a named, tested function rather than an inline
 * condition precisely because its absence is invisible in review.
 */

import { cacheGet, cacheSet, prefs } from './idb.js';
import { apiGet, ApiError } from './api.js';
import { pendingCount, pendingItems, flush } from './outbox.js';
import { projectBalances } from './deltas.js';

/**
 * @param {number} pendingBefore count taken immediately BEFORE issuing the read
 * @param {number} pendingAfter  count taken when the response resolved
 * @return {boolean}
 *
 * Both must be zero. Checking only "before" misses a write enqueued while the
 * request was in flight (the response predates it); checking only "after"
 * misses the opposite ordering.
 */
export function canAdoptServerSnapshot(pendingBefore, pendingAfter) {
  return pendingBefore === 0 && pendingAfter === 0;
}

/* ------------------------------------------------------------------ *
 * Cached server state
 * ------------------------------------------------------------------ */

export const state = {
  items: [],
  users: [],
  balances: [],       // last known SERVER figures, never the projected ones
  uoms: ['PCS', 'KG', 'MT', 'BAG', 'BUNDLE', 'CBM', 'ROLL', 'LTR'],
  epoch: 0,
  itemsEpoch: 0,
  lastSyncTs: null,
  lastError: null,
  // Guarded so this module can be imported in Node for unit tests.
  online: typeof navigator !== 'undefined' ? navigator.onLine : true
};

export async function loadFromCache() {
  const [items, users, balances, meta] = await Promise.all([
    cacheGet('items'), cacheGet('users'), cacheGet('balances'), cacheGet('meta')
  ]);
  if (items) state.items = items;
  if (users) state.users = users;
  if (balances) state.balances = balances;
  if (meta) {
    state.epoch = meta.epoch || 0;
    state.itemsEpoch = meta.itemsEpoch || 0;
    state.lastSyncTs = meta.lastSyncTs || null;
  }
  return state;
}

async function persist() {
  await Promise.all([
    cacheSet('items', state.items),
    cacheSet('users', state.users),
    cacheSet('balances', state.balances),
    cacheSet('meta', {
      epoch: state.epoch,
      itemsEpoch: state.itemsEpoch,
      lastSyncTs: state.lastSyncTs
    })
  ]);
}

/**
 * Fold the balances a write RESPONSE carried back into local state.
 * Using the write's own response — rather than a follow-up read — is what
 * keeps a refresh from racing the writes it was triggered by.
 */
export async function mergeBalances(rows) {
  if (!rows || !rows.length) return;
  const map = new Map(state.balances.map(b => [String(b.sku).toUpperCase(), b]));
  for (const r of rows) {
    map.set(String(r.sku).toUpperCase(), {
      sku: String(r.sku).toUpperCase(),
      total: Number(r.total) || 0,
      damaged: Number(r.damaged) || 0,
      lastTxnTs: r.lastTxnTs || ''
    });
  }
  state.balances = [...map.values()].sort((a, b) => (a.sku < b.sku ? -1 : 1));
  state.lastSyncTs = new Date().toISOString();
  await persist();
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Full cold-start load: users + items + balances in ONE round trip. */
export async function bootstrap() {
  const before = await pendingCount();
  const res = await apiGet('bootstrap');
  const after = await pendingCount();
  const d = res.data || {};

  state.users = d.users || [];
  state.items = d.items || [];
  state.itemsEpoch = (d.meta && d.meta.itemsEpoch) || 0;
  state.epoch = (d.meta && d.meta.epoch) || 0;
  if (d.meta && d.meta.uoms) state.uoms = d.meta.uoms;

  // Items and users are reference data — safe to adopt unconditionally.
  // Balances are the contested resource, so they go through the gate.
  if (canAdoptServerSnapshot(before, after)) {
    state.balances = d.balances || [];
  } else {
    await mergeBalances(d.balances || []);
  }
  state.lastSyncTs = new Date().toISOString();
  state.lastError = null;
  await persist();
  return state;
}

/**
 * Background refresh. Cheap when nothing changed: the server answers
 * `unchanged` in ~40 bytes if our epoch still matches.
 */
export async function refreshBalances() {
  const before = await pendingCount();
  const res = await apiGet('getBalances', { sinceEpoch: String(state.epoch) });
  const after = await pendingCount();
  const d = res.data || {};

  if (d.unchanged) {
    state.lastSyncTs = new Date().toISOString();
    await persist();
    return { unchanged: true };
  }

  state.epoch = d.epoch || state.epoch;
  if (canAdoptServerSnapshot(before, after)) {
    state.balances = d.balances || [];
  } else {
    await mergeBalances(d.balances || []);
  }
  state.lastSyncTs = new Date().toISOString();
  await persist();
  return { unchanged: false };
}

export async function refreshItems() {
  const res = await apiGet('getItems', { sinceEpoch: String(state.itemsEpoch) });
  const d = res.data || {};
  if (d.unchanged) return { unchanged: true };
  state.items = d.items || [];
  state.itemsEpoch = d.itemsEpoch || state.itemsEpoch;
  await persist();
  return { unchanged: false };
}

/**
 * Pull-to-refresh. SEND THEN READ, deliberately.
 *
 * Reading first would report the state from before the pending write — which is
 * precisely the thing the user pulled down to check.
 */
export async function manualRefresh() {
  let flushError = null;
  try {
    const summary = await flush();
    if (summary.balances.length) await mergeBalances(summary.balances);
    flushError = summary.error;
  } catch (err) {
    flushError = err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err), true);
  }
  try {
    await refreshBalances();
    await refreshItems();
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err), true);
    return { ok: false, error: state.lastError };
  }
  return { ok: !flushError, error: flushError };
}

/* ------------------------------------------------------------------ *
 * What the screen actually shows
 * ------------------------------------------------------------------ */

/**
 * Server balances with every unsynced local entry layered on top.
 * Never render `state.balances` directly.
 */
export async function projected() {
  const queue = await pendingItems();
  return projectBalances(state.balances, queue);
}

export async function projectedFor(sku) {
  const key = String(sku || '').trim().toUpperCase();
  const rows = await projected();
  return rows.find(r => r.sku === key)
    || { sku: key, total: 0, damaged: 0, good: 0, pending: 0 };
}

export function itemBySku(sku) {
  const key = String(sku || '').trim().toUpperCase();
  return state.items.find(i => i.sku === key) || null;
}
