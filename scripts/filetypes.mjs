// Brings in the file-type icons, and the map from a file's name to one of them.
//
// Run by hand, not by the build: it needs the network, and what it writes is committed. The set is the
// Material Icon Theme (MIT), which is the one he already reads at a glance in his editor, curated wide rather
// than narrow (his, 2026-11-18 night: "go way more than the normal extension files, cover as much as
// possible"). BUILD-RULES 2.27 was narrowed the same night to allow a stock set for file types, which are a
// taxonomy of the outside world and not Berth's own voice.
//
//   node scripts/filetypes.mjs            reads the clone it expects at /tmp/material-icon-theme
//   node scripts/filetypes.mjs <path>     reads a clone elsewhere
//
// What it writes: src/tab/filetypes/*.svg, one a kind, and src/tab/filetypes.ts, the map. Nothing it writes
// is executable: they are pictures and a table of names.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const from = process.argv[2] ?? '/tmp/material-icon-theme';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'src/tab/filetypes');

const src = await readFile(path.join(from, 'src/core/icons/fileIcons.ts'), 'utf8');
// The entries are objects in one array, some written on a line of their own and some on several, with
// objects nested inside them for a light theme and a high-contrast one. Splitting the text on a shape of
// newlines reads only the ones written the way that shape expects: it found 338 of the 394 there are, and the
// ones it missed were go, ts, java, c and the rest of the one-liners. So the array is walked by its braces
// and each entry is taken whole, nested objects and all.
const body = src.slice(src.indexOf('parseByPattern([') + 'parseByPattern(['.length);
const entries = [];
for (let i = 0, depth = 0, from0 = -1, inStr = ''; i < body.length; i++) {
  const c = body[i];
  if (inStr) {
    if (c === '\\') i++;
    else if (c === inStr) inStr = '';
    continue;
  }
  if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
  if (c === '{') { if (depth === 0) from0 = i; depth++; continue; }
  if (c === '}') { depth--; if (depth === 0 && from0 >= 0) entries.push(body.slice(from0, i + 1)); continue; }
  if (c === ']' && depth === 0) break;
}
const byExt = {};
const byName = {};
const wanted = new Set();
for (const b of entries) {
  // The entry's own name, which is the first one in it: a nested light or high-contrast object carries its
  // own name after it, and that is a different picture for a theme this app does not have.
  const name = (b.match(/name:\s*'([^']+)'/) || [])[1];
  if (!name) continue;
  const grab = (key) => {
    const m = b.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, 's'));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const exts = grab('fileExtensions');
  const names = grab('fileNames');
  if (exts.length === 0 && names.length === 0) continue;
  wanted.add(name);
  // Last writer wins, which is the order the theme itself resolves them in: it writes each entry's endings
  // into one table as it goes, so a later entry is the one that stands.
  for (const e of exts) byExt[e.toLowerCase()] = name;
  for (const n of names) byName[n.toLowerCase()] = name;
}
console.log(JSON.stringify({ entriesRead: entries.length }));

// Berth's own additions, for files a person meets on a server that an editor's theme has no ending for. They
// are written here rather than beside the table, so they survive the table being written again, and they only
// ever name a picture the set already holds.
const ALSO = {
  service: 'settings',
  socket: 'settings',
  timer: 'settings',
  mount: 'settings',
  target: 'settings',
  slice: 'settings',
  sock: 'console',
  pid: 'console',
  rpm: 'zip',
  deb: 'zip',
  tgz: 'zip',
  tbz: 'zip',
  txz: 'zip',
  zst: 'zip',
  journal: 'log',
  out: 'log',
  err: 'log',
  pcap: 'log',
  htpasswd: 'key',
  kdbx: 'key',
  csr: 'certificate',
  der: 'certificate',
  jks: 'certificate',
};
for (const [e, n] of Object.entries(ALSO)) byExt[e] = n;

// And the folders, from the same set and by the same rules. He named them first: "the folders icons, files
// icons and other file types are very generic and carry no weight at all". A folder whose name the set does
// not know keeps Berth's own folder shape.
const folderSrc = await readFile(path.join(from, 'src/core/icons/folderIcons.ts'), 'utf8');
const byFolder = {};
{
  const fbody = folderSrc.slice(folderSrc.indexOf('icons: ['));
  const got = [];
  for (let i = 0, depth = 0, start = -1, inStr = ''; i < fbody.length; i++) {
    const c = fbody[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') { depth--; if (depth === 0 && start >= 0) got.push(fbody.slice(start, i + 1)); continue; }
  }
  for (const b of got) {
    const name = (b.match(/name:\s*'([^']+)'/) || [])[1];
    const m = b.match(/folderNames:\s*\[([^\]]*)\]/s);
    if (!name || !m) continue;
    wanted.add(name);
    for (const f of [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) byFolder[f.toLowerCase()] = name;
  }
}
for (const [k, v] of Object.entries(byFolder)) if (!v) delete byFolder[k];

const have = new Set((await readdir(path.join(from, 'icons'))).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)));
const missing = [...wanted].filter((n) => !have.has(n));
for (const [k, v] of Object.entries(byExt)) if (!have.has(v)) delete byExt[k];
for (const [k, v] of Object.entries(byName)) if (!have.has(v)) delete byName[k];
for (const [k, v] of Object.entries(byFolder)) if (!have.has(v)) delete byFolder[k];
const keep = [...wanted].filter((n) => have.has(n)).sort();

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const n of keep) await cp(path.join(from, 'icons', `${n}.svg`), path.join(out, `${n}.svg`));
await cp(path.join(from, 'LICENSE'), path.join(out, 'LICENSE'));

const head = await readFile(path.join(from, '.git/HEAD'), 'utf8').catch(() => '');
await writeFile(
  path.join(root, 'src/tab/filetypes.ts'),
  `// What kind of file a name says it is, and nothing else: this table is written by scripts/filetypes.mjs and\n` +
    `// is not edited by hand. The pictures it names are in src/tab/filetypes, from the Material Icon Theme\n` +
    `// (MIT, see the LICENSE beside them). A name here is only ever one of these keys' values, never anything\n` +
    `// taken from a box: a file on a box called "../../etc" can reach nothing, because its own letters are\n` +
    `// looked up and never used to build a path.\n` +
    `//\n` +
    `// ${keep.length} kinds, ${Object.keys(byExt).length} endings and ${Object.keys(byName).length} whole names.\n` +
    `export const BY_END: Readonly<Record<string, string>> = ${JSON.stringify(byExt, null, 0)};\n` +
    `export const BY_NAME: Readonly<Record<string, string>> = ${JSON.stringify(byName, null, 0)};\n` +
    `export const BY_FOLDER: Readonly<Record<string, string>> = ${JSON.stringify(byFolder, null, 0)};\n`,
);
console.log(JSON.stringify({ kinds: keep.length, endings: Object.keys(byExt).length, names: Object.keys(byName).length, folders: Object.keys(byFolder).length, noPicture: missing.length, from: head.trim().slice(0, 60) }));
