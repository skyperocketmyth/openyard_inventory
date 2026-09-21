# Open Yard Inventory — project instructions

Installable, no-login PWA for recording open-yard stock movements, over an Apps
Script backend with a Google Sheet as the database.

## Architecture

```
docs/            the app — GitHub Pages serves this folder (own origin)
  index.html     every screen, one file, no build step
                 (Balance · Receive · Issue · Activity · Items)
  sw.js          service worker — BUMP `CACHE` on every change to docs/
  lib/*.js       ES modules: deltas, dates, idb, api, outbox, sync
        |
        |  fetch(), Content-Type: text/plain
        v
gas/             Apps Script web app (access: ANYONE_ANONYMOUS)
  Code.js        doGet/doPost router + reads
  Ledger.js      writes, under lock + idempotency
  Balance.js     the delta contract + snapshot maintenance
  Setup.js       ensureTabs, diag, runTests
        |
        v
Google Sheet     Items · Ledger · Users · Meta · Balance_Snapshot · Rejections
```

## Live IDs

| Thing | Value |
|---|---|
| Sheet | `1eoS12tnEJ1YEjF3_89rxFjI9fu6b0yU-Cy9wVqB5RNo` |
| Apps Script (bound to that Sheet) | `1fL1478vhQ6XIqE8-xRqRM1kAY0go6B9fJiIEfX-EoiSeiD73KjHCVyG2` |
| Deployment id (**reuse this — never mint a new one**) | `AKfycby_s3R6Kn2YaLNFM4CmuP9QZCTNiqcdBOonFrigrAdOFhV4XNHrMIRWlApTtzS2fMYn` |
| `/exec` URL | see `.exec_url`, and `SCRIPT_URL` in `docs/index.html` |
| App URL | https://skyperocketmyth.github.io/openyard_inventory/ |

## The data model

`Ledger` is append-only and is the only source of truth. Every balance is a fold
over it. `Balance_Snapshot` is a derived cache maintained inside the write lock
and rebuildable at any time via `action=rebuildSnapshot`.

**The damage model:** `TOTAL` is everything physically in the yard, damaged
included. `DAMAGED` is the subset of `TOTAL` that is damaged. `GOOD = TOTAL −
DAMAGED`, never stored. So recording damage moves units GOOD → DAMAGED and
leaves TOTAL alone. Issuing only ever draws from GOOD.

Every ledger row is a **commutative delta** — nothing is an absolute "set to X".
That is what lets an offline entry recorded at 08:00 and arriving at 17:00 land
on the right total. `OPENING` is enforced once-per-SKU for the same reason.

## Do NOT

- **Do not add a build step or npm runtime dependencies.** `docs/` is served as-is.
- **Do not `clasp push` without the gate.** Use `npm run push`. `clasp push`
  fully replaces the remote `appsscript.json`; a manifest missing its `webapp`
  block silently republishes this project as a *library* and `/exec` then serves
  Drive's error page — at HTTP 200. This project arrived with exactly that block
  missing. `scripts/prepush-gate.mjs` now blocks it.
- **Do not mint a new deployment.** Redeploy into the existing id:
  `clasp update-deployment --description "..." <id>`. A new deployment changes
  the `/exec` URL and breaks `SCRIPT_URL` in the shipped app.
- **Do not send `Content-Type: application/json`.** Apps Script cannot answer a
  CORS preflight. Writes use `text/plain` and the idempotency key travels in the
  body, never a header.
- **Do not cache the API in `sw.js`.** `/exec` 302s to googleusercontent.com; a
  cached response there breaks every call and looks like a server outage.
- **Do not iframe the `/exec` URL.** `script.google.com` sends
  `X-Frame-Options: sameorigin`. Nothing here does this — keep it that way.
- **Do not edit `deltasFor` in one place only.** It is one contract in two files:
  `gas/Balance.js` and `docs/lib/deltas.js`, plus the case list inside
  `gas/Setup.js:runTests`. `npm test` fails if the server list drifts from
  `test/deltas.fixtures.json`.
- **Do not let a read adopt server balances while writes are pending.** Go
  through `canAdoptServerSnapshot` in `docs/lib/sync.js`.
- **Do not gate an action on stock summed across warehouses.** Every quantity
  limit, enable check and prefill reads the SELECTED warehouse's `good`. The
  "All warehouses" stock view is view-only and offers no action buttons at all,
  which is what makes this structural rather than a check to remember. See
  `uiFacility` in `docs/index.html` and PLAN finding F10.
- **Do not format a date anywhere but `docs/lib/dates.js`.** Every timestamp
  the app shows goes through `when()`, which is now a one-line delegate to
  `fmtDubai`, and every column that holds one in the Sheet carries
  `dd-mm-yyyy hh:mm:ss` applied by `ensureTabs_`. Both are pinned to
  `Asia/Dubai`, never to the device or to the script's own locale — a handset on
  the wrong timezone otherwise relabels which DAY a movement belongs to, which
  does not throw and does not look wrong.
- **Do not assume a Sheets number format will render an ISO string.** It only
  renders a real Date, which is why `client_ts` and `last_txn_ts` are written
  through `sheetTs_`. Their in-memory forms stay ISO STRINGS, because
  `lastTxnTs` is compared with a lexicographic `>` in three places
  (`gas/Ledger.js`, `gas/Balance.js` twice) that depend on ISO text ordering.
  `snapshotMap_` converts back on read, so the round trip is safe — keep it
  that way.
- **Do not filter the Activity window on `server_ts`.** The window is compared
  against `client_ts`, when the movement HAPPENED. An entry recorded at 23:00
  and uploaded at 08:00 belongs to yesterday; filtering on arrival silently
  moves it into today and the yard's day totals stop matching the paperwork.
  `server_ts` is used only to decide where `ledgerRowsSince_` may stop reading,
  which is safe because append order is `server_ts` order and
  `client_ts <= server_ts`.
