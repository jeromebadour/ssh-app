// The Windows run: starts the Windows packages for real, on a Windows machine, and checks them.
// Needs: scripts/build.sh and "node scripts/package.mjs win32" first. Run by CI's `windows` job.
//
//   lab package      the self-test, packaged; seven tabs; children end with their parent; a swapped engine
//   release package  starts and stays up as a release build; exits on any argument; the lab marker changes
//                    nothing; and, what only Windows can show: a changed app archive is refused by Electron
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { changeArchive } from './lib/change-archive.mjs';

const root = path.resolve(import.meta.dirname, '..');
const LAB = path.join(root, 'out', 'ssh-app-win32-x64-lab');
const REL = path.join(root, 'out', 'ssh-app-win32-x64-release');
const EXE = 'ssh-app.exe';
const work = await mkdtemp(path.join(os.tmpdir(), 'ssh-app-win-'));
let failures = 0;
const say = (name) => console.log(`ok    ${name}`);
const fail = (name, detail = '') => {
  failures++;
  console.log(`FAIL  ${name}${detail ? `   -> ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const endByForce = (pid) => new Promise((resolve) => execFile('taskkill', ['/F', '/PID', String(pid)], () => resolve()));

// Starts a package. Resolves when it exits, when `until` matches its output, or after `ms` (then it is ended).
function run(dir, args, env, { ms, until }) {
  return new Promise((resolve) => {
    const child = spawn(path.join(dir, EXE), args, { env: { ...process.env, ...env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (how, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ how, code, out, pid: child.pid, end: () => endByForce(child.pid) });
    };
    const timer = setTimeout(() => finish('still up', null), ms);
    const feed = (chunk) => {
      out += chunk.toString('utf8');
      if (until && until.test(out)) finish('matched', null);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => finish(`could not start: ${err.message}`, null));
    child.on('exit', (code) => finish('exited', code));
  });
}

async function selftest(name, dir, mode) {
  const r = await run(dir, ['--lab'], { SSHAPP_SELFTEST: mode }, { ms: 150_000 });
  const line = r.out.split('\n').find((l) => l.startsWith('SELFTEST '));
  if (!line) {
    if (r.how === 'still up') await r.end();
    return fail(name, `no result (${r.how}, exit ${r.code}): ${r.out.slice(-600).trim()}`);
  }
  const result = JSON.parse(line.slice(9));
  for (const p of result.results) console.log(`  ${p.ok ? 'ok  ' : 'FAIL'}  ${p.name}${p.ok ? '' : `   -> ${p.detail}`}`);
  const bad = result.results.filter((p) => !p.ok).length;
  if (bad || r.code !== 0) fail(name, `${bad} of ${result.results.length} probes failed (exit ${r.code})`);
  else say(`${name}: all ${result.results.length} probes held (${result.kind})`);
}

async function copyOf(dir, name) {
  const dest = path.join(work, name);
  await cp(dir, dest, { recursive: true });
  return dest;
}

async function flipByte(file, position) {
  const size = (await stat(file)).size;
  const at = position < 0 ? size + position : position;
  const handle = await open(file, 'r+');
  const one = Buffer.alloc(1);
  await handle.read(one, 0, 1, at);
  one[0] ^= 0xff;
  await handle.write(one, 0, 1, at);
  await handle.close();
}

// ---- the lab package
await selftest('the lab package, self-test', LAB, 'all');
await selftest('the lab package, seven tabs', LAB, 'seven');

{
  const r = await run(LAB, ['--lab'], { SSHAPP_SELFTEST: 'hold' }, { ms: 60_000, until: /^HOLD .*$/m });
  const held = /^HOLD ok=(\w+) main=(\d+) engines=(\d+),(\d+)/m.exec(r.out);
  if (!held || held[1] !== 'true') {
    fail('children end with their parent', `the app did not come up with two engines (${r.how}): ${r.out.slice(-400).trim()}`);
    if (r.how !== 'exited') await r.end();
  } else {
    const main = Number(held[2]);
    const engines = [Number(held[3]), Number(held[4])];
    if (![main, ...engines].every(alive)) fail('children end with their parent', 'a process was not running before the test');
    else {
      await endByForce(main);
      let gone = false;
      for (let i = 0; i < 25 && !gone; i++) {
        gone = !engines.some(alive);
        if (!gone) await sleep(200);
      }
      if (gone) say('main ended by force: its engines ended with it');
      else {
        fail('children end with their parent', 'engines outlived main');
        for (const e of engines) await endByForce(e);
      }
    }
  }
}

{
  const swapped = await copyOf(LAB, 'swapped-engine');
  await flipByte(path.join(swapped, 'resources', 'engine', 'sshapp-engine.exe'), 4096);
  const r = await run(swapped, ['--lab'], { SSHAPP_SELFTEST: 'engine-must-be-refused' }, { ms: 60_000 });
  if (r.how === 'exited' && r.code === 0 && /^SELFTEST .*"ok":true/m.test(r.out)) say('a swapped engine is not started, and the tab says why');
  else {
    fail('a swapped engine is refused', `${r.how}, exit ${r.code}: ${r.out.slice(-400).trim()}`);
    if (r.how === 'still up') await r.end();
  }
}

// ---- the release package
{
  const r = await run(REL, [], { SSHAPP_SELFTEST: 'all' }, { ms: 12_000 });
  if (r.how !== 'still up') fail('the release package starts and stays up', `${r.how}, exit ${r.code}: ${r.out.slice(-400).trim()}`);
  else {
    const ready = /^READY kind=release ms=(\d+)/m.exec(r.out);
    if (ready) say(`the release package starts and stays up as a release build (up in ${ready[1]} ms)`);
    else fail('the release package says it is a release build', r.out.slice(-400).trim());
    if (/^SELFTEST /m.test(r.out)) fail('the self-test switch does nothing in a release build');
    else say('the self-test switch does nothing in it');
    if (/^MAINFAULT/m.test(r.out)) fail('no fault in main', r.out.slice(-400).trim());
    else say('no fault in main');
    await r.end();
  }
}

for (const args of [['--anything'], ['--inspect=0'], ['--remote-debugging-port=9333'], ['--lab'], ['--lab', '--remote-debugging-port=9333'], ['C:\\some-file']]) {
  const t0 = Date.now();
  const r = await run(REL, args, { SSHAPP_SELFTEST: 'all' }, { ms: 20_000 });
  const label = `exits on: ${args.join(' ')}`;
  if (r.how === 'exited' && r.code === 64 && !/^READY|^SELFTEST|Debugger listening|DevTools listening/m.test(r.out)) say(`${label} (${Date.now() - t0} ms, nothing listening)`);
  else {
    fail(label, `${r.how}, exit ${r.code}: ${r.out.slice(-300).trim()}`);
    if (r.how === 'still up') await r.end();
  }
}

{
  const marked = await copyOf(REL, 'marked');
  await cp(path.join(LAB, 'resources', 'lab'), path.join(marked, 'resources', 'lab'));
  const r = await run(marked, ['--lab'], { SSHAPP_SELFTEST: 'all' }, { ms: 20_000 });
  if (r.how === 'exited' && r.code === 64 && !/^READY|^SELFTEST/m.test(r.out)) say('the lab marker beside a release binary changes nothing');
  else {
    fail('the lab marker beside a release binary changes nothing', `${r.how}, exit ${r.code}`);
    if (r.how === 'still up') await r.end();
  }
}

// What only Windows can show: Electron itself refuses an app archive that is not the one the program was built
// with. One byte changed in the archive's index, and, separately, one byte changed in a file inside it.
// The change is harmless by itself (a hex digit of a recorded hash; a letter in a comment): on Linux, where
// Electron has no such check, the same changed archives start normally (scripts/smoke.sh release is the control).
for (const [what, label0] of [['index', 'its index'], ['file', 'a file inside it']]) {
  const changed = await copyOf(REL, `changed-${what}`);
  await changeArchive(path.join(changed, 'resources', 'app.asar'), what);
  const r = await run(changed, [], {}, { ms: 15_000 });
  const label = `a changed app archive is refused (${label0})`;
  if (r.how === 'exited' && r.code !== 0 && !/^READY/m.test(r.out)) say(`${label}: the program ended with code ${r.code}`);
  else {
    fail(label, `${r.how}, exit ${r.code}: ${r.out.slice(-300).trim()}`);
    if (r.how === 'still up') await r.end();
  }
}

await rm(work, { recursive: true, force: true }).catch(() => undefined);
console.log(failures ? `smoke-windows: ${failures} check(s) FAILED` : 'smoke-windows: every check held');
process.exit(failures ? 1 : 0);
