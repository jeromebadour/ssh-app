// The bar at the top of the window, as approved in pictures on 2026-11-16: the mark, the Boxes menu, the tabs
// grouped by box (each saying its box in the box's colour, then its place), and when the tabs would not fit, a
// box with several tabs folded into one with a count that opens them as a list.
//
// Every press answers at once (BUILD-RULES 2.18): a pressed tab takes its selected look the moment it is
// pressed, and keeps it until main says which tab is in front.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BoxView, ShellState, TabInfo } from '../common/ipc';
import { ending } from '../common/link-words';
import { Glyph, glyphNode } from './glyphs';
import { openMenu, type MenuLine } from './menu';
import { Mark } from './marks';

export interface BarActions {
  select(id: number): void;
  close(id: number): void;
  open(box: string, place: string): void; // a pinned box: a tab; a box never checked: its check
  addBox(from?: string): void; // from: a box to make this one from (Duplicate)
  editBox(box: string): void;
  removeBox(box: string): void;
  menu(open: boolean): void; // a menu is open: the shell must be above the tabs
  settings(): void; // open the settings
  window(what: 'minimize' | 'maximize' | 'close'): void; // the window's own three buttons
  reopen(which: number[]): void; // the morning: open these of the last session's tabs again
  dropReopen(): void; // put the morning's offer away, and forget what was open
}

const TAB_MIN = 168 + 10; // a tab's width and the room beside it, while there is room

// A tab's mark and its words, from where its link stands.
export function tabLook(t: TabInfo): { mark: string; words: string; sig: string } {
  const l = t.link;
  if (!t.box) return { mark: t.state === 'ready' ? 'connected' : t.state === 'starting' ? 'connecting' : 'gone', words: t.state, sig: '' };
  if (t.state === 'not-answering') return { mark: 'silent', words: 'not answering', sig: '' };
  switch (l.phase) {
    case 'none':
    case 'connecting':
    case 'key-exchange':
    case 'signing-in':
      return { mark: 'connecting', words: l.phase === 'signing-in' ? 'signing in' : 'connecting', sig: '' };
    case 'up':
      return l.silentSinceMs > 0 ? { mark: 'silent', words: 'no answer', sig: `${Math.max(0, Math.round((Date.now() - l.silentSinceMs) / 1000))} s` } : { mark: 'connected', words: 'connected', sig: '' };
    case 'ended':
      return l.cause === 'identity-changed' ? { mark: 'stopped', words: ending(l.cause).short, sig: 'stopped' } : { mark: 'gone', words: 'gone', sig: '' };
  }
}

// How long something took, in the fewest characters that still mean it: a tab is a few letters wide, so the
// full words ("3 minutes") go in what the pointer shows and this goes on the tab.
export function shortLong(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? `${m % 60}m` : ''}`;
}

// The same length in the words a person says, for what the pointer shows. Main writes this for a
// notification; the bar writes it for a tab, and the two say the same thing.
export function howLong(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${rest > 0 ? ` and ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

export function placeLabel(t: TabInfo, boxes: BoxView[]): string {
  if (!t.box) return t.state;
  if (t.box.place) return t.box.place;
  const box = boxes.find((b) => b.id === t.box!.id);
  const folder = box?.folder ?? '';
  return folder === '' ? 'home' : folder.split('/').filter(Boolean).pop() ?? '/';
}

interface Group {
  key: string;
  box: TabInfo['box'];
  tabs: TabInfo[];
}

function groupsOf(tabs: TabInfo[]): Group[] {
  const out: Group[] = [];
  for (const t of tabs) {
    const key = t.box ? `box:${t.box.id}` : `tab:${t.id}`;
    const g = out.find((x) => x.key === key);
    if (g) g.tabs.push(t);
    else out.push({ key, box: t.box, tabs: [t] });
  }
  return out;
}

// Which groups fold: the ones with most tabs first, until what is left fits at a tab's full width.
function foldsFor(groups: Group[], room: number): Set<string> {
  const folded = new Set<string>();
  const count = () => groups.reduce((n, g) => n + (folded.has(g.key) ? 1 : g.tabs.length), 0);
  const many = groups.filter((g) => g.tabs.length > 1).sort((a, b) => b.tabs.length - a.tabs.length);
  for (const g of many) {
    if (count() * TAB_MIN <= room) break;
    folded.add(g.key);
  }
  return folded;
}

