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
  let said = ''; // the answer to a press that opened nothing, shown on the foot until the place moves
  // Files being brought over to the PC, by the number of the ask that is bringing each. A tab may be bringing
  // more than one at a time, and the strip at the foot says what each is doing.
  type Bringing = { name: string; way: 'in' | 'out'; got: number; of: number; began: number; at: number; rate: number; landed: string; mark: string; markWhy: string; renamed: string; replaced: boolean; asking: string; tookUpAt: number; ended: string };
  const bringing = new Map<number, Bringing>();

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
  binBtn.addEventListener('click', () => {
    if (bin.open) {
      bin = { open: false, where: '', rows: [], busy: false, said: bin.said };
      draw();
      return;
    }
    openTrash();
  });
  here.append(el.path, binBtn, sendBtn);
  at.append(here, el.list, el.moving, el.foot);

  const ask = (a: FileAsk) => asker.ask(a);

  const open = (path: string, keepTries = 0) => {
    if (trying) {
      clearTimeout(trying);
      trying = null;
    }
    tried = keepTries;
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
  const WORTH_ANOTHER_TRY = new Set(['unsupported', 'no-link', 'no-answer', 'failed']);
  const TRIES = 3;
  let tried = 0;
  let trying: ReturnType<typeof setTimeout> | null = null;

  port.onFilePage((p: FilePage) => {
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
    // The trash: what a delete, a restore or an emptying did, and what is in it now.
    if (p.trash !== undefined || p.trashed !== undefined || p.emptied !== undefined || (bin.busy && p.done)) {
      if (p.trash !== undefined) {
        bin.rows = p.trash;
        bin.where = p.where ?? bin.where;
      }
      if (p.trashed) {
        const t = p.trashed;
        bin.said = p.id === askingTrash ? bin.said : `${shorten(t.from.split('/').pop() ?? t.name, 30)} ${bin.open ? 'is back where it was' : 'is in the trash'}`;
        if (bin.open) bin.rows = bin.rows.filter((x) => x.name !== t.name);
        else open(where || asked); // the folder it left is listed again, so the row goes
      }
      if (typeof p.emptied === 'number' || typeof p.freed === 'number') {
        const n = p.emptied ?? 0;
        if (!quietly || n > 0) bin.said = n === 0 ? 'Nothing in the trash is old enough to empty' : `${n} ${n === 1 ? 'thing' : 'things'} older than ${TRASH_DAYS} days emptied from the trash, ${size(p.freed ?? 0)} freed`;
        if (bin.open) openTrash();
      }
      if (p.done) {
        bin.busy = false;
        if (p.error && !quietly) bin.said = TRASH_WHY[p.error] ?? TRASH_WHY['failed']!;
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
      if (typeof p.mark === 'string') down.mark = p.mark;
      if (typeof p.markWhy === 'string') down.markWhy = p.markWhy;
      if (typeof p.renamed === 'string') down.renamed = p.renamed;
      if (p.replaced === true) down.replaced = true;
      if (typeof p.asking === 'string') down.asking = p.asking;
      if (typeof p.resumedAt === 'number' && p.resumedAt > 0) down.tookUpAt = p.resumedAt;
      if (p.done) {
        down.asking = '';
        const words = down.way === 'in' ? DOWNLOAD_WHY : SEND_WHY;
        down.ended = p.error
          ? (words[p.error] ?? words['failed']!)
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
      : [`${rows.length} ${rows.length === 1 ? 'item' : 'items'}${busy ? ', reading' : ''}`];
    if (!bin.open && bin.said !== '') bits.push(bin.said);
    if (space && !bin.open) bits.push(`${size(space.free)} free of ${size(space.total)}`);
    if (said !== '' && !bin.open) bits.push(said);
    // What is being brought over or sent, one line each: how far it has got, how fast, and how long is left.
    // A finished one says where it went and whether it could be checked, and stays until the next move. These
    // go under the counts and may take two lines, because what they say is a sentence and a sentence that is
    // cut off at the edge of the pane is a sentence nobody can read.
    const lines: string[] = [];
    for (const b of bringing.values()) {
      if (b.ended !== '') {
        lines.push(b.ended);
        continue;
      }
      if (b.asking !== '') {
        lines.push(`${shorten(b.asking, 28)} is already on the box: waiting on your answer`);
        continue;
      }
      const left = b.rate > 1 && b.of > b.got ? `, ${howLong((b.of - b.got) / b.rate)} left` : '';
      const name = shorten(b.landed === '' ? b.name : b.landed, 28);
      // Until the other end has said how big it is there is nothing worth counting, so nothing is counted.
      const far = b.of > 0 ? ` ${size(b.got)} of ${size(b.of)}${b.rate > 1 ? `, ${size(b.rate)}/s` : ''}${left}` : '';
      const tookUp = b.tookUpAt > 0 ? `, taken up at ${size(b.tookUpAt)}` : '';
      lines.push(`${b.way === 'out' ? 'Sending ' : ''}${name}${far}${tookUp}`);
    }
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
      head.textContent = `Delete ${shorten(goingToTrash.name, 26)}?`;
      const said = document.createElement('div');
      said.className = 'fb-ask-said';
      said.id = 'fb-ask-said';
      said.textContent =
        goingToTrash.kind === 'folder'
          ? 'It goes to this disk\u2019s trash, whole, and can be brought back from there. The box keeps it for 7 days.'
          : `${size(goingToTrash.size)}. It goes to this disk\u2019s trash and can be brought back from there. The box keeps it for 7 days, so that much stays used.`;
      const acts = document.createElement('div');
      acts.className = 'fb-ask-acts';
      const keep = document.createElement('button');
      keep.className = 'fb-ask-keep';
      keep.id = 'fb-ask-keep';
      keep.type = 'button';
      keep.append(glyph('close'));
      const keepWord = document.createElement('span');
      keepWord.textContent = 'Keep it';
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
      goWord.textContent = 'Delete it';
      go.append(goWord);
      go.addEventListener('click', () => reallyDelete());
      acts.append(keep, go);
      ask.append(head, said, acts);
      el.moving.append(ask);
      setTimeout(() => (document.getElementById('fb-ask-keep') as HTMLButtonElement | null)?.focus(), 0);
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
    for (const [id, b] of bringing) {
      const one = document.createElement('div');
      one.className = 'fb-moving-one';
      const words = document.createElement('span');
      words.textContent = lines.shift() ?? '';
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
    if (r.kind === 'file') {
      // Bringing the file over, by hand. The button is on the row rather than in a menu, and it says what it
      // does with a glyph before a word (BUILD-RULES 2.1); the keyboard's way to the same thing is Ctrl+S.
      const get = document.createElement('button');
      get.className = 'fb-get';
      get.type = 'button';
      get.title = 'Bring this file to the PC (Ctrl+S)';
      get.setAttribute('aria-label', `Bring ${r.name} to the PC`);
      get.tabIndex = -1;
      get.append(glyph('bring'));
      get.addEventListener('click', (ev) => {
        ev.stopPropagation();
        place(r.name);
        bring(r.name);
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
        askToDelete(r.name);
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
      e.append(sum, get, bye);
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
        askToDelete(r.name);
      });
      e.append(bye);
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
      if (b.name === name && b.ended === '') return; // already on its way
    }
    const id = asker.ask({ do: 'get', path: join(where || asked, name) });
    bringing.set(id, { name, way: 'in', got: 0, of: r.size, began: performance.now(), at: performance.now(), rate: 0, landed: '', mark: '', markWhy: '', renamed: '', replaced: false, asking: '', tookUpAt: 0, ended: '' });
    draw();
  };

  // Deleting, and the trash it goes into. Nothing is removed: the window asks main, main asks the engine, and
  // the engine moves it into the trash on its own disk. What the window does here is ask first, with what
  // would go in front of the person, and then say where it went (BUILD-RULES 2.20, plan B4.4).
  const askToDelete = (name: string): void => {
    const r = rows.find((x) => x.name === name);
    if (!r) return;
    goingToTrash = { name, kind: r.kind, size: r.size };
    draw();
  };

  const reallyDelete = (): void => {
    const going = goingToTrash;
    goingToTrash = null;
    if (!going) return;
    bin.busy = true;
    bin.said = '';
    asker.ask({ do: 'delete', path: join(where || asked, going.name) });
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
  const emptyOldTrash = (): void => {
    if (emptiedOnce) return;
    emptiedOnce = true;
    quietly = true;
    asker.ask({ do: 'empty', path: where || asked });
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
  let goingToTrash: { name: string; kind: string; size: number } | null = null;
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
    bringing.set(id, { name: 'a file from the PC', way: 'out', got: 0, of: 0, began: performance.now(), at: performance.now(), rate: 0, landed: '', mark: '', markWhy: '', renamed: '', replaced: false, asking: '', tookUpAt: 0, ended: '' });
    draw();
  };

  // The list is reached by the keyboard, not only by a mouse: Tab lands on it, the arrows move inside it, and
  // Enter opens what a double-click would. Anything with Ctrl, Alt or the Windows key is not the list's: those
  // belong to the window itself or to the box.
  // Escape keeps whatever is being asked about, from anywhere in the pane.
  at.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !goingToTrash) return;
    goingToTrash = null;
    draw();
    e.preventDefault();
  });

  el.list.addEventListener('keydown', (e: KeyboardEvent) => {
    // The one press with Ctrl the list answers: bringing the file it is standing on over to the PC. It is the
    // save key, it is not a key a window or a box has any use for here, and the list is not a terminal.
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 's' || e.key === 'S')) {
      bring(standing);
      e.preventDefault();
      return;
    }
    // And the one other: asking the box for its own hash of the file the list is standing on. Shift makes it
    // md5, which is the only other hash a box may ever be asked for.
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) {
      askHash(standing, e.shiftKey ? 'md5' : 'sha256');
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const all = names();
    if (e.key === 'Delete') {
      if (standing !== '' && standing !== '..') askToDelete(standing);
    } else if (e.key === 'ArrowDown') step(1);
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
