// The main process: the window, the views, the engines, and the few messages that cross between them.
// It holds no key, opens no network connection and parses nothing a box sent.
import { app, BaseWindow, clipboard, dialog, ipcMain, nativeImage, protocol, session, shell as osShell, WebContentsView, type IpcMainEvent, type Session } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import firstConnection from '../../protocol/first-connection.json';
import { addrOf, signsWith, type Box, type BoxDraft } from '../common/boxes';
import { freeName, safeName } from '../common/landing';
import { CH, COPY_MAX, GRAB_MAX, INPUT_MAX, MOST_AT_ONCE, TABS_MAX, type BoxView, type CheckShown, type ClosingAsked, type FileRow, type KeyFileChosen, type LinkAsked, type PasteShown, type ReplaceAsked, type ShellCmd, type ShellState, type TabInfo } from '../common/ipc';
import { look } from '../common/paste';
import { AGAIN_AFTER_MS, mayOpenAgain } from './again';
import { Boxes, fingerprintOf } from './boxes';
import { Engine, type EngineAim, type SignAnswer, type SignRequest } from './engine';
import { Gate } from './gate';
import { identifyWith } from './identify';
import { KeyProc } from './keyproc';
import { isLabPackageNow } from './lab-proof';
import { Meter } from './meter';
import { Pace, PACE_EVERY_MS } from './pace';

// A release build takes no arguments: none of its own, and none of Chromium's (a debugging port, for one).
// The one exception is the lab package, which the test driver must be able to start with a debugger: it says
// --lab, and that is believed only if the package really is a lab package (lab-proof.ts). The question is
// answered here, before the event loop turns once: a release build given --lab, alone or with anything else,
// exits like for any other argument, before Chromium has started anything those arguments asked for.
// Refusing means ending the process there and then. app.exit() is not used for it: asked to exit while Electron
// is still starting, it can wait for a start-up that we do not want to happen (seen on GitHub's runner, where
// a release binary given --lab stayed alive).
const refuse = (): never => process.exit(64);
const LAB = app.isPackaged && process.argv.includes('--lab') && isLabPackageNow(process.resourcesPath, process.execPath);
if (app.isPackaged && process.argv.length > 1 && !LAB) refuse();

// The app's name decides where its own files live (the locked list, in the user's app-data folder).
app.setName('Berth');
// A lab or development run keeps its files apart from a real profile: in the folder it is given, or in a fresh
// one. A release build never reads this.
//
// Fresh has to mean fresh. A folder named after the process alone is not: process numbers come round again,
// on a machine that has been running a while and on every container that starts counting from the beginning,
// and a self-test that lands on the folder an earlier run left behind starts with that run's boxes already in
// its list. Then it fails on a name that is taken, and the fault looks like the app's. The name carries
// something random as well, so each run begins with nothing.
const LAB_RUN = !app.isPackaged || LAB;
const LAB_PROFILE = LAB_RUN ? (process.env['SSHAPP_PROFILE'] ?? (process.env['SSHAPP_SELFTEST'] ? path.join(os.tmpdir(), `berth-lab-${process.pid}-${randomBytes(6).toString('hex')}`) : '')) : '';
if (LAB_PROFILE) app.setPath('userData', path.join(LAB_PROFILE, 'profile'));

const DIST = __dirname;
const BAR = 46; // the shell's bar above the tabs
const STATUS = 30; // and its status line below them
const ENGINE_NAME = process.platform === 'win32' ? 'sshapp-engine.exe' : 'sshapp-engine';
// Packaged: the engine sits beside the app archive (a program cannot be started from inside it).
const ENGINE_BIN = app.isPackaged ? path.join(process.resourcesPath, 'engine', ENGINE_NAME) : path.join(DIST, 'engine', ENGINE_NAME);
const ENGINE_HASHES = path.join(DIST, 'engine-hashes.json');
let SELFTEST = ''; // the self-test to run, or '' for none; decided once it is known what kind of build this is

// A fault in main must never open a blocking error box (Electron's default) and must never pass unseen.
// A packaged app has no console, so stderr alone would be nowhere: each fault is also written to a file
// beside the list, with the moment it happened. The local log with an id per failure replaces this file.
const FAULT_FILE = 'faults.txt';
const FAULT_MAX = 256 * 1024;
let faultsWritten = 0;
function faultHappened(what: string, detail: string): void {
  process.stderr.write(`MAINFAULT ${what} ${detail}\n`);
  faultsWritten++;
  try {
    // Appending is the one blocking call here on purpose: a fault may be the last thing this process does,
    // and a written fault is worth more than the microseconds. It is capped so it can never fill a disk.
    const file = path.join(app.getPath('userData'), FAULT_FILE);
    const already = statSync(file, { throwIfNoEntry: false });
    if (!already || already.size < FAULT_MAX) appendFileSync(file, `${new Date().toISOString()} ${what} ${detail}\n`);
  } catch {
    // Nowhere to write it: stderr above is what there is, and the count is told to the self-test.
  }
  if (SELFTEST) app.exit(70);
}
process.on('uncaughtException', (err) => faultHappened('fault', err.stack ?? String(err)));
process.on('unhandledRejection', (reason) => faultHappened('rejection', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)));

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Every file a view may load, by kind and path. Anything else is 404: no path is ever built from a request.
const FILES: Record<'shell' | 'tab' | 'easel' | 'directions', Record<string, [file: string, type: string]>> = {
  // The direction pictures: filled from dist/directions when a lab run asks for them, empty otherwise.
  directions: {},
  // The easel puts pictures of the window together. Lab and development builds only (see below).
  easel: {
    '/index.html': ['lab/index.html', 'text/html; charset=utf-8'],
    '/easel.js': ['lab/easel.js', 'text/javascript; charset=utf-8'],
  },
  // The shell's page, script, stylesheet and typefaces: filled from dist/shell at start.
  shell: {},
  // A tab's page, script, stylesheets and typefaces: filled from dist/tab at start.
  tab: {},
};

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
// A kind's files are listed once, from its own folder inside the app: still no path is ever built from a request.
async function listFiles(kind: 'shell' | 'tab' | 'directions'): Promise<void> {
  const base = path.join(DIST, kind);
  for (const rel of await readdir(base, { recursive: true })) {
    const type = TYPES[path.extname(rel)];
    if (type) FILES[kind][`/${rel.split(path.sep).join('/')}`] = [path.join(kind, rel), type];
  }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

const missing = new Map<string, number>();

async function serve(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response(null, { status: 400 });
  }
  const kind = url.hostname === 'shell' ? 'shell' : /^tab-[0-9]{1,6}$/.test(url.hostname) ? 'tab' : url.hostname === 'easel' && SELFTEST ? 'easel' : url.hostname === 'directions' && SELFTEST === 'direction' ? 'directions' : null;
  const entry = kind && request.method === 'GET' ? FILES[kind][url.pathname] : undefined;
  if (!entry) {
    // A file one of the app's own pages asked for and the app does not hold is a fault of the app, never a
    // quiet gap: it is counted by name. (Found 2026-11-16: a tab's stylesheets were not on its list, and the
    // terminal ran without them with every probe passing.)
    const name = `${kind ?? 'unknown'}${url.pathname}`.slice(0, 120);
    if (missing.size < 200 || missing.has(name)) missing.set(name, (missing.get(name) ?? 0) + 1);
    return new Response(null, { status: 404 });
  }
  const data = await readFile(path.join(DIST, entry[0]));
  return new Response(new Uint8Array(data), {
    headers: {
      'content-type': entry[1],
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

function harden(ses: Session): void {
  ses.protocol.handle('app', serve);
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  // No spell checking, and no dictionary for it: with a language set, Chromium fetches that language's dictionary
  // from Google's servers the first time a text field is used, by a path that webRequest (below) does not see.
  // Found by the lab's network canary on 2026-11-16, the day the first real text field (the password) was built.
  ses.setSpellCheckerEnabled(false);
  if (process.platform !== 'darwin') ses.setSpellCheckerLanguages([]);
  // The app makes no web request at all. Only its own pages load.
  ses.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('app://') }));
}

function viewPrefs(ses: Session, preload: string, throttle: boolean): Electron.WebPreferences {
  return {
    session: ses,
    preload: path.join(DIST, preload),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
    devTools: false,
    navigateOnDragDrop: false,
    backgroundThrottling: throttle,
  };
}

interface Tab {
  id: number;
  view: WebContentsView;
  engine: Engine;
  begin(cols: number, rows: number): void; // starts the engine, once, at the view's size
  reopen(now: boolean): void; // a new session on the same box and place (a new engine: an engine is one link)
  stopReopen(forGood?: boolean): void;
  againAt: number; // when the new session opens; 0 when none is coming
  cancelled: boolean; // the person stopped the new session: nothing may start one by itself again
  origin: string;
  box: Box | null; // the one box this tab's engine was aimed at; null for the skeleton's tab with no box
  place: string;
}


// New connections to one box are paced: at most five in any thirty seconds, whatever asks for them (plan B1).
const OPENED_MAX = 5;
const OPENED_WITHIN_MS = 30_000;
const opened = new Map<string, number[]>();
function waitForBox(boxId: string): number {
  const now = Date.now();
  const when = (opened.get(boxId) ?? []).filter((t) => now - t < OPENED_WITHIN_MS);
  opened.set(boxId, when);
  return when.length < OPENED_MAX ? 0 : OPENED_WITHIN_MS - (now - when[when.length - OPENED_MAX]!);
}
function boxOpened(boxId: string): void {
  opened.set(boxId, [...(opened.get(boxId) ?? []), Date.now()]);
}

const tabs = new Map<number, Tab>();
const tabByContents = new Map<number, Tab>();
let nextTabId = 1;
let active = 0;
let win: BaseWindow | null = null;
let shell: WebContentsView | null = null;
let droppedMessages = 0;
const droppedOn = new Map<string, number>(); // which kind of message was dropped, for the self-test to say
// A view that was just closed may have a message on its way (the meter reports twice a second): that one is
// late, not refused, and is counted apart. Nothing from a closed view is ever acted on either way.
const closedViews = new Set<number>();
let lateFromClosed = 0;
function drop(on: string, e?: IpcMainEvent): void {
  if (e && closedViews.has(e.sender.id)) {
    lateFromClosed++;
    return;
  }
  droppedMessages++;
  droppedOn.set(on, (droppedOn.get(on) ?? 0) + 1);
}
const meter = new Meter();
const pace = new Pace(os.availableParallelism());
// One look at every tab, twenty times a second: which tabs behind are flooded, and what share each may work.
const lookPace = (): void => {
  if (!pace.look([...tabs.values()].map((t) => ({ id: t.id, behind: t.id !== active, waiting: t.engine.waiting() })))) return;
  for (const t of tabs.values()) sendTo(t.view, CH.tabPace, pace.share);
};
let keys: KeyProc | null = null;
let gate: Gate | null = null;
let listOnDisk = ''; // where the list is kept: main's own, never a view's word for it
let boxes: Boxes | null = null;
let signsRefused = 0;
let copiesRefused = 0; // a tab not in front, or a window not in use, offered text for the clipboard
let overlay = false; // a menu or dialog of the shell is open: the shell is above the tabs
let openCheck = ''; // the box whose first-connection check is open in a dialog
const askedAt = new Map<string, string[]>(); // per box: when it was asked who it is
let added: ShellState['added'] = null;
let done = '';
let signsPassedOn = 0; // requests main let through to the key process

function tellGate(): void {
  if (!gate) return;
  sendTo(shell, CH.gateState, gate.view());
  // What the window may show depends on the lock as much as on the boxes: before the lock is open the window
  // is told no box at all. So the lock changing is a reason to tell the window the rest of what it holds, and
  // it is done here, where every change to the lock passes, rather than at each place one happens. Without
  // this, the one send that follows the boxes being loaded happens while the lock still says "working", so
  // the window is told nothing, and nothing tells it again: every box saved, none on screen.
  tellShell();
}

function info(t: Tab): TabInfo {
  // The box as it stands now: a box that was edited while its tabs are open says its new name on them.
  const box = t.box ? (boxes?.get(t.box.id) ?? t.box) : null;
  const place = box?.places.find((p) => p.name === t.place);
  return { id: t.id, againAt: t.againAt, state: t.engine.state, cause: t.engine.cause, box: box ? { id: box.id, name: box.name, colour: box.colour, place: t.place, addr: addrOf(box), user: box.user, folder: place?.folder ?? box.folder, pinType: box.pin.startsWith('ssh-rsa ') ? 'RSA' : 'ED25519' } : null, link: t.engine.link };
}

function boxView(b: Box): BoxView {
  return { id: b.id, name: b.name, colour: b.colour, host: b.host, port: b.port, user: b.user, folder: b.folder, places: b.places.map((p) => ({ name: p.name, folder: p.folder })), pinned: b.pin !== '', pinFingerprint: b.pinFingerprint, pinType: b.pin.startsWith('ssh-rsa ') ? 'RSA' : b.pin === '' ? '' : 'ED25519', pinnedAt: b.pinnedAt };
}

function checkShown(): CheckShown | null {
  const box = openCheck ? boxes?.get(openCheck) : undefined;
  if (!boxes || !box) return null;
  return { ...boxes.check(box.id), name: box.name, addr: addrOf(box), block: boxes.block(box.id), askedAt: askedAt.get(box.id) ?? [] };
}

function shellState(): ShellState {
  return { tabs: [...tabs.values()].map(info), active, boxes: gate?.unlocked && boxes ? boxes.list.map(boxView) : [], boxesFault: boxes?.fault ?? '', check: gate?.unlocked ? checkShown() : null, added, done, paste: waitingPaste?.shown ?? null, link: waitingLink, maximized: win?.isMaximized() ?? false, closing: closingAsked, keyFile: keyFile?.shown ?? null, replacing: replaceAsked };
}

// ---- An address a box printed (plan B2.7) ----
// A box can print whatever it likes, so nothing it prints opens by itself: the terminal's own opening is off,
// a link hidden behind other words is refused before the terminal sees it, and a plain click does nothing. A
// Ctrl+click asks here, and the whole address is shown on the window's own surface before anything opens.
let waitingLink: LinkAsked | null = null;
let linksRefused = 0;
// Closing the window with sessions open asks first, and nothing is ended until the answer comes back
// (BUILD-RULES 2.20). While this holds the question, the window's own close has been refused once.
let closingAsked: ClosingAsked | null = null;

// A key file chosen for the box being added (plan O1). Its bytes live here and nowhere else: no view is ever
// told them, and they are wiped as soon as the box is made or the file is put aside. What a view learns is the
// file's name, the public half of the key inside it, and what is in the way.
let keyFile: { shown: KeyFileChosen; bytes: Buffer; passphrase: Buffer } | null = null;

function dropKeyFile(): void {
  if (!keyFile) return;
  keyFile.bytes.fill(0);
  keyFile.passphrase.fill(0);
  keyFile = null;
}

// A key file is chosen. Main reads it and holds the bytes; the lab reaches this the same way the window does,
// because the chooser itself is the system's and cannot be driven.
async function chooseKeyFile(file: string): Promise<void> {
  const blank = { name: path.basename(file), publicKey: '', keyType: '', fingerprint: '', needsPassphrase: false, wrongPassphrase: false };
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    dropKeyFile();
    keyFile = { shown: { ...blank, fault: `That file could not be read: ${String(err)}`.slice(0, 120) }, bytes: Buffer.alloc(0), passphrase: Buffer.alloc(0) };
    tellShell();
    return;
  }
  dropKeyFile();
  keyFile = { shown: { ...blank, fault: '' }, bytes, passphrase: Buffer.alloc(0) };
  tellShell();
  await tryKeyFile();
}