- **Do not send a correction's cancellation before the replacement is saved.**
  `askCorrect` only prefills the form; `commitCorrection`, called from the
  Receive/Issue submit handlers, is what sends the `voidTxn` — and it returns
  false, stopping the save, when the server refuses. Voiding up front is the
  obvious design and it shrinks the yard every time someone opens a correction
  and changes their mind. `ui.correcting` is cleared by `show()` so abandoning
  is the default; the one dangerous consequence is a stale `ui.correcting`
  attaching itself to the NEXT unrelated entry, which is what
  `verify-activity.mjs` checks by recording a plain entry afterwards.
- **Do not gate an Issue correction on `projectedFor` alone.** The pending
  cancellation is about to hand the original quantity back, so
  `correctionAllowance` adds it — in `paintIssue` AND in the submit handler,
  which must agree. It returns 0 unless the form still names the same
  warehouse and item the original did, because the stock returns to where the
  original was recorded, not to wherever the form now points.
- **Do not put cancelling into the outbox without re-reading its invariants.**
  `flush()` speaks only `submitTxnBatch`. Cancelling is online-only on
  purpose; `docs/lib/deltas.js` already carries the `VOID` case and
  `entryKeys` would key it correctly off the original's facility/sku, so the
  change is small — but it lands in the head-of-line ordering that guards
  every balance in the yard.
- **Do not open a sheet from inside a sheet and expect to come back.** There is
  one sheet; `openSheet` replaces its contents. A form that needs a sub-choice
  uses inline chips, or re-opens itself from the callback. And never
  `closeSheet()` immediately followed by `openSheet()` — close runs
  `history.back()`, open pushes a state, and the two race.
- **Do not assert on HTTP status.** Apps Script serves its own error pages at
  200. Assert on the response body.
- **Do not route `migrateToV2`.** It clears `Ledger`, `Balance_Snapshot` and
  `Rejections`. `action=setup` is an unauthenticated GET on an
  `ANYONE_ANONYMOUS` deployment, so a routed destructive action is a public
  wipe button for the whole yard. It is run by hand from the Apps Script
  editor, once. It refuses to run a second time (the book is already v2 by
  then, and holds real opening stock typed from a physical count).

## Commands

```
npm test                  # 97 unit tests: delta contract, adoption gate, validateTxn_,
                          #   ledger round trip, outbox head-of-line ordering + the
                          #   pre-warehouse drain. The gate READS this file list out of
                          #   package.json — adding a test file here is enough.
npm run gate              # pre-push checks (manifest, doGet/doPost, tests, Sheet id, CACHE)
npm run push              # gate + clasp push
npm run harness           # 45 server scenarios against a fake Sheet — no network, no deploy
node scripts/smoke.mjs    # 16 live tests against the deployed web app
python scripts/make-icons.py   # regenerate docs/icon-*.png
```

Browser checks. They all take the URL as `argv[2]` and otherwise default to the LIVE
GitHub Pages site — so **serve `docs/` and pass the local URL**, or you are testing a build
you have already pushed to Harish's phone:

```
npm run serve             # docs/ on http://127.0.0.1:8787/  (leave running)
node scripts/verify-mobile.mjs     http://127.0.0.1:8787/   # 18 layout checks
node scripts/verify-flows.mjs      http://127.0.0.1:8787/   # 8 interaction checks
node scripts/verify-facilities.mjs http://127.0.0.1:8787/   # 34 warehouse-UI checks
node scripts/verify-activity.mjs   http://127.0.0.1:8787/   # 63 Activity/cancel/correct/window checks
```

```
npm run mutate            # breaks load-bearing lines on purpose and checks the
                          #   browser suites actually go red. Cases live in
                          #   scripts/mutations.mjs. Do NOT pipe it — the pipe
                          #   eats the exit code and survivors look like a pass.
npm run mutate -- --list  # what it would test, running nothing
```

`verify-facilities` seeds warehouses into the throwaway browser profile (never the Sheet)
and blocks the API, because warehouse data does not exist on any reachable server until S04
migrates it. Its load-bearing check is that an action is gated on the SELECTED warehouse's
good stock and never on the across-warehouse total.

Redeploy after a `gas/` change:
```
npm run push
clasp update-deployment --description "what changed" AKfycby_s3R6Kn2YaLNFM4CmuP9QZCTNiqcdBOonFrigrAdOFhV4XNHrMIRWlApTtzS2fMYn
```

Redeploy after a `docs/` change: bump `CACHE` in `docs/sw.js`, commit, push to
`main`. Then **hard-refresh on the phone** — the old service worker will
otherwise keep serving the previous build.

## Known trade-offs

- `ANYONE_ANONYMOUS` means anyone with the `/exec` URL can write. Accepted
  deliberately: it is what removes the login. Mitigated by the ledger being
  append-only, every row carrying a name, and nothing being deletable — only
  voidable, visibly.
- The Sheet and the Google account are personal, and the repo is public. Against
  `~/.claude/references/ai-governance/checklist.md` this fails items 2, 3, 6 and
  7. Fine for a yard tool; not fine if this becomes an official RSA record. The
  exit path is the `octrl` Postgres + `*.rsa.global` + the `auth.rsaxb.com` SSO
  broker, the route `driverattendance.rsa.global` already took.
- No photo capture in v1 — it would put RSA operational records in a personal
  Drive (checklist item 4). The `Ledger` has no photo column yet; add one plus a
  Drive folder if this is ever wanted.
- Montserrat/Monument are not shipped (licensed desktop fonts, and a yard app
  must not depend on a font round-trip). The app uses the system stack. RSA
  colours are exact.
