// Where a tab's link stands, in words, as the approved pictures show it (SSH-APP-DETAILS section 8).
// This file decides what to say; tab.ts draws it. Nothing here comes from a box: every word is Berth's, and
// the few things a box gives (its address, the cause of an ending) are shown as the inert text they are.
import type { TabInfo } from '../common/ipc';
import { ending } from '../common/link-words';

export type StageMark = 'done' | 'now' | 'waiting';

export interface Stage {
  key: string;
  said: string;
  mark: StageMark;
  aside: string; // the quiet value at the end of the row: a time, an algorithm, a kind of key
}

// The stages of opening a tab, as the picture lists them. `since` is when each phase was first seen here, so
// the times are what this window saw, not what a box claimed.
export function stages(info: TabInfo, since: Record<string, number>, now: number): Stage[] {
  const box = info.box;
  const l = info.link;
  const order = ['connecting', 'key-exchange', 'signing-in', 'up'];
  const reached = order.indexOf(l.phase === 'ended' ? l.endedIn || 'connecting' : l.phase);
  const mark = (n: number): StageMark => (reached > n ? 'done' : reached === n ? 'now' : 'waiting');
  const took = (from: string, to: string): string => {
    const a = since[from];
    const b = since[to] ?? now;
    if (a === undefined || b <= a) return '';
    const ms = b - a;
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  };
  return [
    { key: 'connected', said: `Connected to ${box?.addr ?? 'the box'}`, mark: mark(0), aside: mark(0) === 'waiting' ? '' : took('connecting', 'key-exchange') },
    { key: 'identity', said: `Identity matches the one pinned for ${box?.name ?? 'this box'}`, mark: mark(1) === 'now' ? 'now' : mark(1), aside: mark(1) === 'done' ? box?.pinType ?? '' : '' },
    { key: 'keys', said: l.keyExchange !== '' && !l.postQuantum ? 'Keys agreed' : 'Keys agreed, post-quantum', mark: mark(1), aside: l.keyExchange === '' ? '' : `${l.keyExchange.replace('-sha256', '')}, ${l.cipher.replace('@openssh.com', '')}` },
    { key: 'signing', said: `Signing in as ${box?.user ?? 'the user'} with Berth’s key for ${box?.name ?? 'this box'}`, mark: mark(2), aside: mark(2) === 'waiting' ? '' : took('signing-in', 'up') },
    { key: 'shell', said: box?.folder ? `Shell in ${box.folder}` : 'Shell', mark: mark(3), aside: '' },
  ];
}

export interface Bar {
  kind: 'none' | 'quiet' | 'gone';
  said: string; // the first words, in weight
  rest: string; // the rest of the line
  aside: string; // the quiet line at the end, before the buttons
}

// The bar over the terminal: nothing while a link is plainly up, amber while it is silent or gone.
// `endedAt` is when this window saw the link end, so the time is one this window can vouch for.
export function bar(info: TabInfo, now: number, endedAt: number, againIn: number): Bar {
  const l = info.link;
  if (!info.box) return { kind: 'none', said: '', rest: '', aside: '' };
  if (l.phase === 'up' && l.silentSinceMs > 0) {
    // silentSinceMs is when the silence began, not how long it has lasted.
    const s = Math.max(1, Math.round((now - l.silentSinceMs) / 1000));
    return {
      kind: 'quiet',
      said: `No answer for ${s} s.`,
      rest: 'The link is kept: the shell and whatever is running are still there on the box.',
      aside: 'ends by itself only after 10 min of silence',
    };
  }
  if (l.phase === 'ended' || info.state === 'gone') {
    const e = ending(l.cause);
    const at = endedAt > 0 ? ` at ${clock(endedAt)}` : '';
    const again = againIn > 0 ? ` A new session opens in ${Math.max(1, Math.round((againIn - now) / 1000))} s${info.box.folder ? `, in ${info.box.folder}` : ''}.` : '';
    return { kind: 'gone', said: 'The link is gone:', rest: `${e.said}${at}. ${e.meant}${again}`.replace(/\s+/g, ' ').trim(), aside: '' };
  }
  return { kind: 'none', said: '', rest: '', aside: '' };
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// The sign-in text a box printed, folded into one line: how many lines it was, and the one line in it that is
// a real notice, lifted onto the fold so it is not missed. Both are the box's words, kept inert (term.words).
export interface Folded {
  lines: number;
  notice: string;
}

const NOTICE = /^(?:\s*\*{2,}\s*(?<stars>[^*]{3,80}?)\s*\*{2,}\s*|\s*(?<plain>(?:System restart required|Your system is booting up|\d+ (?:update|package)s? can be (?:applied|updated)|New release '[^']{1,40}' available)[^\n]{0,60}))$/;

export function folded(text: string): Folded {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  let notice = '';
  for (const line of lines) {
    const m = NOTICE.exec(line);
    const said = m?.groups?.['stars'] ?? m?.groups?.['plain'] ?? '';
    if (said !== '' && notice === '') notice = said.trim().slice(0, 80);
  }
  return { lines: lines.length, notice };
}
