// The boxes (plan B2.3, B2.4): main's part of the locked list, and the first-connection check.
//
// Main holds the list of boxes while unlocked, without their keys. A box's key is made by the key process and
// stays there; here a box only names it. Every change is saved through the key process at once, and what is in
// memory is never ahead of what was saved.
//
// The check, in order, with nothing skipped:
//   1. reach(): one engine asks the box who it is. What it answers is kept here and shown to no one.
//   2. paste(): what the box itself printed, in a trusted place, is pasted. Only now are the two compared.
//      A match may be shown; a mismatch says they differ without printing what answered, and nothing is stored.
//   3. trust(): only after a match, and only for the very identity that matched, the box is pinned.
// A box that is not pinned cannot be connected to: there is no other way to a first sign-in.
import { SETTINGS_DEFAULT, type AppSettings } from '../common/ipc';
import { createHash, randomBytes } from 'node:crypto';
import { BOXES_MAX, BOX_COLOURS, FINGERPRINT, KEY_LINE, addrOf, draftFaults, fingerprintsIn, firstConnectionBlock, folderFault, placesOf, portOf, type Box, type BoxDraft } from '../common/boxes';
import type { KeyReply } from './keyproc';

export interface Keys {
  request(op: string, fields?: Record<string, unknown>): Promise<KeyReply>;
}

// What asking a box who it is came to.
export type Reached = { ok: true; type: string; fingerprint: string; key: string } | { ok: false; cause: string; phase: string; detail: string; what?: string; ours?: string[]; box?: string[] };
export type Identify = (addr: string, onPhase: (phase: string) => void) => { done: Promise<Reached>; cancel(): void };

// Where a box's check stands, as it may be told to the shell view. The identity the box showed is in here only
// once a paste has been compared with it.
export interface CheckView {
  boxId: string;
  step: 'idle' | 'reaching' | 'reached' | 'unreachable' | 'match' | 'mismatch';
  phase: string; // reaching: connecting, key-exchange
  cause: string; // unreachable: the one cause
  detail: string;
  what: string; // unreachable for a weak offer: which list
  ours: string[];
  theirs: string[]; // text from the box: shown escaped, marked as the box's
  shownType: string; // match or mismatch: what the box at that address showed
  shownFingerprint: string;
  pasted: string[]; // mismatch: the fingerprints found in the paste
}

interface Checking {
  view: CheckView;
  reached: Extract<Reached, { ok: true }> | null;
  matched: string; // the key line that matched a paste; empty until one did
  cancel: (() => void) | null;
}

export type Result = { ok: true; id: string } | { ok: false; error: string; fields?: Record<string, string>; code?: string };

const blank = (boxId: string): CheckView => ({ boxId, step: 'idle', phase: '', cause: '', detail: '', what: '', ours: [], theirs: [], shownType: '', shownFingerprint: '', pasted: [] });

