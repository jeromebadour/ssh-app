// When a tab may open a new session by itself, and when it may not. It is a rule, not a timer, so it lives
// here on its own and is tested as what it is.
//
// A tab opens a new session by itself only after an ending that could go otherwise next time: the box was
// restarted, the connection was reset, the network went. It never does it after an ending that says the same
// thing would happen again (a changed identity, a refused key), after one the person asked for, or after the
// person pressed Cancel. A word from the box can arrive after that press (its process ending is one), and
// such a word must never start the countdown again behind their back.

// An ending Berth never opens a new session after: the same thing would happen again, or it is the person's
// own doing (plan A3 decision 6, B8).
export const NEVER_AGAIN: readonly string[] = ['identity-changed', 'sign-in-failed', 'no-signature', 'weak-offer', 'cancelled', 'shell-exited'];
// How long the tab waits before it opens one, so a box that is coming back is given the time to come back.
export const AGAIN_AFTER_MS = 5000;

export interface Ending {
  phase: string;
  cause: string;
}

export function mayOpenAgain(link: Ending, againAt: number, cancelled: boolean): boolean {
  if (cancelled) return false; // the person stopped it; only the person starts one now
  if (againAt > 0) return false; // one is already counted down
  if (link.phase !== 'ended') return false;
  return !NEVER_AGAIN.includes(link.cause);
}
