# CORRECTIONS FROM REVIEW 2 — READ THIS BEFORE SPEC-v2.md. IT OVERRIDES SPEC-v2.

Verdict: APPROVED WITH CHANGES. All of the following are MANDATORY and each overrides the
corresponding statement in SPEC-v2.md. Build order is X9.

## X1. TOP RISK — two `deltasFor_` callers were missing from SPEC-v2's A2/A3/A4 lists (VERIFIED)
Changing `deltasFor` to return an ARRAY breaks these, silently:
- `gas/Ledger.js:114-120` — `var d = deltasFor_({...}); w.total += d.dTotal;`
  With an array, `d.dTotal` is `undefined` -> `w.total` becomes `NaN` -> `deltaMap` `NaN` ->
  `applySnapshotDeltas_` writes **NaN into Balance_Snapshot** (`gas/Balance.js:141-145`).
  Every later balance for that key is poisoned until a rebuild.
- `gas/Ledger.js:283-297` — the trailing post-state reconciliation the file itself calls
  "deliberately redundant... compute the end state and assert on it".
  `pTotal = total + undefined` -> `NaN`; `NaN < 0` is false and `pDamaged > pTotal` is false, so
  **`WOULD_GO_NEGATIVE` returns null for everything.** The last line of defence against negative
  stock goes inert with no error. Nothing in `test/` or `gas/Setup.js:runTests` exercises
  `validateTxn_` at all.
- Also missing: `voidTxn_` `:518-524`, `:542-543`; the duplicate-replay path `:96-102`;
  `docs/lib/outbox.js:159-171` (the txns mapper — Part A never mentioned it, so
  `facility`/`toFacility`/`vehicleNo` would never reach the server); `docs/index.html:520`
  (imports `deltasFor`, currently unused — a trap after the shape change).

**Both call sites must iterate the list, and the post-state assertion must run PER ENTRY.**
Add a `validateTxn_` unit test in the same change — it currently has zero coverage.

## X2. A4 — four gaps, all mandatory
- **X2a `voidTxn_` is a logic change, not re-indexing.** SPEC-v2 A4's "needs no change beyond
  re-indexing / RESOLVES F4 entirely" is WRONG. `gas/Ledger.js:518-529` computes the post-void
  state for ONE key; `:542-544` builds a single-key `deltaMap`; `:549` marks one key. Voiding a
  transfer whose stock has since been issued at the DESTINATION must be refused — with a
  single-key check the destination is never examined and the void drives it negative. Required:
  (a) copy `facility` AND `to_facility` into the VOID row (`:534-540`); (b) evaluate the post-state
  per entry of the negated list and refuse if ANY entry goes negative; (c) multi-key `deltaMap`;
  (d) `balancesForTouched_` for every key.
- **X2b `deltasFor`'s INPUT contract changes too.** The VOID case recurses with
  `{type: t.voidOfType, qty, damagedQty, condition}` (`gas/Balance.js:61-66`,
  `docs/lib/deltas.js:55-60`). It must ALSO pass `facility` and `toFacility`, or the recursion
  returns entries keyed `undefined`. SPEC-v2 documented only the output shape.
- **X2c the transfer destination must be advanced in the working balance.** SPEC-v2 A4 specified
  only "source `good >= qty`". `workingFor_` exists so later txns in a batch validate against what
  their predecessors created (`gas/Ledger.js:112-113`). Offline TRANSFER A->B then OUTBOUND at B
  — the normal yard sequence, one phone, one batch — takes a NON-RETRYABLE
  `INSUFFICIENT_GOOD_STOCK` (`:251-256`) and lands in `failures`. Every entry of the list must be
  applied to `working`, `deltaMap` and `touched`.
- **X2d the duplicate-replay path must mark BOTH keys.** `gas/Ledger.js:96-102` marks the source
  only. A replayed TRANSFER returns no destination balance, the phone deletes the outbox entry
  (`docs/lib/outbox.js:205-210`), and the destination figure REVERTS — the C1 symptom re-created
  inside the C1 fix. The payload carries both facilities; one line, but it must be written.

