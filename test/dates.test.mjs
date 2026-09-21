/**
 * Dubai formatting and the Activity filter's day boundaries.
 *
 * Run:  node --test test/dates.test.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A timezone bug is the quietest bug in this app. It does not throw, it does
 * not look wrong, and it does not move any quantity — it just relabels WHICH
 * DAY a movement belongs to. A truck that arrived at 09:05 reads 05:05, "today"
 * silently starts at 04:00, and the first anyone knows is a day's figures not
 * matching the paperwork.
 *
 * Every instant below is FIXED and every expectation is written out by hand in
 * Dubai wall-clock terms. Nothing here derives an expectation from the same
 * function it is testing, and nothing calls `Date.now()` — `dayStartMs` and
 * `windowFor` both take an explicit `nowMs` for exactly this reason. A test
 * that computes its own midnight the same way the code does passes whether or
 * not either is right.
 *
 * Dubai is UTC+4, no DST, ever. So 00:00 Dubai == 20:00 UTC the previous day,
 * and each boundary is written as that UTC instant to keep the arithmetic
 * visible rather than implied.
 *
 * THE PROCESS RUNS IN WHATEVER TIMEZONE THE MACHINE IS IN. These tests must
 * pass on a laptop set to Dubai, to UTC, or to Los Angeles — that is the whole
 * point of pinning the zone in the module. `TZ` is never set here, so a pass on
 * Harish's Dubai-set Windows box would be meaningless on its own; the
 * cross-timezone test at the bottom re-runs the core assertions under three
 * different process timezones to prove the pinning actually holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fmtDubai, fmtDubaiTime, dayStartMs, windowFor, RANGES, DEFAULT_RANGE
} from '../docs/lib/dates.js';

const here = dirname(fileURLToPath(import.meta.url));

/* A Sunday morning in the yard: 2026-09-21 09:05:20 Dubai. */
const MORNING = Date.parse('2026-09-21T05:05:20.000Z');

test('a timestamp reads DD-MM-YYYY HH:MM:SS in Dubai time', () => {
  assert.equal(fmtDubai('2026-09-21T05:05:20.000Z'), '21-09-2026 09:05:20',
    '05:05 UTC is 09:05 in the yard');
});

test('the four-hour shift is applied, not just the layout', () => {
  // The failure this guards: formatting correctly but in UTC. Both strings
  // below are well-formed DD-MM-YYYY HH:MM:SS, so a format-only check passes
  // against the bug. Only the VALUE distinguishes them.
  assert.notEqual(fmtDubai('2026-09-21T05:05:20.000Z'), '21-09-2026 05:05:20',
    'rendering UTC in the right shape is still the wrong time');
});

test('an instant late enough in UTC rolls over to the NEXT day in Dubai', () => {
  // 21:30 UTC is 01:30 the following morning in Dubai. Getting the zone wrong
  // here puts a movement on the wrong DATE, not just the wrong clock time —
  // which is what makes a day's totals disagree with the paperwork.
  assert.equal(fmtDubai('2026-09-21T21:30:00.000Z'), '22-09-2026 01:30:00');
});

test('midnight renders as 00, never 24', () => {
  // 20:00 UTC is exactly 00:00 Dubai. `hour12:false` is permitted to render
  // this as "24" in some engines, which would read as 24-09-2026 24:00:00.
  assert.equal(fmtDubai('2026-09-20T20:00:00.000Z'), '21-09-2026 00:00:00');
});

test('it takes ISO strings, Dates and epoch millis alike', () => {
  const want = '21-09-2026 09:05:20';
  assert.equal(fmtDubai('2026-09-21T05:05:20.000Z'), want, 'ISO string');
  assert.equal(fmtDubai(new Date(MORNING)), want, 'Date');
  assert.equal(fmtDubai(MORNING), want, 'epoch millis');
});

