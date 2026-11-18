import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { T } from '../src/common/frame';
import type { LinkInfo } from '../src/common/ipc';
import { Engine, type EngineAim, type SignRequest } from '../src/main/engine';

// A stand-in for the engine program: a small script that speaks frames. It says Hello, then plays its script:
// each step either sends a frame or waits a moment. Every SignReply and Ack it is sent, it sends back inside an
// Output frame, so the test sees exactly what main's side gave an engine.
type Step = [number, unknown] | number | 'exit';
function fakeEngine(steps: Step[]): { bin: string; hashes: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'berth-fake-engine-'));
  const bin = path.join(dir, 'engine');
  const source = `#!${process.execPath}
const steps = ${JSON.stringify(steps)};
const send = (type, body) => { const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); const h = Buffer.alloc(5); h.writeUInt32BE(b.length + 1); h[4] = type; process.stdout.write(Buffer.concat([h, b])); };
let buf = Buffer.alloc(0); let aimed = false;
process.stdin.on('data', (c) => { buf = Buffer.concat([buf, c]); for (;;) { if (buf.length < 4) return; const n = buf.readUInt32BE(0); if (buf.length < 4 + n) return; const type = buf[4]; const body = buf.subarray(5, 4 + n); buf = buf.subarray(4 + n);
  if (type === ${T.Aim} && !aimed) { aimed = true; send(${T.Hello}, { v: 1 }); play(0); }
  else if (type === ${T.Ping}) send(${T.Pong}, body);
  else if (type === ${T.SignReply}) send(${T.Output}, 'reply:' + body.toString());
  else if (type === ${T.Ack}) send(${T.Output}, 'ack:' + body.readBigUInt64BE(0)); } });
process.stdin.on('end', () => process.exit(0));
function play(i) { if (i >= steps.length) return; const s = steps[i]; if (s === 'exit') return setTimeout(() => process.exit(0), 20); if (typeof s === 'number') return setTimeout(() => play(i + 1), s); send(s[0], s[1] && s[1].raw !== undefined ? Buffer.from(s[1].raw, 'base64') : s[1]); play(i + 1); }
`;
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  const hashes = path.join(dir, 'hashes.json');
  writeFileSync(hashes, JSON.stringify({ [`${process.platform}-${process.arch}`]: createHash('sha256').update(source).digest('hex') }));
  return { bin, hashes };
}

const REAL: EngineAim = { stub: false, box: { addr: '203.0.113.58:22', user: 'deploy', hostKey: 'ssh-ed25519 AAAA', key: 'b0123456789abcdef', publicKey: 'ssh-ed25519 BBBB' }, shell: { folder: '', tmux: '', term: 'xterm-256color', cols: 120, rows: 40 } };

interface Run {
  engine: Engine;
  out: string[];
  links: LinkInfo[];
  signs: SignRequest[];
  banners: string[];
  states: string[];
}

// Every engine a test started is closed when the test file is done: none may keep the run alive.
const started: Engine[] = [];
after(() => {
  for (const e of started) e.close();
});

function run(steps: Step[], aim: EngineAim = REAL, sign: ((r: SignRequest) => Promise<{ signature: string } | { error: string }>) | null = async () => ({ signature: 'c2ln' })): Run {
  const { bin, hashes } = fakeEngine(steps);
  const r: Run = { engine: null as unknown as Engine, out: [], links: [], signs: [], banners: [], states: [] };
  r.engine = new Engine(bin, hashes, 3, {
    output: (b) => void r.out.push(Buffer.from(b).toString()),
    state: (s, cause) => void r.states.push(cause ? `${s}: ${cause}` : s),
    link: (l) => void r.links.push(l),
    banner: (b) => void r.banners.push(Buffer.from(b).toString()),
    ...(sign ? { sign: (req: SignRequest) => (r.signs.push(req), sign(req)) } : {}),
  }, aim);
  started.push(r.engine);
  void r.engine.start();
  return r;
}

async function until(what: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) return false;
    await new Promise((res) => setTimeout(res, 10));
  }
  return true;
}
const signReq = (id: number, more: object = {}): [number, unknown] => [T.SignRequest, { id, key: 'b0123456789abcdef', algorithm: 'ssh-ed25519', data: 'AAAA', ...more }];

