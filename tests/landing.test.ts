import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freeName, safeName } from '../src/common/landing';

test('a name from a box never becomes a path on the PC', () => {
  // This is the rule that keeps a download inside the folder it was sent to. A name is a name, whatever is
  // in it: a box may call a file anything at all.
  for (const nasty of [
    '../../etc/passwd',
    '..\\..\\windows\\system32\\drivers\\etc\\hosts',
    '/etc/shadow',
    'C:\\Windows\\System32\\cmd.exe',
    'a/b/c',
    'a\\b\\c',
    '....//....//x',
  ]) {
    const { name } = safeName(nasty);
    assert.ok(!name.includes('/'), `${nasty} landed as ${name}`);
    assert.ok(!name.includes('\\'), `${nasty} landed as ${name}`);
    assert.ok(!name.includes(':'), `${nasty} landed as ${name}`);
    assert.notEqual(name, '.');
    assert.notEqual(name, '..');
  }
});

test('a colon never lands, because Windows would make it a hidden second stream', () => {
  const { name, changed } = safeName('notes.txt:hidden');
  assert.ok(!name.includes(':'));
  assert.equal(changed, true);
});

test('the names Windows keeps for devices land as something else', () => {
  for (const device of ['CON', 'con', 'nul', 'COM1', 'lpt9', 'aux.txt', 'NUL.tar.gz']) {
    const { name } = safeName(device);
    const stem = name.split('.')[0]!.toLowerCase();
    assert.ok(!['con', 'nul', 'com1', 'lpt9', 'aux', 'prn'].includes(stem), `${device} landed as ${name}`);
  }
  // A name that merely starts the same way is left alone: console.log is not a device.
  assert.equal(safeName('console.log').name, 'console.log');
  assert.equal(safeName('connect.sh').name, 'connect.sh');
});

test('a trailing dot or space never lands, because Windows drops it', () => {
  // Two different names on a box would otherwise become one file here, and the second would overwrite the first.
  assert.equal(safeName('report.').name, 'report');
  assert.equal(safeName('report ').name, 'report');
  assert.equal(safeName('report. . ').name, 'report');
  assert.equal(safeName('report.txt').name, 'report.txt');
});

test('a kind Explorer acts on by itself lands harmless, and says so', () => {
  for (const kind of ['shortcut.lnk', 'thing.url', 'x.scf', 'y.library-ms', 'desktop.ini', 'z.settingcontent-ms']) {
    const { name, changed, why } = safeName(kind);
    assert.ok(name.endsWith('.txt'), `${kind} landed as ${name}`);
    assert.equal(changed, true);
    assert.match(why, /acts on/);
  }
  // An ordinary file of a similar name is left alone.
  assert.equal(safeName('notes.txt').name, 'notes.txt');
  assert.equal(safeName('kit.tar.gz').name, 'kit.tar.gz');
});

test('a name longer than Windows allows is cut, and keeps what it is', () => {
  const long = `${'a'.repeat(300)}.tar.gz`;
  const { name, changed } = safeName(long);
  assert.ok(name.length <= 255, `landed at ${name.length}`);
  assert.ok(name.endsWith('.tar.gz'));
  assert.equal(changed, true);
});

test('a name with nothing usable in it still gets one', () => {
  for (const empty of ['', '...', '/', '\\', ':::', '   ']) {
    const { name } = safeName(empty);
    assert.notEqual(name, '');
    assert.ok(!/^[. ]*$/.test(name), `${JSON.stringify(empty)} landed as ${JSON.stringify(name)}`);
  }
});

test('an ordinary name lands exactly as it was, and says nothing changed', () => {
  for (const fine of ['notes.txt', 'kit.tar.gz', 'today.log', 'a file with spaces.md', 'ledger-2026-11.csv', 'Ünïcödé.txt', '日本語.txt']) {
    const { name, changed, why } = safeName(fine);
    assert.equal(name, fine);
    assert.equal(changed, false);
    assert.equal(why, '');
  }
});

test('two names that Windows would treat as one never overwrite each other', () => {
  // Windows pays no attention to case, so these are the same file to it. Both ways round: the name being
  // asked for and the names already there can each be in any case.
  assert.equal(freeName('Notes.txt', ['notes.txt']), 'Notes (2).txt');
  assert.equal(freeName('notes.txt', ['NOTES.TXT']), 'notes (2).txt');
  assert.equal(freeName('notes.txt', ['NOTES.TXT', 'Notes (2).TXT']), 'notes (3).txt');
  assert.equal(freeName('notes.txt', []), 'notes.txt');
  assert.equal(freeName('notes.txt', ['notes.txt', 'notes (2).txt']), 'notes (3).txt');
  // The number goes before the ending, as Windows does it, and a double ending is kept whole.
  assert.equal(freeName('kit.tar.gz', ['kit.tar.gz']), 'kit (2).tar.gz');
  // A name with no ending at all.
  assert.equal(freeName('README', ['readme']), 'README (2)');
  // A name that is nothing but an ending.
  assert.equal(freeName('.bashrc', ['.bashrc']), '.bashrc (2)');
});

test('whatever a box calls a file, the name that lands is one Windows can hold', () => {
  // Every byte a name could be made of, in every place in a name, checked against the rules themselves rather
  // than against a list of cases somebody thought of.
  const pieces = ['a', '.', ' ', ':', '/', '\\', '<', '|', '\u0000', '\u001f', 'con', 'nul', 'lnk', '..'];
  const seen = new Set<string>();
  for (const one of pieces) {
    for (const two of pieces) {
      for (const three of pieces) {
        const from = one + two + three;
        const { name } = safeName(from);
        seen.add(name);
        assert.ok(name.length > 0 && name.length <= 255, `${JSON.stringify(from)} landed as ${JSON.stringify(name)}`);
        assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(name), `${JSON.stringify(from)} landed as ${JSON.stringify(name)}`);
        assert.ok(!/[ .]$/.test(name), `${JSON.stringify(from)} landed as ${JSON.stringify(name)}`);
        assert.ok(!['con', 'prn', 'aux', 'nul'].includes(name.split('.')[0]!.toLowerCase()), `${JSON.stringify(from)} landed as ${JSON.stringify(name)}`);
        assert.notEqual(name, '.');
        assert.notEqual(name, '..');
      }
    }
  }
  assert.ok(seen.size > 100, 'the run covered too little to mean anything');
});
