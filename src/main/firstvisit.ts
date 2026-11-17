// The first visit (decision O2, plan B2.5 entry 5): main's end of the engine program aimed with the role
// "firstvisit". One process per visit, which lives a few seconds.
//
// This is the one place in the whole app where a password is ever offered to a box, so what main does here is
// as narrow as it can be made:
//
//   - It is called only after the box has been pinned. The pinned identity goes with the aim, and the engine
//     refuses to sign in to anything else, so a box pretending to be his never sees the password.
//   - The command is not a caller's to choose in spirit: it is the one block from first-connection.json with
//     the box's own public key in it, which is the same text the paste route shows and the lab runs.
//   - The password is held in a string for as long as this call takes and is written nowhere: not to the list,
//     not to a log, not to the window's state.
//   - What the box prints back is a box's own words. It is capped here as well as in the engine, and it is
//     shown where box text is shown, escaped, and never acted on.

import { spawn } from 'node:child_process';
import { encodeFrame, FrameDecoder, T } from '../common/frame';
import { engineFault } from './engine-check';

// The engine allows two minutes for the whole visit. This is the limit on the process itself, should it ever
// fail to end.
const HARD_LIMIT_MS = 150_000;
const PHASES = ['connecting', 'key-exchange', 'signing-in'];
const CAUSES = ['refused', 'unreachable', 'timed-out', 'weak-offer', 'reset', 'closed-by-box', 'cancelled', 'protocol', 'identity-changed', 'sign-in-failed', 'asked-something-else'];
const SAID_MAX = 4000;

export type Visited = { ok: true; said: string } | { ok: false; cause: string; detail: string };

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const safeJson = (body: Uint8Array): Record<string, unknown> => {
  try {
    const v = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export function firstVisitWith(bin: string, hashesFile: string) {
  return (box: { addr: string; user: string; hostKey: string }, password: string, command: string, onPhase: (p: string) => void): Promise<Visited> =>
    new Promise<Visited>((resolve) => {
      let settled = false;
      const finish = (r: Visited): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const fail = (cause: string, detail: string): void => finish({ ok: false, cause, detail });
      void engineFault(bin, hashesFile, `${process.platform}-${process.arch}`).then((fault) => {
        if (settled) return;
        if (fault) return fail('protocol', fault);
        const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true });
        const decoder = new FrameDecoder();
        const limit = setTimeout(() => {
          child.kill();
          fail('timed-out', 'the visit did not end');
        }, HARD_LIMIT_MS);
        const end = (): void => {
          clearTimeout(limit);
          child.stdin.end();
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
            else if (state === 'visited') {
              end();
              return finish({ ok: true, said: text(v['said'], SAID_MAX) });
            } else if (state === 'ended') {
              const cause = text(v['cause'], 32);
              end();
              return finish({ ok: false, cause: CAUSES.includes(cause) ? cause : 'protocol', detail: text(v['detail'], 300) });
            } else {
              child.kill();
              return fail('protocol', 'said a state that does not exist');
            }
          }
        });
        // The password leaves main here and nowhere else, on this one process's standard input.
        child.stdin.write(encodeFrame(T.Aim, Buffer.from(JSON.stringify({ v: 1, role: 'firstvisit', box: { addr: box.addr, user: box.user, hostKey: box.hostKey }, password, command }))));
      });
    });
}
