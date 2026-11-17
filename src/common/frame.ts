// The one message format spoken between the app's processes.
// A frame is: a 4-byte big-endian length, then that many bytes: one type byte and the body.
// The Go side (engine/internal/frame) implements the same format; both run protocol/vectors.json.

export const MAX_PAYLOAD = 1 << 20;

export const T = {
  Aim: 0x01,
  Hello: 0x02,
  Ping: 0x03,
  Pong: 0x04,
  Input: 0x10,
  Output: 0x11,
  Resize: 0x12,
  Ack: 0x13,
  State: 0x20,
  Pulse: 0x21,
  SignRequest: 0x22,
  SignReply: 0x23,
  Banner: 0x24,
  Exit: 0x25,
  Notice: 0x26,
  // Files, on a channel of their own so a listing never holds up what is typed.
  FileAsk: 0x28,
  FilePage: 0x29,
  KeyRequest: 0x30,
  KeyReply: 0x31,
  Password: 0x32,
  Fatal: 0x7f,
} as const;

export type FrameErrorKind = 'empty' | 'too-large' | 'truncated';

export class FrameError extends Error {
  constructor(readonly kind: FrameErrorKind) {
    super(`frame: ${kind}`);
  }
}

export interface Frame {
  type: number;
  body: Uint8Array;
}

export function encodeFrame(type: number, body: Uint8Array): Uint8Array {
  if (body.byteLength + 1 > MAX_PAYLOAD) throw new FrameError('too-large');
  const out = new Uint8Array(5 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength + 1);
  out[4] = type & 0xff;
  out.set(body, 5);
  return out;
}

// Turns a byte stream into frames. It holds at most one frame's worth of bytes plus the chunk it was
// just given, and refuses a length over the limit before any of that frame's body is kept.
export class FrameDecoder {
  private chunks: Uint8Array[] = [];
  private held = 0;
  private failed = false;

  push(chunk: Uint8Array): Frame[] {
    if (this.failed) throw new FrameError('truncated');
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
      this.held += chunk.byteLength;
    }
    const frames: Frame[] = [];
    for (;;) {
      if (this.held < 4) return frames;
      const head = this.peek(4);
      const n = new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
      if (n === 0) return this.fail('empty');
      if (n > MAX_PAYLOAD) return this.fail('too-large');
      if (this.held < 4 + n) return frames;
      const whole = this.take(4 + n);
      frames.push({ type: whole[4]!, body: whole.subarray(5) });
    }
  }

  // Call when the stream has ended: bytes left over mean the last frame was cut short.
  end(): void {
    if (this.held > 0 && !this.failed) this.fail('truncated');
  }

  private fail(kind: FrameErrorKind): never {
    this.failed = true;
    this.chunks = [];
    this.held = 0;
    throw new FrameError(kind);
  }

  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength >= n) return first.subarray(0, n);
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of this.chunks) {
      const part = c.subarray(0, Math.min(c.byteLength, n - at));
      out.set(part, at);
      at += part.byteLength;
      if (at === n) break;
    }
    return out;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0]!;
      const want = n - at;
      if (c.byteLength <= want) {
        out.set(c, at);
        at += c.byteLength;
        this.chunks.shift();
      } else {
        out.set(c.subarray(0, want), at);
        this.chunks[0] = c.subarray(want);
        at += want;
      }
    }
    this.held -= n;
    return out;
  }
}
