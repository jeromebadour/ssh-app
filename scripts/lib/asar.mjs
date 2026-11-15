// Writes and reads Electron's app archive (the "asar" format), with nothing from outside Node.
//
// Why ours: the official packaging tool brings about forty packages we would never use, and every build tool can
// change what ships. The format is small and fixed, and this writer gives the same bytes for the same files,
// whoever builds and whenever (sorted names, no dates, no machine paths).
//
// The format (checked against the official @electron/asar 4.3.1 source, 2026-11-15):
//   [4 as u32][H as u32]                       H = length of the header block
//   header block: [P as u32][L as i32][json, L bytes][zeros to a multiple of 4]     P = 4 + L rounded up to 4
//   then every file's bytes, one after another, in the order they appear in the json
// The json: {"files": {name: {"files": {...}} | {"size", "offset" (a string), "integrity"}}}.
// "integrity": {"algorithm":"SHA256","hash": of the whole file,"blockSize":4194304,"blocks":[hash per block]}.
// What Electron checks at start (when its integrity fuse is on) is the SHA-256 of the json text.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 4 * 1024 * 1024;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function integrity(data) {
  const blocks = [];
  for (let at = 0; at < data.length; at += BLOCK) blocks.push(sha(data.subarray(at, Math.min(at + BLOCK, data.length))));
  if (data.length === 0) blocks.push(sha(data));
  return { algorithm: 'SHA256', hash: sha(data), blockSize: BLOCK, blocks };
}

// Builds the archive from a folder. Returns { bytes, headerHash, files }.
export async function buildAsar(srcDir) {
  const bodies = [];
  let offset = 0;
  const walk = async (dir) => {
    const node = { files: {} };
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) node.files[e.name] = await walk(full);
      else if (e.isFile()) {
        const data = await readFile(full);
        node.files[e.name] = { size: data.length, offset: String(offset), integrity: integrity(data) };
        offset += data.length;
        bodies.push(data);
      } else throw new Error(`asar: not a plain file or folder: ${full}`);
    }
    return node;
  };
  const header = JSON.stringify(await walk(srcDir));
  const json = Buffer.from(header, 'utf8');
  const padded = (json.length + 3) & ~3;
  const block = Buffer.alloc(8 + padded);
  block.writeUInt32LE(4 + padded, 0);
  block.writeInt32LE(json.length, 4);
  json.copy(block, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(block.length, 4);
  return { bytes: Buffer.concat([size, block, ...bodies]), headerHash: sha(json), files: bodies.length };
}

export async function writeAsar(srcDir, destFile) {
  const built = await buildAsar(srcDir);
  await writeFile(destFile, built.bytes);
  return { headerHash: built.headerHash, sha256: sha(built.bytes), files: built.files, size: built.bytes.length };
}

// Reads an archive back: its header text, the header's hash, and every file's bytes by path. For tests and checks.
export function readAsar(bytes) {
  if (bytes.readUInt32LE(0) !== 4) throw new Error('asar: bad start');
  const blockLen = bytes.readUInt32LE(4);
  const jsonLen = bytes.readInt32LE(12);
  const header = bytes.subarray(16, 16 + jsonLen).toString('utf8');
  const base = 8 + blockLen;
  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else files.set(p, bytes.subarray(base + Number(child.offset), base + Number(child.offset) + child.size));
    }
  };
  walk(JSON.parse(header), '');
  return { header, headerHash: sha(Buffer.from(header, 'utf8')), files };
}
