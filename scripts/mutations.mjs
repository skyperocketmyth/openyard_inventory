/**
 * The mutation cases. Data, not code — adding one is a new entry here.
 *
 * Each case breaks ONE load-bearing line on purpose and names the checks that
 * must go red as a result. The runner fails if a named check stays green,
 * because a check that cannot fail is worse than no check: it reads as
 * coverage. See scripts/mutate.mjs.
 *
 * `find` must appear EXACTLY ONCE in the file. That is asserted, so a case
 * silently stops matching the moment the code it targets is reworded, rather
 * than quietly passing against an unmutated file — which is the failure mode
 * this whole script exists to catch in the suites themselves.
 *
 * `expect` labels are matched as substrings against the suite's own PASS/FAIL
 * lines, so they can be shortened, but they must still be unique.
 */

export default [
  /* ---------------- Dubai time and the Activity window ---------------- */
  {
    name: 'timestamps are rendered in UTC instead of Dubai',
    why: 'A four-hour-wrong clock on every row. It does not throw, it is a '
       + 'perfectly plausible time, and it disagrees with the Sheet.',
    suite: 'verify-activity',
    file: 'docs/lib/dates.js',
    // 'UTC', not removing timeZone altogether: dropping it falls back to the
    // MACHINE's zone, which on Harish's box and in headless Chrome is already
    // Asia/Dubai — a mutation that changes nothing and reports SURVIVED.
    find: "  timeZone: ZONE,\n  year: 'numeric', month: '2-digit', day: '2-digit',",
    replace: "  timeZone: 'UTC', // MUTANT\n  year: 'numeric', month: '2-digit', day: '2-digit',",
    expect: [
      'and it is the Dubai time, to the second',
      'it is NOT the UTC hour'
    ]
  },
  {
    name: 'the day boundary is taken from the device, not from Dubai',
    why: 'THE QUIET ONE. "Today" would start at the device midnight, so a '
       + 'phone on the wrong timezone silently moves movements between days.',
    suite: 'test/dates.test.mjs',
    file: 'docs/lib/dates.js',
    find: '  const midnight = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))' + '\n'
        + '    - offsetMsAt(at);',
    replace: '  const d0 = new Date(at); d0.setHours(0, 0, 0, 0);' + '\n'
      + '  const midnight = d0.getTime(); // MUTANT: device midnight',
    expect: ["today starts at Dubai midnight, not the device's"]
  },
  {
    name: 'Yesterday loses its upper bound',
    why: 'It would then mean "yesterday AND today" while the chip says '
       + 'Yesterday — a wrong day total that reads as a busy day.',
    suite: 'verify-activity',
    file: 'docs/lib/dates.js',
    find: "        until: iso(dayStartMs(0, nowMs)),",
    replace: "        until: '', // MUTANT",
    expect: [
      'Yesterday sends BOTH bounds, so it cannot also mean today',
      "...while today's entries drop out of it"
    ]
  },
  {
    name: 'the window is never sent to the server',
    why: 'Every range would return the whole ledger. The chips would look like '
       + 'they worked and the list would be wrong under all of them.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: "    if (win.since) params.since = win.since;\n    if (win.until) params.until = win.until;",
    replace: "    // MUTANT: window not sent",
    expect: [
      'opening it asks the server only for today',
      'an entry uploaded today but recorded last night is NOT in Today'
    ]
  },
  {
    name: 'the tab bar stops resetting the window to Today',
    why: 'A filter left on Yesterday from an earlier visit reads as an empty '
       + 'yard the next time someone opens the tab.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: "    if (t.dataset.screen === 'activity') ui.actRange = DEFAULT_RANGE;",
    replace: '    // MUTANT: window not reset',
    expect: ['leaving and returning resets the window to Today']
  },
  {
    name: 'the offline window filter reads arrival instead of when it happened',
    why: 'An entry recorded at 23:00 and uploaded at 08:00 would be counted '
       + 'under the wrong day, and the day totals stop matching the paperwork.',
    suite: 'test/ledger-window.test.mjs',
    file: 'gas/Code.js',
    find: '    var whenMs = tsMs_(r[LX.client_ts]);\n    if (whenMs === null) whenMs = tsMs_(r[LX.server_ts]);',
    replace: '    var whenMs = tsMs_(r[LX.server_ts]); // MUTANT: arrival, not occurrence',
    expect: [
      'an entry recorded last night and uploaded this morning is NOT today',
      '...and it DOES show under yesterday, the day it actually happened'
    ]
  },
  {
    name: 'the windowed read stops one block too eagerly',
    why: 'Movements inside the window would silently fall off the end of the '
       + 'list — the worst outcome of the whole optimisation.',
    suite: 'test/ledger-window.test.mjs',
    file: 'gas/Code.js',
    find: '    if (oldest !== null && oldest < sinceMs) break;',
    replace: '    break; // MUTANT: always stop after one block',
    expect: ['reading today does not read the whole tab']
  },

  {
    name: 'the correction is never committed on save (Issue)',
    why: 'A correction that does not cancel the original double-counts the stock.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: "  if (!await commitCorrection()) { $('issSubmit').disabled = false; return; }",
    replace: '  // MUTANT: correction never committed',
    expect: [
      'saving sends the cancellation',
      'the cancellation goes BEFORE the replacement is uploaded'
    ]
  },
  {
    name: 'the correction is never committed on save (Receive)',
    why: 'Same as above, on the other entry screen. Both handlers must be covered.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: '  if (!await commitCorrection()) { btn.disabled = false; return; }',
    replace: '  // MUTANT: correction never committed',
    expect: ['a refused cancellation queues NO replacement']
  },
  {
    name: 'the returning stock is not counted on a correction',
    why: 'Correcting an issue upward is then refused for "not enough stock" '
       + 'whenever the yard is nearly empty.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: "  if (!c || c.type !== 'OUTBOUND') return 0;",
    replace: '  return 0; // MUTANT: allowance always zero',
    expect: [
      'available counts the 30 coming back',
      'raising the issue to 50 is allowed'
    ]
  },
  {
    name: 'show() stops clearing the pending correction',
    why: 'THE ONE THAT CAUGHT A HOLE IN THE SUITE. A stale correction outlives '
       + 'its form and cancels whatever the NEXT unrelated entry touches. The '
       + 'banner assertion alone let this through, so the sequence check below '
       + 'is the one that matters.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: "  ui.correcting = null;\n  paintCorrectNote();\n  if (screen === 'receive')",
    replace: "  if (screen === 'receive')",
    expect: ['an abandoned correction does NOT cancel anything on the next save']
  },
  {
    name: 'an already-cancelled entry still offers its buttons',
    why: 'Inviting a second cancellation the server will refuse, on a row whose '
       + 'stock has already been put back.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: '      const canAct = !isVoid && !isCancelled;',
    replace: '      const canAct = true; // MUTANT: everything actionable',
    expect: [
      'an already-cancelled entry offers NO buttons',
      'a cancellation itself cannot be cancelled'
    ]
  },
  {
    name: 'cancelling skips its confirmation and fires immediately',
    why: 'A mis-tap on a phone in a yard rewrites stock with no question asked.',
    suite: 'verify-activity',
    file: 'docs/index.html',
    find: '    b.onclick = () => askCancel(b.dataset.cancel);',
    replace: '    b.onclick = async () => { await sendVoid(b.dataset.cancel, \'\'); await render(); };',
    expect: ['Cancel asks for confirmation first']
  },
  {
    name: 'the warehouse chip row reads the across-yard total',
    why: 'F10. The oldest and worst bug class in this app: an action gated on '
       + 'stock summed across warehouses.',
    suite: 'verify-facilities',
    file: 'docs/index.html',
    // It must SUM across yards, not `.find` one. A `.find(x => x.sku === sku)`
    // looks like an across-yard bug and is not one: rows are sorted facility
    // then sku, so it returns YARD A's row — the correct answer — and the
    // mutation changes nothing. It reported SURVIVED and sent me looking for a
    // hole in the suite that was not there. A mutation has to be checked for
    // actually altering behaviour, not just for compiling.
    find: '    const b = await SY.projectedFor(fac, sku);\n    // A correction is about to hand the original quantity back to this yard,',
    replace: '    const __all = (await SY.projected()).filter(x => x.sku === sku);\n'
      + '    const b = { total: __all.reduce((s,x) => s + x.total, 0),\n'
      + '      damaged: __all.reduce((s,x) => s + x.damaged, 0),\n'
      + '      good: __all.reduce((s,x) => s + x.good, 0) }; // MUTANT: across-yard total\n'
      + '    // A correction is about to hand the original quantity back to this yard,',
    expect: [
      "available-to-issue is YARD A's 35 good, not the aggregate 295",
      'issuing 300 (the aggregate) from YARD A is REFUSED'
    ]
  }
];
