import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseIn } from '../src/main/fuse';

const sentinel = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const binary = (wire: string) => Buffer.concat([Buffer.from('some program bytes '), Buffer.from(sentinel), Buffer.from([1, wire.length]), Buffer.from(wire), Buffer.from(' more')]);

test('a fuse is read as on, off or removed', () => {
  const b = binary('01r1');
  assert.equal(fuseIn(b, 0), 'off');
  assert.equal(fuseIn(b, 1), 'on');
  assert.equal(fuseIn(b, 2), 'removed');
  assert.equal(fuseIn(b, 3), 'on');
});

test('anything else is unknown, never on', () => {
  assert.equal(fuseIn(binary('0101'), 4), 'unknown'); // past the end
  assert.equal(fuseIn(binary('0101'), -1), 'unknown');
  assert.equal(fuseIn(Buffer.from('no marker here'), 3), 'unknown');
  assert.equal(fuseIn(Buffer.concat([Buffer.from(sentinel), Buffer.from([2, 4]), Buffer.from('1111')]), 3), 'unknown'); // another version
  assert.equal(fuseIn(Buffer.concat([Buffer.from(sentinel), Buffer.from([1, 4]), Buffer.from('111x')]), 3), 'unknown');
  assert.equal(fuseIn(Buffer.from(sentinel), 0), 'unknown'); // cut off
});
