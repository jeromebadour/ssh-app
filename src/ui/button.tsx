// The one button every dialog answers with.
//
// His, the night of 2026-11-18, looking at a Close Berth dialog: "the dialogs' buttons are dummies". And they
// were. The safe answer was bare text with a glyph and a key hint floating beside it, while the thing next to
// it was filled, so a person reading the dialog saw one button and a sentence. Five different looks were in
// use across five files, some of them with no surface at all.
//
// There are three tones and no more, because a dialog asks one question with two answers:
//   plain   the safe answer, and anything that is neither: a surface of its own and a hairline edge.
//   go      the answer the dialog is for, filled in the window's main colour.
//   danger  the answer that takes something away, filled in the remove colour.
//
// Every one of them is a real surface. A person must be able to see where to press without reading.
import type { ComponentChildren, Ref } from 'preact';
import { Glyph } from './glyphs';

export function Button(props: {
  id: string;
  // Every one of these may be left out, and a caller that has nothing to pass may pass undefined: a dialog
  // that must spread its own maybe-absent handler should not have to build the attribute list by hand.
  tone?: 'plain' | 'go' | 'danger' | undefined;
  glyph?: string | undefined;
  kbd?: string | undefined;
  type?: 'button' | 'submit' | undefined;
  disabled?: boolean | undefined;
  wide?: boolean | undefined;
  // Waiting on something: the surface goes quiet while the words say what is happening. Its own tone would
  // be a fourth meaning, and waiting is a state a button is in, not a thing it means.
  waiting?: boolean | undefined;
  autofocus?: boolean | undefined;
  hold?: Ref<HTMLButtonElement> | undefined;
  onClick?: (() => void) | undefined;
  children?: ComponentChildren;
}) {
  const tone = props.tone ?? 'plain';
  return (
    <button
      type={props.type ?? 'button'}
      class={`btn btn-${tone}${props.wide === true ? ' btn-wide' : ''}${props.waiting === true ? ' btn-waiting' : ''}`}
      id={props.id}
      disabled={props.disabled === true}
      {...(props.hold ? { ref: props.hold } : {})}
      {...(props.autofocus === true ? { autofocus: true } : {})}
      {...(props.onClick ? { onClick: props.onClick } : {})}
    >
      {props.glyph === undefined ? null : <Glyph name={props.glyph} />}
      <span class="btn-words">{props.children}</span>
      {props.kbd === undefined ? null : <kbd>{props.kbd}</kbd>}
    </button>
  );
}
