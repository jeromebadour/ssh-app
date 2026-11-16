// The rule that lets the tab in front come first (src/main/pace.ts): pure arithmetic, so it is tested as that.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CALM_LOOKS, CALM_UNDER, FLOODED_FROM, Pace, SHARE_MIN, shareFor } from '../src/main/pace';

test('with no flooded tab behind, every tab has all of its time', () => {
  for (const processors of [1, 2, 4, 8, 64]) assert.equal(shareFor(processors, 0), 1);
});

test('a PC with processors to spare holds no tab back', () => {
  assert.equal(shareFor(8, 6), 1); // six behind, six to spare
  assert.equal(shareFor(16, 6), 1);
  assert.equal(shareFor(4, 2), 1);
});

test('more flooded tabs behind than processors to spare: each gets its part, never under the least', () => {
  assert.equal(shareFor(4, 6), 0.33); // two to spare among six
  assert.equal(shareFor(2, 1), 0.5); // a PC with two has half of one to spare
  assert.equal(shareFor(2, 6), 0.08);
  assert.equal(shareFor(1, 6), 0.08);
  assert.equal(shareFor(2, 100), SHARE_MIN);
});

test('numbers that are none change nothing', () => {
  assert.equal(shareFor(Number.NaN, 3), shareFor(1, 3));
  assert.equal(shareFor(0, 3), shareFor(1, 3));
  assert.equal(shareFor(8, -1), 1);
  assert.equal(shareFor(8, 1.5), 1);
  assert.equal(shareFor(8, Number.NaN), 1);
});

const tabs = (waiting: number[], front = 0) => waiting.map((w, id) => ({ id, behind: id !== front, waiting: w }));

test('a tab is flooded only while its box is far ahead of it; the tab in front is never counted', () => {
  const pace = new Pace(2);
  assert.equal(pace.look(tabs([0, 0, 0])), false);
  assert.equal(pace.share, 1);
  // The tab in front is flooded: nobody behind is, so nothing changes.
  assert.equal(pace.look(tabs([FLOODED_FROM * 2, 0, 0])), false);
  // One behind, just under the mark: not flooded. At the mark: flooded.
  assert.equal(pace.look(tabs([0, FLOODED_FROM - 1, 0])), false);
  assert.equal(pace.look(tabs([0, FLOODED_FROM, 0])), true);
  assert.equal(pace.share, 0.5);
  assert.equal(pace.look(tabs([0, FLOODED_FROM, FLOODED_FROM])), true);
  assert.equal(pace.share, 0.25);
  assert.equal(pace.lowest, 0.25);
});

test('a flooded tab is calm again only after staying low for some looks, so the share does not swing', () => {
  const pace = new Pace(2);
  pace.look(tabs([0, FLOODED_FROM]));
  assert.equal(pace.share, 0.5);
  // Between the two marks it stays flooded, however long.
  for (let i = 0; i < 20; i++) assert.equal(pace.look(tabs([0, CALM_UNDER])), false);
  // Low, but not for long enough; then one look higher starts the count again.
  for (let i = 0; i < CALM_LOOKS - 1; i++) assert.equal(pace.look(tabs([0, CALM_UNDER - 1])), false);
  assert.equal(pace.look(tabs([0, CALM_UNDER])), false);
  for (let i = 0; i < CALM_LOOKS - 1; i++) assert.equal(pace.look(tabs([0, 0])), false);
  assert.equal(pace.look(tabs([0, 0])), true);
  assert.equal(pace.share, 1);
  assert.equal(pace.lowest, 0.5);
});

test('a flooded tab brought to the front stops counting; the one it replaces starts', () => {
  const pace = new Pace(2);
  pace.look(tabs([0, FLOODED_FROM, FLOODED_FROM], 0));
  assert.equal(pace.share, 0.25);
  pace.look(tabs([0, FLOODED_FROM, FLOODED_FROM], 1));
  assert.equal(pace.share, 0.5);
});

test('a closed tab is forgotten', () => {
  const pace = new Pace(2);
  pace.look(tabs([0, FLOODED_FROM, FLOODED_FROM]));
  assert.equal(pace.share, 0.25);
  assert.equal(pace.look([{ id: 0, behind: false, waiting: 0 }, { id: 1, behind: true, waiting: FLOODED_FROM }]), true);
  assert.equal(pace.share, 0.5);
});

test('the lab can hold a share by hand, and give the rule back', () => {
  const pace = new Pace(64);
  pace.force(0.05);
  assert.equal(pace.look(tabs([0, 0])), true);
  assert.equal(pace.share, 0.05);
  pace.force(0.001);
  pace.look(tabs([0, 0]));
  assert.equal(pace.share, SHARE_MIN);
  pace.force(null);
  assert.equal(pace.look(tabs([0, 0])), true);
  assert.equal(pace.share, 1);
});
