# Open Yard Inventory — Active Progress

Last updated: 2026-09-10 (S01 shipped)
Active wave: Speed, then warehouses

## Overall  █░░░  1/4 sessions

## Phase 0 — Performance & correctness      █  1/1
## Phase 1 — Vehicle no. + facility model   ░  0/1
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
[ ] S02  Vehicle number + facility data model & server    [Opus 1M · plan: NO  · teams: YES — Builder×2 + Verifier]
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
