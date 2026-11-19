// What he calls one tab, and the colour he gives it.
//
// His, the night of 2026-11-18: a tab carries its own name and colour, saved. Most tabs are left as what
// they are, one box and one place; this is for the two or three that are not, where "the one I am watching
// the deploy in" is what he is looking for and "lab-box · logs" is not.
//
// The group's edge and its dot keep the box's own colour whatever a tab is called. A tab is his to name; a
// box is what it is.
import { useState } from 'preact/hooks';
import { BOX_COLOURS } from '../common/boxes';
import { Button } from './button';
import { Glyph } from './glyphs';

export function TabDialog(props: { name: string; colour: number; was: string; onDone: (name: string, colour: number) => void; onCancel: () => void }) {
  const [name, setName] = useState(props.name);
  const [colour, setColour] = useState(props.colour);
  const send = (): void => props.onDone(name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40), colour);
  return (
    <div class="scrim">
      <div class="dialog" id="name-tab" role="dialog" aria-modal="true" aria-labelledby="name-tab-title">
        <h1 id="name-tab-title"><Glyph name="tag" />What this tab is called</h1>
        <p class="said quiet" id="name-tab-said">Empty puts it back to {props.was}.</p>
        <label class="field">
          <span class="field-label"><Glyph name="name" />Its name</span>
          <span class="input sized" style={{ '--w': '26ch' }}>
            <input
              id="name-tab-field"
              type="text"
              autocomplete="off"
              spellcheck={false}
              maxLength={40}
              value={name}
              autofocus
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            />
          </span>
        </label>
        <div class="sect">
          <span class="field-label"><Glyph name="box" />Its colour</span>
          <div class="swatches" id="name-tab-colours" role="radiogroup" aria-label="The colour of this tab">
            {/* Nought is the box's own colour, and it is a choice like the others rather than a way of
                undoing one: a tab that goes by its box is the ordinary case. */}
            <button type="button" class={`swatch swatch-none ${colour === 0 ? 'on' : ''}`} data-hue="0" role="radio" aria-checked={colour === 0} aria-label="Its box's own colour" title="Its box's own colour" onClick={() => setColour(0)} />
            {Array.from({ length: BOX_COLOURS }, (_, i) => i + 1).map((n) => (
              <button type="button" key={n} class={`swatch ${n === colour ? 'on' : ''}`} data-hue={n} style={{ '--hue': `var(--box-${n})` }} role="radio" aria-checked={n === colour} aria-label={`Colour ${n}`} onClick={() => setColour(n)} />
            ))}
          </div>
        </div>
        <div class="dlg-actions">
          <Button id="name-tab-cancel" glyph="back" kbd="Esc" onClick={props.onCancel}>Leave it</Button>
          <Button id="name-tab-go" tone="go" glyph="check" onClick={send}>Name it</Button>
        </div>
      </div>
    </div>
  );
}
