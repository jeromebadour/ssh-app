// Main's end of the key process (plan B1, B2.4): the same engine program, aimed with the role "keys". Main starts
// it once, asks it things, and passes passwords and sign requests on. Main never holds a key: what comes back
// from here is answers, public halves and signatures.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { encodeFrame, FrameDecoder, T } from '../common/frame';
import { engineFault } from './engine-check';

const PING_EVERY_MS = 1000;
const SILENT_AFTER_MS = 5000;

export type KeyReply = { ok: boolean; error?: string; detail?: string; [field: string]: unknown };
export type KeyProcState = 'starting' | 'ready' | 'not-answering' | 'gone';

// The kinds of Password frame (the key process's own numbers).
export const PW = { create: 1, unlock: 2, change: 3, restore: 4 } as const;

export class KeyProc {
  state: KeyProcState = 'starting';
  cause = '';

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly waiting = new Map<number, (r: KeyReply) => void>();
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  private lastHeard = 0;
  private pingOut = false;
  private closing = false;

  constructor(
    private readonly bin: string,
    private readonly hashesFile: string,
    private readonly listFile: string,
    private readonly onState: () => void,
  ) {}

  get pid(): number {
    return this.child?.pid ?? 0;
  }

  // The same check as for a tab's engine: a program file that is not the one this app was built with is not started.
  async start(): Promise<void> {
    const fault = await engineFault(this.bin, this.hashesFile, `${process.platform}-${process.arch}`);
    if (fault) return this.gone(fault);
    const child = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true });
    this.child = child;
    this.lastHeard = Date.now();
    child.stdout.on('data', (chunk: Buffer) => this.onBytes(chunk));
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => this.gone(`could not start: ${err.message}`));
    child.on('exit', (code, signal) => this.gone(this.closing ? 'closed' : signal ? `ended by signal ${signal}` : `ended with code ${code ?? -1}`));
    child.stdin.write(encodeFrame(T.Aim, Buffer.from(JSON.stringify({ v: 1, role: 'keys', file: this.listFile }))));
    this.timer = setInterval(() => this.beat(), PING_EVERY_MS);
  }

  // One thing asked of the list or a key. Always answers: a key process that is gone answers so.
  request(op: string, fields: Record<string, unknown> = {}): Promise<KeyReply> {
    return this.ask((id) => encodeFrame(T.KeyRequest, Buffer.from(JSON.stringify({ ...fields, id, op }))), false);
  }

  // A password, as raw bytes. Every copy made here is overwritten once it has been written to the pipe.
  password(kind: number, password: Uint8Array, before: Uint8Array = new Uint8Array(0)): Promise<KeyReply> {
    return this.ask((id) => {
      const body = Buffer.alloc(9 + before.byteLength + password.byteLength);
      body.writeBigUInt64BE(BigInt(id), 0);
      body[8] = kind;
      body.set(before, 9);
      body.set(password, 9 + before.byteLength);
      const frame = encodeFrame(T.Password, body);
      body.fill(0);
      return frame;
    }, true);
  }

  // Restoring: the backup's full path goes with the password, length first. The path is main's own (a native
  // dialog, or the copy beside the list); no view ever names a file (plan B2.7).
  restore(from: string, password: Uint8Array): Promise<KeyReply> {
    return this.ask((id) => {
      const where = Buffer.from(from, 'utf8');
      const body = Buffer.alloc(13 + where.byteLength + password.byteLength);
      body.writeBigUInt64BE(BigInt(id), 0);
      body[8] = PW.restore;
      body.writeUInt32BE(where.byteLength, 9);
      where.copy(body, 13);
      body.set(password, 13 + where.byteLength);
      const frame = encodeFrame(T.Password, body);
      body.fill(0);
      return frame;
    }, true);
  }

  close(): void {
    this.closing = true;
    this.child?.stdin.end();
  }

  private ask(make: (id: number) => Uint8Array, wipe: boolean): Promise<KeyReply> {
    const child = this.child;
    if (!child || this.state === 'gone' || !child.stdin.writable) return Promise.resolve({ ok: false, error: 'gone', detail: this.cause });
    const id = this.nextId++;
    // Making the frame can refuse it: the protocol carries 1 MiB at most. That is this program's fault, not
    // the key process's, and the answer is said here as a failure of this request. Letting it throw would
    // leave whoever asked waiting for an answer that was never sent.
    let frame: Uint8Array;
    try {
      frame = make(id);
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'refused', detail: `too much to send in one message: ${e instanceof Error ? e.message : String(e)}` });
    }
    return new Promise<KeyReply>((resolve) => {
      this.waiting.set(id, resolve);
      child.stdin.write(frame, () => {
        if (wipe) frame.fill(0);
      });
    });
  }

  private onBytes(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.child?.kill();
      return this.gone('sent a malformed message');
    }
    for (const f of frames) {
      this.lastHeard = Date.now();
      if (f.type === T.Hello) this.set('ready');
      else if (f.type === T.Pong) {
        this.pingOut = false;
        if (this.state === 'not-answering') this.set('ready');
      } else if (f.type === T.KeyReply) {
        let reply: KeyReply & { id?: unknown };
        try {
          reply = JSON.parse(Buffer.from(f.body).toString('utf8')) as KeyReply & { id?: unknown };
        } catch {
          this.child?.kill();
          return this.gone('sent an answer that cannot be read');
        }
        const resolve = typeof reply.id === 'number' ? this.waiting.get(reply.id) : undefined;
        if (!resolve) {
          this.child?.kill();
          return this.gone('answered a question nobody asked');
        }
        this.waiting.delete(reply.id as number);
        resolve(reply);
      } else if (f.type === T.Fatal) {
        try {
          const v = JSON.parse(Buffer.from(f.body).toString('utf8')) as { error?: unknown };
          this.cause = typeof v.error === 'string' ? v.error.slice(0, 200) : 'fault';
        } catch {
          this.cause = 'fault';
        }
      } else {
        this.child?.kill();
        return this.gone('sent an unknown message');
      }
    }
  }

  private beat(): void {
    if (this.state === 'gone') return;
    if (Date.now() - this.lastHeard > SILENT_AFTER_MS) this.set('not-answering');
    if (this.pingOut || this.state === 'starting') return;
    this.pingOut = true;
    this.child?.stdin.write(encodeFrame(T.Ping, randomBytes(8)));
  }

  private gone(cause: string): void {
    if (this.state === 'gone') return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cause = this.cause || cause;
    this.state = 'gone';
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: 'gone', detail: this.cause });
    this.waiting.clear();
    this.onState();
  }

  private set(state: KeyProcState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState();
  }
}