// Read the chosen file again through the key process, with whatever passphrase has been given, and say what it
// holds. Nothing is kept by that: it is the same parse the add will do, done early so the person finds out here.
async function tryKeyFile(): Promise<void> {
  const k = keyFile;
  if (!k || !keys) return;
  const r = await keys.request('tryKeyFile', { file: k.bytes.toString('base64'), passphrase: k.passphrase.toString('base64') });
  if (keyFile !== k) return; // put aside, or another file chosen, while this was asked
  const line = r['publicKey'];
  const kind = r['keyType'];
  if (r.ok && typeof line === 'string' && typeof kind === 'string') {
    k.shown = { ...k.shown, publicKey: line, keyType: kind, fingerprint: fingerprintOf(line), needsPassphrase: false, wrongPassphrase: false, fault: '' };
  } else {
    const code = String(r.error ?? '');
    k.shown = {
      ...k.shown,
      publicKey: '',
      keyType: '',
      fingerprint: '',
      needsPassphrase: code === 'needs-passphrase' || code === 'wrong-passphrase',
      wrongPassphrase: code === 'wrong-passphrase',
      fault: keyFileFault(code),
    };
  }
  tellShell();
}

// Each refusal of a key file in the words the person needs, and nothing else.
function keyFileFault(code: string): string {
  switch (code) {
    case 'needs-passphrase':
    case 'wrong-passphrase':
      return '';
    case 'not-a-key':
      return 'That file is not a private key.';
    case 'key-kind':
      return 'That is a kind of key Berth will not sign with.';
    case 'key-too-small':
      return 'That RSA key is smaller than 2048 bits.';
    default:
      return 'That key file could not be read.';
  }
}
let closingForReal = false;

// The sessions that would end if the window closed now, and the tabs that have nothing to lose.
function whatWouldEnd(): ClosingAsked {
  const live: ClosingAsked['live'] = [];
  let idle = 0;
  for (const t of tabs.values()) {
    const i = info(t);
    // A session that is signed in, or on its way there, is a real loss. One that has ended is not.
    if (i.box && ['connecting', 'key-exchange', 'signing-in', 'up'].includes(i.link.phase)) {
      live.push({ id: t.id, box: i.box.name, place: t.place, words: i.link.phase === 'up' ? (i.state === 'not-answering' ? 'not answering' : 'connected') : i.link.phase === 'signing-in' ? 'signing in' : 'connecting' });
    } else idle++;
  }
  return { live, idle };
}

let lastOpened = ''; // the last address handed to Windows, for the lab
const windowAsked: string[] = []; // what the window's own three buttons have asked of the window, for the lab
let opensAsked = 0;

function linkAsked(tab: Tab, url: string): void {
  if (tab.id !== active || overlay || !win?.isFocused() || !tab.box || waitingLink || url.length > 2048) {
    linksRefused++;
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    linksRefused++;
    return;
  }
  // Only the two schemes a browser takes. Anything else a box prints is not an address to open.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    linksRefused++;
    return;
  }
  waitingLink = { tab: tab.id, box: tab.box.name, place: tab.place, url: parsed.href, host: parsed.host, scheme: parsed.protocol.replace(':', '') };
  overlay = true;
  stack();
  tellShell();
}

function closeLink(open: boolean): void {
  const asked = waitingLink;
  waitingLink = null;
  overlay = false;
  stack();
  if (asked && open) {
    opensAsked++;
    lastOpened = asked.url;
    done = `Opened ${asked.host} in the browser`;
    // The app opens nothing itself: the address is handed to Windows, which opens it where the person's
    // own browser is. Nothing of Berth goes with it.
    void osShell.openExternal(asked.url).catch(() => undefined);
  } else if (asked) done = 'The address was not opened';
  tellShell();
}

// ---- Paste (plan B2.7, B3) ----
// The clipboard is read here, and only for a paste a person made themselves: a paste key main saw before the
// page did, or a paste from the menu of a right-click main saw. A view cannot ask for it, and a box cannot
// make one happen. What is read is taken apart (common/paste.ts), and a paste of more than one line is shown
// on the shell before anything is sent, because a line ending in it would run as a command on arrival.
let waitingPaste: { shown: PasteShown; text: string } | null = null;
let pastesRefused = 0; // a paste asked for where it is not the person's own: counted, never acted on
const protectedPaste = new Map<number, boolean>(); // per tab: its box asked to be told where a paste begins
const pasteAgainAfterMs = 150;
let lastPasteAt = 0;

// Only the tab in front, in a window in use, with nothing of the shell's over it, and not twice in a moment.
function mayPaste(tab: Tab): boolean {
  return tab.id === active && !overlay && !!win?.isFocused() && !!tab.box && tabs.get(tab.id) === tab;
}

