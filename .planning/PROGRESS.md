# Open Yard Inventory — Active Progress

Last updated: 2026-09-10 (S02 built, on a branch, not merged)
Active wave: Speed, then warehouses

## Overall  ██░░  2/4 sessions

## Phase 0 — Performance & correctness      █  1/1
## Phase 1 — Vehicle no. + facility model   █  1/1
## Phase 2 — Facility UI + transfers        ░  0/1
## Phase 3 — Migration + live verification  ░  0/1

---

## Speed, then warehouses (S01–S04)

**Plan file:** `.planning/PLAN.md`
**READ FIRST:** `.planning/PLAN-CORRECTIONS.md` — it OVERRIDES PLAN.md and carries the
findings of two independent code-reading reviews. PLAN.md alone is NOT safe to build from.
**Primary model:** Opus 1M
**Target:** stock is tracked separately per warehouse, transfers work, Issue records a
vehicle number, and every screen responds without waiting on the network.

### Decisions already locked with Harish (do not re-ask)

1.A separate stock per facility · 2.A transfers required · 3.C wipe existing test data
4.B facilities created from a settings screen, near-duplicate names rejected
5.A every entry screen requires a facility · 6.B no stale pre-fill
7.B vehicle number optional, free text, **Issue screen only**
8.B new `facility` column; leave the existing unused `location` column free
9.A **facility name is immutable — no rename, ever**
10.A "All facilities" view is view-only; a facility chosen on the stock screen carries
     into an action started from there; entering Receive/Issue directly asks fresh
11.A a movement to an inactive facility is ACCEPTED and flagged, never rejected
12.A OPENING blocked only by a prior OPENING at the same (facility, SKU)
13.A wipe performed on the live Sheet, **no backup copy** (Harish declined)
14.A under 10 facilities → no server-side facility filtering needed

### Session checklist

[x] S01  Speed + the reverting-stock bug                  [Opus 1M · plan: NO  · teams: YES — 1 builder + 2 reviewers]
[x] S02  Vehicle number + facility data model & server    [Opus 1M · plan: NO  · teams: YES — Builder×3 + Critic×2 + Fix×2]
[ ] S03  Facility UI + transfers                          [Opus 1M · plan: NO  · teams: YES — Builder×2 + Critic]
[ ] S04  Migration wipe + full live verification          [Opus 1M · plan: NO  · teams: YES — Verifier×2]

---

## S01 — shipped 2026-09-10 (commit `ef29329`)

Ship: a saved entry stays saved, and typing does not lag.

- Fixed the reverting/vanishing stock figure (`enqueue` discarded the flush summary; the
  30s tick was gated on `pendingCount() > 0` so it never ran once the entry was gone).
- Fixed the unreported multi-phone fault: a phone never learned another phone's entries
  without a restart.
- Memoised the balance projection on (outbox version, balances version); debounced the two
  search fields; one memoised read for the sync pill's counts.
- Name save no longer blocks up to 20s. Item save still blocks on its FIRST call
  deliberately — the OPENING entry queued after it would take `UNKNOWN_SKU` if it raced.
- Server: 34 Sheet round trips per save → 12 (25-SKU batch 43 → 11).
- `npm run deploy` no longer mints a new deployment. Pre-push check 7 now compares the
  `CACHE` string against HEAD instead of only noticing sw.js was touched.
- New: `scripts/verify-no-revert.mjs` (`npm run verify:norevert`) and
  `scripts/gas-harness.cjs` (`npm run harness`).

Verified: 17/17 unit · 16/16 live smoke ×3 · 7/7 no-revert · 18/18 layout · 8/8 flows.

**Measured platform limit, relevant to any future "make it faster" ask:** the same
`getBalances` request against the live deployment took 3.9s once and 36.7s another time,
with no relation to the work done. Cold `bootstrap` ≈ 10s. That variance is Google's, not
the code's. The app stays responsive because writes are optimistic and uploaded in the
background — it does not become responsive by making Apps Script fast, and it cannot.

**Known, deliberately NOT fixed:** the sync pill can briefly keep showing "Syncing" after
an upload finishes (it repaints from an async listener nobody awaits). Cosmetic.

**Trap for whoever runs the live tests:** `purgeTestData` deletes the user named
"Smoke Test", so `verify:norevert` and `smoke` must NOT run at the same time — doing so
makes smoke fail with `NO_USER` and looks exactly like a server regression. It cost a
session's worth of false alarm.

---

## S02 — "Vehicle number + facility data model & server"

Model: Opus 1M · Plan mode: NO · Agent teams: YES — Builder×2 (server / tooling) + Verifier
Ship: `npm run harness` diffs clean against an S01 baseline apart from call counts, and the
composite-key server logic is unit-tested — with NOTHING deployed and NO data wiped.

