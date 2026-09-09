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

## 2. The four tabs at the bottom

| Tab | What it's for |
|---|---|
| **Balance** | The home screen. What's in the yard right now, per item. |
| **Receive** | Stock arriving. This is where damages on arrival are recorded. |
| **Issue** | Stock going out. |
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
