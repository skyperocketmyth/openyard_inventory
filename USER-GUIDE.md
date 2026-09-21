# Open Yard Inventory — how to use it

**App:** https://skyperocketmyth.github.io/openyard_inventory/
**Data:** the `Open Yard Inventory` Google Sheet

No password. Works from any network. Works with no signal.

---

## 1. Install it on a phone (once)

Open the link in the phone's browser, then:

| Phone | What to tap |
|---|---|
| Android (Chrome) | menu **⋮** → **Add to Home screen** |
| iPhone (Safari) | **Share** → **Add to Home Screen** |

You get an app icon. From then on it opens like a normal app, with no browser bars.

**First time it opens** it asks *"Who are you?"* — tap your name. That's remembered on
that phone, and every entry you make is stamped with it. To switch, tap your name
chip at the top right → **Change name**.

---

## 2. The five tabs at the bottom

| Tab | What it's for |
|---|---|
| **Balance** | The home screen. What's in the yard right now, per item. |
| **Receive** | Stock arriving. This is where damages on arrival are recorded. |
| **Issue** | Stock going out. |
| **Activity** | Every movement ever recorded, newest first. Fix or cancel a mistake here. |
| **Items** | The item list. Add a new SKU or fix a description. |

---

## 3. The one idea to understand: damaged is *inside* the total

For every item you see three numbers:

```
     TOTAL  350   =   GOOD  338   +   DAMAGED  12
```

- **TOTAL** — everything physically sitting in the yard, damaged pieces included.
- **DAMAGED** — how many of those are damaged.
- **GOOD** — the rest, the ones you can actually send out.

So:

- Receive **100** with **5** damaged → the total goes **up by 100**. Five of them are damaged.
- Mark **12** as damaged later → **the total does not change**. Twelve pieces move from
  GOOD to DAMAGED. They're still in the yard.
- Issuing stock can only take from **GOOD**.

The coloured bar under each item shows this at a glance: green is good, the red bit
at the end is the damaged part of the same pile.

---

## 4. Recording stock coming in

1. Tap **Receive**
2. Tap **Tap to choose item** → pick the item (search if the list is long)
3. Type the **quantity received** — the big `+` `−` buttons and the `+1 +5 +10 +25`
   chips are there so you don't have to use the keyboard
4. If some arrived damaged, type how many in **Damaged in this receipt**.
   Leave it at 0 if nothing was damaged.
5. Check the grey box — it spells out what will happen:
   *"Receiving 100 → 95 good + 5 damaged"*, and what the yard will hold afterwards
6. Optionally add a **reference** (GRN, truck number) and a **note**
7. Tap **Receive 100 PCS**

The item stays selected afterwards, because several trucks of the same item usually
arrive one after another. Only the numbers clear.

---

## 5. Recording stock going out

1. Tap **Issue**
2. Pick the item
3. The green panel shows **Available to issue** — that's the GOOD stock. Damaged
   pieces can't be issued, and it says so.
4. Type the quantity. If you type more than is available, the app tells you the real
   number and won't let you submit.
5. Tap **Issue 20 PCS**

---

## 6. Recording damage on stock already in the yard

1. Tap **Balance**
2. Tap the item's row
3. Tap **⚠ Record damage on this stock**
4. Type how many are damaged, pick a **reason** (Rain / Handling / Rust / Bent /
   Torn packing / Other), and tap **Record as damaged**
5. Confirm

The confirmation spells out exactly what changes, and the app reminds you: **the
total stays the same**. The pieces haven't left the yard, they've just moved from
good to damaged.

---

## 6b. Fixing a mistake — the Activity tab

Open **Activity**. It opens on **today's** movements, newest at the top, across
every warehouse and every item. Anything still waiting to upload sits above the
rest with a ⟳ next to it.

### Choosing how far back to look

Five buttons across the top: **Today**, **Yesterday**, **Last 7 days**,
**Last 30 days**, **All time**. It always starts on Today — leave the tab and
come back and it resets, so you never end up staring at an old filter and
thinking the yard is empty.

The line underneath always tells you which one you are looking at, so a short
list can never be mistaken for a quiet day.

Two things worth knowing:

- **Yesterday means yesterday only** — that one calendar day, not "since
  yesterday". Use Last 7 days if you want a run of days.
- **An entry belongs to the day it was RECORDED, not the day it uploaded.** If
  someone books a truck in at 11pm with no signal and the phone uploads it at
  8am, it stays under Yesterday, where it actually happened. That is what keeps
  a day's figures matching the paperwork.

Two buttons sit under each entry:

**Correct** — you typed the wrong number. Tap it and the Receive or Issue form
opens already filled in with everything that was recorded. Change what was
wrong and save. The original is cancelled at the moment you save, not before,
so if you change your mind just switch tabs and nothing at all has happened.

**Cancel entry** — the whole entry should not be there. Tap it, confirm, and the
stock goes back to what it was.

