// One engine process for one tab. Main starts it, aims it once, relays bytes, and watches it.
// Main never restarts an engine by itself: a silent or dead engine is shown, and the tab says so.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { encodeFrame, FrameDecoder, T } from '../common/frame';
import type { EngineState } from '../common/ipc';

const PING_EVERY_MS = 1000;
const SILENT_AFTER_MS = 5000;
const PENDING_MAX = 1 << 20; // bytes waiting to be written to the engine; more than this is refused

export interface EngineHooks {
  output(bytes: Uint8Array): void;
  state(state: EngineState, cause: string): void;
}

export class Engine {
  state: EngineState = 'starting';
  cause = '';
  refusedInputs = 0;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new FrameDecoder();
  private timer: NodeJS.Timeout | null = null;
  private lastHeard = 0;
  private pingOut = false;
  private closing = false;

  constructor(
    private readonly bin: string,
    private readonly tabId: number,
    private readonly hooks: EngineHooks,
  ) {}

  get pid(): number {
    return this.child?.pid ?? 0;
  }

  start(): void {
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
      this.gone(signal ? `ended by signal ${signal}` : `ended with code ${code ?? -1}`);
    });

    this.write(T.Aim, Buffer.from(JSON.stringify({ v: 1, tab: String(this.tabId), stub: true })));
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

  // The tab was closed by the user: let the engine end by itself, and only then insist.
  close(): void {
    const child = this.child;
    if (!child || this.state === 'gone') return;
    this.closing = true;
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
          this.hooks.output(f.body);
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