function TabMark(props: { t: TabInfo }) {
  const look = tabLook(props.t);
  return <span class={`conn conn-${look.mark}`} title={look.words} />;
}

// The window's own three buttons, at the right-hand end of the bar. Windows draws no title bar for Berth, so
// these are the only way to minimize, maximize or close with the mouse, and they are Berth's own: its spacing,
// its colours, and its answer to a press (BUILD-RULES 2.18), not a strip of Windows' chrome above the app.
//
// Close is last and apart from the other two, as it is on every window: it is the one of the three a person
// must not press by mistake while reaching for the others.
// The same three buttons on the screens shown before the lock is open, where there is no bar to put them in.
// Without this the password screen would have no way to close, minimize or move the window with the mouse at
// all, Windows having been told to draw no title bar: a window a person cannot put away is not acceptable, and
// the lock screen is the first thing they see.
export function WindowStrip(props: { maximized: boolean; act: BarActions }) {
  return (
    <div class="win-strip" id="win-strip">
      <WindowButtons maximized={props.maximized} act={props.act} />
    </div>
  );
}

function WindowButtons(props: { maximized: boolean; act: BarActions }) {
  return (
    <div class="win-buttons" id="win-buttons">
      <button type="button" class="win-btn" id="win-min" aria-label="Minimize" title="Minimize" onClick={() => props.act.window('minimize')}><Glyph name="winMinimize" /></button>
      <button type="button" class="win-btn" id="win-max" aria-label={props.maximized ? 'Restore' : 'Maximize'} title={props.maximized ? 'Restore' : 'Maximize'} onClick={() => props.act.window('maximize')}>
        <Glyph name={props.maximized ? 'winRestore' : 'winMaximize'} />
      </button>
      <button type="button" class="win-btn win-close" id="win-close" aria-label="Close Berth" title="Close Berth" onClick={() => props.act.window('close')}><Glyph name="winClose" /></button>
    </div>
  );
}

