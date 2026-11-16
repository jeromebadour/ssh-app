// A paste of more than one line, shown before anything is sent (plan B3). A line ending in a paste runs as a
// command the moment it arrives, so a paste that holds one is read first, here, on a surface no tab can draw
// on. What cannot be seen by looking at the text is marked: characters drawn as nothing, characters that turn
// the reading round, and characters that look like a letter of the keyboard and are not.
import type { PasteShown } from '../common/ipc';
import { Glyph } from './glyphs';
import { useEffect } from 'preact/hooks';

export interface PasteActions {
  send(): void;
  drop(): void;
}

// A line as it is drawn here: what cannot be seen is made visible, and nothing is left to be obeyed.
function drawn(line: string): string {
  let out = '';
  for (const ch of line) {
    const c = ch.codePointAt(0)!;
    if (ch === '\t') out += '\u2192   '; // a tab, drawn as an arrow and its width
    else if (c < 0x20 || c === 0x7f) out += '\u2423';
    else if (c === 0x00a0 || (c >= 0x2000 && c <= 0x200f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || c === 0x00ad || c === 0x061c) out += '\u2420';
    else out += ch;
  }
  return out;
}

export function PasteDialog(props: { p: PasteShown; act: PasteActions }) {
  const p = props.p;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.act.drop();
      if (e.key === 'Enter' && !e.shiftKey) props.act.send();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [props.act]);
  const oddOn = new Map<number, { what: string; shown: string }[]>();
  for (const o of p.odd) oddOn.set(o.line, [...(oddOn.get(o.line) ?? []), { what: o.what, shown: o.shown }]);
  const lines = p.lines.length;
  const chars = p.lines.reduce((n, l) => n + l.length, 0) + Math.max(0, lines - 1);
  return (
    <div class="scrim">
      <div class={`dialog wide ${p.odd.length > 0 ? 'dlg-problem' : 'dlg-main'}`} id="paste" role="dialog" aria-modal="true" aria-labelledby="paste-title">
        <h1 id="paste-title">
          <Glyph name="paste" />
          {lines} {lines === 1 ? 'line' : 'lines'} to {p.box}
          {p.place ? `, ${p.place}` : ''}
        </h1>
        <p class="said">
          {chars} characters.{' '}
          {p.endsWithLineEnding
            ? `It ends with a line ending, so the last line runs on arrival without an Enter of yours.`
            : `It does not end with a line ending, so the last line is left typed, not run.`}
          {p.protectedPaste ? ' The box asked to be told where a paste begins, so its shell will see it as pasted.' : ''}
        </p>
        {p.controlsRemoved > 0 || p.cut ? (
          <p class="said quiet" id="paste-taken">
            {p.controlsRemoved > 0 ? `${p.controlsRemoved} control ${p.controlsRemoved === 1 ? 'character' : 'characters'} taken out. ` : ''}
            {p.cut ? 'The clipboard held more than Berth pastes at once: the rest is not here.' : ''}
          </p>
        ) : null}
        {p.odd.length > 0 ? (
          <ul class="odd" id="paste-odd">
            {p.odd.slice(0, 12).map((o) => (
              <li key={`${o.line}-${o.at}`}>
                <Glyph name="find" />
                <span class="where">
                  line {o.line}, character {o.at}
                </span>
                <span class="what">{o.what}</span>
                <span class="shown">{o.shown}</span>
              </li>
            ))}
            {p.odd.length > 12 ? <li class="more">and {p.odd.length - 12} more</li> : null}
          </ul>
        ) : null}
        <ol class="paste-lines" id="paste-lines">
          {p.lines.map((line, i) => (
            <li key={i} data-odd={oddOn.has(i + 1) ? '' : undefined}>
              <code>{drawn(line)}</code>
            </li>
          ))}
        </ol>
        <div class="row end">
          <button type="button" class="btn" id="paste-drop" onClick={props.act.drop}>
            <Glyph name="close" />
            Don't send<kbd>Esc</kbd>
          </button>
          <button type="button" class="btn primary" id="paste-send" onClick={props.act.send}>
            <Glyph name="paste" />
            Send to {p.box}
            <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