## X3. The `|` separator is unsafe — carry the pair, do not parse the key
SKUs cannot contain `|` (`gas/Ledger.js:360`) but **facility names are unconstrained free text**.
A facility named `Yard A | North` corrupts every key split, including `balancesForTouched_`
(`gas/Ledger.js:331-345`). Do BOTH: (a) store `{facility, sku}` on the map VALUE so no code ever
splits a key, and (b) reject `|` in `upsertFacility_`.

## X4. DROP the chunked idem-key cache (SPEC-v2 C4). Keep `ledgerIdemKeys_` as a plain full read.
Missing keys degrade safely (full scan). **Extra keys are catastrophic:** an `idem_key` in the map
with no ledger row makes the server answer `duplicate`, and the client then DELETES the entry
without it ever being written (`docs/lib/outbox.js:205-210`) — a real physical movement lost
silently, the exact failure `gas/Ledger.js:29-37` was hardened against. Three other callers bump
`ledger_epoch` without adding keys (`voidTxn_:545`, `rebuildSnapshot_:197`,
`purgeTestData_:182-183`), so any of them re-putting the map gives a double-posted VOID.
`ledgerIdemKeys_` is ALREADY a single two-column `getValues` (`gas/Ledger.js:318`) — one of ~25
calls, worth a fraction of a second for years at yard scale. Not worth the only new
silent-data-loss vector in Part C. C4 still reaches ~8-9 trips via `metaAll_`, `snapshotMap_`,
`ss_`/`tab_` and the `applySnapshotDeltas_` batch write.

## X5. KEEP `opening_done`, but all four fixes are mandatory (deliberate disagreement with the reviewer)
The reviewer recommended dropping the column, on the grounds that OPENING and INBOUND have
identical deltas so the guard is UX not integrity. Rejected: 12.A asked for the guard RE-KEYED,
not removed, and opening stock is the one entry type where an operator types a large absolute
number from a physical count during a multi-yard setup — a likely, expensive error. The four
fixes are cheap and local:
1. **In-batch:** SPEC-v2 A5 deletes the `(total !== 0 || damaged !== 0)` clause that currently
   catches a second OPENING in the same batch via the WORKING balance
   (`gas/Ledger.js:215-218, 234`). `openingDone` must be tracked in `working` too, or two OPENINGs
   in one batch both commit.
2. **VOID:** voiding an OPENING must CLEAR the flag, or that (facility, SKU) can never have an
   opening again and the error message is a lie.
3. **`rebuildSnapshot_`:** the flag is not derivable from `foldDeltas_` (it is not a delta), so as
   specified a rebuild BLANKS it — and `rebuildSnapshot` is routed unauthenticated
   (`gas/Code.js:135`). It IS derivable from the ledger rows `rebuildSnapshot_` already holds in
   memory: second pass, `type==='OPENING'` minus VOIDs with `voidOfType==='OPENING'`. Free.
4. **`applySnapshotDeltas_`** rewrites the full row positionally (`gas/Balance.js:144-145`) — it
   must carry the existing `openingDone` forward or every ordinary receipt wipes it.

## X6. C1 — use option 1 only. The `onChange` alternative does NOT work.
`emit()` calls listeners synchronously, with no arguments, inside a synchronous try/catch
(`docs/lib/outbox.js:48-52`), so an async merging listener's rejection escapes unhandled; it fires
5+ times per flush (`:130, :152, :230, :246`), so each would trigger a `mergeBalances` +
`persist()` IndexedDB write; and the only registered listener repaints the sync pill only
(`docs/index.html:1702`) — the balance list would still not repaint.
**Do:** `enqueue` returns the flush promise, and the submit handler MUST NOT await it —
`.then(s => mergeBalances(s.balances)).then(render)`. Awaiting it reintroduces the blocking round
trip `docs/lib/outbox.js:1-7` exists to forbid.

## X7. C2's memo key needs a BALANCES version, not just an outbox version
`projected()` is `state.balances` PLUS the outbox (`docs/lib/sync.js:199-202`). `state.balances`
changes in `mergeBalances`/`refreshBalances`/`bootstrap` — none of which call `emit()`. An
outbox-only memo key goes stale exactly when a sync lands, i.e. **it re-creates the C1
stale-figure bug one step after C1 fixes it.** Bump a balances version wherever `state.balances`
is assigned.

