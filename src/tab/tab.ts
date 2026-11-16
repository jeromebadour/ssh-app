// The tab's view: its terminal, and where its link stands, as the approved pictures show it (the file panel
// comes with step 3). It talks to main through the few functions of tabPort and to nothing else.
import type { TabInfo, TabPort } from '../common/ipc';
import { painted, watchView } from '../common/meter-view';
import { ending } from '../common/link-words';
import { forBox } from '../common/paste';
import { drawChrome, folded, type Chrome } from './chrome';
import { clock } from './states';
import { openTerminal, type Term } from './term';

declare global {
  interface Window {
    tabPort: TabPort;
    berthTerm: Term & { policyFaults(): string[]; pace(): { front: boolean; share: number; rested: number; taken: number; waiting: number } }; // read by the lab's self-test, which runs in main
  }
}

// Anything this page's content policy refuses is counted, from the first line: there must be none.
const policyFaults: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => void policyFaults.push(`${e.effectiveDirective} at line ${e.lineNumber}, column ${e.columnNumber}`));

const port = window.tabPort;
const state = document.getElementById('state') as HTMLDivElement;
const host = document.getElementById('term') as HTMLDivElement;
const chromeAt = document.getElementById('chrome') as HTMLDivElement;
const signInAt = document.getElementById('signin-at') as HTMLDivElement;

const term = openTerminal(host, {
  typed: (bytes) => {
    // Typed bytes go out in pieces main will take.
    for (let at = 0; at < bytes.byteLength; at += 32 * 1024) port.send(bytes.subarray(at, at + 32 * 1024));
  },
  selected: (text) => port.copy(text),
  link: (url) => port.link(url),
});
window.berthTerm = { ...term, policyFaults: () => policyFaults.slice(0, 20), pace: () => ({ front, share, rested, taken: total, waiting: waiting.length }) };

// Output goes to the terminal one piece after another, and is counted as taken once the terminal has worked
// through it: the box sends on only then, so what waits here is never more than the fixed amount a box may be
// ahead (512 KiB).
//
// The tab in front works through output as fast as it can. So does a tab behind, shown or not, with one
// exception: when the PC is out of processor time, main tells the tabs behind a share, and a tab behind then
// rests after each piece for as long as keeps its work to that share. The tab in front never rests.
let total = 0;
let front = true;
let share = 1;
let rested = 0; // how often this tab rested, for the lab
const waiting: Uint8Array[] = [];
let feeding = false;
let ack = 0;
const taken = (n: number): void => {
  total += n;
  // Told to main a few times a frame at most, not once a piece: the count is cumulative, so nothing is lost.
  if (ack === 0) ack = window.setTimeout(() => { ack = 0; port.taken(total); }, 8);
};
const feed = (): void => {
  const bytes = waiting.shift();
  if (!bytes) {
    feeding = false;
    return;
  }
  feeding = true;
  const began = performance.now();
  term.write(bytes, () => {
    taken(bytes.byteLength);
    const rest = front || share >= 1 ? 0 : Math.min(250, (performance.now() - began) * (1 / share - 1));
    if (rest < 1) return feed();
    rested++;
    setTimeout(feed, rest);
  });
};
port.onOutput((bytes) => {
  waiting.push(bytes);
  if (!feeding) feed();
});
port.onPace((now) => { share = now; });

// The box's sign-in text, before anything else it prints. It is words, not a program's output: nothing in it
// is obeyed or answered. It is folded into one line at the top, and written into the terminal when that line
// is opened, so nothing a box said is lost and nothing it said is drawn before it is asked for.
const decoder = new TextDecoder();
let signInText = '';
port.onBanner((bytes) => {
  signInText += decoder.decode(bytes, { stream: true });
  chrome.signIn = folded(signInText);
  draw();
});

