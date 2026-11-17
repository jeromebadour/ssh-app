// The tab's own file browser: the box's files, beside its terminal, on the file channel of its own.
//
// Nothing here waits on the network. A listing arrives a page at a time and each page is drawn as it comes, so
// the first rows of a folder with thousands of files are on screen while the rest are still being read. Moving
// to another folder abandons the listing that was running, and its late pages are dropped by their number
// rather than drawn over the new one.
import type { FileAsk, FilePage, FileRow, TabPort } from '../common/ipc';

// What the window says for each way a listing can stop. A box's own words are never shown: it chooses them.
const WHY: Record<string, string> = {
  'no-such-file': 'That folder is not there',
  denied: 'This account may not read that folder',
  'too-many': 'More files than Berth will read from one folder',
  unsupported: 'This box has no file subsystem',
  'no-answer': 'The box did not answer',
  'no-link': 'There is no link to the box',
  failed: 'That folder could not be read',
};

export interface Files {
  open(path: string): void; // list this folder
  shown(): string; // the folder on screen now, as the box names it
  rows(): number;
  draw(): void;
}

export function startFiles(at: HTMLElement, port: TabPort): Files {
  let asking = 0; // the number of the listing being drawn; pages of any other are dropped
  let next = 1;
  let where = ''; // the folder as the box itself names it
  let asked = ''; // what was asked for, until the box says what it really is
  let rows: FileRow[] = [];
  let why = '';
  let busy = false;
  let space: { total: number; free: number } | null = null;

  const el = {
    path: document.createElement('div'),
    list: document.createElement('div'),
    foot: document.createElement('div'),
  };
  el.path.className = 'fb-path';
  el.list.className = 'fb-list';
  el.list.id = 'fb-list';
  el.foot.className = 'fb-foot';
  el.foot.id = 'fb-foot';
  at.append(el.path, el.list, el.foot);

  const ask = (a: FileAsk) => port.files(a);

  const open = (path: string) => {
    if (asking !== 0) ask({ id: asking, do: 'cancel', path: '' }); // the one running is abandoned, not read on
    asking = next++;
    asked = path;
    where = '';
    rows = [];
    why = '';
    space = null;
    busy = true;
    draw();
    ask({ id: asking, do: 'list', path });
  };

  port.onFilePage((p: FilePage) => {
    if (p.id !== asking) return; // a page of a listing already left behind
    if (typeof p.where === 'string') where = p.where;
    if (p.space) space = p.space;
    if (p.rows && p.rows.length > 0) {
      rows = rows.concat(p.rows);
      sort(rows);
    }
    if (p.error) why = WHY[p.error] ?? WHY['failed']!;
    if (p.done) busy = false;
    draw();
  });

  // Folders first, then files, each by name as a person reads them: 10 after 9, and case ignored.
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sort = (r: FileRow[]) => {
    r.sort((a, b) => {
      const af = a.kind === 'folder' ? 0 : 1;
      const bf = b.kind === 'folder' ? 0 : 1;
      return af !== bf ? af - bf : collator.compare(a.name, b.name);
    });
  };

  const draw = () => {
    const here = where || asked;
    // A long path is cut in the middle, keeping its start and its end: the end says which folder this is and
    // the start says which disk it is on. It is cut here rather than by the stylesheet, because leaning on a
    // text direction to cut from the left moves the leading "/" to the other end of the line.
    el.path.textContent = shorten(here, 46);
    el.path.title = here;

    el.list.replaceChildren();
    if (why !== '') {
      const fault = document.createElement('div');
      fault.className = 'fb-why';
      fault.id = 'fb-why';
      fault.textContent = why;
      el.list.append(fault);
    } else if (rows.length === 0) {
      const none = document.createElement('div');
      none.className = 'fb-why quiet';
      none.id = 'fb-empty';
      none.textContent = busy ? 'Reading the folder' : 'This folder is empty';
      el.list.append(none);
    } else {
      const frag = document.createDocumentFragment();
      // One row above, when there is one: the window's own way up, rather than a "..' among the files.
      const up = parent(here);
      if (up !== '') {
        frag.append(row({ name: '..', kind: 'folder', size: 0, mode: 0, mtime: 0 }, () => open(up), 'fb-up'));
      }
      for (const r of rows) {
        frag.append(row(r, r.kind === 'folder' ? () => open(join(here, r.name)) : undefined));
      }
      el.list.append(frag);
    }

    el.foot.replaceChildren();
    const bits: string[] = [`${rows.length} ${rows.length === 1 ? 'item' : 'items'}${busy ? ', reading' : ''}`];
    if (space) bits.push(`${size(space.free)} free of ${size(space.total)}`);
    for (const [i, b] of bits.entries()) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'fb-sep';
        el.foot.append(sep);
      }
      const part = document.createElement('span');
      part.textContent = b;
      el.foot.append(part);
    }
  };

  const row = (r: FileRow, enter: (() => void) | undefined, id?: string) => {
    const e = document.createElement('div');
    e.className = `fb-row fb-${r.kind}`;
    if (id) e.id = id;
    e.dataset['name'] = r.name;
    e.dataset['kind'] = r.kind;
    e.append(glyph(id === 'fb-up' ? 'up' : r.kind));
    const name = document.createElement('span');
    name.className = 'fb-name';
    // A name is data, never markup: it is set as text and nothing else, however it is written.
    name.textContent = r.name;
    name.title = r.name;
    const right = document.createElement('span');
    right.className = 'fb-size';
    right.textContent = r.kind === 'folder' ? '' : r.kind === 'file' ? size(r.size) : r.kind;
    e.append(name, right);
    if (enter) {
      e.classList.add('fb-can-enter');
      e.addEventListener('dblclick', enter);
    }
    return e;
  };

  return {
    open,
    shown: () => where,
    rows: () => rows.length,
    draw,
  };
}

