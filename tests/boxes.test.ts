import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { addrOf, checkFolder, checkHost, checkName, checkPlace, checkPort, checkUser, draftFaults, fingerprintsIn, firstConnectionBlock, isV6, portOf, type BoxDraft } from '../src/common/boxes';
import { Boxes, fingerprintOf, readBoxes, type Identify, type Reached } from '../src/main/boxes';
import type { KeyReply } from '../src/main/keyproc';

// A real ed25519 public key as one authorized-keys line, and its fingerprint worked out apart from the app's code.
function keyLine(): { line: string; fingerprint: string } {
  const der = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  const name = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([Buffer.from([0, 0, 0, name.length]), name, Buffer.from([0, 0, 0, 32]), raw]);
  return { line: `ssh-ed25519 ${blob.toString('base64')}`, fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` };
}

const draft = (change: Partial<BoxDraft> = {}): BoxDraft => ({ name: 'ledger-db', colour: 4, host: '203.0.113.58', port: '', user: 'deploy', folder: '/srv/ledger', places: [{ name: 'db', folder: '/srv/ledger/db' }, { name: '', folder: '' }], ...change });

// A stand-in for the key process: it makes key lines, keeps the saved public part, and can be told to fail.
class FakeKeys {
  held = new Map<string, { box: string; user: string; publicKey: string }>();
  saved: unknown = {};
  asked: { op: string; fields: Record<string, unknown> }[] = [];
  failOn = '';
  async request(op: string, fields: Record<string, unknown> = {}): Promise<KeyReply> {
    this.asked.push({ op, fields });
    if (op === this.failOn) return { ok: false, error: 'not-saved', detail: 'the disk is full' };
    if (op === 'newKey') {
      const publicKey = keyLine().line;
      this.held.set(String(fields['name']), { box: String(fields['box']), user: String(fields['user']), publicKey });
      return { ok: true, publicKey };
    }
    if (op === 'deleteKey') return this.held.delete(String(fields['key'])) ? { ok: true } : { ok: false, error: 'refused' };
    if (op === 'setPublic') {
      this.saved = JSON.parse(JSON.stringify(fields['public']));
      return { ok: true };
    }
    return { ok: false, error: 'unknown' };
  }
  infos(): unknown {
    return [...this.held].map(([name, k]) => ({ name, ...k }));
  }
}

function world(answer: () => Reached = () => ({ ok: false, cause: 'refused', phase: 'connecting', detail: '' })) {
  const keys = new FakeKeys();
  const asks: string[] = [];
  let cancelled = 0;
  let release: (() => void) | null = null;
  let hold = false;
  const identify: Identify = (addr, onPhase) => {
    asks.push(addr);
    onPhase('connecting');
    onPhase('key-exchange');
    const done = new Promise<Reached>((resolve) => {
      if (hold) {
        hold = false; // the next one only
        release = () => resolve(answer());
      } else resolve(answer());
    });
    return { done, cancel: () => void cancelled++ };
  };
  let changes = 0;
  const boxes = new Boxes(keys, identify, "run '{KEY}' here", () => void changes++, () => new Date('2026-11-16T03:00:00.250Z'));
  boxes.load({}, []);
  return { keys, boxes, asks, cancelled: () => cancelled, changes: () => changes, holdNext: () => (hold = true), release: () => release?.() };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('each field says what it understood, or what to fix, in the approved words', () => {
  assert.deepEqual(checkName('ledger-db', ['vault-ams']), { state: 'ok', text: 'free: no other box has it' });
  assert.equal(checkName('Vault-AMS', ['vault-ams']).state, 'fix');
  for (const bad of [' x', 'x ', '-x', 'a/b', 'a\u202eb', 'x'.repeat(33), 'a\tb']) assert.equal(checkName(bad, []).state, 'fix', JSON.stringify(bad));
  assert.equal(checkName('', []).state, 'hint');

  assert.deepEqual(checkHost('203.0.113.58'), { state: 'ok', text: 'an IP address' });
  assert.equal(checkHost('2001:db8::58').text, 'an IPv6 address');
  assert.equal(checkHost('db.example.net').state, 'ok');
  for (const bad of ['203.0.113', '203.0.113.256', 'a b', 'user@host', 'host:22', '-x.example', 'x..y', '[::1]', 'http://x', 'a\u0000b', '1::2::3', 'x'.repeat(254)]) assert.equal(checkHost(bad).state, 'fix', bad);
  for (const [h, want] of [['::1', true], ['2001:db8::', true], ['1:2:3:4:5:6:7:8', true], ['1:2:3:4:5:6:7', false], ['::ffff:203.0.113.5', true], ['12345::1', false], ['1:2:3:4:5:6:7:8:9', false]] as const) assert.equal(isV6(h), want, h);

  assert.deepEqual(checkPort(''), { state: 'hint', text: 'empty = 22' });
  assert.deepEqual([portOf(''), portOf('22'), portOf('65535'), portOf('65536'), portOf('0'), portOf('022'), portOf('2 2'), portOf('-1')], [22, 22, 65535, 0, 0, 0, 0, 0]);
  assert.deepEqual(checkUser('deploy'), { state: 'ok', text: 'a valid account name' });
  for (const bad of ['de ploy', 'a;b', '-x', 'x'.repeat(33), 'root\n', "a'b", '$(x)']) assert.equal(checkUser(bad).state, 'fix', JSON.stringify(bad));
  assert.deepEqual(checkFolder('var/backups/ledger'), { state: 'fix', text: 'a full path starts with /' });
  assert.equal(checkFolder("/srv/it's a $(place)").state, 'ok'); // quoting is the engine's work, proven there
  assert.equal(checkFolder('/a\nb').state, 'fix');
  assert.equal(checkPlace({ name: '', folder: '' }, []), null);
  assert.equal(checkPlace({ name: 'db', folder: '' }, [])?.state, 'fix');
  assert.equal(checkPlace({ name: 'db', folder: '/x' }, [{ name: 'DB', folder: '/y' }])?.state, 'fix');
  assert.deepEqual(draftFaults(draft(), []), {});
  assert.deepEqual(Object.keys(draftFaults(draft({ name: '', host: '', user: '', port: '99999', colour: 9, places: [{ name: 'a', folder: 'x' }] }), [])).sort(), ['colour', 'host', 'name', 'place-0', 'port', 'user']);
  assert.equal(addrOf({ host: '203.0.113.58', port: 22 }), '203.0.113.58:22');
  assert.equal(addrOf({ host: '2001:db8::58', port: 2201 }), '[2001:db8::58]:2201');
});

test('a paste is read for fingerprints only, as OpenSSH prints them', () => {
  const a = keyLine().fingerprint;
  const b = keyLine().fingerprint;
  const pasted = `256 ${a} root@ledger-db (ED25519)\n3072 ${b} root@ledger-db (RSA)\nMD5:aa:bb SHA256:short SHA256:${'x'.repeat(44)}\n`;
  assert.deepEqual(fingerprintsIn(pasted), [a, b]);
  assert.deepEqual(fingerprintsIn('x'.repeat(16 * 1024) + a), []); // past the size taken from a paste
  assert.deepEqual(fingerprintsIn(`SSHA256:${a.slice(7)}`), []);
});

test('the block is the approved text with the box\'s own key line in it, and nothing else can get in', () => {
  const k = keyLine().line;
  assert.equal(firstConnectionBlock("echo '{KEY}' >> f", k, "ledger db'; rm -rf /"), `echo '${k} berth:ledger-db---rm--rf--' >> f`);
  assert.throws(() => firstConnectionBlock("echo '{KEY}'", "ssh-ed25519 AAAA' ; rm -rf /", 'x'));
  assert.throws(() => firstConnectionBlock("echo '{KEY}'", `${k} comment`, 'x'));
});

test('adding a box makes its key, saves it unpinned, and leaves no key behind when the save fails', async () => {
  const w = world();
  const r = await w.boxes.add(draft());
  assert.equal(r.ok, true);
  const box = w.boxes.list[0]!;
  assert.match(box.id, /^b[0-9a-f]{16}$/);
  assert.deepEqual([box.name, box.port, box.user, box.pin, box.pinnedAt, box.places.length, box.created], ['ledger-db', 22, 'deploy', '', '', 1, '2026-11-16T03:00:00Z']);
  assert.deepEqual(w.keys.asked.map((a) => a.op), ['newKey', 'setPublic']);
  assert.deepEqual(w.keys.asked[0]!.fields, { name: box.id, box: box.id, user: 'deploy' });
  assert.deepEqual(readBoxes(w.keys.saved), w.boxes.list);

  // The same name again, a broken draft, something that is not a draft: nothing is asked of the key process.
  const before = w.keys.asked.length;
  assert.deepEqual(await w.boxes.add(draft()), { ok: false, error: 'fields', fields: { name: 'another box has this name' } });
  assert.equal((await w.boxes.add(draft({ name: 'two', host: 'a b' }))).ok, false);
  for (const bad of [null, 5, {}, { ...draft(), name: 7 }, { ...draft(), places: 'x' }, { ...draft(), places: [{ name: 1, folder: '/x' }] }]) assert.equal((await w.boxes.add(bad as BoxDraft)).ok, false);
  assert.equal(w.keys.asked.length, before);

  // The save fails: the key that was just made is removed again, and the list is as it was.
  w.keys.failOn = 'setPublic';
  const failed = await w.boxes.add(draft({ name: 'second' }));
  assert.equal(failed.ok, false);
  assert.equal(w.boxes.list.length, 1);
  assert.equal(w.keys.held.size, 1);
  assert.deepEqual(w.keys.asked.slice(-3).map((a) => a.op), ['newKey', 'setPublic', 'deleteKey']);
});

test('the check: the box\'s answer is kept back until a paste is compared; only a match can pin', async () => {
  const shown = keyLine();
  const w = world(() => ({ ok: true, type: 'ssh-ed25519', fingerprint: shown.fingerprint, key: shown.line }));
  const { id } = (await w.boxes.add(draft())) as { ok: true; id: string };
  assert.equal(w.boxes.block(id), `run '${w.boxes.get(id)!.publicKey} berth:ledger-db' here`);

  // Nothing checked yet: pasting or trusting does nothing.
  w.boxes.paste(id, `256 ${shown.fingerprint} x (ED25519)`);
  assert.equal(w.boxes.check(id).step, 'idle');
  assert.equal((await w.boxes.trust(id)).ok, false);

  w.holdNext();
  w.boxes.reach(id);
  assert.deepEqual([w.boxes.check(id).step, w.boxes.check(id).phase, w.asks[0]], ['reaching', 'key-exchange', '203.0.113.58:22']);
  w.boxes.paste(id, `256 ${shown.fingerprint} x (ED25519)`); // too early: there is nothing to compare with
  assert.equal(w.boxes.check(id).step, 'reaching');
  w.release();
  await settle();

  // Reached. What the box showed is nowhere in what a view may be told.
  const reached = w.boxes.check(id);
  assert.equal(reached.step, 'reached');
  assert.equal(JSON.stringify(reached).includes(shown.fingerprint.slice(7)), false);
  assert.equal(JSON.stringify(reached).includes(shown.line.slice(12)), false);
  assert.equal((await w.boxes.trust(id)).ok, false);

  // A paste with no identity line; then one from another box: what was pasted is shown, nothing is stored,
  // and what answered is still kept back. Printing it would put the one value this check exists to withhold
  // one copy away from the field it is compared against.
  w.boxes.paste(id, 'bash: ssh-keygen: command not found');
  assert.deepEqual([w.boxes.check(id).step, w.boxes.check(id).detail], ['reached', 'no identity line in what was pasted']);
  const other = keyLine().fingerprint;
  w.boxes.paste(id, `256 ${other} root@elsewhere (ED25519)`);
  const mismatch = w.boxes.check(id);
  assert.deepEqual([mismatch.step, mismatch.shownType, mismatch.shownFingerprint, mismatch.pasted], ['mismatch', 'ssh-ed25519', '', [other]]);
  assert.equal(JSON.stringify(mismatch).includes(shown.fingerprint.slice(7)), false);
  assert.equal((await w.boxes.trust(id)).ok, false);
  assert.equal(w.boxes.get(id)!.pin, '');

  // The right paste: a match, and only then can it be pinned.
  w.boxes.paste(id, `256 ${other} x (ECDSA)\n256 ${shown.fingerprint} root@ledger-db (ED25519)\n`);
  assert.deepEqual([w.boxes.check(id).step, w.boxes.check(id).shownType, w.boxes.check(id).shownFingerprint], ['match', 'ssh-ed25519', shown.fingerprint]);
  // A match that a later paste takes back cannot be trusted any more.
  w.boxes.paste(id, `256 ${other} x (ED25519)`);
  assert.equal((await w.boxes.trust(id)).ok, false);
  w.boxes.paste(id, `256 ${shown.fingerprint} x (ED25519)`);
  assert.deepEqual(await w.boxes.trust(id), { ok: true, id });
  const pinned = w.boxes.get(id)!;
  assert.deepEqual([pinned.pin, pinned.pinFingerprint, pinned.pinnedAt], [shown.line, shown.fingerprint, '2026-11-16T03:00:00Z']);
  assert.deepEqual(readBoxes(w.keys.saved), w.boxes.list);
  assert.equal(w.boxes.check(id).step, 'idle');
  assert.equal((await w.boxes.trust(id)).ok, false); // once: a pin is not made twice from one check
});

test('an answer that is not this key\'s own fingerprint is no answer; an unreachable box says why', async () => {
  const a = keyLine();
  const b = keyLine();
  for (const lie of [
    { ok: true, type: 'ssh-ed25519', fingerprint: b.fingerprint, key: a.line }, // another key's fingerprint
    { ok: true, type: 'ssh-rsa', fingerprint: a.fingerprint, key: a.line }, // the kind does not match the key
    { ok: true, type: 'ssh-ed25519', fingerprint: a.fingerprint, key: `${a.line} extra` },
    { ok: true, type: 'ssh-ed25519', fingerprint: 'SHA256:short', key: a.line },
  ] as Reached[]) {
    const w = world(() => lie);
    const { id } = (await w.boxes.add(draft())) as { ok: true; id: string };
    w.boxes.reach(id);
    await settle();
    assert.deepEqual([w.boxes.check(id).step, w.boxes.check(id).cause], ['unreachable', 'protocol']);
    w.boxes.paste(id, `256 ${a.fingerprint} x (ED25519)\n256 ${b.fingerprint} x (ED25519)`);
    assert.equal((await w.boxes.trust(id)).ok, false);
  }
  assert.equal(fingerprintOf(a.line), a.fingerprint);

  const w = world(() => ({ ok: false, cause: 'weak-offer', phase: 'key-exchange', detail: 'x', what: 'cipher', ours: ['aes256-gcm@openssh.com'], box: ['chacha20-poly1305@openssh.com'] }));
  const { id } = (await w.boxes.add(draft())) as { ok: true; id: string };
  w.boxes.reach(id);
  await settle();
  const v = w.boxes.check(id);
  assert.deepEqual([v.step, v.cause, v.what, v.ours, v.theirs], ['unreachable', 'weak-offer', 'cipher', ['aes256-gcm@openssh.com'], ['chacha20-poly1305@openssh.com']]);
});

test('a check that was replaced or cancelled cannot answer late; removing a box removes its key', async () => {
  const first = keyLine();
  const second = keyLine();
  let which = first;
  const w = world(() => ({ ok: true, type: 'ssh-ed25519', fingerprint: which.fingerprint, key: which.line }));
  const { id } = (await w.boxes.add(draft())) as { ok: true; id: string };
  w.holdNext();
  w.boxes.reach(id);
  const lateAnswer = w.release;
  w.boxes.cancelCheck(id);
  assert.equal(w.cancelled(), 1);
  const told = w.changes();
  lateAnswer();
  await settle();
  assert.equal(w.boxes.check(id).step, 'idle');
  assert.equal(w.changes(), told); // and nobody is told anything on its account

  // Asked again: only the newest answer counts.
  which = second;
  w.boxes.reach(id);
  await settle();
  w.boxes.paste(id, `256 ${first.fingerprint} x (ED25519)`);
  assert.equal(w.boxes.check(id).step, 'mismatch');

  assert.deepEqual(await w.boxes.remove(id), { ok: true, id });
  assert.deepEqual([w.boxes.list.length, w.keys.held.size, w.boxes.check(id).step], [0, 0, 'idle']);
  assert.equal((await w.boxes.remove(id)).ok, false);
});

test('what was saved is read back whole or not at all, and a box must be with its own key', async () => {
  const w = world();
  await w.boxes.add(draft());
  await w.boxes.add(draft({ name: 'vault-ams', host: 'vault.example.net', port: '2201', places: [] }));
  const saved = JSON.parse(JSON.stringify(w.keys.saved)) as { v: number; boxes: Record<string, unknown>[] };
  assert.equal(readBoxes(saved)?.length, 2);
  assert.deepEqual(readBoxes({}), []);
  const broken: [string, (s: typeof saved) => void][] = [
    ['another version', (s) => void (s.v = 2)],
    ['an id of another shape', (s) => void (s.boxes[0]!['id'] = 'x')],
    ['the same id twice', (s) => void (s.boxes[1]!['id'] = s.boxes[0]!['id'])],
    ['the same name twice', (s) => void (s.boxes[1]!['name'] = 'LEDGER-DB')],
    ['a port that is none', (s) => void (s.boxes[0]!['port'] = 70000)],
    ['a host that is none', (s) => void (s.boxes[0]!['host'] = 'a b')],
    ['a folder that is no full path', (s) => void (s.boxes[0]!['folder'] = 'srv')],
    ['a key that is no key line', (s) => void (s.boxes[0]!['publicKey'] = 'ssh-ed25519 x')],
    ['a pin with no fingerprint', (s) => void (s.boxes[0]!['pin'] = s.boxes[0]!['publicKey'])],
    ['a fingerprint with no pin', (s) => void (s.boxes[0]!['pinFingerprint'] = keyLine().fingerprint)],
    // What is enforced is the pinned key; what is shown is the fingerprint beside it. A saved box whose two
    // do not belong together would show one identity and enforce another.
    ['a fingerprint that is not the pinned key\'s', (s) => {
      s.boxes[0]!['pin'] = s.boxes[0]!['publicKey'];
      s.boxes[0]!['pinnedAt'] = '2026-11-16T03:00:00Z';
      s.boxes[0]!['pinFingerprint'] = keyLine().fingerprint;
    }],
    ['a missing field', (s) => void delete s.boxes[0]!['user']],
    ['places that are no list', (s) => void (s.boxes[0]!['places'] = 'x')],
    ['a half-filled place', (s) => void (s.boxes[0]!['places'] = [{ name: 'db', folder: '' }])],
    ['a colour that is none', (s) => void (s.boxes[0]!['colour'] = 0)],
    ['no list at all', (s) => void ((s as unknown as { boxes: unknown }).boxes = null)],
  ];
  for (const [what, change] of broken) {
    const copy = JSON.parse(JSON.stringify(saved)) as typeof saved;
    change(copy);
    assert.equal(readBoxes(copy), null, what);
  }

  // Loaded again as after an unlock: each box must come with the key the key process holds for it.
  const again = new Boxes(w.keys, () => ({ done: new Promise(() => undefined), cancel: () => undefined }), '{KEY}', () => undefined);
  again.load(saved, w.keys.infos());
  assert.deepEqual([again.fault, again.list.length], ['', 2]);
  const id = w.boxes.list[0]!.id;
  for (const change of [(k: FakeKeys) => void k.held.delete(id), (k: FakeKeys) => void (k.held.get(id)!.user = 'root'), (k: FakeKeys) => void (k.held.get(id)!.publicKey = keyLine().line), (k: FakeKeys) => void (k.held.get(id)!.box = 'b0000000000000000')]) {
    const k2 = new FakeKeys();
    for (const [name, v] of w.keys.held) k2.held.set(name, { ...v });
    change(k2);
    again.load(saved, k2.infos());
    assert.equal(again.list.length, 0);
    assert.match(again.fault, /do not belong together/);
    assert.equal((await again.add(draft({ name: 'third' }))).ok, false); // nothing is added on top of a list that could not be read
  }
  again.load({ v: 3 }, []);
  assert.match(again.fault, /cannot be read/);
});
