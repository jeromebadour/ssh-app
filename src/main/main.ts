// The main process: the window, the views, the engines, and the few messages that cross between them.
// It holds no key, opens no network connection and parses nothing a box sent.
import { app, BaseWindow, clipboard, dialog, ipcMain, protocol, session, WebContentsView, type IpcMainEvent, type Session } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import firstConnection from '../../protocol/first-connection.json';
import { addrOf, type Box, type BoxDraft } from '../common/boxes';
import { CH, COPY_MAX, INPUT_MAX, TABS_MAX, type BoxView, type CheckShown, type ShellCmd, type ShellState, type TabInfo } from '../common/ipc';
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
  origin: string;
  box: Box | null; // the one box this tab's engine was aimed at; null for the skeleton's tab with no box
  place: string;
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
  return { id: t.id, state: t.engine.state, cause: t.engine.cause, box: t.box ? { id: t.box.id, name: t.box.name, colour: t.box.colour, place: t.place } : null, link: t.engine.link };
}

function boxView(b: Box): BoxView {
  return { id: b.id, name: b.name, colour: b.colour, host: b.host, port: b.port, user: b.user, folder: b.folder, places: b.places.map((p) => p.name), pinned: b.pin !== '', pinFingerprint: b.pinFingerprint, pinType: b.pin.startsWith('ssh-rsa ') ? 'RSA' : b.pin === '' ? '' : 'ED25519', pinnedAt: b.pinnedAt };
}

function checkShown(): CheckShown | null {
  const box = openCheck ? boxes?.get(openCheck) : undefined;
  if (!boxes || !box) return null;
  return { ...boxes.check(box.id), name: box.name, addr: addrOf(box), block: boxes.block(box.id), askedAt: askedAt.get(box.id) ?? [] };
}

function shellState(): ShellState {
  return { tabs: [...tabs.values()].map(info), active, boxes: gate?.unlocked && boxes ? boxes.list.map(boxView) : [], boxesFault: boxes?.fault ?? '', check: gate?.unlocked ? checkShown() : null, added, done };
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
  const origin = `app://tab-${id}`;
  // Its own partition (in memory only) and its own origin: nothing is shared with another tab.
  const ses = session.fromPartition(`tab-${id}`, { cache: false });
  harden(ses);
  // A tab never slows its box because its view is hidden: background throttling is off for tab views.
  const view = new WebContentsView({ webPreferences: viewPrefs(ses, 'preload-tab.js', false) });
  const engine = new Engine(ENGINE_BIN, ENGINE_HASHES, id, {
    // An engine can outlive its tab for a moment (it ends after its view is closed): then only the shell is told.
    output: (bytes) => {
      if (tabs.get(id) === tab) sendTo(view, CH.tabOutput, bytes);
    },
    state: () => {
      if (tabs.get(id) === tab) sendTo(view, CH.tabState, info(tab));
      tellShell();
    },
    link: () => {
      if (tabs.get(id) === tab) sendTo(view, CH.tabState, info(tab));
      tellShell();
    },
    // Text a box sent before sign-in: it goes to the tab's own view, for its terminal, and nowhere else.
    banner: (bytes) => {
      if (tabs.get(id) === tab) sendTo(view, CH.tabBanner, bytes);
    },
    sign: (req) => (aimedAt ? signFor(aimedAt, req) : Promise.resolve({ error: 'refused' })),
  }, aim);
  // A box's terminal is opened at the size its view really has, so the engine starts when the view has said
  // its size. A view that says nothing does not hold the tab up: after two seconds the engine starts anyway.
  let begun = false;
  const begin = (cols: number, rows: number): void => {
    if (begun) return;
    begun = true;
    engine.openAt(cols, rows);
    void engine.start();
  };
  const tab: Tab = { id, view, engine, begin, origin, box, place };
  tabs.set(id, tab);
  tabByContents.set(view.webContents.id, tab);
  win.contentView.addChildView(view);
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
      }, listFile, backups, shell, shellLoaded, openTab, closeTab, tabs, shellState, dropped: () => droppedMessages, droppedOn: () => Object.fromEntries(droppedOn), lateFromClosed: () => lateFromClosed, missing: () => Object.fromEntries(missing), kind, mode: SELFTEST, meter, pace, forcePace: (share: number | null) => {
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
