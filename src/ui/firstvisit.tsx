// The first visit (decision O2): the one screen in this whole app that ever asks for a box's own password.
//
// Everything about it is written to make that one exception small and visible. It opens only from the
// first-connection check, and only after that box's identity has been pinned, so the machine on the other end
// has already proved it is the one he checked. It says in its own words that this is the only time it will
// ever ask. What is typed goes straight to main, is used once, and is not kept anywhere: not by this screen,
// not in the window's state, not on disk.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FirstVisitShown } from '../common/ipc';
import { Glyph } from './glyphs';

const WHY: Record<string, string> = {
  'no-password': 'A password has to be typed',
  'sign-in-failed': 'That password was not taken by the box',
  'asked-something-else': 'The box asked for something a password cannot answer, such as a code. Berth cannot answer that here: put the key on through the block instead',
  'identity-changed': 'The box showed an identity that is not the one pinned. Nothing was sent to it',
  'key-did-not-work': 'The key went on, but signing in with it did not work',
  'no-tab': 'The key went on, but Berth could not open a tab to prove it',
  refused: 'The box refused the connection',
  unreachable: 'The box could not be reached',
  'timed-out': 'The box did not answer in time',
  reset: 'The connection was cut',
  'closed-by-box': 'The box closed the connection',
  'weak-offer': 'The box offered only settings Berth refuses',
  protocol: 'Something went wrong before the box could be asked',
};

export function FirstVisitDialog(props: { shown: FirstVisitShown; onGo(password: string): void; onClose(): void }) {
  const [password, setPassword] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const v = props.shown;
  const asking = v.phase === 'asking';
  const working = v.phase === 'visiting' || v.phase === 'proving';
  useEffect(() => {
    if (asking) field.current?.focus();
    else if (!working) close.current?.focus();
  }, [v.phase]);
  // The password is dropped the moment it has been handed over, so it is not sitting in this window while the
  // visit runs, and not there at all once it is done.
  useEffect(() => {
    if (!asking) setPassword('');
  }, [v.phase]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !working) props.onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [working]);

  return (
    <div class="scrim">
      <div class="dialog dlg-visit" id="first-visit" role="dialog" aria-modal="true" aria-labelledby="first-visit-title">
        <h1 id="first-visit-title"><Glyph name="fileKey" />Put Berth's key on {v.name}</h1>

        <p class="said" id="first-visit-what">
          {v.name} is pinned: the machine at {v.addr} has proved it is the one you checked. Berth can now sign in once as <b>{v.user}</b> with that account's password, add its own key, and never ask for a password for this box again.
        </p>
        <p class="said quiet" id="first-visit-cost">
          This is the only time Berth will ever ask you for a password for a box. It is used once, for one command, and is not written down anywhere. From here on this box is key only, even if the key is removed: starting over means deleting the box and adding it again.
        </p>

        {asking && (
          <form
            class="visit-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (password !== '') props.onGo(password);
            }}
          >
            <label class="visit-label" for="first-visit-password"><Glyph name="lock" />The password for {v.user} on {v.name}</label>
            <input
              id="first-visit-password"
              class="visit-field"
              ref={field}
              type="password"
              value={password}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
            {v.error !== '' && <p class="said problem" id="first-visit-why">{WHY[v.error] ?? WHY['protocol']}{v.detail ? ` (${v.detail})` : ''}</p>}
            <div class="dlg-actions gap-top">
              <button type="button" class="btn keep-plain" id="first-visit-cancel" onClick={props.onClose}><Glyph name="close" />Cancel</button>
              <button type="submit" class="btn primary" id="first-visit-go" disabled={password === ''}><Glyph name="ok" />Put the key on</button>
            </div>
          </form>
        )}

        {working && (
          <p class="said" id="first-visit-working">
            <span class="wait-ring" />
            {v.phase === 'visiting' ? 'Signing in once and adding the key' : 'Signing back in with the key alone, to prove it worked'}
            {v.detail ? <span class="quiet"> ({v.detail})</span> : null}
          </p>
        )}

        {v.phase === 'done' && (
          <>
            <p class="said ok" id="first-visit-done">The key is on {v.name}, and signing in with it works. The tab is open. Berth will not ask for a password for this box again.</p>
            {v.said !== '' && <pre class="visit-said" id="first-visit-said">{v.said}</pre>}
          </>
        )}

        {v.phase === 'failed' && (
          <p class="said problem" id="first-visit-failed">{WHY[v.error] ?? WHY['protocol']}{v.detail ? ` (${v.detail})` : ''}</p>
        )}

        {!asking && !working && (
          <div class="dlg-actions gap-top">
            <button type="button" class="btn primary" id="first-visit-close" ref={close} onClick={props.onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
