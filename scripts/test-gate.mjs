// Tests scripts/gate.mjs: a copy of the real pins must pass, and each way of breaking them must fail with its
// own message. No network: publish dates come from a file.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const gate = path.join(root, 'scripts', 'gate.mjs');
const base = await mkdtemp(path.join(os.tmpdir(), 'gate-test-'));
let failures = 0;
let count = 0;

async function fixture() {
  const dir = await mkdtemp(path.join(base, 'case-'));
  await mkdir(path.join(dir, 'engine'));
  await cp(path.join(root, 'toolchain'), path.join(dir, 'toolchain'), { recursive: true });
  await mkdir(path.join(dir, 'engine', 'vendor'));
  for (const f of ['package-lock.json', '.node-version', 'engine/go.mod', 'engine/vendor/modules.txt']) await cp(path.join(root, f), path.join(dir, f));
  const lock = JSON.parse(await readFile(path.join(dir, 'package-lock.json'), 'utf8'));
  const times = {};
  for (const [key, e] of Object.entries(lock.packages)) {
    if (key) times[`${key.slice(key.lastIndexOf('node_modules/') + 13)}@${e.version}`] = '2026-01-01T00:00:00.000Z';
  }
  const goMod = await readFile(path.join(dir, 'engine/go.mod'), 'utf8');
  for (const m of goMod.matchAll(/^(?:require\s+|\t)([^\s()]+)\s+(v[^\s]+)/gm)) times[`go:${m[1]}@${m[2]}`] = '2026-01-01T00:00:00Z';
  times[`go:golang.org/x/vuln@${(await readFile(path.join(dir, 'toolchain/govulncheck-version'), 'utf8')).trim()}`] = '2026-01-01T00:00:00Z';
  await writeFile(path.join(dir, 'times.json'), JSON.stringify(times));
  return dir;
}

const edit = async (dir, rel, change) => {
  const file = path.join(dir, rel);
  const isJson = rel.endsWith('.json');
  const before = await readFile(file, 'utf8');
  const after = isJson ? JSON.stringify(change(JSON.parse(before)) ?? null) : change(before);
  await writeFile(file, after);
};

const run = (dir, now) =>
  new Promise((resolve) => {
    execFile(process.execPath, [gate], { env: { ...process.env, GATE_DIR: dir, GATE_TIMES: path.join(dir, 'times.json'), GATE_NOW: now } }, (err, stdout) =>
      resolve({ code: err ? (err.code ?? 1) : 0, out: stdout }),
    );
  });

async function expect(name, wantMessage, prepare, now = '2026-11-15') {
  count++;
  const dir = await fixture();
  await prepare(dir);
  const { code, out } = await run(dir, now);
  const ok = wantMessage === null ? code === 0 : code === 1 && out.includes(wantMessage);
  if (!ok) {
    failures++;
    console.log(`test-gate: FAIL: ${name}\n  exit ${code}, wanted ${wantMessage === null ? 'a pass' : `"${wantMessage}"`}\n  ${out.trim().split('\n').join('\n  ')}`);
  }
}

const semverKey = (l) => Object.keys(l.packages).find((k) => k.endsWith('node_modules/semver'));
const pin = { name: 'semver', version: null };

await expect('the real pins pass', null, async () => {});
await expect('a package nobody reviewed', 'not on the reviewed list: left-pad@1.3.0', (d) =>
  edit(d, 'package-lock.json', (l) => {
    l.packages['node_modules/left-pad'] = { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-abc=' };
    return l;
  }).then(() => edit(d, 'times.json', (t) => ({ ...t, 'left-pad@1.3.0': '2018-01-01T00:00:00Z' }))),
);
await expect('a reviewed name that is no longer used', 'on the reviewed list but no longer used: left-pad', (d) =>
  edit(d, 'toolchain/reviewed.json', (r) => {
    r.packages['left-pad'] = 'not used';
    return r;
  }),
);
await expect('a package without its hash', 'no integrity hash: semver@', (d) =>
  edit(d, 'package-lock.json', (l) => {
    delete l.packages[semverKey(l)].integrity;
    return l;
  }),
);
await expect('a package from somewhere else', 'not from the npm registry: semver@', (d) =>
  edit(d, 'package-lock.json', (l) => {
    l.packages[semverKey(l)].resolved = 'https://example.org/semver.tgz';
    return l;
  }),
);
const young = (d) =>
  edit(d, 'times.json', (t) => {
    const key = Object.keys(t).find((k) => k.startsWith('semver@'));
    pin.version = key.slice('semver@'.length);
    t[key] = '2026-11-10T00:00:00Z';
    return t;
  });
await expect('a version five days old', 'younger than 14 days: semver@', young);
await expect('the same, 14 days later', null, young, '2026-11-25');
await expect('the same, with a written exception', null, async (d) => {
  await young(d);
  await edit(d, 'toolchain/exceptions.json', (e) => {
    e.young.push({ name: 'semver', version: pin.version, reason: 'security release, diff read', date: '2026-11-15' });
    return e;
  });
});
await expect('an exception with no reason', 'an exception without a reason and a full date', async (d) => {
  await young(d);
  await edit(d, 'toolchain/exceptions.json', (e) => {
    e.young.push({ name: 'semver', version: pin.version });
    return e;
  });
});
await expect('an exception for something not installed', 'an exception for a version that is not installed: semver@0.0.1', (d) =>
  edit(d, 'toolchain/exceptions.json', (e) => {
    e.young.push({ name: 'semver', version: '0.0.1', reason: 'left over', date: '2026-11-15' });
    return e;
  }),
);
await expect('a version with no publish date', 'no publish date found for semver@', (d) =>
  edit(d, 'times.json', (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('semver@')))),
);
await expect('a runtime past its support date', 'out of support since 2027-04-30: Node 22', async () => {}, '2027-05-01');
await expect('go.mod and the pinned Go disagree', 'engine/go.mod says go 1.26', (d) => edit(d, 'engine/go.mod', (s) => s.replace(/^go .*$/m, 'go 1.26')));
await expect('a toolchain with no support date', 'no support date written for Electron', (d) =>
  edit(d, 'toolchain/support.json', (s) => {
    s.items = s.items.filter((i) => !i.name.startsWith('Electron'));
    return s;
  }),
);
await expect('a Go download without its hash', 'no SHA-256 for the Go download (win32)', (d) => edit(d, 'toolchain/go.env', (s) => s.replace(/^GO_WIN32_X64_SHA256=.*$/m, 'GO_WIN32_X64_SHA256=')));
await expect('a Go download of another version', 'is not the pinned version from actions/go-versions', (d) => edit(d, 'toolchain/go.env', (s) => s.replace(/^GO_VERSION=.*$/m, 'GO_VERSION=1.27.9')));

