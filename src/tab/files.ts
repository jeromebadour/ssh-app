// The tab's own file browser: the box's files, beside its terminal, on the file channel of its own.
//
// Nothing here waits on the network. A listing arrives a page at a time and each page is drawn as it comes, so
// the first rows of a folder with thousands of files are on screen while the rest are still being read. Moving
// to another folder abandons the listing that was running, and its late pages are dropped by their number
// rather than drawn over the new one.
import { whenAs, whenShort } from '../common/when';
import { openMenu, shutMenu, type MenuLine } from './menu';
import { GRAB_MAX, MOST_AT_ONCE, type FileAsk, type FilePage, type FileRow, type TabPort } from '../common/ipc';

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

// What the window says for each way a download can end. As with a listing, a box's own words are never shown.
const DOWNLOAD_WHY: Record<string, string> = {
  'not-a-name': 'That file cannot be given a name on this PC',
  'already-there': 'A file of that name is already here',
  'not-the-same': 'What arrived is not what the box has, so it was not kept',
  'pc-denied': 'The download folder could not be written to',
  'pc-full': 'There is not enough room on this disk',
  'no-such-file': 'That file is not there any more',
  denied: 'This account may not read that file',
  unsupported: 'This box has no file subsystem',
  'no-answer': 'The box did not answer',
  'no-link': 'There is no link to the box',
  stopped: 'It was stopped before it began',
  'link-gone': 'The link to the box went while it was coming over',
  'bigger-than-said': 'The box kept sending past the size it said the file was, so it was stopped',
  failed: 'It could not be brought over',
};

// And for a file sent the other way. The same reasons where they are the same, and its own where they are not.
const SEND_WHY: Record<string, string> = {
  'not-a-name': 'That file cannot be given a name on the box',
  'not-a-folder': 'That is not a folder on the box',
  'in-the-way': 'Something is already there that Berth will not write through',
  'already-there': 'A file of that name is already on the box',
  'box-full': "There is not enough room on the box's disk",
  'not-the-same': 'What arrived on the box is not what was sent, so it was not put in place',
  denied: 'This account may not write there',
  unsupported: 'This box has no file subsystem',
  'no-answer': 'The box did not answer',
  'no-link': 'There is no link to the box',
  'not-now': 'The window is busy with another question',
  'nothing-chosen': 'No file was chosen',
  kept: 'The file on the box was left as it was',
  stopped: 'It was stopped before it began',
  'link-gone': 'The link to the box went while it was going over',
  failed: 'It could not be sent',
};

// What a mark on a finished transfer means, in words. The two ways round are not the same sentence: one says
// what this PC now holds, the other what the box now holds.
const MARK: Record<string, string> = {
  checked: 'checked against the box',
  changed: 'it changed on the box while it was read, so it could not be checked',
  'not-checked': 'the box could not check it',
  '': 'it was not checked',
};

const SENT_MARK: Record<string, string> = {
  checked: 'and the box holds the same file',
  changed: 'but it changed on this PC while it was read, so it could not be checked',
  'not-checked': 'but the box could not check it',
  '': 'but it was not checked',
};

// What the window says for each way a delete, a restore or an emptying can end.
// How long a box's trash keeps things, which is the engine's own number said here so the button can name it.
const TRASH_DAYS = 7;

const TRASH_WHY: Record<string, string> = {
  refused: 'Berth does not delete that',
  'no-trash': 'This disk cannot hold a trash, so nothing here can be deleted',
  'already-there': 'Something of that name is there now, so it was not put back',
  'no-such-file': 'That is not there any more',
  denied: 'This account may not do that',
  unsupported: 'This box has no file subsystem',
  'no-answer': 'The box did not answer',
  'no-link': 'There is no link to the box',
  failed: 'It could not be done',
};

// What the window says for each way a new name, or a new folder, can end.
const NAME_WHY: Record<string, string> = {
  'already-there': 'Something here is already called that',
  'not-a-name': 'That name cannot be used on a box',
  'no-such-file': 'That is not there any more',
  denied: 'This account may not do that here',
  unsupported: 'This box has no file subsystem',
  'no-answer': 'The box did not answer',
  'no-link': 'There is no link to the box',
  failed: 'The box would not do it',
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
      if (a.which) port.files({ id, do: a.do, path: a.path, which: a.which });
      else if (a.name !== undefined) port.files({ id, do: a.do, path: a.path, name: a.name });
      else port.files({ id, do: a.do, path: a.path });
      return id;
    },
  };
}

export interface Files {
  open(path: string): void; // list this folder
  emptyOldTrash(): void; // take what is older than the days this box keeps things out of its trash
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
  // Which rows are chosen, and the row a run of them is measured from. He asked for this against MobaXterm:
  // "i cant do select multiple files like mobaxterm". Names rather than rows, because the list is drawn
  // again on every answer from the box and a kept row would be a row that no longer exists.
  let chosen = new Set<string>();
  let anchor = '';
  let said = ''; // the answer to a press that opened nothing, shown on the foot until the place moves
  // Files being brought over to the PC, by the number of the ask that is bringing each. A tab may be bringing
  // more than one at a time, and the strip at the foot says what each is doing.
  type Bringing = { name: string; way: 'in' | 'out'; got: number; of: number; began: number; at: number; rate: number; landed: string; mark: string; markWhy: string; renamed: string; replaced: boolean; asking: string; tookUpAt: number; ended: string; canDrag: boolean };
  const bringing = new Map<number, Bringing>();
  // Files chosen in one go that have not had their turn yet, and how many were past what one chooser may
  // hand over. Both are main's count, not the window's: the window only says them.
  let waitingToSend = 0;
  let leftBehind = 0;
  // Files fetched only so they can be carried out of the window (plan B4.5). A press on a small file starts
  // one; it is not a download and gets no line of its own in the strip, because a person who presses a row is
  // not asking for a transfer, only reaching for the file.
  const carryReady = new Map<string, number>(); // the box's name for it, and the ask that fetched it
  const carryGoing = new Map<number, string>(); // asks still fetching, by the name they are fetching

