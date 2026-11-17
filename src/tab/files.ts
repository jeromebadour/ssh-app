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

// Every ask on the tab's one file channel takes a number from here, so the browser and the viewer can both
// use it and each knows which pages are its own.
export interface Asker {
  ask(a: Omit<FileAsk, 'id'> & { id?: number }): number;
}

export function makeAsker(port: TabPort): Asker {
  let next = 1;
  return {
    ask(a) {
      const id = a.id && a.id > 0 ? a.id : next++;
      port.files({ id, do: a.do, path: a.path });
      return id;
    },
  };
}

export interface Files {
  open(path: string): void; // list this folder
  shown(): string; // the folder on screen now, as the box names it
  rows(): number;
  draw(): void;
}

export function startFiles(at: HTMLElement, port: TabPort, asker: Asker, openFile: (path: string, name: string, bytes: number) => void): Files {
  let asking = 0; // the number of the listing being drawn; pages of any other are dropped
  let where = ''; // the folder as the box itself names it
  let asked = ''; // what was asked for, until the box says what it really is
  let rows: FileRow[] = [];
  let why = '';
  let busy = false;
  let space: { total: number; free: number } | null = null;
  // Where the keyboard stands in the list, held by the name of the row rather than by its number: pages keep
  // arriving and the sort moves rows about, and a person's place should not move with them.
  let standing = '';
  let said = ''; // the answer to a press that opened nothing, shown on the foot until the place moves

  const el = {
    path: document.createElement('div'),
    list: document.createElement('div'),
    foot: document.createElement('div'),
  };
  el.path.className = 'fb-path';
  el.list.className = 'fb-list';
  el.list.id = 'fb-list';
  el.list.setAttribute('role', 'listbox');
  el.list.setAttribute('aria-label', 'Files on the box');
  el.foot.className = 'fb-foot';
  el.foot.id = 'fb-foot';
  at.append(el.path, el.list, el.foot);

  const ask = (a: FileAsk) => asker.ask(a);

  const open = (path: string, keepTries = 0) => {
    if (trying) {
      clearTimeout(trying);
      trying = null;
    }
    tried = keepTries;
    if (asking !== 0) ask({ id: asking, do: 'cancel', path: '' }); // the one running is abandoned, not read on
    asking = asker.ask({ do: 'list', path });
    asked = path;
    where = '';
    rows = [];
    why = '';
    space = null;
    busy = true;
    standing = '';
    said = '';
    draw();
  };

  // A listing can fail for a reason that is nothing to do with the folder: the first ask can land in the
  // moment before the link is ready, or the box can be busy. Those are tried again, a few times, a moment
  // apart, and the window says it is trying rather than leaving a person looking at a dead list with no way
  // to ask again. A reason that is the folder's own (it is not there, this account may not read it) is the
  // answer, and is not tried again.
  const WORTH_ANOTHER_TRY = new Set(['unsupported', 'no-link', 'no-answer', 'failed']);
  const TRIES = 3;
  let tried = 0;
  let trying: ReturnType<typeof setTimeout> | null = null;

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
    if (p.error && WORTH_ANOTHER_TRY.has(p.error) && rows.length === 0 && tried < TRIES) {
      tried++;
      why = `${why}. Trying again (${tried} of ${TRIES})`;
      const folder = asked;
      trying = setTimeout(() => {
        trying = null;
        if (asked === folder) open(folder, tried);
      }, 1200);
    }
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
    const hadFocus = el.list.contains(document.activeElement);
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
        // A folder is gone into; a file is opened in the viewer, read-only. Anything else is neither, and is
        // shown with what it is rather than opened at all (plan B4.1).
        const enter = r.kind === 'folder' ? () => open(join(here, r.name)) : r.kind === 'file' ? () => openFile(join(here, r.name), r.name, r.size) : undefined;
        frag.append(row(r, enter));
      }
      el.list.append(frag);
    }

    // Where the keyboard stands is settled from the rows that are really on screen, and from nothing else.
    // Working it out twice, once here and once from the list the rows came from, is how the two come to
    // disagree: pages keep arriving and the sort moves rows about, and a list with no tab stop in it cannot be
    // reached by Tab at all. A name that has gone falls back to the first row.
    const drawn = [...el.list.querySelectorAll<HTMLElement>('.fb-row')];
    if (!drawn.some((e) => e.dataset['name'] === standing)) standing = drawn[0]?.dataset['name'] ?? '';
    for (const e of drawn) {
      const holds = e.dataset['name'] === standing;
      e.tabIndex = holds ? 0 : -1;
      e.setAttribute('aria-selected', String(holds));
    }
    if (hadFocus) drawn.find((e) => e.tabIndex === 0)?.focus();

    el.foot.replaceChildren();
    const bits: string[] = [`${rows.length} ${rows.length === 1 ? 'item' : 'items'}${busy ? ', reading' : ''}`];
    if (space) bits.push(`${size(space.free)} free of ${size(space.total)}`);
    if (said !== '') bits.push(said);
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
    // Every row is a place the keyboard can stand. Which one holds the tab stop is settled after the whole
    // list is on screen, not here.
    e.setAttribute('role', 'option');
    e.addEventListener('mousedown', () => place(r.name));
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

  // What a row is for, found from its name: the same thing a double-click on it does.
  const opener = (name: string): (() => void) | undefined => {
    const here = where || asked;
    if (name === '..') {
      const up = parent(here);
      return up === '' ? undefined : () => open(up);
    }
    const r = rows.find((x) => x.name === name);
    if (!r) return undefined;
    if (r.kind === 'folder') return () => open(join(here, r.name));
    if (r.kind === 'file') return () => openFile(join(here, r.name), r.name, r.size);
    return undefined;
  };

  // The names on screen now, in the order they are drawn, which is the order the arrows move through.
  const names = (): string[] => [...el.list.querySelectorAll<HTMLElement>('.fb-row')].map((e) => e.dataset['name'] ?? '');

  // Moving the place redraws the list, and the drawing is what carries the focus to the row that now holds
  // the tab stop: one way of doing it, used by the arrows, by a click and by every page that arrives, rather
  // than a second one here that only some of those would go through.
  const place = (name: string): void => {
    if (name === '' || standing === name) return;
    standing = name;
    said = '';
    draw();
  };

  const step = (by: number): void => {
    const all = names();
    if (all.length === 0) return;
    const now = all.indexOf(standing);
    const want = now < 0 ? (by > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, now + by));
    place(all[want]!);
  };

  // Enter on a row does what a double-click does. A row that is neither a file nor a folder opens nothing and
  // says what it is, rather than leaving the press unanswered.
  const enterHere = (): void => {
    if (standing === '') return;
    const go = opener(standing);
    if (go) {
      go();
      return;
    }
    const r = rows.find((x) => x.name === standing);
    said = r ? `${r.name} is a ${r.kind === 'unknown' ? 'thing Berth does not know' : r.kind}, so it does not open` : 'that row is no longer there';
    draw();
  };

  // The list is reached by the keyboard, not only by a mouse: Tab lands on it, the arrows move inside it, and
  // Enter opens what a double-click would. Anything with Ctrl, Alt or the Windows key is not the list's: those
  // belong to the window itself or to the box.
  el.list.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const all = names();
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Home') place(all[0] ?? '');
    else if (e.key === 'End') place(all[all.length - 1] ?? '');
    else if (e.key === 'PageDown') step(10);
    else if (e.key === 'PageUp') step(-10);
    else if (e.key === 'Enter' || e.key === ' ') enterHere();
    else if (e.key === 'ArrowRight') {
      if (rows.find((x) => x.name === standing)?.kind !== 'folder') return;
      enterHere();
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
      const up = parent(where || asked);
      if (up === '') return;
      open(up);
    } else return;
    e.preventDefault();
  });

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
export const SHAPES: Record<string, string> = {
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v7h-11z',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  link: 'M6.5 9.5l3-3M5.5 7.5l-1 1a2.1 2.1 0 0 0 3 3l1-1M10.5 8.5l1-1a2.1 2.1 0 0 0-3-3l-1 1',
  pipe: 'M3 8h4a2 2 0 0 1 2 2v3M13 8H9',
  device: 'M3.5 3.5h9v9h-9zM6 6h4v4H6',
  socket: 'M8 2.5v4M4.5 6.5h7v3a3.5 3.5 0 0 1-7 0zM8 13v1.5',
  unknown: 'M8 11.5v.25M6.2 6a1.8 1.8 0 1 1 1.8 2.2v1',
  up: 'M8 12.5V4M4.5 7.5L8 4l3.5 3.5',
  down: 'M8 3.5V12M4.5 8.5L8 12l3.5-3.5',
  find: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M10 10l3.5 3.5',
  zoomIn: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M10 10l3.5 3.5M5.2 7H8.8M7 5.2v3.6',
  zoomOut: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M10 10l3.5 3.5M5.2 7H8.8',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
};

export function glyph(kind: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'fb-glyph');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', SHAPES[kind] ?? SHAPES['unknown']!);
  svg.append(path);
  return svg;
}