// Go modules.
const goKey = (t, name) => Object.keys(t).find((k) => k.startsWith(`go:${name}@`));
await expect('a Go module nobody reviewed', 'Go module not on the reviewed list: example.org/evil@v1.0.0', async (d) => {
  await edit(d, 'engine/go.mod', (s) => `${s}\nrequire example.org/evil v1.0.0\n`);
  await edit(d, 'engine/vendor/modules.txt', (s) => `${s}\n# example.org/evil v1.0.0\n## explicit\n`);
  await edit(d, 'times.json', (t) => ({ ...t, 'go:example.org/evil@v1.0.0': '2020-01-01T00:00:00Z' }));
});
await expect('a reviewed Go module that is no longer required', 'Go module on the reviewed list but no longer required: example.org/gone', (d) =>
  edit(d, 'toolchain/reviewed.json', (r) => {
    r.goModules['example.org/gone'] = 'not used';
    return r;
  }),
);
await expect('modules required but not vendored', 'engine/vendor/modules.txt is missing', (d) => rm(path.join(d, 'engine/vendor/modules.txt')));
await expect('the vendored version is not the required one', 'engine/vendor holds golang.org/x/crypto@v0.1.0, engine/go.mod requires', (d) =>
  edit(d, 'engine/vendor/modules.txt', (s) => s.replace(/^# golang\.org\/x\/crypto .*$/m, '# golang.org/x/crypto v0.1.0')),
);
await expect('a vendored module that go.mod does not require', 'engine/vendor holds a module engine/go.mod does not require: example.org/extra@v1.0.0', (d) =>
  edit(d, 'engine/vendor/modules.txt', (s) => `${s}\n# example.org/extra v1.0.0\n`),
);
await expect('a replaced module', 'engine/go.mod replaces or excludes a module', (d) => edit(d, 'engine/go.mod', (s) => `${s}\nreplace golang.org/x/crypto => ../my-crypto\n`));
await expect('a module replaced inside the vendor folder', 'engine/vendor holds a replaced module', (d) =>
  edit(d, 'engine/vendor/modules.txt', (s) => s.replace(/^(# golang\.org\/x\/crypto \S+)$/m, '$1 => ../my-crypto')),
);
await expect('a Go module five days old', 'younger than 14 days: Go module golang.org/x/crypto@', (d) =>
  edit(d, 'times.json', (t) => ({ ...t, [goKey(t, 'golang.org/x/crypto')]: '2026-11-10T00:00:00Z' })),
);
await expect('a Go module with no publish date', 'no publish date found for Go module golang.org/x/sys@', (d) =>
  edit(d, 'times.json', (t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== goKey(t, 'golang.org/x/sys')))),
);
await expect('the vulnerability checker five days old', 'younger than 14 days: Go module golang.org/x/vuln@', (d) =>
  edit(d, 'times.json', (t) => ({ ...t, [goKey(t, 'golang.org/x/vuln')]: '2026-11-10T00:00:00Z' })),
);
await expect('the vulnerability checker without a full version', 'toolchain/govulncheck-version is not a full version', (d) => edit(d, 'toolchain/govulncheck-version', () => 'latest'));

await rm(base, { recursive: true, force: true });
console.log(failures ? `test-gate: ${failures} of ${count} cases FAILED` : `test-gate: ${count} cases held`);
process.exit(failures ? 1 : 0);
