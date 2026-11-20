// The path as steps, and what folds when it is too long for the bar (src/tab/path-steps.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { foldSteps, stepsOf } from '../src/tab/path-steps';

test('every folder on the way to this one, the root included', () => {
  assert.deepEqual(stepsOf('/var/log/ledger').map((s) => s.at), ['/', '/var', '/var/log', '/var/log/ledger']);
  assert.deepEqual(stepsOf('/var/log/ledger').map((s) => s.name), ['/', 'var', 'log', 'ledger']);
});

test('the root on its own is one step, and so is a path that is only the root', () => {
  assert.deepEqual(stepsOf('/').map((s) => s.at), ['/']);
  assert.deepEqual(stepsOf('').map((s) => s.at), ['/']);
});

test('read end to end the steps spell the path', () => {
  for (const p of ['/', '/var', '/var/log', '/srv/ledger/2026/11/20']) {
    const steps = stepsOf(p);
    const says = steps.map((s, i) => (i === 0 || steps[i - 1]!.at === '/' ? s.name : `/${s.name}`)).join('');
    assert.equal(says, p === '' ? '/' : p, p);
  }
});

test('a path that fits folds nothing', () => {
  const got = foldSteps('/var/log', 46, 3);
  assert.equal(got.folded.length, 0);
  assert.deepEqual(got.shown.map((s) => s.at), ['/', '/var', '/var/log']);
});

test('a path too long for the bar folds its middle, keeping the root and the last few', () => {
  const deep = '/srv/customers/acme/releases/2026/11/20/build/output';
  const got = foldSteps(deep, 46, 3);
  assert.equal(got.shown[0]!.at, '/', 'the root is kept');
  assert.deepEqual(got.shown.slice(1).map((s) => s.name), ['20', 'build', 'output'], 'the last few are kept');
  assert.equal(got.shown[got.shown.length - 1]!.at, deep, 'the folder he is in is the last step');
  assert.deepEqual(got.folded.map((s) => s.name), ['srv', 'customers', 'acme', 'releases', '2026', '11']);
});

test('nothing is lost in a fold: every folder is either shown or folded, once', () => {
  const deep = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z';
  const got = foldSteps(deep, 46, 3);
  const all = stepsOf(deep).map((s) => s.at);
  const seen = [...got.shown.map((s) => s.at), ...got.folded.map((s) => s.at)];
  assert.equal(seen.length, all.length);
  assert.deepEqual([...seen].sort(), [...all].sort());
});

test('a shallow path is never folded however long its own names are', () => {
  const wide = '/a-very-long-single-folder-name-that-goes-on-and-on-for-ever';
  const got = foldSteps(wide, 46, 3);
  assert.equal(got.folded.length, 0, 'there is nothing in the middle to fold');
});
