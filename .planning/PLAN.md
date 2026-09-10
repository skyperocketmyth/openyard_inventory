# SPEC v2 — Open Yard Inventory: facilities, vehicle number, performance

Supersedes DRAFT-SPEC.md. Every finding F1–F13 from the first review is addressed
below with an explicit resolution line. Read this as the build spec.

## Confirmed user decisions
1.A stock SEPARATE per facility · 2.A transfers required · 3.C wipe existing (test) data
4.B facilities created from a settings screen with a near-duplicate guard
5.A every entry screen requires a facility · 6.B no stale pre-fill
7.B vehicle number OPTIONAL free text, Issue screen only
8.B new `facility` column; leave `location` free
9.A facility name is IMMUTABLE — no rename, ever
10.A "All facilities" view is VIEW-ONLY; actions require a facility
    (+ implied) a facility chosen on the balance screen carries into the action started from
    there; entering Issue/Receive directly still requires a fresh pick
11.A a movement to an INACTIVE facility is ACCEPTED and flagged, never rejected
12.A OPENING is blocked only by a prior OPENING at the same (facility, SKU) — not by other movements
13.A wipe performed directly on the live Sheet, no backup copy (user declined)
14.A under 10 facilities -> NO server-side facility filtering needed

---

# PART A — Facility dimension

## A1. `Facilities` tab
Header: `facility, description, active, created_by, created_ts, facility_rev`
- Key = `facility`, trimmed + uppercased (mirrors `normSku_`, `gas/Code.js:169-171`).
- **The key is immutable (9.A).** `upsertFacility_` may edit `description` and `active` ONLY.
  Never rewrite column 1 — same rule and same reason as `gas/Ledger.js:406` for SKUs.
  The Manage-warehouses UI must say so at creation: "This name cannot be changed later."
- Near-duplicate guard: reject if `upper(name).replace(/[^A-Z0-9]/g,'')` collides with an existing
  facility's same normalisation. "Yard A" / "yard a" / "YardA" -> one facility.
- New Meta key `facilities_epoch`, bumped on every facility write (mirrors `items_epoch`).
- `bootstrap_()` returns `facilities`; new `getFacilities` read action; client caches in IndexedDB.
- **RESOLVES F9.**

## A2. Ledger header
```
H_LEDGER = [txn_id, idem_key, txn_type, facility, to_facility, sku, qty, damaged_qty,
            condition, ref_no, vehicle_no, location, remarks, recorded_by,
            client_ts, server_ts, device_id, app_version, void_of_txn_id, void_of_type]
```
`H_SNAP = [facility, sku, total_qty, damaged_qty, good_qty, opening_done, last_txn_ts, updated_ts]`
(`opening_done` is new — see A5.)