  const el = {
    path: document.createElement('div'),
    list: document.createElement('div'),
    foot: document.createElement('div'),
    moving: document.createElement('div'),
  };
  el.path.className = 'fb-path';
  const here = document.createElement('div');
  here.className = 'fb-here';
  // Sending a file into the folder on screen. It sits beside the folder's own name, because that is what it
  // acts on, and it says what it does with a glyph before a word (BUILD-RULES 2.1).
  const sendBtn = document.createElement('button');
  sendBtn.className = 'fb-send';
  sendBtn.id = 'fb-send';
  sendBtn.type = 'button';
  sendBtn.title = 'Send a file from this PC into this folder';
  sendBtn.setAttribute('aria-label', 'Send a file from this PC into this folder');
  sendBtn.append(glyph('send'));
  sendBtn.addEventListener('click', () => send());
  el.list.className = 'fb-list';
  el.list.id = 'fb-list';
  el.list.setAttribute('role', 'listbox');
  el.list.setAttribute('aria-label', 'Files on the box');
  // It holds several at once, and a list that does not say so is read as holding one choice whatever it then
  // does, so the three gestures read as broken rather than as working.
  el.list.setAttribute('aria-multiselectable', 'true');
  el.foot.className = 'fb-foot';
  el.foot.id = 'fb-foot';
  el.moving.className = 'fb-moving';
  el.moving.id = 'fb-moving';
  // The trash of the disk this folder is on. It sits beside the folder's name because it belongs to the disk
  // that folder is on, not to the window.
  const binBtn = document.createElement('button');
  binBtn.className = 'fb-send';
  binBtn.id = 'fb-bin';
  binBtn.type = 'button';
  binBtn.title = "What has been deleted on this disk, and can be brought back";
  binBtn.setAttribute('aria-label', 'The trash on this disk');
  binBtn.append(glyph('bin'));
  // One way out of the trash, because the button and the menu both offer it and two ways to leave a view is
  // how a view ends up half-left.
  const shutTrash = (): void => {
    bin = { open: false, where: '', rows: [], busy: false, said: bin.said };
    draw();
  };
  binBtn.addEventListener('click', () => {
    if (bin.open) shutTrash();
    else openTrash();
  });
  // A new folder in the folder on screen. It sits with the other two that act on this folder, and like them
  // it says what it does with a glyph alone, because all three are the same size and sit side by side.
  const newBtn = document.createElement('button');
  newBtn.className = 'fb-send';
  newBtn.id = 'fb-newfolder';
  newBtn.type = 'button';
  newBtn.title = 'Make a new folder in this folder';
  newBtn.setAttribute('aria-label', 'Make a new folder in this folder');
  newBtn.append(glyph('newfolder'));
  newBtn.addEventListener('click', () => askForFolder());
  // Narrowing the list to what is being looked for, and saying what the list is ordered by. Both sit on a
  // strip of their own under the folder's name: putting them beside it would push the folder's name about as
  // the order changed, and the folder's name is the one thing on this pane that must not move.
  const tools = document.createElement('div');
  tools.className = 'fb-tools';
  const find = document.createElement('div');
  find.className = 'fb-find';
  find.append(glyph('search'));
  const findField = document.createElement('input');
  findField.type = 'text';
  findField.id = 'fb-find';
  findField.className = 'fb-find-field';
  findField.placeholder = 'Find in this folder';
  findField.setAttribute('aria-label', 'Show only things whose name holds this');
  findField.spellcheck = false;
  findField.autocomplete = 'off';
  findField.addEventListener('input', () => {
    only = findField.value;
    standing = ''; // the row the keyboard stood on may be hidden now; it is settled again from what is drawn
    chosen = new Set(); // and nothing of the folder just left stays chosen in the one just opened
    anchor = '';
    draw();
  });
  // Escape clears it and gives the list back, which is the way out a person reaches for first.
  findField.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || only === '') return;
    e.preventDefault();
    e.stopPropagation();
    only = '';
    findField.value = '';
    draw();
  });
  const clearFind = document.createElement('button');
  clearFind.className = 'fb-stop';
  clearFind.id = 'fb-find-clear';
  clearFind.type = 'button';
  clearFind.title = 'Show everything in this folder again';
  clearFind.setAttribute('aria-label', 'Show everything in this folder again');
  clearFind.append(glyph('close'));
  clearFind.addEventListener('click', () => {
    only = '';
    findField.value = '';
    findField.focus();
    draw();
  });
  find.append(findField, clearFind);
  // One button a column: pressing the one already in use turns the order around, which is how every file list
  // a person has used behaves (BUILD-RULES 2.13: reuse, never reinvent).
  const byBtns: { what: By; btn: HTMLButtonElement }[] = (['name', 'size', 'changed'] as By[]).map((what) => {
    const btn = document.createElement('button');
    btn.className = 'fb-by';
    btn.id = `fb-by-${what}`;
    btn.type = 'button';
    btn.append(glyph(what === 'name' ? 'name' : what === 'size' ? 'size' : 'clock'));
    const label = document.createElement('span');
    label.textContent = what === 'name' ? 'Name' : what === 'size' ? 'Size' : 'Modified';
    btn.append(label);
    btn.addEventListener('click', () => {
      // The same column again turns the order around; another column starts it the way that column is usually
      // read: names from A, sizes biggest first, times newest first.
      if (by === what) down = !down;
      else {
        by = what;
        down = what !== 'name';
      }
      sort(rows);
      draw();
    });
    return { what, btn };
  });
  tools.append(find);
  // The heads of the columns, each one over the column it orders, which is where every file list a person has
  // used puts them. They were buttons in the tools row before, so a list of files had no columns at all and
  // the one column on the right said whatever the order was, which is a column that cannot be read against
  // anything. The ids are the ones they already had, because what they do has not changed.
  const head = document.createElement('div');
  head.className = 'fb-head';
  head.id = 'fb-head';
  const headSpacer = document.createElement('span');
  headSpacer.className = 'fb-head-glyph';
  head.append(headSpacer, ...byBtns.map((b) => b.btn));
  const wayBtn = (what: 'back' | 'forward', title: string, press: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'fb-way';
    b.id = `fb-${what}`;
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(glyph(what === 'back' ? 'wayBack' : 'wayForward'));
    b.addEventListener('click', press);
    return b;
  };
  let recentOpen = false;
  const recentBtn = document.createElement('button');
  recentBtn.className = 'fb-way fb-recent-btn';
  recentBtn.id = 'fb-recent';
  recentBtn.type = 'button';
  recentBtn.title = 'The folders this tab has been in';
  recentBtn.setAttribute('aria-label', 'The folders this tab has been in');
  recentBtn.append(glyph('recent'));
  recentBtn.addEventListener('click', () => {
    recentOpen = !recentOpen;
    said = '';
    draw();
  });
  const backBtn = wayBtn('back', 'The folder before this one (Alt and left, or the mouse\'s own back button)', () => back());
  const fwdBtn = wayBtn('forward', 'Forward again (Alt and right, or the mouse\'s own forward button)', () => forward());
  here.append(backBtn, fwdBtn, el.path, recentBtn, binBtn, newBtn, sendBtn);
  const recentAt = document.createElement('div');
  recentAt.className = 'fb-recent-menu';
  recentAt.id = 'fb-recent-menu';
  // The heads and the rows are wrapped in one thing, because what gives way when there is not enough room
  // across is measured against the list's own size, and the pane holds other rows that the zoom never touches.
  const grid = document.createElement('div');
  grid.className = 'fb-grid';
  grid.id = 'fb-grid';
  grid.append(head, el.list);
  at.append(here, recentAt, tools, grid, el.moving, el.foot);

  // ---- How big this pane's text is ----
  // His own words about MobaXterm: the terminal zooms and the file browser does not, and that annoys him.
  // The pane has its own size, apart from the terminal's, because the two are read for different things: a
  // folder of long names wants room across, a terminal wants lines down. It is this tab's own and lasts as
  // long as the tab; keeping it between runs comes with the settings.
  const SIZES = [0.75, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
  let sizeAt = SIZES.indexOf(1);
  const setSize = (to: number, say: boolean): void => {
    const next = Math.min(SIZES.length - 1, Math.max(0, to));
    // A press that changes nothing still answers, or a person at either end presses again and again into
    // silence wondering whether the key is reaching the window at all (BUILD-RULES 2.18).
    if (next === sizeAt && say) {
      // A press that changes nothing says why it changed nothing, and the three reasons are different: it is
      // as small as it goes, as large as it goes, or already at its own size.
      said = next === 0 ? 'This is as small as the list goes' : next === SIZES.length - 1 ? 'This is as large as the list goes' : 'The list is already at its own size';
      draw();
      return;
    }
    sizeAt = next;
    at.style.setProperty('--fb-size', String(SIZES[sizeAt]));
    at.dataset['size'] = String(Math.round(SIZES[sizeAt]! * 100));
    if (say) said = SIZES[sizeAt] === 1 ? 'The list is back to its own size' : `The list is at ${Math.round(SIZES[sizeAt]! * 100)}%`;
    draw();
  };
  at.style.setProperty('--fb-size', '1');
  at.dataset['size'] = '100';
  // Where this tab's list starts, from the settings. The nearest of the sizes this pane has, so that the keys
  // step from it rather than from somewhere between two of them.
  port.onSettings((s) => {
    const want = typeof s?.paneSize === 'number' && s.paneSize >= 0.5 && s.paneSize <= 3 ? s.paneSize : 1;
    let near = SIZES.indexOf(1);
    for (let i = 0; i < SIZES.length; i++) if (Math.abs(SIZES[i]! - want) < Math.abs(SIZES[near]! - want)) near = i;
    setSize(near, false);
  });
  // The path, and every folder above it. He asked for a way to change folders from the path itself, the way
  // MobaXterm's path carries a list: the caret beside it already opens the folders this tab has been in, and
  // this is the other half, the folders this one is inside. A left press opens it too, because a path that
  // can be pressed and does nothing is worse than one that cannot.
  //
  // What is deliberately NOT here: anything that types into his shell. "Open this folder in the terminal" is
  // in his own reference menu and cannot be in this one, because nothing in this app is ever typed into a
  // shell by the app (plan B2.5, his rule of 2026-11-15).
  const pathMenu = (x: number, y: number): void => {
    const now = where || asked;
    const lines: MenuLine[] = [];
    const up: string[] = [];
    for (let f = parent(now); f !== ''; f = parent(f)) {
      up.push(f);
      if (up.length >= 12) break;
    }
    for (const f of up) lines.push({ glyph: 'up', label: f, run: () => goTo(f) });
    if (up.length > 0) lines.push({ apart: true });
    lines.push({ glyph: 'copy', label: 'Copy this folder\u2019s path', run: () => void port.copy(now), id: 'fb-menu-copy-path' });
    lines.push({ glyph: 'send', label: 'Send a file here', run: () => sendBtn.click() });
    openMenu(at, x, y, lines, glyph);
  };
  el.path.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    pathMenu(e.clientX, e.clientY);
  });
  el.path.addEventListener('click', (e: MouseEvent) => {
    const box = el.path.getBoundingClientRect();
    pathMenu(e.clientX, box.bottom);
  });

  // The right button, on the list. There was no menu anywhere in this app: not on a file, not on a folder,
  // not on the empty part of a list, which he called one of the biggest gaps. What is in it is decided by
  // what the press came down on, as his own reference menus do: a folder's and a file's are not the same.
  el.list.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    const onRow = (e.target as HTMLElement | null)?.closest<HTMLElement>('.fb-row');
    const name = onRow?.dataset['name'] ?? '';
    // The trash draws its rows into the same list, with the same class and the same data-name, so without
    // this the menu for a folder's files opened on top of it: Bring it over, Rename, Delete, every one of
    // them aimed at a name in the folder behind rather than at the thing under the pointer. What the trash
    // offers is what the trash can really do. There is no "delete for good" here: the view is told what a
    // trashed thing is called inside the trash and where it came from, and never where the trash itself is,
    // so that menu line would be a delete aimed at a path this side of the app guessed at.
    if (bin.open) {
      const t = name === '' ? undefined : bin.rows.find((x) => x.name === name);
      const binLines: MenuLine[] = [];
      if (t !== undefined) {
        binLines.push({ glyph: 'back', label: 'Put it back where it was', run: () => putBack(t.name), id: 'fb-menu-back' });
        binLines.push({ apart: true });
        binLines.push({ glyph: 'copy', label: 'Copy where it came from', run: () => void port.copy(t.from) });
        binLines.push({ apart: true });
      }
      if (bin.rows.length > 0) binLines.push({ glyph: 'bin', label: `Empty what is older than ${TRASH_DAYS} days`, danger: true, run: () => emptyTrash(), id: 'fb-menu-empty' });
      binLines.push({ glyph: 'folder', label: 'Back to the folder', run: () => shutTrash(), id: 'fb-menu-leave-bin' });
      openMenu(at, e.clientX, e.clientY, binLines, glyph);
      return;
    }
    const r = name === '' || name === '..' ? undefined : rows.find((x) => x.name === name);
    // Several, when the press came down on one of them: the menu is about all of them, which is why a right
    // press on a chosen row leaves what is chosen alone.
    const several = r !== undefined && chosen.has(r.name) && chosen.size > 1 ? names().filter((n) => chosen.has(n)) : [];
    const lines: MenuLine[] = [];
    if (several.length > 0) {
      const bytes = rows.filter((x) => several.includes(x.name) && x.kind === 'file').reduce((n, x) => n + x.size, 0);
      lines.push({ glyph: 'bring', label: `Bring ${several.length} files over`, keys: 'Ctrl+S', run: () => { for (const n of several) bring(n); } });
      lines.push({ apart: true });
      lines.push({ glyph: 'copy', label: 'Copy their paths', run: () => void port.copy(several.map((n) => join(where || asked, n)).join('\n')) });
      lines.push({ glyph: 'size', label: `${size(bytes)} in ${several.length} chosen`, run: () => { said = `${several.length} chosen, ${size(bytes)}`; draw(); } });
      lines.push({ apart: true });
      lines.push({ glyph: 'bin', label: `Delete ${several.length}`, keys: 'Delete', danger: true, run: () => askToDelete(several), id: 'fb-menu-delete' });
    } else if (r !== undefined) {
      if (r.kind === 'folder') lines.push({ glyph: 'folder', label: 'Open', keys: 'Enter', run: () => goTo(join(where || asked, r.name)) });
      if (r.kind === 'file') lines.push({ glyph: 'file', label: 'Open', keys: 'Enter', run: () => openFile(join(where || asked, r.name), r.name, r.size) });
      if (r.kind === 'file') lines.push({ glyph: 'bring', label: 'Bring it over', keys: 'Ctrl+S', run: () => bring(r.name), id: 'fb-menu-bring' });
      lines.push({ apart: true });
      lines.push({ glyph: 'rename', label: 'Rename', keys: 'F2', run: () => askToRename(r.name) });
      lines.push({ glyph: 'copy', label: 'Copy its path', run: () => void port.copy(join(where || asked, r.name)) });
      if (r.kind === 'file') lines.push({ glyph: 'sum', label: "The box's own hash", keys: 'Ctrl+H', run: () => askHash(r.name, 'sha256') });
      lines.push({ apart: true });
      lines.push({ glyph: 'bin', label: 'Delete', keys: 'Delete', danger: true, run: () => askToDelete([r.name]), id: 'fb-menu-delete' });
    } else {
      // The empty part of the list, or the way up: the folder itself is what the menu is about.
      const up = parent(where || asked);
      if (up !== '') lines.push({ glyph: 'up', label: 'The folder above', run: () => goTo(up) });
      lines.push({ glyph: 'newfolder', label: 'New folder', run: () => askForFolder(), id: 'fb-menu-newfolder' });
      lines.push({ glyph: 'send', label: 'Send a file here', run: () => sendBtn.click() });
      lines.push({ apart: true });
      lines.push({ glyph: 'copy', label: 'Copy this folder\u2019s path', run: () => void port.copy(where || asked) });
      lines.push({ glyph: 'bin', label: 'What was deleted here', run: () => binBtn.click() });
    }
    if (r !== undefined && !chosen.has(r.name)) {
      chooseOne(r.name);
      place(r.name);
      draw();
    }
    openMenu(at, e.clientX, e.clientY, lines, glyph);
  });

  // The right button on the strip of transfers. What is in it is what this side of the app can really do:
  // stop one that is moving, start a download again from the row that is still in the folder behind, and
  // clear away what has finished. **"Show where it landed" is deliberately not in it.** The view is told the
  // name a file landed under and never the folder it landed in, and showing it would mean a new thing main
  // does for a view: open a window of Windows' own at a path. That is a wider boundary than a menu line is
  // worth taking without him, so it is written down rather than guessed at.
  el.moving.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    const onRow = (e.target as HTMLElement | null)?.closest<HTMLElement>('.fb-moving-one');
    const ask = Number(onRow?.dataset['ask'] ?? '');
    const b = Number.isFinite(ask) && ask > 0 ? bringing.get(ask) : undefined;
    const lines: MenuLine[] = [];
    if (b !== undefined && b.ended === '') {
      lines.push({ glyph: 'close', label: 'Stop this transfer', danger: true, run: () => asker.ask({ id: ask, do: 'cancel', path: '' }), id: 'fb-menu-stop' });
    }
    // Only when the file is still in the folder on screen: a download begins from a row, and starting one
    // for a name this folder no longer holds would be a press that quietly did nothing.
    if (b !== undefined && b.ended !== '' && b.way === 'in' && rows.some((r) => r.name === b.name && r.kind === 'file')) {
      lines.push({ glyph: 'bring', label: 'Bring it over again', keys: 'Ctrl+S', run: () => bring(b.name), id: 'fb-menu-again' });
    }
    const done = [...bringing].filter(([, x]) => x.ended !== '');
    if (done.length > 0) {
      if (lines.length > 0) lines.push({ apart: true });
      lines.push({ glyph: 'close', label: done.length === 1 ? 'Clear the one that finished' : `Clear the ${done.length} that finished`, run: () => { for (const [i] of done) bringing.delete(i); draw(); }, id: 'fb-menu-clear' });
    }
    if (lines.length === 0) return;
    openMenu(at, e.clientX, e.clientY, lines, glyph);
  });

  // The mouse's own back and forward buttons, which is how he moves through folders in every other window he
  // uses. They are taken on the pane rather than on the list, because they mean the same thing wherever in
  // the pane the pointer is standing.
  at.addEventListener('auxclick', (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    if (e.button === 3) back();
    else forward();
    e.preventDefault();
  });
  // Alt and an arrow, which is the same pair of ways by the keyboard. Alt is the window's own, so this is
  // read before the list's own arrows, which move where it stands.
  at.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowLeft') back();
    else if (e.key === 'ArrowRight') forward();
    else return;
    e.preventDefault();
  });
  // Escape shuts the list of folders, wherever in the pane it is pressed.
  at.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !recentOpen) return;
    recentOpen = false;
    draw();
    e.preventDefault();
  });

  // The keys, taken only while this pane has the focus: the terminal beside it has its own size and its own
  // keys, and a press meant for one must never move the other.
  at.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const bigger = e.key === '+' || e.key === '=';
    const smaller = e.key === '-' || e.key === '_';
    const same = e.key === '0';
    if (!bigger && !smaller && !same) return;
    e.preventDefault(); // the browser's own zoom would take the whole view, terminal and all
    e.stopPropagation();
    setSize(same ? SIZES.indexOf(1) : sizeAt + (bigger ? 1 : -1), true);
  });
  // And the wheel, which is how a person who is already pointing at the list reaches for it.
  at.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      setSize(sizeAt + (e.deltaY < 0 ? 1 : -1), true);
    },
    { passive: false },
  );

  const ask = (a: FileAsk) => asker.ask(a);

  // Where this tab has been, and where it stands in that. He asked for it against MobaXterm, whose path bar
  // carries a list of everywhere it has been and is how he changes folders: "no drop down forward backward at
  // all ... this is very important for changing paths". It is this tab's own, as its list size and the grip's
  // share are, and it holds folders rather than rows.
  const been: string[] = [];
  let wasAt = -1;
  const MOST_KEPT = 60;
  // goTo is what a press means: a new folder, so anything forward of here is no longer where he is going.
  // open on its own is the listing itself, used again by the box's own answers and by a retry, and those must
  // never write history: a folder listed again because something in it changed is not a place he went.
  const goTo = (path: string): void => {
    if (path === '') return;
    if (been[wasAt] !== path) {
      been.splice(wasAt + 1);
      been.push(path);
      if (been.length > MOST_KEPT) been.shift();
      wasAt = been.length - 1;
    }
    open(path);
  };
  const canBack = (): boolean => wasAt > 0;
  const canForward = (): boolean => wasAt >= 0 && wasAt < been.length - 1;
  const back = (): void => {
    if (!canBack()) {
      said = 'This tab has not been anywhere else yet';
      draw();
      return;
    }
    wasAt -= 1;
    open(been[wasAt]!);
  };
  const forward = (): void => {
    if (!canForward()) {
      said = 'This is the last folder this tab opened';
      draw();
      return;
    }
    wasAt += 1;
    open(been[wasAt]!);
  };

  const open = (path: string, keepTries = 0) => {
    if (trying) {
      clearTimeout(trying);
      trying = null;
    }
    tried = keepTries;
    // A filter belongs to the folder it was typed in: carrying it into the next one would make that folder
    // look half empty for a reason a person has already stopped thinking about.
    if (keepTries === 0) {
      only = '';
      findField.value = '';
    }
    for (const [id, b] of [...bringing]) {
      if (b.ended !== '') bringing.delete(id); // what has finished has been read; what is still coming goes on
    }
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
  // Why a file could not be fetched for carrying, in words rather than in the one word the engine uses.
  const CARRY_WHY: Record<string, string> = {
    'too-big-to-carry': 'too big to pick up by hand; bring it over first',
    'no-such-file': 'it is not there any more',
    denied: 'this account may not read it',
    'pc-denied': 'Berth could not write its own folder on this PC',
    'no-link': 'the link to the box is not up',
    'no-answer': 'the box did not answer',
    failed: 'it could not be fetched',
  };
  const WORTH_ANOTHER_TRY = new Set(['unsupported', 'no-link', 'no-answer', 'failed']);
  const TRIES = 3;
  let tried = 0;
  let trying: ReturnType<typeof setTimeout> | null = null;

  port.onFilePage((p: FilePage) => {
    // More than one file was chosen: main sends them one at a time, and says how many are still waiting and
    // how many were past what one chooser may hand over. Both are read before anything else, because they
    // belong to the whole strip rather than to any one transfer.
    if (typeof p.waiting === 'number') waitingToSend = p.waiting;
    if (typeof p.tooMany === 'number' && p.tooMany > 0) leftBehind = p.tooMany;
    // What was waiting has been dropped, because a person asked for it to be: it is said, so the button that
    // did it says what it did, and nothing else on this page is about a file at all.
    // A file fetched only to be carried. Its pages never become a transfer line: what a person sees is the row
    // becoming draggable, and one line saying what is happening while they wait (BUILD-RULES 2.18).
    if (p.carrying === true) {
      const what = carryGoing.get(p.id) ?? '';
      if (p.draggable === true && what !== '') {
        carryReady.set(what, p.id);
        carryGoing.delete(p.id);
        said = `${shorten(what, 28)} is ready to drag`;
      } else if (p.done === true) {
        carryGoing.delete(p.id);
        if (p.error) said = what === '' ? (CARRY_WHY[p.error] ?? CARRY_WHY['failed']!) : `${shorten(what, 28)}: ${CARRY_WHY[p.error] ?? CARRY_WHY['failed']!}`;
      }
      draw();
      return;
    }
    // The file is not in the download folder any more: it was moved, renamed or deleted since it landed. The
    // line says so and stops offering the drag, rather than leaving a hand reaching for nothing.
    if (p.dragGone === true) {
      const b = bringing.get(p.id);
      if (b) b.canDrag = false;
      said = `${shorten(b?.landed === '' || b?.landed === undefined ? (b?.name ?? 'That file') : b.landed, 28)} is not in the download folder any more`;
      draw(); // the list is drawn again from what is already known: the row stops offering the drag with it

      return;
    }
    // A page that says only "this one can be dragged" belongs to a transfer that may already have ended, so it
    // is taken before the pages of a listing are, and it draws.
    if (p.draggable === true) {
      const b = bringing.get(p.id);
      if (b) {
        b.canDrag = true;
        draw();
        return;
      }
    }
    if (typeof p.unqueued === 'number') {
      said = p.unqueued === 0 ? 'Nothing was waiting to be sent' : `${p.unqueued} ${p.unqueued === 1 ? 'file' : 'files'} that ${p.unqueued === 1 ? 'was' : 'were'} waiting will not be sent`;
      leftBehind = 0;
      draw();
      return;
    }
    // A transfer main began itself, out of that queue: it gets its own line from the moment it is named, so
    // nothing is moving without something on screen saying so.
    if (typeof p.alsoSending === 'string') {
      const already = bringing.get(p.id);
      if (already) already.name = p.alsoSending; // the file a person chose first: its line gets the real name
      else bringing.set(p.id, { name: p.alsoSending, way: 'out', got: 0, of: 0, began: performance.now(), at: performance.now(), rate: 0, landed: '', mark: '', markWhy: '', renamed: '', replaced: false, asking: '', tookUpAt: 0, ended: '', canDrag: false });
      draw();
      return;
    }
    if (hashing && typeof p.hash === 'string' && p.hash !== '') {
      hashing.hash = p.hash;
      draw();
      return;
    }
    if (hashing && hashing.hash === '' && p.done && p.error) {
      hashing.fault = WHY[p.error] ?? 'The box could not give a hash for it';
      draw();
      return;
    }
    // A new name, or a new folder: the one ask whose answer this panel is waiting for, found by its own
    // number so nothing else that carries a thing's attributes can be mistaken for it.
    if (naming && naming.id !== 0 && p.id === naming.id) {
      const n = naming;
      if (p.attrs) {
        const made = p.attrs.name.split('/').pop() ?? '';
        sayNext = n.mode === 'rename' ? `${shorten(n.was, 24)} is now called ${shorten(made, 24)}` : `${shorten(made, 24)} made`;
        naming = null;
        standNext = made;
        open(where || asked); // the folder is listed again, so the row shows what it is called now
        draw();
        return;
      }
      if (p.error) {
        n.busy = false;
        n.said = NAME_WHY[p.error] ?? NAME_WHY['failed']!;
        draw();
        return;
      }
      if (p.done) {
        // An answer that said nothing at all: the panel stays open rather than closing on a silence.
        n.busy = false;
        n.said = NAME_WHY['failed']!;
        draw();
        return;
      }
    }
    // The trash: what a delete, a restore or an emptying did, and what is in it now.
    if (p.trash !== undefined || p.trashed !== undefined || p.emptied !== undefined || (bin.busy && p.done)) {
      if (p.trash !== undefined) {
        bin.rows = p.trash;
        bin.where = p.where ?? bin.where;
      }
      if (p.trashed) {
        const t = p.trashed;
        if (batch) batch.done += 1;
        bin.said = batch
          ? `${batch.done} of ${batch.want} in the trash`
          : p.id === askingTrash
            ? bin.said
            : `${shorten(t.from.split('/').pop() ?? t.name, 30)} ${bin.open ? 'is back where it was' : 'is in the trash'}`;
        if (bin.open) bin.rows = bin.rows.filter((x) => x.name !== t.name);
        else open(where || asked); // the folder it left is listed again, so the row goes
      }
      if (typeof p.emptied === 'number' || typeof p.freed === 'number') {
        const n = p.emptied ?? 0;
        if (!quietly || n > 0) bin.said = n === 0 ? 'Nothing in the trash is old enough to empty' : `${n} ${n === 1 ? 'thing' : 'things'} older than ${TRASH_DAYS} days emptied from the trash, ${size(p.freed ?? 0)} freed`;
        if (bin.open) openTrash();
      }
      if (p.done) {
        if (batch) {
          if (p.error) batch.failed += 1;
          // The strip stays busy until every one of them has been answered for, and what is said at the end
          // is the count, not whichever of them the box happened to answer last. One that could not go is
          // said in the same line: a delete that half happened and says nothing is the worst of both.
          const over = batch.done + batch.failed >= batch.want;
          bin.busy = !over;
          if (over) {
            bin.said = batch.failed === 0 ? `${batch.done} ${batch.done === 1 ? 'thing is' : 'things are'} in the trash` : `${batch.done} in the trash, ${batch.failed} could not go: ${TRASH_WHY[p.error ?? 'failed'] ?? TRASH_WHY['failed']!}`;
            batch = null;
          }
        } else {
          bin.busy = false;
          if (p.error && !quietly) bin.said = TRASH_WHY[p.error] ?? TRASH_WHY['failed']!;
        }
        quietly = false;
      }
      draw();
      return;
    }
    const down = bringing.get(p.id);
    if (down) {
      if (typeof p.of === 'number' && p.of > 0) down.of = p.of;
      if (typeof p.got === 'number') {
        // The speed is of the last stretch, not of the whole download, so a link that slows is seen slowing.
        const now = performance.now();
        if (now > down.at) down.rate = ((p.got - down.got) * 1000) / (now - down.at);
        down.got = p.got;
        down.at = now;
      }
      // Where it landed is said on its own page, a moment before the one that says the ask is finished: what
      // each page carries is kept, and the end is written from all of it together.
      if (typeof p.landed === 'string') down.landed = p.landed;
      // Main has said this one is on the PC and may be dragged out. The window keeps the number of the ask and
      // nothing else: where the file is on this PC is main's knowledge and never this view's (plan B2.7).
      if (p.draggable === true) down.canDrag = true;
      if (typeof p.mark === 'string') down.mark = p.mark;
      if (typeof p.markWhy === 'string') down.markWhy = p.markWhy;
      if (typeof p.renamed === 'string') down.renamed = p.renamed;
      if (p.replaced === true) down.replaced = true;
      if (typeof p.asking === 'string') down.asking = p.asking;
      if (typeof p.resumedAt === 'number' && p.resumedAt > 0) down.tookUpAt = p.resumedAt;
      if (p.done) {
        down.asking = '';
        const words = down.way === 'in' ? DOWNLOAD_WHY : SEND_WHY;
        // A failure the app wrote down carries the id of its line, and the row says it: he can read a fault
        // out of the pane and find that one failure in the log without going looking for it.
        const named = p.fault === undefined || p.fault === '' ? '' : ` (fault ${p.fault})`;
        // What went wrong in the words of whatever said so, after Berth's own: a row that can only say "it
        // could not be done" leaves him with nothing to go on. It is text and nothing else, as everything a
        // box writes is.
        const because = p.detail === undefined || p.detail === '' ? '' : `: ${shorten(p.detail, 90)}`;
        down.ended = p.error
          ? `${words[p.error] ?? words['failed']!}${because}${named}`
          : down.landed === ''
            ? 'It was stopped'
            : down.way === 'in'
              ? `${down.landed} is in the download folder${down.tookUpAt > 0 ? ', taken up where it broke' : ''}, ${MARK[down.mark] ?? 'it was not checked'}${down.markWhy === '' ? '' : ` (${down.markWhy})`}${down.renamed === '' ? '' : ` (renamed: ${down.renamed})`}`
              : `${down.landed} is on the box${down.replaced ? ', over the file that was there' : ''}${down.tookUpAt > 0 ? ', taken up where it broke' : ''}, ${SENT_MARK[down.mark] ?? 'but it was not checked'}${down.markWhy === '' ? '' : ` (${down.markWhy})`}`;
        down.at = performance.now();
      }
      draw();
      return;
    }
    if (p.id !== asking) return; // a page of a listing already left behind
    if (typeof p.where === 'string') where = p.where;
    // The box has said where this tab is, so the one thing Berth does on a box without being asked can
    // happen now rather than against a name that is not a path.
    if (where !== '' && emptyWhenKnown) {
      emptyWhenKnown = false;
      emptyOldTrash();
    }
    if (p.space) space = p.space;
    if (p.rows && p.rows.length > 0) {
      rows = rows.concat(p.rows);
      sort(rows);
    }
    if (p.error) why = `${WHY[p.error] ?? WHY['failed']!}${p.fault === undefined || p.fault === '' ? '' : ` (fault ${p.fault})`}`;
    if (p.done) {
      busy = false;
      // Whatever was just renamed or just made is what the list stands on, if it is in this listing at all.
      if (standNext !== '') {
        const want = standNext;
        standNext = '';
        if (rows.some((x) => x.name === want)) standing = want;
      }
      if (sayNext !== '') {
        said = sayNext;
        sayNext = '';
      }
    }
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
  // How the list is ordered, and what of it is shown. Folders always come before files, whichever column the
  // order is by: a folder is a place to go and a file is a thing to act on, and mixing them by size would put
  // a place to go in the middle of a list of things. The order is this tab's own and lasts as long as the tab.
  type By = 'name' | 'size' | 'changed';
  let by: By = 'name';
  let down = false; // the biggest, the newest, or Z first
  const sort = (r: FileRow[]) => {
    r.sort((a, b) => {
      const af = a.kind === 'folder' ? 0 : 1;
      const bf = b.kind === 'folder' ? 0 : 1;
      if (af !== bf) return af - bf;
      // Within folders there is nothing to compare but the name: a folder's size is not its contents' size and
      // saying it is would be a number that means nothing.
      // Both sides are folders by now, or neither is: the rule above has already separated them. It is
      // written as both rather than one, because a comparison that reads one side only answers differently
      // depending on which side it is given, and a comparator that does that puts a list in no order at all.
      const bothFolders = a.kind === 'folder' && b.kind === 'folder';
      const same = by === 'name' || bothFolders ? collator.compare(a.name, b.name) : by === 'size' ? a.size - b.size : a.mtime - b.mtime;
      // A tie is broken by name, always, so the same folder comes out in the same order every time it is read.
      return (down ? -same : same) || collator.compare(a.name, b.name);
    });
  };

  // What is typed into the filter. It hides rows and nothing else: the folder is still the whole folder, the
  // counts below say what is hidden, and moving to another folder clears it.
  let only = '';
  const shown = (r: FileRow[]): FileRow[] => {
    const want = only.trim().toLowerCase();
    if (want === '') return r;
    return r.filter((x) => x.name === '..' || x.name.toLowerCase().includes(want));
  };

  const draw = () => {
    const here = where || asked;
    const hadFocus = el.list.contains(document.activeElement);
    // A long path is cut in the middle, keeping its start and its end: the end says which folder this is and
    // the start says which disk it is on. It is cut here rather than by the stylesheet, because leaning on a
    // text direction to cut from the left moves the leading "/" to the other end of the line.
    el.path.textContent = shorten(here, 46);
    el.path.title = here;
    // Where this tab has been, in numbers, for the window's own tests to read: a probe that judged the
    // history from the buttons alone would be judging the buttons.
    at.dataset['been'] = String(been.length);
    at.dataset['beenAt'] = String(wasAt);
    at.dataset['recentOpen'] = recentOpen ? 'yes' : 'no';
    // The two ways through the folders this tab has been in. A way that leads nowhere is dim rather than
    // gone: a button that comes and goes under the hand is a button that is pressed by accident.
    backBtn.disabled = !canBack();
    fwdBtn.disabled = !canForward();
    recentBtn.disabled = been.length < 2;
    recentBtn.dataset['on'] = recentOpen ? 'yes' : 'no';
    recentAt.replaceChildren();
    if (recentOpen && been.length > 0) {
      // Newest first, each folder once: a list of where he has been is not a list of how often he went.
      const seen = new Set<string>();
      for (let i = been.length - 1; i >= 0; i--) {
        const folder = been[i]!;
        if (seen.has(folder)) continue;
        seen.add(folder);
        const b = document.createElement('button');
        b.className = 'fb-recent-one';
        b.type = 'button';
        b.dataset['path'] = folder;
        if (i === wasAt) b.dataset['on'] = 'yes';
        b.append(glyph('folder'));
        const words = document.createElement('span');
        words.textContent = shorten(folder, 52);
        words.title = folder;
        b.append(words);
        b.addEventListener('click', () => {
          recentOpen = false;
          goTo(folder);
        });
        recentAt.append(b);
      }
    }
    // Which column the list is ordered by, and which way: said on the buttons themselves, in words a reader
    // hears as well as in their look, because a button that is "on" only by its colour says nothing aloud.
    for (const { what, btn } of byBtns) {
      const on = by === what && !bin.open;
      btn.dataset['on'] = on ? 'yes' : 'no';
      btn.dataset['down'] = on && down ? 'yes' : 'no';
      btn.setAttribute('aria-pressed', String(on));
      const which = what === 'name' ? (down ? 'Z to A' : 'A to Z') : what === 'size' ? (down ? 'biggest first' : 'smallest first') : down ? 'newest first' : 'oldest first';
      btn.title = on ? `Ordered by ${what}, ${which}. Press to turn it around` : `Order by ${what}`;
      btn.setAttribute('aria-label', btn.title);
    }
    tools.dataset['off'] = bin.open ? 'yes' : 'no';
    findField.disabled = bin.open;
    clearFind.disabled = bin.open || only === '';

    el.list.replaceChildren();
    binBtn.dataset['open'] = bin.open ? 'yes' : 'no';
    binBtn.setAttribute('aria-pressed', String(bin.open));
    if (bin.open) {
      drawTrash();
      drawFoot();
      return;
    }
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
    } else if (shown(rows).length === 0) {
      // The folder has things in it and the filter hides all of them. That is said, with a way back in one
      // press, rather than a list that looks like an empty folder (NOTHING fails silently).
      const none = document.createElement('div');
      none.className = 'fb-why quiet';
      none.id = 'fb-none-match';
      none.textContent = `Nothing here is called "${shorten(only.trim(), 24)}". ${rows.length} ${rows.length === 1 ? 'thing is' : 'things are'} hidden by the filter.`;
      el.list.append(none);
    } else {
      const frag = document.createDocumentFragment();
      // One row above, when there is one: the window's own way up, rather than a "..' among the files.
      const up = parent(here);
      if (up !== '') {
        frag.append(row({ name: '..', kind: 'folder', size: 0, mode: 0, mtime: 0 }, () => goTo(up), 'fb-up'));
      }
      for (const r of shown(rows)) {
        // A folder is gone into; a file is opened in the viewer, read-only. Anything else is neither, and is
        // shown with what it is rather than opened at all (plan B4.1).
        const enter = r.kind === 'folder' ? () => goTo(join(here, r.name)) : r.kind === 'file' ? () => openFile(join(here, r.name), r.name, r.size) : undefined;
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
    // This pass settles the tab stop and nothing else. It used to write aria-selected from it as well, and
    // wrote over what was chosen: when one row was all there was, where the keyboard stands and what is chosen
    // were the same thing, and they stopped being the same the moment several became possible. Three rows
    // chosen, three counted in the foot, and one announced, and that one wherever the keyboard happened to be.
    // Where the keyboard stands is carried by the tab stop and by focus, which is what they are for.
    for (const e of drawn) e.tabIndex = e.dataset['name'] === standing ? 0 : -1;
    if (hadFocus) drawn.find((e) => e.tabIndex === 0)?.focus();

    drawFoot();
  };

  // What has been deleted on this disk, newest first, each with where it came from and when, and a way to put
  // it back. It is drawn in the list's own place, because it is the same list seen from the other side.
  const drawTrash = () => {
    const head = document.createElement('div');
    head.className = 'fb-why quiet';
    head.id = 'fb-bin-head';
    head.textContent = bin.busy && bin.rows.length === 0 ? 'Reading the trash' : bin.rows.length === 0 ? 'Nothing has been deleted on this disk' : `Deleted on this disk, newest first`;
    el.list.append(head);
    if (bin.rows.length > 0) {
      const empty = document.createElement('button');
      empty.className = 'fb-bin-empty';
      empty.id = 'fb-bin-empty';
      empty.type = 'button';
      empty.append(glyph('bin'));
      const word = document.createElement('span');
      word.textContent = `Empty what is older than ${TRASH_DAYS} days`;
      empty.append(word);
      empty.addEventListener('click', () => emptyTrash());
      el.list.append(empty);
    }
    for (const t of bin.rows) {
      const row = document.createElement('div');
      row.className = `fb-row fb-${t.kind}`;
      row.dataset['name'] = t.name;
      row.append(glyph(t.kind));
      const words = document.createElement('span');
      words.className = 'fb-name';
      words.textContent = t.from;
      words.title = t.from;
      const when = document.createElement('span');
      when.className = 'fb-size';
      when.textContent = `${t.kind === 'folder' ? '' : size(t.size) + ', '}${howLongAgo(t.when)}`;
      const back = document.createElement('button');
      back.className = 'fb-get fb-back';
      back.type = 'button';
      back.title = 'Put this back where it was';
      back.setAttribute('aria-label', `Put ${t.from} back`);
      back.tabIndex = -1;
      back.append(glyph('back'));
      back.addEventListener('click', () => putBack(t.name));
      row.append(words, when, back);
      el.list.append(row);
    }
  };

  // The foot and the strip under the list, drawn the same whether the list or the trash is on screen.
  const drawFoot = () => {
    el.foot.replaceChildren();
    const bits: string[] = bin.open
      ? [`${bin.rows.length} in the trash${bin.busy ? ', reading' : ''}`, ...(bin.said === '' ? [] : [bin.said])]
      : [
          `${rows.length} ${rows.length === 1 ? 'item' : 'items'}${busy ? ', reading' : ''}`,
          ...(chosen.size === 0 ? [] : [`${chosen.size} chosen${chosenBytes() > 0 ? `, ${size(chosenBytes())}` : ''}`]),
          ...(only.trim() === '' || rows.length === 0 ? [] : [`${rows.length - shown(rows).length} hidden by the filter`]),
        ];
    if (!bin.open && bin.said !== '') bits.push(bin.said);
    if (space && !bin.open) bits.push(`${size(space.free)} free of ${size(space.total)}`);
    if (said !== '' && !bin.open) bits.push(said);
    // What is being brought over or sent, one line each: how far it has got, how fast, and how long is left.
    // A finished one says where it went and whether it could be checked, and stays until the next move. These
    // go under the counts and may take two lines, because what they say is a sentence and a sentence that is
    // cut off at the edge of the pane is a sentence nobody can read.
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
    el.moving.replaceChildren();
    // Deleting asks first, and names what would go. It is asked in the pane rather than on the shell because
    // it is about this tab's own box and folder, and because the answer is one press either way
    // (BUILD-RULES 2.20). Keeping it has the focus, so Enter and Escape both keep it.
    if (goingToTrash) {
      const ask = document.createElement('div');
      ask.className = 'fb-ask';
      ask.id = 'fb-ask-delete';
      const head = document.createElement('div');
      head.className = 'fb-ask-head';
      const many = goingToTrash.names.length;
      head.textContent = many === 1 ? `Delete ${shorten(goingToTrash.names[0]!, 26)}?` : `Delete ${many} things?`;
      const said = document.createElement('div');
      said.className = 'fb-ask-said';
      said.id = 'fb-ask-said';
      // What goes is named, every time. With several, they are named too: a count alone is not something a
      // person can check, and a delete is the one act here that must never take something he did not mean.
      const folders = goingToTrash.folders;
      const bytes = goingToTrash.bytes;
      const whatGoes =
        many === 1
          ? folders === 1
            ? 'It goes to this disk\u2019s trash, whole, and can be brought back from there. The box keeps it for 7 days.'
            : `${size(bytes)}. It goes to this disk\u2019s trash and can be brought back from there. The box keeps it for 7 days, so that much stays used.`
          : `${folders > 0 ? `${folders} ${folders === 1 ? 'folder, whole, and ' : 'folders, whole, and '}${many - folders} ${many - folders === 1 ? 'file' : 'files'}, ` : ''}${size(bytes)}. They go to this disk\u2019s trash and can be brought back from there. The box keeps them for 7 days, so that much stays used.`;
      said.textContent = whatGoes;
      let namesAt: HTMLElement | null = null;
      if (many > 1) {
        const naming = document.createElement('div');
        naming.className = 'fb-ask-names';
        naming.id = 'fb-ask-names';
        const SHOWN = 8;
        for (const n of goingToTrash.names.slice(0, SHOWN)) {
          const one = document.createElement('div');
          one.className = 'fb-ask-name';
          one.textContent = shorten(n, 40);
          one.title = n;
          naming.append(one);
        }
        if (many > SHOWN) {
          const rest = document.createElement('div');
          rest.className = 'fb-ask-name fb-ask-rest';
          rest.textContent = `and ${many - SHOWN} more`;
          naming.append(rest);
        }
        namesAt = naming;
      }
      const acts = document.createElement('div');
      acts.className = 'fb-ask-acts';
      const keep = document.createElement('button');
      keep.className = 'fb-ask-keep';
      keep.id = 'fb-ask-keep';
      keep.type = 'button';
      keep.append(glyph('close'));
      const keepWord = document.createElement('span');
      keepWord.textContent = many === 1 ? 'Keep it' : 'Keep them';
      keep.append(keepWord);
      keep.addEventListener('click', () => {
        goingToTrash = null;
        draw();
      });
      const go = document.createElement('button');
      go.className = 'fb-ask-go';
      go.id = 'fb-ask-go';
      go.type = 'button';
      go.append(glyph('bin'));
      const goWord = document.createElement('span');
      goWord.textContent = many === 1 ? 'Delete it' : `Delete ${many}`;
      go.append(goWord);
      go.addEventListener('click', () => reallyDelete());
      acts.append(keep, go);
      ask.append(head, said, ...(namesAt ? [namesAt] : []), acts);
      el.moving.append(ask);
      setTimeout(() => (document.getElementById('fb-ask-keep') as HTMLButtonElement | null)?.focus(), 0);
    }
    // Naming: one field and one press. The field has the focus and holds what the thing is called now, with
    // the part before any last dot picked out, because a rename is most often a change to the name and not to
    // what kind of file it is. Enter does it, Escape leaves it alone, and the field is kept as it was typed:
    // a panel that is redrawn under a person's hands must not take their letters back.
    if (naming) {
      const n = naming;
      const panel = document.createElement('div');
      panel.className = 'fb-ask fb-naming';
      panel.id = 'fb-naming';
      const head = document.createElement('div');
      head.className = 'fb-ask-head';
      head.textContent = n.mode === 'rename' ? `Rename ${shorten(n.was, 26)}` : `New folder in ${shorten((where || asked).split('/').pop() || '/', 22)}`;
      // The field is made once for the panel and then kept, redraw after redraw. A field built afresh each
      // time is a field whose caret goes back to the end of the name whenever anything arrives from the box,
      // and a person typing in the middle of a name would lose their place without touching anything.
      const field = nameField ?? document.createElement('input');
      const fresh = nameField === null;
      nameField = field;
      field.type = 'text';
      field.className = 'fb-name-field';
      field.id = 'fb-name-field';
      if (fresh) field.value = n.name;
      field.spellcheck = false;
      field.autocomplete = 'off';
      field.disabled = n.busy;
      field.setAttribute('aria-label', n.mode === 'rename' ? 'The new name' : 'What the new folder is called');
      if (fresh) field.addEventListener('input', () => {
        n.name = field.value;
        if (n.said !== '') {
          n.said = '';
          const saidEl = document.getElementById('fb-name-said');
          if (saidEl) saidEl.textContent = '';
        }
      });
      if (fresh) field.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          n.name = field.value;
          reallyName();
          ev.preventDefault();
        } else if (ev.key === 'Escape') {
          naming = null;
          draw();
          el.list.focus();
          ev.preventDefault();
        }
        ev.stopPropagation();
      });
      const saidLine = document.createElement('div');
      saidLine.className = 'fb-ask-said';
      saidLine.id = 'fb-name-said';
      saidLine.textContent = n.busy ? 'Asking the box' : n.said;
      const acts = document.createElement('div');
      acts.className = 'fb-ask-acts';
      const drop = document.createElement('button');
      drop.className = 'fb-ask-keep';
      drop.id = 'fb-name-drop';
      drop.type = 'button';
      drop.append(glyph('close'));
      const dropWord = document.createElement('span');
      dropWord.textContent = 'Leave it';
      drop.append(dropWord);
      drop.addEventListener('click', () => {
        naming = null;
        draw();
        el.list.focus();
      });
      const go = document.createElement('button');
      go.className = 'fb-ask-go fb-name-go';
      go.id = 'fb-name-go';
      go.type = 'button';
      go.disabled = n.busy;
      go.append(glyph(n.mode === 'rename' ? 'rename' : 'newfolder'));
      const goWord = document.createElement('span');
      goWord.textContent = n.mode === 'rename' ? 'Rename it' : 'Make it';
      go.append(goWord);
      go.addEventListener('click', () => reallyName());
      acts.append(drop, go);
      panel.append(head, field, saidLine, acts);
      el.moving.append(panel);
      // The focus goes to the field once, when the panel appears, and the caret sits on the part of the name
      // a person is most likely to be changing. A redraw while they are typing must not move either.
      if (fresh) {
        setTimeout(() => {
          const f = document.getElementById('fb-name-field') as HTMLInputElement | null;
          if (!f) return;
          f.focus();
          const dot = n.mode === 'rename' ? n.was.lastIndexOf('.') : -1;
          if (dot > 0) f.setSelectionRange(0, dot);
          else f.select();
        }, 0);
      }
    } else {
      nameField = null;
    }
    // A hash a person asked for: what it is, a way to copy it, and a place to paste what it should be.
    if (hashing) {
      const h = document.createElement('div');
      h.className = 'fb-hash';
      h.id = 'fb-hash';
      const top = document.createElement('div');
      top.className = 'fb-hash-top';
      const what = document.createElement('span');
      what.className = 'fb-hash-what';
      what.textContent = `${hashing.which} of ${shorten(hashing.name, 24)}`;
      const shut = document.createElement('button');
      shut.className = 'fb-hash-shut';
      shut.id = 'fb-hash-shut';
      shut.type = 'button';
      shut.setAttribute('aria-label', 'Close this hash');
      shut.append(glyph('close'));
      shut.addEventListener('click', () => {
        hashing = null;
        draw();
      });
      top.append(what, shut);
      h.append(top);
      if (hashing.fault !== '') {
        const bad = document.createElement('div');
        bad.className = 'fb-hash-fault';
        bad.id = 'fb-hash-fault';
        bad.textContent = hashing.fault;
        h.append(bad);
      } else if (hashing.hash === '') {
        const wait = document.createElement('div');
        wait.className = 'fb-hash-wait quiet';
        wait.id = 'fb-hash-wait';
        wait.textContent = 'Asking the box';
        h.append(wait);
      } else {
        const row = document.createElement('div');
        row.className = 'fb-hash-row';
        const value = document.createElement('code');
        value.className = 'fb-hash-value';
        value.id = 'fb-hash-value';
        value.textContent = hashing.hash;
        const copy = document.createElement('button');
        copy.className = 'fb-hash-copy';
        copy.id = 'fb-hash-copy';
        copy.type = 'button';
        copy.title = 'Copy this hash';
        copy.setAttribute('aria-label', 'Copy this hash');
        copy.append(glyph('copy'));
        copy.addEventListener('click', () => {
          port.copy(hashing?.hash ?? '');
        });
        row.append(value, copy);
        const field = document.createElement('input');
        field.className = 'fb-hash-expected';
        field.id = 'fb-hash-expected';
        field.type = 'text';
        field.spellcheck = false;
        field.placeholder = 'Paste what it should be';
        field.setAttribute('aria-label', 'What this hash should be');
        field.value = hashing.expected;
        field.addEventListener('input', () => {
          if (!hashing) return;
          hashing.expected = field.value;
          draw();
          (document.getElementById('fb-hash-expected') as HTMLInputElement | null)?.focus();
        });
        const said = document.createElement('div');
        said.className = 'fb-hash-said';
        said.id = 'fb-hash-said';
        // The two are compared here, with case ignored and anything around them left out, because a hash
        // pasted from somewhere else arrives with a file name beside it as often as not.
        const want = (hashing.expected.match(/[0-9a-fA-F]{32,64}/) ?? [''])[0].toLowerCase();
        if (hashing.expected.trim() === '') said.textContent = '';
        else if (want === '') {
          said.textContent = 'That does not hold a hash';
          said.dataset['how'] = 'no';
        } else if (want === hashing.hash.toLowerCase()) {
          said.textContent = 'The same';
          said.dataset['how'] = 'yes';
        } else {
          said.textContent = 'Not the same';
          said.dataset['how'] = 'no';
        }
        h.append(row, field, said);
      }
      el.moving.append(h);
    }
    // What is still to come out of one choosing, as a count rather than a line each: a strip with sixty lines
    // in it says less than one line with a number on it. It has its own Stop, which drops what is waiting and
    // leaves what is already moving alone, because that has a Stop of its own. It is drawn above the lines
    // about transfers rather than below them, so that it keeps its place as those come and go: nothing moves
    // under a hand that is reaching for it (BUILD-RULES 2.4).
    if (waitingToSend > 0) {
      const one = document.createElement('div');
      one.className = 'fb-moving-one';
      one.id = 'fb-waiting';
      const words = document.createElement('span');
      words.textContent = `${waitingToSend} more ${waitingToSend === 1 ? 'file is' : 'files are'} waiting to be sent`;
      const stop = document.createElement('button');
      stop.className = 'fb-stop';
      stop.type = 'button';
      stop.id = 'fb-waiting-stop';
      stop.title = 'Do not send the rest';
      stop.setAttribute('aria-label', `Do not send the ${waitingToSend} files still waiting`);
      stop.append(glyph('close'));
      stop.addEventListener('click', () => {
        asker.ask({ do: 'unqueue', path: '' });
      });
      one.append(words, stop);
      el.moving.append(one);
    }
    // What was past the most one chooser may hand over. It stays said until the next move, because a file a
    // person chose and did not get is not a quiet matter.
    if (leftBehind > 0) {
      const one = document.createElement('div');
      one.className = 'fb-moving-one';
      one.id = 'fb-too-many';
      const words = document.createElement('span');
      words.textContent = `${leftBehind} more ${leftBehind === 1 ? 'file was' : 'files were'} chosen than can go in one send (${MOST_AT_ONCE} at a time), and ${leftBehind === 1 ? 'it was' : 'they were'} not sent`;
      one.append(words);
      el.moving.append(one);
    }
    // Several files at once. A file is dragged out as the transfer that brought it, so a drag of several is
    // a drag of several of those: one line, above the lines it stands for, carrying every file in the strip
    // that is here and still here. It appears only when there are two, because with one the line for that
    // one file already does it (BUILD-RULES 2.4: a line that comes and goes must not move the lines below).
    const ready = [...bringing].filter(([, b]) => b.canDrag);
    if (ready.length > 1) {
      const all = document.createElement('div');
      all.className = 'fb-moving-one fb-drag-all';
      all.id = 'fb-drag-all';
      dragAll(all, ready.map(([id]) => id), `${ready.length} files`);
      const words = document.createElement('span');
      words.textContent = `${ready.length} files are here: drag them out together`;
      all.append(words);
      el.moving.append(all);
    }
    for (const [id, b] of bringing) {
      const one = document.createElement('div');
      one.className = 'fb-moving-one';
      one.dataset['ask'] = String(id);
      // A file that is here on the PC can be taken out of the window by hand, into a chat or a folder. The
      // window starts nothing itself: it says which ask, and main hands the file to the system (plan B4.5).
      if (b.canDrag) dragFrom(one, id, b.landed === '' ? b.name : b.landed);
      // A transfer that is moving is numbers, and numbers read as fields rather than as a sentence: the name,
      // how far it has got, how fast and how long is left, each its own, the way his own tables are read. A
      // transfer that has ended is not numbers: it carries where the file went, whether its hash matched, and
      // when it failed the box's own words and the id of the line in the log. That stays a sentence, because
      // breaking a reason into fields loses the reason.
      const words = document.createElement('span');
      words.className = 'fb-x';
      if (b.ended !== '') {
        const mark = document.createElement('span');
        mark.className = b.mark === 'checked' ? 'fb-x-mark fb-x-ok' : b.mark === 'changed' ? 'fb-x-mark fb-x-bad' : 'fb-x-mark';
        mark.append(glyph(b.mark === 'checked' ? 'sum' : b.mark === 'changed' ? 'close' : 'file'));
        const said = document.createElement('span');
        said.className = 'fb-x-said';
        said.textContent = b.ended;
        words.append(mark, said);
      } else if (b.asking !== '') {
        const said = document.createElement('span');
        said.className = 'fb-x-said';
        said.textContent = `${shorten(b.asking, 28)} is already on the box: waiting on your answer`;
        words.append(said);
      } else {
        const top = document.createElement('span');
        top.className = 'fb-x-top';
        const name = document.createElement('span');
        name.className = 'fb-x-name';
        const whole = b.landed === '' ? b.name : b.landed;
        name.textContent = shorten(whole, 28);
        name.title = whole;
        top.append(glyph(b.way === 'out' ? 'send' : 'bring'), name);
        // Until the other end has said how big it is there is nothing worth counting, so nothing is counted.
        if (b.of > 0) {
          const far = document.createElement('span');
          far.className = 'fb-x-far';
          far.textContent = `${size(b.got)} of ${size(b.of)}`;
          top.append(far);
        }
        words.append(top);
        const under: string[] = [];
        if (b.rate > 1) under.push(`${size(b.rate)}/s`);
        if (b.rate > 1 && b.of > b.got) under.push(`${howLong((b.of - b.got) / b.rate)} left`);
        if (b.tookUpAt > 0) under.push(`taken up at ${size(b.tookUpAt)}`);
        if (under.length > 0) {
          const row = document.createElement('span');
          row.className = 'fb-x-under';
          for (const u of under) {
            const part = document.createElement('span');
            part.textContent = u;
            row.append(part);
          }
          words.append(row);
        }
      }
      one.append(words);
      // A transfer still going can be stopped, and stopping it leaves nothing behind at either end.
      if (b.ended === '') {
        const stop = document.createElement('button');
        stop.className = 'fb-stop';
        stop.type = 'button';
        stop.title = 'Stop this transfer';
        stop.setAttribute('aria-label', `Stop ${b.name}`);
        stop.append(glyph('close'));
        stop.addEventListener('click', () => {
          asker.ask({ id, do: 'cancel', path: '' });
        });
        one.append(stop);
      }
      el.moving.append(one);
    }
  };

  // Making something draggable: the same two lines wherever it is done, so a row and a line in the strip
  // behave alike. The press is answered at once by the window (the dragging mark), and the file itself is
  // main's to hand over: a view holds a number, never a path (BUILD-RULES 2.18, plan B2.7).
  const dragFrom = (e: HTMLElement, ask: number, what: string): void => {
    e.draggable = true;
    e.title = `Drag ${what} out of this window`;
    e.addEventListener('dragstart', (ev) => {
      ev.preventDefault(); // the system's own drag takes over from here, started by main
      e.dataset['dragging'] = 'yes';
      said = `${shorten(what, 28)} is being dragged out`;
      draw();
      port.drag(ask);
    });
    e.addEventListener('dragend', () => {
      delete e.dataset['dragging'];
    });
  };

  // The same, for several at once: the window still holds numbers and never a path, and main hands the
  // system every file those numbers brought over, in one drag.
  const dragAll = (e: HTMLElement, asks: number[], what: string): void => {
    e.draggable = true;
    e.title = `Drag ${what} out of this window`;
    e.addEventListener('dragstart', (ev) => {
      ev.preventDefault();
      e.dataset['dragging'] = 'yes';
      said = `${what} are being dragged out`;
      draw();
      port.dragAll(asks);
    });
    e.addEventListener('dragend', () => {
      delete e.dataset['dragging'];
    });
  };

  // Which ask brought a file of this name over, if this tab brought it and it is still here. A row of the
  // list is dragged as the transfer that fetched it, so nothing new has to be remembered to say what it is.
  // The latest one, not the first: a file fetched twice has two lines, and a row must offer the copy that was
  // brought over last. If that last try failed, the row offers nothing at all, rather than quietly handing
  // over an older copy of a file that has since changed on the box.
  const broughtOver = (name: string): number | undefined => {
    for (const [id, b] of [...bringing].reverse()) if (b.way === 'in' && (b.landed === name || b.name === name)) return b.canDrag ? id : undefined;
    return carryReady.get(name);
  };

  // A press on a small file fetches it, so that a drag begun a moment later has something to carry. A file
  // already here is not fetched again; one too big for this is left to the download button, which says so.
  const carry = (r: FileRow): void => {
    if (r.kind !== 'file' || r.size > GRAB_MAX) return;
    if (broughtOver(r.name) !== undefined) return;
    if ([...carryGoing.values()].includes(r.name)) return;
    const id = asker.ask({ do: 'grab', path: join(where || asked, r.name) });
    carryGoing.set(id, r.name);
    said = `Fetching ${shorten(r.name, 24)} so it can be dragged`;
    draw();
  };

  const row = (r: FileRow, enter: (() => void) | undefined, id?: string) => {
    const e = document.createElement('div');
    e.className = `fb-row fb-${r.kind}`;
    if (id) e.id = id;
    e.dataset['name'] = r.name;
    e.dataset['kind'] = r.kind;
    // What the row is, in numbers, for the window's own tests to read: a probe that judged the order from the
    // words on screen would be judging how a size is written, not how the list is ordered.
    e.dataset['bytes'] = String(r.size);
    e.dataset['changed'] = String(r.mtime);
    if (chosen.has(r.name)) e.dataset['chosen'] = 'yes';
    e.setAttribute('aria-selected', chosen.has(r.name) ? 'true' : 'false');
    // Every row is a place the keyboard can stand. Which one holds the tab stop is settled after the whole
    // list is on screen, not here.
    e.setAttribute('role', 'option');
    e.addEventListener('mousedown', (ev: MouseEvent) => {
      // The right button never changes what is chosen when it comes down on something already chosen: a menu
      // for several is opened by pressing one of them, and losing the rest to that press would be the opposite
      // of what was asked.
      if (ev.button === 2 && chosen.has(r.name)) {
        place(r.name);
        return;
      }
      chooseByPress(r.name, ev);
      place(r.name);
      if (standing === r.name) draw();
      carry(r);
    });
    // What kind of thing this is, by the end of its name, so a folder of a hundred files can be read by
    // colour before it is read by word. The colours are the ones the approved direction already uses, muted
    // and each meaning one thing (BUILD-RULES 2.2 and 2.3); the shapes stay as they are.
    const mark = glyph(id === 'fb-up' ? 'up' : r.kind);
    mark.classList.add('fb-ft', `fb-ft-${id === 'fb-up' ? 'up' : r.kind === 'file' ? byName(r.name) : r.kind}`);
    e.append(mark);
    const name = document.createElement('span');
    name.className = 'fb-name';
    // A name is data, never markup: it is set as text and nothing else, however it is written.
    name.textContent = r.name;
    name.title = r.name;
    // Size and time are columns of their own now, both on every row, rather than one column on the right
    // saying whatever the list happened to be ordered by. An order by time with no time on screen is an
    // order he has to take on trust, and a size set in the name's own weight shouts as loud as the name.
    const right = document.createElement('span');
    right.className = 'fb-size';
    right.textContent = r.kind === 'folder' ? '' : r.kind === 'file' ? size(r.size) : r.kind;
    const when = document.createElement('span');
    when.className = 'fb-when';
    when.textContent = r.name === '..' || r.mtime <= 0 ? '' : whenShort(r.mtime);
    if (r.name !== '..' && r.mtime > 0) when.title = `last changed ${whenAs(r.mtime)}`;
    e.append(name, right, when);
    // A file this tab has already brought over is draggable from its own row too, not only from the strip:
    // the row is where a person is looking when they decide to take it somewhere.
    const brought = r.kind === 'file' ? broughtOver(r.name) : undefined;
    if (brought !== undefined) {
      e.classList.add('fb-on-pc');
      dragFrom(e, brought, r.name);
    }
    if (enter) {
      e.classList.add('fb-can-enter');
      e.addEventListener('dblclick', enter);
    }
    if (r.kind === 'file') {
      // Bringing the file over, by hand. The button is on the row rather than in a menu, and it says what it
      // does with a glyph before a word (BUILD-RULES 2.1); the keyboard's way to the same thing is Ctrl+S.
      const get = document.createElement('button');
      get.className = 'fb-get fb-bring';
      get.type = 'button';
      get.title = 'Bring this file to the PC (Ctrl+S)';
      get.setAttribute('aria-label', `Bring ${r.name} to the PC`);
      get.tabIndex = -1;
      get.append(glyph('bring'));
      get.addEventListener('click', (ev) => {
        ev.stopPropagation();
        place(r.name);
        // A row's own button means that row, unless that row is one of several he has chosen.
        if (chosen.has(r.name) && chosen.size > 1) for (const n of names().filter((x) => chosen.has(x))) bring(n);
        else bring(r.name);
      });
      const bye = document.createElement('button');
      bye.className = 'fb-get fb-bye';
      bye.type = 'button';
      bye.title = 'Delete this file (Delete)';
      bye.setAttribute('aria-label', `Delete ${r.name}`);
      bye.tabIndex = -1;
      bye.append(glyph('bin'));
      bye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        place(r.name);
        // A row's own button means that row, unless that row is one of several he has chosen: then it means
        // all of them, because that is what is under his hand and what the foot has been counting for him.
        askToDelete(chosen.has(r.name) && chosen.size > 1 ? names().filter((n) => chosen.has(n)) : [r.name]);
      });
      const sum = document.createElement('button');
      sum.className = 'fb-get fb-sum';
      sum.type = 'button';
      sum.title = "The box's own hash of this file (Ctrl+H, Ctrl+Shift+H for md5)";
      sum.setAttribute('aria-label', `The box's own hash of ${r.name}`);
      sum.tabIndex = -1;
      sum.append(glyph('sum'));
      sum.addEventListener('click', (ev) => {
        ev.stopPropagation();
        place(r.name);
        askHash(r.name, ev.shiftKey ? 'md5' : 'sha256');
      });
      e.append(sum, renameBtn(r.name), get, bye);
    } else if (r.kind === 'folder' && r.name !== '..') {
      // A folder is deleted whole, and comes back whole; it has no hash and nothing to bring over.
      const bye = document.createElement('button');
      bye.className = 'fb-get fb-bye';
      bye.type = 'button';
      bye.title = 'Delete this folder (Delete)';
      bye.setAttribute('aria-label', `Delete ${r.name}`);
      bye.tabIndex = -1;
      bye.append(glyph('bin'));
      bye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        place(r.name);
        // A row's own button means that row, unless that row is one of several he has chosen: then it means
        // all of them, because that is what is under his hand and what the foot has been counting for him.
        askToDelete(chosen.has(r.name) && chosen.size > 1 ? names().filter((n) => chosen.has(n)) : [r.name]);
      });
      e.append(renameBtn(r.name), bye);
    }
    return e;
  };

  // The button on a row that gives the thing on it a new name. It is on the row for the same reason the
  // others are: it acts on that row and nothing else. Ctrl is not needed, so the key is F2, which is the key
  // this does on Windows and the one his hands already know from the app this replaces.
  const renameBtn = (name: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'fb-get fb-rename';
    b.type = 'button';
    b.title = 'Give this a new name (F2)';
    b.setAttribute('aria-label', `Give ${name} a new name`);
    b.tabIndex = -1;
    b.append(glyph('rename'));
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      place(name);
      askToRename(name);
    });
    return b;
  };

  // What a row is for, found from its name: the same thing a double-click on it does.
  const opener = (name: string): (() => void) | undefined => {
    const here = where || asked;
    if (name === '..') {
      const up = parent(here);
      return up === '' ? undefined : () => goTo(up);
    }
    const r = rows.find((x) => x.name === name);
    if (!r) return undefined;
    if (r.kind === 'folder') return () => goTo(join(here, r.name));
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

  // The three gestures every file list shares: a press chooses one, Ctrl adds or takes one away, Shift takes
  // everything between what was last pressed and this. The way up is never chosen: it is the window's own way
  // out of a folder, not a thing on the box.
  const choosable = (): string[] => names().filter((n) => n !== '..');
  const chooseOne = (name: string): void => {
    chosen = name === '..' ? new Set() : new Set([name]);
    anchor = name === '..' ? '' : name;
  };
  const chooseAlso = (name: string): void => {
    if (name === '..') return;
    if (chosen.has(name)) chosen.delete(name);
    else chosen.add(name);
    anchor = name;
  };
  const chooseTo = (name: string): void => {
    const all = choosable();
    const from = all.indexOf(anchor === '' ? name : anchor);
    const to = all.indexOf(name);
    if (from < 0 || to < 0) {
      chooseOne(name);
      return;
    }
    chosen = new Set(all.slice(Math.min(from, to), Math.max(from, to) + 1));
  };
  const chooseByPress = (name: string, e: MouseEvent | KeyboardEvent): void => {
    if (e.shiftKey) chooseTo(name);
    else if (e.ctrlKey || e.metaKey) chooseAlso(name);
    else chooseOne(name);
  };
  // How much is chosen, in bytes, counting only the files: a folder's own size says nothing about what is in it.
  const chosenBytes = (): number => rows.filter((r) => chosen.has(r.name) && r.kind === 'file').reduce((n, r) => n + r.size, 0);

  const step = (by: number, e?: KeyboardEvent): void => {
    const all = names();
    if (all.length === 0) return;
    const now = all.indexOf(standing);
    const want = now < 0 ? (by > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, now + by));
    const to = all[want]!;
    // Moving with Shift held takes everything between where the run began and where it now stands; moving
    // without it starts a new run of one. A list whose arrows move a frame but choose nothing is a list that
    // cannot be worked from the keyboard at all.
    if (e?.shiftKey) chooseTo(to);
    else chooseOne(to);
    const moved = standing !== to;
    place(to);
    if (!moved) draw();
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

  // Bringing a file over to the PC. The view says which file on its own box, and nothing else: where it lands
  // and what it is called there are main's (plan B2.7). One file can be brought over once at a time.
  const bring = (name: string): void => {
    const r = rows.find((x) => x.name === name);
    if (!r) return;
    if (r.kind !== 'file') {
      said = `${name} is a ${r.kind === 'folder' ? 'folder' : r.kind}, and only a file can be brought over`;
      draw();
      return;
    }
    for (const b of bringing.values()) {
      if (b.name === name && b.ended === '') {
        // Already on its way. A press that looked as if it did nothing is the silence this app is built
        // not to have, so the line that is already there is named rather than the press being swallowed.
        said = `${shorten(name, 28)} is already on its way over`;
        draw();
        return;
      }
    }
    const id = asker.ask({ do: 'get', path: join(where || asked, name) });
    bringing.set(id, { name, way: 'in', got: 0, of: r.size, began: performance.now(), at: performance.now(), rate: 0, landed: '', mark: '', markWhy: '', renamed: '', replaced: false, asking: '', tookUpAt: 0, ended: '', canDrag: false });
    draw();
  };

  // Deleting, and the trash it goes into. Nothing is removed: the window asks main, main asks the engine, and
  // the engine moves it into the trash on its own disk. What the window does here is ask first, with what
  // would go in front of the person, and then say where it went (BUILD-RULES 2.20, plan B4.4).
  const askToDelete = (names: string[]): void => {
    const want = names.filter((n) => n !== '..' && rows.some((r) => r.name === n));
    if (want.length === 0) return;
    const picked = rows.filter((r) => want.includes(r.name));
    goingToTrash = {
      names: want,
      folders: picked.filter((r) => r.kind === 'folder').length,
      bytes: picked.filter((r) => r.kind === 'file').reduce((n, r) => n + r.size, 0),
    };
    draw();
  };
  // What a press on Delete means: everything chosen, or the row it is standing on when nothing is.
  const toDelete = (): string[] => (chosen.size > 0 ? names().filter((n) => chosen.has(n)) : standing === '' || standing === '..' ? [] : [standing]);

  const reallyDelete = (): void => {
    const going = goingToTrash;
    goingToTrash = null;
    if (!going) return;
    bin.busy = true;
    bin.said = '';
    batch = going.names.length > 1 ? { want: going.names.length, done: 0, failed: 0 } : null;
    for (const name of going.names) asker.ask({ do: 'delete', path: join(where || asked, name) });
    // Nothing stays chosen that is on its way to the trash: what is chosen is what the next press acts on.
    chosen = new Set();
    anchor = '';
    draw();
  };

  // A new name for one thing, and a new folder in the folder on screen. The panel is the same for both: a
  // field with one name in it and one press either way. What a box would refuse is said here first, before
  // anything leaves the window, so a name that cannot work is answered at once instead of after a round trip
  // (BUILD-RULES 2.20). The box is still the one that decides: it checks the same things again.
  const askToRename = (name: string): void => {
    if (name === '' || name === '..') return;
    if (!rows.some((x) => x.name === name)) return;
    naming = { mode: 'rename', was: name, name, busy: false, said: '', id: 0 };
    draw();
  };

  const askForFolder = (): void => {
    naming = { mode: 'folder', was: '', name: '', busy: false, said: '', id: 0 };
    draw();
  };

  // What is wrong with a name, in words, or an empty string when nothing is. The rules are the box's own
  // (src/main/main.ts holds to them too), said here as a person would hear them.
  const wrongWith = (name: string): string => {
    if (name === '') return 'Type a name';
    if (name === '.' || name === '..') return 'That name is a folder\u2019s own shorthand, so nothing can be called it';
    if (name.includes('/')) return 'A name cannot hold a slash: that would be a path to somewhere else';
    if (name.length > 255) return 'That name is longer than a box will take';
    for (const ch of name) {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20 || c === 0x7f) return 'That name holds something that is not a character a name can hold';
    }
    return '';
  };

  const reallyName = (): void => {
    const n = naming;
    if (!n || n.busy) return;
    const name = n.name;
    const wrong = wrongWith(name);
    if (wrong !== '') {
      n.said = wrong;
      draw();
      return;
    }
    if (n.mode === 'rename' && name === n.was) {
      naming = null;
      draw();
      return;
    }
    if (rows.some((x) => x.name === name)) {
      n.said = NAME_WHY['already-there']!;
      draw();
      return;
    }
    n.busy = true;
    n.said = '';
    n.id = asker.ask(
      n.mode === 'rename' ? { do: 'rename', path: join(where || asked, n.was), name } : { do: 'folder', path: where || asked, name },
    );
    draw();
  };

  const openTrash = (): void => {
    bin = { open: true, where: '', rows: [], busy: true, said: '' };
    askingTrash = asker.ask({ do: 'trash', path: where || asked });
    draw();
  };

  // The emptying that happens by itself when a tab comes up: the same thing the button does, but it says
  // nothing at all when there was nothing old enough, because that is not news, and nothing when the disk
  // cannot hold a trash, because a tab coming up is not the place to say so.
  let emptiedOnce = false;
  let quietly = false;
  // What has been in this disk's trash longer than the box keeps things goes once per tab. It waits for the
  // box to have said where the tab really is: a tab opened at the account's home asks for ".", which is not
  // a path, so the engine refused it and the emptying quietly never happened for any such tab. What decides
  // which disk the trash is on is the folder the box named, not the one we asked for.
  let emptyWhenKnown = false;
  const emptyOldTrash = (): void => {
    if (emptiedOnce) return;
    if (where === '') {
      emptyWhenKnown = true;
      return;
    }
    emptiedOnce = true;
    quietly = true;
    asker.ask({ do: 'empty', path: where });
  };

  const emptyTrash = (): void => {
    bin.busy = true;
    bin.said = '';
    asker.ask({ do: 'empty', path: where || asked });
    draw();
  };

  const putBack = (name: string): void => {
    bin.busy = true;
    bin.said = '';
    asker.ask({ do: 'restore', path: where || asked, name });
    draw();
  };

  // A box's own hash of one of its files, because a person asked for it. sha256 is what a transfer compares;
  // md5 is here because people still paste md5 at each other, and it is the only other hash a box may ever be
  // asked for (plan B2.5, entry 3). What comes back can be copied, and an expected one can be pasted in and
  // compared here, so nobody has to compare sixty-four characters by eye.
  type Hashing = { name: string; which: 'sha256' | 'md5'; hash: string; fault: string; expected: string };
  let hashing: Hashing | null = null;
  // The trash of the disk the folder on screen is on: what is in it, and what the last thing done to it was.
  type Binned = { open: boolean; where: string; rows: TrashedRow[]; busy: boolean; said: string };
  let bin: Binned = { open: false, where: '', rows: [], busy: false, said: '' };
  let askingTrash = 0;
  // What is going to the trash: every name he chose, not the one row the keyboard happened to stand on. A
  // delete is the one act in this app that must never act on something he did not mean, so the dialog names
  // what goes and the count is his own count, the one the foot was showing him.
  let goingToTrash: { names: string[]; folders: number; bytes: number } | null = null;
  // A batch of deletes in flight: one ask each, and what is said at the end is the count rather than whichever
  // of them the box happened to answer last.
  let batch: { want: number; done: number; failed: number } | null = null;
  // Naming something: a new name for what is there, or one new folder. Both are the same panel, because both
  // are one name typed and one press, and the box is not asked until the name could be a name at all.
  let naming: { mode: 'rename' | 'folder'; was: string; name: string; busy: boolean; said: string; id: number } | null = null;
  // Which row the list should stand on once the next listing arrives: what was just renamed or just made, so
  // the eye and the keyboard both end up on the thing that changed rather than back at the top.
  let standNext = '';
  // And what the foot should say once it arrives: a listing clears whatever was said, because it is a new
  // folder's worth of rows, so a word about what just changed has to be carried across it.
  let sayNext = '';
  // The naming panel's own field, kept for as long as the panel is open so that a redraw puts the same field
  // back rather than a new one: a new one loses the caret, and with it a person's place in the name.
  let nameField: HTMLInputElement | null = null;
  type TrashedRow = { name: string; from: string; when: number; size: number; kind: string };

  const askHash = (name: string, which: 'sha256' | 'md5'): void => {
    const r = rows.find((x) => x.name === name);
    if (!r || r.kind !== 'file') return;
    hashing = { name, which, hash: '', fault: '', expected: '' };
    asker.ask({ do: 'hash', path: join(where || asked, name), which });
    draw();
  };

  // Sending a file from the PC to this folder on the box. The view says the folder and nothing else: which
  // file leaves this PC is answered in the system's own chooser, which only a person can answer (plan B2.7).
  const send = (): void => {
    const here = where || asked;
    if (here === '' || busy) return;
    const id = asker.ask({ do: 'put', path: here });
    bringing.set(id, { name: 'a file from the PC', way: 'out', got: 0, of: 0, began: performance.now(), at: performance.now(), rate: 0, landed: '', mark: '', markWhy: '', renamed: '', replaced: false, asking: '', tookUpAt: 0, ended: '', canDrag: false });
    draw();
  };

  // The list is reached by the keyboard, not only by a mouse: Tab lands on it, the arrows move inside it, and
  // Enter opens what a double-click would. Anything with Ctrl, Alt or the Windows key is not the list's: those
  // belong to the window itself or to the box.
  // Escape keeps whatever is being asked about, from anywhere in the pane.
  at.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || (!goingToTrash && !naming)) return;
    goingToTrash = null;
    naming = null;
    draw();
    e.preventDefault();
  });

  el.list.addEventListener('keydown', (e: KeyboardEvent) => {
    // The one press with Ctrl the list answers: bringing the file it is standing on over to the PC. It is the
    // save key, it is not a key a window or a box has any use for here, and the list is not a terminal.
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 's' || e.key === 'S')) {
      // Everything chosen, or the row it stands on when nothing is: the same reach the delete has, because
      // choosing five and bringing one over is the same broken promise in the other direction. Folders and
      // what is already on its way say so for themselves, one line each, inside bring.
      const want = chosen.size > 0 ? names().filter((n) => chosen.has(n)) : standing === '' || standing === '..' ? [] : [standing];
      for (const n of want) bring(n);
      e.preventDefault();
      return;
    }
    // And the one other: asking the box for its own hash of the file the list is standing on. Shift makes it
    // md5, which is the only other hash a box may ever be asked for.
    // Everything in the folder. It goes here, above the guard that turns every other press with Ctrl away:
    // put below it, this was never reached at all, which is what the probe found.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'a' || e.key === 'A')) {
      chosen = new Set(choosable());
      anchor = chosen.size > 0 ? [...chosen][0]! : '';
      said = chosen.size === 0 ? 'There is nothing in this folder to choose' : `${chosen.size} chosen`;
      draw();
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) {
      askHash(standing, e.shiftKey ? 'md5' : 'sha256');
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const all = names();
    if (e.key === 'Delete') {
      askToDelete(toDelete());
    } else if (e.key === 'F2') {
      askToRename(standing);
    } else if (e.key === 'ArrowDown') step(1, e);
    else if (e.key === 'ArrowUp') step(-1, e);
    else if (e.key === 'Home') place(all[0] ?? '');
    else if (e.key === 'End') place(all[all.length - 1] ?? '');
    else if (e.key === 'PageDown') step(10, e);
    else if (e.key === 'PageUp') step(-10, e);
    else if (e.key === 'Enter' || e.key === ' ') enterHere();
    else if (e.key === 'ArrowRight') {
      if (rows.find((x) => x.name === standing)?.kind !== 'folder') return;
      enterHere();
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
      const up = parent(where || asked);
      if (up === '') return;
      goTo(up);
    } else return;
    e.preventDefault();
  });

  return {
    open: goTo,
    emptyOldTrash,
    shown: () => where,
    rows: () => rows.length,
    draw,
  };
}

