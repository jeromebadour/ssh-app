// The tab's terminal: the terminal library with Berth's limits around it (plan B3).
//   - What a box prints is drawn; what a box may not do through it, and the few fixed answers it may get, are
//     in guards.ts.
//   - Paste is not the library's: its own paste, and text dropped onto it, are switched off here. Paste is
//     main's work, from a key or a click it saw itself.
//   - Output is counted as taken only once the terminal has worked through it, so a box sends ahead of the
//     window by a fixed amount at most.
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

export interface Term {
  ready: Promise<void>; // drawn, in its own typeface: a cell has its true size from here on
  write(bytes: Uint8Array, done: () => void): void;
  note(text: string): void; // a line of Berth's own, never a box's
  words(text: string): void; // a box's words that are not a program's output (its sign-in text): drawn, never obeyed
  size(): { cols: number; rows: number };
  fit(): boolean; // true when the size changed
  focus(): void;
  text(): string; // everything on screen and scrolled out, for the lab
  spot(text: string): { x: number; y: number; hand: boolean } | null; // where these words are drawn, and whether the pointer is a hand; for the lab
  bracketedPaste(): boolean;
}

export function openTerminal(host: HTMLElement, out: { typed(bytes: Uint8Array): void; selected(text: string): void }): Term {
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
    allowProposedApi: false,
    altClickMovesCursor: false, // it would type arrow keys for a click
    rightClickSelectsWord: false,
    linkHandler: null,
    windowOptions: {}, // nothing about the window may be asked or set by a box
    screenReaderMode: false,
  });
  const encoder = new TextEncoder();
  const send = (text: string): void => out.typed(encoder.encode(text));
  guard(term, send);
  term.onData(send); // keys, and the mouse and focus reports a program on the box asked for
  term.onBinary((data) => out.typed(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
  // The terminal is drawn once its typeface is there: a cell measured in another face has another size, and
  // the box would be told a size that is not the view's. What arrives before is kept and drawn then.
  const FACE = "13.5px 'Plex Mono'";
  const ready = Promise.all([document.fonts.load(FACE), document.fonts.load(`600 ${FACE}`)]).then(
    () => undefined,
    () => undefined, // a face that will not load is said by the self-test; the terminal still opens
  ).then(() => term.open(host));

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

  return {
    ready,
    write: (bytes, done) => term.write(bytes, done),
    // A line of Berth's own always starts a line of its own: a box's output rarely ends at a line's end.
    note: (text) => term.write(`${term.buffer.active.cursorX > 0 ? '\r\n' : ''}\x1b[2m${inert(text).replace(/[\r\n\t]+/g, ' ')}\x1b[0m\r\n`),
    words: (text) => term.write(inert(text)),
    size: () => ({ cols: term.cols, rows: term.rows }),
    fit,
    focus: () => term.focus(),
    text: () => {
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      return lines.join('\n').replace(/\n+$/, '');
    },
    spot: (text) => {
      const b = term.buffer.active;
      const c = cell();
      const screen = host.querySelector('.xterm-screen')?.getBoundingClientRect();
      if (!c || !screen) return null;
      for (let row = 0; row < term.rows; row++) {
        const col = (b.getLine(b.viewportY + row)?.translateToString(true) ?? '').indexOf(text);
        if (col >= 0) return { x: Math.round(screen.left + (col + 1.5) * c.w), y: Math.round(screen.top + (row + 0.5) * c.h), hand: !!host.querySelector('.xterm-cursor-pointer') };
      }
      return null;
    },
    bracketedPaste: () => term.modes.bracketedPasteMode,
  };
}
