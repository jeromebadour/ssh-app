import assert from 'node:assert/strict';
import test from 'node:test';

import { BUDGET, Meter } from '../src/main/meter';

test('the meter keeps the worst value and refuses anything that is not a sane number', () => {
  const m = new Meter();
  assert.equal(m.fromView({ longTaskMs: 40, reactionMs: 20 }), true);
  assert.equal(m.fromView({ longTaskMs: 10, reactionMs: 90 }), true);
  assert.deepEqual([m.worst.viewTaskMs, m.worst.reactionMs], [40, 90]);
  for (const bad of [null, 5, 'x', {}, { longTaskMs: 1 }, { longTaskMs: -1, reactionMs: 1 }, { longTaskMs: NaN, reactionMs: 1 }, { longTaskMs: Infinity, reactionMs: 1 }, { longTaskMs: '9', reactionMs: 1 }, { longTaskMs: 1e12, reactionMs: 1 }]) {
    assert.equal(m.fromView(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual([m.worst.viewTaskMs, m.worst.reactionMs], [40, 90]);
  m.reset();
  assert.deepEqual([m.worst.viewTaskMs, m.worst.reactionMs], [0, 0]);
});

test('a tab switch is timed only between its begin and its painted frame', () => {
  const m = new Meter();
  m.tabPainted(1); // a frame nobody asked for changes nothing
  assert.equal(m.worst.tabSwitchMs, 0);
  m.tabSwitchBegins(2);
  m.forget(2); // the tab was closed meanwhile
  m.tabPainted(2);
  assert.equal(m.worst.tabSwitchMs, 0);
});

test('the budgets are the plan\'s', () => {
  assert.deepEqual(BUDGET, { mainDelayMs: 50, viewTaskMs: 100, reactionMs: 100, tabSwitchMs: 100, startMs: 2000 });
});