async function pasteInto(tab: Tab, how: string): Promise<void> {
  if (!mayPaste(tab) || Date.now() - lastPasteAt < pasteAgainAfterMs) {
    pastesRefused++;
    return;
  }
  lastPasteAt = Date.now();
  const seen = look(await clipboard.readText());
  // Reading the clipboard is awaited, so everything that made this paste the person's own is asked again.
  if (!mayPaste(tab)) {
    pastesRefused++;
    return;
  }
  if (seen.text === '') {
    done = 'Nothing to paste';
    tellShell();
    return;
  }
  if (seen.oneLine && seen.odd.length === 0 && !seen.cut) {
    sendTo(tab.view, CH.tabPaste, seen.text);
    done = `Pasted ${seen.text.length} characters into ${tab.box!.name}`;
    tellShell();
    return;
  }
  // More than one line, or something in it a person cannot see: it is shown first, never sent on a key.
  waitingPaste = {
    text: seen.text,
    shown: { tab: tab.id, box: tab.box!.name, place: tab.place, lines: seen.lines.slice(0, 400), endsWithLineEnding: seen.endsWithLineEnding, odd: seen.odd.slice(0, 200), cut: seen.cut, controlsRemoved: seen.controlsRemoved, protectedPaste: protectedPaste.get(tab.id) === true },
  };
  overlay = true;
  stack();
  tellShell();
  void how;
}

function closePaste(send: boolean): void {
  const waiting = waitingPaste;
  waitingPaste = null;
  overlay = false;
  stack();
  if (waiting && send) {
    const tab = tabs.get(waiting.shown.tab);
    if (tab && tab.box) {
      sendTo(tab.view, CH.tabPaste, waiting.text);
      done = `Pasted ${waiting.shown.lines.length} lines into ${tab.box.name}`;
    }
  } else if (waiting) done = 'The paste was not sent';
  tellShell();
}

// The shell is above the tabs while one of its menus or dialogs is open, so nothing a tab draws can cover them
// and no click reaches a tab meanwhile; otherwise the tab in front is above the shell's empty middle.
function stack(): void {
  if (!win || !shell) return;
  if (overlay) win.contentView.addChildView(shell);
  else for (const t of tabs.values()) win.contentView.addChildView(t.view);
}

// A view that was closed has no contents any more: every send goes through here, and a late message to a
// closed view is dropped, never a fault.
function sendTo(view: WebContentsView | null, channel: string, payload: unknown): void {
  const contents = view?.webContents as Electron.WebContents | undefined;
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

function tellShell(): void {
  tellTitle();
  sendTo(shell, CH.shellState, shellState());
}

const frontTold = new Map<number, boolean>(); // what each tab's view was last told: in front, or not

// What the window calls itself. Berth draws its own title bar, so this is read in the taskbar and in Alt+Tab
// rather than on the window: with several boxes open, that is where a person tells one Berth window from the
// state of another (SSH-APP-DETAILS 2: "<box> . <place> of the active tab, so the taskbar says which box").
function tellTitle(): void {
  if (!win) return;
  const t = tabs.get(active);
  const i = t ? info(t) : null;
  const name = i?.box ? `${i.box.name}${t?.place ? ` · ${t.place}` : ''} · Berth` : 'Berth';
  if (win.title !== name) win.setTitle(name);
}

function layout(): void {
  if (!win || !shell) return;
  const { width, height } = win.getContentBounds();
  shell.setBounds({ x: 0, y: 0, width, height });
  for (const t of tabs.values()) {
    t.view.setBounds({ x: 0, y: BAR, width, height: Math.max(0, height - BAR - STATUS) });
    const front = t.id === active;
    t.view.setVisible(front);
    if (frontTold.get(t.id) !== front) {
      frontTold.set(t.id, front);
      sendTo(t.view, CH.tabShown, front);
    }
  }
}

// A signature for a box's sign-in. Which key signs, and for which box, is decided here from the box the asking
// engine was aimed at when its tab was opened: nothing the engine says can name another. The key process then
// checks every field of the request itself.
async function signFor(box: Box, req: SignRequest): Promise<SignAnswer> {
  // Which algorithm this box's key may be asked for comes from the key itself, not from a constant: a key
  // brought in from a file (plan O1) can be of another kind than the ed25519 ones Berth makes.
  if (!keys || !gate?.unlocked || req.key !== box.id || !signsWith(box.publicKey).includes(req.algorithm)) {
    signsRefused++;
    return { error: 'refused' };
  }
  signsPassedOn++;
  const r = await keys.request('sign', { key: box.id, box: box.id, algorithm: req.algorithm, data: req.data });
  const signature = r['signature'];
  if (!r.ok || typeof signature !== 'string') {
    signsRefused++;
    return { error: String(r.error ?? 'refused').slice(0, 40) };
  }
  return { signature };
}

// Opens a tab: on a box (which must be pinned: there is no way to a box whose identity was never checked), in
// one of its places or in its starting folder; or, with no box, the skeleton's tab that the self-test uses.
function openTab(boxId = '', place = ''): Tab | null {
  if (!win || tabs.size >= TABS_MAX) return null;
  let box: Box | null = null;
  let aim: EngineAim = { stub: true };
  if (boxId !== '') {
    box = boxes?.get(boxId) ?? null;
    if (!box || box.pin === '') return null;
    const at = place === '' ? null : box.places.find((p) => p.name === place);
    if (place !== '' && !at) return null;
    aim = { stub: false, box: { addr: addrOf(box), user: box.user, hostKey: box.pin, key: box.id, publicKey: box.publicKey }, shell: { folder: at ? at.folder : box.folder, term: 'xterm-256color', cols: 120, rows: 40 } };
  }
  const aimedAt = box;
  const id = nextTabId++;
  // When a link is certainly gone, a new session opens by itself, after a wait the tab counts down.
  const maybeAgain = (): void => {
    const t = tabs.get(id);
    if (!t || t !== tab || !box) return;
    if (!mayOpenAgain(t.engine.link, t.againAt, t.cancelled)) return;
    t.reopen(false);
  };
  const origin = `app://tab-${id}`;
  // Its own partition (in memory only) and its own origin: nothing is shared with another tab.
  const ses = session.fromPartition(`tab-${id}`, { cache: false });
  harden(ses);
  // A tab never slows its box because its view is hidden: background throttling is off for tab views.
  const view = new WebContentsView({ webPreferences: viewPrefs(ses, 'preload-tab.js', false) });
  const hooks = {
    // An engine can outlive its tab for a moment (it ends after its view is closed): then only the shell is told.
    output: (bytes: Uint8Array) => {
      if (tabs.get(id) === tab) sendTo(view, CH.tabOutput, bytes);
    },
    state: () => {
      maybeAgain();
      if (tabs.get(id) === tab) sendTo(view, CH.tabState, info(tab));
      tellShell();
    },
    link: () => {
      maybeAgain();
      if (tabs.get(id) === tab) sendTo(view, CH.tabState, info(tab));
      tellShell();
    },
    // Text a box sent before sign-in: it goes to the tab's own view, for its terminal, and nowhere else.
    banner: (bytes: Uint8Array) => {
      if (tabs.get(id) === tab) sendTo(view, CH.tabBanner, bytes);
    },
    sign: (req: SignRequest) => (aimedAt ? signFor(aimedAt, req) : Promise.resolve({ error: 'refused' })),
    // A page of an answer about the box's files goes to the tab that asked, and nowhere else. A download's
    // pages pass through what main knows about it: where it is going, why its name is not the box's, and
    // whether the disk can hold it at all.
    filePage: (page: Record<string, unknown>) => {
      if (tabs.get(id) !== tab) return;
      const ask = typeof page['id'] === 'number' ? page['id'] : 0;
      const ours = mainAsks.get(comingKey(id, ask));
      if (ours) return ours(page);
      // A file is in the way of one being sent: the window asks about it, with what is there in front of the
      // person, instead of the strip simply saying no.
      const send = sendingNow.get(comingKey(id, ask));
      if (send) {
        const there = page['there'] as FileRow | undefined;
        if (there && typeof page['of'] === 'number') {
          // Held by its tab while the question is open, and still under its own number, so the refusal the
          // engine sends next is known for what it is and is not shown as the answer: the question is.
          sendingNow.set(comingKey(id, 0), send);
          askAboutReplacing(send, there, page['of']);
          return;
        }
        if (page['done'] === true) {
          if (page['error'] === 'already-there' && sendingNow.has(comingKey(id, 0))) return; // the question has it
          sendingNow.delete(comingKey(id, ask));
          // Whatever was chosen behind this one goes now. However this one ended: a queue that stopped at the
          // first refusal would leave the rest of what a person chose unsent and unsaid.
          nextQueued(tab);
          const was = comingBroke.get(comingKey(id, ask));
          comingBroke.delete(comingKey(id, ask));
          const why = page['error'];
          if (was) {
            if (typeof why === 'string' && WORTH_TAKING_UP.has(why)) broke.set(was.key, { size: was.size, mtime: was.mtime });
            else broke.delete(was.key);
          }
        }
      }
      // A file fetched to be carried: when it is there and whole it becomes draggable, exactly as a download
      // does, and the view is told so. Its pages are the view's own to show on the row it pressed.
      const carried = carrying.get(comingKey(id, ask));
      if (carried) {
        page = { ...page, carrying: true };
        if (page['landed'] === carried.name && page['error'] === undefined) {
          draggable.set(comingKey(id, ask), path.join(carried.into, carried.name));
          sendTo(view, CH.tabFilePage, { id: ask, draggable: true, carrying: true });
        }
        if (page['done'] === true) {
          carrying.delete(comingKey(id, ask));
          grabbing.delete(comingKey(id, ask));
        }
      }
      const mine = coming.get(comingKey(id, ask));
      if (mine) {
        // Where a download really landed is main's own knowledge, worked out before the engine was asked
        // (B4.2). When the engine says it is there and whole, that path becomes the one thing this tab may
        // drag out, named by the number of the ask and never by a path a view could say for itself.
        if (page['landed'] === mine.name && page['error'] === undefined) {
          draggable.set(comingKey(id, ask), path.join(mine.into, mine.name));
          sendTo(view, CH.tabFilePage, { id: ask, draggable: true });
        }
        if (page['done'] === true) {
          coming.delete(comingKey(id, ask));
          // A transfer that broke with bytes already written is written down, so the next try takes it up.
          const was = comingBroke.get(comingKey(id, ask));
          comingBroke.delete(comingKey(id, ask));
          const why = page['error'];
          if (was) {
            if (typeof why === 'string' && WORTH_TAKING_UP.has(why)) broke.set(was.key, { size: was.size, mtime: was.mtime });
            else broke.delete(was.key);
          }
        }
        page = { ...page, into: mine.into, ...(mine.why === '' ? {} : { renamed: mine.why }) };
      }
      sendTo(view, CH.tabFilePage, page);
    },
  };
  let engine = new Engine(ENGINE_BIN, ENGINE_HASHES, id, hooks, aim);
  // A box's terminal is opened at the size its view really has, so the engine starts when the view has said
  // its size. A view that says nothing does not hold the tab up: after two seconds the engine starts anyway.
  let begun = false;
  const lastSize = { cols: 120, rows: 40 };
  const begin = (cols: number, rows: number): void => {
    if (cols >= 1 && rows >= 1) {
      lastSize.cols = cols;
      lastSize.rows = rows;
    }
    if (begun) return;
    begun = true;
    if (box) boxOpened(box.id);
    engine.openAt(cols, rows);
    void engine.start();
  };
  // A new session: a new engine, aimed at the same box and place, opened at the size the view has now.
  // The view keeps everything it has drawn, and is told plainly that this is a new session.
  let againTimer: NodeJS.Timeout | null = null;
  // forGood: the person pressed Cancel. A late word from the box (its process ending is one) must not
  // start the countdown again behind their back, so the tab remembers that they stopped it.
  const stopReopen = (forGood = false): void => {
    if (againTimer) clearTimeout(againTimer);
    againTimer = null;
    tab.againAt = 0;
    if (forGood) tab.cancelled = true;
    if (tabs.get(id) === tab) sendTo(view, CH.tabState, info(tab));
    tellShell();
  };
  const reopen = (now: boolean): void => {
    if (!box || tabs.get(id) !== tab) return;
    tab.cancelled = false;
    const wait = now ? waitForBox(box.id) : Math.max(AGAIN_AFTER_MS, waitForBox(box.id));
    if (againTimer) clearTimeout(againTimer);
    tab.againAt = Date.now() + wait;
    if (wait > 0) {
      againTimer = setTimeout(() => reopen(true), wait);
      againTimer.unref();
      sendTo(view, CH.tabState, info(tab));
      tellShell();
      return;
    }
    againTimer = null;
    tab.againAt = 0;
    tab.engine.close();
    boxOpened(box.id);
    engine = new Engine(ENGINE_BIN, ENGINE_HASHES, id, hooks, structuredClone(aim));
    tab.engine = engine;
    engine.openAt(lastSize.cols, lastSize.rows);
    sendTo(view, CH.tabAgain, null);
    void engine.start();
    sendTo(view, CH.tabState, info(tab));
    tellShell();
  };
  const tab: Tab = { id, view, engine, begin, reopen, stopReopen, againAt: 0, cancelled: false, origin, box, place };
  tabs.set(id, tab);
  tabByContents.set(view.webContents.id, tab);
  win.contentView.addChildView(view);
  // A paste is a person's own doing, and main must have seen it: these two events reach main before the page
  // sees anything. The view is never asked, and never asks.
  view.webContents.on('before-input-event', (e, input) => {
    if (windowKey(input)) {
      e.preventDefault();
      return;
    }
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const paste = (input.control && input.shift && key === 'v') || (input.control && key === 'v') || (input.shift && key === 'insert');
    if (paste) void pasteInto(tab, 'a paste key');
  });
  view.webContents.on('context-menu', (_e, params) => {
    // Right-click pastes, as MobaXterm does. Only a real click on the terminal, never a menu asked for in code.
    if (params.x >= 0 && params.y >= 0) void pasteInto(tab, 'a right-click');
  });
  view.webContents.once('did-finish-load', () => {
    sendTo(view, CH.tabState, info(tab));
    sendTo(view, CH.tabShown, id === active);
    sendTo(view, CH.tabPace, pace.share);
  });
  void view.webContents.loadURL(`${origin}/index.html`);
  if (box) setTimeout(() => begin(120, 40), 2000).unref();
  else begin(0, 0);
  active = id;
  layout();
  tellShell();
  return tab;
}

// ---- The window's own keys ----
// Which tab is in front is the window's business, not a box's, so these presses are taken here in main, before
// any view is given them. That is what makes them work the same wherever the focus happens to be: the
// terminal, the row of files, a file open in the viewer, or a file held ready to be dragged. A page cannot
// swallow them and a box is never sent them.
//
// Only presses no box can want are taken. Ctrl+Tab and Ctrl+Shift+Tab cannot be written as bytes to a box at
// all, and Ctrl+Alt+a number is nobody's: Ctrl with a number alone is not free (Ctrl+2 is a zero byte to a
// terminal, Ctrl+6 and Ctrl+8 are bytes too), and neither are Ctrl+PageUp and Ctrl+PageDown, which real
// programs on a box use to move between their own windows. Those stay the box's.
let keysRefused = 0; // a window key pressed where the window is not the person's to drive: counted, never acted on

function goToTab(id: number): void {
  if (!tabs.has(id)) return;
  active = id;
  meter.tabSwitchBegins(id);
  frontTold.delete(id); // told again even if it was in front already: its frame ends the switch
  layout();
  tellShell();
}

// Answers the press, and says whether it was this window's to answer. True means no view ever sees it.
function windowKey(input: { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }): boolean {
  if (input.type !== 'keyDown' || !input.control || input.meta) return false;
  const digit = input.alt && input.key.length === 1 && input.key >= '1' && input.key <= '9';
  const step = !input.alt && input.key === 'Tab';
  if (!digit && !step) return false;
  // A dialog of the window's own is in front, or the window is not the one being typed into: the press is not
  // this person's doing here, so nothing moves. It is still taken, so no view is given a key meant for main.
  if (overlay || !win?.isFocused()) {
    keysRefused++;
    return true;
  }
  const ids = [...tabs.keys()];
  if (step) {
    if (ids.length < 2) {
      done = 'This is the only tab';
      tellShell();
      return true;
    }
    const at = ids.indexOf(active);
    const next = ids[(at + (input.shift ? ids.length - 1 : 1) + ids.length) % ids.length]!;
    goToTab(next);
    return true;
  }
  // Ctrl+Alt and a number: that tab, counting from the left. 9 is the last one, however many there are, which
  // is what every tabbed window does and what a person reaches for when there are more than nine.
  const want = Number(input.key);
  const id = want === 9 ? ids[ids.length - 1] : ids[want - 1];
  if (id === undefined) {
    done = `There is no tab ${want}`;
    tellShell();
    return true;
  }
  goToTab(id);
  return true;
}

function closeTab(id: number): void {
  const tab = tabs.get(id);
  if (!tab || !win) return;
  tab.engine.close();
  tabs.delete(id);
  tabByContents.delete(tab.view.webContents.id);
  win.contentView.removeChildView(tab.view);
  closedViews.add(tab.view.webContents.id);
  tab.view.webContents.close();
  meter.forget(id);
  frontTold.delete(id);
  protectedPaste.delete(id);
  queuedToSend.delete(id); // a tab that has gone takes what it still had to send with it
  for (const key of [...draggable.keys()]) if (key.startsWith(`${id}:`)) draggable.delete(key); // and what it could drag out
  for (const key of [...grabbing]) if (key.startsWith(`${id}:`)) grabbing.delete(key);
  for (const key of [...carrying.keys()]) if (key.startsWith(`${id}:`)) carrying.delete(key);
  // The copies it fetched for carrying go with it: they were never his files, only Berth's way of handing one
  // to Windows, and a tab that has gone has nothing left to hand over.
  void rm(path.join(carryIn, String(id)), { recursive: true, force: true }).catch(() => undefined);
  if (waitingPaste?.shown.tab === id) closePaste(false);
  if (waitingLink?.tab === id) closeLink(false);
  tab.stopReopen();
  if (active === id) active = [...tabs.keys()].pop() ?? 0;
  layout();
  tellShell();
}

// Routing is by sender: which process sent a message decides what it may reach. Nothing in the message does.
function fromMainFrameOf(e: IpcMainEvent, origin: string): boolean {
  const frame = e.senderFrame;
  return !!frame && frame === e.sender.mainFrame && frame.origin === origin;
}

ipcMain.on(CH.tabInput, (e, bytes: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin) || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > INPUT_MAX) {
    drop('tab:input', e);
    return;
  }
  tab.engine.input(bytes);
});

