// The first visit (decision O2): the one screen in this whole app that ever asks for a box's own password.
//
// Everything about it is written to make that one exception small and visible. It opens only from the
// first-connection check, and only after that box's identity has been pinned, so the machine on the other end
// has already proved it is the one he checked. It says in its own words that this is the only time it will
// ever ask. What is typed goes straight to main, is used once, and is not kept anywhere: not by this screen,
// not in the window's state, not on disk.

import { Button } from './button';
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

export function FirstVisitDialog(props: { shown: FirstVisitShown; onGo(password: string): void; onAnswers(answers: string[]): void; onClose(): void }) {
  const [password, setPassword] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const firstAnswer = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const v = props.shown;
  const asking = v.phase === 'asking';
  const answering = v.phase === 'answering';
  const working = v.phase === 'visiting' || v.phase === 'proving';
  // One field per question, kept for as long as the questions are on screen, so a redraw cannot take the
  // caret back from under his hands.
  useEffect(() => {
    if (answering) {
      setAnswers(v.asked.map(() => ''));
      firstAnswer.current?.focus();
    }
  }, [answering, v.asked.length]);
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

        {/* One line. The title says what this screen does; what it must add is the thing he cannot see: that
            this is the one password Berth ever asks for a box, used once and written down nowhere. */}
        <p class="said" id="first-visit-what">
          The only password Berth ever asks for a box: used once, as <b>{v.user}</b>, to put its key on {v.name}, and written down nowhere.
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
              <Button id="first-visit-cancel" glyph="close" onClick={props.onClose}>Cancel</Button>
              <Button id="first-visit-go" tone="go" type="submit" glyph="ok" disabled={password === ''}>Put the key on</Button>
            </div>
          </form>
        )}

        {answering && (
          <form
            id="first-visit-questions"
            onSubmit={(e) => {
              e.preventDefault();
              props.onAnswers(v.asked.map((_, i) => answers[i] ?? ''));
            }}
          >
            {/* The box's own words. They are drawn as text and nothing else: never markup, never a link,
                and marked as the box's, because this screen is the window's and the words are not. */}
            <p class="said" id="first-visit-asked-why">
              {v.name} is asking for something of its own before it will sign in. These are the box's words:
            </p>
            {v.asked.map((q, i) => (
              <label class="field" key={`${i}:${q.question}`}>
                <span class="said quiet" data-question={i}>{q.question}</span>
                <span class="input">
                  {q.show ? (
                    <input ref={i === 0 ? firstAnswer : null} id={`first-visit-answer-${i}`} type="text" autocomplete="off" spellcheck={false} value={answers[i] ?? ''} onInput={(e) => setAnswers((was) => was.map((a, j) => (j === i ? (e.target as HTMLInputElement).value : a)))} />
                  ) : (
                    /* The box wants this one hidden as it is typed, so it is drawn as a password is. */
                    <input ref={i === 0 ? firstAnswer : null} id={`first-visit-answer-${i}`} type="password" autocomplete="off" spellcheck={false} value={answers[i] ?? ''} onInput={(e) => setAnswers((was) => was.map((a, j) => (j === i ? (e.target as HTMLInputElement).value : a)))} />
                  )}
                </span>
              </label>
            ))}
            <div class="dlg-actions gap-top">
              <Button id="first-visit-answers-cancel" glyph="close" onClick={props.onClose}>Don't answer</Button>
              <Button id="first-visit-answers-go" tone="go" type="submit" glyph="check">Answer</Button>
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

        {!asking && !working && !answering && (
          <div class="dlg-actions gap-top">
            <Button id="first-visit-close" tone="go" hold={close} onClick={props.onClose}>Done</Button>
          </div>
        )}
      </div>
    </div>
  );
}
