/**
 * A minimal in-memory IndexedDB for the Node tests.
 *
 * Node has no IndexedDB, and the client modules write through docs/lib/idb.js
 * on nearly every path — `persist()` at the end of `mergeBalances`, the outbox
 * on every enqueue and drain. Without this those calls reject, and a test would
 * have to swallow the error, which would also swallow a real failure.
 *
 * Only the handful of operations idb.js actually uses are implemented. Anything
 * else is deliberately absent, so a new caller shows up as an error rather than
 * as a silent no-op.
 *
 * It is shared rather than copied into each test file on purpose: this project
 * has lost a session to twin-file drift more than once, and a test double that
 * disagrees with itself between two files is the same failure wearing a hat.
 *
 * Install order does not matter. `indexedDB` is read inside `openDb()`, never
 * at import time, so calling this after the imports at the top of a test file
 * is still before anything opens a database.
 */
export function installFakeIndexedDb() {
  const stores = new Map();
  const storeOf = (n) => {
    if (!stores.has(n)) stores.set(n, new Map());
    return stores.get(n);
  };
  globalThis.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore(n) { storeOf(n); return { createIndex() {} }; },
          transaction(name) {
            const m = storeOf(name);
            const t = {};
            t.objectStore = () => ({
              // The cache store is keyed on `key`, the outbox on `seq`.
              put(v) { const k = v.key !== undefined ? v.key : v.seq; m.set(k, v); return { result: k }; },
              add(v) { const k = v.key !== undefined ? v.key : v.seq; m.set(k, v); return { result: k }; },
              get(k) { return { result: m.get(k) }; },
              getAll() { return { result: [...m.values()] }; },
              delete(k) { m.delete(k); return { result: undefined }; },
              count() { return { result: m.size }; },
              clear() { m.clear(); return { result: undefined }; }
            });
            // Fires after the whole synchronous body of idb.js's tx(), which
            // is where `oncomplete` gets assigned.
            queueMicrotask(() => { if (t.oncomplete) t.oncomplete(); });
            return t;
          }
        };
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return {
    /** Direct access to a store, for arranging and asserting in a test. */
    store: storeOf,
    reset() { stores.clear(); }
  };
}
