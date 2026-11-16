// The tab's view: its terminal, and one line saying where its link stands. (The file panel, and the link states
// as pictured, come next.) It talks to main through the few functions of tabPort and to nothing else.
import type { TabInfo, TabPort } from '../common/ipc';
import { painted, watchView } from '../common/meter-view';
import { openTerminal, type Term } from './term';

declare global {
  interface Window {
    tabPort: TabPort;
    berthTerm: Term & { policyFaults(): string[] }; // read by the lab's self-test, which runs in main
  }
}

// Anything this page's content policy refuses is counted, from the first line: there must be none.
const policyFaults: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => void policyFaults.push(`${e.effectiveDirective} at line ${e.lineNumber}, column ${e.columnNumber}`));

const port = window.tabPort;
const state = document.getElementById('state') as HTMLDivElement;
const host = document.getElementById('term') as HTMLDivElement;

const term = openTerminal(host, {
  typed: (bytes) => {
    // Typed bytes go out in pieces main will take.
    for (let at = 0; at < bytes.byteLength; at += 32 * 1024) port.send(bytes.subarray(at, at + 32 * 1024));
  },
  selected: (text) => port.copy(text),
});
window.berthTerm = { ...term, policyFaults: () => policyFaults.slice(0, 20) };

// Output is counted as taken once the terminal has worked through it: the box sends on only then.
let total = 0;
port.onOutput((bytes) => {
  const n = bytes.byteLength;
  term.write(bytes, () => {
    total += n;
    port.taken(total);
  });
});

// The box's sign-in text, before anything else it prints. It is words, not a program's output: it is drawn
// as words, and nothing in it is obeyed or answered.
const banner = new TextDecoder();
port.onBanner((bytes) => term.words(banner.decode(bytes, { stream: true })));

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
let last = '';
port.onState((info) => {
  const now = words(info);
  state.textContent = now;
  state.dataset['phase'] = info.box ? info.link.phase : info.state;
  if (now === 'connected') delete state.dataset['held'];
  else state.dataset['held'] = '';
  // The end of a link is also written where it happened, in the terminal, in Berth's own words.
  if (info.box && info.link.phase === 'ended' && now !== last) term.note(`Berth: the link ${now}`);
  if (info.link.droppedBytes > 0 && now !== last) term.note(`Berth: ${info.link.droppedBytes} typed bytes could not be kept for the box`);
  last = now;
});

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
port.onShown(() => {
  refit();
  term.focus();
  painted(port);
});
