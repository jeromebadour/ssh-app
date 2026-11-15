import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeFrame, FrameDecoder, FrameError, MAX_PAYLOAD, T } from '../src/common/frame';

interface Vectors {
  max_payload: number;
  valid: { name: string; type: number; body: string; frame: string }[];
  invalid: { name: string; bytes: string; error: string }[];
}

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const vectors = JSON.parse(await readFile(new URL('../../protocol/vectors.json', import.meta.url), 'utf8')) as Vectors;

test('the limit matches the vectors file', () => {
  assert.equal(MAX_PAYLOAD, vectors.max_payload);
});

test('valid vectors encode and decode', () => {
  assert.ok(vectors.valid.length > 0);
  for (const c of vectors.valid) {
    assert.deepEqual(encodeFrame(c.type, hex(c.body)), hex(c.frame), c.name);
    const got = new FrameDecoder().push(hex(c.frame));
    assert.equal(got.length, 1, c.name);
    assert.equal(got[0]!.type, c.type, c.name);
    assert.deepEqual(got[0]!.body, hex(c.body), c.name);
  }
});

test('invalid vectors are refused with the right reason', () => {
  assert.ok(vectors.invalid.length > 0);
  for (const c of vectors.invalid) {
    const d = new FrameDecoder();
    assert.throws(
      () => {
        d.push(hex(c.bytes));
        d.end();
      },
      (e: unknown) => e instanceof FrameError && e.kind === c.error,
      c.name,
    );
  }
});

test('frames split at every byte still decode, in order', () => {
  const all = Buffer.concat(vectors.valid.map((c) => Buffer.from(c.frame, 'hex')));
  const d = new FrameDecoder();
  const got = [];
  for (const byte of all) got.push(...d.push(Uint8Array.of(byte)));
  d.end();
  assert.deepEqual(
    got.map((f) => [f.type, Buffer.from(f.body).toString('hex')]),
    vectors.valid.map((c) => [c.type, c.body]),
  );
});

test('many frames in one chunk decode', () => {
  const all = Buffer.concat(vectors.valid.map((c) => Buffer.from(c.frame, 'hex')));
  assert.equal(new FrameDecoder().push(Uint8Array.from(all)).length, vectors.valid.length);
});

test('the largest frame round-trips and one byte more is refused', () => {
  const body = new Uint8Array(MAX_PAYLOAD - 1).fill(7);
  const got = new FrameDecoder().push(encodeFrame(T.Output, body));
  assert.equal(got[0]!.body.byteLength, MAX_PAYLOAD - 1);
  assert.throws(() => encodeFrame(T.Output, new Uint8Array(MAX_PAYLOAD)), FrameError);
});

test('a decoder that failed stays failed', () => {
  const d = new FrameDecoder();
  assert.throws(() => d.push(hex('00000000')), FrameError);
  assert.throws(() => d.push(hex('0000000103')), FrameError);
});
