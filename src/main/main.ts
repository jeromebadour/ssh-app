// The main process: the window, the views, the engines, and the few messages that cross between them.
// It holds no key, opens no network connection and parses nothing a box sent.
import { app, BaseWindow, ipcMain, protocol, session, WebContentsView, type IpcMainEvent, type Session } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CH, INPUT_MAX, TABS_MAX, type ShellCmd, type ShellState, type TabInfo } from '../common/ipc';
import { Engine } from './engine';

// A release build takes no arguments: none of its own, and none of Chromium's (a debugging port, for one).
if (app.isPackaged && process.argv.length > 1) app.exit(64);

const DIST = __dirname;
const BAR = 44;
const SELFTEST = !app.isPackaged && process.env['SSHAPP_SELFTEST'] === '1';
const ENGINE_BIN = path.join(DIST, 'engine', process.platform === 'win32' ? 'sshapp-engine.exe' : 'sshapp-engine');

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
const FILES: Record<'shell' | 'tab', Record<string, [file: string, type: string]>> = {
  shell: {
    '/index.html': ['shell/index.html', 'text/html; charset=utf-8'],
    '/shell.js': ['shell/shell.js', 'text/javascript; charset=utf-8'],
    '/shell.css': ['shell/shell.css', 'text/css; charset=utf-8'],
  },
  tab: {
    '/index.html': ['tab/index.html', 'text/html; charset=utf-8'],
    '/tab.js': ['tab/tab.js', 'text/javascript; charset=utf-8'],
    '/tab.css': ['tab/tab.css', 'text/css; charset=utf-8'],
  },
};

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

async function serve(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response(null, { status: 400 });
  }
  const kind = url.hostname === 'shell' ? 'shell' : /^tab-[0-9]{1,6}$/.test(url.hostname) ? 'tab' : null;
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
  ses.setSpellCheckerEnabled(false);
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
  const engine = new Engine(ENGINE_BIN, id, {
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
  engine.start();
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
  if (c?.op === 'new') openTab();
  else if (c?.op === 'select' && typeof c.id === 'number' && tabs.has(c.id)) {
    active = c.id;
    layout();
    tellShell();
  } else if (c?.op === 'close' && typeof c.id === 'number') closeTab(c.id);
  else droppedMessages++;
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
    harden(session.defaultSession);
    const shellSession = session.fromPartition('shell', { cache: false });
    harden(shellSession);

    win = new BaseWindow({ width: 1280, height: 800, minWidth: 800, minHeight: 500, backgroundColor: '#0c0e10', title: 'SSH App', show: !SELFTEST });
    win.setMenu(null);
    shell = new WebContentsView({ webPreferences: viewPrefs(shellSession, 'preload-shell.js', true) });
    win.contentView.addChildView(shell);
    shell.webContents.once('did-finish-load', tellShell);
    win.on('resize', layout);
    win.on('closed', () => {
      for (const t of tabs.values()) t.engine.close();
      win = null;
    });
    layout();
    const shellLoaded = shell.webContents.loadURL('app://shell/index.html');

    if (SELFTEST) {
      const { runSelfTest } = await import('./selftest');
      await runSelfTest({ shell, shellLoaded, openTab, closeTab, tabs, shellState, dropped: () => droppedMessages });
    } else {
      await shellLoaded;
    }
  });
}

export type { Tab };