test('a link is told phase by phase, and a signature is asked for only while signing in', async () => {
  const r = run([[T.State, { state: 'connecting' }], [T.State, { state: 'key-exchange' }], signReq(1), 30, [T.State, { state: 'signing-in' }], signReq(2), 30, [T.State, { state: 'up', keyExchange: 'mlkem768x25519-sha256', cipher: 'aes256-gcm@openssh.com', identityAlgorithm: 'ssh-ed25519', postQuantum: true }], signReq(3), 30, [T.Banner, 'Welcome\n'], [T.Pulse, { silent: false, rttMs: 41.6 }], [T.Pulse, { silent: true, sinceMs: 1763262000000 }], [T.Notice, { notice: 'waiting-on-window', on: true }], [T.Notice, { notice: 'typed-bytes-dropped', bytes: 512 }], [T.Exit, { status: 7 }]]);
  assert.ok(await until(() => r.engine.link.exitStatus === 7), JSON.stringify(r.engine.link));
  assert.deepEqual(r.links.map((l) => l.phase).filter((p, i, all) => p !== all[i - 1]), ['connecting', 'key-exchange', 'signing-in', 'up']);
  const l = r.engine.link;
  assert.deepEqual([l.keyExchange, l.cipher, l.postQuantum, l.rttMs, l.silentSinceMs, l.waitingOnWindow, l.droppedBytes], ['mlkem768x25519-sha256', 'aes256-gcm@openssh.com', true, 42, 1763262000000, true, 512]);
  assert.deepEqual(r.banners, ['Welcome\n']);
  // Three were asked; only the one that came while signing in reached whoever signs. The others were answered "refused".
  assert.ok(await until(() => r.out.length === 3));
  assert.deepEqual(r.signs, [{ key: 'b0123456789abcdef', algorithm: 'ssh-ed25519', data: 'AAAA' }]);
  assert.deepEqual(r.out.map((o) => JSON.parse(o.slice(6)) as unknown), [{ id: 1, error: 'refused' }, { id: 2, signature: 'c2ln' }, { id: 3, error: 'refused' }]);
  assert.deepEqual([r.engine.signAsked, r.engine.signRefused], [3, 2]);
  r.engine.close();
});

test('more than a few signature requests, or one that is not a sign-in\'s size or shape, are refused here', async () => {
  const many = run([[T.State, { state: 'signing-in' }], signReq(1), signReq(2), signReq(3), signReq(4), signReq(5), signReq(6)]);
  assert.ok(await until(() => many.out.length === 6));
  assert.deepEqual([many.signs.length, many.engine.signRefused], [4, 2]);
  many.engine.close();

  const odd = run([[T.State, { state: 'signing-in' }], signReq(1, { data: 'A'.repeat(8 * 1024 + 4) }), signReq(2, { data: '' }), signReq(3, { data: 'not base64!' }), signReq(4, { data: 5 })]);
  assert.ok(await until(() => odd.out.length === 4));
  assert.deepEqual([odd.signs.length, odd.engine.signRefused], [0, 4]);
  odd.engine.close();

  // Nobody to sign (a tab with no box): refused, never an error thrown.
  const nobody = run([[T.State, { state: 'signing-in' }], signReq(1)], REAL, null);
  assert.ok(await until(() => nobody.out.length === 1));
  assert.deepEqual(JSON.parse(nobody.out[0]!.slice(6)), { id: 1, error: 'refused' });
  nobody.engine.close();

  // Whoever signs fails: said as refused to the engine, and nothing is thrown.
  const failing = run([[T.State, { state: 'signing-in' }], signReq(1)], REAL, async () => Promise.reject(new Error('the key process is gone')));
  assert.ok(await until(() => failing.out.length === 1));
  assert.deepEqual(JSON.parse(failing.out[0]!.slice(6)), { id: 1, error: 'refused' });
  failing.engine.close();
});

test('how a link ended is said from a fixed list; what a box sent is cut and counted', async () => {
  const r = run([[T.State, { state: 'key-exchange' }], [T.State, { state: 'ended', cause: 'identity-changed', phase: 'key-exchange', gotFingerprint: 'SHA256:' + 'a'.repeat(43), got: 'ssh-ed25519 AAAA', detail: 'x'.repeat(5000) }], 'exit']);
  assert.ok(await until(() => r.engine.state === 'gone'));
  const l = r.engine.link;
  assert.deepEqual([l.phase, l.cause, l.endedIn, l.shownFingerprint, l.detail.length], ['ended', 'identity-changed', 'key-exchange', 'SHA256:' + 'a'.repeat(43), 300]);
  assert.deepEqual(r.states.at(-1), 'gone: the link ended');

  const weak = run([[T.State, { state: 'ended', cause: 'weak-offer', phase: 'key-exchange', what: 'cipher', ours: ['aes256-gcm@openssh.com'], box: [...Array(100).fill('x'.repeat(200)), 7, null] }]]);
  assert.ok(await until(() => weak.engine.link.phase === 'ended'));
  assert.deepEqual([weak.engine.link.what, weak.engine.link.ours, weak.engine.link.theirs.length, weak.engine.link.theirs[0]!.length], ['cipher', ['aes256-gcm@openssh.com'], 32, 80]);

  const invented = run([[T.State, { state: 'ended', cause: 'trust me, all is well', phase: 'up', gotFingerprint: '<b>SHA256</b>' }]]);
  assert.ok(await until(() => invented.engine.link.phase === 'ended'));
  assert.deepEqual([invented.engine.link.cause, invented.engine.link.shownFingerprint], ['protocol', '']);
});

