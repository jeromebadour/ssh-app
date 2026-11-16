// The main process: the window, the views, the engines, and the few messages that cross between them.
// It holds no key, opens no network connection and parses nothing a box sent.
import { app, BaseWindow, clipboard, dialog, ipcMain, protocol, session, shell as osShell, WebContentsView, type IpcMainEvent, type Session } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import firstConnection from '../../protocol/first-connection.json';
import { addrOf, type Box, type BoxDraft } from '../common/boxes';
import { CH, COPY_MAX, INPUT_MAX, TABS_MAX, type BoxView, type CheckShown, type LinkAsked, type PasteShown, type ShellCmd, type ShellState, type TabInfo } from '../common/ipc';
import { look } from '../common/paste';
import { Boxes } from './boxes';
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
const LAB_RUN = !app.isPackaged || LAB;
const LAB_PROFILE = LAB_RUN ? (process.env['SSHAPP_PROFILE'] ?? (process.env['SSHAPP_SELFTEST'] ? path.join(os.tmpdir(), `berth-lab-${process.pid}`) : '')) : '';
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
// For now it is written to stderr; the local log with an id per failure replaces this in step 2.
process.on('uncaughtException', (err) => {
  process.stderr.write(`MAINFAULT ${err.stack ?? String(err)}\n`);
  if (SELFTEST) app.exit(70);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`MAINFAULT (rejection) ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  if (SELFTEST) app.exit(70);
});

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
  stopReopen(): void;
  againAt: number; // when the new session opens; 0 when none is coming
  origin: string;
  box: Box | null; // the one box this tab's engine was aimed at; null for the skeleton's tab with no box
  place: string;
}

// An ending Berth never opens a new session after: the same thing would happen again, or it is the person's
// own doing. A changed identity and a refused key are stops, not hiccups (plan A3 decision 6, B8).
const NEVER_AGAIN: readonly string[] = ['identity-changed', 'sign-in-failed', 'no-signature', 'weak-offer', 'cancelled', 'shell-exited'];
const AGAIN_AFTER_MS = 5000;

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
  if (gate) sendTo(shell, CH.gateState, gate.view());
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
  return { tabs: [...tabs.values()].map(info), active, boxes: gate?.unlocked && boxes ? boxes.list.map(boxView) : [], boxesFault: boxes?.fault ?? '', check: gate?.unlocked ? checkShown() : null, added, done, paste: waitingPaste?.shown ?? null, link: waitingLink };
}

// ---- An address a box printed (plan B2.7) ----
// A box can print whatever it likes, so nothing it prints opens by itself: the terminal's own opening is off,
// a link hidden behind other words is refused before the terminal sees it, and a plain click does nothing. A
// Ctrl+click asks here, and the whole address is shown on the window's own surface before anything opens.
let waitingLink: LinkAsked | null = null;
let linksRefused = 0;
let lastOpened = ''; // the last address handed to Windows, for the lab
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
  sendTo(shell, CH.shellState, shellState());
}

const frontTold = new Map<number, boolean>(); // what each tab's view was last told: in front, or not

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
  if (!keys || !gate?.unlocked || req.key !== box.id || req.algorithm !== 'ssh-ed25519') {
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
    if (!t || t !== tab || !box || t.againAt > 0) return;
    const l = t.engine.link;
    if (l.phase !== 'ended' || NEVER_AGAIN.includes(l.cause)) return;
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
  const stopReopen = (): void => {
    if (againTimer) clearTimeout(againTimer);
    againTimer = null;
    tab.againAt = 0;
    if (tabs.get(id) === tab) sendTo(view, CH.tabState, info(tab));
    tellShell();
  };
  const reopen = (now: boolean): void => {
    if (!box || tabs.get(id) !== tab) return;
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
  const tab: Tab = { id, view, engine, begin, reopen, stopReopen, againAt: 0, origin, box, place };
  tabs.set(id, tab);
  tabByContents.set(view.webContents.id, tab);
  win.contentView.addChildView(view);
  // A paste is a person's own doing, and main must have seen it: these two events reach main before the page
  // sees anything. The view is never asked, and never asks.
  view.webContents.on('before-input-event', (_e, input) => {
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
  else tab.stopReopen();
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
    void b.add(c.draft as BoxDraft).then((r) => {
      added = { req: c.req!, ok: r.ok, id: r.ok ? r.id : '', error: r.ok ? '' : r.error, fields: r.ok ? {} : (r.fields ?? {}) };
      if (r.ok) {
        // A new box goes straight to its check: there is no other way to its first sign-in.
        openCheck = r.id;
        askedAt.set(r.id, [new Date().toISOString()]);
        b.reach(r.id);
        done = `Added ${b.get(r.id)!.name}: its key was made, and Berth is asking it who it is`;
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
    active = c.id;
    meter.tabSwitchBegins(c.id);
    frontTold.delete(c.id); // told again even if it was in front already: its frame ends the switch
    layout();
    tellShell();
  } else if (c?.op === 'openLink' && waitingLink) closeLink(true);
  else if (c?.op === 'dropLink' && waitingLink) closeLink(false);
  else if (c?.op === 'sendPaste' && waitingPaste) closePaste(true);
  else if (c?.op === 'dropPaste' && waitingPaste) closePaste(false);
  else if (c?.op === 'close' && typeof c.id === 'number') closeTab(c.id);
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
    SELFTEST = kind !== 'release' && ['all', 'engine-must-be-refused', 'hold', 'seven', 'picture', 'direction', 'gate-unlock', 'gate-shot', 'boxes-ui'].includes(asked) ? asked : '';
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

    win = new BaseWindow({ width: 1280, height: 800, minWidth: 800, minHeight: 500, backgroundColor: '#161e25', title: 'Berth', useContentSize: true });
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
    // The key process, and the lock in front of everything else.
    const listFile = path.join(app.getPath('userData'), 'list.berth');
    const backups = LAB_PROFILE ? path.join(LAB_PROFILE, 'backups') : path.join(app.getPath('documents'), 'Berth backups');
    const k = new KeyProc(ENGINE_BIN, ENGINE_HASHES, listFile, () => void g.keysChanged());
    const b = new Boxes(k, identifyWith(ENGINE_BIN, ENGINE_HASHES), firstConnection.block, tellShell);
    const g = new Gate(k, tellGate, backups, (publicPart, keyInfos) => b.load(publicPart, keyInfos));
    keys = k;
    gate = g;
    boxes = b;
    void k.start();
    win.on('resize', layout);
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
      }, listFile, backups, shell, shellLoaded, openTab, closeTab, tabs, shellState, dropped: () => droppedMessages, droppedOn: () => Object.fromEntries(droppedOn), lateFromClosed: () => lateFromClosed, missing: () => Object.fromEntries(missing), opened: () => ({ url: lastOpened, asked: opensAsked, refused: linksRefused }), kind, mode: SELFTEST, meter, pace, forcePace: (share: number | null) => {
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
