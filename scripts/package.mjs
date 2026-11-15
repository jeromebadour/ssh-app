// Makes the packages from what scripts/build.sh built: for Linux and for Windows, a lab one and a release one.
//
// All four hold the same app archive, byte for byte. A lab package differs from a release package in exactly two
// things, both outside the archive: its binary keeps the inspect fuse on (so the test driver can attach), and a
// marker file sits beside the archive. The lab proves the code; the release package gets its own run with no
// debugger (scripts/smoke.sh).
//
// No packaging tool is used: Electron's own files come from its release (checked against the checksums inside
// the electron package), the archive is written by scripts/lib/asar.mjs, fuses by Electron's own fuse tool, and
// on Windows the archive's hash is written into the program file as the resource Electron's integrity check reads.
import { downloadArtifact } from '@electron/get';
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as ResEdit from 'resedit';
import { readAsar, writeAsar } from './lib/asar.mjs';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'out');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const pkg = require(path.join(root, 'package.json'));
const electronVersion = require(path.join(root, 'node_modules/electron/package.json')).version;
const NAME = 'ssh-app';

// What every package's binary must say, read back after writing. Only the inspect fuse differs.
const fusesFor = (kind) => ({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: kind === 'lab',
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});
if (FuseV1Options.EnableNodeCliInspectArguments !== 3) throw new Error('package: the inspect fuse moved; src/main/fuse.ts must follow');

async function manifest(dir) {
  const lines = [];
  const walk = async (d) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) lines.push(`${sha(await readFile(full))}  ${path.relative(dir, full).split(path.sep).join('/')}`);
    }
  };
  await walk(dir);
  return lines.join('\n') + '\n';
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The app archive: a small package.json and dist/ without the engines (a program cannot run from inside it).
const stage = await mkdtemp(path.join(os.tmpdir(), 'ssh-app-stage-'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main }) + '\n');
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true, filter: (src) => path.relative(path.join(root, 'dist'), src).split(path.sep)[0] !== 'engine' });
const archive = await writeAsar(stage, path.join(out, 'app.asar'));
await rm(stage, { recursive: true });
const hashes = JSON.parse(readAsar(await readFile(path.join(out, 'app.asar'))).files.get('dist/engine-hashes.json').toString());

const report = { electron: electronVersion, archive: { sha256: archive.sha256, headerHash: archive.headerHash, files: archive.files }, packages: {} };

// "node scripts/package.mjs win32" makes the Windows packages only (the Windows job needs no Linux ones).
const platforms = process.argv.length > 2 ? process.argv.slice(2) : ['linux', 'win32'];
for (const platform of platforms) {
  if (platform !== 'linux' && platform !== 'win32') throw new Error(`package: unknown platform ${platform}`);
  const zip = await downloadArtifact({ version: electronVersion, platform, arch: 'x64', artifactName: 'electron', checksums: require(path.join(root, 'node_modules/electron/checksums.json')) });
  const engineName = platform === 'win32' ? 'sshapp-engine.exe' : 'sshapp-engine';
  const engine = await readFile(path.join(root, 'dist/engine', engineName));
  if (sha(engine) !== hashes[`${platform}-x64`]) throw new Error(`package: the ${platform} engine is not the one recorded in the archive`);

  for (const kind of ['lab', 'release']) {
    const id = `${NAME}-${platform}-x64-${kind}`;
    const dir = path.join(out, id);
    await mkdir(dir);
    await run('unzip', ['-q', zip, '-d', dir]);
    const res = path.join(dir, 'resources');
    await rm(path.join(res, 'default_app.asar'));
    await cp(path.join(out, 'app.asar'), path.join(res, 'app.asar'));
    await mkdir(path.join(res, 'engine'));
    await writeFile(path.join(res, 'engine', engineName), engine);
    if (platform !== 'win32') await chmod(path.join(res, 'engine', engineName), 0o755);
    if (kind === 'lab') await writeFile(path.join(res, 'lab'), 'A lab package: for the test lab only, never for use.\n');

    const exe = path.join(dir, platform === 'win32' ? `${NAME}.exe` : NAME);
    await rename(path.join(dir, platform === 'win32' ? 'electron.exe' : 'electron'), exe);

    if (platform === 'win32') {
      // The resource Electron's integrity check reads: type INTEGRITY, name ELECTRONASAR, a JSON list.
      const wanted = JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: archive.headerHash }]);
      const pe = ResEdit.NtExecutable.from(await readFile(exe), { ignoreCert: true });
      const resources = ResEdit.NtExecutableResource.from(pe);
      const lang = resources.entries.find((e) => e.type === 16)?.lang ?? 1033;
      const bin = Buffer.from(wanted, 'utf8');
      resources.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', lang, codepage: 1200, bin: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length) });
      resources.outputResource(pe);
      await writeFile(exe, Buffer.from(pe.generate()));
      // Read it back from the file as written.
      const back = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(await readFile(exe), { ignoreCert: true })).entries.find((e) => e.type === 'INTEGRITY' && e.id === 'ELECTRONASAR');
      if (!back || Buffer.from(back.bin).toString('utf8') !== wanted) throw new Error(`package: ${id}: the integrity resource did not read back`);
    }

    const fuses = fusesFor(kind);
    await flipFuses(exe, { version: FuseVersion.V1, resetAdHocDarwinSignature: false, strictlyRequireAllFuses: false, ...fuses });
    const wire = await getCurrentFuseWire(exe);
    for (const [index, want] of Object.entries(fuses)) {
      if (String.fromCharCode(wire[index]) !== (want ? '1' : '0')) throw new Error(`package: ${id}: fuse ${FuseV1Options[index]} did not read back as ${want}`);
    }

    const list = await manifest(dir);
    await writeFile(path.join(out, `${id}.manifest`), list);
    report.packages[id] = {
      program: path.basename(exe),
      fuses: Object.fromEntries(Object.entries(fuses).map(([i, v]) => [FuseV1Options[i], v])),
      archiveSha256: sha(await readFile(path.join(res, 'app.asar'))),
      engineSha256: sha(engine),
      files: list.trim().split('\n').length,
      manifestSha256: sha(list),
    };
    if (report.packages[id].archiveSha256 !== archive.sha256) throw new Error(`package: ${id}: the archive changed on the way in`);
  }
}

await rm(path.join(out, 'app.asar'));
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
for (const [id, p] of Object.entries(report.packages)) console.log(`package: ${id}  ${p.files} files  manifest ${p.manifestSha256.slice(0, 16)}`);
console.log(`package: one archive in all ${Object.keys(report.packages).length}: ${archive.sha256.slice(0, 16)} (${archive.files} files, header ${archive.headerHash.slice(0, 16)})`);