export class Boxes {
  list: Box[] = [];
  // The app's own settings live in the same locked list as the boxes, and are written by the same save, so a
  // change to one can never drop the other (which is what a second writer of the same file would do).
  settings: AppSettings = { ...SETTINGS_DEFAULT };
  loaded = false;
  fault = ''; // the list opened but its boxes could not be read: said, and nothing is overwritten
  faultId = ''; // the id of that fault's line in the local log, so the window can say which failure it is
  private readonly checks = new Map<string, Checking>();
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly keys: Keys,
    private readonly identify: Identify,
    private readonly blockTemplate: string,
    private readonly changed: () => void,
    private readonly now: () => Date = () => new Date(),
    // How a failure of the list itself is written down. It is given from outside so this class knows nothing
    // of files, and it is handed the app's own words and a box's id, never a box's name: the log is read by
    // whoever can read that folder (src/main/faultlog.ts says why).
    private readonly writeDown: (f: { what: string; detail: string; box?: string }) => string = () => '',
  ) {}

  // One failure of the list itself: said in the window, and written down with an id the window can say.
  private wentWrong(said: string, logged: string, box?: string): void {
    this.fault = said;
    this.faultId = this.writeDown({ what: 'boxes', detail: logged, ...(box ? { box } : {}) });
  }

  // After unlock: what the key process opened. The key names it holds must be the boxes' own, one each.
  load(publicPart: unknown, keyInfos: unknown): void {
    this.list = [];
    this.fault = '';
    this.faultId = '';
    this.checks.clear();
    this.settings = readSettings(publicPart);
    const boxes = readBoxes(publicPart);
    if (!boxes) this.wentWrong('the list of boxes inside the locked list cannot be read', 'the list opened but its boxes could not be read');
    else {
      const held = new Map<string, { box: string; user: string; publicKey: string }>();
      if (Array.isArray(keyInfos)) {
        for (const k of keyInfos as Record<string, unknown>[]) {
          if (typeof k?.['name'] === 'string') held.set(k['name'], { box: String(k['box']), user: String(k['user']), publicKey: String(k['publicKey']) });
        }
      }
      for (const b of boxes) {
        const k = held.get(b.id);
        if (!k || k.box !== b.id || k.user !== b.user || k.publicKey !== b.publicKey) {
          this.wentWrong(`the box "${b.name}" and its key do not belong together`, 'a box and its key do not belong together', b.id);
          this.list = [];
          break;
        }
        this.list.push(b);
      }
    }
    this.loaded = true;
    this.changed();
  }

  get(id: string): Box | undefined {
    return this.list.find((b) => b.id === id);
  }

  // Add box: the fields are checked, the key process makes the box's key, and the box is saved, not yet pinned.
  // Adding a box. Its key is either one the key process makes for it, or one brought in from a file the person
  // already has (plan O1), which is what lets a box be added without another program: his boxes already hold
  // his public key, so bringing in the private half is a way in that needs nothing run on the box.
  //
  // `withKey` is the file's own bytes and its passphrase, which reach here from main and go straight to the key
  // process. Nothing of a key file is ever told to a view.
  add(draft: BoxDraft, withKey?: { file: Buffer; passphrase: Buffer }): Promise<Result> {
    return this.oneAtATime(async () => {
      if (!this.loaded || this.fault) return { ok: false, error: this.fault || 'locked' };
      const d = cleanDraft(draft);
      if (!d) return { ok: false, error: 'not a box' };
      const fields = draftFaults(d, this.list.map((b) => b.name));
      if (Object.keys(fields).length > 0) return { ok: false, error: 'fields', fields };
      if (this.list.length >= BOXES_MAX) return { ok: false, error: `${BOXES_MAX} boxes at most` };
      const id = `b${randomBytes(8).toString('hex')}`;
      const made = withKey
        ? await this.keys.request('takeKey', { name: id, box: id, user: d.user, file: withKey.file.toString('base64'), passphrase: withKey.passphrase.toString('base64') })
        : await this.keys.request('newKey', { name: id, box: id, user: d.user });
      const publicKey = made['publicKey'];
      if (!made.ok || typeof publicKey !== 'string' || !KEY_LINE.test(publicKey)) {
        const what = withKey ? 'the key file could not be used' : 'the key could not be made';
        return { ok: false, error: `${what}: ${String(made.detail ?? made.error ?? 'no key came back')}`, code: String(made.error ?? '') };
      }
      const box: Box = { id, name: d.name, colour: d.colour, host: d.host, port: portOf(d.port), user: d.user, folder: d.folder, places: placesOf(d), publicKey, pin: '', pinFingerprint: '', pinnedAt: '', created: this.stamp() };
      const saved = await this.save([...this.list, box]);
      if (!saved.ok) {
        // No box was saved: its key must not be left behind. If that cannot be done either, the key process
        // holds a key no box knows about, and that is said here and now, not found out later.
        const undone = await this.keys.request('deleteKey', { key: id });
        const also = undone.ok ? '' : `. Its key could not be taken out again (${String(undone.detail ?? undone.error ?? '')}): a key with no box is in the list`;
        if (!undone.ok) this.wentWrong(`a key was made for "${d.name}" and the box could not be saved, and the key could not be taken out again`, 'a key was made, the box could not be saved, and the key could not be taken out again');
        return { ok: false, error: `not saved: ${String(saved.detail ?? saved.error ?? '')}${also}` };
      }
      return { ok: true, id };
    });
  }

  // Edit box: everything about a box but its key and its id. Two changes are not just fields:
  //   - its user: the key is bound to one user on one box, so the key process is told to bind it anew;
  //   - its address: an address that changes may be another machine, so the identity pinned for the old one
  //     is forgotten and the box is checked again before it can be opened.
  // Nothing is saved unless every field is right, and the key is never remade.
  edit(id: string, draft: BoxDraft): Promise<Result> {
    return this.oneAtATime(async () => {
      if (!this.loaded || this.fault) return { ok: false, error: this.fault || 'locked' };
      const was = this.get(id);
      if (!was) return { ok: false, error: 'no such box' };
      const d = cleanDraft(draft);
      if (!d) return { ok: false, error: 'not a box' };
      const fields = draftFaults(d, this.list.filter((b) => b.id !== id).map((b) => b.name));
      if (Object.keys(fields).length > 0) return { ok: false, error: 'fields', fields };
      const moved = d.host !== was.host || portOf(d.port) !== was.port;
      const next: Box = { ...was, name: d.name, colour: d.colour, host: d.host, port: portOf(d.port), user: d.user, folder: d.folder, places: placesOf(d) };
      if (moved) {
        next.pin = '';
        next.pinFingerprint = '';
        next.pinnedAt = '';
      }
      if (d.user !== was.user) {
        const bound = await this.keys.request('rebind', { key: id, box: id, user: d.user });
        if (!bound.ok) return { ok: false, error: `its key could not be bound to ${d.user}: ${String(bound.detail ?? bound.error ?? '')}` };
      }
      const saved = await this.save(this.list.map((b) => (b.id === id ? next : b)));
      if (!saved.ok) {
        // The list was not written: put the key's user back, so what the key process holds matches the list.
        // If that fails too, the two no longer agree, and the next start would empty the whole list without
        // ever saying why. It is said now instead, while the person is still here.
        let also = '';
        if (d.user !== was.user) {
          const back = await this.keys.request('rebind', { key: id, box: id, user: was.user });
          if (!back.ok) {
            this.wentWrong(`the key for "${was.name}" is bound to ${d.user} and the saved box still says ${was.user}`, 'a key is bound to a user the saved box does not have', was.id);
            also = `. Its key could not be bound back to ${was.user} (${String(back.detail ?? back.error ?? '')}): the key and the saved box no longer agree`;
          }
        }
        return { ok: false, error: `not saved: ${String(saved.detail ?? saved.error ?? '')}${also}` };
      }
      if (moved || d.user !== was.user) this.dropCheck(id);
      return { ok: true, id };
    });
  }

  // Forget the identity pinned for a box: a box that was rebuilt shows another one, and is checked again
  // the same way as the first time. Nothing else about the box changes.
  forget(id: string): Promise<Result> {
    return this.oneAtATime(async () => {
      const was = this.get(id);
      if (!was) return { ok: false, error: 'no such box' };
      if (was.pin === '') return { ok: true, id };
      this.dropCheck(id);
      const saved = await this.save(this.list.map((b) => (b.id === id ? { ...b, pin: '', pinFingerprint: '', pinnedAt: '' } : b)));
      return saved.ok ? { ok: true, id } : { ok: false, error: `not saved: ${String(saved.detail ?? saved.error ?? '')}` };
    });
  }

  // Delete box: the box and its key go together.
  remove(id: string): Promise<Result> {
    return this.oneAtATime(async () => {
      if (!this.get(id)) return { ok: false, error: 'no such box' };
      this.dropCheck(id);
      // The key goes first, and the box is written out without it only once the key is gone. The two cannot be
      // done at the same moment, so one of them is left half done if the app stops in between, and this is the
      // order where that is safe: a box whose key has gone is on screen and says so, and can be deleted again,
      // while a key whose box has gone is a private key nobody owns, held in the vault with nothing naming it.
      const gone = await this.keys.request('deleteKey', { key: id });
      if (!gone.ok) return { ok: false, error: `its key could not be deleted, so the box is still here: ${String(gone.detail ?? gone.error ?? '')}` };
      const saved = await this.save(this.list.filter((b) => b.id !== id));
      if (!saved.ok) return { ok: false, error: `its key is deleted, but the box could not be removed: ${String(saved.detail ?? saved.error ?? '')}` };
      return { ok: true, id };
    });
  }

  // The one block to run on the box, with this box's key in it.
  block(id: string): string {
    const box = this.get(id);
    return box ? firstConnectionBlock(this.blockTemplate, box.publicKey, box.name) : '';
  }

  check(id: string): CheckView {
    return this.checks.get(id)?.view ?? blank(id);
  }

  // Step 1: ask the box who it is. The answer stays here.
  reach(id: string): void {
    const box = this.get(id);
    if (!box) return;
    this.dropCheck(id);
    const c: Checking = { view: { ...blank(id), step: 'reaching', phase: 'connecting' }, reached: null, matched: '', cancel: null };
    this.checks.set(id, c);
    const asked = this.identify(addrOf(box), (phase) => {
      if (this.checks.get(id) !== c || c.view.step !== 'reaching') return;
      c.view = { ...c.view, phase };
      this.changed();
    });
    c.cancel = asked.cancel;
    this.changed();
    void asked.done.then((r) => {
      if (this.checks.get(id) !== c) return;
      c.cancel = null;
      // The fingerprint must be this very key's: it is worked out again here, from the key's own bytes.
      if (r.ok && KEY_LINE.test(r.key) && FINGERPRINT.test(r.fingerprint) && r.key.startsWith(`${r.type} `) && fingerprintOf(r.key) === r.fingerprint) {
        c.reached = r;
        c.view = { ...blank(id), step: 'reached' };
      } else if (r.ok) {
        c.view = { ...blank(id), step: 'unreachable', cause: 'protocol', detail: 'the answer was not an identity' };
      } else {
        c.view = { ...blank(id), step: 'unreachable', cause: r.cause, phase: r.phase, detail: r.detail, what: r.what ?? '', ours: r.ours ?? [], theirs: r.box ?? [] };
      }
      this.changed();
    });
  }

  // Step 2: compare what was pasted with what the box showed. Only now may that be shown.
  paste(id: string, pasted: unknown): void {
    const c = this.checks.get(id);
    if (!c || !c.reached || typeof pasted !== 'string') return; // nothing was reached: there is nothing to compare with
    const found = fingerprintsIn(pasted);
    c.matched = '';
    if (found.length === 0) c.view = { ...blank(id), step: 'reached', detail: pasted.trim() === '' ? '' : 'no identity line in what was pasted' };
    else if (found.includes(c.reached.fingerprint)) {
      c.matched = c.reached.key;
      c.view = { ...blank(id), step: 'match', shownType: c.reached.type, shownFingerprint: c.reached.fingerprint };
    } else {
      // A mismatch says that they differ. It does not print what answered: that value is the one thing the
      // check exists to withhold, and printing it puts it one copy away from the field above, for a person in
      // a hurry and for anything that has taken over the window alike. Its kind is said; its fingerprint is
      // not, here or anywhere a view can reach.
      c.view = { ...blank(id), step: 'mismatch', shownType: c.reached.type, shownFingerprint: '', pasted: found.slice(0, 8) };
    }
    this.changed();
  }

  // Step 3: pin the identity that matched. Nothing else can pin a box.
  trust(id: string): Promise<Result> {
    return this.oneAtATime(async () => {
      const c = this.checks.get(id);
      const box = this.get(id);
      if (!box || !c || !c.reached || c.view.step !== 'match' || c.matched === '' || c.matched !== c.reached.key) return { ok: false, error: 'nothing was checked' };
      const pinned: Box = { ...box, pin: c.matched, pinFingerprint: c.reached.fingerprint, pinnedAt: this.stamp() };
      const saved = await this.save(this.list.map((b) => (b.id === id ? pinned : b)));
      if (!saved.ok) return { ok: false, error: `not saved: ${String(saved.detail ?? saved.error ?? '')}` };
      this.dropCheck(id);
      return { ok: true, id };
    });
  }

  cancelCheck(id: string): void {
    this.dropCheck(id);
    this.changed();
  }

  private dropCheck(id: string): void {
    const c = this.checks.get(id);
    c?.cancel?.();
    this.checks.delete(id);
  }

  private stamp(): string {
    return this.now().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  // Saves a new list of boxes through the key process; memory follows only what was saved.
  private async save(next: Box[], settings = this.settings): Promise<KeyReply> {
    const saved = await this.keys.request('setPublic', { public: { v: 1, boxes: next, settings } });
    if (saved.ok) {
      this.list = next;
      this.settings = settings;
      this.changed();
    }
    return saved;
  }

  // Changing a setting: the whole list is written again, boxes and all, because the list is one file and the
  // key process holds it whole. Nothing is kept in memory as changed until the write says it worked.
  setSettings(next: Partial<AppSettings>): Promise<KeyReply> {
    return this.oneAtATime(() => this.save(this.list, { ...this.settings, ...next }));
  }

  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = this.saving.then(work, work);
    this.saving = next.catch(() => undefined);
    return next;
  }
}

