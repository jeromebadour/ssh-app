// What a tab draws around its terminal, as the approved pictures show it: the stages while it opens, the one
// folded line of what the box said at sign-in, and the amber bar when the link goes quiet or is gone.
// Every word here is Berth's. The box's own words appear only inside the terminal, through term.words.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { TabInfo } from '../common/ipc';
import { bar, folded, stages, type Folded, type Stage } from './states';

export interface Chrome {
  info: TabInfo | null;
  since: Record<string, number>; // when this window first saw each phase
  endedAt: number; // when it saw the link end
  againIn: number; // when a new session opens, 0 when none is coming
  signIn: Folded | null; // the box's sign-in text, folded
  signInOpen: boolean;
  onReconnect(): void;
  onCancel(): void;
  onOpenSignIn(open: boolean): void;
}

function Mark({ mark }: { mark: Stage['mark'] }) {
  if (mark === 'done') {
    return (
      <svg class="mark done" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 8.5 6.4 12 13 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }
  if (mark === 'now') {
    return (
      <svg class="mark now" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="20 14" stroke-linecap="round" />
      </svg>
    );
  }
  return (
    <svg class="mark waiting" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="currentColor" />
    </svg>
  );
}

function Opening({ info, since }: { info: TabInfo; since: Record<string, number> }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const t = setInterval(() => redraw((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  const rows = stages(info, since, performance.now());
  return (
    <div class="opening">
      <h1>
        <svg class="mark now" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="4" fill="currentColor" />
        </svg>
        Opening {info.box?.name}
        {info.box?.place ? `, ${info.box.place}` : ''}
      </h1>
      <ul>
        {rows.map((s) => (
          <li key={s.key} data-mark={s.mark}>
            <Mark mark={s.mark} />
            <span class="said">{s.said}</span>
            <span class="aside">{s.aside}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SignIn({ box, said, open, onOpen }: { box: string; said: Folded; open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <button type="button" class="signin" id="signin" aria-expanded={open} onClick={() => onOpen(!open)}>
      <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.5 3.5h11v7.5h-6.2L4 14v-3H2.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      </svg>
      <span class="said">
        {box} said {said.lines} {said.lines === 1 ? 'line' : 'lines'} at sign-in
      </span>
      {said.notice === '' ? null : <span class="notice">*** {said.notice} ***</span>}
      <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d={open ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  );
}

function Quiet({ said, rest, aside, onReconnect }: { said: string; rest: string; aside: string; onReconnect: () => void }) {
  return (
    <div class="bar quiet" id="bar" role="status">
      <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 13.5v-3m4 3V8m4 5.5V5.5m4 8v-11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <span class="words">
        <b>{said}</b> {rest}
      </span>
      <span class="aside">{aside}</span>
      <button type="button" id="reconnect" onClick={onReconnect}>
        <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.2 7.2A5.2 5.2 0 1 1 11.6 3.6M13 1.6v3.1h-3.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Reconnect<kbd>R</kbd>
      </button>
    </div>
  );
}

function Gone({ said, rest, again, onReconnect, onCancel }: { said: string; rest: string; again: boolean; onReconnect: () => void; onCancel: () => void }) {
  return (
    <div class="bar gone" id="bar" role="status">
      <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.2 7.2A5.2 5.2 0 1 1 11.6 3.6M13 1.6v3.1h-3.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="words">
        <b>{said}</b> {rest}
      </span>
      <button type="button" id="reconnect" onClick={onReconnect}>
        <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.2 7.2A5.2 5.2 0 1 1 11.6 3.6M13 1.6v3.1h-3.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {again ? 'Now' : 'Reconnect'}
        <kbd>R</kbd>
      </button>
      {again ? (
        <button type="button" id="cancel" onClick={onCancel}>
          <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          Cancel
        </button>
      ) : null}
    </div>
  );
}

function View(c: Chrome) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const t = setInterval(() => redraw((n) => n + 1), 200);
    return () => clearInterval(t);
  }, []);
  if (!c.info) return null;
  const l = c.info.link;
  const opening = !!c.info.box && (l.phase === 'connecting' || l.phase === 'key-exchange' || l.phase === 'signing-in' || (l.phase === 'none' && c.info.state !== 'gone'));
  if (opening) return <Opening info={c.info} since={c.since} />;
  const b = bar(c.info, Date.now(), c.endedAt, c.againIn);
  return (
    <>
      {c.signIn && b.kind === 'none' ? <SignIn box={c.info.box?.name ?? 'the box'} said={c.signIn} open={c.signInOpen} onOpen={c.onOpenSignIn} /> : null}
      {b.kind === 'quiet' ? <Quiet said={b.said} rest={b.rest} aside={b.aside} onReconnect={c.onReconnect} /> : null}
      {b.kind === 'gone' ? <Gone said={b.said} rest={b.rest} again={c.againIn > 0} onReconnect={c.onReconnect} onCancel={c.onCancel} /> : null}
    </>
  );
}

export function drawChrome(where: HTMLElement, c: Chrome): void {
  render(<View {...c} />, where);
}

export { folded };
