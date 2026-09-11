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
import { pendingCount, pendingItems, flush, outboxVersion } from './outbox.js';
import { projectBalances, balKey, normSku, normFacility } from './deltas.js';

/**
 * Bumped every time `state.balances` is replaced. Half of the projection's
 * cache key; the other half is the outbox version.
 *
 * BOTH are required. Keying on the outbox alone looks sufficient — the queue is
 * what changes as the user taps — but `state.balances` also changes on
 * `bootstrap`, `mergeBalances` and `refreshBalances`, and none of those touch
 * the queue. A cache keyed only on the outbox would therefore go stale at
 * exactly the moment a sync lands, re-creating the very stale-figure bug this
 * layer exists to prevent.
 */
let balancesVersion = 0;
function bumpBalances() { balancesVersion += 1; }

/**
 * The cache key for the last-known SERVER balance rows.
 *
 * v2, and the version is the whole point. In S02 the row SHAPE changed: a
 * balance is now one row per (facility, sku) and carries `facility`. A v1 blob
 * restored under the new reader is worse than having no cache at all —
 * `balKey(undefined, 'X')` is '|X', and `uiFacility` is '' until S03 wires the
 * picker, so `projectedFor('', sku)` looks up '|X' and HITS last week's
 * pre-facility figure. The app would then show that number as this yard's
 * current stock, confidently and with no error, until a getBalances happened
 * to come back with a changed epoch.
 *
 * Changing the key is the same move the server made for its own cache
 * ('oy_bal_v2_' in readBalances_), and for the same reason. Bumping
 * DB_VERSION in idb.js would NOT have done it — an IndexedDB upgrade only
 * creates missing stores, it does not discard what is in them.
 *
 * S04 (PLAN A7) replaces this with a schema-version-driven cache clear that
 * handles every key at once. This closes the specific hole that exists now.
 */
const BALANCES_CACHE_KEY = 'balances_v2';

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
  facilities: [],     // reference data, same status as items
  balances: [],       // last known SERVER figures, never the projected ones
  uoms: ['PCS', 'KG', 'MT', 'BAG', 'BUNDLE', 'CBM', 'ROLL', 'LTR'],
  epoch: 0,
  itemsEpoch: 0,
  facilitiesEpoch: 0,
  lastSyncTs: null,
  lastError: null,
  // Guarded so this module can be imported in Node for unit tests.
  online: typeof navigator !== 'undefined' ? navigator.onLine : true
};

export async function loadFromCache() {
  const [items, users, facilities, balances, meta] = await Promise.all([
    cacheGet('items'), cacheGet('users'), cacheGet('facilities'),
    cacheGet(BALANCES_CACHE_KEY), cacheGet('meta')
  ]);
  if (items) state.items = items;
  if (users) state.users = users;
  if (facilities) state.facilities = facilities;
  if (balances) { state.balances = balances; bumpBalances(); }
  if (meta) {
    state.epoch = meta.epoch || 0;
    state.itemsEpoch = meta.itemsEpoch || 0;
    state.facilitiesEpoch = meta.facilitiesEpoch || 0;
    state.lastSyncTs = meta.lastSyncTs || null;
  }
  return state;
}