test('a frame that cannot be what it claims ends the engine', async () => {
  for (const [what, step] of [
    ['a state that does not exist', [T.State, { state: 'all-good' }]],
    ['a state that is not JSON', [T.State, 'up']],
    ['a signature request with no id', [T.SignRequest, { key: 'k', algorithm: 'ssh-ed25519', data: 'AAAA' }]],
    ['a notice that does not exist', [T.Notice, { notice: 'please-run-this' }]],
    ['a key request, which only main sends', [T.KeyRequest, { op: 'keys' }]],
    ['a password frame', [T.Password, 'x']],
  ] as [string, [number, unknown]][]) {
    const r = run([step]);
    assert.ok(await until(() => r.engine.state === 'gone'), what);
    assert.equal(r.states.at(-1), 'gone: sent an unknown message', what);
  }
  // The skeleton's engine (no box) says none of a real engine's frames.
  const stub = run([[T.State, { state: 'up' }]], { stub: true });
  assert.ok(await until(() => stub.engine.state === 'gone'));
  assert.equal(stub.states.at(-1), 'gone: sent an unknown message');
  const stubSign = run([signReq(1)], { stub: true });
  assert.ok(await until(() => stubSign.engine.state === 'gone'));
  assert.equal(stubSign.signs.length, 0);
});

test('credit: the count a view reports is passed on only when it can be true', async () => {
  const r = run([[T.State, { state: 'up' }], [T.Output, 'x'.repeat(1000)], [T.Output, 'y'.repeat(500)]]);
  assert.ok(await until(() => r.out.join('').length === 1500));
  assert.equal(r.engine.taken(1501), false); // more than was ever handed on
  assert.equal(r.engine.taken(-1), false);
  assert.equal(r.engine.taken(1.5), false);
  assert.equal(r.engine.taken(Number.NaN), false);
  assert.equal(r.engine.taken(1000), true);
  assert.equal(r.engine.taken(1000), true); // said again: nothing new, nothing sent
  assert.equal(r.engine.taken(999), false); // never backwards
  assert.equal(r.engine.taken(1500), true);
  assert.ok(await until(() => r.out.filter((o) => o.startsWith('ack:')).length === 2));
  assert.deepEqual(r.out.filter((o) => o.startsWith('ack:')), ['ack:1000', 'ack:1500']);
  r.engine.close();

  // The skeleton's engine is never sent a count, and a true one is still accepted.
  const stub = run([[T.Output, 'abc']], { stub: true });
  assert.ok(await until(() => stub.out.join('') === 'abc'));
  assert.equal(stub.engine.taken(3), true);
  assert.equal(stub.engine.taken(4), false);
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(stub.out, ['abc']);
  stub.engine.close();
});

test('an engine is aimed with its one box, exactly as it was given', async () => {
  // The fake says back what it was aimed with, by ending with it as a fatal reason.
  const { bin, hashes } = (() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'berth-fake-engine-'));
    const bin = path.join(dir, 'engine');
    const source = `#!${process.execPath}
let buf = Buffer.alloc(0);
process.stdin.on('data', (c) => { buf = Buffer.concat([buf, c]); if (buf.length < 4) return; const n = buf.readUInt32BE(0); if (buf.length < 4 + n) return; const body = buf.subarray(5, 4 + n); const h = Buffer.alloc(5); h.writeUInt32BE(body.length + 1); h[4] = ${T.Output}; process.stdout.write(Buffer.concat([h, body])); });
process.stdin.on('end', () => process.exit(0));
`;
    writeFileSync(bin, source);
    chmodSync(bin, 0o755);
    const hashes = path.join(dir, 'hashes.json');
    writeFileSync(hashes, JSON.stringify({ [`${process.platform}-${process.arch}`]: createHash('sha256').update(source).digest('hex') }));
    return { bin, hashes };
  })();
  const got: string[] = [];
  const e = new Engine(bin, hashes, 9, { output: (b) => void got.push(Buffer.from(b).toString()), state: () => undefined }, REAL);
  started.push(e);
  void e.start();
  assert.ok(await until(() => got.length === 1));
  assert.deepEqual(JSON.parse(got[0]!), { v: 1, tab: '9', ...REAL });
  e.close();
});