// The SHA-256 fingerprint of a key line, as OpenSSH prints it. The key's bytes are hashed, never read into.
export function fingerprintOf(keyLine: string): string {
  const blob = Buffer.from(keyLine.split(' ')[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

// A draft as it arrives from a view: every field must be of its kind, or there is no draft.
function cleanDraft(draft: unknown): BoxDraft | null {
  const d = draft as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d['places']) || d['places'].length > 64) return null;
  const name = str(d['name'], 256);
  const host = str(d['host'], 512);
  const port = str(d['port'], 16);
  const user = str(d['user'], 256);
  const folder = str(d['folder'], 4096);
  if (name === null || host === null || port === null || user === null || folder === null || typeof d['colour'] !== 'number') return null;
  const places = [];
  for (const p of d['places'] as Record<string, unknown>[]) {
    const pn = str(p?.['name'], 256);
    const pf = str(p?.['folder'], 4096);
    if (pn === null || pf === null) return null;
    places.push({ name: pn, folder: pf });
  }
  return { name, colour: d['colour'], host, port, user, folder, places };
}

// The boxes as they were saved. Anything that is not exactly a list of boxes is refused whole: a list that
// cannot be read is said, never guessed at and never overwritten.
// The settings as they were saved, with anything missing or of the wrong shape left at its default: a list
// written by an older build, or one damaged in a way the seal did not catch, must still open.
export function readSettings(publicPart: unknown): AppSettings {
  const p = publicPart as Record<string, unknown> | null;
  const raw = (p?.['settings'] ?? {}) as Record<string, unknown>;
  const downloads = typeof raw['downloads'] === 'string' && raw['downloads'].length <= 4096 ? raw['downloads'] : '';
  const size = typeof raw['paneSize'] === 'number' && raw['paneSize'] >= 0.5 && raw['paneSize'] <= 3 ? raw['paneSize'] : 1;
  return { downloads, paneSize: size };
}

export function readBoxes(publicPart: unknown): Box[] | null {
  const p = publicPart as { v?: unknown; boxes?: unknown } | null;
  if (!p || typeof p !== 'object') return null;
  if (p.v === undefined && p.boxes === undefined && Object.keys(p).length === 0) return []; // a new list
  if (p.v !== 1 || !Array.isArray(p.boxes) || p.boxes.length > BOXES_MAX) return null;
  const out: Box[] = [];
  const ids = new Set<string>();
  const names: string[] = [];
  for (const raw of p.boxes as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as unknown as Box;
    const texts = [b.id, b.name, b.host, b.user, b.folder, b.publicKey, b.pin, b.pinFingerprint, b.pinnedAt, b.created];
    if (texts.some((t) => typeof t !== 'string') || !Array.isArray(b.places)) return null;
    if (!/^b[0-9a-f]{16}$/.test(b.id) || ids.has(b.id)) return null;
    if (!Number.isInteger(b.colour) || b.colour < 1 || b.colour > BOX_COLOURS || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) return null;
    const places = b.places.map((x) => ({ name: (x as { name?: unknown })?.name, folder: (x as { folder?: unknown })?.folder }));
    if (places.some((x) => typeof x.name !== 'string' || typeof x.folder !== 'string')) return null;
    const draft: BoxDraft = { name: b.name, colour: b.colour, host: b.host, port: String(b.port), user: b.user, folder: b.folder, places: places as { name: string; folder: string }[] };
    if (Object.keys(draftFaults(draft, names)).length > 0 || placesOf(draft).length !== places.length) return null;
    if (!KEY_LINE.test(b.publicKey)) return null;
    // The pinned key is what is enforced on every later connection; the fingerprint beside it is what the
    // person is shown. A saved box whose two do not belong together would show one identity and enforce
    // another, so it is not read at all.
    if (b.pin === '' ? b.pinFingerprint !== '' || b.pinnedAt !== '' : !KEY_LINE.test(b.pin) || !FINGERPRINT.test(b.pinFingerprint) || b.pinnedAt === '' || fingerprintOf(b.pin) !== b.pinFingerprint) return null;
    if (b.folder !== '' && folderFault(b.folder)) return null;
    ids.add(b.id);
    names.push(b.name);
    out.push({ id: b.id, name: b.name, colour: b.colour, host: b.host, port: b.port, user: b.user, folder: b.folder, places: draft.places, publicKey: b.publicKey, pin: b.pin, pinFingerprint: b.pinFingerprint, pinnedAt: b.pinnedAt, created: b.created });
  }
  return out;
}
