import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error a plain script module without types
import { buildAsar, readAsar } from '../scripts/lib/asar.mjs';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

async function tree(files: Record<string, Uint8Array | string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asar-test-'));
  for (const [rel, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), data);
  }
  return dir;
}

test('every file comes back byte for byte, and the header hash is the hash of the header text', async () => {
  const big = new Uint8Array(4 * 1024 * 1024 + 123).map((_, i) => (i * 31) & 0xff);
  const files = { 'package.json': '{"main":"dist/main.js"}', 'dist/main.js': 'console.log(1)', 'dist/tab/tab.css': '', 'dist/big.bin': big };
  const dir = await tree(files);
  const built = await buildAsar(dir);
  const back = readAsar(built.bytes);
  assert.equal(back.files.size, 4);
  for (const [rel, data] of Object.entries(files)) assert.deepEqual(new Uint8Array(back.files.get(rel)), typeof data === 'string' ? new TextEncoder().encode(data) : data, rel);
  assert.equal(back.headerHash, built.headerHash);
  assert.equal(built.headerHash, sha(back.header));
  const header = JSON.parse(back.header);
  const bigNode = header.files.dist.files['big.bin'];
  assert.equal(bigNode.integrity.algorithm, 'SHA256');
  assert.equal(bigNode.integrity.hash, sha(big));
  assert.equal(bigNode.integrity.blocks.length, 2);
  assert.equal(bigNode.integrity.blocks[1], sha(big.subarray(4 * 1024 * 1024)));
  assert.equal(header.files.dist.files.tab.files['tab.css'].integrity.blocks.length, 1);
  await rm(dir, { recursive: true });
});

test('the layout is the official one', async () => {
  const dir = await tree({ a: 'xyz' });
  const { bytes } = await buildAsar(dir);
  const jsonLen = bytes.readInt32LE(12);
  const padded = (jsonLen + 3) & ~3;
  assert.equal(bytes.readUInt32LE(0), 4);
  assert.equal(bytes.readUInt32LE(4), 8 + padded);
  assert.equal(bytes.readUInt32LE(8), 4 + padded);
  assert.equal(bytes.length, 16 + padded + 3);
  assert.equal(bytes.subarray(16 + padded).toString(), 'xyz');
  await rm(dir, { recursive: true });
});

test('the same files give the same bytes, whatever order they were created in', async () => {
  const one = await tree({ 'b.txt': 'two', 'a.txt': 'one', 'z/k': 'three' });
  const two = await tree({ 'z/k': 'three', 'a.txt': 'one', 'b.txt': 'two' });
  assert.equal(sha((await buildAsar(one)).bytes), sha((await buildAsar(two)).bytes));
  const three = await tree({ 'z/k': 'three', 'a.txt': 'onE', 'b.txt': 'two' });
  assert.notEqual((await buildAsar(one)).headerHash, (await buildAsar(three)).headerHash);
  for (const d of [one, two, three]) await rm(d, { recursive: true });
});