ipcMain.on(CH.tabTaken, (e, total: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin) || typeof total !== 'number' || !tab.engine.taken(total)) drop('tab:taken', e);
});

ipcMain.on(CH.tabResize, (e, cols: unknown, rows: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin) || !tab.engine.resize(cols as number, rows as number)) return drop('tab:resize', e);
  tab.begin(cols as number, rows as number);
});

// The tab's own file browser asks its own box, and nothing else. A path is a box's to understand, so main
// checks only that it is a plain string of a sane length and hands it on; what it means is worked out on the
// box itself and every answer names the folder as the box names it.
ipcMain.on(CH.tabFileAsk, (e, ask: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin)) return drop('tab:file-ask', e);
  const a = ask as Record<string, unknown> | null;
  const id = a?.['id'];
  const what = a?.['do'];
  const where = a?.['path'];
  const doing = what === 'list' || what === 'stat' || what === 'space' || what === 'read' || what === 'get' || what === 'put' || what === 'hash' || what === 'delete' || what === 'trash' || what === 'restore' || what === 'empty' || what === 'cancel' || what === 'unqueue' || what === 'grab';
  if (!a || typeof id !== 'number' || !Number.isInteger(id) || id < 1 || !doing || typeof where !== 'string' || where.length > 4096) {
    return drop('tab:file-ask', e);
  }
  // Bringing a file over is the one ask that touches the PC, so the view's part of it ends here: it names a
  // file on its own box and nothing else. Where the file lands, and what it is called when it gets there, are
  // main's to decide (plan B2.7).
  // Written down before either of them is started, because both begin by waiting on something and a stop that
  // arrives in that first moment would otherwise find nothing to stop.
  if (what === 'get' || what === 'put') {
    settling.add(comingKey(tab.id, id));
    if (what === 'get') void bringOver(tab, id, where);
    else void sendOver(tab, id, where);
    return;
  }
  // Fetching a small file so it can be carried out of the window. It is the same ask as a download in every
  // way a box can see; what differs is where it lands, which is Berth's own folder and never his (plan B4.5).
  if (what === 'grab') {
    const key = comingKey(tab.id, id);
    if (grabbing.has(key)) return;
    grabbing.add(key);
    void grabOver(tab, id, where);
    return;
  }
  // A stop is written down here as well as passed on, always, and for a moment afterwards. A transfer main
  // has taken in has not reached an engine yet, and one that has may finish before the stop lands: between
  // those two there is a gap a stop can fall into, and a stop that falls into it is a button that did
  // nothing. Written down, it is seen by whichever of the two is still to come.
  if (what === 'cancel') {
    const key = comingKey(tab.id, id);
    settling.add(`stop:${key}`);
    setTimeout(() => settling.delete(`stop:${key}`), 30_000).unref();
    if (settling.has(key)) return;
  }
  // Dropping what a tab still has to send. It never reaches a box: it is a list main is holding, and this
  // empties it. What is already moving is not touched, because that is its own transfer with its own Stop.
  if (what === 'unqueue') {
    const had = queuedToSend.get(tab.id)?.paths.length ?? 0;
    queuedToSend.delete(tab.id);
    sendTo(tab.view, CH.tabFilePage, { id, done: true, waiting: 0, unqueued: had });
    return;
  }
  // Which hash a box may be asked for is written down here and nowhere else: a view may ask for one of two
  // and can name no other, so no command of a view's choosing can reach a box through this (plan B2.5).
  if (what === 'hash') {
    const which = a['which'];
    if (which !== 'sha256' && which !== 'md5') return drop('tab:file-ask', e);
    if (!tab.engine.askFiles({ id, do: 'hash', path: where, name: which })) return drop('tab:file-ask', e);
    return;
  }
  // Putting something back names one thing inside the trash, and that name came from the box itself a moment
  // ago. It is passed on as a name and never as a path: the engine looks it up in that trash's own record.
  if (what === 'restore') {
    const name = a['name'];
    if (typeof name !== 'string' || name === '' || name.length > 512 || name.includes('/') || name.includes('\\')) return drop('tab:file-ask', e);
    if (!tab.engine.askFiles({ id, do: 'restore', path: where, name })) return drop('tab:file-ask', e);
    filesAsked.set('restore', (filesAsked.get('restore') ?? 0) + 1);
    return;
  }
  if (!tab.engine.askFiles({ id, do: what, path: where })) return drop('tab:file-ask', e);
  filesAsked.set(what, (filesAsked.get(what) ?? 0) + 1);

});
// What a view has asked of its box's files, by kind, for the lab to say which asks really left main.
const filesAsked = new Map<string, number>();