test('anything unparseable is blank, never "Invalid Date"', () => {
  for (const bad of ['', null, undefined, 'not a date', NaN, '   ']) {
    assert.equal(fmtDubai(bad), '', `"${String(bad)}" must render as nothing`);
  }
});

test('the time-only form is the clock part of the full one', () => {
  assert.equal(fmtDubaiTime('2026-09-21T05:05:20.000Z'), '09:05:20');
  assert.equal(fmtDubaiTime(''), '');
});

/* ------------------------- the day boundaries ------------------------- */

test("today starts at Dubai midnight, not the device's", () => {
  assert.equal(new Date(dayStartMs(0, MORNING)).toISOString(),
    '2026-09-20T20:00:00.000Z', '00:00 on 21 Sep Dubai is 20:00 UTC on the 20th');
});

test('yesterday and last week step back by whole Dubai days', () => {
  assert.equal(new Date(dayStartMs(1, MORNING)).toISOString(), '2026-09-19T20:00:00.000Z');
  assert.equal(new Date(dayStartMs(6, MORNING)).toISOString(), '2026-09-14T20:00:00.000Z');
  assert.equal(new Date(dayStartMs(29, MORNING)).toISOString(), '2026-08-22T20:00:00.000Z');
});

test('a moment just after Dubai midnight belongs to the new day', () => {
  // 20:00:01 UTC on the 20th is 00:00:01 on the 21st in the yard, so "today"
  // must already have started. An off-by-one here makes the first entries of
  // a shift vanish from the Today list.
  const justAfter = Date.parse('2026-09-20T20:00:01.000Z');
  assert.equal(new Date(dayStartMs(0, justAfter)).toISOString(), '2026-09-20T20:00:00.000Z');
});

test('a moment just BEFORE Dubai midnight still belongs to the old day', () => {
  const justBefore = Date.parse('2026-09-20T19:59:59.000Z');
  assert.equal(new Date(dayStartMs(0, justBefore)).toISOString(), '2026-09-19T20:00:00.000Z',
    'at 23:59:59 Dubai, today began the previous UTC evening');
});

/* ---------------------------- the windows ---------------------------- */

test('Today is open-ended: everything since midnight', () => {
  const w = windowFor('today', MORNING);
  assert.equal(w.since, '2026-09-20T20:00:00.000Z');
  assert.equal(w.until, '', 'no upper bound — entries are still arriving');
});

test('Yesterday is a CLOSED window, one calendar day wide', () => {
  // The only range with an upper bound, and the reason `until` exists. If
  // `until` were dropped, Yesterday would quietly mean "yesterday and today".
  const w = windowFor('yesterday', MORNING);
  assert.equal(w.since, '2026-09-19T20:00:00.000Z');
  assert.equal(w.until, '2026-09-20T20:00:00.000Z');
  assert.equal(Date.parse(w.until) - Date.parse(w.since), 86400000,
    'exactly 24 hours wide');
});

test('Last 7 days means today plus the six before it', () => {
  const w = windowFor('week', MORNING);
  assert.equal(w.since, '2026-09-14T20:00:00.000Z');
  assert.equal(w.until, '');
  const days = (Date.parse('2026-09-20T20:00:00.000Z') - Date.parse(w.since)) / 86400000;
  assert.equal(days, 6, 'six midnights back, so seven calendar days including today');
});

test('Last 30 days means today plus the twenty-nine before it', () => {
  const w = windowFor('month', MORNING);
  assert.equal(w.since, '2026-08-22T20:00:00.000Z');
  assert.equal(w.until, '');
});

test('All time sends no bounds at all', () => {
  const w = windowFor('all', MORNING);
  assert.equal(w.since, '');
  assert.equal(w.until, '');
});

test('an unknown range key falls back to All, never to a narrower window', () => {
  // Failing open matters: a typo in a chip name that silently hid movements
  // would look exactly like stock having gone missing.
  for (const junk of ['', 'TODAY', 'last-week', undefined, null]) {
    const w = windowFor(junk, MORNING);
    assert.equal(w.since, '', `"${String(junk)}" must not bound the list`);
    assert.equal(w.until, '');
  }
});

