// Fails on purpose, once: to see on GitHub that a pull request with a red run is not merged.
// This file is removed in the same pull request before it can merge.
import assert from 'node:assert/strict';
import test from 'node:test';

test('a red run is not merged', () => {
  assert.fail('red on purpose');
});
