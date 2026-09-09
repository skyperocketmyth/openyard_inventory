# Open Yard Inventory — project instructions

Installable, no-login PWA for recording open-yard stock movements, over an Apps
Script backend with a Google Sheet as the database.

## Architecture

```
docs/            the app — GitHub Pages serves this folder (own origin)
  index.html     every screen, one file, no build step
  sw.js          service worker — BUMP `CACHE` on every change to docs/
  lib/*.js       ES modules: deltas, idb, api, outbox, sync
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
- **Do not assert on HTTP status.** Apps Script serves its own error pages at
  200. Assert on the response body.

## Commands

```
npm test                  # 17 unit tests: delta contract + adoption gate
npm run gate              # pre-push checks (manifest, doGet/doPost, tests, Sheet id)
npm run push              # gate + clasp push
node scripts/smoke.mjs    # 16 live tests against the deployed web app
python scripts/make-icons.py   # regenerate docs/icon-*.png
```

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
