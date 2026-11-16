// What a link's ending is called, in one place: the tab's bar says it in full, the tab's terminal writes it
// where it happened, and the window's status line says it short. One ending, one wording, everywhere.
// None of these words comes from a box: a box's own words are only ever drawn inside the terminal.

interface Ending {
  said: string; // the full words: "the connection was reset"
  short: string; // the status line's words: "the link was reset"
  meant: string; // what it means for what was running; empty when nothing was running
}

const ENDINGS: Record<string, Ending> = {
  refused: { said: 'the box refused the connection', short: 'the box refused', meant: 'Nothing was signed in to.' },
  unreachable: { said: 'the box could not be reached', short: 'could not be reached', meant: 'Nothing was signed in to.' },
  'timed-out': { said: 'the box did not answer in time', short: 'no answer in time', meant: 'Nothing was signed in to.' },
  'weak-offer': { said: 'the box offered only ways Berth does not use', short: 'the box offered only weak ways', meant: 'Nothing was signed in to, and no key was used.' },
  'identity-changed': { said: 'the box showed another identity than the one pinned', short: 'stopped: another identity', meant: 'Berth stopped before signing in: no key was used and nothing was sent.' },
  'sign-in-failed': { said: 'the box did not accept Berth’s key', short: 'the key was not accepted', meant: 'Nothing was signed in to.' },
  'no-signature': { said: 'Berth could not sign in with this box’s key', short: 'could not sign in', meant: 'Nothing was signed in to.' },
  reset: { said: 'the connection was reset', short: 'the link was reset', meant: 'What was running in this tab ended with it.' },
  'closed-by-box': { said: 'the box closed the connection', short: 'the box closed the link', meant: 'What was running in this tab ended with it.' },
  'silent-too-long': { said: 'the link was silent for ten minutes', short: 'silent for ten minutes', meant: 'What was running in this tab ended with it.' },
  cancelled: { said: 'the tab was closed', short: 'closed', meant: '' },
  protocol: { said: 'the box broke the protocol', short: 'the box broke the protocol', meant: 'What was running in this tab ended with it.' },
  'no-shell': { said: 'the box would not open a shell', short: 'no shell', meant: 'Nothing is running in this tab.' },
  'shell-exited': { said: 'the shell ended', short: 'the shell ended', meant: '' },
};

const UNKNOWN: Ending = { said: 'the link ended', short: 'the link ended', meant: 'What was running in this tab ended with it.' };

export function ending(cause: string): Ending {
  return ENDINGS[cause] ?? UNKNOWN;
}