// ---- Downloads: what main decides (plan B4.2, B4.3) ----
// One folder holds everything brought over from a box, so a download can never land anywhere else and a person
// has one place to look. The name is worked out from the box's name for the file (common/landing.ts) and then
// made free of whatever is already in the folder: a download never writes over a file that is already there.
const downloadsInto = (): string => (LAB_PROFILE ? path.join(LAB_PROFILE, 'downloads') : path.join(app.getPath('downloads'), 'Berth'));
// Space to leave on the disk beyond the file itself, so a download cannot be the thing that fills it.
const spareOnDisk = 64 * 1024 * 1024;
type Coming = { tab: number; into: string; name: string; why: string };
const coming = new Map<string, Coming>(); // per tab and ask: what main knows that the engine does not
const comingBroke = new Map<string, { key: string; size: number; mtime: number }>(); // what to write down if it breaks
// Transfers main has taken in and not yet given to an engine: the stat for a download, the chooser for a send.
// A stop that arrives in that gap lands here, and is seen before anything starts.
const settling = new Set<string>();
const stopWanted = (tab: Tab, id: number): boolean => {
  const key = comingKey(tab.id, id);
  const wanted = settling.has(`stop:${key}`);
  settling.delete(`stop:${key}`);
  settling.delete(key);
  return wanted;
};
// And once a transfer is really under way, a stop that was written down a moment before it started is still
// its own: it is given to the engine, which is the only thing that can end a transfer that has begun.
const passOnAnyStop = (tab: Tab, id: number): void => {
  if (!settling.has(`stop:${comingKey(tab.id, id)}`)) return;
  settling.delete(`stop:${comingKey(tab.id, id)}`);
  tab.engine.askFiles({ id, do: 'cancel', path: '' });
};
const comingKey = (tab: number, id: number): string => `${tab}:${id}`;

async function bringOver(tab: Tab, id: number, remote: string): Promise<void> {
  const into = downloadsInto();
  const say = (error: string): void => sendTo(tab.view, CH.tabFilePage, { id, done: true, error });
  try {
    await mkdir(into, { recursive: true });
  } catch {
    stopWanted(tab, id);
    return say('pc-denied');
  }
  // How big the box says it is, before anything is opened on the PC. The room has to be settled first: a check
  // made while the file is already arriving is a race, and on a small file the file wins and lands on a disk
  // that was supposed to have refused it.
  const at = await askTheBox(tab, { do: 'stat', path: remote });
  if (at.error !== '') {
    stopWanted(tab, id);
    return say(at.error);
  }
  const size = at.attrs?.size ?? 0;
  const mtime = at.attrs?.mtime ?? 0;
  const key = brokeKey('in', tab.box?.id ?? '', remote);
  const had = broke.get(key);
  const resume = had !== undefined && had.size === size && had.mtime === mtime;
  const room = await roomFor(into, size);
  if (stopWanted(tab, id)) return say('stopped');
  if (!room) return say('pc-full');
  if (tabs.get(tab.id) !== tab) return;
  // The box's own name for the file, which is everything after the last separator, turned into one name this
  // PC can hold, and then into one nothing in the folder is already using.
  const asked = remote.split('/').pop() ?? '';
  const landed = safeName(asked);
  let taken: string[] = [];
  try {
    taken = await readdir(into);
  } catch {
    return say('pc-denied');
  }
  const name = freeName(landed.name, taken);
  const why = [landed.changed ? landed.why : '', name !== landed.name ? 'a file of that name was already here' : ''].filter((x) => x !== '').join(', ');
  if (tabs.get(tab.id) !== tab) return;
  coming.set(comingKey(tab.id, id), { tab: tab.id, into, name, why });
  comingBroke.set(comingKey(tab.id, id), { key, size, mtime });
  if (!tab.engine.askFiles(resume ? { id, do: 'get', path: remote, into, name, resume: true } : { id, do: 'get', path: remote, into, name })) {
    coming.delete(comingKey(tab.id, id));
    say('no-link');
  }
  settling.delete(comingKey(tab.id, id));
  passOnAnyStop(tab, id);
}

// ---- Uploads: what main decides (plan B4.3) ----
// Which file on the PC goes to a box is never a view's to say. The view names the folder on its own box; the
// file itself comes from the system's own chooser, which only a person can answer, and main hands the engine
// the whole path. A view cannot open the chooser twice over, and a tab that has gone takes its ask with it.
let choosing = false;
// The lab cannot press a button in the system's own chooser, so the self-test answers it here instead. Nothing
// but the self-test sets this, and it only exists where the self-test does.
let labChoosesAFile: (() => string | string[] | undefined) | null = null;
// What a tab still has to send, in the order it was chosen, and the folder it is going to. One at a time: a
// box asked for sixty files at once is a box that answers none of them quickly, and a strip with sixty lines
// in it says less than a strip with one line and a count.
const queuedToSend = new Map<number, { paths: string[]; folder: string }>();
// Sends main began itself, out of a queue, take numbers from a range of their own: above anything a view will
// ask for, and apart from main's own invisible asks, so neither can ever be taken for the other.
const QUEUED_ASKS_FROM = 2_000_000;
let queuedAskNext = QUEUED_ASKS_FROM;

