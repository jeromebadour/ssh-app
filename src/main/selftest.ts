// The skeleton's self-test. It runs inside the real main process, against the real views and engines,
// and only in an unpackaged build started with SSHAPP_SELFTEST=1. It prints one line, "SELFTEST <json>",
// and exits with 0 only if every probe held. The lab (Playwright, real SSH servers, the fault proxy)
// grows out of this; these probes stay as its first cases.
import { app, type BaseWindow, type Session, type WebContentsView } from 'electron';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ShellState } from '../common/ipc';
import type { Gate } from './gate';
import type { KeyProc } from './keyproc';
import type { Tab } from './main';
import { memory } from './memory';
import { BUDGET, type Meter } from './meter';
import { takePicture } from './picture';

interface Ctx {
  gate: Gate;
  keys: KeyProc;
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
  openTab(): Tab | null;
  closeTab(id: number): void;
  tabs: Map<number, Tab>;
  shellState(): ShellState;
  dropped(): number;
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      const scene = /^(dialog|paths|boxes|logs|plain|create|unlock|wrong|addbox|trust|changed|connecting|fresh|noanswer|dropped)$/.test(process.env['SSHAPP_SCENE'] ?? '') ? process.env['SSHAPP_SCENE'] : 'plain';
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
      let switches = 0;
      while (Date.now() < until4) {
        const t = all[turn++ % all.length]!;
        const at = await js<{ x: number; y: number } | null>(ctx.shell, `(() => { const b = document.querySelector('[data-tab="${t.id}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (at) {
          ctx.shell.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          ctx.shell.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          switches++;
        }
        t.view.webContents.focus();
        for (const type of ['keyDown', 'char', 'keyUp'] as const) t.view.webContents.sendInputEvent({ type, keyCode: 'k' });
        await sleep(200);
      }
      await sleep(1500); // the views report twice a second
      let sent = 0;
      for (const t of all) sent += await js<number>(t.view, `window.__sent || 0`);
      const w = { ...ctx.meter.worst };
      const mbps = (sent / 1048576 / (FLOOD_MS / 1000)).toFixed(1);
      check(`under load: ${switches} tab switches, ${mbps} MB/s through seven engines`, switches >= 7 && sent > 0, { switches, sent });
      const within = (key: keyof typeof BUDGET, what: string, mustMeasure: boolean) => {
        const limit = BUDGET[key] * factor;
        check(`${what}: ${w[key]} ms (budget ${BUDGET[key]} ms${factor > 1 ? `, times ${factor} on this machine` : ''})`, w[key] <= limit && (!mustMeasure || w[key] > 0), w);
      };
      within('mainDelayMs', 'main was never later than', true);
      within('viewTaskMs', 'no view was busy in one stretch longer than', false);
      within('reactionMs', 'a real click or key was painted within', false);
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
      check(`${name}: only its own port`, port === (name === 'shell' ? 'cmd,frame,gateCreate,gatePickBackup,gateUnlock,meter,onGate,onState,sandboxed' : 'frame,meter,onOutput,onShown,onState,sandboxed,send'), port);
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

    check('no view ever reached the canary web server', canaryHits === 0, canaryHits);
    check('no message was dropped, but the ones the lock refused on purpose', ctx.dropped() === refusedByTheLock, [ctx.dropped(), refusedByTheLock]);
  } catch (err) {
    check('no probe threw', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  canary.close();
  clearTimeout(guard);
  finish(results.every((r) => r.ok) ? 0 : 1);
}
