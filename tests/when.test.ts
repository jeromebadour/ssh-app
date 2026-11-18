// How a time is said (src/common/when.ts). What is held here is the one thing a person cannot check for
// himself from the screen: that the clock he is shown is his own, and not the one the computer stores.
import assert from 'node:assert/strict';
import test from 'node:test';
import { whenAs, whenShort } from '../src/common/when';

// His own zone, so the test means something on a runner whose clock is UTC, which is every runner.
const inIstanbul = (run: () => void): void => {
  const was = process.env['TZ'];
  process.env['TZ'] = 'Europe/Istanbul'; // UTC+3, no summer time since 2016
  try {
    run();
  } finally {
    if (was === undefined) delete process.env['TZ'];
    else process.env['TZ'] = was;
  }
};

test("today's file is said by his own clock, not by UTC", () => {
  inIstanbul(() => {
    const now = new Date();
    const atNine = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30, 0);
    assert.equal(whenShort(atNine.getTime() / 1000), '09:30');
    // And that really is the thing being held: UTC would have said 06:30.
    assert.equal(atNine.toISOString().slice(11, 16), '06:30');
  });
});

test('a file from earlier this year is said by the day his calendar shows', () => {
  inIstanbul(() => {
    const now = new Date();
    // Half past midnight is where UTC and his own clock disagree about the day.
    const justAfterMidnight = new Date(now.getFullYear(), 0, 14, 0, 30, 0);
    assert.equal(whenShort(justAfterMidnight.getTime() / 1000), '01-14');
    assert.equal(justAfterMidnight.toISOString().slice(5, 10), '01-13'); // what UTC would have said
  });
});

test('an older file is said by its own date, in his zone', () => {
  inIstanbul(() => {
    const old = new Date(2020, 2, 7, 1, 15, 0); // 7 March 2020, 01:15 in Istanbul
    assert.equal(whenShort(old.getTime() / 1000), '2020-03-07');
    assert.equal(whenAs(old.getTime() / 1000), '2020-03-07');
    assert.equal(old.toISOString().slice(0, 10), '2020-03-06'); // what UTC would have said
  });
});

test('nothing is said for a time that is not one', () => {
  assert.equal(whenShort(0), '');
  assert.equal(whenShort(-1), '');
});

test('a time near now is said as a distance, as it was', () => {
  const now = Date.now() / 1000;
  assert.equal(whenAs(now - 10), 'a moment ago');
  assert.equal(whenAs(now - 600), '10 minutes ago');
  assert.equal(whenAs(now - 7200), '2 hours ago');
  assert.equal(whenAs(now - 5 * 86400), '5 days ago');
});