// The folder above this one, or nothing at the very top.
function parent(p: string): string {
  if (p === '' || p === '/') return '';
  const cut = p.replace(/\/+$/, '').lastIndexOf('/');
  if (cut < 0) return '';
  return cut === 0 ? '/' : p.slice(0, cut);
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// Sizes as decided: 812 B, 23.4 KB, 9.8 GB; one decimal under 100, none above.
export function size(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1000;
  let at = 0;
  while (v >= 1000 && at < units.length - 1) {
    v /= 1000;
    at++;
  }
  return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${units[at]}`;
}


// A path cut in the middle, keeping both ends: "/srv/.../ledger/logs".
export function shorten(p: string, most: number): string {
  if (p.length <= most) return p;
  const keepEnd = Math.max(8, Math.floor((most - 3) * 0.6));
  const keepStart = most - 3 - keepEnd;
  return `${p.slice(0, keepStart)}\u2026${p.slice(p.length - keepEnd)}`;
}

// The app's own glyphs, drawn for this pane: each kind of thing in a folder says what it is without reading
// (BUILD-RULES 2.1). They are built here rather than taken from the window's set, because a tab's page holds
// no part of the window.
const SHAPES: Record<string, string> = {
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v7h-11z',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  link: 'M6.5 9.5l3-3M5.5 7.5l-1 1a2.1 2.1 0 0 0 3 3l1-1M10.5 8.5l1-1a2.1 2.1 0 0 0-3-3l-1 1',
  pipe: 'M3 8h4a2 2 0 0 1 2 2v3M13 8H9',
  device: 'M3.5 3.5h9v9h-9zM6 6h4v4H6',
  socket: 'M8 2.5v4M4.5 6.5h7v3a3.5 3.5 0 0 1-7 0zM8 13v1.5',
  unknown: 'M8 11.5v.25M6.2 6a1.8 1.8 0 1 1 1.8 2.2v1',
  up: 'M8 12.5V4M4.5 7.5L8 4l3.5 3.5',
};

function glyph(kind: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'fb-glyph');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', SHAPES[kind] ?? SHAPES['unknown']!);
  svg.append(path);
  return svg;
}
