// The skeleton's self-test. It runs inside the real main process, against the real views and engines,
// and only in an unpackaged build started with SSHAPP_SELFTEST=1. It prints one line, "SELFTEST <json>",
// and exits with 0 only if every probe held. The lab (Playwright, real SSH servers, the fault proxy)
// grows out of this; these probes stay as its first cases.
import { app, clipboard, type BaseWindow, type Session, type WebContentsView } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ShellState } from '../common/ipc';
import type { Boxes } from './boxes';
import type { SignAnswer, SignRequest } from './engine';
import type { Gate } from './gate';
import type { KeyProc } from './keyproc';
import type { Tab } from './main';
import { memory } from './memory';
import { BUDGET, type Meter } from './meter';
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

async function until(what: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await what()) return true;
    if (Date.now() > end) return false;
    await sleep(25);
  }
}

const js = <T>(view: WebContentsView, code: string) => view.webContents.executeJavaScript(code, true) as Promise<T>;
const shown = (t: Tab) => js<string>(t.view, `document.getElementById('out').textContent`);
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
    results.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  };
  const finish = (code: number) => {
    process.stdout.write(`SELFTEST ${JSON.stringify({ ok: code === 0, kind: ctx.kind, results })}\n`);
    app.exit(code);
  };
  const guard = setTimeout(() => {
    check('finished in time', false, `no end within 90 s; stuck ${stage}`);
    finish(1);
  }, 90_000);

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
    const at = (sel: string) => js<{ x: number; y: number } | null>(ctx.shell, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    const clickOn = async (sel: string) => {
      const p = await at(sel);
      if (!p) return false;
      sh.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      sh.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
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
    const text = (sel: string) => js<string>(ctx.shell, `document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
    const has = (sel: string) => js<boolean>(ctx.shell, `!!document.querySelector(${JSON.stringify(sel)})`);
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
      await lockHolds('before any password');
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
      check('after the wait the right password unlocks', await until(() => phase() === 'unlocked', 30_000), [phase(), ctx.gate.state.detail]);
      check('the window is the app now', await until(() => has('#bar'), 5000), '');
      // What the first start left in the list is there again: the box, pinned, with its key in the key process.
      if (process.env['SSHAPP_LABBOX']) {
        const kept = ctx.boxes.list;
        const heldNow = await ctx.keys.request('keys');
        check('the boxes are back as they were saved: one box, pinned, with its own key', ctx.boxes.loaded && ctx.boxes.fault === '' && kept.length === 1 && kept[0]!.name === 'lab-box' && kept[0]!.pin !== '' && kept[0]!.places[0]?.name === 'logs' && Array.isArray(heldNow['keys']) && (heldNow['keys'] as Record<string, unknown>[]).length === 1 && (heldNow['keys'] as Record<string, unknown>[])[0]!['publicKey'] === kept[0]!.publicKey, [ctx.boxes.fault, kept.map((b) => [b.name, b.pin !== ''])]);
      }
      const holding = await filesHolding(PASSWORD);
      check('no file the app wrote holds the password, or the wrong one', holding.length === 0 && (await filesHolding('not the password, sorry')).length === 0, holding);
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

    // "boxes-ui": the box screens driven by hand, as Kami will use them: real clicks and keys into the real
    // dialogs, against the lab's SSH server. SSHAPP_PICTURES=<folder> also pictures each screen on the way.
    if (ctx.mode === 'boxes-ui') {
      const labBin = process.env['SSHAPP_LABBOX'] ?? '';
      const shots = process.env['SSHAPP_PICTURES'] ?? '';
      const commit = process.env['SSHAPP_PICTURE_COMMIT'] ?? '';
      const size = ctx.win.getContentBounds();
      const shot = async (name: string, what: string) => {
        if (!shots) return;
        await sleep(350);
        const front = [...ctx.tabs.values()].find((t) => t.id === ctx.shellState().active);
        const made = await takePicture({ win: ctx.win, views: front ? [front.view, ctx.shell] : [ctx.shell], file: path.join(shots, `berth-app-dark-${size.width}x${size.height}-${name}.png`), strip: `Berth, the app as built   |   dark   |   window ${size.width}x${size.height}   |   ${what}   |   commit ${commit}`, dist: ctx.dist, harden: ctx.harden });
        check(`a picture: ${what}`, made.width > 0, made);
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
        await shot('add-empty', 'Add box, empty');
        // Add with nothing typed: every required field says so, and nothing is asked of main.
        await clickOn('#add-submit');
        check('Add with nothing typed: the fields to fix are counted and named', (await text('#add-to-fix')).includes('3 fields to fix') && (await text('#box-name-check')) === 'needed' && ctx.boxes.list.length === 0, await text('#add-to-fix'));
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
        await shot('check-asked', 'the first-connection check, waiting for the paste');

        await clickOn('#check-paste');
        await typeKeys('256 SHA256:nB4yE8wQ2oL6cT0vR9mK3jH7gF5dS1aZ8xU4iP6eW2k root@elsewhere (ED25519)');
        check('a paste from another box: the dialog turns to a mismatch, both shown, no Trust', (await until(async () => (await step()) === 'mismatch', 3000)) && (await has('#check-mismatch')) && !(await has('#check-trust')), await step());
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
        ctx.closeTab(t1.id);
        await lab.tell(`accept ${ctx.boxes.list[0]!.publicKey}`);

        // The Boxes menu: the box, its place beside it; a place opens a tab there.
        await clickOn('#boxes');
        check('Boxes opens the menu, above the tabs', (await until(() => has('#box-menu'), 2000)) && (await until(shellOnTop, 1000)) && (await text('#box-menu')).includes('lab-box'), '');
        await moveTo('[data-box="lab-box"]');
        check('its places open beside it', await until(() => has('[data-place="logs"]'), 2000), '');
        await shot('boxes-menu', 'the Boxes menu, a box\'s places open');
        await clickOn('[data-place="logs"]');
        const t2ok = await until(() => [...ctx.tabs.values()].some((t) => t.place === 'logs' && t.engine.link.phase === 'up'), 20_000);
        check('a place opens a tab there, signed in; the menu is gone and the tab is above the shell', t2ok && !(await has('#box-menu')) && !shellOnTop(), [...ctx.tabs.values()].map((t) => t.engine.link.phase));
        check('the tab says its box and its place, in the box\'s colour', (await text('[data-tab]')).includes('lab-box') && (await text('[data-tab]')).includes('logs') && (await text('#status')).includes('lab-box, logs'), await text('#status'));
        await shot('tab-open', 'a tab open on a box');

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
        await lab.tell('rekey');
        ctx.openTab(id, '');
        check('a box showing another identity: the tab stops and the dialog says so, with both fingerprints', (await until(() => has('#changed'), 20_000)) && (await text('#changed')).includes(ctx.boxes.list[0]!.pinFingerprint) && (await until(shellOnTop, 1000)), [await has('#changed'), await text('#changed'), shellOnTop(), ctx.shellState().tabs.map((t) => [t.link.phase, t.link.cause]), ctx.shellState().check?.boxId ?? '', ctx.boxes.list.map((b) => [b.name, b.pinFingerprint])]);
        await shot('changed', 'a box whose identity changed');
        await clickOn('#changed-close');
        check('Close: the dialog goes, the tab stays, marked stopped', (await until(async () => !(await has('#changed')), 2000)) && (await js<string>(ctx.shell, `document.querySelector('[data-tab]')?.dataset.state ?? ''`)) === 'stopped', '');
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

    // "seven": the fullest day. Seven tabs, each with its own view and engine, all answering, none leaking into
    // another; with what it costs in memory.
    if (ctx.mode === 'seven') {
      const all = Array.from({ length: 7 }, () => ctx.openTab()!);
      check('seven engines answer', await until(() => all.every((t) => t.engine.state === 'ready'), 30_000), all.map((t) => t.engine.state));
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
      check('each of the seven hears its own engine only', arrived === 7 && leaks === 0, { arrived, leaks });
      // Every tab, and the button that opens one more, is in sight, whatever the window's width. A tab that has
      // slid out of the bar cannot be pressed, and what cannot be seen is not there (found 2026-11-16 on a
      // 1024-wide screen: tabs six and seven were past the window's edge).
      const inBar = await js<{ width: number; out: string[] }>(ctx.shell, `(() => { const w = window.innerWidth; const out = []; for (const el of document.querySelectorAll('[data-tab], #new')) { const r = el.getBoundingClientRect(); if (r.width < 1 || r.left < 0 || r.right > w + 0.5) out.push((el.getAttribute('data-tab') ? 'tab ' + el.getAttribute('data-tab') : 'the new-tab button') + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); } return { width: w, out }; })()`);
      check(`all seven tabs and the new-tab button are inside a bar ${inBar.width} wide`, inBar.out.length === 0, inBar);
      // The promises, measured under load: every tab floods its engine for four seconds while real clicks switch
      // tabs and real keys are typed. Budgets are the plan's (B8), times the stated factor for slow test machines.
      const factor = Math.max(1, Number(process.env['SSHAPP_BUDGET_FACTOR']) || 1);
      await sleep(1200); // let start-up noise be reported, then begin clean
      ctx.meter.reset();
      const FLOOD_MS = 4000;
      for (const t of all) {
        await js(t.view, `(() => { const chunk = new Uint8Array(16384).fill(120); const end = Date.now() + ${FLOOD_MS}; window.__sent = 0; const go = () => { if (Date.now() > end) return; window.tabPort.send(chunk); window.__sent += chunk.length; setTimeout(go, 0); }; go(); })()`);
      }
      const until4 = Date.now() + FLOOD_MS;
      let turn = 0;
      let presses = 0;
      let switches = 0;
      while (Date.now() < until4) {
        const t = all[turn++ % all.length]!;
        const at = await js<{ x: number; y: number } | null>(ctx.shell, `(() => { const b = document.querySelector('[data-tab="${t.id}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (at) {
          ctx.shell.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          ctx.shell.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          presses++;
        }
        // The key follows the press at once, as a hand does, before the tab has been painted.
        t.view.webContents.focus();
        for (const type of ['keyDown', 'char', 'keyUp'] as const) t.view.webContents.sendInputEvent({ type, keyCode: 'k' });
        // A press counts only if the tab really came to the front: a press that landed nowhere measures nothing.
        const began = Date.now();
        if (at && (await until(() => ctx.shellState().active === t.id, 1000))) switches++;
        await sleep(Math.max(0, 200 - (Date.now() - began)));
      }
      await sleep(1500); // the views report twice a second
      let sent = 0;
      for (const t of all) sent += await js<number>(t.view, `window.__sent || 0`);
      const w = { ...ctx.meter.worst };
      const mbps = (sent / 1048576 / (FLOOD_MS / 1000)).toFixed(1);
      check(`under load: ${switches} of ${presses} presses on a tab brought it to the front, ${mbps} MB/s through seven engines`, presses >= 7 && switches === presses && turn === presses && sent > 0, { turn, presses, switches, sent });
      const within = (key: keyof typeof BUDGET, what: string, mustMeasure: boolean) => {
        const limit = BUDGET[key] * factor;
        check(`${what}: ${w[key]} ms (budget ${BUDGET[key]} ms${factor > 1 ? `, times ${factor} on this machine` : ''})`, w[key] <= limit && (!mustMeasure || w[key] > 0), w);
      };
      within('mainDelayMs', 'main was never later than', true);
      within('viewTaskMs', 'no view was busy in one stretch longer than', false);
      // The slowest one also says where its time went: a slow reaction is explained, never guessed at.
      const slow = ctx.meter.slowest;
      within('reactionMs', `a real click or key was painted within (slowest: ${slow ? `${slow.kind} in ${slow.view === 0 ? 'the bar' : `tab ${slow.view}`}, ${slow.waitMs} ms before its handlers, ${slow.handlerMs} ms inside them, ${slow.paintMs} ms to the painted frame` : 'none over 16 ms'})`, false);
      within('tabSwitchMs', 'a tab switch was painted within', true);
      within('startMs', 'from process start to the first painted frame', true);

      const mem = await memory(all.map((t) => t.engine.pid));
      const budget = 300 + 7 * 220;
      check(`memory with seven tabs: ${mem.fairMB} MB (${mem.how}); budget ${budget} MB; plain per-process sum ${mem.plainMB} MB`, mem.fairMB > 0 && mem.fairMB < budget, mem);
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
      check(`${name}: only its own port`, port === (name === 'shell' ? 'cmd,frame,gateCreate,gatePickBackup,gateUnlock,meter,onGate,onState,sandboxed' : 'frame,meter,onBanner,onOutput,onShown,onState,sandboxed,send,taken'), port);
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
    const net = await js<string>(a.view, `Promise.all([
      fetch('${web}/fetch').then(() => 'reached', () => 'blocked'),
      new Promise((r) => { const i = new Image(); i.onload = () => r('reached'); i.onerror = () => r('blocked'); i.src = '${web}/x.png'; }),
      fetch('app://tab-2/index.html').then(() => 'reached', () => 'blocked'),
      fetch('app://shell/index.html').then(() => 'reached', () => 'blocked'),
      fetch('file:///etc/hostname').then(() => 'reached', () => 'blocked'),
    ]).then((x) => x.join())`);
    check('a view reaches no network, no other view, no file', net === 'blocked,blocked,blocked,blocked,blocked', net);
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
      check('a paste from another box is a mismatch: both are shown, nothing is pinned', mis.step === 'mismatch' && printed.includes(mis.shownFingerprint) && mis.pasted.length === 1 && !tried.ok && box().pin === '' && ctx.openTab(id) === null, [mis, tried]);
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
      check('the tab says which box and place it is on', JSON.stringify(ctx.shellState().tabs.find((x) => x.id === t.id)?.box) === JSON.stringify({ id, name: 'lab-box', colour: 2, place: 'logs' }), ctx.shellState().tabs);
      await until(async () => (await js<string>(t.view, `document.readyState`)) === 'complete', 10_000);
      await type(t, 'typed-into-the-box-5b2');
      check('typed bytes reach the box\'s shell and its output comes back to this tab', await until(async () => (await shown(t)).includes('typed-into-the-box-5b2'), 5000), await shown(t));
      check('another tab saw none of it', !(await shown(a)).includes('typed-into-the-box'), '');
      const seenNow = await lab.tell('seen');
      const sessions = (seenNow['sessions'] ?? []) as { Asked?: string[]; Command?: string; Term?: string; Cols?: number; Rows?: number }[];
      const last = sessions[sessions.length - 1];
      check('the box was asked for a terminal and the place\'s one start command, and nothing else', sessions.length === 1 && JSON.stringify(last?.Asked) === '["pty-req","exec"]' && last?.Command === `cd -- '/var/log/it'\\''s here' && exec "$SHELL" -l` && last?.Term === 'xterm-256color' && last?.Cols === 120 && last?.Rows === 40, seenNow);
      check('it signed in as the box\'s user', Array.isArray(seenNow['users']) && (seenNow['users'] as string[]).every((u) => u === 'demo'), seenNow['users']);

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
      ctx.closeTab(t.id);
      lab.end();
      // With the app closed the PC holds one locked file: no box's name is readable in anything the app wrote.
      const named = [...(await filesHolding('lab-box')), ...(await filesHolding('second-box')), ...(await filesHolding('/var/log/it'))];
      check('no file the app wrote names a box or a place in the clear', named.length === 0, named);
    }

    check('no view ever reached the canary web server', canaryHits === 0, canaryHits);
    check(`no message was dropped, but the ones the lock refused on purpose (late from a closed view, not acted on: ${ctx.lateFromClosed()})`, ctx.dropped() === refusedByTheLock, [ctx.dropped(), refusedByTheLock, ctx.droppedOn()]);
  } catch (err) {
    check('no probe threw', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  canary.close();
  clearTimeout(guard);
  finish(results.every((r) => r.ok) ? 0 : 1);
}
