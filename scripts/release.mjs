// Makes the zip the app is installed from, out of what scripts/package.mjs already made.
//
//   node scripts/release.mjs <version>
//
// In the zip, one folder:
//
//   <folder>-<version>/app/            the release package, file for file
//   <folder>-<version>/app.manifest    a sha256 for every file in app/, as package.mjs wrote it
//   <folder>-<version>/install.json    what the install scripts read: name, program, folder, version
//   <folder>-<version>/install.ps1     installs it for the machine, checking every file first
//   <folder>-<version>/uninstall.ps1   removes it, and never the user's own files
//   <folder>-<version>/README.txt      the two commands, and what the version means
//
// Nothing here signs anything and nothing here publishes anything: it writes out/release/ and prints the
// zip's sha256. The release workflow is what attaches it to a draft release, and only a person starts that.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeZip } from './lib/zip.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const version = process.argv[2];
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error('release: needs a version like 0.1.0 or 0.1.0-rc.1');
  process.exit(2);
}

const NAME = 'Berth';
const FOLDER = 'Berth';
const PUBLISHER = 'Jerome Badour';
const PACKAGE = 'ssh-app-win32-x64-release';

const out = path.join(root, 'out');
const from = path.join(out, PACKAGE);
const manifestPath = path.join(out, `${PACKAGE}.manifest`);
const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
const p = report.packages[PACKAGE];
if (!p) throw new Error(`release: out/report.json has no ${PACKAGE}; run node scripts/package.mjs win32 first`);

const manifest = await readFile(manifestPath, 'utf8');
if (sha(Buffer.from(manifest)) !== p.manifestSha256) throw new Error('release: the manifest file is not the manifest the report names');

// The manifest and the folder must still agree, file for file. The installer checks this too, where it runs;
// a release that ships a manifest that is already wrong would fail there, so it fails here instead.
const want = new Map();
for (const line of manifest.split('\n')) {
  if (!line.trim()) continue;
  const cut = line.indexOf('  ');
  if (cut < 1) throw new Error(`release: a line of the manifest cannot be read: ${line}`);
  want.set(line.slice(cut + 2), line.slice(0, cut));
}
const have = new Map();
const walk = async (dir) => {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else if (e.isFile()) have.set(path.relative(from, full).split(path.sep).join('/'), sha(await readFile(full)));
  }
};
await walk(from);
const wrong = [];
for (const [rel, hash] of want) {
  if (!have.has(rel)) wrong.push(`missing: ${rel}`);
  else if (have.get(rel) !== hash) wrong.push(`changed: ${rel}`);
}
for (const rel of have.keys()) if (!want.has(rel)) wrong.push(`not in the manifest: ${rel}`);
if (wrong.length) {
  for (const line of wrong) console.error(`release: ${line}`);
  throw new Error(`release: ${wrong.length} files do not match the manifest`);
}

const stem = `${FOLDER}-${version}`;
const dest = path.join(out, 'release', stem);
await rm(path.join(out, 'release'), { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(from, path.join(dest, 'app'), { recursive: true });
await writeFile(path.join(dest, 'app.manifest'), manifest);

const plan = {
  name: NAME,
  folder: FOLDER,
  program: p.program,
  version,
  publisher: PUBLISHER,
  archiveSha256: p.archiveSha256,
  engineSha256: p.engineSha256,
  files: p.files,
};
await writeFile(path.join(dest, 'install.json'), JSON.stringify(plan, null, 2) + '\n');
for (const file of ['install.ps1', 'uninstall.ps1']) await cp(path.join(root, 'toolchain', file), path.join(dest, file));

const readme = [
  `${NAME} ${version}, for Windows on x64.`,
  '',
  'To install it, in a PowerShell started with "Run as administrator", from this folder:',
  '',
  '  powershell -ExecutionPolicy Bypass -File .\\install.ps1',
  '',
  'To see what it would do, and change nothing:',
  '',
  '  powershell -ExecutionPolicy Bypass -File .\\install.ps1 -Check',
  '',
  'It checks every file in app\\ against app.manifest before it writes anything, and again where the files',
  'landed. If one byte is wrong it stops and installs nothing.',
  '',
  'Nothing here is signed: no certificate was bought for it. Windows Smart App Control blocks programs that',
  'are not signed, so the install script reads that setting and says what it found. SmartScreen may also ask',
  'once, because this program is new to it.',
  '',
  'To remove it, from the installed folder:',
  '',
  `  powershell -ExecutionPolicy Bypass -File "C:\\Program Files\\${FOLDER}\\uninstall.ps1"`,
  '',
  'That removes the program, the Start menu entry and the entry in Apps and features. It never removes your',
  `own files: your boxes, your keys and your settings stay at %APPDATA%\\${FOLDER}.`,
  '',
  'What the numbers are:',
  '',
  `  version       ${version}, the tag this build was made from`,
  `  files         ${p.files} in app\\, each one named in app.manifest with its sha256`,
  `  app archive   ${p.archiveSha256}`,
  `  engine        ${p.engineSha256}`,
  '',
].join('\r\n');
await writeFile(path.join(dest, 'README.txt'), readme);

// The zip is written here, by us: a Windows machine has no `zip`, and every entry carries one fixed moment,
// so the same files always make the same zip (the two builders are compared byte for byte).
const zip = path.join(out, `${stem}-win32-x64.zip`);
await rm(zip, { force: true });
const made = await writeZip(zip, dest);
const zipSha = made.sha256;
if (made.files !== p.files + 5) throw new Error(`release: the zip holds ${made.files} files, wanted ${p.files + 5} (the package, and the five this script adds)`);
await writeFile(path.join(out, 'release.json'), JSON.stringify({ name: NAME, version, zip: path.basename(zip), sha256: zipSha, ...plan }, null, 2) + '\n');

console.log(`release: ${path.basename(zip)}`);
console.log(`release: sha256 ${zipSha}`);
console.log(`release: ${made.files} files in the zip, ${p.files} of them the package, each checked against the manifest`);
