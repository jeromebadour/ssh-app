import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { firstVisitWith } from '../src/main/firstvisit';

// A box that asks its own questions at sign-in and then says nothing more. It is the engine's side of the
// first visit, in as few lines as the protocol allows: a frame is a 4-byte big-endian length, then a type
// byte and the body. It writes the phases, asks one question, and once an answer has come back it goes quiet
// for ever without ending. That is the shape of the fault: a visit that never ends.
const aBoxThatGoesQuiet = `
let said = 0;
const frame = (type, body) => {
  const b = Buffer.from(JSON.stringify(body));
  const out = Buffer.alloc(5 + b.length);
  out.writeUInt32BE(b.length + 1, 0);
  out[4] = type;
  b.copy(out, 5);
  return out;
};
process.stdin.on('data', () => {
  said++;
  if (said === 1) {
    process.stdout.write(frame(0x20, { state: 'connecting' }));
    process.stdout.write(frame(0x27, { questions: ['the code from your phone'], show: [true] }));
  }
  // The answers came back on the second thing said to us, and nothing is written ever again.
});
// And it gives up on its own after a while, so that a limit which never comes back fails this probe with
// what the visit really said instead of hanging a whole test run on the fault it is looking for.
setTimeout(() => process.exit(0), 4000);
`;

async function aFakeEngine(dir: string, body: string): Promise<{ bin: string; hashes: string }> {
  // Spawned with no environment at all, so the shebang must be a whole path and not "env node".
  const bin = path.join(dir, 'engine.mjs');
  await writeFile(bin, `#!${process.execPath}\n${body}`);
  await chmod(bin, 0o755);
  const hashes = path.join(dir, 'hashes.json');
  await writeFile(hashes, JSON.stringify({ [`${process.platform}-${process.arch}`]: createHash('sha256').update(await readFile(bin)).digest('hex') }));
  return { bin, hashes };
}

// The visit's own limit is put down while a box's questions are on the screen and must really be there again
// once they are answered. This drives firstVisitWith itself, not a copy of the way it arms the limit: the
// fault was one line of that function, and with refresh() put back in its place this probe waits for ever
// and fails on its own time instead of coming back "timed-out".
test('a visit that never ends after its questions were answered still runs out of time', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'visit-limit-'));
  const { bin, hashes } = await aFakeEngine(dir, aBoxThatGoesQuiet);
  const phases: string[] = [];
  let asked: string[] = [];

  const began = Date.now();
  const visit = firstVisitWith(bin, hashes, 300);
  const got = await visit(
    { addr: '10.0.0.1:22', user: 'demo', hostKey: 'AAAA' },
    'a password',
    'echo hello',
    (p) => void phases.push(p),
    async (questions) => {
      asked = questions;
      // As long as a person reading a code off a phone: longer than the limit, which is why it is put down.
      await new Promise((go) => setTimeout(go, 700));
      return ['123456'];
    },
  );
  const took = Date.now() - began;

  assert.deepEqual(asked, ['the code from your phone'], 'the box’s own question did not reach the screen');
  assert.deepEqual(phases, ['connecting'], `the phases were ${JSON.stringify(phases)}`);
  assert.equal(got.ok, false);
  // "protocol ... ended with code 0 and no answer" here means the limit never came back and the box gave up
  // first: the visit itself had nothing counting against it at all.
  assert.equal(got.ok === false && got.cause, 'timed-out', `the visit came back ${JSON.stringify(got)}`);
  // It did not run out while he was answering, and it did run out afterwards: both halves of the limit being
  // put down and taken up again.
  assert.ok(took >= 700, `it ran out after ${took}ms, while he was still answering`);
  assert.ok(took < 5000, `it took ${took}ms, which is not the limit it was given`);

  await rm(dir, { recursive: true, force: true });
});
