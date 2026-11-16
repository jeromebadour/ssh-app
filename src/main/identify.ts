// Asking a box who it is (plan B2.3): main's end of the engine program aimed with the role "identify". One
// process per question; it holds no key and can ask for no signature. What it answers is checked for shape here
// and handed to the boxes' check, which keeps it back until a paste has been compared with it.
import { spawn } from 'node:child_process';
import { FINGERPRINT, KEY_LINE } from '../common/boxes';
import { encodeFrame, FrameDecoder, T } from '../common/frame';
import { engineFault } from './engine-check';
import type { Identify, Reached } from './boxes';

// The engine's own deadlines are 10 s to connect and 15 s for the key exchange. This is the limit on the
// process itself, should it ever fail to end.
const HARD_LIMIT_MS = 40_000;
const PHASES = ['connecting', 'key-exchange'];
const CAUSES = ['refused', 'unreachable', 'timed-out', 'weak-offer', 'reset', 'closed-by-box', 'cancelled', 'protocol'];

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const words = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 32).map((x) => x.slice(0, 80)) : []);

export function identifyWith(bin: string, hashesFile: string): Identify {
  return (addr, onPhase) => {
    let cancel = (): void => undefined;
    const done = new Promise<Reached>((resolve) => {
      let settled = false;
      const finish = (r: Reached): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const fail = (cause: string, detail: string, phase = ''): void => finish({ ok: false, cause, phase, detail });
      cancel = () => fail('cancelled', '');
      void engineFault(bin, hashesFile, `${process.platform}-${process.arch}`).then((fault) => {
        if (settled) return;
        if (fault) return fail('protocol', fault);
        const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true });
        const decoder = new FrameDecoder();
        const limit = setTimeout(() => {
          child.kill();
          fail('timed-out', 'the check did not end');
        }, HARD_LIMIT_MS);
        const end = (): void => {
          clearTimeout(limit);
          child.stdin.end();
        };
        cancel = () => {
          end();
          fail('cancelled', '');
        };
        child.stderr.on('data', () => undefined);
        child.stdin.on('error', () => undefined);
        child.on('error', (err) => {
          clearTimeout(limit);
          fail('protocol', `could not start: ${err.message}`);
        });
        child.on('exit', (code) => {
          clearTimeout(limit);
          fail('protocol', `ended with code ${code ?? -1} and no answer`);
        });
        child.stdout.on('data', (chunk: Buffer) => {
          let frames;
          try {
            frames = decoder.push(chunk);
          } catch {
            child.kill();
            return fail('protocol', 'sent a malformed message');
          }
          for (const f of frames) {
            if (f.type === T.Hello) continue;
            if (f.type === T.Fatal) return fail('protocol', text(safeJson(f.body)['error'], 200) || 'fault');
            if (f.type !== T.State) {
              child.kill();
              return fail('protocol', 'sent an unknown message');
            }
            const v = safeJson(f.body);
            const state = text(v['state'], 32);
            if (PHASES.includes(state)) onPhase(state);
            else if (state === 'identified') {
              const type = text(v['type'], 32);
              const fingerprint = text(v['fingerprint'], 64);
              const key = text(v['key'], 1200);
              end();
              if (!KEY_LINE.test(key) || !FINGERPRINT.test(fingerprint) || !key.startsWith(`${type} `)) return fail('protocol', 'the answer was not an identity');
              return finish({ ok: true, type, fingerprint, key });
            } else if (state === 'ended') {
              const cause = text(v['cause'], 32);
              end();
              return finish({ ok: false, cause: CAUSES.includes(cause) ? cause : 'protocol', phase: PHASES.includes(text(v['phase'], 32)) ? text(v['phase'], 32) : '', detail: text(v['detail'], 300), what: text(v['what'], 32), ours: words(v['ours']), box: words(v['box']) });
            } else {
              child.kill();
              return fail('protocol', 'said a state that does not exist');
            }
          }
        });
        child.stdin.write(encodeFrame(T.Aim, Buffer.from(JSON.stringify({ v: 1, role: 'identify', box: { addr } }))));
      });
    });
    return { done, cancel: () => cancel() };
  };
}

function safeJson(body: Uint8Array): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
