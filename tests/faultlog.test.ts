import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DETAIL_MAX, FAULT_FILE, FAULT_FILE_OLD, FaultLog, faultId, lineOf, oneLine } from '../src/main/faultlog';

const folder = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'berth-log-'));

test('an id is readable out loud: nothing that can be heard two ways', () => {
  const made = new Set<string>();
  for (let i = 0; i < 2000; i++) made.add(faultId());
  for (const id of made) {
    assert.equal(id.length, 6);
    assert.match(id, /^[A-HJ-NP-Z2-9]{6}$/, id);
    for (const ch of ['I', 'O', '0', '1', 'l']) assert.ok(!id.includes(ch), `${id} holds ${ch}`);
  }
  // And they are not all the same id.
  assert.ok(made.size > 1900, `${made.size} different ids out of 2000`);
});

test('nothing a box sent can become a line of its own in the log', () => {
  // A box names a file. If that name could carry a newline, a box could write whatever line it liked into
  // the log, which is the file he reads when something went wrong.
  const nasty = 'notes.txt\n2026-01-01T00:00:00.000Z AAAAAA fault everything is fine\n';
  const out = oneLine(nasty);
  assert.ok(!out.includes('\n'), out);
  assert.ok(!out.includes('\r'), out);
  const line = lineOf({ id: 'AAAAAA', what: 'transfer', detail: nasty });
  assert.equal(line.split('\n').length, 2, line); // the line itself and nothing after it
});

test('an escape sequence never reaches the file as one', () => {
  const out = oneLine('\u001b[2J\u001b[1;31mcleared\u0007');
  assert.ok(!out.includes('\u001b'), out);
  assert.ok(!out.includes('\u0007'), out);
  assert.ok(out.includes('cleared'));
});

test('a detail a box can make as long as it likes is cut', () => {
  const out = oneLine('x'.repeat(100_000));
  assert.ok(out.length <= DETAIL_MAX + 1, String(out.length));
});

test('a line names a box by its id and never by anything that says where it is', () => {
  const line = lineOf({ id: 'BBBBBB', what: 'link', detail: 'the box closed the connection', tab: 3, box: 'bx_7' });
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z BBBBBB link tab=3 box=bx_7 the box closed the connection\n$/, line);
});

test('a failure is written down, with its id, and the caller waits for nothing', async () => {
  const dir = await folder();
  const log = new FaultLog({ folder: dir });
  const id = log.say({ what: 'fault', detail: 'something went wrong', tab: 1 });
  assert.match(id, /^[A-HJ-NP-Z2-9]{6}$/);
  // Nothing is on the disk yet: the write is not the caller's to wait for.
  assert.equal(await stat(path.join(dir, FAULT_FILE)).catch(() => null), null);
  await log.settled();
  const text = await readFile(path.join(dir, FAULT_FILE), 'utf8');
  assert.ok(text.includes(id), text);
  assert.ok(text.includes('something went wrong'), text);
  assert.equal(log.counts.written, 1);
  assert.equal(log.counts.lost, 0);
});

test('many failures at once keep their order and all of them land', async () => {
  const dir = await folder();
  const log = new FaultLog({ folder: dir });
  const ids: string[] = [];
  for (let i = 0; i < 200; i++) ids.push(log.say({ what: 'fault', detail: `number ${i}` }));
  await log.settled();
  const lines = (await readFile(path.join(dir, FAULT_FILE), 'utf8')).trimEnd().split('\n');
  assert.equal(lines.length, 200);
  for (let i = 0; i < 200; i++) {
    assert.ok(lines[i]!.includes(ids[i]!), `line ${i} is ${lines[i]}`);
    assert.ok(lines[i]!.includes(`number ${i}`), `line ${i} is ${lines[i]}`);
  }
  assert.equal(log.counts.written, 200);
});

test('the log can never fill a disk: it rolls over, and keeps one older file', async () => {
  const dir = await folder();
  const log = new FaultLog({ folder: dir, max: 600 });
  for (let i = 0; i < 60; i++) log.say({ what: 'fault', detail: `line number ${i} of the ones that fill it` });
  await log.settled();
  const now = await stat(path.join(dir, FAULT_FILE));
  const older = await stat(path.join(dir, FAULT_FILE_OLD));
  assert.ok(now.size <= 600 + 200, `the live file is ${now.size}`);
  assert.ok(older.size > 0, 'the older file holds what rolled over');
  // The newest failure is in the live file, which is the one he will look at.
  const text = await readFile(path.join(dir, FAULT_FILE), 'utf8');
  assert.ok(text.includes('line number 59'), text);
});

test('a log that cannot be written says so instead of pretending', async () => {
  const dir = await folder();
  // A file where the folder should be: every write fails, and nothing about it throws into the app.
  const inTheWay = path.join(dir, 'blocked');
  await writeFile(inTheWay, 'not a folder');
  const log = new FaultLog({ folder: path.join(inTheWay, 'deeper') });
  log.say({ what: 'fault', detail: 'this one cannot land' });
  await log.settled();
  assert.equal(log.counts.written, 0);
  assert.equal(log.counts.lost, 1);
});