test('the ranges offered are the five asked for, Today first', () => {
  assert.deepEqual(RANGES.map(r => r.key),
    ['today', 'yesterday', 'week', 'month', 'all']);
  assert.equal(DEFAULT_RANGE, 'today', 'the tab must open on today');
  assert.equal(RANGES[0].key, DEFAULT_RANGE, 'and the default must be the first chip');
});

test('every window is ordered — since is never after until', () => {
  for (const r of RANGES) {
    const w = windowFor(r.key, MORNING);
    if (w.since && w.until) {
      assert.ok(Date.parse(w.since) < Date.parse(w.until),
        `${r.key} has since >= until, which would return nothing at all`);
    }
  }
});

/* --------------------- and none of it uses the device --------------------- */

test('the same answers come back under any process timezone', () => {
  // THE LOAD-BEARING TEST. Everything above passes trivially on a machine
  // already set to Dubai — which is Harish's — so on its own it proves
  // nothing about the pinning. This re-runs the core assertions in child
  // processes forced to UTC, to US Pacific and to Dubai itself. If the module
  // ever reads the device clock's zone instead of Asia/Dubai, the UTC and
  // Pacific runs diverge and this fails.
  const probe = [
    // pathToFileURL, not the raw path: on Windows an absolute path begins
    // "D:\..." and the ESM loader rejects that as an unknown URL scheme "d:".
    "import { fmtDubai, dayStartMs, windowFor } from " +
      JSON.stringify(pathToFileURL(join(here, '..', 'docs', 'lib', 'dates.js')).href) + ";",
    "const M = Date.parse('2026-09-21T05:05:20.000Z');",
    "console.log(JSON.stringify({",
    "  fmt: fmtDubai('2026-09-21T05:05:20.000Z'),",
    "  rollover: fmtDubai('2026-09-21T21:30:00.000Z'),",
    "  today: new Date(dayStartMs(0, M)).toISOString(),",
    "  yest: windowFor('yesterday', M)",
    "}));"
  ].join('\n');

  const under = tz => JSON.parse(execFileSync(
    process.execPath, ['--input-type=module', '-e', probe],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
  ));

  const dubai = under('Asia/Dubai');
  const utc = under('UTC');
  const pacific = under('America/Los_Angeles');

  assert.equal(dubai.fmt, '21-09-2026 09:05:20', 'the Dubai-set machine is the baseline');
  assert.deepEqual(utc, dubai, 'a UTC machine must agree with a Dubai one');
  assert.deepEqual(pacific, dubai, 'so must a machine on the other side of the world');
});

test('a day boundary is exactly midnight, to the millisecond', () => {
  // Regression. `offsetMsAt` rebuilt the instant from Intl parts, which stop at
  // seconds, and differenced it against the RAW millisecond value — so the
  // leftover milliseconds of "now" leaked into the offset and midnight came
  // back a few hundred ms late. Filtering still worked, which is exactly why it
  // would have gone unnoticed.
  for (const odd of [766, 1, 999, 500]) {
    const at = Date.parse('2026-09-21T05:05:20.000Z') + odd;
    const start = dayStartMs(0, at);
    assert.equal(start % 1000, 0, `midnight must land on a whole second (+${odd}ms)`);
    assert.equal(new Date(start).toISOString(), '2026-09-20T20:00:00.000Z',
      `a now with ${odd}ms must not move the day boundary`);
  }
});

test('every range boundary lands on a whole second', () => {
  const at = Date.now();
  for (const r of RANGES) {
    const w = windowFor(r.key, at);
    for (const edge of [w.since, w.until]) {
      if (!edge) continue;
      assert.ok(edge.endsWith('.000Z'), `${r.key} boundary ${edge} is not a clean instant`);
    }
  }
});