### Nothing is ever deleted

A cancelled entry stays on the list with a line through it and a **CANCELLED**
stamp. The Sheet gets a new row recording the cancellation, who did it and when.
That is deliberate: it is the difference between a mistake being fixed and stock
quietly disappearing, and with no login on this app it is the only thing that
keeps the yard's numbers trustworthy.

### Things it will not let you do

- **Cancel something twice.** The button disappears once an entry is cancelled.
- **Cancel a cancellation.** Same reason.
- **Cancel stock that has already moved on.** If you received 100 and 80 have
  since been issued, cancelling the receipt would leave the yard on minus 80 —
  so it is refused, and it says so. Record what actually happened instead.
- **Correct a transfer, an opening balance or a damage entry.** Those can only
  be cancelled, then re-entered.

### This one needs signal

Recording stock works with no signal at all. Cancelling and correcting do not —
they need a connection, because the correction has to be agreed with the Sheet
before it counts. If you are out of range it will tell you, and nothing is lost:
try again when you have a bar.

---

## 6c. Dates and times

Everywhere in the app, and in every date column of the Google Sheet, a date and
time now reads:

```
21-09-2026 09:05:20     (day-month-year, then the time to the second)
```

Always **Dubai time**, whatever the phone's own clock is set to. The app used to
say things like "Today 09:05" or "Yest 23:40" using the handset's timezone —
which meant a phone set wrongly could put a movement on the wrong day, and two
entries a minute apart looked identical with no way to match them to a row in
the Sheet.

---

## 7. Adding a new item

1. Tap **Items** → the blue **+** button at the bottom right
2. Enter the **SKU code** (short code, e.g. `0.3`) and a **description**
3. Pick a **unit** (PCS, KG, MT, BAG…)
4. If you already have stock of it, enter the **opening stock** — good and, of those,
   how many are damaged
5. Tap **Save item**

**The SKU code can't be changed later** once the item has any movements, because all
its history is filed under that code. The description can always be edited.

---

## 8. Working with no signal

You can keep recording with no signal at all. Nothing is lost.

- The top of the screen shows **Offline · 3 pending** — three entries saved on the
  phone, waiting to upload.
- The balances still update, so the numbers on screen stay right.
- When signal comes back it uploads by itself and the counter goes to zero.
- Tap the status chip any time to see exactly what's waiting.

**If an entry can't be saved** (for example someone else shipped that stock while you
were offline, so there isn't enough left), you get a red bar: *"1 entry could not be
saved — tap to fix"*. Tap it and you'll see what you typed and why it was refused,
with **Try again** or **Discard**. Nothing disappears silently.

---

## 9. What each tab in the Google Sheet is

Open the Sheet if you want to read or report on the raw data. **You don't need to
edit it — the app does that.**

| Tab | What it holds | Safe to edit by hand? |
|---|---|---|
| **Items** | The item list: code, description, unit, barcode, whether it's active, who added it, and a revision counter. | Description and unit — yes. **Never change a `sku`** that has movements. |
| **Ledger** | **The real record.** One row per action, ever. Receipts, issues, damages, opening stock, cancellations. Nothing is edited or deleted — a mistake is corrected by adding a cancelling row. Every row carries who did it, when they did it, and which phone it came from. | **No.** This is the source of truth. Editing it changes history. |
| **Users** | The names that appear in the app's "Who are you?" list. Set `active` to `FALSE` for someone who's left — their past entries keep their name. | Yes — add a name, or set `active` to FALSE. |
| **Meta** | The app's own settings and counters. `read_only` set to `TRUE` puts the app in maintenance mode (entries still save on phones and upload later). The `epoch` numbers are how the app knows when data changed. | Only `read_only`. Leave the rest alone. |
| **Balance_Snapshot** | The current total / damaged / good per item. This is **not** the truth — it's a fast running total the app keeps so it doesn't have to re-add the whole Ledger every time. It can be rebuilt from the Ledger at any moment. | No need. If it ever looks wrong, it can be rebuilt from the Ledger. |
| **Rejections** | A log of entries the app refused, and why. Useful for seeing what staff *tried* to record even when it wasn't accepted. | Yes — it's only a log, safe to clear. |

**Why the Ledger works this way:** because nothing is ever overwritten, every number
in the app can be traced back to the exact rows that produced it, and a late-arriving
offline entry can't corrupt a total. It's also what lets you answer "who recorded
that, and when?" months later, even though nobody logs in.

---

## 10. Two things worth knowing

**Anyone with the app link can record entries.** That's the cost of having no
password. Every entry is stamped with a name and nothing can be deleted, only
cancelled visibly — so mistakes and mischief are both traceable. Don't share the
link outside the team.

**The data lives in a personal Google account.** Fine for a working yard tool. If
this becomes an official RSA record, it should move onto RSA infrastructure with
proper Microsoft sign-in — that's a separate piece of work, and it would mean giving
up the no-login convenience.
