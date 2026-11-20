// The tab's terminal: the terminal library with Berth's limits around it (plan B3).
//   - What a box prints is drawn; what a box may not do through it, and the few fixed answers it may get, are
//     in guards.ts.
//   - Paste is not the library's: its own paste, and text dropped onto it, are switched off here. Paste is
//     main's work, from a key or a click it saw itself.
//   - Output is counted as taken only once the terminal has worked through it, so a box sends ahead of the
//     window by a fixed amount at most.
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { guard } from './guards';

// The library gives its cell sizes and colours as <style> elements made at run time, which this page's content
// policy refuses (no inline styles, on purpose). Each is given a stylesheet object instead: the same rules,
// applied by script, with the policy left as strict as it is. The self-test fails on any refusal by the policy.
function stylesWithoutInline(): void {
  const make = document.createElement.bind(document) as (tag: string, o?: ElementCreationOptions) => HTMLElement;
  document.createElement = ((tag: string, o?: ElementCreationOptions) => {
    if (tag.toLowerCase() !== 'style') return make(tag, o);
    // In the <style>'s place goes an element that holds nothing and shows nothing; its rules live in the sheet.
    const el = make('span');
    el.hidden = true;
    const sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    Object.defineProperty(el, 'textContent', { configurable: true, get: () => '', set: (css: string) => sheet.replaceSync(String(css)) });
    Object.defineProperty(el, 'sheet', { configurable: true, get: () => sheet });
    const remove = el.remove.bind(el);
    el.remove = () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      remove();
    };
    return el;
  }) as typeof document.createElement;
}

// Berth's colours for what a box prints in colour: muted, the hue carrying the meaning (direction A).
const THEME = {
  background: '#141b21',
  foreground: '#bcc5cc',
  cursor: '#86a6c2',
  cursorAccent: '#141b21',
  selectionBackground: '#33485a',
  selectionInactiveBackground: '#2a3844',
  black: '#1f2932',
  red: '#b86a5f',
  green: '#79a373',
  yellow: '#cc9b47',
  blue: '#6e92b6',
  magenta: '#a397c0',
  cyan: '#5a9a8c',
  white: '#bcc5cc',
  brightBlack: '#808d99',
  brightRed: '#c98678',
  brightGreen: '#93b98c',
  brightYellow: '#d9b26a',
  brightBlue: '#86a6c2',
  brightMagenta: '#b8aed0',
  brightCyan: '#7bb3a6',
  brightWhite: '#dfe5ea',
};

// Words to draw as words. No control character reaches the terminal (the escape character with them, so
// nothing in the text can be obeyed or answered); each is drawn as its picture instead, so nothing a box said is
// dropped unseen. The marks that turn the reading direction round are drawn as the unknown-character mark.
// Line ends and tabs are kept; a line end is made the terminal's own.
export function inert(text: string): string {
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n') out += '\r\n';
    else if (ch === '\t') out += ch;
    else if (c < 0x20) out += String.fromCodePoint(0x2400 + c);
    else if (c === 0x7f) out += String.fromCodePoint(0x2421);
    else if (c >= 0x80 && c <= 0x9f) out += String.fromCodePoint(0xfffd);
    else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0x061c) out += String.fromCodePoint(0xfffd);
    else out += ch;
  }
  return out;
}

// What a press on a block is asking for.
export type BlockWanted = 'output' | 'output-to-file' | 'command' | 'command-and-output';

