// The read-only viewer: a file from the box, shown in the tab, with zoom and a search through it. Nothing is
// edited and nothing is ever written back to a box (agreed 2026-11-15: hand edits on live boxes are against
// the owner's own rules, and a viewer that can save is one slip away from being an editor).
//
// What arrives is bytes, not text, and a box chooses them. So they are shown as text only when they really are
// text; anything else says what it is instead of drawing a screenful of nonsense. Every line is set as text, so
// no file can be markup.
import type { FilePage, TabPort } from '../common/ipc';
import { glyph, size, type Asker } from './files';

// How a file's bytes are judged. A file with a zero byte in it is not text, and so is one whose bytes are not
// valid UTF-8: both would come out as replacement characters, which tells a person nothing.
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const ZOOM = [10, 11, 12, 13, 14, 16, 18, 20, 24];

export interface Viewer {
  open(path: string, name: string, bytes: number): void;
  close(): void;
  isOpen(): boolean;
}

export function startViewer(at: HTMLElement, port: TabPort, asker: Asker): Viewer {
  let asking = 0;
  let pieces: Uint8Array[] = [];
  let read = 0;
  let more = false;
  let busy = false;
  let why = '';
  let text: string | null = null;
  let path = '';
  let name = '';
  let bytes = 0;
  let zoom = 3; // an index into ZOOM
  let find = '';
  let at_ = 0; // which hit is in view

  const el = {
    back: document.createElement('div'),
    box: document.createElement('div'),
    head: document.createElement('div'),
    title: document.createElement('div'),
    tools: document.createElement('div'),
    search: document.createElement('input'),
    body: document.createElement('div'),
    foot: document.createElement('div'),
  };
  el.back.className = 'vw-back';
  el.back.id = 'viewer';
  el.box.className = 'vw-box';
  el.head.className = 'vw-head';
  el.title.className = 'vw-title';
  el.title.id = 'vw-title';
  el.tools.className = 'vw-tools';
  el.search.className = 'vw-search';
  el.search.id = 'vw-search';
  el.search.type = 'text';
  el.search.placeholder = 'Find';
  el.search.spellcheck = false;
  el.body.className = 'vw-body';
  el.body.id = 'vw-body';
  el.foot.className = 'vw-foot';
  el.foot.id = 'vw-foot';

  // Every button carries the app's own glyph and says what it is for whoever cannot see it (BUILD-RULES 2.1
  // and 2.16). Nothing here is a bare character standing in for a drawing.
  const button = (id: string, kind: string, label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vw-btn';
    b.id = id;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(glyph(kind));
    b.addEventListener('click', run);
    return b;
  };

  const findWrap = document.createElement('span');
  findWrap.className = 'vw-find';
  findWrap.append(glyph('find'), el.search);
  el.tools.append(
    findWrap,
    button('vw-prev', 'up', 'The match before this one', () => step(-1)),
    button('vw-next', 'down', 'The next match', () => step(1)),
    button('vw-out', 'zoomOut', 'Smaller', () => setZoom(zoom - 1)),
    button('vw-in', 'zoomIn', 'Bigger', () => setZoom(zoom + 1)),
    button('vw-close', 'close', 'Close the viewer', () => close()),
  );
  el.head.append(el.title, el.tools);
  el.box.append(el.head, el.body, el.foot);
  el.back.append(el.box);

  const setZoom = (n: number) => {
    zoom = Math.max(0, Math.min(ZOOM.length - 1, n));
    el.body.style.fontSize = `${ZOOM[zoom]}px`;
    draw();
  };

  const close = () => {
    if (asking !== 0) asker.ask({ id: asking, do: 'cancel', path: '' });
    asking = 0;
    pieces = [];
    text = null;
    find = '';
    el.search.value = '';
    el.back.remove();
  };

  const open = (p: string, n: string, b: number) => {
    path = p;
    name = n;
    bytes = b;
    pieces = [];
    read = 0;
    more = false;
    why = '';
    text = null;
    find = '';
    at_ = 0;
    busy = true;
    el.search.value = '';
    at.append(el.back);
    el.body.style.fontSize = `${ZOOM[zoom]}px`;
    draw();
    asking = asker.ask({ do: 'read', path: p });
  };

  port.onFilePage((pg: FilePage) => {
    if (pg.id !== asking || asking === 0) return;
    if (typeof pg.data === 'string' && pg.data !== '') {
      const raw = Uint8Array.from(atob(pg.data), (c) => c.charCodeAt(0));
      pieces.push(raw);
      read += raw.byteLength;
    }
    if (pg.more) more = true;
    if (pg.error) why = pg.error === 'denied' ? 'This account may not read that file' : pg.error === 'no-such-file' ? 'That file is not there' : 'That file could not be read';
    if (pg.done) {
      busy = false;
      const all = new Uint8Array(read);
      let put = 0;
      for (const p of pieces) {
        all.set(p, put);
        put += p.byteLength;
      }
      pieces = [];
      text = why === '' ? asText(all) : null;
    }
    draw();
  });

  const hits = (): number => {
    if (text === null || find === '') return 0;
    let n = 0;
    let from = 0;
    const hay = text.toLowerCase();
    const needle = find.toLowerCase();
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      n++;
      from = i + needle.length;
    }
    return n;
  };

  const step = (by: number) => {
    const n = hits();
    if (n === 0) return;
    at_ = (at_ + by + n) % n;
    draw();
    const mark = el.body.querySelector('.vw-hit.now');
    mark?.scrollIntoView({ block: 'center' });
  };

  el.search.addEventListener('input', () => {
    find = el.search.value;
    at_ = 0;
    draw();
  });

  const draw = () => {
    el.title.textContent = name;
    el.title.title = path;

    el.body.replaceChildren();
    if (why !== '') {
      const f = document.createElement('div');
      f.className = 'vw-why';
      f.id = 'vw-why';
      f.textContent = why;
      el.body.append(f);
    } else if (busy) {
      const w = document.createElement('div');
      w.className = 'vw-why quiet';
      w.textContent = 'Reading it';
      el.body.append(w);
    } else if (text === null) {
      const f = document.createElement('div');
      f.className = 'vw-why quiet';
      f.id = 'vw-not-text';
      f.textContent = 'This is not a text file, so Berth does not draw it.';
      el.body.append(f);
    } else {
      el.body.append(drawText(text, find, at_));
    }

    const bits = [name, size(bytes)];
    if (text !== null) bits.push(`${text.split('\n').length} lines`);
    if (more) bits.push(`the first ${size(read)} only`);
    if (find !== '' && text !== null) {
      const n = hits();
      bits.push(n === 0 ? 'no match' : `${at_ + 1} of ${n}`);
    }
    el.foot.textContent = bits.join('   ·   ');
  };

  // The file's own text, with every match of the search marked. It is built out of text nodes and marks, never
  // out of markup: a file is a box's to write, and nothing in it is ever read as anything but characters.
  const drawText = (all: string, needle: string, which: number): DocumentFragment => {
    const frag = document.createDocumentFragment();
    const pre = document.createElement('pre');
    pre.className = 'vw-pre';
    if (needle === '') {
      pre.textContent = all;
      frag.append(pre);
      return frag;
    }
    const hay = all.toLowerCase();
    const low = needle.toLowerCase();
    let from = 0;
    let n = 0;
    for (;;) {
      const i = hay.indexOf(low, from);
      if (i < 0) break;
      pre.append(document.createTextNode(all.slice(from, i)));
      const mark = document.createElement('span');
      mark.className = `vw-hit ${n === which ? 'now' : ''}`;
      mark.textContent = all.slice(i, i + needle.length);
      pre.append(mark);
      from = i + needle.length;
      n++;
    }
    pre.append(document.createTextNode(all.slice(from)));
    frag.append(pre);
    return frag;
  };

  // Escape closes it; the zoom keys work while it is open, as they do in the terminal.
  window.addEventListener('keydown', (e) => {
    if (!el.back.isConnected) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      setZoom(zoom + 1);
    } else if (e.ctrlKey && e.key === '-') {
      e.preventDefault();
      setZoom(zoom - 1);
    } else if (e.ctrlKey && e.key === '0') {
      e.preventDefault();
      setZoom(3);
    } else if (e.key === 'Enter' && document.activeElement === el.search) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });

  return { open, close, isOpen: () => el.back.isConnected };
}
