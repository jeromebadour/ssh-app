// The dependency gate (plan B7). Fails if:
//   - a package is in package-lock.json that is not on the reviewed list, or a reviewed name is no longer used;
//   - a package does not come from the npm registry with an integrity hash;
//   - a version is younger than 14 days (unless it is a written exception);
//   - a compiler or runtime is past its maker's support date;
//   - the pinned versions disagree with each other (Go in toolchain/go.env and engine/go.mod; Node in .node-version).
// Registry signatures and advisories are checked by npm itself, in scripts/check.sh.
//
// GATE_NOW=YYYY-MM-DD sets "today"; GATE_TIMES=<file> gives publish dates as {"name@version": "ISO date"} instead
// of asking the registry. Both exist for the gate's own tests.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = process.env.GATE_DIR ? path.resolve(process.env.GATE_DIR) : root;
const read = async (rel) => JSON.parse(await readFile(path.join(dir, rel), 'utf8'));
const text = async (rel) => (await readFile(path.join(dir, rel), 'utf8')).trim();
const now = process.env.GATE_NOW ? new Date(`${process.env.GATE_NOW}T00:00:00Z`) : new Date();
const MIN_AGE_DAYS = 14;
const problems = [];
const bad = (msg) => problems.push(msg);

const lock = await read('package-lock.json');
const reviewed = (await read('toolchain/reviewed.json')).packages;
const exceptions = await read('toolchain/exceptions.json');
const support = (await read('toolchain/support.json')).items;

// 1. Every package is reviewed, comes from the registry, and carries its hash.
const rule = (name) => Object.keys(reviewed).find((r) => (r.endsWith('*') ? name.startsWith(r.slice(0, -1)) : r === name));
const used = new Set();
const pairs = new Map();
for (const [key, entry] of Object.entries(lock.packages)) {
  if (key === '') continue;
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const r = rule(name);
  if (!r) bad(`not on the reviewed list: ${name}@${entry.version}`);
  else used.add(r);
  if (!String(entry.resolved ?? '').startsWith('https://registry.npmjs.org/')) bad(`not from the npm registry: ${name}@${entry.version}`);
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(String(entry.integrity ?? ''))) bad(`no integrity hash: ${name}@${entry.version}`);
  pairs.set(`${name}@${entry.version}`, name);
}
for (const r of Object.keys(reviewed)) if (!used.has(r)) bad(`on the reviewed list but no longer used: ${r}`);
if (lock.lockfileVersion !== 3) bad(`package-lock.json has lockfileVersion ${lock.lockfileVersion}, expected 3`);

// 2. Nothing is younger than 14 days.
let times;
if (process.env.GATE_TIMES) {
  times = JSON.parse(await readFile(process.env.GATE_TIMES, 'utf8'));
} else {
  times = {};
  const names = [...new Set(pairs.values())];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`the registry answered ${res.status} for ${name}`);
      const doc = await res.json();
      for (const [version, when] of Object.entries(doc.time ?? {})) times[`${name}@${version}`] = when;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}
const young = new Set((exceptions.young ?? []).map((e) => `${e.name}@${e.version}`));
for (const e of [...(exceptions.young ?? []), ...(exceptions.advisories ?? [])]) {
  if (!e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date ?? ''))) bad(`an exception without a reason and a full date: ${JSON.stringify(e)}`);
}
for (const pair of pairs.keys()) {
  const when = times[pair];
  if (!when) {
    bad(`no publish date found for ${pair}`);
    continue;
  }
  const age = (now - new Date(when)) / 86_400_000;
  if (age < MIN_AGE_DAYS && !young.has(pair)) bad(`younger than ${MIN_AGE_DAYS} days: ${pair} (published ${String(when).slice(0, 10)})`);
}
for (const pair of young) if (!pairs.has(pair)) bad(`an exception for a version that is not installed: ${pair}`);

// 3. Compilers and runtimes are still supported by their makers.
for (const item of support) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.until) || !item.source) bad(`support entry without a full date and a source: ${item.name}`);
  else if (now > new Date(`${item.until}T23:59:59Z`)) bad(`out of support since ${item.until}: ${item.name}`);
}

// 4. The pins agree with each other and with the support list.
const goEnv = Object.fromEntries((await text('toolchain/go.env')).split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const goMod = /^go (\d+\.\d+)(?:\.\d+)?$/m.exec(await text('engine/go.mod'))?.[1];
const goMinor = /^(\d+\.\d+)\.\d+$/.exec(goEnv.GO_VERSION ?? '')?.[1];
if (!goMinor) bad(`toolchain/go.env has no full Go version: ${goEnv.GO_VERSION}`);
if (goMinor !== goMod) bad(`engine/go.mod says go ${goMod}, toolchain/go.env pins ${goEnv.GO_VERSION}`);
for (const os of ['LINUX', 'WIN32']) {
  if (!/^[0-9a-f]{64}$/.test(goEnv[`GO_${os}_X64_SHA256`] ?? '')) bad(`toolchain/go.env has no SHA-256 for the Go download (${os.toLowerCase()})`);
  const url = String(goEnv[`GO_${os}_X64_URL`] ?? '');
  if (!url.startsWith('https://github.com/actions/go-versions/releases/download/') || !url.includes(`/go-${goEnv.GO_VERSION}-`)) bad(`the Go download (${os.toLowerCase()}) is not the pinned version from actions/go-versions`);
}
const node = await text('.node-version');
const nodeMajor = /^(\d+)\.\d+\.\d+$/.exec(node)?.[1];
if (!nodeMajor) bad(`.node-version is not a full version: ${node}`);
const electron = lock.packages['node_modules/electron']?.version ?? '';
const want = [`Node ${nodeMajor}`, `Go ${goMinor}`, `Electron ${electron.split('.')[0]}`];
for (const w of want) if (!support.some((i) => i.name === w)) bad(`no support date written for ${w}`);
for (const i of support) if (!want.includes(i.name)) bad(`a support date for something we do not use: ${i.name}`);

if (problems.length) {
  for (const p of problems) console.log(`gate: ${p}`);
  console.log(`gate: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`gate: ${pairs.size} packages reviewed, pinned and at least ${MIN_AGE_DAYS} days old; ${support.length} toolchains in support`);
