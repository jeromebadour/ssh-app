// An address a box printed, shown whole before anything opens (plan B2.7). A box can print any text at all,
// so what is drawn here is Berth's: the host on its own line, because the host is what decides where the
// address really goes, and then the whole address, as it is, with nothing cut and nothing shortened.
import { Button } from './button';
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
          <Button id="link-drop" glyph="close" kbd="Esc" onClick={props.act.drop}>Don't open</Button>
          <Button id="link-open" tone="go" glyph="link" kbd="Enter" onClick={props.act.open}>Open</Button>
        </div>
      </div>
    </div>
  );
}
