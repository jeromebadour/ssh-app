// The zip writer (scripts/lib/zip.mjs): what it writes is read back here, byte for byte, by a reader that
// shares none of its code, and the same tree twice must make the same bytes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
// @ts-expect-error a plain script module without types
import { writeZip } from '../scripts/lib/zip.mjs';

// A reader of the format, written from the format and not from the writer.
function read(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, 'no end record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'no central header');
    const method = buf.readUInt16LE(at + 10);
    const sum = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const where = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;

    assert.equal(buf.readUInt32LE(where), 0x04034b50, `no local header for ${name}`);
    const localName = buf.readUInt16LE(where + 26);
    const localExtra = buf.readUInt16LE(where + 28);
    const from = where + 30 + localName + localExtra;
    const raw = buf.subarray(from, from + packed);
    const body = method === 0 ? raw : inflateRawSync(raw);
    assert.equal(body.byteLength, size, `${name}: the size does not match`);
    assert.equal(crc32(body), sum, `${name}: the checksum does not match`);
    out.set(name, Buffer.from(body));
  }
  return out;
}

test('what it writes reads back, and folders are in it', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'zip-'));
  const tree = path.join(work, 'Berth-0.0.0');
  await mkdir(path.join(tree, 'app', 'resources'), { recursive: true });
  const big = Buffer.alloc(200_000, 'A'); // squashes well
  const odd = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
  await writeFile(path.join(tree, 'README.txt'), 'two lines\r\nand a return\r\n');
  await writeFile(path.join(tree, 'app', 'program.exe'), odd);
  await writeFile(path.join(tree, 'app', 'resources', 'app.asar'), big);
  await writeFile(path.join(tree, 'app', 'empty'), '');

  const zip = path.join(work, 'out.zip');
  const made = await writeZip(zip, tree);
  assert.equal(made.files, 4);
  const held = read(await readFile(zip));
  assert.equal(held.get('Berth-0.0.0/README.txt')!.toString('utf8'), 'two lines\r\nand a return\r\n');
  assert.deepEqual([...held.get('Berth-0.0.0/app/program.exe')!], [...odd]);
  assert.equal(held.get('Berth-0.0.0/app/resources/app.asar')!.byteLength, big.byteLength);
  assert.equal(held.get('Berth-0.0.0/app/empty')!.byteLength, 0);
  for (const folder of ['Berth-0.0.0/', 'Berth-0.0.0/app/', 'Berth-0.0.0/app/resources/']) {
    assert.ok(held.has(folder), `${folder} is not in it`);
  }
  // Something that squashes must be smaller in the file than out of it.
  assert.ok((await readFile(zip)).byteLength < big.byteLength, 'nothing was squashed');
  await rm(work, { recursive: true, force: true });
});

test('the same tree twice makes the same bytes', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'zip-'));
  const tree = path.join(work, 'same');
  await mkdir(path.join(tree, 'a'), { recursive: true });
  await writeFile(path.join(tree, 'a', 'one'), 'one');
  await writeFile(path.join(tree, 'two'), 'two');
  const first = path.join(work, 'first.zip');
  const second = path.join(work, 'second.zip');
  await writeZip(first, tree);
  await new Promise((r) => setTimeout(r, 1100)); // a different second on the clock
  await writeFile(path.join(tree, 'two'), 'two'); // written again, so its time on disk is new
  await writeZip(second, tree);
  assert.deepEqual([...(await readFile(first))], [...(await readFile(second))]);
  await rm(work, { recursive: true, force: true });
});
