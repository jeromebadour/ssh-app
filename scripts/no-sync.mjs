// Fails if the app's own code calls anything that blocks: a synchronous file, process or message call,
// or a blocking browser dialog. One blocked call in main freezes every tab at once.
// Two files are allowed named calls, each once, and nothing else anywhere:
//   - src/main/lab-proof.ts, which answers "is this a lab package?" before the app has started anything (its own
//     header says why);
//   - src/tab/term.ts, one replaceSync: a stylesheet's rules set from text already in memory, the work a <style>
//     element does when its text is set. It waits on no file, process or network;
//   - src/main/main.ts, one statSync and one appendFileSync, in the fault handler alone: a fault may be the
//     last thing this process does, and a fault nobody can read is the thing this app must never do. Nothing
//     is waiting on the window at that moment, because the window is already in a state nobody designed.
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

const allowed = { 'main/lab-proof.ts': ['statSync', 'readFileSync'], 'tab/term.ts': ['replaceSync'], 'main/main.ts': ['statSync', 'appendFileSync'] };
const usedAllowance = new Set();

let bad = 0;
let seen = 0;
for await (const file of files(root)) {
  seen++;
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const [re, what] of rules) {
      const hit = re.exec(line);
      const call = hit ? hit[0].replace(/\s*\($/, '') : '';
      const rel = path.relative(root, file).split(path.sep).join('/');
      // Each allowed call may appear once: a second use is a new blocking call like any other.
      if (hit && (allowed[rel] ?? []).includes(call) && line.split(call).length === 2 && !usedAllowance.has(`${rel}:${call}`)) {
        usedAllowance.add(`${rel}:${call}`);
        continue;
      }
      if (hit) {
        bad++;
        console.log(`${path.relative(process.cwd(), file)}:${i + 1}: ${what}: ${line.trim()}`);
      }
    }
  });
}
for (const [rel, calls] of Object.entries(allowed)) {
  for (const call of calls) {
    if (!usedAllowance.has(`${rel}:${call}`)) {
      bad++;
      console.log(`no-sync: an allowance nothing uses any more: ${call} in ${rel}`);
    }
  }
}
if (seen === 0) { console.log('no-sync: found no source files'); process.exit(1); }
console.log(bad ? `no-sync: ${bad} blocking call(s)` : `no-sync: ${seen} files, no blocking call`);
process.exit(bad ? 1 : 0);
