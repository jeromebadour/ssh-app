// The lock on the app (plan B2.4): where it stands, and the two things the password screen may ask for. Nothing
// else in the app works until this says "unlocked". The password passes through here once, as bytes, on its
// way to the key process, and is overwritten here as soon as it has been handed on.
import { access, constants, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PASSWORD_MAX_BYTES, PASSWORD_MIN, type GateState } from '../common/ipc';
import { PW, type KeyProc, type KeyReply } from './keyproc';

export class Gate {
  state: GateState = { phase: 'starting', wrong: false, waitMs: 0, backupDir: '', backupOk: false, detail: '', hasPrevious: false };
  backup = ''; // after unlock: what became of the last backup ('none', 'written', 'failed')
  private waitUntil = 0;

  constructor(
    private readonly keys: KeyProc,
    private readonly tell: () => void,
    defaultBackupDir: string,
    // Told once the list is open, with what the key process opened: the boxes' part, and what is known of the keys.
    private readonly opened: (publicPart: unknown, keyInfos: unknown) => void = () => undefined,
  ) {
    this.state.backupDir = defaultBackupDir;
  }

  get unlocked(): boolean {
    return this.state.phase === 'unlocked';
  }

  // What the shell view is told: the same state, with the wait counted from now.
  view(): GateState {
    return { ...this.state, waitMs: Math.max(0, this.waitUntil - Date.now()) };
  }

  // Called when the key process is up, and whenever its state changes.
  async keysChanged(): Promise<void> {
    if (this.keys.state === 'gone') return this.set({ phase: 'fault', detail: `the key process ended: ${this.keys.cause}` });
    if (this.keys.state !== 'ready' || this.state.phase !== 'starting') return;
    const s = await this.keys.request('status');
    if (!s.ok) return this.set({ phase: 'fault', detail: String(s.detail ?? s.error ?? 'no answer') });
    if (s['exists'] === true) return this.set({ phase: 'locked', hasPrevious: s['hasPrevious'] === true });
    await this.checkBackupDir();
    this.set({ phase: 'create' });
  }

  async setBackupDir(dir: string): Promise<void> {
    if (this.state.phase !== 'create') return;
    this.state.backupDir = dir;
    await this.checkBackupDir();
    this.tell();
  }

  // Can the folder be written to? Nothing is made by asking: the folder itself, or the nearest folder above it
  // that exists, must be writable. The folder is made when the password is.
  private async checkBackupDir(): Promise<void> {
    let dir = this.state.backupDir;
    this.state.backupOk = false;
    for (let up = 0; up < 64 && path.isAbsolute(dir); up++) {
      try {
        await access(dir, constants.W_OK);
        this.state.backupOk = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(dir) === dir) return;
        dir = path.dirname(dir);
      }
    }
  }

  // The first password. Checked here as well as in the view and in the key process: three places, one rule.
  async create(password: Uint8Array): Promise<void> {
    if (this.state.phase !== 'create' || !usable(password) || !this.state.backupOk) return wipe(password);
    this.set({ phase: 'working', wrong: false });
    const made = await this.keys.password(PW.create, password);
    wipe(password);
    if (!made.ok) return this.failed(made, 'create');
    this.opened(made['public'], made['keys']);
    const folder = await mkdir(this.state.backupDir, { recursive: true }).then(() => '', (err: Error) => err.message);
    const set = folder === '' ? await this.keys.request('setBackupDir', { dir: this.state.backupDir }) : { ok: false, detail: folder };
    this.backup = set.ok ? String((set as KeyReply)['backup'] ?? '') : 'failed';
    this.set({ phase: 'unlocked', detail: set.ok ? '' : `the backup folder was not saved: ${String(set.detail ?? '')}` });
  }

  async unlock(password: Uint8Array): Promise<void> {
    if (this.state.phase !== 'locked' || !(password instanceof Uint8Array) || password.byteLength === 0 || password.byteLength > PASSWORD_MAX_BYTES || Date.now() < this.waitUntil) return wipe(password);
    this.set({ phase: 'working', wrong: false });
    const opened = await this.keys.password(PW.unlock, password);
    wipe(password);
    if (!opened.ok) return this.failed(opened, 'locked');
    this.opened(opened['public'], opened['keys']);
    this.set({ phase: 'unlocked', backupDir: String(opened['backupDir'] ?? '') });
  }

  private failed(r: KeyReply, back: 'create' | 'locked'): void {
    const wait = typeof r['retryAfterMs'] === 'number' ? r['retryAfterMs'] : 0;
    this.waitUntil = Date.now() + wait;
    switch (r.error) {
      case 'wrong-password':
      case 'wait':
        return this.set({ phase: 'locked', wrong: true });
      case 'damaged':
      case 'not-a-list':
      case 'newer-version':
      case 'cost-out-of-range':
        return this.set({ phase: 'damaged', detail: r.error, hasPrevious: r['hasPrevious'] === true });
      case 'gone':
        return this.set({ phase: 'fault', detail: `the key process ended: ${String(r.detail ?? '')}` });
      default:
        return this.set({ phase: back, detail: String(r.detail ?? r.error ?? 'refused') });
    }
  }

  private set(change: Partial<GateState>): void {
    this.state = { ...this.state, detail: '', ...change };
    this.tell();
  }
}

function usable(password: unknown): password is Uint8Array {
  return password instanceof Uint8Array && password.byteLength >= PASSWORD_MIN && password.byteLength <= PASSWORD_MAX_BYTES;
}

function wipe(password: unknown): void {
  if (password instanceof Uint8Array) password.fill(0);
}
