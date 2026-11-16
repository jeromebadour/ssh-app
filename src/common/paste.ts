// What a paste is made of, and what of it may reach a box (plan B2.7, B3).
//
// A paste is the one thing a person brings into a shell from somewhere else, and what it holds cannot be seen
// by looking at it: a page can carry a line ending that runs a command on arrival, a character that looks like
// a letter and is not, or a mark that turns a line round on screen so it reads as something it is not.
//
// So: every control character is taken out but tab and newline (the escape character with them, so no paste
// can carry a terminal's own instructions, the end of a protected paste included); line endings are made one
// kind; and what is left is looked at, line by line, for what a person could not see. Nothing here decides for
// the person: a paste that holds more than one line is shown before it is sent, with these marks on it.

export const PASTE_MAX = 1024 * 1024; // characters taken from the clipboard at once

// Characters that are drawn as nothing, or that change how the rest is read.
const INVISIBLE: Record<number, string> = {
  0x00a0: 'no-break space',
  0x00ad: 'soft hyphen',
  0x180e: 'Mongolian vowel separator',
  0x200b: 'zero-width space',
  0x200c: 'zero-width non-joiner',
  0x200d: 'zero-width joiner',
  0x2060: 'word joiner',
  0xfeff: 'byte-order mark',
  0x2028: 'line separator',
  0x2029: 'paragraph separator',
};
const BIDI: Record<number, string> = {
  0x061c: 'Arabic letter mark',
  0x200e: 'left-to-right mark',
  0x200f: 'right-to-left mark',
  0x202a: 'left-to-right embedding',
  0x202b: 'right-to-left embedding',
  0x202c: 'pop directional formatting',
  0x202d: 'left-to-right override',
  0x202e: 'right-to-left override',
  0x2066: 'left-to-right isolate',
  0x2067: 'right-to-left isolate',
  0x2068: 'first strong isolate',
  0x2069: 'pop directional isolate',
};
// Characters that are drawn like a letter, a digit or a mark of the keyboard, and are another character.
const LOOKALIKE: Record<string, string> = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j', '\u04bb': 'h', '\u0501': 'd', '\u051b': 'q', '\u0491': 'r',
  '\u03bf': 'o', '\u03bd': 'v', '\u03c1': 'p', '\u03c5': 'u', '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P', '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '\u00b4': "'", '`': '`',
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u2033': '"',
  '\u2044': '/', '\u2215': '/', '\u00f7': '/', '\u01c0': '|', '\u2223': '|', '\uff5c': '|',
  '\u037e': ';', '\u0387': ';', '\u00a6': '|', '\u2236': ':', '\uff1a': ':', '\uff0c': ',', '\uff0e': '.', '\uff1b': ';', '\uff04': '$', '\uff05': '%', '\uff06': '&', '\uff0f': '/',
};

export interface Odd {
  line: number; // 1-based
  at: number; // 1-based, in characters
  what: string; // what it is, in plain words
  shown: string; // how it is written out: U+200B and its name, or the letter it looks like
}

export interface Looked {
  text: string; // what would be sent: control characters out, line endings one kind
  lines: string[]; // its lines, without the empty one a trailing line ending would leave
  endsWithLineEnding: boolean; // the last line would run on arrival, with no Enter of the person's own
  odd: Odd[];
  cut: boolean; // the clipboard held more than PASTE_MAX and was cut
  controlsRemoved: number; // control characters taken out, the escape character included
  oneLine: boolean; // no newline and no tab: it goes as typed, with no preview
}

// Takes the clipboard's text apart. Nothing is sent anywhere by this; it only says what the paste is.
export function look(raw: string): Looked {
  const cut = raw.length > PASTE_MAX;
  const text0 = (cut ? raw.slice(0, PASTE_MAX) : raw).replace(/\r\n?/g, '\n');
  let controlsRemoved = 0;
  let text = '';
  for (const ch of text0) {
    const c = ch.codePointAt(0)!;
    const control = (c < 0x20 && ch !== '\n' && ch !== '\t') || c === 0x7f || (c >= 0x80 && c <= 0x9f);
    if (control) controlsRemoved++;
    else text += ch;
  }
  const all = text.split('\n');
  const endsWithLineEnding = all.length > 1 && all[all.length - 1] === '';
  const lines = endsWithLineEnding ? all.slice(0, -1) : all;
  const odd: Odd[] = [];
  lines.forEach((line, i) => {
    [...line].forEach((ch, j) => {
      const c = ch.codePointAt(0)!;
      const point = `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
      if (INVISIBLE[c]) odd.push({ line: i + 1, at: j + 1, what: 'drawn as nothing', shown: `${point} ${INVISIBLE[c]}` });
      else if (BIDI[c]) odd.push({ line: i + 1, at: j + 1, what: 'turns the reading round', shown: `${point} ${BIDI[c]}` });
      else if (LOOKALIKE[ch]) odd.push({ line: i + 1, at: j + 1, what: `looks like ${LOOKALIKE[ch]}`, shown: `${point} is not ${LOOKALIKE[ch]}` });
    });
  });
  return { text, lines, endsWithLineEnding, odd, cut, controlsRemoved, oneLine: !text.includes('\n') && !text.includes('\t') };
}

// What goes to the box. A box that asked for protected paste is told where the paste begins and ends, so a
// shell can see it as pasted and not as typed; the end marker itself can never be inside the text, because no
// escape character survives `look`. A trailing newline is kept: it is the person's own Enter.
export function forBox(text: string, protectedPaste: boolean): string {
  return protectedPaste ? `\u001b[200~${text}\u001b[201~` : text;
}
