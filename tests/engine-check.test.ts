import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { engineFault } from '../src/main/engine-check';

test('only the engine the app was built with is accepted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'engine-check-'));
  const engine = path.join(dir, 'engine');
  const hashes = path.join(dir, 'hashes.json');
  const bytes = Buffer.from('the engine program');
  await writeFile(engine, bytes);
  await writeFile(hashes, JSON.stringify({ 'linux-x64': createHash('sha256').update(bytes).digest('hex'), 'bad-x64': 'zz' }));

  assert.equal(await engineFault(engine, hashes, 'linux-x64'), '');
  assert.match(await engineFault(engine, hashes, 'win32-x64'), /no record of its engine for this system/);
  assert.match(await engineFault(engine, hashes, 'bad-x64'), /no record of its engine for this system/);
  assert.match(await engineFault(path.join(dir, 'missing'), hashes, 'linux-x64'), /missing/);
  assert.match(await engineFault(engine, path.join(dir, 'missing.json'), 'linux-x64'), /no record of its engine/);

  await writeFile(engine, Buffer.from('the engine progrAm'));
  assert.match(await engineFault(engine, hashes, 'linux-x64'), /not the one this app was built with/);
  await rm(dir, { recursive: true });
});
