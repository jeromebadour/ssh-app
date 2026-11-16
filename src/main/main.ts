// The main process: the window, the views, the engines, and the few messages that cross between them.
// It holds no key, opens no network connection and parses nothing a box sent.
import { app, BaseWindow, dialog, ipcMain, protocol, session, WebContentsView, type IpcMainEvent, type Session } from 'electron';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CH, INPUT_MAX, TABS_MAX, type ShellCmd, type ShellState, type TabInfo } from '../common/ipc';
import { Engine } from './engine';
import { Gate } from './gate';
import { KeyProc } from './keyproc';
import { isLabPackageNow } from './lab-proof';
import { Meter } from './meter';

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
const BAR = 44;
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
  tab: {
    '/index.html': ['tab/index.html', 'text/html; charset=utf-8'],
    '/tab.js': ['tab/tab.js', 'text/javascript; charset=utf-8'],
    '/tab.css': ['tab/tab.css', 'text/css; charset=utf-8'],
  },
};

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
// A kind's files are listed once, from its own folder inside the app: still no path is ever built from a request.
async function listFiles(kind: 'shell' | 'directions'): Promise<void> {
  const base = path.join(DIST, kind);
  for (const rel of await readdir(base, { recursive: true })) {
    const type = TYPES[path.extname(rel)];
    if (type) FILES[kind][`/${rel.split(path.sep).join('/')}`] = [path.join(kind, rel), type];
  }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

async function serve(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response(null, { status: 400 });
  }
  const kind = url.hostname === 'shell' ? 'shell' : /^tab-[0-9]{1,6}$/.test(url.hostname) ? 'tab' : url.hostname === 'easel' && SELFTEST ? 'easel' : url.hostname === 'directions' && SELFTEST === 'direction' ? 'directions' : null;
  const entry = kind && request.method === 'GET' ? FILES[kind][url.pathname] : undefined;
  if (!entry) return new Response(null, { status: 404 });
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
  origin: string;
}

const tabs = new Map<number, Tab>();
const tabByContents = new Map<number, Tab>();
let nextTabId = 1;
let active = 0;
let win: BaseWindow | null = null;
let shell: WebContentsView | null = null;
let droppedMessages = 0;
const meter = new Meter();
let keys: KeyProc | null = null;
let gate: Gate | null = null;

function tellGate(): void {
  if (gate) sendTo(shell, CH.gateState, gate.view());
}

function info(t: Tab): TabInfo {
  return { id: t.id, state: t.engine.state, cause: t.engine.cause };
}

function shellState(): ShellState {
  return { tabs: [...tabs.values()].map(info), active };
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

function layout(): void {
  if (!win || !shell) return;
  const { width, height } = win.getContentBounds();
  shell.setBounds({ x: 0, y: 0, width, height });
  for (const t of tabs.values()) {
    t.view.setBounds({ x: 0, y: BAR, width, height: Math.max(0, height - BAR) });
    t.view.setVisible(t.id === active);
  }
}

function openTab(): Tab | null {
  if (!win || tabs.size >= TABS_MAX) return null;
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
  });
  const tab: Tab = { id, view, engine, origin };
  tabs.set(id, tab);
  tabByContents.set(view.webContents.id, tab);
  win.contentView.addChildView(view);
  view.webContents.once('did-finish-load', () => sendTo(view, CH.tabState, info(tab)));
  void view.webContents.loadURL(`${origin}/index.html`);
  void engine.start();
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
  tab.view.webContents.close();
  meter.forget(id);
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
    droppedMessages++;
    return;
  }
  tab.engine.input(bytes);
});

ipcMain.on(CH.shellCmd, (e, cmd: unknown) => {
  if (!shell || e.sender.id !== shell.webContents.id || !fromMainFrameOf(e, 'app://shell')) {
    droppedMessages++;
    return;
  }
  const c = cmd as Partial<ShellCmd> | null;
  // Without the password nothing opens: before unlock the shell's only messages are the gate's.
  if (!gate?.unlocked) {
    droppedMessages++;
    return;
  }
  if (c?.op === 'new') openTab();
  else if (c?.op === 'select' && typeof c.id === 'number' && tabs.has(c.id)) {
    active = c.id;
    meter.tabSwitchBegins(c.id);
    layout();
    sendTo(tabs.get(c.id)!.view, CH.tabShown, null);
    tellShell();
  } else if (c?.op === 'close' && typeof c.id === 'number') closeTab(c.id);
  else droppedMessages++;
});

// The gate's three messages: from the shell view's own main frame only.
const fromShell = (e: IpcMainEvent): boolean => !!shell && e.sender.id === shell.webContents.id && fromMainFrameOf(e, 'app://shell');

ipcMain.on(CH.gateCreate, (e, password: unknown) => {
  if (!fromShell(e) || !gate || !(password instanceof Uint8Array)) return void droppedMessages++;
  void gate.create(password);
});

ipcMain.on(CH.gateUnlock, (e, password: unknown) => {
  if (!fromShell(e) || !gate || !(password instanceof Uint8Array)) return void droppedMessages++;
  void gate.unlock(password);
});

ipcMain.on(CH.gatePickBackup, (e) => {
  if (!fromShell(e) || !gate || !win || gate.state.phase !== 'create') return void droppedMessages++;
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
  if (!knownView(e) || !meter.fromView(numbers)) droppedMessages++;
});

ipcMain.on(CH.meterFrame, (e) => {
  const from = knownView(e);
  if (!from) {
    droppedMessages++;
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
    SELFTEST = kind !== 'release' && ['all', 'engine-must-be-refused', 'hold', 'seven', 'picture', 'direction', 'gate-unlock', 'gate-shot'].includes(asked) ? asked : '';
    if (SELFTEST === 'direction') await listFiles('directions');
    await listFiles('shell');
    // A lab or development run may ask for a window size (for pictures). A release build never reads this.
    const asksSize = kind !== 'release' ? /^(\d{3,4})x(\d{3,4})$/.exec(process.env['SSHAPP_WINDOW'] ?? '') : null;
    meter.start();
    harden(session.defaultSession);
    const shellSession = session.fromPartition('shell', { cache: false });
    harden(shellSession);

    win = new BaseWindow({ width: 1280, height: 800, minWidth: 800, minHeight: 500, backgroundColor: '#161e25', title: 'Berth', useContentSize: true });
    if (asksSize) win.setContentSize(Number(asksSize[1]), Number(asksSize[2]));
    win.setMenu(null);
    shell = new WebContentsView({ webPreferences: viewPrefs(shellSession, 'preload-shell.js', true) });
    win.contentView.addChildView(shell);
    shell.webContents.once('did-finish-load', () => {
      tellShell();
      tellGate();
    });
    // The key process, and the lock in front of everything else.
    const listFile = path.join(app.getPath('userData'), 'list.berth');
    const backups = LAB_PROFILE ? path.join(LAB_PROFILE, 'backups') : path.join(app.getPath('documents'), 'Berth backups');
    const k = new KeyProc(ENGINE_BIN, ENGINE_HASHES, listFile, () => void g.keysChanged());
    const g = new Gate(k, tellGate, backups);
    keys = k;
    gate = g;
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
      await runSelfTest({ gate: g, keys: k, listFile, backups, shell, shellLoaded, openTab, closeTab, tabs, shellState, dropped: () => droppedMessages, kind, mode: SELFTEST, meter, win, dist: DIST, harden, newView: (partition: string) => {
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
