// An address a box printed, shown whole before anything opens (plan B2.7). A box can print any text at all,
// so what is drawn here is Berth's: the host on its own line, because the host is what decides where the
// address really goes, and then the whole address, as it is, with nothing cut and nothing shortened.
import type { LinkAsked } from '../common/ipc';
import { Glyph } from './glyphs';
import { useEffect } from 'preact/hooks';

export interface LinkActions {
  open(): void;
  drop(): void;
}

export function LinkDialog(props: { l: LinkAsked; act: LinkActions }) {
  const l = props.l;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.act.drop();
      if (e.key === 'Enter' && !e.shiftKey) props.act.open();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [props.act]);
  return (
    <div class="scrim">
      <div class={`dialog ${l.scheme === 'http' ? 'dlg-problem' : 'dlg-main'}`} id="link" role="dialog" aria-modal="true" aria-labelledby="link-title">
        <h1 id="link-title">
          <Glyph name="link" />
          Open {l.host} in the browser?
        </h1>
        <p class="said">
          {l.box}
          {l.place ? `, ${l.place}` : ''} printed this. {l.scheme === 'http' ? 'It is http, so what it carries is open on the way.' : 'It is https.'}
        </p>
        <p class="link-url" id="link-url">
          <code>{l.url}</code>
        </p>
        <div class="row end">
          <button type="button" class="btn" id="link-drop" onClick={props.act.drop}>
            <Glyph name="close" />
            Don't open<kbd>Esc</kbd>
          </button>
          <button type="button" class="btn primary" id="link-open" onClick={props.act.open}>
            <Glyph name="link" />
            Open<kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
