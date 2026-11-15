// Fails if the app's own code calls anything that blocks: a synchronous file, process or message call,
// or a blocking browser dialog. One blocked call in main freezes every tab at once.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'src');
const rules = [
  [/\b[A-Za-z_$][\w$]*Sync\s*\(/, 'a synchronous call'],
  [/\b(?:alert|confirm|prompt)\s*\(/, 'a blocking dialog'],
  [/\bdialog\.showErrorBox\s*\(/, 'a blocking error box'],
];

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(ts|js|mjs|html)$/.test(e.name)) yield p;
  }
}

let bad = 0;
let seen = 0;
for await (const file of files(root)) {
  seen++;
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const [re, what] of rules) {
      if (re.test(line)) {
        bad++;
        console.log(`${path.relative(process.cwd(), file)}:${i + 1}: ${what}: ${line.trim()}`);
      }
    }
  });
}
if (seen === 0) { console.log('no-sync: found no source files'); process.exit(1); }
console.log(bad ? `no-sync: ${bad} blocking call(s)` : `no-sync: ${seen} files, no blocking call`);
process.exit(bad ? 1 : 0);