async function sendOver(tab: Tab, id: number, folder: string): Promise<void> {
  const say = (error: string): void => sendTo(tab.view, CH.tabFilePage, { id, done: true, error });
  if (!win || !gate?.unlocked || choosing) {
    stopWanted(tab, id);
    return say('not-now');
  }
  choosing = true;
  let chosen: string[] = [];
  try {
    if (labChoosesAFile) {
      const said = labChoosesAFile();
      chosen = said === undefined ? [] : typeof said === 'string' ? [said] : said;
    }
    else {
      const picked = await dialog.showOpenDialog(win, { title: `Files to send to ${tab.box?.name ?? 'the box'}`, buttonLabel: 'Send', properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
      chosen = picked.canceled ? [] : picked.filePaths;
    }
  } finally {
    choosing = false;
  }
  if (stopWanted(tab, id)) return say('stopped');
  if (chosen.length === 0) return say('nothing-chosen');
  if (tabs.get(tab.id) !== tab) return;
  // The first of them goes now; the rest wait their turn, in the order they were chosen, and each begins as
  // the one before it ends. Anything past what one chooser may hand over is left, and the strip says so
  // rather than quietly dropping it (NOTHING fails silently).
  const rest = chosen.slice(1, MOST_AT_ONCE);
  const left = chosen.length - 1 - rest.length;
  if (rest.length > 0) queuedToSend.set(tab.id, { paths: rest, folder });
  if (rest.length > 0 || left > 0) sendTo(tab.view, CH.tabFilePage, { id, waiting: rest.length, tooMany: left });
  settling.delete(comingKey(tab.id, id));
  await startSend(tab, id, folder, chosen[0]!);
}

// One file on its way to a box: what main knows, and what the engine is told. The file a person chose first
// comes through here, and so does each one that was waiting behind it.
async function startSend(tab: Tab, id: number, folder: string, from: string): Promise<void> {
  // A send that ends here, rather than at the engine, still has to move the queue on, or one file that could
  // not be opened would leave everything chosen behind it waiting for an end that never comes. It is moved on
  // after this turn, not inside it, so sixty files that all fail at once do not stack sixty calls deep.
  const say = (error: string): void => {
    sendTo(tab.view, CH.tabFilePage, { id, done: true, error });
    setImmediate(() => nextQueued(tab));
  };
  // The name it will have on the box is the name it has here, and nothing of the path it came from.
  const name = path.basename(from);
  // The view is told that name, and only the name: it has a line of its own for this file from the moment
  // the chooser is answered, and a person watching sees what is going rather than "a file from the PC".
  sendTo(tab.view, CH.tabFilePage, { id, alsoSending: name });
  sendingNow.set(comingKey(tab.id, id), { tab: tab.id, id, from, name, folder });
  // A send that broke part way is taken up where it stopped, if the file on this PC is still the one those
  // bytes came from. What is checked at the end still covers the whole file.
  let was: { size: number; mtime: number } = { size: 0, mtime: 0 };
  try {
    const f = await stat(from);
    was = { size: f.size, mtime: Math.floor(f.mtimeMs / 1000) };
  } catch {
    sendingNow.delete(comingKey(tab.id, id));
    return say('failed');
  }
  const key = brokeKey('out', tab.box?.id ?? '', `${folder}/${name}`);
  const had = broke.get(key);
  const resume = had !== undefined && had.size === was.size && had.mtime === was.mtime;
  comingBroke.set(comingKey(tab.id, id), { key, size: was.size, mtime: was.mtime });
  if (!tab.engine.askFiles(resume ? { id, do: 'put', path: folder, name, from, resume: true } : { id, do: 'put', path: folder, name, from })) {
    sendingNow.delete(comingKey(tab.id, id));
    say('no-link');
  }
  passOnAnyStop(tab, id);
}

// The next file of a queue, once the one before it has ended, however it ended: a queue that stops at the
// first refusal would leave a person watching a strip that says nothing is happening. It is given a number of
// main's own, and the view is told the name so it has a line for it before any bytes move.
function nextQueued(tab: Tab): void {
  const queue = queuedToSend.get(tab.id);
  if (!queue) return;
  const from = queue.paths.shift();
  if (from === undefined || queue.paths.length === 0) queuedToSend.delete(tab.id);
  if (from === undefined) return;
  if (tabs.get(tab.id) !== tab || tab.engine.state !== 'ready') {
    queuedToSend.delete(tab.id);
    return;
  }
  const id = ++queuedAskNext;
  sendTo(tab.view, CH.tabFilePage, { id, waiting: queue.paths.length });
  void startSend(tab, id, queue.folder, from);
}

// Main's own asks on a tab's file channel, which no view sees. They take numbers from a range of their own,
// above anything a view will reach, and their answers are taken here rather than passed on.
const MAIN_ASKS_FROM = 1_000_000;
let mainAskNext = MAIN_ASKS_FROM;
const mainAsks = new Map<string, (p: Record<string, unknown>) => void>();

function askTheBox(tab: Tab, what: { do: string; path: string }): Promise<{ error: string; attrs?: { size: number; kind: string; mtime: number } }> {
  return new Promise((settle) => {
    const ask = ++mainAskNext;
    const key = comingKey(tab.id, ask);
    let attrs: { size: number; kind: string; mtime: number } | undefined;
    const done = setTimeout(() => {
      mainAsks.delete(key);
      settle({ error: 'no-answer' });
    }, 30_000);
    mainAsks.set(key, (p) => {
      const a = p['attrs'] as { size?: number; kind?: string; mtime?: number } | undefined;
      if (a && typeof a.size === 'number') attrs = { size: a.size, kind: String(a.kind ?? ''), mtime: typeof a.mtime === 'number' ? a.mtime : 0 };
      if (p['done'] !== true) return;
      clearTimeout(done);
      mainAsks.delete(key);
      const error = typeof p['error'] === 'string' ? p['error'] : '';
      settle(attrs ? { error, attrs } : { error });
    });
    if (!tab.engine.askFiles({ id: ask, do: what.do, path: what.path })) {
      clearTimeout(done);
      mainAsks.delete(key);
      settle({ error: 'no-link' });
    }
  });
}

// A file is already where one is being sent. Berth asks first, with both files in front of the person, and
// nothing on the box is touched until the answer comes back (BUILD-RULES 2.20). One question at a time: the
// window has one person at it.
let replaceAsked: ReplaceAsked | null = null;
type Sending = { tab: number; id: number; from: string; name: string; folder: string };
const sendingNow = new Map<string, Sending>();

function askAboutReplacing(mine: Sending, there: FileRow, sendingBytes: number): void {
  const tab = tabs.get(mine.tab);
  if (!tab) return;
  replaceAsked = { tab: mine.tab, box: tab.box?.name ?? '', folder: mine.folder, name: mine.name, bytes: there.size, changed: there.mtime, sendingBytes };
  // The tab is told its send is waiting on a question, so its own strip says that rather than a transfer that
  // seems to have stopped at nothing.
  sendTo(tab.view, CH.tabFilePage, { id: mine.id, asking: mine.name });
  overlay = true;
  stack();
  tellShell();
}

// The answer. Replace sends the same file again, saying this time that it may go in over what is there; Keep
// it leaves the box exactly as it was and tells the window so, rather than leaving the strip waiting.
function answerReplacing(replace: boolean): void {
  const asked = replaceAsked;
  replaceAsked = null;
  overlay = false;
  stack();
  if (!asked) return tellShell();
  const mine = sendingNow.get(comingKey(asked.tab, 0));
  const tab = tabs.get(asked.tab);
  sendingNow.delete(comingKey(asked.tab, 0));
  if (!tab || !mine) return tellShell();
  sendingNow.delete(comingKey(asked.tab, mine.id));
  sendTo(tab.view, CH.tabFilePage, { id: mine.id, asking: '' });
  if (!replace) {
    done = `${asked.name} on ${asked.box} was left as it was`;
    sendTo(tab.view, CH.tabFilePage, { id: mine.id, done: true, error: 'kept' });
    setImmediate(() => nextQueued(tab)); // whatever was chosen behind it still goes
    return tellShell();
  }
  done = `Replacing ${asked.name} on ${asked.box}`;
  sendingNow.set(comingKey(asked.tab, mine.id), mine);
  if (!tab.engine.askFiles({ id: mine.id, do: 'put', path: mine.folder, name: mine.name, from: mine.from, replace: true })) {
    sendTo(tab.view, CH.tabFilePage, { id: mine.id, done: true, error: 'no-link' });
    setImmediate(() => nextQueued(tab));
  }
  tellShell();
}

// Transfers that broke part way, so the next try can take one up where it stopped rather than start again.
// What is remembered is which file, at which end, and what it was when it broke: a file that has changed since
// is not the file those bytes came from, so that one starts again. Whatever happens, the hash at the end
// covers the whole file, so a wrong guess here cannot deliver a wrong file, only waste a transfer.
type Broke = { size: number; mtime: number };
const broke = new Map<string, Broke>();
const brokeKey = (way: string, box: string, where: string): string => `${way}:${box}:${where}`;
// The ways a transfer can end with bytes worth keeping. Anything else either wrote nothing or wrote something
// known to be wrong, and the engine has already taken its half-written file away.
const WORTH_TAKING_UP = new Set(['no-answer', 'no-link', 'failed', 'denied']);

// ---- Fetching a small file so it can be dragged (plan B4.5) ----
// A file on a box cannot be dragged into anything until it is on this PC, because Windows takes hold of a
// file and not of an idea of one. So a press on a small file fetches it, into a folder of Berth's own that
// nothing else writes to and that is emptied at every start and when a tab closes. It is a copy for carrying,
// not a download: it never goes near his download folder.
const grabRoot = (): string => (LAB_PROFILE ? path.join(LAB_PROFILE, 'carry') : path.join(os.tmpdir(), `berth-carry-${process.pid}-${randomBytes(6).toString('hex')}`));
const carryIn = grabRoot();
// Every start begins with an empty one: a copy left behind by a run that ended badly is not carried forward.
// It is emptied without blocking (B8.1: main never waits on the disk), and anything that would write into it
// waits for that to have happened, so a fetch can never land in a folder that is about to be removed.
const carryCleared = rm(carryIn, { recursive: true, force: true }).catch(() => undefined);
const grabbing = new Set<string>(); // asks that are fetching a file to carry, so one press does not start two

async function grabOver(tab: Tab, id: number, remote: string): Promise<void> {
  const say = (error: string): void => sendTo(tab.view, CH.tabFilePage, { id, done: true, error, carrying: true });
  const key = comingKey(tab.id, id);
  // Its own folder for this one ask, so two files of the same name never meet and nothing has to be renamed.
  const into = path.join(carryIn, String(tab.id), String(id));
  await carryCleared;
  const at = await askTheBox(tab, { do: 'stat', path: remote });
  if (at.error !== '') {
    grabbing.delete(key);
    return say(at.error);
  }
  if ((at.attrs?.size ?? 0) > GRAB_MAX) {
    grabbing.delete(key);
    return say('too-big-to-carry');
  }
  try {
    await mkdir(into, { recursive: true });
  } catch {
    grabbing.delete(key);
    return say('pc-denied');
  }
  if (tabs.get(tab.id) !== tab) return;
  const name = safeName(remote.split('/').pop() ?? '').name;
  carrying.set(key, { into, name });
  if (!tab.engine.askFiles({ id, do: 'get', path: remote, into, name })) {
    carrying.delete(key);
    grabbing.delete(key);
    say('no-link');
  }
}
// What each carrying ask is fetching, and where: main's own knowledge, as with a download (B4.2).
const carrying = new Map<string, { into: string; name: string }>();

// ---- Dragging a file out of the window (plan B4.5) ----
// What a tab may drag out: files its own engine brought over, by the number of the ask that brought each.
// A view names a number and never a path, so a view that has been taken over can drag out nothing it was not
// given, and nothing of another tab's (B2.7).
const draggable = new Map<string, string>();
// The lab cannot take hold of a real drag, so it watches what main handed to the system instead. Nothing but
// the self-test sets this.
let labWatchesDrags: ((file: string) => void) | null = null;

ipcMain.on(CH.tabDrag, (e: IpcMainEvent, ask: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin)) return drop('tab:drag', e);
  if (typeof ask !== 'number' || !Number.isInteger(ask) || ask < 1) return drop('tab:drag', e);
  const file = draggable.get(comingKey(tab.id, ask));
  if (file === undefined) return drop('tab:drag', e); // not a file this tab brought over: there is nothing to drag
  void handOver(tab, ask, file);
});

// What main knows about a file is what it knew when the file landed, and the download folder is his: a file
// can be moved, renamed or deleted between landing and the hand reaching for it. So it is looked for again
// before it is handed to the system, and if it has gone the window says so rather than handing over a path to
// nothing (NOTHING fails silently).
async function handOver(tab: Tab, ask: number, file: string): Promise<void> {
  try {
    const f = await stat(file);
    if (!f.isFile()) throw new Error('not a file');
  } catch {
    draggable.delete(comingKey(tab.id, ask));
    sendTo(tab.view, CH.tabFilePage, { id: ask, dragGone: true });
    return;
  }
  if (tabs.get(tab.id) !== tab) return;
  dragsAsked++;
  if (labWatchesDrags) return labWatchesDrags(file);
  // The window hands the file to the system itself. An icon is asked for from the system rather than drawn by
  // us, so what is under the hand is the file's own kind.
  const icon = await app.getFileIcon(file, { size: 'normal' }).catch(() => nativeImage.createEmpty());
  if (tabs.get(tab.id) === tab) tab.view.webContents.startDrag({ file, icon });
}
// How many drags main has acted on, for the lab.
let dragsAsked = 0;

