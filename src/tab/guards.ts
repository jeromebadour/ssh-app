// What a box may not do through the terminal, and the whole list of what the terminal may answer a box
// (plan B3, B10). Everything a box prints is parsed by the terminal library; these handlers come before the
// library's own, and the ones named here are taken from it entirely.
//
// A box cannot:
//   - make the terminal send back text of the box's choosing. Every question a terminal can be asked is taken
//     here; the answers below are fixed text or numbers the box cannot choose, and every other question gets none.
//   - write to the clipboard, set the window's title or a tab's label, move or size the window, or change the
//     terminal's colours (those are Berth's).
//   - hide a link behind other words.
//
// The answers, complete:
//   CSI c            what kind of terminal      ESC [ ? 1 ; 2 c
//   CSI > c          which terminal             ESC [ > 0 ; 276 ; 0 c
//   CSI 5 n          are you there              ESC [ 0 n
//   CSI 6 n          where is the cursor        ESC [ row ; column R
//   CSI ? 6 n        the same, the other form   ESC [ ? row ; column R
//   CSI ? n $ p      is this mode on            ESC [ ? n ; (0 not known, 1 on, 2 off) $ y
// What is left to go to the box without a question: keys, the mouse while a program on the box asked for it,
// and "the window gained or lost focus" while a program asked for that. None of it holds text from the box.
import type { Terminal } from '@xterm/xterm';

export const ANSWERS = {
  kind: '\x1b[?1;2c',
  which: '\x1b[>0;276;0c',
  there: '\x1b[0n',
} as const;

// Operating-system commands (OSC) the library would act on, all refused: 0, 1, 2 title and icon name; 4, 10, 11,
// 12 and their resets 104, 110, 111, 112 colours (set, and asked for: the answer would be text); 8 a link behind
// other words; 52 the clipboard.
export const REFUSED_OSC = [0, 1, 2, 4, 8, 10, 11, 12, 52, 104, 110, 111, 112] as const;

export function guard(term: Terminal, answer: (text: string) => void): void {
  const p = term.parser;
  const first = (params: (number | number[])[]): number => (typeof params[0] === 'number' ? params[0] : 0);
  const cursor = (): [number, number] => [term.buffer.active.cursorY + 1, term.buffer.active.cursorX + 1];
  const modes = (): Record<number, boolean> => ({
    1: term.modes.applicationCursorKeysMode,
    6: term.modes.originMode,
    7: term.modes.wraparoundMode,
    45: term.modes.reverseWraparoundMode,
    1004: term.modes.sendFocusMode,
    2004: term.modes.bracketedPasteMode,
    2026: term.modes.synchronizedOutputMode,
  });

  p.registerCsiHandler({ final: 'c' }, (params) => {
    if (first(params) === 0) answer(ANSWERS.kind);
    return true;
  });
  p.registerCsiHandler({ prefix: '>', final: 'c' }, (params) => {
    if (first(params) === 0) answer(ANSWERS.which);
    return true;
  });
  p.registerCsiHandler({ prefix: '=', final: 'c' }, () => true);
  p.registerCsiHandler({ final: 'n' }, (params) => {
    if (first(params) === 5) answer(ANSWERS.there);
    else if (first(params) === 6) answer(`\x1b[${cursor()[0]};${cursor()[1]}R`);
    return true;
  });
  p.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
    if (first(params) === 6) answer(`\x1b[?${cursor()[0]};${cursor()[1]}R`);
    return true;
  });
  p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
    const n = first(params);
    if (Number.isInteger(n) && n >= 0 && n <= 99999) {
      const on = modes()[n];
      answer(`\x1b[?${n};${on === undefined ? 0 : on ? 1 : 2}$y`);
    }
    return true;
  });
  p.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true); // the same question in its other form: no answer
  p.registerCsiHandler({ final: 't' }, () => true); // the window: its size, its place, its title, asked or set
  p.registerCsiHandler({ prefix: '>', final: 't' }, () => true);
  p.registerCsiHandler({ prefix: '>', final: 'q' }, () => true); // "name yourself"
  p.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true); // "say back your settings"
  p.registerDcsHandler({ intermediates: '+', final: 'q' }, () => true); // "say back your abilities"
  for (const n of REFUSED_OSC) p.registerOscHandler(n, () => true);
}
