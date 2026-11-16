// The install proof, on Windows: unpacks the release zip and drives install.ps1 and uninstall.ps1 for real.
// Needs: node scripts/release.mjs <version> first. Run by CI's `windows` job.
//
//   -Check             says what it would do and writes nothing
//   a changed byte     stops the install and names the file
//   install            the program, the Start menu entry, the entry in Apps and features, all three there
//   the program runs   the installed copy starts and exits on an argument, as a release package does
//   a second install   refused, and the install that is there is left alone
//   -Replace           allowed
//   uninstall          all three gone, and the user's own files never touched
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const work = await mkdtemp(path.join(os.tmpdir(), 'ssh-app-install-'));
let failures = 0;
const say = (name) => console.log(`ok    ${name}`);
const fail = (name, detail = '') => {
  failures++;
  console.log(`FAIL  ${name}${detail ? `   -> ${detail}` : ''}`);
};

function shell(file, args, { ms = 180000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: ms, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, out: `${stdout}${stderr}` });
    });
  });
}
const ps = (args) => shell('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args]);
const script = (file, args) => ps(['-File', file, ...args]);
const there = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const release = JSON.parse(await readFile(path.join(root, 'out', 'release.json'), 'utf8'));
const zip = path.join(root, 'out', release.zip);
const unpacked = path.join(work, 'unpacked');
await ps(['-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpacked}' -Force`]);
const stem = (await readdir(unpacked))[0];
const from = path.join(unpacked, stem);
const installer = path.join(from, 'install.ps1');
if (!(await there(installer))) {
  console.log(`FAIL  the zip unpacked   -> no install.ps1 under ${from}`);
  process.exit(1);
}
say(`the zip unpacked: ${stem}`);

const to = path.join(work, 'Installed');
const program = release.program;
const shortcut = path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${release.name}.lnk`);
const regKey = `HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${release.folder}`;
const regThere = async () => (await ps(['-Command', `if (Test-Path -LiteralPath '${regKey}') { 'yes' } else { 'no' }`])).out.trim();
const regValue = async (name) => (await ps(['-Command', `(Get-ItemProperty -LiteralPath '${regKey}' -Name ${name} -ErrorAction SilentlyContinue).${name}`])).out.trim();

// 1. -Check writes nothing.
{
  const r = await script(installer, ['-Check', '-To', to]);
  if (r.code !== 0) fail('-Check ends well', `exit ${r.code}: ${r.out.trim().split('\n').pop()}`);
  else if (!/all of them match/.test(r.out)) fail('-Check checks every file', r.out.trim().split('\n').pop());
  else if (!/Nothing was written/.test(r.out)) fail('-Check says it wrote nothing');
  else if (await there(to)) fail('-Check really wrote nothing', `${to} is there`);
  else say('-Check: files checked, nothing written');
  const sac = r.out.split('\n').find((l) => /Smart App Control/.test(l));
  if (!sac) fail('-Check says what Smart App Control is');
  else say(`it read Smart App Control: ${sac.trim()}`);
}

// 2. One changed byte stops it.
{
  const victim = path.join(from, 'app', 'resources', 'app.asar');
  const was = await readFile(victim);
  const changed = Buffer.from(was);
  changed[changed.length - 1] = changed[changed.length - 1] ^ 0xff;
  await writeFile(victim, changed);
  const r = await script(installer, ['-Check', '-To', to]);
  await writeFile(victim, was);
  if (r.code === 0) fail('a changed byte stops it', 'it ended well');
  else if (!/changed: resources\/app\.asar/.test(r.out)) fail('a changed byte is named', r.out.trim().split('\n').slice(-2).join(' | '));
  else say('a changed byte stops it, and it names the file');
  const back = await script(installer, ['-Check', '-To', to]);
  if (back.code !== 0) fail('the file was put back', back.out.trim().split('\n').pop());
}

// 3. The install itself.
{
  const r = await script(installer, ['-To', to]);
  if (r.code !== 0) fail('installs', `exit ${r.code}: ${r.out.trim()}`);
  else say('installs');
  const exe = path.join(to, program);
  if (!(await there(exe))) fail('the program is there', exe);
  else say(`the program is there: ${program}`);
  for (const file of ['install.json', 'uninstall.ps1', 'app.manifest']) {
    if (!(await there(path.join(to, file)))) fail(`${file} is there`);
  }
  say('install.json, uninstall.ps1 and app.manifest came with it');
  if (!(await there(shortcut))) fail('the Start menu entry is there', shortcut);
  else say('the Start menu entry is there');
  if ((await regThere()) !== 'yes') fail('the entry in Apps and features is there', regKey);
  else {
    const name = await regValue('DisplayName');
    const un = await regValue('UninstallString');
    if (name !== release.name) fail('the entry says the name', name);
    else if (!un.includes('uninstall.ps1')) fail('the entry says how to remove it', un);
    else say(`the entry in Apps and features is there: ${name} ${await regValue('DisplayVersion')}`);
  }
  // Every file where it landed, against the manifest that came with it.
  const check = await ps(['-Command', `$bad=0; foreach ($line in Get-Content -LiteralPath '${path.join(to, 'app.manifest')}') { if (-not $line.Trim()) { continue }; $cut=$line.IndexOf('  '); $rel=$line.Substring($cut+2).Replace('/','\\'); $want=$line.Substring(0,$cut); $p=Join-Path '${to}' $rel; if (-not (Test-Path -LiteralPath $p)) { $bad++; continue }; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() -ne $want) { $bad++ } }; $bad`]);
  if (check.out.trim() !== '0') fail('every installed file matches the manifest', `${check.out.trim()} do not`);
  else say(`every installed file matches the manifest (${release.files} files)`);
}

// 4. The installed copy is a working release program: it exits on any argument.
{
  const r = await shell(path.join(to, program), ['--anything'], { ms: 60000 });
  if (r.code === 0) fail('the installed program refuses an argument', 'it ended well');
  else say('the installed program starts and refuses an argument, as a release build does');
}

// 5. A second install is refused, and leaves the one that is there alone.
{
  const before = (await ps(['-Command', `(Get-FileHash -Algorithm SHA256 -LiteralPath '${path.join(to, program)}').Hash`])).out.trim();
  const r = await script(installer, ['-To', to]);
  if (r.code === 0) fail('a second install is refused', 'it ended well');
  else if (!/already installed/.test(r.out)) fail('it says why', r.out.trim().split('\n').pop());
  else say('a second install is refused by name and version');
  const after = (await ps(['-Command', `(Get-FileHash -Algorithm SHA256 -LiteralPath '${path.join(to, program)}').Hash`])).out.trim();
  if (before !== after || !before) fail('the install that is there was left alone');
  else say('the install that is there was left alone');
}

// 6. -Replace is allowed.
{
  const r = await script(installer, ['-To', to, '-Replace']);
  if (r.code !== 0) fail('-Replace replaces it', `exit ${r.code}: ${r.out.trim().split('\n').pop()}`);
  else if (!(await there(path.join(to, program)))) fail('the program is there after -Replace');
  else say('-Replace replaces it');
  for (const leftover of [`${to}.incoming`, `${to}.previous`]) {
    if (await there(leftover)) fail('no leftover folders', leftover);
  }
  say('no leftover folders');
}

// 7. Uninstall.
{
  const uninstaller = path.join(to, 'uninstall.ps1');
  const look = await script(uninstaller, ['-Check']);
  if (look.code !== 0) fail('uninstall -Check ends well', look.out.trim().split('\n').pop());
  else if (!/left alone, your own files/i.test(look.out)) fail('uninstall -Check says what it leaves alone');
  else if (!(await there(to))) fail('uninstall -Check removed nothing');
  else say('uninstall -Check: says what it would remove, removes nothing');

  const r = await script(uninstaller, []);
  if (r.code !== 0) fail('uninstalls', `exit ${r.code}: ${r.out.trim()}`);
  else say('uninstalls');
  if (await there(shortcut)) fail('the Start menu entry is gone', shortcut);
  else say('the Start menu entry is gone');
  if ((await regThere()) !== 'no') fail('the entry in Apps and features is gone', regKey);
  else say('the entry in Apps and features is gone');
  // The folder goes with it, said in the same words and in the same window: no second window, nothing left
  // to finish later. A script cannot delete the folder it is running from, so it hands that to a copy of
  // itself in the temporary folder and waits for it.
  if (await there(to)) fail('the folder is gone', `${to} is still there: ${r.out.trim().split('\n').slice(-4).join(' | ')}`);
  else if (!/removed the folder/.test(r.out)) fail('it said the folder went', r.out.trim().split('\n').slice(-3).join(' | '));
  else say('the folder is gone, and it said so');
  for (const leftover of await readdir(path.dirname(to))) {
    if (leftover.endsWith('.removed.txt')) fail('nothing is left behind to finish later', leftover);
  }
}

await rm(work, { recursive: true, force: true }).catch(() => {});
console.log(failures === 0 ? 'install: all of it holds' : `install: ${failures} did not hold`);
process.exit(failures === 0 ? 0 : 1);