Bundle:
- `Facilities` tab + `facilities_epoch` + `getFacilities` + `upsertFacility_` with the
  near-duplicate guard and the immutable-key rule (PLAN A1, X3).
- New `H_LEDGER` / `H_SNAP` shape, and **re-index every positional read** — PLAN A2 lists
  them, and X1 lists the two `deltasFor_` callers PLAN A2 MISSED. X1 is the top risk in the
  whole job: one of them is the guard that stops stock going negative, and it fails silently.
- `deltasFor` returns a LIST of keyed deltas (PLAN A4) with the input contract from X2b.
  Same change in BOTH `gas/Balance.js` and `docs/lib/deltas.js`, plus the `var cases = [`
  literal in `gas/Setup.js` — `npm test` parses that literal by string match.
- Composite key everywhere in PLAN A3 **plus** the six callers X1 adds. Carry `{facility,
  sku}` on the map value; never split a key (X3).
- `opening_done` with all four fixes from X5.
- Vehicle number end to end (PLAN Part B).
- Derive every column index from `H_X.indexOf(...)` — X8 / PLAN A2 hardening. Miss this and
  the numeric-SKU corruption fixed in `4856d64` comes straight back.
- Fixture format + `runTests` + `purgeTestData_` + `diag_` rework (PLAN test table).
- Add the `validateTxn_` unit test it has never had (X1).

DO NOT in S02: deploy, wipe, or touch `migrateToV2`.

---

## S02 — built 2026-09-10 on branch `feat/s02-facilities-server` (NOT merged, NOT deployed)

Ship: the harness diffs clean against the S01 baseline, the composite-key server logic is
unit-tested, nothing deployed, no data wiped.

**Why it is on a branch.** GitHub Pages serves `docs/` off `main`. S02 changes the client data
layer but S03 owns the warehouse picker, so a merge to `main` today would put a client on
Harish's phone that shows zero stock and cannot record anything. Nothing merges until S03 and
S04 are done.

Built: `Facilities` tab + `facilities_epoch` + `getFacilities` + `upsertFacility_` (immutable
key, near-duplicate fold, no rename, no delete) · `H_LEDGER` 17→20 and `H_SNAP` 6→8 with EVERY
positional read re-derived from the header · `deltasFor` returning a list of per-facility
deltas in all three copies · composite `FACILITY|SKU` key throughout · `opening_done` with all
four X5 fixes · TRANSFER server-side · vehicle number end to end.

Verified: 71/71 unit (was 17) · harness 45 scenarios, exit 0 · 200,000-case differential fuzz
between the server and client copies of `deltasFor`, zero divergence · `grep` for magic column
indexes and for key-splitting both empty. The harness diff against the S01 baseline shows NO
change to any quantity, status, error code, retryable flag or epoch.

### Found by review, fixed here — none of these were in PLAN.md

- **No schema gate.** The columns moved, but nothing stopped this code running against the
  un-migrated Sheet: `facility` would read the old `sku`, and a 20-cell append SUCCEEDS into a
  17-column tab because a Sheets grid is 26 wide. Silent two-shape corruption of an append-only
  ledger. Now `assertSchema_` checks both `schema_version >= 2` AND the live header row by name,
  and refuses **retryably** so phones hold their entries instead of filing them as failures.
  Gated at the route AND inside each write function — the harness and the Apps Script editor
  call those directly, bypassing `route_`.
- **`VOID` was an accepted batch type with no validation.** `/exec` is `ANYONE_ANONYMOUS`, so a
  hand-written POST could delete a unit of stock and clear `opening_done` — re-opening the very
  guard S02 built. `VOID` is out of `TYPES_ALL`; cancellations go through `voidTxn_`, which has
  the real checks. This also closed a VOID-of-TRANSFER path that skipped every destination check
  and could invent stock at one yard while destroying it at another.
- **The batch echoed the caller's `void_of_txn_id` into the row.** `voidTxn_` decides
  ALREADY_VOIDED by scanning that column, so a crafted entry naming a real txn id would
  permanently block that entry from ever being cancelled. Now always written blank.
- **Twin-file drift, in the function whose whole purpose is not to drift.** Server `foldDeltas_`
  used `normSku_`; client used `String(t.sku || '')`. A SKU of `0` made a row on the server and
  was DROPPED on the client. This project has live numeric SKUs. Same bug in `mergeBalances`,
  `projectedFor`, `itemBySku` and `facilityByName`.
- **The client balance cache was not versioned** while the server's was. A stale S01 row has no
  facility, `balKey(undefined,'X')` is `'|X'`, and `uiFacility` is `''` — so the app would have
  shown last week's number as this yard's current stock, confidently. Cache key is now
  `balances_v2`.