const words = (info: TabInfo): string => {
  const l = info.link;
  if (!info.box) return info.cause ? `${info.state}: ${info.cause}` : info.state;
  if (info.state === 'not-answering') return 'this tab\'s engine is not answering';
  switch (l.phase) {
    case 'up':
      return l.silentSinceMs > 0 ? 'no answer: the link is kept' : l.waitingOnWindow ? 'connected: the box is waiting on this window' : 'connected';
    case 'ended':
      return `ended: ${l.cause.replace(/-/g, ' ')}${l.endedIn && l.endedIn !== 'up' ? ` (while ${l.endedIn.replace(/-/g, ' ')})` : ''}`;
    case 'none':
      return info.state === 'gone' ? `gone: ${info.cause}` : 'starting';
    default:
      return l.phase.replace(/-/g, ' ');
  }
};
// What the view draws around the terminal (chrome.tsx), and when each phase was first seen here, so the times
// in the opening stages are ones this window can vouch for.
const chrome: Chrome = {
  info: null,
  since: {},
  endedAt: 0,
  againIn: 0,
  signIn: null,
  signInOpen: false,
  onReconnect: () => port.reopen(true),
  onCancel: () => port.reopen(false),
  onOpenSignIn: (open) => {
    chrome.signInOpen = open;
    if (open && signInText !== '') term.words(`${signInText.replace(/\n*$/, '')}\n`);
    draw();
  },
};
const draw = (): void => drawChrome(chromeAt, signInAt, chrome);

let last = '';
port.onState((info) => {
  const now = words(info);
  state.textContent = now;
  state.dataset['phase'] = info.box ? info.link.phase : info.state;
  if (info.box) state.dataset['box'] = '';
  else delete state.dataset['box'];
  if (now === 'connected') delete state.dataset['held'];
  else state.dataset['held'] = '';
  if (chrome.since[info.link.phase] === undefined) chrome.since[info.link.phase] = performance.now();
  if (info.link.phase === 'ended' && chrome.endedAt === 0) chrome.endedAt = Date.now();
  chrome.againIn = info.againAt;
  chrome.info = info;
  draw();
  // The end of a link is also written where it happened, in the terminal, in Berth's own words.
  if (info.box && info.link.phase === 'ended' && now !== last) term.note(`Berth: the link is gone: ${ending(info.link.cause).said} at ${clock(Date.now())}`);
  if (info.link.droppedBytes > 0 && now !== last) term.note(`Berth: ${info.link.droppedBytes} typed bytes could not be kept for the box`);
  last = now;
});

// A new session on the same box: said in the terminal, where the old one's output still stands, and the
// stages start again from nothing.
port.onAgain(() => {
  term.note(`Berth: a new session on ${chrome.info?.box?.name ?? 'the box'}${chrome.info?.box?.place ? `, ${chrome.info.box.place}` : ''}`);
  chrome.since = {};
  chrome.endedAt = 0;
  chrome.signIn = null;
  chrome.signInOpen = false;
  signInText = '';
  told = '';
  draw();
});

// A paste, from main, which read the clipboard for a key or a click it saw itself. It goes to the box the way
// a paste should: inside the markers if the box asked to be told where a paste begins and ends, as it is if
// not. Nothing of it is drawn here first: the box's own shell echoes it, as it does for anything typed.
port.onPaste((text) => {
  const bytes = new TextEncoder().encode(forBox(text, term.bracketedPaste()));
  for (let at = 0; at < bytes.byteLength; at += 32 * 1024) port.send(bytes.subarray(at, at + 32 * 1024));
});
// Whether the box has asked to be told where a paste begins: main needs it to say so before sending one.
let saidMode = false;
setInterval(() => {
  const now = term.bracketedPaste();
  if (now === saidMode) return;
  saidMode = now;
  port.pasteMode(now);
}, 250);

// While a bar is showing, R alone asks for a new session: the key cannot reach the box (the link is gone), or
// is being kept for a link that may never come back. Both bars say so on their button. Every other key, and R
// with any other key held, goes to the terminal as always.
window.addEventListener('keydown', (e) => {
  const bar = chrome.info && chrome.info.box && (chrome.info.link.phase === 'ended' || (chrome.info.link.phase === 'up' && chrome.info.link.silentSinceMs > 0));
  if (!bar || e.key !== 'r' && e.key !== 'R') return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  port.reopen(true);
}, true);

// The terminal is as large as the view, in whole cells, and the box is told its size.
// It is told once the typeface is there (a cell has no true size before), and after that only when it changes.
let told = '';
let ready = false;
const refit = (): void => {
  if (!ready) return;
  term.fit();
  const { cols, rows } = term.size();
  if (told === `${cols}x${rows}`) return;
  told = `${cols}x${rows}`;
  port.resize(cols, rows);
};
new ResizeObserver(refit).observe(host);
void term.ready.then(() => {
  ready = true;
  refit();
  term.focus();
});

watchView(port);
port.onShown((now) => {
  front = now;
  if (!front) return;
  refit();
  term.focus();
  painted(port);
});
