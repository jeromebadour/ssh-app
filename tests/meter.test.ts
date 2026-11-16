import assert from 'node:assert/strict';
import test from 'node:test';

import { REACTION_KINDS } from '../src/common/ipc';
import { BUDGET, Meter } from '../src/main/meter';

const view = (longTaskMs: unknown, reactionMs: unknown, more: object = {}) => ({ longTaskMs, reactionMs, reactionKind: 0, reactionWaitMs: 0, reactionHandlerMs: 0, ...more });

test('the meter keeps the worst value and refuses anything that is not a sane number', () => {
  const m = new Meter();
  assert.equal(m.fromView(view(40, 20)), true);
  assert.equal(m.fromView(view(10, 90)), true);
  assert.deepEqual([m.worst.viewTaskMs, m.worst.reactionMs], [40, 90]);
  const bad = [null, 5, 'x', {}, { longTaskMs: 1 }, { longTaskMs: 1, reactionMs: 1 }, view(-1, 1), view(NaN, 1), view(Infinity, 1), view('9', 1), view(1e12, 1), view(1, 1, { reactionKind: 999 }), view(1, 1, { reactionKind: 1.5 }), view(1, 1, { reactionKind: 'click' }), view(1, 1, { reactionKind: -1 }), view(1, 1, { reactionWaitMs: -1 }), view(1, 1, { reactionHandlerMs: NaN })];
  for (const b of bad) assert.equal(m.fromView(b), false, JSON.stringify(b));
  assert.deepEqual([m.worst.viewTaskMs, m.worst.reactionMs], [40, 90]);
  m.reset();
  assert.deepEqual([m.worst.viewTaskMs, m.worst.reactionMs], [0, 0]);
});

test('the slowest reaction says which view, which event, and where its time went', () => {
  const m = new Meter();
  assert.equal(m.slowest, null);
  m.fromView(view(0, 120, { reactionKind: REACTION_KINDS.indexOf('click'), reactionWaitMs: 5, reactionHandlerMs: 15 }), 0);
  assert.deepEqual(m.slowest, { view: 0, kind: 'click', waitMs: 5, handlerMs: 15, paintMs: 100 });
  m.fromView(view(0, 60, { reactionKind: REACTION_KINDS.indexOf('keydown') }), 3); // a faster one changes nothing
  assert.deepEqual(m.slowest, { view: 0, kind: 'click', waitMs: 5, handlerMs: 15, paintMs: 100 });
  m.fromView(view(0, 400, { reactionKind: REACTION_KINDS.indexOf('keydown'), reactionWaitMs: 390, reactionHandlerMs: 20 }), 3);
  assert.deepEqual(m.slowest, { view: 3, kind: 'keydown', waitMs: 390, handlerMs: 20, paintMs: 0 }); // parts never add up past the whole
  m.reset();
  assert.equal(m.slowest, null);
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

test('only a click or a key is a reaction: the pointer passing over a view is not in the list', () => {
  for (const hover of ['pointerenter', 'pointerleave', 'pointerover', 'pointerout', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'pointermove', 'mousemove']) {
    assert.equal((REACTION_KINDS as readonly string[]).includes(hover), false, hover);
  }
  for (const press of ['pointerdown', 'click', 'keydown', 'keyup']) assert.equal((REACTION_KINDS as readonly string[]).includes(press), true, press);
});

test('the budgets are the plan\'s', () => {
  assert.deepEqual(BUDGET, { mainDelayMs: 50, viewTaskMs: 100, reactionMs: 100, tabSwitchMs: 100, startMs: 2000 });
});