## X8. `migrateToV2` MUST re-apply the plain-text column formats
`sku` moves from Ledger col 4 -> 6 and Snapshot col 1 -> 2. The `'@'` format is applied only by
`ensureTabs_:58-64`, which `migrateToV2` does not run. Without it the new `sku` column is
General-formatted and the numeric-SKU corruption fixed in commit `4856d64` returns on the first
`0.50` code. Re-apply the derived `textCols`, or call `ensureTabs_` last.

## X9. REVISED BUILD ORDER — C4's `metaAll_` memoisation goes BEFORE C1 step 2
A no-op `getBalances` poll costs FOUR full Meta-tab reads today: `getBalancesRead_` -> `metaGet_`
-> `metaAll_` -> `rows_` -> `ss_()` (`gas/Code.js:288`) plus three inside `metaBlock_` (`:74-76`).
The "~40 bytes" figure is wire size, not cost. Making the poll unconditional on every phone
multiplies four `openById` + four `getValues` by phones x 120/hour against one script lock.

Order:
1. C1 step 1 — `enqueue` returns the flush promise; submit handlers merge + repaint (X6).
2. C4 part 1 — memoise `ss_`, `tab_`, `metaAll_`, `readUsers_`.
3. C1 step 2 — unconditional `refreshBalances` in the poll, at **60s**, foreground only.
4. C2 — memoisation (with X7) + debounce. PREREQUISITE for Part A.
5. C3 — non-blocking name save; single round trip on item save.
6. C4 part 2 — `snapshotMap_` once; `applySnapshotDeltas_` single batch write.
7. C5 — the SKIP_WAITING update prompt. Plus the `package.json` deploy fix and X11.
8. Part B — vehicle number (rides along with A2's header change; same pass).
9. Part A — facilities, transfers, `migrateToV2`. The only one-way door.

## X10. Pre-existing bug found, unrelated to this work (VERIFIED)
`docs/lib/outbox.js:18-21` documents per-SKU head-of-line blocking as load-bearing. **It does not
exist.** `blocked` is declared at `:140` and checked at `:144` and **never populated.** One bad
entry does not hold back later entries for the same SKU, so a receive-then-issue pair can be
applied out of order. Transfers make this worse (cross-facility ordering). Fix in Part A: populate
`blocked`, keyed on `(facility, sku)`, and on BOTH keys for a transfer.

## X11. Gate check 7 is weaker than claimed
`scripts/prepush-gate.mjs:102-117` only checks that `docs/sw.js` APPEARS in the diff — not that
`CACHE` changed. Touching a comment in `sw.js` passes. Cheap fix: assert the `CACHE = 'oy-...-vN'`
string actually differs from HEAD's.

## X12. Citation and count fixes
- `normSku_` is `gas/Code.js:216`, not `:169-171` (SPEC-v2 A1 was wrong).
- `setCacheChunked_` is `gas/Code.js:225`, not `:212-227` (SPEC-v2 C4 was wrong).
- `scripts/smoke.mjs` has **7** `submitTxnBatch` sites, not 8. The listed line numbers are correct.
- Inactive-facility handling (11.A) was specified for the DESTINATION only. An entry sitting in
  the outbox when its SOURCE facility is deactivated has an inactive `facility`, not
  `to_facility` — same rule: accept and flag.
- `voidTxn_` performs no facility validation at all, so a void involving an inactive facility will
  not be flagged. Accepted and documented, not fixed.
- Keep fixture facility names free of `(` — the drift detector refuses a `cases` literal
  containing `word(` (`test/deltas.test.mjs:44, 61-62`).

## X13. Residual risk — STATE IT IN THE UI, do not silently accept
The fold is commutative; **validation is not.** An offline TRANSFER A->B arriving after another
phone has already issued that stock from B takes a hard rejection at B. Today this only happens if
someone issues before a receipt uploads; transfers make it routine, because the destination
legitimately holds physical stock the server believes is zero. The rejection message must say so:
"the transfer for this item may not have uploaded yet — check pending uploads."
