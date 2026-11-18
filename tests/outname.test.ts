// The name offered for a file written from what a box printed (src/main/outname.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { saveName } from '../src/main/outname';

const at = new Date(2026, 10, 18, 3, 7); // 2026-11-18 03:07, local time: the name says his clock, not UTC
const name = (box: string, place = '', kind = 'whole') => saveName(box, place, at, kind);

test('the box, the place, the day and the minute, and it ends in .txt', () => {
  assert.equal(name('lab-box', 'logs'), 'lab-box logs 2026-11-18 03-07.txt');
  assert.equal(name('lab-box'), 'lab-box 2026-11-18 03-07.txt');
});

test('a block says it is one command, not the whole terminal', () => {
  assert.equal(name('lab-box', 'logs', 'block'), 'lab-box logs command 2026-11-18 03-07.txt');
});

test('a name is a name: nothing in it can name a folder or climb out of one', () => {
  for (const box of ['../../etc', 'a/b', 'a\\b', 'C:box', 'a:b', 'a*b?c"d', 'a|b<c>d']) {
    const out = name(box);
    assert.ok(!/[\\/:*?"<>|]/.test(out), `${box} -> ${out}`);
    assert.ok(!out.includes('..'), `${box} -> ${out}`);
    assert.ok(out.endsWith('.txt'), `${box} -> ${out}`);
  }
});

test('nothing Windows takes off a name by itself is left at either end', () => {
  for (const box of ['  spaced  ', 'dotted...', '...dotted', ' . ']) {
    const out = name(box);
    const stem = out.slice(0, -'.txt'.length);
    assert.ok(!/^[ .]/.test(stem), out);
    assert.ok(!/[ .]$/.test(stem), out);
  }
});

test('a box with no name of its own still gets a file it can be given', () => {
  assert.equal(saveName('', '', at, 'whole'), '2026-11-18 03-07.txt');
  assert.equal(saveName('***', '', at, 'whole'), '___ 2026-11-18 03-07.txt');
});

test('a very long name is cut, and is still a name', () => {
  const out = name('b'.repeat(400));
  assert.ok(out.length <= 100, String(out.length));
  assert.ok(out.endsWith('.txt'), out);
});