async function persist() {
  await Promise.all([
    cacheSet('items', state.items),
    cacheSet('users', state.users),
    cacheSet('facilities', state.facilities),
    cacheSet(BALANCES_CACHE_KEY, state.balances),
    cacheSet('meta', {
      epoch: state.epoch,
      itemsEpoch: state.itemsEpoch,
      facilitiesEpoch: state.facilitiesEpoch,
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
  // Keyed FACILITY|SKU. The same item at two yards is two independent rows,
  // and a write response naming one of them must not overwrite the other.
  const map = new Map(state.balances.map(b => [balKey(b.facility, b.sku), b]));
  for (const r of rows) {
    map.set(balKey(r.facility, r.sku), {
      // normSku/normFacility, never String(x || '') — a SKU of 0 is real here.
      facility: normFacility(r.facility),
      sku: normSku(r.sku),
      total: Number(r.total) || 0,
      damaged: Number(r.damaged) || 0,
      lastTxnTs: r.lastTxnTs || ''
    });
  }
  state.balances = [...map.values()].sort((a, b) =>
    a.facility < b.facility ? -1 : a.facility > b.facility ? 1
      : a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  bumpBalances();
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
  state.facilities = d.facilities || [];
  state.itemsEpoch = (d.meta && d.meta.itemsEpoch) || 0;
  state.facilitiesEpoch = (d.meta && d.meta.facilitiesEpoch) || 0;
  state.epoch = (d.meta && d.meta.epoch) || 0;
  if (d.meta && d.meta.uoms) state.uoms = d.meta.uoms;

  // Items, users and facilities are reference data — safe to adopt
  // unconditionally.
  // Balances are the contested resource, so they go through the gate.
  if (canAdoptServerSnapshot(before, after)) {
    state.balances = d.balances || [];
    bumpBalances();
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
    bumpBalances();
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
 * The same shape as `refreshItems`, and deliberately outside the adoption
 * gate: a pending write can only change a BALANCE, never the list of yards.
 */
export async function refreshFacilities() {
  const res = await apiGet('getFacilities', { sinceEpoch: String(state.facilitiesEpoch) });
  const d = res.data || {};
  if (d.unchanged) return { unchanged: true };
  state.facilities = d.facilities || [];
  state.facilitiesEpoch = d.facilitiesEpoch || state.facilitiesEpoch;
  await persist();
  return { unchanged: false };
}

/**
 * Fold one saved warehouse back into local state, using the full record
 * `upsertFacility` returns, so the screen updates without a second round trip.
 *
 * Merged by NAME, which is safe precisely because a warehouse can never be
 * renamed (9.A) — the key it is merged on is the same key it will always have.
 * The list is kept sorted by name to match the server's own order, so the
 * picker does not visibly reshuffle when the next read lands.
 */
export async function mergeFacility(rec) {
  if (!rec || !rec.facility) return state.facilities;
  const key = normFacility(rec.facility);
  const merged = {
    facility: key,
    description: String(rec.description ?? ''),
    active: rec.active !== false,
    rev: Number(rec.rev) || 0
  };
  const rest = state.facilities.filter(f => normFacility(f.facility) !== key);
  state.facilities = [...rest, merged].sort((a, b) =>
    a.facility < b.facility ? -1 : a.facility > b.facility ? 1 : 0);
  await persist();
  return state.facilities;
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
    // Its own try/catch, and not a lazy one. A server that predates warehouses
    // answers UNKNOWN_ACTION here, which is NOT retryable — so without this the
    // whole pull-to-refresh reports a hard failure even though the upload and
    // both other reads succeeded, and the user is told the sync broke when it
    // did not. Any other failure is still surfaced.
    try {
      await refreshFacilities();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'UNKNOWN_ACTION')) throw err;
    }
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
 *
 * Memoised, because this is on the typing path. Every keystroke in a quantity
 * box or a search field used to re-read the whole outbox from IndexedDB and
 * re-fold every balance — twice per keystroke in the quantity fields, since
 * `projectedFor` ran the full projection and then picked one row out of it.
 *
 * The cache key is (outbox version, balances version) and both halves matter —
 * see the note on `balancesVersion` above.
 */
let memo = { key: '', rows: null, byKey: null };

export async function projected() {
  const key = outboxVersion() + ':' + balancesVersion;
  if (memo.key === key && memo.rows) return memo.rows;

  const queue = await pendingItems();
  const rows = projectBalances(state.balances, queue);

  // The index is built here rather than on demand so that `projectedFor` is a
  // map lookup: the quantity fields call it on every keystroke.
  const byKey = new Map(rows.map(r => [balKey(r.facility, r.sku), r]));
  memo = { key, rows, byKey };
  return rows;
}

/** One yard's figure for one item. A key with no row is zeros, never undefined. */
export async function projectedFor(facility, sku) {
  const fac = normFacility(facility);
  const key = normSku(sku);
  await projected();                       // fills the memo, cheap when warm
  return memo.byKey.get(balKey(fac, key))
    || { facility: fac, sku: key, total: 0, damaged: 0, good: 0, pending: 0 };
}

export function itemBySku(sku) {
  const key = normSku(sku);
  return state.items.find(i => i.sku === key) || null;
}

export function facilityByName(name) {
  const key = normFacility(name);
  return state.facilities.find(f => f.facility === key) || null;
}