// How long ago something was, in the words a person uses for it.
function howLongAgo(when: number): string {
  const ago = Date.now() / 1000 - when;
  if (ago < 90) return 'a moment ago';
  if (ago < 5400) return `${Math.round(ago / 60)} minutes ago`;
  if (ago < 36 * 3600) return `${Math.round(ago / 3600)} hours ago`;
  return `${Math.round(ago / 86400)} days ago`;
}

// A length of time in the words a person uses for it, never more exactly than it is worth saying.
function howLong(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 360) / 10}h`;
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
// What kind of file a name says it is. Only the end of the name is read: a box is asked nothing for this, and
// nothing is opened to find out. A name with no end to read, which is most of what sits in /etc, is a plain
// file and wears the plain colour.
const KINDS: Record<string, string> = {
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive', '7z': 'archive', rar: 'archive',
  log: 'log', out: 'log', err: 'log',
  txt: 'text', text: 'text', rst: 'text',
  md: 'markdown', markdown: 'markdown',
  sh: 'script', bash: 'script', zsh: 'script', ps1: 'script', bat: 'script', cmd: 'script', py: 'script', rb: 'script', pl: 'script',
  conf: 'config', cfg: 'config', ini: 'config', toml: 'config', yaml: 'config', yml: 'config', env: 'config', service: 'config', timer: 'config',
  json: 'json',
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', mjs: 'code', cjs: 'code', go: 'code', c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', rs: 'code', java: 'code', php: 'code', css: 'code', html: 'code', htm: 'code', xml: 'code',
  sql: 'sql', db: 'sql', sqlite: 'sql',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image', bmp: 'image',
};

function byName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'file';
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? 'file';
}

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
  bring: 'M8 2.5v7M5 6.5L8 9.5l3-3M3.5 12.5h9',
  send: 'M8 9.5v-7M5 5.5L8 2.5l3 3M3.5 12.5h9',
  sum: 'M4.5 3.5h7l-4 4.5 4 4.5h-7',
  copy: 'M5.5 5.5h7.5v7.5h-7.5zM3 10.5V3h7.5',
  bin: 'M3.5 4.5h9M6 4.5V3h4v1.5M4.5 4.5l.75 8.5h5.5l.75-8.5M7 7v3.5M9 7v3.5',
  back: 'M3.5 8.5h7a2.5 2.5 0 0 0 0-5H7M6 11L3.5 8.5 6 6',
  // Going back and forward through the folders this tab has been in. Their own glyphs: the one above means
  // putting a thing back from the trash, which is a different act and may not share a picture with this.
  wayBack: 'M10 3.5L5.5 8l4.5 4.5',
  wayForward: 'M6 3.5L10.5 8 6 12.5',
  recent: 'M4 6.5L8 10.5l4-4',
  // Narrowing the list: a lens, drawn as the one glyph a person already reads as "look for".
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5l3 3',
  // The three columns the list can be ordered by: letters, a stack with weight at its foot, and a clock.
  name: 'M3.5 4.5h9M3.5 8h6M3.5 11.5h3',
  size: 'M4.5 3.5h7M3.5 7h9M2.5 10.5h11M2.5 13h11',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.5l2.5 1.5',
  // Naming: a pencil for a new name, and the same folder as above with a plus in it for a new folder. Both
  // are the shape a person already reads as the thing, and neither is a word in a picture.
  rename: 'M9.5 3.5l3 3-6 6h-3v-3zM8 5l3 3',
  newfolder: 'M2.5 4.5h4l1.5 1.5h5.5v7h-11zM8 8.5v3.5M6.25 10.25h3.5',
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