export function Bar(props: { s: ShellState; act: BarActions }) {
  const [pressed, setPressed] = useState(0);
  const [menu, setMenu] = useState<'' | 'boxes' | string>(''); // '' none, 'boxes', or a group's key for its fold
  const [room, setRoom] = useState(10_000);
  const groupsEl = useRef<HTMLDivElement>(null);
  useEffect(() => setPressed(0), [props.s.active]);
  useLayoutEffect(() => {
    const el = groupsEl.current;
    if (!el) return;
    const measure = () => setRoom(el.clientWidth - 48);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const showMenu = (m: string) => {
    setMenu(m);
    props.act.menu(m !== '');
  };
  const front = pressed || props.s.active;
  const groups = groupsOf(props.s.tabs);
  const folded = foldsFor(groups, room);
  const n = groups.reduce((k, g) => k + (folded.has(g.key) ? 1 : g.tabs.length), 0);
  const hue = (b: TabInfo['box']) => `var(--box-${b?.colour ?? 1})`;
  const pick = (id: number) => {
    setPressed(id);
    props.act.select(id);
  };

  const tabEl = (t: TabInfo, fold?: Group) => {
    const look = tabLook(t);
    const isFront = t.id === front;
    return (
      <span class={`tab ${isFront ? 'active' : ''}`} key={t.id} data-tab={t.id} data-state={look.mark} aria-selected={isFront} title={`${t.box?.name ?? `tab ${t.id}`} · ${placeLabel(t, props.s.boxes)} · ${look.words}`} onPointerDown={() => setPressed(t.id)} onClick={() => props.act.select(t.id)}>
        <TabMark t={t} />
        <span class="tab-box">{t.box ? t.box.name : `tab ${t.id}`}</span>
        <span class="tab-place">{placeLabel(t, props.s.boxes)}</span>
        <span class="tab-end">
          {look.sig === 'stopped' ? <Glyph name="identityBroken" class="sig sig-stopped" label="identity changed" /> : look.sig !== '' && <span class="sig sig-silent">{look.sig}</span>}
          {/* What happened in this tab while he was looking at another one. A command that finished says how
              long it took, because that is what he asked to be told; something still running says so with a
              clock; output nobody has seen yet is a quiet dot. All three go the moment the tab is in front. */}
          {t.finishedMs > 0 ? (
            <span class="sig sig-done" title={`a command finished here: it took ${howLong(t.finishedMs)}`}><Glyph name="check" class="sig-glyph" />{shortLong(t.finishedMs)}</span>
          ) : !isFront && t.doing === 'running' ? (
            <Glyph name="running" class="sig sig-running" label="something is running here" />
          ) : (
            !isFront && t.unseen && <span class="sig sig-output" title="it printed while you were in another tab" />
          )}
          {fold && (
            <button type="button" class={`fold-n ${menu === fold.key ? 'open' : ''}`} data-fold={fold.key} aria-haspopup="menu" aria-expanded={menu === fold.key} aria-label={`${fold.tabs.length} tabs on ${t.box?.name ?? ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); showMenu(menu === fold.key ? '' : fold.key); }}>
              {fold.tabs.length}
              <Glyph name="chevron" class="caret" />
            </button>
          )}
          {(!fold || isFront) && <button type="button" class="tab-close" data-close={t.id} aria-label={`Close ${t.box?.name ?? `tab ${t.id}`} ${placeLabel(t, props.s.boxes)}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); props.act.close(t.id); }}><Glyph name="close" class="tab-x" /></button>}
        </span>
      </span>
    );
  };

  // The right button on the tab strip: on a tab, what can be done to that tab and the ones beside it; on the
  // empty part, what the strip itself is for. The same component the panes use, drawn in a layer of its own
  // outside the app, because the app is redrawn whenever anything changes and would sweep a menu away
  // mid-press.
  //
  // What is deliberately not in it, and waits for him: Rename tab and Set tab colour, which his reference
  // menu has and Berth has nowhere to put, because a tab is named by its box and its place and takes its
  // colour from its box; Duplicate tab, because a place that keeps running is one session on the box and one
  // tab here, so what a second tab on it would mean is not decided; and Reopen the last closed tab, which
  // would need a record of what was closed that nothing in the app keeps.
  const stripMenu = (e: MouseEvent) => {
    const layer = document.getElementById('shell-menus');
    if (!layer) return;
    const on = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tab]');
    const id = Number(on?.dataset['tab'] ?? '');
    const tabs = props.s.tabs;
    const lines: MenuLine[] = [];
    if (on && Number.isFinite(id)) {
      const t = tabs.find((x) => x.id === id);
      const after = tabs.slice(tabs.findIndex((x) => x.id === id) + 1);
      const others = tabs.filter((x) => x.id !== id);
      lines.push({ glyph: 'close', label: 'Close this tab', danger: true, run: () => props.act.close(id), id: 'tab-menu-close' });
      if (others.length > 0) lines.push({ glyph: 'close', label: `Close the other ${others.length === 1 ? 'tab' : `${others.length} tabs`}`, danger: true, run: () => { for (const x of others) props.act.close(x.id); }, id: 'tab-menu-others' });
      if (after.length > 0) lines.push({ glyph: 'close', label: `Close the ${after.length === 1 ? 'one' : after.length} to the right`, danger: true, run: () => { for (const x of after) props.act.close(x.id); }, id: 'tab-menu-right' });
      if (t?.box) {
        lines.push({ apart: true });
        lines.push({ glyph: 'edit', label: `Edit ${t.box.name}`, run: () => props.act.editBox(t.box!.id), id: 'tab-menu-edit' });
      }
    } else {
      lines.push({ glyph: 'plus', label: 'Open a box', run: () => showMenu('boxes'), id: 'tab-menu-open' });
      lines.push({ apart: true });
      lines.push({ glyph: 'settings', label: 'Settings', run: () => props.act.settings(), id: 'tab-menu-settings' });
    }
    e.preventDefault();
    // While a menu is open the window has to be above its tabs, or the menu is drawn behind the one it is
    // about. The same switch every other menu in the shell throws, put back however the menu goes.
    const menu = openMenu(layer, e.clientX, e.clientY, lines, glyphNode, () => props.act.menu(false));
    if (menu) props.act.menu(true);
  };

  // Three rows (his, 2026-11-18 night). The nav is what he does to the app; the strip below it is what he is
  // working in. One row made them fight: the Boxes button sat among his tabs, and everything the app could do
  // was folded inside that one menu because there was nowhere else for it to be.
  //
  // The nav is the window's title bar, so it drags and carries the window's own three buttons at its end.
  // **The strip deliberately does not drag.** It did when it was one row, and a region Windows drags by
  // swallows the press before the page sees it, so the right button on the strip's empty part could not have
  // worked on his machine however well it worked under a dispatched event in the lab.
  return (
    <>
      <header class="nav" id="nav">
        <div class="brand"><Mark /><span class="wordmark">Berth</span></div>
        <button type="button" class={`nav-btn boxes-btn ${menu === 'boxes' ? 'open' : ''}`} id="boxes" aria-haspopup="menu" aria-expanded={menu === 'boxes'} onClick={() => showMenu(menu === 'boxes' ? '' : 'boxes')}>
          <Glyph name="boxes" />Boxes<Glyph name="chevron" class="caret" />
        </button>
        <button type="button" class="nav-btn" id="settings-open" onClick={() => { showMenu(''); props.act.settings(); }}><Glyph name="settings" />Settings</button>
        <span class="nav-rest" />
        <WindowButtons maximized={props.s.maximized} act={props.act} />
      </header>
    <header class="tabbar" id="bar" onContextMenu={stripMenu}>
      <div class="tab-groups" ref={groupsEl} style={{ '--n': n }}>
        {groups.map((g) => {
          if (!folded.has(g.key)) {
            return (
              <div class="tab-group" key={g.key} style={{ '--hue': hue(g.box) }}>
                {g.tabs.map((t) => tabEl(t))}
              </div>
            );
          }
          const shown = g.tabs.find((t) => t.id === front) ?? g.tabs[g.tabs.length - 1]!;
          return (
            <div class="tab-group folded" key={g.key} style={{ '--hue': hue(g.box) }}>
              {tabEl(shown, g)}
              {menu === g.key && (
                <div class="fold-menu" role="menu" id="fold-menu" aria-label={`Tabs on ${g.box?.name ?? ''}`}>
                  {g.tabs.map((t) => (
                    <div class={`fm-row ${t.id === shown.id ? 'front' : ''}`} key={t.id} role="menuitem" data-fold-tab={t.id} onClick={() => { showMenu(''); pick(t.id); }}>
                      <TabMark t={t} />
                      <Glyph name="place" class="fm-glyph" />
                      <span class="fm-place">{placeLabel(t, props.s.boxes)}</span>
                      <button type="button" class="fm-x-btn" aria-label={`Close ${placeLabel(t, props.s.boxes)}`} onClick={(e) => { e.stopPropagation(); props.act.close(t.id); }}><Glyph name="close" class="fm-x" /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <button type="button" class="new-tab" id="new" aria-label="Open a box" onClick={() => showMenu(menu === 'boxes' ? '' : 'boxes')}><Glyph name="plus" /></button>
      </div>
      {menu === 'boxes' && <BoxMenu s={props.s} act={props.act} done={() => showMenu('')} />}
      {menu !== '' && <div class="menu-away" onPointerDown={() => showMenu('')} />}
    </header>
    </>
  );
}

// The Boxes menu: the saved boxes, one line each. A box with places shows an arrow; its places open beside it.
// Typing while the menu is open filters it. A box never checked opens its check, the only way to its first sign-in.
function BoxMenu(props: { s: ShellState; act: BarActions; done(): void }) {
  const [filter, setFilter] = useState('');
  const [places, setPlaces] = useState('');
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return props.done();
      if (e.key === 'Backspace') return setFilter((f) => f.slice(0, -1));
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) setFilter((f) => (f + e.key).slice(0, 32));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const open = (box: BoxView, place: string) => {
    props.done();
    props.act.open(box.id, place);
  };
  // The right button on a box, which is where his walkthrough of 2026-11-15 put Connect, Edit, Duplicate and
  // Delete. Edit and Delete are already on the row as buttons, because nothing in this app hides behind a
  // right press; the menu is the second way to them and adds the two that have nowhere else to be. A box
  // that was never checked has no tab to open: picking it opens its check, so the menu says that rather than
  // offering something that would not happen.
  const boxMenu = (e: MouseEvent, b: BoxView) => {
    const layer = document.getElementById('shell-menus');
    if (!layer) return;
    e.preventDefault();
    e.stopPropagation();
    const lines: MenuLine[] = [];
    if (b.pinned) {
      lines.push({ glyph: 'box', label: 'Open it in a new tab', run: () => open(b, ''), id: 'box-menu-open' });
      for (const p of b.places) lines.push({ glyph: 'place', label: `Open ${p.name}`, run: () => open(b, p.name) });
    } else {
      lines.push({ glyph: 'identity', label: 'Check it before the first sign-in', run: () => open(b, ''), id: 'box-menu-check' });
    }
    lines.push({ apart: true });
    lines.push({ glyph: 'edit', label: 'Edit it', run: () => { props.done(); props.act.editBox(b.id); }, id: 'box-menu-edit' });
    lines.push({ glyph: 'copy', label: 'Make another from it', run: () => { props.done(); props.act.addBox(b.id); }, id: 'box-menu-duplicate' });
    lines.push({ apart: true });
    lines.push({ glyph: 'stop', label: 'Delete it', danger: true, run: () => { props.done(); props.act.removeBox(b.id); }, id: 'box-menu-remove' });
    const menu = openMenu(layer, e.clientX, e.clientY, lines, glyphNode, () => props.act.menu(false));
    if (menu) props.act.menu(true);
  };
  const shown = props.s.boxes.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()));
  const openNow = (id: string) => props.s.tabs.filter((t) => t.box?.id === id);
  return (
    <div class="box-menu" id="box-menu" role="menu" aria-label="Boxes">
      {filter !== '' && <div class="bm-filter"><Glyph name="find" />{filter}</div>}
      {props.s.boxesFault !== '' && <div class="bm-fault"><Glyph name="fix" />{props.s.boxesFault}</div>}
      {shown.map((b) => {
        const open1 = openNow(b.id);
        const state = open1.length === 0 ? '' : open1.some((t) => ['gone', 'silent', 'stopped'].includes(tabLook(t).mark)) ? 'reconnecting' : 'connected';
        return (
          <div class={`bm-row ${places === b.id ? 'hot' : ''}`} key={b.id} role="menuitem" data-box={b.name} style={{ '--hue': `var(--box-${b.colour})` }} onClick={() => open(b, '')} onContextMenu={(e) => boxMenu(e, b)} onPointerEnter={() => setPlaces(b.places.length > 0 && b.pinned ? b.id : '')}>
            <span class="box-dot" />
            <span class="bm-name">{b.name}</span>
            {!b.pinned && <Glyph name="identity" class="bm-unchecked" label="not checked yet" />}
            {state !== '' && <span class={`conn conn-${state}`} title={state} />}
            {b.places.length > 0 && b.pinned && <Glyph name="chevron" class="bm-more" />}
            {/* Edit and Delete, on the row of the box they are for: nothing is hidden behind a right-click. */}
            <span class="bm-acts">
              <button type="button" class="bm-act" data-edit={b.name} title={`Edit ${b.name}`} aria-label={`Edit ${b.name}`} onClick={(e) => { e.stopPropagation(); props.done(); props.act.editBox(b.id); }}>
                <Glyph name="edit" />
              </button>
              <button type="button" class="bm-act remove" data-remove={b.name} title={`Delete ${b.name}`} aria-label={`Delete ${b.name}`} onClick={(e) => { e.stopPropagation(); props.done(); props.act.removeBox(b.id); }}>
                <Glyph name="stop" />
              </button>
            </span>
            {places === b.id && (
              <div class="bm-places" role="menu" aria-label={`Places on ${b.name}`}>
                {b.places.map((p) => (
                  <div class="bm-row" key={p.name} role="menuitem" data-place={p.name} onClick={(e) => { e.stopPropagation(); open(b, p.name); }}>
                    <Glyph name="place" class="fm-glyph" />
                    <span class="bm-name">{p.name}</span>
                    {/* A place that keeps running is marked here, where he picks it: the difference between
                        this place and the one above it is the whole reason he made it. */}
                    {p.tmux && <Glyph name="reopen" class="bm-keeps" label="keeps running" />}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div class="bm-foot">
        <button type="button" class="bm-add" id="add-box-open" onClick={() => { props.done(); props.act.addBox(); }}><Glyph name="plus" />Add box</button>
      </div>
    </div>
  );
}
