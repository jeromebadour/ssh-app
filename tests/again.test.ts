// The rule for a new session a tab opens by itself (src/main/again.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGAIN_AFTER_MS, mayOpenAgain, NEVER_AGAIN } from '../src/main/again';

const ended = (cause: string) => ({ phase: 'ended', cause });

test('an ending that could go otherwise next time: a new session', () => {
  for (const cause of ['reset', 'closed-by-box', 'network-gone', 'timed-out', 'unknown']) {
    assert.equal(mayOpenAgain(ended(cause), 0, false), true, cause);
  }
});

test('an ending that would happen again, or that the person asked for: never', () => {
  for (const cause of NEVER_AGAIN) assert.equal(mayOpenAgain(ended(cause), 0, false), false, cause);
});

test('a link that has not ended: nothing to open', () => {
  for (const phase of ['none', 'connecting', 'key-exchange', 'signing-in', 'up']) {
    assert.equal(mayOpenAgain({ phase, cause: '' }, 0, false), false, phase);
  }
});

test('one is already counted down: it is not counted down twice', () => {
  assert.equal(mayOpenAgain(ended('reset'), Date.now() + AGAIN_AFTER_MS, false), false);
});

test('the person pressed Cancel: nothing opens one, however the word arrives', () => {
  // The press clears the countdown, so what comes after it finds no countdown to stop it: this is the only
  // thing that does. A word from the box after the press (its process ending is one) must not undo the press.
  assert.equal(mayOpenAgain(ended('reset'), 0, true), false);
  for (const cause of ['reset', 'closed-by-box', 'network-gone']) {
    assert.equal(mayOpenAgain(ended(cause), 0, true), false, cause);
  }
});

test('Reconnect after a Cancel is the person asking, and it is not this rule that answers', () => {
  // Pressing Reconnect clears the press, so the tab is open to one again.
  assert.equal(mayOpenAgain(ended('reset'), 0, false), true);
});