// How much room the disk has left for one more file. The file being replaced, if there is one, is still there
// while the new one is written, so what must fit is the whole of the new file beside everything already on the
// disk, and not the difference between them.
async function roomFor(into: string, bytes: number): Promise<boolean> {
  try {
    const d = await statfs(into);
    return Number(d.bsize) * Number(d.bavail) >= bytes + spareOnDisk;
  } catch {
    return true; // a disk that will not say is not a reason to refuse: the write itself will say
  }
}

// Select to copy. A tab may leave plain text on the clipboard only while it is the tab in front of the window
// that is in use: a tab nobody is looking at cannot change what the next paste holds (plan B2.7).
// A new session, asked for by the tab (the picture's Reconnect, Now and Cancel; R while a bar is showing).
// A tab's box asked to be told where a paste begins and ends (or stopped asking): its own view says so.
ipcMain.on(CH.tabLink, (e, url: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin) || typeof url !== 'string' || url === '') return drop('tab:link', e);
  linkAsked(tab, url);
});

ipcMain.on(CH.tabPasteMode, (e, on: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin) || typeof on !== 'boolean') return drop('tab:paste-mode', e);
  protectedPaste.set(tab.id, on);
});

ipcMain.on(CH.tabReopen, (e, now: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin) || typeof now !== 'boolean' || !tab.box) return drop('tab:reopen', e);
  if (now) tab.reopen(true);
  else tab.stopReopen(true);
});

ipcMain.on(CH.tabCopy, (e, text: unknown) => {
  const tab = tabByContents.get(e.sender.id);
  if (!tab || !fromMainFrameOf(e, tab.origin) || typeof text !== 'string' || text.length === 0 || text.length > COPY_MAX) return drop('tab:copy', e);
  if (tab.id !== active || overlay || !win?.isFocused()) return void copiesRefused++;
  clipboard.writeText(text);
  const lines = text.split('\n').length;
  done = `Copied ${lines} ${lines === 1 ? 'line' : 'lines'}`;
  tellShell();
});

ipcMain.on(CH.shellCmd, (e, cmd: unknown) => {
  if (!shell || e.sender.id !== shell.webContents.id || !fromMainFrameOf(e, 'app://shell')) {
    drop('shell:cmd');
    return;
  }
  const c = cmd as Partial<ShellCmd> | null;
  // Without the password nothing opens: before unlock the shell's only messages are the gate's.
  if (!gate?.unlocked) {
    drop('shell:cmd');
    return;
  }
  const isBox = (v: unknown): v is string => typeof v === 'string' && !!boxes?.get(v);
  if (c?.op === 'new') openTab();
  else if (c?.op === 'open' && isBox(c.box) && typeof c.place === 'string') {
    const box = boxes!.get(c.box)!;
    const t = openTab(c.box, c.place);
    done = t ? '' : box.pin === '' ? `${box.name} was never checked: open its check first` : `no more tabs: ${TABS_MAX} at most`;
    tellShell();
  } else if (c?.op === 'overlay' && typeof c.on === 'boolean') {
    overlay = c.on;
    stack();
  } else if (c?.op === 'addBox' && typeof c.req === 'number' && boxes) {
    const b = boxes;
    // A key file chosen for this box is used in place of a key made here. It must have opened first: adding
    // with a file that has not opened would be adding with no key at all.
    const chosen = keyFile;
    const withKey = chosen && chosen.shown.publicKey !== '' ? { file: chosen.bytes, passphrase: chosen.passphrase } : undefined;
    if (chosen && !withKey) {
      added = { req: c.req, ok: false, id: '', error: chosen.shown.fault || 'that key file has not opened yet', fields: {} };
      tellShell();
      return;
    }
    void b.add(c.draft as BoxDraft, withKey).then((r) => {
      added = { req: c.req!, ok: r.ok, id: r.ok ? r.id : '', error: r.ok ? '' : r.error, fields: r.ok ? {} : (r.fields ?? {}) };
      if (r.ok) {
        const brought = withKey !== undefined;
        dropKeyFile();
        // A box whose key came from a file is still checked before it opens: the check is about who the box
        // is, not about how Berth got its key. What it does not need is the block run on the box, because the
        // box already holds this key: that is the whole point of bringing one in (plan O1).
        openCheck = r.id;
        askedAt.set(r.id, [new Date().toISOString()]);
        b.reach(r.id);
        done = brought
          ? `Added ${b.get(r.id)!.name} with your own key, and Berth is asking it who it is`
          : `Added ${b.get(r.id)!.name}: its key was made, and Berth is asking it who it is`;
      }
      tellShell();
    });
  } else if (c?.op === 'editBox' && typeof c.req === 'number' && isBox(c.box) && boxes) {
    const b = boxes;
    const id = c.box;
    const was = b.get(id)!.name;
    void b.edit(id, c.draft as BoxDraft).then((r) => {
      added = { req: c.req!, ok: r.ok, id: r.ok ? r.id : '', error: r.ok ? '' : r.error, fields: r.ok ? {} : (r.fields ?? {}) };
      if (r.ok) {
        const now = b.get(id)!;
        done = now.pin === '' ? `Saved ${now.name}: its address changed, so it is checked again before it opens` : `Saved ${was === now.name ? now.name : `${was}, now ${now.name}`}`;
      }
      tellShell();
    });
  } else if (c?.op === 'forgetIdentity' && isBox(c.box) && boxes) {
    const b = boxes;
    const id = c.box;
    void b.forget(id).then((r) => {
      done = r.ok ? `${b.get(id)?.name ?? 'The box'} is checked again before it opens` : `Its identity could not be forgotten: ${r.error}`;
      tellShell();
    });
  } else if (c?.op === 'removeBox' && isBox(c.box) && boxes) {
    const b = boxes;
    const id = c.box;
    const name = b.get(id)!.name;
    // Every tab on that box goes with it: there is nothing left for them to be on.
    for (const t of [...tabs.values()]) if (t.box?.id === id) closeTab(t.id);
    void b.remove(id).then((r) => {
      done = r.ok ? `Deleted ${name}, and its key with it` : `${name} was not deleted: ${r.error}`;
      tellShell();
    });
  } else if (c?.op === 'check' && isBox(c.box)) {
    openCheck = c.box;
    askedAt.set(c.box, [...(askedAt.get(c.box) ?? []).slice(-3), new Date().toISOString()]);
    boxes!.reach(c.box);
  } else if (c?.op === 'paste' && isBox(c.box) && c.box === openCheck && typeof c.text === 'string' && c.text.length <= 64 * 1024) {
    boxes!.paste(c.box, c.text);
  } else if (c?.op === 'trust' && isBox(c.box) && c.box === openCheck) {
    const b = boxes!;
    const id = c.box;
    void b.trust(id).then((r) => {
      if (r.ok) {
        openCheck = '';
        overlay = false;
        const box = b.get(id)!;
        done = `Trusted ${box.name}: ${box.pinFingerprint}`;
        openTab(id, '');
        stack();
      } else done = `Not trusted: ${r.error}`;
      tellShell();
    });
  } else if (c?.op === 'closeCheck' && isBox(c.box)) {
    boxes!.cancelCheck(c.box);
    if (openCheck === c.box) openCheck = '';
    tellShell();
  } else if (c?.op === 'copyBlock' && isBox(c.box)) {
    // Main writes only the text it made itself: the block, with the box's own key line in it.
    void clipboard.writeText(boxes!.block(c.box));
    done = `Copied the block for ${boxes!.get(c.box)!.name}`;
    tellShell();
  } else if (c?.op === 'select' && typeof c.id === 'number' && tabs.has(c.id)) {
    goToTab(c.id);
  } else if (c?.op === 'openLink' && waitingLink) closeLink(true);
  else if (c?.op === 'dropLink' && waitingLink) closeLink(false);
  else if (c?.op === 'sendPaste' && waitingPaste) closePaste(true);
  else if (c?.op === 'dropPaste' && waitingPaste) closePaste(false);
  else if (c?.op === 'window' && (c.do === 'minimize' || c.do === 'maximize' || c.do === 'close')) {
    // The window's own three buttons. Berth draws them, so it must do what they say; `close` goes the same way
    // as the window's own close, and not straight to an exit, so whatever stands in the way of closing stands
    // in the way of this button too.
    if (!win) return;
    windowAsked.push(c.do); // for the lab: a window manager decides what happens, but the asking is Berth's
    if (c.do === 'minimize') win.minimize();
    else if (c.do === 'close') win.close();
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (c?.op === 'replaceFile' && replaceAsked) {
    answerReplacing(true);
  } else if (c?.op === 'keepFile' && replaceAsked) {
    answerReplacing(false);
  } else if (c?.op === 'closeApp') {
    // Asked and answered: close for real. The question is dropped first, so a second close is a plain close.
    closingAsked = null;
    closingForReal = true;
    win?.close();
  } else if (c?.op === 'pickKeyFile') {
    // Which file it is stays main's own, from the system's chooser: a view may type a passphrase, never name a
    // file (the same rule the way back from a damaged list follows).
    if (!win || !gate?.unlocked) return;
    const w = win;
    void dialog
      .showOpenDialog(w, { title: 'A key file you already have', properties: ['openFile', 'dontAddToRecent'] })
      .then((picked) => {
        const file = picked.filePaths[0];
        if (!picked.canceled && file) void chooseKeyFile(file);
      });
  } else if (c?.op === 'dropKeyFile') {
    dropKeyFile();
    tellShell();
  } else if (c?.op === 'keepApp') {
    closingAsked = null;
    done = 'The window was kept open';
    tellShell();
  } else if (c?.op === 'close' && typeof c.id === 'number') closeTab(c.id);
  else drop('shell:cmd');
});

// The gate's three messages: from the shell view's own main frame only.
const fromShell = (e: IpcMainEvent): boolean => !!shell && e.sender.id === shell.webContents.id && fromMainFrameOf(e, 'app://shell');

ipcMain.on(CH.gateCreate, (e, password: unknown) => {
  if (!fromShell(e) || !gate || !(password instanceof Uint8Array)) return void drop('gate');
  void gate.create(password);
});

ipcMain.on(CH.gateUnlock, (e, password: unknown) => {
  if (!fromShell(e) || !gate || !(password instanceof Uint8Array)) return void drop('gate');
  void gate.unlock(password);
});

// The passphrase of a chosen key file. Raw bytes on their own channel, as every password is; used at once to
// open the file again and kept only while that file is chosen, so that adding the box can use it.
ipcMain.on(CH.keyPassphrase, (e, bytes: unknown) => {
  if (!fromShell(e) || !gate?.unlocked || !keyFile) return void drop('key');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024) return void drop('key');
  keyFile.passphrase.fill(0);
  keyFile.passphrase = Buffer.from(bytes);
  bytes.fill(0);
  void tryKeyFile();
});

