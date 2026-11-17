// The local log: one line for every failure, each with a short id he can read out loud, so what the window
// said and what the file holds can be put side by side. It is step 2b's ninth finding and BUILD-RULES 5.7,
// and it is what the console will read.
//
// What it holds and what it must never hold. The file is plain text on his PC, beside the encrypted list,
// so it is written on the assumption that it will be read by whoever can read that folder: it names a box
// only by the box's own short id, never by a name, an address, a user or a folder, and nothing of a key, a
// password or the list's contents is ever passed to it. Everything a box sent is escaped to one line, so a
// box cannot write a line of its own into the log by naming a file with a newline in it.
//
// **Only the app's own words go in a detail.** Not a box's, and not a library's either: the SSH library's
// error text reads "read tcp 127.0.0.1:47724->127.0.0.1:42973", which is both ends of the link in the clear.
// A cause from a fixed list, a phase, a number of an ask: those are the app's. A caller that wants to pass
// on what something else wrote shows it in the window instead, where it is drawn escaped and marked as
// theirs. A probe in the lab holds this: it reads the log and fails on a box's name, address or folder.
//
// Writing never blocks (plan B8.1). Lines are queued and appended in order by one writer; a caller gets its
// id at once and goes on. The one exception is the fault that may be the last thing the process does, which
// has its own blocking path in main and uses the same line shape.

import { appendFile, rename, stat } from 'node:fs/promises';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

// The alphabet of an id: no I, O, 0 or 1, because he will read these over a chat or a phone. Six characters
// out of 32 is about a billion, which is far more than one log of a few thousand lines needs to keep apart.
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_LENGTH = 6;

// How long one line's detail may be, and how big the file may grow before it is rolled over. A log that can
// fill a disk is a fault of its own.
export const DETAIL_MAX = 400;
export const FILE_MAX = 1024 * 1024;

export const FAULT_FILE = 'faults.log';
export const FAULT_FILE_OLD = 'faults-1.log';

// One id. The random source is the platform's, because an id that can be guessed is of no use to anyone and
// an id that repeats is a line he cannot find.
export const faultId = (random: () => number = Math.random): string => {
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? 'A';
  return out;
};

// One line, made safe to be a line. Anything a box or a view had a hand in arrives here; what leaves is one
// line of printable characters, so no sender can add a line, blank the file with returns, or hide text behind
// an escape sequence the next reader's terminal would act on.
export const oneLine = (text: string, most = DETAIL_MAX): string => {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13) out += ' ';
    else if (c < 0x20 || c === 0x7f) out += '.';
    else out += ch;
    if (out.length >= most) return `${out.slice(0, most)}…`;
  }
  return out;
};

export interface FaultLine {
  id: string;
  what: string; // one word for the kind of failure, always the app's own, never a box's or a view's
  detail: string;
  tab?: number; // which tab it happened in, if any
  box?: string; // the box's own id in the list, and never its name, address or user
  at?: Date;
}

// The line as it is written: time, id, kind, then the named things and the detail. One line, one failure.
export const lineOf = (f: FaultLine): string => {
  const at = (f.at ?? new Date()).toISOString();
  const bits = [at, f.id, oneLine(f.what, 40)];
  if (typeof f.tab === 'number') bits.push(`tab=${Math.trunc(f.tab)}`);
  if (f.box) bits.push(`box=${oneLine(f.box, 40)}`);
  bits.push(oneLine(f.detail));
  return `${bits.join(' ')}\n`;
};

export interface FaultLogWhere {
  folder: string;
  max?: number;
  now?: () => Date;
  random?: () => number;
}

export class FaultLog {
  private readonly folder: string;
  private readonly max: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  // What is waiting to be written, and the one writer working through it. Lines keep their order because one
  // chain does all the work; a caller never waits for any of it.
  private waiting: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private busy = false;
  private written = 0;
  private lost = 0;
  // How big the live file is, as far as this process knows. It is read from the disk once and then kept, so
  // the cap costs one stat and not one per line; a failed write forgets it, so the next line reads it again.
  private size: number | null = null;
  private recent: { id: string; what: string }[] = [];