export interface Term {
  ready: Promise<void>; // drawn, in its own typeface: a cell has its true size from here on
  write(bytes: Uint8Array, done: () => void): void;
  note(text: string): void; // a line of Berth's own, never a box's
  words(text: string): void; // a box's words that are not a program's output (its sign-in text): drawn, never obeyed
  size(): { cols: number; rows: number };
  fit(): boolean; // true when the size changed
  // How large its letters are, in the same eight steps the file list beside it uses, so the two panes answer
  // the same keys the same way. Returns where it ended up and, when a press changed nothing, which end it is
  // standing at: a press that changes nothing still has to answer (BUILD-RULES 2.18).
  zoom(to: 'in' | 'out' | 'own'): { at: number; end: 'small' | 'large' | 'own' | '' };
  zoomAt(): number;
  focus(): void;
  text(): string; // everything on screen and scrolled out, for the lab
  held(): number; // how many lines the terminal is holding, on screen and scrolled out
  spot(text: string): { x: number; y: number; hand: boolean } | null; // where these words are drawn, and whether the pointer is a hand; for the lab
  links(row: number): string[]; // what the app would treat as an address to open on this row; for the lab
  bracketedPaste(): boolean;
  // Which of the two renderers is drawing: 'webgl' or 'plain'. There is no third answer and no 'we do not
  // know': a terminal that quietly fell back to the plain one is a terminal whose prompt has no colour in it,
  // and that is a thing the window has to be able to say (his rule: nothing ever fails silently).
  drawnBy(): 'webgl' | 'plain';
  // Everything the terminal holds, selected and given back: what Ctrl+Shift+A copies. Ctrl+A is the shell's
  // own and is never taken from him.
  takeAll(): string;
  // The same text, read from the buffer and nothing selected. Selecting is what copies in this app, so the
  // whole terminal on its way to a file must not go through a selection: saving a file is not a press that
  // may quietly take over what is on his clipboard.
  whole(): string;
  // The lines the box has printed since this was last asked, with the one the cursor sits on marked: what
  // reads the shape of a prompt (src/tab/blocks.ts). It is given lines from the terminal's own buffer, where
  // every escape sequence has already been acted on, so nothing reading them has to understand a terminal.
  since(row: number): { lines: { text: string; atCursor: boolean }[]; next: number };
  // One block: the prompt at this row is drawn in the box's own colour, with a line above it, so one command
  // and its output can be told from the next at a glance. It is the thing he said matters most about a
  // terminal (2026-11-15 07:32). Returns a way to take it off again.
  // The press on a block, and what was asked of it: a plain press takes what the command printed to the
  // clipboard and a press with Shift held puts it in a file, as they always have; the three the right
  // button adds are the command on its own, the command with its output under it, and the output into a
  // file. One callback with a word rather than four, because they are four answers to the same question:
  // what of this block do you want.
  // Returns a way to take the block off again, and a way to ask where its row is now. A row number does not
  // stay still: once the scrollback is full the oldest lines are dropped and every row below them means a
  // different line, so a block that kept the number it was made with would copy somebody else's output. The
  // marker drawn with the block follows its own line, and that is what this asks.
  blockAt(row: number, width: number, colour: string, press: (what: BlockWanted) => void): { off(): void; rowNow(): number } | null;
  // What one block printed: the rows after the prompt at this row, up to the next prompt or the end.
  outputAfter(row: number, until: number): string;
  rows(): number; // how many rows the terminal holds, on screen and scrolled out
  lineAt(row: number): string; // one row of what it holds, as a person sees it: the prompt's own row, for the command on it
  // The block the last right press landed on, asked for one of the four things a block can give. False when
  // that press was not on a block at all, or the block it was on has gone since.
  blockPressed(what: BlockWanted): boolean;
  hasSelection(): boolean; // something is selected in it right now
  selection(): string; // what is selected in it right now, for the clipboard
  clear(): void; // everything it holds, on screen and scrolled out, goes
  // The last right press on this terminal, and whether it asked for a menu rather than a paste. Main's own
  // `context-menu` event carries no modifier, so when main asks what a press landed on this is the answer:
  // Shift held means the menu, and so does the press landing on a block's mark, whose own menu is about that
  // one command. A press older than a moment is no answer at all, which is why the time is here.
  rightPress(): { at: number; menu: boolean; onBlock: boolean } | null;
  // Finding words in what the box has printed, on screen and scrolled out. It is a read of the terminal's
  // own buffer and nothing else: not one byte goes to the box, which is the rule for every key this app
  // takes (B2.5). Returns which match it landed on and how many there are, because a highlight on its own
  // does not say whether there is another one further up.
  find(what: string, way: 'next' | 'back'): { found: boolean; at: number; of: number };
  findOff(): void; // the highlights and the selection the search made, gone
}

// A web address in a box's output. Only http and https, only as far as a character that cannot be in one, and
// never a trailing character that is almost always the sentence's, not the address's.
const ADDRESS = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

