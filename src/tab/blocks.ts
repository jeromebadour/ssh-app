// Telling one command from the next in a terminal, which is the thing about MobaXterm he named first: with
// everything the same colour he cannot see where one command's output ends, so he types clear instead
// (2026-11-15 07:32). Everything here is a reading aid and never a proof: a box can print whatever it likes,
// including something that looks exactly like a prompt, and nothing any safety question depends on is
// decided from what is read here (plan A5, B3).
//
// What it knows: the shape of this box's prompt, learned from the first prompt it prints and matched after
// that; whether the box is waiting for a command or running one; and when a command finished, with how long
// it took. A prompt it cannot learn means no blocks for that tab and a quiet marker saying so, never a guess.

// The symbols a shell's prompt ends with. A line ending in one of these, with nothing after it, is how every
// shell he uses says it is waiting.
const ENDS = ['$', '#', '%', '>'];

// How long a line may be and still be a prompt, and the longest "who" a prompt may name. A box that prints
// three hundred characters and a dollar sign is printing output, not a prompt.
const LINE_MAX = 200;
const WHO_MAX = 80;

export interface Shape {
  who: string; // the part before the first colon, such as "demo@lab-box": stable while the folder changes
  ends: string; // the symbol it ends with
}

// Whether a line could be a prompt at all: one line, short, ending in a prompt symbol, and nothing a
// terminal would have acted on. The text here has already been read from the terminal's own buffer, so it
// holds no escape sequences; a control character in it means the line is not what it looks like.
export const promptLike = (line: string): boolean => {
  if (line.length === 0 || line.length > LINE_MAX) return false;
  for (const ch of line) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return false;
  }
  const text = line.replace(/\s+$/, '');
  if (text.length === 0) return false;
  if (!ENDS.includes(text.slice(-1))) return false;
  // A digit right before the symbol is money, not a shell: "the cost is 40$" is a line of output, and a
  // prompt's symbol follows a folder, a name or a space.
  return !/[0-9]$/.test(text.slice(0, -1));
};

// The shape of a prompt, learned from one line of it. The folder is left out on purpose: it is the part that
// changes, and a prompt remembered with the folder in it would stop matching the moment he changes folder.
// A line with no stable part before the folder gives nothing to learn, and nothing is what is returned: a
// guessed prompt would mark output as commands, which is worse than no marks at all.
export const learn = (line: string): Shape | null => {
  if (!promptLike(line)) return null;
  const text = line.replace(/\s+$/, '');
  const ends = text.slice(-1);
  const colon = text.indexOf(':');
  const who = colon > 0 ? text.slice(0, colon) : '';
  if (who === '' || who.length > WHO_MAX) return null;
  return { who, ends };
};

// Whether a line is this box's prompt. Both ends are asked for: a line that merely ends in the symbol is any
// line of output that happens to end in one, and a line that merely starts with the name is the output of
// anything that prints it.
export const isPrompt = (line: string, shape: Shape | null): boolean => {
  if (!shape || !promptLike(line)) return false;
  const text = line.replace(/\s+$/, '');
  return text.startsWith(shape.who) && text.slice(-1) === shape.ends;
};

export type Doing = 'unknown' | 'idle' | 'running';

// A line of the terminal as this reads it: the text, whether the cursor sits on it, and which row of the
// terminal's own buffer it is. The row is what tells typing from running: a person typing at the prompt is
// on the prompt's own row, and a command that has started has moved the cursor below it.

// What one tab's terminal is doing, worked out from what the box printed and what was typed into it. It is
// fed lines, not bytes: the lines come from the terminal's own buffer, where the escape sequences have
// already been acted on, so nothing here has to understand a terminal.
export class Blocks {
  shape: Shape | null = null;
  doing: Doing = 'unknown';
  // Whether this tab gave up on learning a prompt. It is said quietly in the tab, because a tab with no
  // blocks looks like a tab whose blocks are broken unless it says which it is.
  gaveUp = false;
  // How many prompts have been seen: what a probe and the tab's own details read.
  prompts = 0;
  // When what is running now started, and the row the last prompt was drawn on.
  since = 0;
  private promptRow = -1;
  // Every prompt row seen, newest last, and how long the prompt itself is on each: what the terminal draws a
  // block from. Only the last few are kept, because a decoration is a thing on a screen and the ones that
  // have scrolled far out of reach are not worth holding.
  readonly marks: { id: number; row: number; width: number }[] = [];
  private nextMark = 1;
  static readonly MARKS_KEPT = 200;
  // The last command that finished: how long it took. What was typed is never kept at all; nothing here
  // needs it, and his own typing is his.
  finished: { ms: number } | null = null;

  // How many lines may be looked at before a prompt is called unlearnable. A shell prints its banner, its
  // notices and its message of the day first; past this many lines without one stable prompt there is
  // nothing to learn and saying so is the honest answer.
  static readonly PATIENCE = 200;
  private looked = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  // The terminal was cleared, so every row this holds a mark for has gone. The marks go with them: a mark
  // kept across a Clear names a row that now holds something else entirely, and the terminal draws it there.
  // What was learned about the shape of this box's prompt stays, because the shell behind it is the same
  // shell and learning it again would cost him his first block after every Clear.
  forgetMarks(): void {
    this.marks.length = 0;
    this.promptRow = -1;
  }


  // One line of the terminal as it now holds it. A prompt is a line the box stopped on, so the cursor's own
  // line is the only one anything is learned from; a line printed and moved past is output.
  //
  // Running or waiting is told from the row, not from what was typed: at the prompt the cursor is on the
  // prompt's own row however much he has typed there, and a command that has started has moved it below.
  // So nothing here has to know what he typed, and nothing of it is kept.
  sawLine(line: string, atCursor: boolean, row: number): void {
    if (this.shape === null) {
      if (this.gaveUp) return;
      if (atCursor) {
        const shape = learn(line);
        if (shape) {
          this.shape = shape;
          this.prompts++;
          this.promptRow = row;
          this.mark(row, line);
          this.doing = 'idle';
          return;
        }
      }
      this.looked++;
      if (this.looked > Blocks.PATIENCE) this.gaveUp = true;
      return;
    }
    if (isPrompt(line, this.shape)) {
      this.prompts++;
      this.promptRow = row;
      this.mark(row, line);
      if (this.doing === 'running') this.finished = { ms: Math.max(0, this.now() - this.since) };
      this.since = 0;
      this.doing = 'idle';
      return;
    }
    // The cursor has moved below the prompt and what is there is not a prompt: something is running. A
    // person typing at the prompt is still on the prompt's row, so typing is not a command running.
    if (atCursor && this.doing === 'idle' && row > this.promptRow) {
      this.doing = 'running';
      this.since = this.now();
    }
  }

  // One prompt row written down, with how wide the prompt itself is, so what is drawn over it covers the
  // prompt and not what he typed after it. The same row seen twice (a prompt redrawn as he types) is the
  // same mark, not another one.
  private mark(row: number, line: string): void {
    const width = line.replace(/\s+$/, '').length;
    const last = this.marks.at(-1);
    if (last && last.row === row) {
      last.width = width;
      return;
    }
    this.marks.push({ id: this.nextMark++, row, width });
    if (this.marks.length > Blocks.MARKS_KEPT) this.marks.splice(0, this.marks.length - Blocks.MARKS_KEPT);
  }

  // The one command that finished since this was last asked, and nothing twice: a mark on a tab and a
  // notification are shown once each, not again on every redraw.
  takeFinished(): { ms: number } | null {
    const was = this.finished;
    this.finished = null;
    return was;
  }
}
