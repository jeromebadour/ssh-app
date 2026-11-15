// Changes one byte of an app archive in a way that harms nothing by itself, so that only an integrity check
// can notice: used to prove that Electron's check on Windows really refuses a changed archive, with Linux
// (where Electron has no such check) as the control that still starts.
//
//   node scripts/lib/change-archive.mjs <app.asar> index   one hex digit of a recorded hash, inside the index
//   node scripts/lib/change-archive.mjs <app.asar> file    one letter inside a comment of dist/shell/shell.css
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function changeArchive(file, what) {
  const bytes = await readFile(file);
  const blockLen = bytes.readUInt32LE(4);
  const jsonLen = bytes.readInt32LE(12);
  const header = bytes.subarray(16, 16 + jsonLen).toString('utf8');
  let at;
  if (what === 'index') {
    // The recorded hash of dist/tab/tab.css: valid JSON before and after, and nothing reads it at start.
    const node = header.indexOf('"tab.css"');
    const hash = header.indexOf('"hash":"', node);
    if (node < 0 || hash < 0) throw new Error('change-archive: tab.css not found in the index');
    at = 16 + Buffer.byteLength(header.slice(0, hash + 8), 'utf8');
    bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30; // another hex digit
  } else if (what === 'file') {
    const css = JSON.parse(header).files.dist.files.shell.files['shell.css'];
    const start = 8 + blockLen + Number(css.offset);
    const text = bytes.subarray(start, start + css.size).toString('utf8');
    const word = text.indexOf('Scaffolding');
    if (word < 0) throw new Error('change-archive: the comment in shell.css was not found');
    at = start + word;
    bytes[at] = 0x73; // "scaffolding": a letter in a comment
  } else throw new Error('change-archive: say index or file');
  await writeFile(file, bytes);
  return at;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = await changeArchive(process.argv[2], process.argv[3]);
  console.log(`change-archive: one byte changed at ${at}`);
}
