// The view's half of the meter: it watches itself with the browser engine's own records and reports numbers,
// nothing else. No text, no keys, no content ever goes through here.
//   long task: the longest single stretch the page was busy (the engine's "longtask" record)
//   reaction:  the longest time from a real click or key reaching the page to the next painted frame
//              (the engine's "event" record; anything under 16 ms is not recorded and counts as 0).
//              Only clicks and keys count (REACTION_KINDS): the pointer passing over a view is not a press.
import { REACTION_KINDS, type ViewNumbers } from './ipc';

export function watchView(port: { meter(n: ViewNumbers): void; frame(): void }): void {
  let longTaskMs = 0;
  let reactionMs = 0;
  let reactionKind = 0;
  let reactionWaitMs = 0;
  let reactionHandlerMs = 0;
  let changed = false;
  const watch = (type: string, take: (ms: number, entry: PerformanceEntry) => void, extra: object = {}) => {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) take(entry.duration, entry);
      }).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    } catch {
      /* a record this engine does not offer is simply not reported */
    }
  };
  watch('longtask', (ms) => {
    if (ms > longTaskMs) {
      longTaskMs = ms;
      changed = true;
    }
  });
  watch(
    'event',
    (ms, entry) => {
      const e = entry as PerformanceEventTiming;
      const kind = (REACTION_KINDS as readonly string[]).indexOf(e.name);
      if (kind >= 0 && ms > reactionMs) {
        reactionMs = ms;
        reactionKind = kind;
        reactionWaitMs = Math.max(0, e.processingStart - e.startTime);
        reactionHandlerMs = Math.max(0, e.processingEnd - e.processingStart);
        changed = true;
      }
    },
    { durationThreshold: 16 },
  );
  setInterval(() => {
    if (!changed) return;
    port.meter({ longTaskMs: Math.round(longTaskMs), reactionMs: Math.round(reactionMs), reactionKind, reactionWaitMs: Math.round(reactionWaitMs), reactionHandlerMs: Math.round(reactionHandlerMs) });
    longTaskMs = 0;
    reactionMs = 0;
    reactionKind = 0;
    reactionWaitMs = 0;
    reactionHandlerMs = 0;
    changed = false;
  }, 500);
  painted(port);
}

// Tells main once the next frame has really been painted (two animation frames: the first is before the paint).
export function painted(port: { frame(): void }): void {
  requestAnimationFrame(() => requestAnimationFrame(() => port.frame()));
}