**Every positional read must be re-indexed. Complete list (RESOLVES F5's omission of Balance.js):**
- `gas/Code.js` — `getLedgerRead_:367-393` (all `r[N]`), `readBalances_:344-365`
- `gas/Ledger.js` — append literal `:131-137`, `ledgerIdemKeys_:313-324`,
  `voidTxn_:503, :508, :512-516, :534-540`
- `gas/Balance.js` — `snapshotMap_:104-114`, `applySnapshotDeltas_:136-152`,
  `rebuildSnapshot_:168-179`  **<- densest, and omitted from the first draft**
- `gas/Setup.js` — `textCols:50-56`, `purgeTestData_:162-164`

**Mandatory hardening:** replace every magic column number with `H_X.indexOf('name')`.
`gas/Setup.js:50-56` hardcodes `[T_LEDGER,4]`=sku and `[T_SNAP,1]`=sku; inserting `facility`
silently moves plain-text protection onto the wrong column and re-introduces the numeric-SKU
corruption fixed in commit `4856d64`. Deriving the index makes that class of bug unrepeatable.
- **RESOLVES F6 (textCols), F5 (Balance.js).**

## A3. Composite balance key
- Key: `facility + '|' + sku`, via one shared `balKey(facility, sku)` per side.
- **Full list of sites that must be re-keyed** (the first draft missed six):

| Site | File:line |
|---|---|
| `snapshotMap_` | gas/Balance.js:101-117 |
| `balanceOf_` | gas/Balance.js:121-125 |
| `applySnapshotDeltas_` | gas/Balance.js:136-152 |
| `rebuildSnapshot_` | gas/Balance.js:160-202 |
| `foldDeltas_` | gas/Balance.js:76-91 |
| `workingFor_` **(highest consequence — same SKU at two facilities would share one working balance and corrupt in-lock validation)** | gas/Ledger.js:178-184 |
| `validateTxn_` (+ signature gains `facility`) | gas/Ledger.js:190, 215, 234 |
| `deltaMap` / `touched` | gas/Ledger.js:82-83, 122-127 |
| `balancesForTouched_` (this is the WIRE SHAPE) | gas/Ledger.js:331-345 |
| `readBalances_` (the bootstrap payload) | gas/Code.js:344-365 |
| `foldDeltas` / `projectBalances` | docs/lib/deltas.js:76-91, 96-136 |
| `mergeBalances` | docs/lib/sync.js:82-96 |
| `projectedFor` | docs/lib/sync.js:204-209 |

Wire shape for a balance row becomes `{facility, sku, total, damaged, good, lastTxnTs}`.
- **RESOLVES F5.**

## A4. TRANSFER — ONE ledger row, two-key delta
**This supersedes both the first draft AND the reviewer's proposed correction.** The reviewer
suggested two rows both typed `TRANSFER`; that double-counts on `rebuildSnapshot_`, which folds
every row independently (`gas/Balance.js:167-181`) — one transfer would apply -2×qty at the source.
Two rows typed `TRANSFER_OUT`/`TRANSFER_IN` avoids that but forces the client (which holds ONE
outbox entry typed `TRANSFER`) to use a different case set from the server — precisely the
twin-file divergence `gas/Balance.js:4-10` exists to prevent.

**The design: one transaction, one ledger row, and `deltasFor` returns a LIST of keyed deltas.**

```
deltasFor(t) -> [ { facility, dTotal, dDamaged }, ... ]
```
- For every existing type the list has exactly ONE entry, at `t.facility`.
- `TRANSFER` returns TWO: `{facility: t.facility, dTotal: -qty, dDamaged: 0}` and
  `{facility: t.toFacility, dTotal: +qty, dDamaged: 0}`.
- `VOID` negates every entry of the original's list — so **voiding a transfer works with the
  existing VOID rule, unchanged, and needs no redesign.**

Why this is better than any two-row scheme:
- ONE contract, byte-identical in `gas/Balance.js` and `docs/lib/deltas.js`. No special case on
  either side. The drift test keeps covering it.
- `rebuildSnapshot_` is correct by construction — one row folded once.
- `voidTxn_` needs no change beyond re-indexing: one `txn_id`, one reversing row. **RESOLVES F4
  entirely**, including its idem-key last-write-wins and `touched`-marks-source-only sub-findings.
- `ledgerIdemKeys_` sees one key per row again. No duplicate-key tolerance needed.
- MAX_BATCH stays 1:1 rows-to-txns.

Rules:
- `TRANSFER` moves GOOD stock only (`condition: 'GOOD'`, dDamaged 0 both sides). Moving damaged
  stock between facilities is OUT of scope.
- `TYPES_ALL` (`gas/Ledger.js:18`) gains `TRANSFER`. It is also valid as a `voidOfType`.
  **RESOLVES F1** (the first draft never mentioned `TYPES_ALL`).
- Validation: `toFacility` must EXIST and differ from `facility`; source `good >= qty`.
  An inactive `toFacility` is accepted and flagged (11.A, see A8).
- `touched` must mark BOTH keys so the response returns both facilities' balances.
- UI: "Move stock" action on the item-detail sheet beside "Record damage" (`docs/index.html:949`).
  Not a fifth tab.

## A5. OPENING guard — once per (facility, SKU), and only vs a prior OPENING
Current guard (`gas/Ledger.js:230-240`) fires on `snap[sku]` being present at all, so any prior
movement blocks the opening — and reports "Opening stock is already set", which would be false.
Per 12.A: block ONLY if an OPENING has already been recorded at that (facility, SKU).

Mechanism: new `opening_done` boolean column on `Balance_Snapshot` (A2), set inside the write lock
when an OPENING is applied. Avoids scanning the ledger. Guard becomes
`if (snap[key] && snap[key].openingDone)`. Error text: "Opening stock for <SKU> at <FACILITY> has
already been recorded."
- **RESOLVES F12.**

## A6. UI
- Facility picker: reuse the item-picker sheet component (`openPicker`, `docs/index.html:988-1048`),
  searchable. Required on Receive, Issue, Damage, Transfer, and the Opening block of the item form.
- Balance screen gains a facility chip row: `All` + one chip per ACTIVE facility.
  - `All` -> one row per ITEM, aggregated. **VIEW-ONLY (10.A).** Tapping a row opens the detail
    sheet showing the per-facility breakdown; each breakdown line is the tap target that starts an
    action for THAT facility.
  - A facility chip selected -> one row per item at that facility; actions started from here carry
    that facility (10.A implied).
  - Entering Receive/Issue from the tab bar -> facility is EMPTY, fresh pick (6.B).
  - **Every action must gate its quantity on the SELECTED facility's `good`, never the aggregate.**
    Specifically: the Issue/Damage enable checks (`docs/index.html:939, 941-942`), `$('issAll')`
    prefill (`:1217, :1247-1251`), and the "Left after this" preview (`:1238-1239`).
    **RESOLVES F10.**
- "Manage warehouses" added to the account sheet (`docs/index.html:770-802`). Add / edit
  description / deactivate. Never delete, never rename (9.A).
- Chosen facility shown prominently on every confirm/preview step.
- `data-sku` render paths to re-key: `docs/index.html:871`, `:893` (the draft's 1003/1008 were
  wrong — those are the picker's `data-pick`, which needs the same treatment separately).
  Also: `openItemDetail:915-951`, `loadMoves:956` (filters `i.sku === sku`),
  `choosePick:1050-1056`, and `getLedgerRead_` (`gas/Code.js:367-393`) which has **no facility
  filter or label today** and needs both.
  `prefs.getRecent`/`pushRecent` (`docs/lib/idb.js:121-128`) keep storing BARE SKUs — recent items
  are a catalogue convenience, not a stock figure. Deliberate; documented in the code.
- **Items remain a single shared, facility-agnostic catalogue.** `H_ITEMS` is unchanged, so
  `upsertItem_`'s hardcoded column offsets (`gas/Ledger.js:407-408`) are unaffected.

## A7. Wipe + schema bump — NOT via `ensureTabs_`
**`ensureTabs_` stays additive-only.** `action=setup` is routed from `doGet` with no auth
(`gas/Code.js:134`) on an `ANYONE_ANONYMOUS` deployment, so making it destructive would give
anyone who has ever seen the `/exec` URL a one-click inventory wipe. `gas/Setup.js:4-6` documents
the additive contract; it must hold.
- `ensureTabs_` may ONLY: add the `Facilities` tab, and write headers where A1 is blank.
- The wipe + header rewrite is a separate `migrateToV2()` function that is **NOT in `route_`** —
  run once from the Apps Script editor. It: rewrites `Ledger` + `Balance_Snapshot` headers,
  clears `Ledger`/`Balance_Snapshot`/`Rejections`, sets `schema_version = 2`, and
  **explicitly bumps `ledger_epoch` and `items_epoch`.**
- **RESOLVES F-top-risk and F7's epoch trap:** `ensureTabs_` only seeds ABSENT Meta keys
  (`gas/Setup.js:66-82`), so without an explicit bump `getBalancesRead_` answers `unchanged:true`
  (`gas/Code.js:288-292`) and `readBalances_`/`readItems_` serve pre-wipe data from the
  epoch-keyed cache (`gas/Code.js:345, 319`) — every phone would keep the deleted numbers forever.
- Client: `schemaVersion` is currently returned (`gas/Code.js:276`) but **ignored** — `sync.js:110-113`
  drops it and `persist()` (`docs/lib/sync.js:64-75`) never stores it. Plumb it: store it, and on
  an increase clear the IndexedDB cache store (old SKU-keyed balances would poison the projection).
- Any outbox entry queued under schema 1 (no facility) moves to `failures` with a plain-English
  message. The failures UI offers **Discard only** for these — `retryFailed`
  (`docs/lib/outbox.js:269-289`) copies the old payload with no way to add a facility, so a
  "Try again" button would be an infinite re-rejection loop. **RESOLVES F7.**
- Bump `CACHE` in `docs/sw.js` (gate check 7 enforces this).

## A8. Inactive facility (11.A)
- No `INACTIVE_FACILITY` rejection exists and none is added. A movement to an inactive facility is
  ACCEPTED; the server appends a marker to the row's `remarks` ("[facility inactive at upload]")
  so a supervisor sees it in the Sheet. A non-existent facility IS rejected (`UNKNOWN_FACILITY`).
- Rationale to keep in the code comment: the stock has already physically moved; rejecting makes
  the app confidently wrong about where it is. Do NOT copy `INACTIVE_SKU` semantics
  (`gas/Ledger.js:198`) here by reflex.
- **RESOLVES F11.**

---

# PART B — Vehicle number
- New `vehicle_no` Ledger column (A2). Optional, trimmed, uppercased, max 20 chars.
- Issue screen only. Input beside `issRef` (`docs/index.html:468`). Recently-used numbers as
  one-tap chips (localStorage, `prefs` pattern).
- Threaded: `docs/index.html:1262` payload -> `docs/lib/outbox.js:159-171` txns mapper ->
  `gas/Ledger.js:131-137` append -> `getLedgerRead_` output.

---

# PART C — Performance

## C1. The stale/reverting stock bug — CORRECTED MECHANISM
The first draft's mechanism was wrong. Verified actual behaviour:
- The 30s poll DOES merge flush balances (`docs/index.html:1731-1732`), as does `visibilitychange`
  (`:1723-1724`). "Nothing pulls balances" was incorrect.
- The real fault: the poll body is gated on `if (await OB.pendingCount() > 0 …)`
  (`docs/index.html:1730`). The `flush()` that `enqueue` fires (`docs/lib/outbox.js:115`) has
  already deleted the applied entry (`:208`), so the count is 0 and the poll never runs. The ONLY
  flush that executed is the one whose `summary.balances` is discarded.
- Symptom is worse than stale: the figure **reverts**. `projected()` = `state.balances` (pre-write)
  + an outbox that is now empty (`docs/lib/sync.js:199-202`), so the correct number shows briefly
  and then jumps backwards.
- The draft's fix was a NO-OP: `flush()` sets `flushing = true` synchronously before its first
  await (`docs/lib/outbox.js:128-130`), so a second `flush()` from the submit handler hits the
  re-entrancy guard and returns `{balances: []}`.

**Correct fix:**
1. `enqueue` returns the flush promise (or routes balances through the existing `onChange`
   listener set, `docs/lib/outbox.js:41-52`) so the enqueue-triggered flush's balances ARE merged.
2. Add `SY.refreshBalances()` to the 30s poll **OUTSIDE the `pendingCount() > 0` guard** — it is
   epoch-conditional and answers in ~40 bytes when nothing changed (`gas/Code.js:286-293`).
   This also fixes the separate, unreported correctness problem that **this app never learns about
   other phones' entries unless it is restarted.**
3. NOT a bug, dropped from the plan: the draft claimed `docs/index.html:1175, 1270` fail to
   re-render. They call `paintReceive()`/`paintIssue()`, which re-read `projectedFor` and do show
   the new figure. The balance list is not visible from those screens.
- **RESOLVES F2.**

## C2. Per-keystroke recomputation
- Memoise `projected()`, invalidated by an outbox version counter bumped in `emit()`.
- `projectedFor(sku, facility)` reads the memoised projection instead of re-folding
  (currently runs the FULL projection then `.find()`s — twice per keystroke:
  `docs/index.html:1116`+`:1139`, `:1205`+`:1236`).
- Debounce balance search (`:898`) and picker search (`:1046`) at ~150ms.
- `renderSync()` (`:628-629`) serves its two counts from memoised state instead of two fresh
  IndexedDB reads per render AND per outbox `emit()`.
- **DROPPED as gold-plating (F13):** the `itemBySku` -> `Map` change. 200 items × 200 rows is
  microseconds and a Map adds an invalidation surface across bootstrap/`refreshItems`/local merge.
- Correction: "re-opens IndexedDB" was overstated — `openDb()` memoises `dbPromise`
  (`docs/lib/idb.js:21`). It opens a new *transaction* per read.
- **PREREQUISITE, not an optimisation:** A3 makes the balance payload O(facilities × items).
  At 14.A (<10 facilities) × 200 items that is ~2000 rows re-folded per keystroke without this.
  C2 must land BEFORE Part A. No server-side facility filtering needed at this scale.

## C3. Blocking network
- New-user save (`docs/index.html:760`) blocks navigation on a POST. Make fully optimistic — no
  dependency, safe.
- Item save does TWO sequential blocking round trips (`:1578` POST, then `:1596` `refreshItems`
  GET — the draft mislabelled the second a POST; substance holds). Drop the second by having
  `upsertItem_` return the **full saved item including `rev`** and merging locally.
  `upsertItem_` currently returns only `{sku, created}` (`gas/Ledger.js:411`); merging without the
  new `rev` means the next edit sends a stale one and takes `STALE_ITEM_REV`
  (`gas/Ledger.js:398-401`). **RESOLVES F13.**
- Keep the FIRST call blocking deliberately: the OPENING outbox entry enqueued straight after
  would take `UNKNOWN_SKU` (`gas/Ledger.js:197`) if it raced ahead of the item's creation.

## C4. Server round trips
Measured starting point: 25+ discrete Sheet calls per `submitTxnBatch_`. Honest target: **~8–9**
(five tabs must be read, three written) — NOT the draft's "4–5".
- Memoise `ss_()` and `tab_()` per execution.
- Memoise `metaAll_()` per execution, invalidated on `metaSet_`. `metaBlock_` alone does three full
  Meta reads (`gas/Code.js:74-76`) and EVERY response builds it.
- `snapshotMap_()` is called exactly three times per write (`gas/Ledger.js:77`,
  `gas/Balance.js:132`, `gas/Ledger.js:332`). Call once, thread it through.
- `applySnapshotDeltas_` writes one `setValues` per SKU in a loop (`gas/Balance.js:144-145`).
  Read the range once, mutate in memory, write back in ONE `setValues`.
- Memoise `readUsers_()` per execution.
- **`ledgerIdemKeys_` — the draft's bounded scan is REJECTED.** Its safety argument was false:
  `stuck` is NOT terminal. `pendingItems()` returns every outbox record with no status filter
  (`docs/lib/outbox.js:63-66`) and `flush()` batches straight off it (`:135-146`), so a stuck entry
  retries on every enqueue, every poll and every `visibilitychange`, forever. A bounded scan is a
  real double-post cliff. The draft also claimed a CacheService `idem_` read that **does not
  exist** — the cache is written (`gas/Ledger.js:148`) and never read; `:76` uses
  `ledgerIdemKeys_()` alone.
  **Instead:** cache the whole `idem_key -> txn_id` map with `setCacheChunked_`
  (`gas/Code.js:212-227`) under the current `ledger_epoch`. On a write, take the cached map, add
  the new keys, and re-put under the bumped epoch — so the map is always complete and a full
  ledger scan happens only on a genuine cache miss (6h idle, or a lost chunk, both of which
  degrade to the correct slow path). Zero double-post risk. **RESOLVES F3.**

## C5. Service worker — DROPPED
The draft proposed cache-first navigations. `docs/sw.js:56-62` documents that this was already
tried and deliberately reverted: it pinned an install to whatever `index.html` it had stored, so a
broken build stayed broken on the device with no escape but a manual hard refresh, which yard staff
will not do. It is also the mechanism `CLAUDE.md`'s deploy workflow depends on. The payoff was
illusory anyway — the app already paints from cache before the network (`docs/index.html:1750-1753`).
**Replaced with:** finish the half-built update path. `docs/sw.js:39-41` receives `SKIP_WAITING`
and **nothing ever posts to it**. Wire an "Update available — tap to reload" prompt.
- **RESOLVES F8.**

---

# Test / tooling work (the draft called this "vague")

| Item | What must change |
|---|---|
| `test/deltas.fixtures.json` | Each fixture's expectation becomes an ARRAY of `{facility,dTotal,dDamaged}` (existing 15 become 1-element arrays). Add TRANSFER + VOID-of-TRANSFER cases. |
| `test/deltas.test.mjs` | Assertions restructured for the list shape (`:33-39`); the drift detector (`:41-76`) still parses `var cases = [` out of `gas/Setup.js` by literal string match — that form MUST be preserved. `projectBalances` tests (`:126-180`) re-keyed to `facility|sku`. |
| `test/deltas.test.mjs` — NEW | The two-key TRANSFER fold is exactly what the drift test does NOT cover (it only compares `deltasFor` case lists). Add explicit two-key fold + projection tests. |
| `gas/Setup.js:224-241` | `cases` array gains the new shape + TRANSFER cases, keeping the `var cases = [` literal form. |
| `gas/Setup.js:255-275` | Scenario folds pass `sku:'X'` with no facility and read `folded['X']` — becomes `undefined` and throws under a composite key. Re-key. |
| `gas/Setup.js:50-56` | `textCols` derived from `H_X.indexOf(...)`, not hardcoded. |
| `gas/Setup.js:118` | `diag_` `expected` gains `Facilities`. |
| `gas/Setup.js:162-164` | `purgeTestData_` column indexes derived from headers; add `Facilities` branch + `TEST_FACILITY_PREFIX = 'ZZTEST-'` so smoke-test facilities don't accumulate in yard staff's picker forever. |
| `scripts/smoke.mjs` | 8 `submitTxnBatch` sites (`:91,102,114,127,137,151,170`) all omit facility and will fail. Create a test facility first, thread it through `txn()`, clean it up. `balance()` (`:63-67`) does `rows.find(b => b.sku === SKU)` — must match on facility too or it silently picks the first match and masks a wrong-facility bug. `ledgerCount` (`:69-72`) needs a facility param. |
| `scripts/verify-numeric-sku.mjs`, `verify-mobile.mjs`, `verify-flows.mjs`, `shoot.mjs` | UNREAD — must be read before building. `verify:sku` exists specifically for the numeric-SKU gotcha and plausibly inspects raw Sheet columns by index. |
| `package.json:11` | `deploy` runs `clasp create-deployment`, minting a NEW deployment — directly violates CLAUDE.md's hard rule and would change `/exec` and break every installed phone. Replace with `clasp update-deployment` into the existing id. Freebie fix. |
| `docs/lib/idb.js:12` | Consider `DB_VERSION` 2. Note a version bump alone clears nothing — the schema-1 outbox drain (A7) is the actual mechanism. |

# Build order (dependencies are real)
1. **C1** — the reverting-stock bug. Shippable alone, immediate user-visible win.
2. **C2** — memoisation + debounce. PREREQUISITE for Part A's larger payload.
3. **C3, C4** — blocking calls and server round trips.
4. **C5** — the update prompt. Plus the `package.json` deploy fix.
5. **Part B** — vehicle number (rides along with A2's header change; do it in the same pass).
6. **Part A** — facilities, transfers, migration. Largest, and the only part needing the wipe.

Steps 1–4 touch no data model and need no wipe. Step 6 is a one-way door.

# Effort
Solo ~3.75 sessions · with an agent team ~2 sessions (~2–3 hours real time).

# Hard rules that constrain every step (CLAUDE.md)
No build step, no npm runtime deps. POST `text/plain` only, idem key in the BODY. `npm run push`
never bare `clasp push`. Never mint a deployment. Never cache `/exec`. Never assert on HTTP status.
Bump `CACHE` in `docs/sw.js` on every `docs/` change. `deltasFor` is ONE contract in THREE places:
`gas/Balance.js`, `docs/lib/deltas.js`, and the `cases` list in `gas/Setup.js`.

---

# ADDENDUM — the four previously-unread scripts (gap now closed)

| Script | Runs against | Impact of Part A |
|---|---|---|
| `verify-numeric-sku.mjs` | LIVE /exec | BREAKS. `txn()` sends no facility; `balance()` finds by bare `sku`. Needs a test facility + facility threading, same as smoke.mjs. It is the guard for the `0.5`/`0.50` collapse, so it must be working BEFORE the header reorder lands. |
| `smoke.mjs` | LIVE /exec | BREAKS (8 sites). Already specified above. |
| `shoot.mjs` | LIVE GitHub Pages URL | BREAKS SILENTLY. Seeds fake balances into browser storage in bare-sku shape (`scripts/shoot.mjs:109-113`) and clicks `#balList [data-sku]` (`:185-186`). Seed data needs `facility`, or screenshots render an empty balance list and nobody notices. |
| `verify-flows.mjs` | LIVE GitHub Pages URL | Shape-agnostic (drives taps, not data). Needs NEW coverage for the facility picker on Receive/Issue and the All-vs-facility chip behaviour. |
| `verify-mobile.mjs` | LIVE GitHub Pages URL | Shape-agnostic, and USEFUL here: it asserts every tap target >=44px and every input font >=16px. The new facility chip row and picker must pass it. |

**Build-order consequence:** `verify-flows`, `verify-mobile` and `shoot` all test the DEPLOYED
GitHub Pages URL, not a local server. They can only run AFTER a push. So each `docs/` step needs:
bump `CACHE` -> `npm run gate` -> commit -> push -> then run those three. Do not treat them as
pre-commit checks.
