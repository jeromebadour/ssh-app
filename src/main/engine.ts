// One engine process for one tab. Main starts it, aims it once, relays bytes, and watches it.
// Main never restarts an engine by itself: a silent or dead engine is shown, and the tab says so.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { encodeFrame, FrameDecoder, T } from '../common/frame';
import { LINK_CAUSES, NO_LINK, type EngineState, type LinkInfo, type LinkPhase } from '../common/ipc';
import { engineFault } from './engine-check';

const PING_EVERY_MS = 1000;
const SILENT_AFTER_MS = 5000;
const PENDING_MAX = 1 << 20; // bytes waiting to be written to the engine; more than this is refused

export interface EngineHooks {
  output(bytes: Uint8Array): void;
  state(state: EngineState, cause: string): void;
  // A real engine only. link: where its link stands, told at every change. banner: the box's sign-in text.
  // sign: the engine asks for one signature; whoever answers decides with which key and for which box.
  link?(info: LinkInfo): void;
  banner?(bytes: Uint8Array): void;
  sign?(req: SignRequest): Promise<SignAnswer>;
}

export interface SignRequest {
  key: string;
  algorithm: string;
  data: string; // base64, exactly what the SSH protocol has a client sign
}
export type SignAnswer = { signature: string } | { error: string };

// What an engine is aimed at, once: nothing (the skeleton's echo, for the self-test), or one box.
export type EngineAim =
  | { stub: true }
  | { stub: false; box: { addr: string; user: string; hostKey: string; key: string; publicKey: string }; shell: { folder: string; term: string; cols: number; rows: number } };

const SIGN_REQUESTS_MAX = 4; // one link asks once; more than a few is not a sign-in
const SIGN_DATA_MAX = 8 * 1024; // base64 characters
const PHASES: readonly string[] = ['connecting', 'key-exchange', 'signing-in', 'up', 'ended'];

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 32).map((x) => x.slice(0, 80)) : []);

export class Engine {
  state: EngineState = 'starting';
  cause = '';
  refusedInputs = 0;
  link: LinkInfo = { ...NO_LINK };
  signAsked = 0;
  signRefused = 0;
  private forwarded = 0; // output bytes handed on, in all
  private acked = 0;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new FrameDecoder();
  private timer: NodeJS.Timeout | null = null;
  private lastHeard = 0;
  private pingOut = false;
  private closing = false;

  constructor(
    private readonly bin: string,
    private readonly hashesFile: string,
    private readonly tabId: number,
    private readonly hooks: EngineHooks,
    private aim: EngineAim = { stub: true },
  ) {}

  get pid(): number {
    return this.child?.pid ?? 0;
  }

  // The size the box's terminal is opened with: the view's own, when it is known before the engine starts.
  openAt(cols: number, rows: number): void {
    if (!this.aim.stub && this.state === 'starting' && !this.child && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1 && cols <= 2000 && rows <= 2000) this.aim.shell = { ...this.aim.shell, cols, rows };
  }

  // Checks the engine file first, every time: a file that is not the one this app was built with is not started.
  async start(): Promise<void> {
    const fault = await engineFault(this.bin, this.hashesFile, `${process.platform}-${process.arch}`);
    if (this.closing) return this.gone('closed');
    if (fault) return this.gone(fault);
    this.spawn();
  }

