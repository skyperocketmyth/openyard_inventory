/**
 * Minimal IndexedDB wrapper. ~90 lines, no npm, no build step.
 *
 * IndexedDB rather than localStorage because localStorage is synchronous
 * (every enqueue would re-serialise the whole queue on the main thread and
 * jank the UI mid-tap) and non-transactional (an app kill during a flush can
 * leave a half-written queue). Only four tiny scalars stay in localStorage:
 * the chosen user, the device id, the app version and the last epoch.
 */

const DB_NAME = 'oy_db';
const DB_VERSION = 1;

export const STORE_OUTBOX = 'outbox';
export const STORE_CACHE = 'cache';
export const STORE_FAILURES = 'failures';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const s = db.createObjectStore(STORE_OUTBOX, { keyPath: 'seq', autoIncrement: true });
        s.createIndex('status', 'status', { unique: false });
        s.createIndex('idemKey', 'idemKey', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_FAILURES)) {
        db.createObjectStore(STORE_FAILURES, { keyPath: 'seq' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try {
      result = fn(s);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = req => ({ __req: req });

export const idb = {
  add: (store, value) => tx(store, 'readwrite', s => wrap(s.add(value))),
  put: (store, value) => tx(store, 'readwrite', s => wrap(s.put(value))),
  get: (store, key) => tx(store, 'readonly', s => wrap(s.get(key))),
  del: (store, key) => tx(store, 'readwrite', s => wrap(s.delete(key))),
  all: store => tx(store, 'readonly', s => wrap(s.getAll())),
  count: store => tx(store, 'readonly', s => wrap(s.count())),
  clear: store => tx(store, 'readwrite', s => wrap(s.clear())),

  /** Read-modify-write a single record inside one transaction. */
  update: (store, key, mutate) => tx(store, 'readwrite', s => {
    const req = s.get(key);
    req.onsuccess = () => {
      const cur = req.result;
      if (cur === undefined) return;
      const next = mutate(cur);
      if (next) s.put(next);
    };
    return null;
  })
};

/* --------- cache store: named JSON blobs (items, balances, users) -------- */

export async function cacheGet(key) {
  const row = await idb.get(STORE_CACHE, key);
  return row ? row.value : null;
}

export async function cacheSet(key, value) {
  return idb.put(STORE_CACHE, { key, value, fetchedTs: new Date().toISOString() });
}

export async function cacheMeta(key) {
  const row = await idb.get(STORE_CACHE, key);
  return row ? { fetchedTs: row.fetchedTs } : null;
}

/* ------------------------- tiny scalar prefs ---------------------------- */

const LS = {
  read(k, dflt = null) {
    try { const v = localStorage.getItem(k); return v === null ? dflt : v; }
    catch { return dflt; }
  },
  write(k, v) {
    try { localStorage.setItem(k, v); } catch { /* private mode: ignore */ }
  }
};

export const prefs = {
  getUser: () => LS.read('oy_user'),
  setUser: name => LS.write('oy_user', name),
  getLastEpoch: () => Number(LS.read('oy_last_epoch', '0')) || 0,
  setLastEpoch: n => LS.write('oy_last_epoch', String(n)),
  getSort: () => LS.read('oy_sort', 'sku'),
  setSort: v => LS.write('oy_sort', v),
  getRecent: () => {
    try { return JSON.parse(LS.read('oy_recent', '[]')) || []; } catch { return []; }
  },
  pushRecent(sku) {
    const list = [sku, ...this.getRecent().filter(s => s !== sku)].slice(0, 8);
    LS.write('oy_recent', JSON.stringify(list));
    return list;
  },
  getDeviceId() {
    let id = LS.read('oy_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 10);
      LS.write('oy_device_id', id);
    }
    return id;
  }
};