// A list that cannot be read: the ways back. The file is always main's own, never named by a view.
ipcMain.on(CH.gatePickRestore, (e) => {
  if (!fromShell(e) || !gate || !win || gate.state.phase !== 'damaged') return void drop('gate');
  const g = gate;
  void dialog
    .showOpenDialog(win, {
      title: 'A backup of the list',
      defaultPath: g.state.backupDir || path.dirname(listOnDisk),
      filters: [{ name: 'Berth list', extensions: ['berth'] }],
      properties: ['openFile'],
    })
    .then((picked) => {
      const file = picked.filePaths[0];
      if (!picked.canceled && file) g.chooseRestore(file);
    });
});

ipcMain.on(CH.gateUsePrevious, (e) => {
  if (!fromShell(e) || !gate || gate.state.phase !== 'damaged' || !gate.state.hasPrevious || listOnDisk === '') return void drop('gate');
  gate.chooseRestore(`${listOnDisk}.previous`);
});

ipcMain.on(CH.gateForgetRestore, (e) => {
  if (!fromShell(e) || !gate || gate.state.phase !== 'damaged') return void drop('gate');
  gate.forgetRestore();
});

ipcMain.on(CH.gateRestore, (e, password: unknown) => {
  // A password may be typed by the view; which file it opens is main's own and must already be chosen. A
  // message that arrives without one is a message the view may not send: it is dropped and counted, not
  // turned into something the person is told (plan B2.7).
  if (!fromShell(e) || !gate || !(password instanceof Uint8Array) || gate.state.phase !== 'damaged' || gate.state.restoreFrom === '') return void drop('gate');
  void gate.restore(password);
});

ipcMain.on(CH.gatePickBackup, (e) => {
  if (!fromShell(e) || !gate || !win || gate.state.phase !== 'create') return void drop('gate');
  const g = gate;
  void dialog.showOpenDialog(win, { title: 'Backup folder', defaultPath: g.state.backupDir, properties: ['openDirectory', 'createDirectory'] }).then((picked) => {
    const dir = picked.filePaths[0];
    if (!picked.canceled && dir) void g.setBackupDir(dir);
  });
});

// The meter's two messages. They carry numbers only, and only from a known view's own main frame.
function knownView(e: IpcMainEvent): { tab: Tab | null } | null {
  const tab = tabByContents.get(e.sender.id);
  if (tab) return fromMainFrameOf(e, tab.origin) ? { tab } : null;
  if (shell && e.sender.id === shell.webContents.id && fromMainFrameOf(e, 'app://shell')) return { tab: null };
  return null;
}

ipcMain.on(CH.meterReport, (e, numbers: unknown) => {
  const from = knownView(e);
  if (!from || !meter.fromView(numbers, from.tab ? from.tab.id : 0)) drop('meter:report', e);
});

ipcMain.on(CH.meterFrame, (e) => {
  const from = knownView(e);
  if (!from) {
    drop('meter:frame', e);
    return;
  }
  if (from.tab) meter.tabPainted(from.tab.id);
  else meter.firstFrame();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  // A second launch changes nothing here, and its arguments are never read.
  app.on('second-instance', () => {
    if (win) win.focus();
  });

  void app.whenReady().then(async () => {
    const kind = !app.isPackaged ? 'dev' : LAB ? 'lab' : 'release';
    const asked = process.env['SSHAPP_SELFTEST'] ?? '';
    SELFTEST = kind !== 'release' && ['all', 'engine-must-be-refused', 'hold', 'seven', 'picture', 'direction', 'gate-unlock', 'gate-restore', 'gate-shot', 'boxes-ui'].includes(asked) ? asked : '';
    if (SELFTEST === 'direction') await listFiles('directions');
    await listFiles('shell');
    await listFiles('tab');
    // A lab or development run may ask for a window size (for pictures). A release build never reads this.
    const asksSize = kind !== 'release' ? /^(\d{3,4})x(\d{3,4})$/.exec(process.env['SSHAPP_WINDOW'] ?? '') : null;
    meter.start();
    setInterval(lookPace, PACE_EVERY_MS).unref();
    harden(session.defaultSession);
    const shellSession = session.fromPartition('shell', { cache: false });
    harden(shellSession);

    // No frame of Windows' own: the bar at the top of the shell is Berth's title bar, with Berth's own mark,
    // name and three buttons. `titleBarStyle: 'hidden'` rather than `frame: false`, because it takes away the
    // title bar and leaves the window itself alone: the edges still resize, and Windows still snaps the window
    // to a side or a corner, which a frameless window has to imitate badly or go without.
    win = new BaseWindow({ width: 1280, height: 800, minWidth: 800, minHeight: 500, backgroundColor: '#161e25', title: 'Berth', useContentSize: true, titleBarStyle: 'hidden' });
    if (asksSize) win.setContentSize(Number(asksSize[1]), Number(asksSize[2]));
    win.setMenu(null);
    shell = new WebContentsView({ webPreferences: viewPrefs(shellSession, 'preload-shell.js', true) });
    // The shell's middle is clear: when it is above the tabs (a menu or dialog open), the tab shows through it.
    shell.setBackgroundColor('#00000000');
    win.contentView.addChildView(shell);
    shell.webContents.once('did-finish-load', () => {
      tellShell();
      tellGate();
    });
    // The same keys when the focus is on the shell itself: the row of tabs, a menu, the status line.
    shell.webContents.on('before-input-event', (e, input) => {
      if (windowKey(input)) e.preventDefault();
    });
    // The key process, and the lock in front of everything else.
    const listFile = path.join(app.getPath('userData'), 'list.berth');
    listOnDisk = listFile;
    const backups = LAB_PROFILE ? path.join(LAB_PROFILE, 'backups') : path.join(app.getPath('documents'), 'Berth backups');
    const k = new KeyProc(ENGINE_BIN, ENGINE_HASHES, listFile, () => void g.keysChanged());
    const b = new Boxes(k, identifyWith(ENGINE_BIN, ENGINE_HASHES), firstConnection.block, tellShell);
    const g = new Gate(k, tellGate, backups, (publicPart, keyInfos) => b.load(publicPart, keyInfos));
    keys = k;
    gate = g;
    boxes = b;
    void k.start();
    win.on('resize', layout);
    // The window can be maximized and restored without either button being pressed: a double-click on the bar,
    // Windows' own snapping, the keyboard. The button must show where the window stands whatever moved it.
    win.on('maximize', tellShell);
    win.on('unmaximize', tellShell);
    // Closing the window ends every session in it, so it asks first and names what would go. Every way of
    // closing comes through here: Berth's own close button (which calls win.close()), Alt+F4, and the taskbar.
    win.on('close', (e: Electron.Event) => {
      if (closingForReal) return;
      const would = whatWouldEnd();
      if (would.live.length === 0) return; // nothing to lose: it closes as it always did
      e.preventDefault();
      closingAsked = would;
      tellShell();
    });
    win.on('closed', () => {
      keys?.close();
      for (const t of tabs.values()) t.engine.close();
      win = null;
    });
    layout();
    const shellLoaded = shell.webContents.loadURL('app://shell/index.html');
    // One line for whoever started the app from a terminal or a test: it is up, and what kind of build it is.
    void shellLoaded.then(() => process.stderr.write(`READY kind=${kind} ms=${Math.round(process.uptime() * 1000)}\n`));
    // And one more once the lock knows where it stands: "create" on a first start, "locked" after that.
    const said = setInterval(() => {
      if (g.state.phase === 'starting') return;
      clearInterval(said);
      process.stderr.write(`GATE ${g.state.phase}\n`);
    }, 50);

    if (SELFTEST) {
      const { runSelfTest } = await import('./selftest');
      await runSelfTest({ gate: g, keys: k, boxes: b, signsRefused: () => signsRefused, signsPassedOn: () => signsPassedOn, signAs: (boxId: string, req: SignRequest) => {
        const box = b.get(boxId);
        return box ? signFor(box, req) : Promise.resolve({ error: 'no such box' });
      }, listFile, backups, shell, shellLoaded, openTab, closeTab, tabs, shellState, dropped: () => droppedMessages, droppedOn: () => Object.fromEntries(droppedOn), lateFromClosed: () => lateFromClosed, missing: () => Object.fromEntries(missing), opened: () => ({ url: lastOpened, asked: opensAsked, refused: linksRefused }), windowAsked: () => [...windowAsked], keysRefused: () => keysRefused, overlayOn: () => overlay, windowInUse: () => win?.isFocused() ?? false, downloads: downloadsInto(), filesAsked: () => Object.fromEntries(filesAsked), chooseKeyFile, chooseToSend: (answer: (() => string | string[] | undefined) | null) => void (labChoosesAFile = answer), stillToSend: (tab: number) => queuedToSend.get(tab)?.paths.length ?? 0, watchDrags: (watch: ((file: string) => void) | null) => void (labWatchesDrags = watch), dragsAsked: () => dragsAsked, canDrag: (tab: number) => [...draggable.keys()].filter((k) => k.startsWith(`${tab}:`)).length, keyPassphrase: (p: string) => {
        if (!keyFile) return;
        keyFile.passphrase.fill(0);
        keyFile.passphrase = Buffer.from(p, 'utf8');
        return tryKeyFile();
      }, kind, mode: SELFTEST, meter, pace, forcePace: (share: number | null) => {
        pace.force(share);
        lookPace();
      }, win, dist: DIST, harden, newView: (partition: string) => {
        const ses = session.fromPartition(partition, { cache: false });
        harden(ses);
        return new WebContentsView({ webPreferences: viewPrefs(ses, 'preload-shell.js', false) });
      } });
    } else {
      await shellLoaded;
    }
  });
}

export type { Tab };
