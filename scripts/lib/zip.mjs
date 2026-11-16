// A zip writer, so that making the release zip needs no tool the machine may not have (Windows runners have
// no `zip`, and PowerShell's own archive command writes something else again). It writes the format itself:
// local header, deflated bytes, central directory, end record. No extra field, no comment, no data
// descriptor, and one fixed moment for every entry, so the same files always make the same bytes.
//
// What it does not do: files of 4 GiB or more, or an archive over 4 GiB (Zip64). It refuses either rather
// than writing something a reader would take as a smaller file.
import { createHash } from 'node:crypto';
import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const MADE_BY = 20;
const NEEDED = 20;
const UTF8 = 0x0800;
const DEFLATED = 8;
const STORED = 0;
// 1980-01-01 00:00:00, the earliest the format can hold: the same for every entry, so nothing about the
// machine or the moment gets into the file.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const LIMIT = 0xffffffff;

function localHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(30 + name.byteLength);
  h.writeUInt32LE(LOCAL, 0);
  h.writeUInt16LE(NEEDED, 4);
  h.writeUInt16LE(UTF8, 6);
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.packed, 18);
  h.writeUInt32LE(e.size, 22);
  h.writeUInt16LE(name.byteLength, 26);
  h.writeUInt16LE(0, 28);
  name.copy(h, 30);
  return h;
}

function centralHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(46 + name.byteLength);
  h.writeUInt32LE(CENTRAL, 0);
  h.writeUInt16LE(MADE_BY, 4);
  h.writeUInt16LE(NEEDED, 6);
  h.writeUInt16LE(UTF8, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(DOS_TIME, 12);
  h.writeUInt16LE(DOS_DATE, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.packed, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(name.byteLength, 28);
  h.writeUInt16LE(0, 30); // extra
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attributes
  h.writeUInt32LE(e.dir ? 0x10 : 0, 38); // external attributes: the directory bit, nothing else
  h.writeUInt32LE(e.at, 42);
  name.copy(h, 46);
  return h;
}

// Every file and folder under `dir`, as entry names under `prefix`, sorted so the order never depends on the
// filesystem. Folders come before what is in them, as a reader expects.
async function entriesOf(dir, prefix) {
  const out = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    const name = `${prefix}${e.name}`;
    if (e.isDirectory()) {
      out.push({ name: `${name}/`, dir: true, from: null });
      out.push(...(await entriesOf(full, `${name}/`)));
    } else if (e.isFile()) {
      out.push({ name, dir: false, from: full });
    }
  }
  return out;
}

// Writes `dir` into the zip at `zipPath`, under one folder named as `dir` is. Returns what was written.
export async function writeZip(zipPath, dir) {
  const top = path.basename(dir);
  const entries = [{ name: `${top}/`, dir: true, from: null }, ...(await entriesOf(dir, `${top}/`))];
  const file = await open(zipPath, 'w');
  let at = 0;
  const written = [];
  try {
    for (const e of entries) {
      const body = e.dir ? Buffer.alloc(0) : await readFile(e.from);
      if (body.byteLength > LIMIT) throw new Error(`zip: ${e.name} is ${body.byteLength} bytes: this writer does not write files of 4 GiB or more`);
      const packed = e.dir ? body : deflateRawSync(body, { level: 9 });
      // A file that deflate makes bigger is kept as it is: a reader needs no instructions either way.
      const useStored = e.dir || packed.byteLength >= body.byteLength;
      const entry = {
        name: e.name,
        dir: e.dir,
        method: useStored ? STORED : DEFLATED,
        crc: e.dir ? 0 : crc32(body),
        size: body.byteLength,
        packed: useStored ? body.byteLength : packed.byteLength,
        at,
      };
      const head = localHeader(entry);
      await file.write(head);
      if (entry.packed > 0) await file.write(useStored ? body : packed);
      at += head.byteLength + entry.packed;
      if (at > LIMIT) throw new Error('zip: over 4 GiB: this writer does not write that');
      written.push(entry);
    }
    const start = at;
    for (const entry of written) {
      const head = centralHeader(entry);
      await file.write(head);
      at += head.byteLength;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(written.length, 8);
    end.writeUInt16LE(written.length, 10);
    end.writeUInt32LE(at - start, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    await file.write(end);
  } finally {
    await file.close();
  }
  const sha256 = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  return { entries: written.length, files: written.filter((e) => !e.dir).length, sha256 };
}
