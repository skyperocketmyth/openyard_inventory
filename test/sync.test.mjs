/**
 * The adoption gate.
 *
 * This is a four-line function with its own test file because the bug it
 * prevents is invisible: a background refresh that adopts server state while
 * a write is still queued on the phone silently erases what the user just
 * recorded, and looks like nothing at all in a code review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canAdoptServerSnapshot } from '../docs/lib/sync.js';

test('adopts only when nothing was pending before OR after the read', () => {
  assert.equal(canAdoptServerSnapshot(0, 0), true);
});

test('refuses when a write was already queued before the read', () => {
  assert.equal(canAdoptServerSnapshot(1, 0), false);
});

test('refuses when a write was enqueued WHILE the read was in flight', () => {
  // The response predates that write, so it cannot contain it. This is the
  // case a "before"-only check misses.
  assert.equal(canAdoptServerSnapshot(0, 1), false);
});

test('refuses when writes were pending throughout', () => {
  assert.equal(canAdoptServerSnapshot(2, 2), false);
});

test('the gate is not a truthiness check', () => {
  // Guards against someone "simplifying" this to !pendingBefore && !pendingAfter
  // and then passing undefined from a failed count.
  assert.equal(canAdoptServerSnapshot(undefined, undefined), false);
  assert.equal(canAdoptServerSnapshot(null, null), false);
});
