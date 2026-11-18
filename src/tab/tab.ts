// The tab's view: its terminal, its own file browser on the box's files, and where its link stands. It talks to main through the few functions of tabPort and to nothing else.
import { COPY_MAX, SAVE_MAX, type TabInfo, type TabPort } from '../common/ipc';
import { painted, watchView } from '../common/meter-view';
import { ending } from '../common/link-words';
import { forBox } from '../common/paste';
import { Blocks } from './blocks';
import { drawChrome, folded, type Chrome } from './chrome';
import { glyph, makeAsker, startFiles } from './files';
import { startViewer } from './viewer';
import { clock } from './states';
import { openTerminal, type Term } from './term';

declare global {
  interface Window {
    tabPort: TabPort;
    berthTerm: Term & { policyFaults(): string[]; pace(): { front: boolean; share: number; rested: number; taken: number; waiting: number } }; // read by the lab's self-test, which runs in main
    // The shape this pane draws for a name, read by the lab's self-test. A glyph name the pane does not know
    // is not an error anywhere: it quietly draws the question mark. The probe that sweeps every menu for one
    // asks here what the pane draws when it does not know a name, rather than holding a copy of that shape,
    // which would pass the day the shape changed.
    berthGlyphPath: (name: string) => string;
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
window.berthGlyphPath = (name) => glyph(name).querySelector('path')?.getAttribute('d') ?? '';
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
    readShape();
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

// Ctrl+Shift+A: the whole terminal, selected and copied. The press never reaches this page as a key: main
// answers it and says so here, so a box can neither see it nor make it happen.
port.onWhole(() => {
  const all = term.takeAll();
  if (all === '') {
    term.note('Berth: there is nothing in this terminal to copy');
    return;
  }
  port.copy(all.slice(0, COPY_MAX));
  term.note(`Berth: the whole terminal is copied, ${all.split('\n').length} lines`);
});

// Ctrl+Shift+S: the whole terminal into a file. The page hands over the text and nothing else; where the
// file goes is main's to ask and his to answer, because a page may never name a file (plan B2.7).
port.onSaveAsk(() => {
  const all = term.whole();
  if (all === '') {
    term.note('Berth: there is nothing in this terminal to save');
    return;
  }
  port.save(all.slice(0, SAVE_MAX), 'this terminal');
});

// Reading this box's prompt, and from it whether something is running in this tab. It is a reading aid: the
// lines come from the terminal's own buffer after the box's bytes have been drawn, and nothing any safety
// question depends on is decided from them (plan A5, B3). What it is for is the marks on a tab that is not in
// front, and the one notification when something long finishes.
const blocks = new Blocks();
let seenRow = 0;
let saidDoing = '';
// The blocks drawn so far, by the number of the prompt they belong to, and how to take each one off again.
// A prompt is drawn once: one redrawn as he types is the same block, not another one. The number is the
// mark's own and never a row, because rows move under everything once the terminal is full and starts
// forgetting its oldest lines.
const drawn = new Map<number, { off(): void; rowNow(): number }>();
let hue = '';
let blocksFault = ''; // what stopped a block being drawn, if anything: the lab reads it
let copied = ''; // what the last press on a block's copy did, for the lab
const drawBlocks = (): void => {
  if (hue === '') return; // no box, no colour of its own: nothing to draw a block in
  try {
    drawBlocksNow();
  } catch (err) {
    // Drawing a block is a reading aid. It runs inside the path that takes a box's output, and a reading
    // aid must never be the thing that stops a terminal from drawing what the box said.
    blocksFault = err instanceof Error ? err.message : String(err);
    document.documentElement.dataset['blocks'] = blocksFault;
  }
};
const drawBlocksNow = (): void => {
  for (const m of blocks.marks) {
    if (drawn.has(m.id)) continue;
    // What this block printed is read when the press happens, not now: the command may still be running,
    // and the rows under it are the box's to fill until its prompt comes back.
    const block = term.blockAt(m.row, m.width, hue, (toFile) => {
      // Where this block and the next one are now, not where they were when they were drawn: once the
      // scrollback is full the oldest lines go and every row below them means a different line, so the
      // numbers they were made with would have copied somebody else's output.
      const from = drawn.get(m.id)?.rowNow() ?? m.row;
      const next = blocks.marks.find((x) => x.id > m.id);
      const until = next ? (drawn.get(next.id)?.rowNow() ?? next.row) : term.rows();
      const text = from < 0 || (until >= 0 && until <= from) ? '' : term.outputAfter(from, until < 0 ? term.rows() : until);
      // A press that did nothing says so, in Berth's own line: a button that looks as if it worked when it
      // did nothing is the silence this app is built not to have.
      if (text === '') term.note(`Berth: that command printed nothing, so nothing was ${toFile ? 'saved' : 'copied'}`);
      else if (toFile) port.save(text.slice(0, SAVE_MAX), 'what one command printed');
      else port.copy(text.slice(0, COPY_MAX));
      copied = text === '' ? 'nothing' : toFile ? 'saving' : 'copied';
      document.documentElement.dataset['copied'] = copied;
    });
    if (block) drawn.set(m.id, block);
  }
  // What the reading no longer holds is taken off, oldest first: a decoration is a thing on a screen, and
  // the ones belonging to commands long scrolled away are not worth keeping.
  const oldest = blocks.marks[0]?.id ?? 0;
  for (const [id, block] of [...drawn]) {
    if (id >= oldest) continue;
    block.off();
    drawn.delete(id);
  }
};

// The whole of the reading, guarded. Only the drawing was: the reading of the buffer, the prompt matching
// and the word to main were not, and all three run inside the path that takes a box's output. A reading aid
// may never be the thing that stops a terminal from drawing what a box said (plan A5, B3), and "I found
// nothing in them that throws today" is not the same as a guard.
const readShape = (): void => {
  try {
    readShapeNow();
  } catch (err) {
    shapeFault = err instanceof Error ? err.message : String(err);
    document.documentElement.dataset['shape'] = shapeFault;
  }
};
let shapeFault = '';

const readShapeNow = (): void => {
  const got = term.since(seenRow);
  seenRow = got.next;
  for (const [i, l] of got.lines.entries()) blocks.sawLine(l.text, l.atCursor, got.next - (got.lines.length - 1 - i));
  drawBlocks();
  const done = blocks.takeFinished();
  // Main is told only when it changes, and the finished command's length is a number and nothing else: what
  // was typed is his own text and never leaves this view (plan B2.7).
  if (done) port.doing(blocks.doing, done.ms);
  else if (blocks.doing !== saidDoing) port.doing(blocks.doing, 0);
  saidDoing = blocks.doing;
};

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
// The tab's file browser, on its own channel to the box. It is asked for a folder once the link is up: before
// that there is nothing to ask.
const asker = makeAsker(port);
const viewer = startViewer(document.body, port, asker);
const files = startFiles(document.getElementById('files') as HTMLDivElement, port, asker, (p, n, b) => viewer.open(p, n, b));
let askedFor = '';

port.onState((info) => {
  // The terminal is framed in its box's colour, so which box you are typing into is visible without reading a
  // tab label: the tabs already carry that colour and the terminal did not, which the design always said it
  // should (the owner, 2026-11-17). The frame goes quiet when the session is not up, so a dead tab does not wear
  // the same colour as a live one.
  const live = info.box !== null && ['connecting', 'key-exchange', 'signing-in', 'up'].includes(info.link.phase);
  document.documentElement.style.setProperty('--hue', info.box ? `var(--box-${info.box.colour})` : 'var(--line)');
  // The same colour, read back as the six digits a terminal decoration needs: the stylesheet is where a
  // box's colours are written down, once, and this reads them from it rather than holding a second copy.
  if (info.box) {
    const read = getComputedStyle(document.documentElement).getPropertyValue(`--box-${info.box.colour}`).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(read)) hue = read;
  }
  document.documentElement.dataset['live'] = live ? 'yes' : 'no';
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
  // The file browser opens on the tab's own place once the link is up, and only once: moving about afterwards
  // is the person's, not the window's. A tab with no place of its own starts where the account's home is,
  // which the box works out itself from ".".
  if (live && info.link.phase === 'up' && askedFor === '') {
    // The tab's own folder: the place's, or the box's starting folder, or the account's home, which the box
    // works out itself from ".". The shell started there too, so the two begin together.
    askedFor = info.box?.folder ? info.box.folder : '.';
    files.open(askedFor);
    // What has been in this disk's trash longer than the box keeps things goes now, once per tab, as the plan
    // says (B2.5, entry 4). It is the one thing Berth does on a box without being asked, it touches nothing
    // but its own trash, and what it took is said on the pane rather than done in silence.
    files.emptyOldTrash();
  }
  // The end of a link is also written where it happened, in the terminal, in Berth's own words.
  if (info.box && info.link.phase === 'ended' && now !== last) term.note(`Berth: the link is gone: ${ending(info.link.cause).said} at ${clock(Date.now())}`);
  // A keeps-running place whose shell ended at once with the status a shell gives a command it could not
  // find: the box has no tmux. Said as that, once, because "the shell ended" tells him nothing he can act on.
  if (info.box?.keepsRunning && info.link.phase === 'ended' && info.link.exitStatus === 127 && now !== last) {
    term.note(`Berth: this box has no tmux, so ${info.box.place} cannot keep running. Take the tick off the place, or install tmux on the box.`);
  }
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

// The grip between the two panes. How much room the files take is this tab's own, as its list size is, and it
// is held to a share of the window rather than a number of pixels, so a window made narrow cannot leave the
// terminal a sliver nothing can be read in. It answers the keyboard as well as the hand: a thing that can
// only be dragged is a thing nobody with a keyboard can move at all (BUILD-RULES 2.16).
{
  const grip = document.getElementById('grip') as HTMLDivElement;
  const split = document.getElementById('split') as HTMLDivElement;
  const LEAST = 0.14; // of the window across
  const MOST = 0.62;
  let share = 0;
  const put = (to: number): void => {
    share = Math.min(MOST, Math.max(LEAST, to));
    split.style.setProperty('--files-w', `${(share * 100).toFixed(2)}%`);
    grip.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  };
  const shareNow = (): number => {
    const whole = split.getBoundingClientRect().width;
    const files = document.getElementById('files-pane')!.getBoundingClientRect().width;
    return whole > 0 ? files / whole : 0.24;
  };
  grip.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    try { grip.setPointerCapture(e.pointerId); } catch { /* a pointer the window no longer has: the move still follows it */ }
    grip.dataset['held'] = 'yes';
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e: PointerEvent) => {
    if (!grip.dataset['held']) return;
    const box = split.getBoundingClientRect();
    if (box.width > 0) put((e.clientX - box.left) / box.width);
  });
  const letGo = (e: PointerEvent): void => {
    if (!grip.dataset['held']) return;
    delete grip.dataset['held'];
    try { grip.releasePointerCapture(e.pointerId); } catch { /* it was already let go */ }
  };
  grip.addEventListener('pointerup', letGo);
  grip.addEventListener('pointercancel', letGo);
  // Back where a tab starts, which is the way out of any corner it has been dragged into. Both ways out go
  // through here: taking the property off and leaving the share the grip was holding meant the next arrow key
  // stepped from the corner it had just left and landed straight back in it.
  const putBack = (): void => {
    split.style.removeProperty('--files-w');
    share = 0;
    grip.setAttribute('aria-valuenow', String(Math.round(shareNow() * 100)));
  };
  grip.addEventListener('dblclick', putBack);
  grip.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') put((share || shareNow()) - step);
    else if (e.key === 'ArrowRight') put((share || shareNow()) + step);
    else if (e.key === 'Home') put(LEAST);
    else if (e.key === 'End') put(MOST);
    else if (e.key === 'Enter' || e.key === ' ') putBack();
    else return;
    e.preventDefault();
  });
  grip.setAttribute('aria-valuemin', String(Math.round(LEAST * 100)));
  grip.setAttribute('aria-valuemax', String(Math.round(MOST * 100)));
  // Where it stands at rest, said once the panes have a width: a separator that announces nothing until it is
  // first moved tells a screen reader nothing about the window it is sitting in.
  requestAnimationFrame(() => grip.setAttribute('aria-valuenow', String(Math.round(shareNow() * 100))));
}

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
