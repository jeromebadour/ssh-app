// The meter: the app measures its own promises while it runs, as numbers only.
// It keeps the worst value seen of each. In step 2 these go to the local log and to About; for now they are
// kept in memory and read by the self-test.
//
//   mainDelayMs   how late a timer in main fired (budget 50 ms): main busy means every tab waits
//   viewTaskMs    the longest single busy stretch in any view (budget 100 ms)
//   reactionMs    the longest time from a real click or key to the next painted frame (budget 100 ms)
//   tabSwitchMs   from the click on a tab to that tab's painted frame (budget 100 ms)
//   startMs       from the process starting to the first painted frame (budget 2000 ms)
export const BUDGET = { mainDelayMs: 50, viewTaskMs: 100, reactionMs: 100, tabSwitchMs: 100, startMs: 2000 } as const;
export type Worst = { -readonly [K in keyof typeof BUDGET]: number };

const TICK_MS = 20;
const SANE_MAX_MS = 10 * 60 * 1000;

export class Meter {
  readonly worst: Worst = { mainDelayMs: 0, viewTaskMs: 0, reactionMs: 0, tabSwitchMs: 0, startMs: 0 };
  private expected = 0;
  private switchStarted = new Map<number, number>();

  start(): void {
    this.expected = performance.now() + TICK_MS;
    setInterval(() => {
      const now = performance.now();
      this.take('mainDelayMs', now - this.expected);
      this.expected = now + TICK_MS;
    }, TICK_MS).unref();
  }

  // Numbers reported by a view. Anything that is not a sane number is ignored: a view is never trusted.
  fromView(n: unknown): boolean {
    const v = n as { longTaskMs?: unknown; reactionMs?: unknown } | null;
    if (!v || !sane(v.longTaskMs) || !sane(v.reactionMs)) return false;
    this.take('viewTaskMs', v.longTaskMs as number);
    this.take('reactionMs', v.reactionMs as number);
    return true;
  }

  firstFrame(): void {
    if (this.worst.startMs === 0) this.worst.startMs = Math.round(process.uptime() * 1000);
  }

  tabSwitchBegins(tabId: number): void {
    this.switchStarted.set(tabId, performance.now());
  }

  tabPainted(tabId: number): void {
    const t0 = this.switchStarted.get(tabId);
    if (t0 === undefined) return;
    this.switchStarted.delete(tabId);
    this.take('tabSwitchMs', performance.now() - t0);
  }

  forget(tabId: number): void {
    this.switchStarted.delete(tabId);
  }

  reset(): void {
    for (const k of Object.keys(this.worst) as (keyof Worst)[]) if (k !== 'startMs') this.worst[k] = 0;
  }

  private take(key: keyof Worst, ms: number): void {
    const v = Math.max(0, Math.round(ms));
    if (v > this.worst[key]) this.worst[key] = v;
  }
}

const sane = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= SANE_MAX_MS;
