# Open Yard Inventory

An installable phone app for recording open-yard stock: item list, opening
stock, inbound receipts (with damages), outbound issues, and a live balance per
item showing how much of it is damaged.

**No login.** Works from any network. Works with no signal — entries queue on the
phone and upload when signal returns.

- **App:** https://skyperocketmyth.github.io/openyard_inventory/
- **Data:** a Google Sheet, via a Google Apps Script web app

## How the numbers work

For every item the app shows three figures:

```
    TOTAL  350   =   GOOD  338   +   DAMAGED  12
```

`TOTAL` is everything physically in the yard, damaged units included. `DAMAGED`
is the part of that total which is damaged. `GOOD` is the rest.

- Receiving 100 with 5 damaged adds **100** to the total, 5 of them damaged.
- Marking 12 units damaged moves them from GOOD to DAMAGED and **leaves the
  total unchanged** — the units are still in the yard.
- Issuing stock only ever draws from GOOD.

Nothing is ever edited or deleted. Every action appends one line to a running
log, and every balance is that log added up. A mistake is corrected with a
cancelling entry, so the history always explains the number.

## Install it on a phone

Open the app link, then:

- **Android / Chrome:** menu (⋮) → *Add to Home screen*
- **iPhone / Safari:** Share → *Add to Home Screen*

First time it opens, tap your name from the list. It's remembered on that phone
and stamped on everything you record.

## For developers

See [CLAUDE.md](CLAUDE.md) — architecture, the live IDs, the deploy commands,
and the list of things not to do (each one has already broken something once).

```
npm test                  # unit tests
npm run push              # gated push of the Apps Script backend
node scripts/smoke.mjs    # live end-to-end tests
```
