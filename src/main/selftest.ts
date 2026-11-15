// The skeleton's self-test. It runs inside the real main process, against the real views and engines,
// and only in an unpackaged build started with SSHAPP_SELFTEST=1. It prints one line, "SELFTEST <json>",
// and exits with 0 only if every probe held. The lab (Playwright, real SSH servers, the fault proxy)
// grows out of this; these probes stay as its first cases.
import { app, type WebContentsView } from 'electron';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ShellState } from '../common/ipc';
import type { Tab } from './main';
import { memory } from './memory';
import { BUDGET, type Meter } from './meter';

interface Ctx {
  shell: WebContentsView;
  shellLoaded: Promise<void>;
  kind: string;
  mode: string;
  meter: Meter;
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

    // The short mode, for a package whose engine file was changed on purpose: one tab, and its engine must be
    // refused with the reason. Nothing else is probed, because nothing else can work without an engine.
    if (ctx.mode === 'engine-must-be-refused') {
      const t = ctx.openTab()!;
      await until(() => t.engine.state === 'gone', 10_000);
      check('the engine was not started', t.engine.state === 'gone' && t.engine.pid === 0, [t.engine.state, t.engine.pid]);
      check('and the tab says why', t.engine.cause === 'the engine file is not the one this app was built with', t.engine.cause);
      canary.close();
      clearTimeout(guard);
      return finish(results.every((r) => r.ok) ? 0 : 1);
    }

    // "hold": two tabs, then nothing. Prints who is who and stays up, so the script outside can end main by
    // force and see that the engines end with it (children never outlive their parent).
    if (ctx.mode === 'hold') {
      const one = ctx.openTab()!;
      const two = ctx.openTab()!;
      const up = await until(() => one.engine.state === 'ready' && two.engine.state === 'ready', 15_000);
      process.stdout.write(`HOLD ok=${up} main=${process.pid} engines=${one.engine.pid},${two.engine.pid}\n`);
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
      check(`${name}: only its own port`, port === (name === 'shell' ? 'cmd,frame,meter,onState,sandboxed' : 'frame,meter,onOutput,onShown,onState,sandboxed,send'), port);
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
    check('no message was dropped as forged', ctx.dropped() === 0, ctx.dropped());
  } catch (err) {
    check('no probe threw', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }

  canary.close();
  clearTimeout(guard);
  finish(results.every((r) => r.ok) ? 0 : 1);
}
