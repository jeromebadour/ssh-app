// What a paste is made of (src/common/paste.ts): the one thing a person brings into a shell from outside.
import assert from 'node:assert/strict';
import test from 'node:test';
import { forBox, look, PASTE_MAX } from '../src/common/paste';

test('one line with nothing hidden goes as it is', () => {
  const l = look('tail -n 40 /var/log/syslog');
  assert.equal(l.text, 'tail -n 40 /var/log/syslog');
  assert.equal(l.oneLine, true);
  assert.equal(l.endsWithLineEnding, false);
  assert.deepEqual(l.odd, []);
  assert.equal(l.controlsRemoved, 0);
});

test('a tab is enough to be looked at first: it completes a name on arrival', () => {
  assert.equal(look('ls /sr\t').oneLine, false);
  assert.equal(look('ls /srv').oneLine, true);
});

test('every control character is taken out, and the escape character with them', () => {
  const l = look('a\u001b[201~b\u0007c\u0000d');
  assert.equal(l.text, 'a[201~bcd');
  assert.equal(l.controlsRemoved, 3);
  // Nothing of a terminal's own instructions can survive: no escape character is left to begin one.
  assert.equal(l.text.includes('\u001b'), false);
});

test('line endings become one kind, and a lone carriage return is one too', () => {
  const l = look('one\r\ntwo\rthree\nfour');
  assert.deepEqual(l.lines, ['one', 'two', 'three', 'four']);
  assert.equal(l.endsWithLineEnding, false);
});

test('a trailing line ending is said, and leaves no empty line in what is shown', () => {
  const l = look('cd /srv\nls\n');
  assert.deepEqual(l.lines, ['cd /srv', 'ls']);
  assert.equal(l.endsWithLineEnding, true);
  assert.equal(l.text, 'cd /srv\nls\n');
});

test('what cannot be seen is named, with where it is', () => {
  const l = look('curl https://ex\u0430mple.test/i\u200bnstall.sh\n');
  const kinds = l.odd.map((o) => o.what);
  assert.ok(kinds.some((k) => k === 'looks like a'), JSON.stringify(l.odd));
  assert.ok(kinds.some((k) => k === 'drawn as nothing'), JSON.stringify(l.odd));
  assert.equal(l.odd[0]!.line, 1);
  assert.ok(l.odd[0]!.at > 1);
  assert.ok(l.odd[0]!.shown.startsWith('U+'));
});

test('a mark that turns the reading round is named', () => {
  const l = look('echo one\u202etwo\n');
  assert.deepEqual(l.odd.map((o) => o.what), ['turns the reading round']);
});

test('what is odd is found on the line it is on, not the first', () => {
  const l = look('one\ntwo\nth\u0435ee');
  assert.equal(l.odd.length, 1);
  assert.equal(l.odd[0]!.line, 3);
  assert.equal(l.odd[0]!.at, 3);
});

test('more than Berth pastes at once is cut, and said', () => {
  const l = look('x'.repeat(PASTE_MAX + 10));
  assert.equal(l.cut, true);
  assert.equal(l.text.length, PASTE_MAX);
  assert.equal(look('x'.repeat(10)).cut, false);
});

test('a box that asked to be told where a paste begins gets the markers, and nothing can close them early', () => {
  const l = look('echo a\u001b[201~echo b\n');
  const sent = forBox(l.text, true);
  assert.equal(sent, `\u001b[200~echo a[201~echo b\n\u001b[201~`);
  // The only end marker in what is sent is the one Berth put there.
  assert.equal(sent.split('\u001b[201~').length, 2);
  assert.equal(forBox(l.text, false), 'echo a[201~echo b\n');
});