export function openTerminal(host: HTMLElement, out: { typed(bytes: Uint8Array): void; selected(text: string): void; link(url: string): void; bell(): void }): Term {
  stylesWithoutInline();
  const term = new Terminal({
    fontFamily: "'Plex Mono', monospace",
    fontSize: 13.5,
    fontWeight: '400',
    fontWeightBold: '600',
    lineHeight: 1.2,
    cursorBlink: false,
    cursorStyle: 'block',
    scrollback: 30_000,
    theme: THEME,
    // Was false, and is true since 2026-11-17 for one thing only: marking a row and drawing over it, which
    // is how one command and its output are told from the next (B3). It widens what this app may call in
    // the library, not what a box may do through the terminal: that list is in B3 and is unchanged. The
    // library is pinned, so a proposed API changing under us happens at a version bump and not on its own.
    allowProposedApi: true,
    altClickMovesCursor: false, // it would type arrow keys for a click
    rightClickSelectsWord: false,
    // What a double press takes as one word. The library's own default breaks on spaces and brackets and
    // nothing else, and this was measured before it was changed: a double press on the path in
    // demo@lab-box:/srv/ledger$ took the whole of it, prompt and all. On a box what he double-presses is a
    // path, a host, a user or a hash, so the shell's own punctuation breaks a word and the characters that
    // live inside those four do not: the slash, the dot, the dash, the underscore and the plus are left out
    // of this on purpose, or /var/log/syslog, lab-box, a dotted name and a flag would each come apart.
    wordSeparator: ' ()[]{}\'",;:@$=&|<>*?!~^\u0060',
    linkHandler: null,
    windowOptions: {}, // nothing about the window may be asked or set by a box
    screenReaderMode: false,
  });
  // The bell a box rings. The terminal does nothing with it here: it is handed on, and what is said about it
  // is main's, in main's own words, in the one place those words live.
  term.onBell(() => out.bell());
  const encoder = new TextEncoder();
  const send = (text: string): void => out.typed(encoder.encode(text));
  guard(term, send);
  term.onData(send); // keys, and the mouse and focus reports a program on the box asked for
  term.onBinary((data) => out.typed(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
  // The terminal is drawn once its typeface is there: a cell measured in another face has another size, and
  // the box would be told a size that is not the view's. What arrives before is kept and drawn then.
  // Addresses a box prints are found here, by us: the library opens nothing by itself (its own handler is off,
  // and a link hidden behind other words is refused before the library sees it, in guards.ts). A plain click
  // does nothing at all; Ctrl+click asks main, which shows the whole address on the window's own surface.
  const addresses = (row: number): { text: string; at: number }[] => {
    // The row is the window's own, counted from the top of what is shown; the buffer counts from the top of
    // everything, scrolled-out lines included.
    const text = term.buffer.active.getLine(term.buffer.active.viewportY + row - 1)?.translateToString(true) ?? '';
    const found: { text: string; at: number }[] = [];
    for (const m of text.matchAll(ADDRESS)) {
      const url = m[0].replace(TRAILING, '');
      if (url.length >= 11 && url.length <= 2048) found.push({ text: url, at: m.index });
    }
    return found;
  };
  const provider: import('@xterm/xterm').ILinkProvider = {
    provideLinks(row, give) {
      const found = addresses(row).map((a) => ({
        range: { start: { x: a.at + 1, y: row }, end: { x: a.at + a.text.length, y: row } },
        text: a.text,
        activate: (e: MouseEvent, where: string) => {
          if (!e.ctrlKey) return; // a plain click in a terminal is a selection, never an opening
          out.link(where);
        },
      }));
      give(found.length > 0 ? found : undefined);
    },
  };
  term.registerLinkProvider(provider);

  // Which renderer ended up drawing. The plain one ignores a colour set on a decoration, so the prompt's own
  // letters can only be coloured by the WebGL one (his, 2026-11-18 night, after this chat proposed rewriting
  // the bytes a box sent and he refused it). A machine with no WebGL, or one whose context is lost while it
  // runs, falls back to the plain renderer and the window says which it is drawing with.
  let drawnBy: 'webgl' | 'plain' = 'plain';
  // Which renderer is drawing is said in the terminal's own head and never in its output: the output is what
  // the box said, and a line of Berth's own in it is a line he has to tell from the box's. It shows only
  // while the renderer is the plain one, which is the state worth saying.
  const sayPlain = (): void => {
    const said = document.getElementById('term-drawn');
    if (!said) return;
    said.hidden = false;
    said.textContent = 'no graphics renderer';
    said.title = 'This machine has no graphics renderer, so the prompt keeps its shape but not its colour.';
  };
  const wearRenderer = (t: Terminal): 'webgl' | 'plain' => {
    try {
      const gl = new WebglAddon();
      // A context can be taken away at any time: a machine asleep, a driver replaced, too many contexts open.
      // When it goes, the addon is dropped and the terminal keeps drawing with the plain renderer rather than
      // stopping. Nothing is thrown away but the renderer.
      gl.onContextLoss(() => {
        gl.dispose();
        drawnBy = 'plain';
        // Said once, in Berth's own words, because a prompt that quietly stops being coloured is a terminal
        // that has changed under him with nothing saying so.
        sayPlain();
      });
      t.loadAddon(gl);
      return 'webgl';
    } catch {
      return 'plain';
    }
  };

  // Finding words in the scrollback. The addon reads the terminal's own buffer, marks what it finds and says
  // how many it found; nothing is sent to the box. The marks are muted ambers, the hue this app uses for
  // something to look at, with the one he is standing on brighter than the rest.
  const search = new SearchAddon({ highlightLimit: 2000 });
  const FOUND = {
    matchBackground: '#4a3d1c',
    matchBorder: '#6b5a2e',
    matchOverviewRuler: '#6b5a2e',
    activeMatchBackground: '#8a6d2c',
    activeMatchBorder: '#b08f3d',
    activeMatchColorOverviewRuler: '#b08f3d',
  };
  let foundAt = -1;
  let foundOf = 0;
  search.onDidChangeResults((r) => {
    foundAt = r.resultIndex;
    foundOf = r.resultCount;
  });

  const FACE = "13.5px 'Plex Mono'";
  const ready = Promise.all([document.fonts.load(FACE), document.fonts.load(`600 ${FACE}`)]).then(
    () => undefined,
    () => undefined, // a face that will not load is said by the self-test; the terminal still opens
  ).then(() => {
    term.open(host);
    term.loadAddon(search);
    drawnBy = wearRenderer(term);
    // A machine with no graphics renderer at all is said as well, once, at the start: a prompt that is not
    // coloured is a thing he would otherwise put down to Berth not doing what it said it would.
    if (drawnBy === 'plain') sayPlain();
  });

  // A right press on the terminal is remembered, and its default is never prevented, because main must see
  // the same press to decide what it means: a paste is main's alone (plan B2.7, B3). Shift held is what asks
  // for the menu instead, as his reference client does.
  // Which block each mark on the screen belongs to, so a right press on one can be answered about that one
  // command. Keyed by the element the library draws, which is the only thing a press can hand back.
  const blockOfMark = new WeakMap<HTMLElement, (what: BlockWanted) => void>();
  let rightAt: { at: number; menu: boolean; onBlock: boolean; press: ((what: BlockWanted) => void) | null } | null = null;
  host.addEventListener('contextmenu', (e) => {
    const mark = (e.target as HTMLElement | null)?.closest<HTMLElement>('.berth-block-copy') ?? null;
    const press = mark ? blockOfMark.get(mark) ?? null : null;
    // A press on a block's mark asks for that block's menu whether or not Shift was held: the mark is
    // Berth's own, not the box's text, and a paste into the middle of it would mean nothing.
    rightAt = { at: Date.now(), menu: e.shiftKey || press !== null, onBlock: press !== null, press };
  }, true);

  // Paste and drop are not the terminal's to take: main pastes, from a key or click it saw itself.
  for (const type of ['paste', 'drop', 'dragover', 'dragenter'] as const) {
    host.addEventListener(type, (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  }
  host.addEventListener('beforeinput', (e) => {
    const kind = (e as InputEvent).inputType;
    if (kind === 'insertFromPaste' || kind === 'insertFromDrop' || kind === 'insertFromYank') { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // Select to copy: what is selected is offered to main once the selection has settled.
  let settle = 0;
  term.onSelectionChange(() => {
    clearTimeout(settle);
    settle = window.setTimeout(() => {
      const text = term.getSelection();
      if (text !== '') out.selected(text);
    }, 150);
  });

  // The size is the host's, in whole cells. A cell's size is read off the grid the library has drawn.
  const cell = (): { w: number; h: number } | null => {
    const screen = host.querySelector('.xterm-screen')?.getBoundingClientRect();
    return screen && screen.width > 0 && screen.height > 0 ? { w: screen.width / term.cols, h: screen.height / term.rows } : null;
  };
  const fit = (): boolean => {
    const c = cell();
    if (!c) return false;
    const cols = Math.max(20, Math.min(500, Math.floor((host.clientWidth - 14) / c.w)));
    const rows = Math.max(5, Math.min(300, Math.floor(host.clientHeight / c.h)));
    if (cols === term.cols && rows === term.rows) return false;
    term.resize(cols, rows);
    return true;
  };

  // The same eight steps as the file list, around the terminal's own 13.5px. A terminal is read for hours,
  // so the steps are the pane's and not the browser's zoom, which would take the whole view and the list
  // with it.
  const STEPS = [0.75, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
  let stepAt = STEPS.indexOf(1);
  const BASE = 13.5;
  const zoom = (to: 'in' | 'out' | 'own'): { at: number; end: 'small' | 'large' | 'own' | '' } => {
    const want = to === 'own' ? STEPS.indexOf(1) : stepAt + (to === 'in' ? 1 : -1);
    const next = Math.min(STEPS.length - 1, Math.max(0, want));
    const at = Math.round(STEPS[next]! * 100);
    if (next === stepAt) return { at, end: next === 0 ? 'small' : next === STEPS.length - 1 ? 'large' : 'own' };
    stepAt = next;
    term.options.fontSize = Math.round(BASE * STEPS[stepAt]! * 10) / 10;
    return { at, end: '' };
  };

  return {
    ready,
    write: (bytes, done) => term.write(bytes, done),
    zoom,
    zoomAt: () => Math.round(STEPS[stepAt]! * 100),
    // A line of Berth's own always starts a line of its own: a box's output rarely ends at a line's end.
    note: (text) => term.write(`${term.buffer.active.cursorX > 0 ? '\r\n' : ''}\x1b[2m${inert(text).replace(/[\r\n\t]+/g, ' ')}\x1b[0m\r\n`),
    words: (text) => term.write(inert(text)),
    size: () => ({ cols: term.cols, rows: term.rows }),
    fit,
    focus: () => term.focus(),
    held: () => term.buffer.active.length,
    text: () => {
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      return lines.join('\n').replace(/\n+$/, '');
    },
    links: (row) => addresses(row).map((a) => a.text),
    spot: (text) => {
      const b = term.buffer.active;
      const c = cell();
      const screen = host.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!c || !screen) return null;
      for (let row = 0; row < term.rows; row++) {
        const col = (b.getLine(b.viewportY + row)?.translateToString(true) ?? '').indexOf(text);
        if (col >= 0) return { x: Math.round(screen.left + (col + 1.5) * c.w), y: Math.round(screen.top + (row + 0.5) * c.h), hand: !!host.querySelector('.xterm-cursor-pointer') };
      }
      // Not on screen: it may be above or below what is in view, because the terminal stays where it was
      // put rather than jumping about. The words are looked for in the whole of what the terminal holds and
      // brought into view, so that asking where something is drawn answers about the thing and not about
      // where the view happened to be standing.
      for (let i = 0; i < b.length; i++) {
        if ((b.getLine(i)?.translateToString(true) ?? '').indexOf(text) < 0) continue;
        term.scrollToLine(Math.max(0, Math.min(i, b.length - term.rows)));
        return null; // in view at the next frame; whoever asked looks again
      }
      return null;
    },
    hasSelection: () => term.hasSelection(),
    selection: () => term.getSelection(),
    clear: () => {
      // Everything, not only the screen: a terminal cleared with its scrollback still behind it is one he
      // would scroll up into and find the thing he asked to be rid of. The line he is standing on stays,
      // because that is his prompt. The terminal is not reset: a reset would put back the modes the box
      // asked for, and one of those is the bracketed paste a protected paste depends on.
      term.clear();
    },
    lineAt: (row) => {
      const b = term.buffer.active;
      return row < 0 || row >= b.length ? '' : (b.getLine(row)?.translateToString(true) ?? '');
    },
    blockPressed: (what) => {
      const press = rightAt?.press;
      if (!press) return false;
      press(what);
      return true;
    },
    rightPress: () => (rightAt === null ? null : { at: rightAt.at, menu: rightAt.menu, onBlock: rightAt.onBlock }),
    // Nothing to look for is not a search with no results: it is no search, so the marks come off and the
    // count says nothing rather than nought of nought, which reads as "it is not there".
    find: (what: string, way: 'next' | 'back') => {
      if (what === '') { search.clearDecorations(); foundAt = -1; foundOf = 0; return { found: false, at: -1, of: 0 }; }
      const opts = { decorations: FOUND, caseSensitive: false, regex: false, wholeWord: false };
      const found = way === 'next' ? search.findNext(what, opts) : search.findPrevious(what, opts);
      return { found, at: foundAt, of: foundOf };
    },
    findOff: () => {
      search.clearDecorations();
      term.clearSelection();
      foundAt = -1;
      foundOf = 0;
    },
    bracketedPaste: () => term.modes.bracketedPasteMode,
    drawnBy: () => drawnBy,
    takeAll: () => {
      term.selectAll();
      return term.getSelection();
    },
    blockAt: (row, width, colour, press) => {
      // A marker follows its row as the terminal scrolls, which is what makes a decoration stay with the
      // command it belongs to rather than with a place on the screen.
      const b = term.buffer.active;
      const at = row - b.baseY;
      if (at < -b.length || at > term.rows) return null;
      const marker = term.registerMarker(at - b.cursorY);
      if (!marker) return null;
      // Two things are drawn: the prompt in the box's colour, which is what tells a prompt from output, and
      // a hairline above it, which is where one command ends and the next begins.
      const text = term.registerDecoration({ marker, x: 0, width: Math.max(1, Math.min(width, term.cols)), height: 1, foregroundColor: colour });
      const rule = term.registerDecoration({ marker, x: 0, width: term.cols, height: 1, layer: 'bottom' });
      rule?.onRender((el) => {
        el.classList.add('berth-block-line');
        el.style.setProperty('--block-hue', colour);
      });
      // And the one press that copies what this command printed. It sits at the right-hand end of the
      // prompt's own row, where a prompt almost never reaches, and it is the only part of a block a pointer
      // can touch at all: everything else is drawn under the text and lets presses through to it.
      const hand = term.registerDecoration({ marker, anchor: 'right', x: 0, width: 2, height: 1 });
      hand?.onRender((el) => {
        if (el.dataset['berth'] === 'copy') return;
        el.dataset['berth'] = 'copy';
        el.classList.add('berth-block-copy');
        el.title = 'Copy what this command printed. Hold Shift to save it as a file';
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'Copy what this command printed, or hold Shift to save it as a file');
        el.addEventListener('mousedown', (ev) => ev.stopPropagation()); // a press here is not a selection
        blockOfMark.set(el, press);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          press(ev.shiftKey ? 'output-to-file' : 'output');
        });
      });
      return {
        off: () => {
          text?.dispose();
          rule?.dispose();
          hand?.dispose();
          marker.dispose();
        },
        // Where this block's own line is now, as the terminal keeps it. -1 once the line has gone.
        rowNow: () => (marker.isDisposed ? -1 : marker.line),
      };
    },
    whole: () => {
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      return lines.join('\n').replace(/\s+$/, '');
    },
    outputAfter: (row, until) => {
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = row + 1; i < Math.min(until, b.length); i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      return lines.join('\n').replace(/\s+$/, '');
    },
    rows: () => term.buffer.active.length,
    since: (row) => {
      const b = term.buffer.active;
      const cursor = b.baseY + b.cursorY;
      // Never more than a screenful and a bit in one go: a box that printed a hundred thousand lines while
      // the window was busy is not a reason for the window to read a hundred thousand lines now.
      const from = Math.max(0, Math.min(row, cursor), cursor - 400);
      const lines: { text: string; atCursor: boolean }[] = [];
      for (let i = from; i <= cursor; i++) lines.push({ text: b.getLine(i)?.translateToString(true) ?? '', atCursor: i === cursor });
      return { lines, next: cursor };
    },
  };
}