  constructor(where: FaultLogWhere) {
    this.folder = where.folder;
    this.max = where.max ?? FILE_MAX;
    this.now = where.now ?? (() => new Date());
    this.random = where.random ?? Math.random;
  }

  get file(): string {
    return path.join(this.folder, FAULT_FILE);
  }

  get old(): string {
    return path.join(this.folder, FAULT_FILE_OLD);
  }

  // How many lines reached the file, and how many could not be written at all. The second is what the
  // self-test and the console read: a log that cannot be written is itself a failure, and saying nothing
  // about it would be the silence this whole file exists to end.
  get counts(): { written: number; lost: number; waiting: number } {
    return { written: this.written, lost: this.lost, waiting: this.waiting.length };
  }

  // Write one failure down and give back its id at once. Nothing here waits on a disk.
  say(f: Omit<FaultLine, 'id' | 'at'> & { id?: string }): string {
    const id = f.id ?? faultId(this.random);
    this.waiting.push(lineOf({ ...f, id, at: this.now() }));
    this.remember(id, f.what);
    this.start();
    return id;
  }

  // The one blocking write, for the failure that may be the last thing this process does: an uncaught fault
  // in main, where a queued line would be lost with the process that queued it. A written failure is worth
  // more than the microseconds, and it is the only place in main that writes to a disk and waits (plan
  // B8.1 names it).
  sayNow(f: Omit<FaultLine, 'id' | 'at'> & { id?: string }): string {
    const id = f.id ?? faultId(this.random);
    const line = lineOf({ ...f, id, at: this.now() });
    try {
      const at = statSync(this.file, { throwIfNoEntry: false });
      if (at && at.size + line.length > this.max) {
        renameSync(this.file, this.old);
        this.size = 0;
      }
      appendFileSync(this.file, line);
      this.written++;
      this.size = this.size === null ? null : this.size + line.length;
    } catch {
      this.lost++;
      this.size = null;
    }
    this.remember(id, f.what);
    return id;
  }

  // The last few failures, for the self-test and later for the console: what kind each was and its id, so a
  // run can say that a failure really was written down and not only shown.
  get lately(): { id: string; what: string }[] {
    return [...this.recent];
  }

  private remember(id: string, what: string): void {
    this.recent.push({ id, what });
    if (this.recent.length > 50) this.recent.shift();
  }

  // Everything written so far, for a close or for the self-test. It never rejects: a log is best-effort by
  // nature, and what went wrong with it is in the counts.
  settled(): Promise<void> {
    this.start();
    return this.writing.catch(() => undefined);
  }

  private start(): void {
    if (this.busy) return;
    this.busy = true;
    this.writing = this.writing.then(() => this.work()).catch(() => undefined);
  }

  private async work(): Promise<void> {
    try {
      while (this.waiting.length > 0) {
        const lines = this.waiting;
        this.waiting = [];
        // The cap is held line by line and not batch by batch. A hundred failures in one moment are one
        // append, but if they would take the file past its size the file is rolled over between them: a cap
        // that only one batch has to respect is a cap a bad moment walks straight through.
        let batch = '';
        for (const line of lines) {
          if (this.size === null) this.size = await stat(this.file).then((a) => a.size, () => 0);
          if (this.size + batch.length + line.length > this.max) {
            if (!(await this.put(batch))) break;
            batch = '';
            await this.roll();
          }
          batch += line;
        }
        if (batch !== '') await this.put(batch);
      }
    } finally {
      this.busy = false;
    }
  }

  // One append, counted either way. It never throws: a log is best-effort by nature, and what went wrong
  // with it is in the counts, which the self-test and the console read.
  private async put(text: string): Promise<boolean> {
    if (text === '') return true;
    const lines = text.split('\n').length - 1;
    try {
      await appendFile(this.file, text);
      this.written += lines;
      this.size = (this.size ?? 0) + text.length;
      return true;
    } catch {
      this.lost += lines;
      this.size = null;
      return false;
    }
  }

  // One previous log is kept and no more: the newest failures are the ones he is looking at, and two files
  // of a known size cannot grow into a problem of their own.
  private async roll(): Promise<void> {
    await rename(this.file, this.old).catch(() => undefined);
    this.size = 0;
  }
}