- `active: null` silently deactivated a yard (and an item) — the `e6b8cd8` reactivation bug in
  reverse. `upsertFacility_`'s charset was widened: it rejected `JEBEL ALI (SOUTH)` and
  `DP WORLD, JAFZA`, having inherited a restriction that only ever belonged to a Node test
  harness — on a field decision 9.A says can NEVER be renamed. `|` is still rejected.
- Item picker read whichever yard sorted first, so it would show 350 at a yard holding 0.

### New guard rails

- `test/ledger-roundtrip.test.mjs` — appends a row and reads it back through `getLedgerRead_`
  and `snapshotMap_`, asserting every field. Two 20-slot positional literals had NO coverage;
  a future slot swap now fails loudly instead of returning a neighbouring cell.
- `test/validate.test.mjs` — `validateTxn_` had never had a single test, and it holds the guard
  that stops stock going negative. Its X1 canaries are built to FAIL if the per-entry loop is
  removed.
- Pre-push check 10 — refuses a push while the server requires a warehouse and the app cannot
  supply one. Self-clearing: it goes quiet the moment S03 assigns to `uiFacility`. Deliberate
  blocks now print as **WAIT** (unfinished) rather than **FAIL** (broken), so a real fault
  cannot hide behind an expected one.

### Carry into S03

- `uiFacility` in `docs/index.html` is the single seam: declared at ~`:547`, threaded through
  nine `projectedFor` call sites. Wiring the picker to set it clears pre-push check 10.
- `docs/index.html` still renders the stock list keyed on SKU alone, so two yards holding one
  item show as duplicate unlabelled rows. Marked `// S03:` in place, along with `loadMoves`.
- `blocked` in `docs/lib/outbox.js` is still unpopulated (X10), as planned.

### Carry into S04 — read this before writing `migrateToV2`

- `migrateToV2` must set `schema_version = 2` **after** widening the headers. The gate checks
  the header row as well as the number, so setting the number first just locks you out.
- `rebuildSnapshot_` derives `opening_done` **solely** from OPENING rows in the ledger. If
  `migrateToV2` sets the flag without synthesising matching OPENING rows, one
  `action=rebuildSnapshot` — which is routed unauthenticated — silently re-opens every one.
- Warehouse names are permanent. There is no rename, ever (9.A).

---

## S03 — "Facility UI + transfers"

Model: Opus 1M · Plan mode: NO · Agent teams: YES — Builder×2 (screens / transfers) + Critic
Ship: the app runs against a locally served `docs/` with a facility picker on every entry
screen, working transfers, and 18/18 layout + 8/8 flows still green.

Bundle:
- Facility picker (reuse `openPicker`) on Receive, Issue, Damage, Transfer, and the Opening
  block. Required, no pre-fill (6.B).
- Stock screen facility chips; "All" view-only with a per-facility breakdown in the detail
  sheet; **every action gated on the SELECTED facility's `good`, never the aggregate** (X's
  F10 sites are listed in PLAN A6).
- "Move stock" on the item-detail sheet beside "Record damage". Not a fifth tab.
- "Manage warehouses" in the account sheet.
- Populate the `blocked` set in `docs/lib/outbox.js` — X10: the per-SKU ordering protection
  its own comment describes has never actually been wired up. Key on (facility, sku), both
  keys for a transfer.
- Rejection message wording from X13.
- Bump `CACHE` in `docs/sw.js`. Run the layout checker — it enforces 44px targets and 16px
  inputs, which the new chip row and picker must pass.

---

## S04 — "Migration wipe + full live verification"

Model: Opus 1M · Plan mode: NO · Agent teams: YES — Verifier×2 (server / device)
Ship: warehouses live on Harish's phone, with real opening stock entered per warehouse.

Bundle:
- `migrateToV2()` — **NOT routed in `route_`** (PLAN A7: `action=setup` is an unauthenticated
  GET on an `ANYONE_ANONYMOUS` deployment, so a destructive setup would be a public wipe
  button). Must bump BOTH epochs and re-apply the text column formats (X8).
- 🔴 **PAUSE AND CONFIRM WITH HARISH IMMEDIATELY BEFORE THE WIPE.** It is irreversible and
  he declined a backup (13.A).
- Client schema-version handling + draining schema-1 outbox entries to `failures` with
  Discard-only (PLAN A7).
- Rework `smoke.mjs` (7 `submitTxnBatch` sites), `verify-numeric-sku.mjs`, and `shoot.mjs`
  seed data for facilities.
- **Capture a live baseline BEFORE deploying** — S01 skipped this and burned a session
  chasing platform flakiness that looked like a regression.
- Deploy: `npm run push` then `clasp update-deployment ... AKfycby_s3R6...` into the
  EXISTING id. Never mint a new one.
- Then Harish enters opening stock per warehouse.