  private spawn(): void {
    // An empty environment: nothing about the PC reaches the engine that it was not given.
    const child = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true });
    this.child = child;
    this.lastHeard = Date.now();

    child.stdout.on('data', (chunk: Buffer) => this.onBytes(chunk));
    child.stdout.on('end', () => this.onStreamEnd());
    child.stderr.on('data', () => undefined); // drained and dropped: an engine's stderr is not a channel
    child.stdin.on('error', () => undefined); // a closed pipe is reported through 'exit'
    child.on('error', (err) => this.gone(`could not start: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.closing) return this.gone('closed');
      // An engine aimed at a box lives for one link: once it has said how the link ended, its own end is expected.
      if (this.link.phase === 'ended' && code === 0) return this.gone('the link ended');
      this.gone(signal ? `ended by signal ${signal}` : `ended with code ${code ?? -1}`);
    });

    this.write(T.Aim, Buffer.from(JSON.stringify({ v: 1, tab: String(this.tabId), ...this.aim })));
    this.timer = setInterval(() => this.beat(), PING_EVERY_MS);
  }

  // Bytes typed in the tab. Returns false when they were refused.
  input(bytes: Uint8Array): boolean {
    const child = this.child;
    if (!child || this.state === 'gone' || this.state === 'starting') return false;
    if (child.stdin.writableLength > PENDING_MAX) {
      this.refusedInputs++;
      return false;
    }
    this.write(T.Input, bytes);
    return true;
  }

  // Output handed on that the view has not yet taken: what its box is ahead by.
  waiting(): number {
    return this.aim.stub ? 0 : this.forwarded - this.acked; // the skeleton's echo knows no credit: nothing of it is ever held back
  }

  // The view says how many output bytes it has taken in all. The engine sends at most a fixed amount ahead of
  // this, so a slow window makes the box wait instead of filling memory. A count that cannot be true (more
  // than was handed on, or going backwards) is not passed on.
  taken(total: number): boolean {
    if (!Number.isSafeInteger(total) || total < this.acked || total > this.forwarded) return false;
    if (total === this.acked) return true;
    this.acked = total;
    if (this.aim.stub) return true; // the skeleton's echo sends on no credit: there is nothing to tell it
    const body = Buffer.alloc(8);
    body.writeBigUInt64BE(BigInt(total));
    this.write(T.Ack, body);
    return true;
  }

  // The terminal's size, for the box's own terminal. False for a size that is none.
  resize(cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 2000 || rows > 2000) return false;
    if (!this.aim.stub) this.write(T.Resize, Buffer.from(JSON.stringify({ cols, rows })));
    return true;
  }

  // The tab was closed by the user: let the engine end by itself, and only then insist.
  close(): void {
    this.closing = true;
    const child = this.child;
    if (!child || this.state === 'gone') return;
    child.stdin.end();
    setTimeout(() => {
      if (this.state !== 'gone') child.kill();
    }, 2000).unref();
  }

  private write(type: number, body: Uint8Array): void {
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(encodeFrame(type, body));
  }

  private onBytes(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch {
      // A malformed frame from a Go process ends that process.
      this.child?.kill();
      return this.gone('sent a malformed message');
    }
    for (const f of frames) {
      this.lastHeard = Date.now();
      switch (f.type) {
        case T.Hello:
          this.set('ready', '');
          break;
        case T.Pong:
          this.pingOut = false;
          if (this.state === 'not-answering') this.set('ready', '');
          break;
        case T.Output:
          this.forwarded += f.body.byteLength;
          this.hooks.output(f.body);
          break;
        case T.State:
        case T.Pulse:
        case T.SignRequest:
        case T.Banner:
        case T.Exit:
        case T.Notice:
          // Only an engine aimed at a box says these; from the skeleton they are an unknown message.
          if (this.aim.stub || !this.fromBox(f.type, f.body)) {
            this.child?.kill();
            return this.gone('sent an unknown message');
          }
          break;
        case T.Fatal:
          this.cause = fatalText(f.body);
          break;
        default:
          this.child?.kill();
          return this.gone('sent an unknown message');
      }
    }
  }

  // A frame only a real engine sends. False for one that cannot be read: that ends the engine.
  private fromBox(type: number, body: Uint8Array): boolean {
    if (type === T.Banner) {
      this.hooks.banner?.(body);
      return true;
    }
    let v: Record<string, unknown>;
    try {
      const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return false;
      v = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    switch (type) {
      case T.State: {
        const phase = str(v['state'], 32);
        if (!PHASES.includes(phase)) return false;
        if (phase === 'ended') {
          const cause = str(v['cause'], 32);
          this.tell({ phase: 'ended', cause: (LINK_CAUSES as readonly string[]).includes(cause) ? cause : 'protocol', endedIn: str(v['phase'], 32), detail: str(v['detail'], 300), what: str(v['what'], 32), ours: strs(v['ours']), theirs: strs(v['box']), shownFingerprint: /^SHA256:[A-Za-z0-9+/]{43}$/.test(str(v['gotFingerprint'], 64)) ? str(v['gotFingerprint'], 64) : '', silentSinceMs: 0, waitingOnWindow: false });
        } else if (phase === 'up') {
          this.tell({ phase: 'up', keyExchange: str(v['keyExchange'], 64), cipher: str(v['cipher'], 64), postQuantum: v['postQuantum'] === true });
        } else this.tell({ phase: phase as LinkPhase });
        return true;
      }
      case T.Pulse:
        if (v['silent'] === true) this.tell({ silentSinceMs: typeof v['sinceMs'] === 'number' && v['sinceMs'] > 0 ? v['sinceMs'] : Date.now() });
        else this.tell({ silentSinceMs: 0, rttMs: typeof v['rttMs'] === 'number' && v['rttMs'] >= 0 ? Math.round(v['rttMs']) : -1 });
        return true;
      case T.Notice:
        if (v['notice'] === 'waiting-on-window') this.tell({ waitingOnWindow: v['on'] === true });
        else if (v['notice'] === 'typed-bytes-dropped') this.tell({ droppedBytes: typeof v['bytes'] === 'number' && v['bytes'] > 0 ? Math.round(v['bytes']) : this.link.droppedBytes });
        else return false;
        return true;
      case T.Exit:
        this.tell({ exitStatus: typeof v['status'] === 'number' && Number.isInteger(v['status']) && v['status'] >= 0 ? v['status'] : -1 });
        return true;
      case T.SignRequest: {
        const id = v['id'];
        const req = { key: str(v['key'], 80), algorithm: str(v['algorithm'], 40), data: typeof v['data'] === 'string' ? v['data'] : '' };
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return false;
        this.signAsked++;
        const answer = (a: SignAnswer): void => this.write(T.SignReply, Buffer.from(JSON.stringify({ id, ...a })));
        // Asked only while signing in, a few times at most, and for nothing that is not a sign-in's size.
        if (!this.hooks.sign || this.link.phase !== 'signing-in' || this.signAsked > SIGN_REQUESTS_MAX || req.data.length === 0 || req.data.length > SIGN_DATA_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(req.data)) {
          this.signRefused++;
          answer({ error: 'refused' });
          return true;
        }
        void this.hooks.sign(req).then(answer, () => answer({ error: 'refused' }));
        return true;
      }
    }
    return false;
  }

  private tell(change: Partial<LinkInfo>): void {
    this.link = { ...this.link, ...change };
    this.hooks.link?.(this.link);
  }

  private onStreamEnd(): void {
    try {
      this.decoder.end();
    } catch {
      /* the exit handler reports it */
    }
  }

  private beat(): void {
    if (this.state === 'gone' || this.state === 'starting') {
      if (this.state === 'starting' && Date.now() - this.lastHeard > SILENT_AFTER_MS) this.set('not-answering', '');
      return;
    }
    if (Date.now() - this.lastHeard > SILENT_AFTER_MS) this.set('not-answering', '');
    if (this.pingOut) return; // one unanswered ping is enough; none are stacked behind it
    this.pingOut = true;
    this.write(T.Ping, randomBytes(8));
  }

  private gone(cause: string): void {
    if (this.state === 'gone') return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.set('gone', this.cause || cause);
  }

  private set(state: EngineState, cause: string): void {
    if (this.state === state && this.cause === cause) return;
    this.state = state;
    this.cause = cause;
    this.hooks.state(state, cause);
  }
}

function fatalText(body: Uint8Array): string {
  try {
    const v = JSON.parse(Buffer.from(body).toString('utf8')) as { error?: unknown };
    return typeof v.error === 'string' ? v.error.slice(0, 200) : 'engine fault';
  } catch {
    return 'engine fault';
  }
}
