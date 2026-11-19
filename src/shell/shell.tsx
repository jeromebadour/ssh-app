// The shell view: the password before anything else, then the bar of tabs. It only draws: what the lock says
// and which tabs exist come from main, and everything it asks goes through the few messages in common/ipc.ts.
import { Button } from '../ui/button';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { SETTINGS_DEFAULT, type GateState, type ShellPort, type ShellState, type TabInfo } from '../common/ipc';
import { ending } from '../common/link-words';
import { Bar, placeLabel, tabLook, WindowStrip, type BarActions } from '../ui/bar';
import { AddBoxDialog, ChangedDialog, CheckDialog, ClosingDialog, RemoveBoxDialog, ReplaceDialog } from '../ui/boxdialogs';
import { LinkDialog } from '../ui/linkdialog';
import { SettingsDialog } from '../ui/settings';
import { FirstVisitDialog } from '../ui/firstvisit';
import { PasteDialog } from '../ui/pastedialog';
import { watchView } from '../common/meter-view';
import { CreateScreen, GateFoot, GateNotice, RestoreScreen, UnlockScreen } from '../ui/gate';
import { Glyph } from '../ui/glyphs';
import { Mark } from '../ui/marks';

declare global {
  interface Window {
    shellPort: ShellPort;
  }
}

const port = window.shellPort;

// What main says is taken from the first moment this script runs, before anything is drawn: main speaks as
// soon as the page has loaded, and a listener added later (after the first paint) would miss its first words.
let gateNow: GateState = { phase: 'starting', wrong: false, waitMs: 0, backupDir: '', backupOk: false, detail: '', hasPrevious: false, restoreFrom: '' };
let shellNow: ShellState = { tabs: [], active: 0, boxes: [], boxesFault: '', check: null, added: null, done: '', paste: null, link: null, maximized: false, closing: null, keyFile: null, replacing: null, settings: { ...SETTINGS_DEFAULT }, settingsOpen: false, downloadsNow: '', firstVisit: null, reopen: [], ready: false };
let redraw = (): void => undefined;
port.onGate((g) => {
  gateNow = g;
  redraw();
});
port.onState((s) => {
  shellNow = s;
  redraw();
});
// The strip before the lock draws the three window buttons and nothing else, so the rest of a bar's actions
// are never reached from it. They are refused rather than left out, so that a later change that does reach one
// of them is a plain refusal here and not a crash on the lock screen.
const noBar = {
  select: () => undefined,
  close: () => undefined,
  open: () => undefined,
  reopen: () => undefined,
  dropReopen: () => undefined,
  addBox: () => undefined,
  editBox: () => undefined,
  removeBox: () => undefined,
  menu: () => undefined,
  settings: () => undefined,
  window: () => undefined,
};

const act = {
  create: (p: Uint8Array) => port.gateCreate(p),
  unlock: (p: Uint8Array) => port.gateUnlock(p),
  pickBackup: () => port.gatePickBackup(),
  pickRestore: () => port.gatePickRestore(),
  usePrevious: () => port.gateUsePrevious(),
  forgetRestore: () => port.gateForgetRestore(),
  restore: (p: Uint8Array) => port.gateRestore(p),
};

// What the window shows once unlocked: the bar, the middle (where the tab in front is drawn above this view),
// the status line, and the one dialog that may be open. Every action is a message to main; nothing is decided here.
type Dialog = { kind: 'none' } | { kind: 'add'; req: number; from?: string } | { kind: 'edit'; box: string; req: number } | { kind: 'remove'; box: string } | { kind: 'changed'; tab: number } | { kind: 'closing'; tab: number };

let nextReq = 1;

// The morning: what was open when he last used the app, each with a tick, so he picks rather than being
// given back a window he then has to tidy. It is here only while nothing is open at all, and once he has
// answered it is gone for this start, whichever way he answered.
function Reopen(props: { s: ShellState; act: BarActions }) {
  const [out, setOut] = useState<Set<number>>(new Set());
  const picked = props.s.reopen.map((_, i) => i).filter((i) => !out.has(i));
  const flip = (i: number) =>
    setOut((was) => {
      const next = new Set(was);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div class="reopen" id="reopen">
      <div class="ro-head"><Glyph name="reopen" />Open again</div>
      <div class="ro-list">
        {props.s.reopen.map((one, i) => (
          <label class="ro-one" key={`${one.box}:${one.place}:${i}`} data-reopen={i} style={{ '--hue': `var(--box-${one.colour})` }}>
            <input type="checkbox" checked={!out.has(i)} onChange={() => flip(i)} />
            <span class="ro-tick"><Glyph name="check" /></span>
            <span class="box-dot" />
            <span class="ro-name">{one.name}</span>
            <span class="ro-place">{one.place === '' ? 'its starting folder' : one.place}</span>
          </label>
        ))}
      </div>
      <div class="ro-acts">
        <Button id="reopen-not-now" glyph="close" onClick={() => props.act.dropReopen()}>Not now</Button>
        <Button id="reopen-go" tone="go" glyph="reopen" disabled={picked.length === 0} onClick={() => props.act.reopen(picked)}>Open {picked.length === props.s.reopen.length ? 'all' : picked.length}</Button>
      </div>
    </div>
  );
}

function Unlocked(props: { s: ShellState }) {
  const s = props.s;
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [seenChanged, setSeenChanged] = useState<number[]>([]);
  // A dialog or the check is open: the shell is above the tabs, so no tab can draw over it or take its clicks.
  // The shell is raised above the tabs whenever something of its own is open, the closing question included:
  // drawn behind a tab's view it would not be seen at all, and the window would look frozen instead of asking.
  const over = dialog.kind !== 'none' || s.check !== null || s.closing !== null;
  // Said before the dialog is painted, so the shell is raised as it appears.
  useLayoutEffect(() => port.cmd({ op: 'overlay', on: over }), [over]);
  // The box was added: its check opens (main has started it), and Add box closes.
  useEffect(() => {
    if ((dialog.kind === 'add' || dialog.kind === 'edit') && s.added?.req === dialog.req && s.added.ok) setDialog({ kind: 'none' });
  }, [s.added]);
  // A tab stopped because its box showed another identity: said at once, once per tab.
  const stopped = s.tabs.find((t) => t.box && t.link.cause === 'identity-changed' && !seenChanged.includes(t.id));
  useEffect(() => {
    if (stopped && dialog.kind === 'none' && !s.check) setDialog({ kind: 'changed', tab: stopped.id });
  }, [stopped?.id, dialog.kind, s.check === null]);
  const act: BarActions = {
    settings: () => port.cmd({ op: 'settings', show: true }),
    select: (id) => port.cmd({ op: 'select', id }),
    close: (id) => {
      // Closing a tab ends its session, so it asks first, the same as closing the window does. A tab whose
      // session has already ended has nothing to lose and closes on the press.
      const t = s.tabs.find((x) => x.id === id);
      if (t && t.box && ['connecting', 'key-exchange', 'signing-in', 'up'].includes(t.link.phase)) setDialog({ kind: 'closing', tab: id });
      else port.cmd({ op: 'close', id });
    },
    open: (box, place) => {
      const b = s.boxes.find((x) => x.id === box);
      if (b && !b.pinned) port.cmd({ op: 'check', box });
      else port.cmd({ op: 'open', box, place });
    },
    addBox: (from) => setDialog({ kind: 'add', req: nextReq++, ...(from === undefined ? {} : { from }) }),
    editBox: (box) => setDialog({ kind: 'edit', box, req: nextReq++ }),
    removeBox: (box) => setDialog({ kind: 'remove', box }),
    menu: (open) => port.cmd({ op: 'overlay', on: open || over }),
    window: (what) => port.cmd({ op: 'window', do: what }),
    reopen: (which) => port.cmd({ op: 'reopen', which }),
    dropReopen: () => port.cmd({ op: 'dropReopen' }),
  };
  const front = s.tabs.find((t) => t.id === s.active);
  const adding = (dialog.kind === 'add' || dialog.kind === 'edit') && s.added?.req !== dialog.req;
  const refusal = (dialog.kind === 'add' || dialog.kind === 'edit') && s.added?.req === dialog.req && !s.added.ok ? s.added : null;
  const editing = dialog.kind === 'edit' ? s.boxes.find((b) => b.id === dialog.box) : undefined;
  // Adding a box made from another (Duplicate, his walkthrough decision of 2026-11-15). It carries what two
  // boxes on one machine really share: where it is, who signs in, where it starts and its places. It carries
  // nothing that is one box's alone: not its key, which every box makes for itself, and not its pinned
  // identity, which is a claim this new box has never made and would have to make for itself at its check.
  // The name is the only field that cannot be the same, so it is offered with a free one already in it.
  const copying = dialog.kind === 'add' && dialog.from !== undefined ? s.boxes.find((b) => b.id === dialog.from) : undefined;
  const freeName = (want: string): string => {
    const taken = new Set(s.boxes.map((b) => b.name));
    if (!taken.has(want)) return want;
    for (let n = 2; n < 100; n++) if (!taken.has(`${want} ${n}`)) return `${want} ${n}`;
    return '';
  };
  const removing = dialog.kind === 'remove' ? s.boxes.find((b) => b.id === dialog.box) : undefined;
  const changedTab = dialog.kind === 'changed' ? s.tabs.find((t) => t.id === dialog.tab) : undefined;
  const closingTab = dialog.kind === 'closing' ? s.tabs.find((t) => t.id === dialog.tab) : undefined;
  const changedBox = changedTab?.box ? s.boxes.find((b) => b.id === changedTab.box!.id) : undefined;
  return (
    <div class="window live">
      <Bar s={s} act={act} />
      <main class="middle">
        {s.tabs.length === 0 && (
          <div class="first-use" id="first-use">
            <Mark />
            {/* Nothing to press until the list is open. The window is drawn the moment the lock opens, and
                for that moment it knows of no box at all: drawing Add box then, alone in the middle, puts a
                button where the morning's offer is about to be. The press he began lands on what arrived. */}
            {s.ready && (<>
            {s.reopen.length > 0 && <Reopen s={s} act={act} />}
            {s.boxes.length > 0 && (
              <div class="fu-boxes">
                {s.boxes.map((b) => (
                  <button type="button" class="fu-box" key={b.id} data-open={b.name} style={{ '--hue': `var(--box-${b.colour})` }} onClick={() => act.open(b.id, '')}>
                    <span class="box-dot" />
                    <span class="fu-name">{b.name}</span>
                    {!b.pinned && <Glyph name="identity" class="bm-unchecked" label="not checked yet" />}
                  </button>
                ))}
              </div>
            )}
            <Button id="first-add" tone={s.boxes.length === 0 ? 'go' : 'plain'} glyph="plus" onClick={() => act.addBox()}>Add box</Button>
            </>)}
          </div>
        )}
      </main>
      <footer class="status" id="status">
        {front ? (
          <>
            <span class="s-tab"><TabStateMark t={front} />{front.box ? `${front.box.name}, ${placeLabel(front, s.boxes)}` : `tab ${front.id}`}</span>
            {statusFields(front).map((f) => (
              <span key={f.id} class={`s-f s-tone-${f.tone}`} id={`status-${f.id}`}><Glyph name={f.glyph} />{f.value}</span>
            ))}
          </>
        ) : <span />}
        <span class="s-last" id="status-done">{s.done}</span>
      </footer>
      {dialog.kind === 'add' && (
        <AddBoxDialog
          key={copying?.id ?? 'new'}
          taken={s.boxes.map((b) => b.name)}
          {...(copying ? { start: { name: freeName(copying.name), colour: copying.colour, host: copying.host, port: String(copying.port), user: copying.user, folder: copying.folder, places: copying.places.map((p) => (p.tmux === true ? { name: p.name, folder: p.folder, tmux: true } : { name: p.name, folder: p.folder })) } } : {})}
          working={adding && pendingAdd === dialog.req}
          refused={refusal?.fields ?? {}}
          error={refusal && Object.keys(refusal.fields).length === 0 ? refusal.error : ''}
          keyFile={s.keyFile}
          onPickKeyFile={() => port.cmd({ op: 'pickKeyFile' })}
          onDropKeyFile={() => port.cmd({ op: 'dropKeyFile' })}
          onPassphrase={(bytes) => port.keyPassphrase(bytes)}
          onAdd={(draft) => { pendingAdd = dialog.req; port.cmd({ op: 'addBox', req: dialog.req, draft }); }}
          onCancel={() => { port.cmd({ op: 'dropKeyFile' }); setDialog({ kind: 'none' }); }}
        />
      )}
      {/* The same dialog, with the box in it: one way of drawing a box's fields, for adding and for editing. */}
      {dialog.kind === 'edit' && editing && (
        <AddBoxDialog
          key={editing.id}
          taken={s.boxes.filter((b) => b.id !== editing.id).map((b) => b.name)}
          working={adding && pendingAdd === dialog.req}
          refused={refusal?.fields ?? {}}
          error={refusal && Object.keys(refusal.fields).length === 0 ? refusal.error : ''}
          editing={{
            draft: { name: editing.name, colour: editing.colour, host: editing.host, port: String(editing.port), user: editing.user, folder: editing.folder, places: editing.places.map((p) => (p.tmux === true ? { name: p.name, folder: p.folder, tmux: true } : { name: p.name, folder: p.folder })) },
            pinType: editing.pinType,
            pinFingerprint: editing.pinFingerprint,
            pinnedAt: editing.pinnedAt,
            onForget: () => port.cmd({ op: 'forgetIdentity', box: editing.id }),
          }}
          onAdd={(draft) => { pendingAdd = dialog.req; port.cmd({ op: 'editBox', req: dialog.req, box: editing.id, draft }); }}
          onCancel={() => setDialog({ kind: 'none' })}
        />
      )}
      {/* A file is already where one is being sent: main asked, with both files in front of the person. */}
      {s.replacing && (
        <ReplaceDialog
          asked={s.replacing}
          onReplace={() => port.cmd({ op: 'replaceFile' })}
          onKeep={() => port.cmd({ op: 'keepFile' })}
        />
      )}
      {/* The first visit (decision O2): the one screen in this app that ever asks for a box's own password.
          It opens only after that box's identity has been pinned. */}
      {s.firstVisit && (
        <FirstVisitDialog
          shown={s.firstVisit}
          onGo={(password) => port.cmd({ op: 'firstVisitGo', box: s.firstVisit!.box, password })}
          onAnswers={(answers) => port.cmd({ op: 'firstVisitAnswers', box: s.firstVisit!.box, answers })}
          onClose={() => port.cmd({ op: 'firstVisitClose' })}
        />
      )}
      {/* The settings, opened from the Boxes menu. Opening it changes nothing. */}
      {s.settingsOpen && (
        <SettingsDialog
          settings={s.settings}
          downloadsNow={s.downloadsNow}
          onPick={() => port.cmd({ op: 'pickDownloads' })}
          onDefault={() => port.cmd({ op: 'defaultDownloads' })}
          onSize={(size) => port.cmd({ op: 'paneSize', size })}
          onClose={() => port.cmd({ op: 'settings', show: false })}
        />
      )}
      {/* Closing the window: main asked, naming every session that would end. */}
      {s.closing && (
        <ClosingDialog
          what="app"
          live={s.closing.live}
          idle={s.closing.idle}
          onClose={() => port.cmd({ op: 'closeApp' })}
          onKeep={() => port.cmd({ op: 'keepApp' })}
        />
      )}
      {/* Closing one tab whose session is live. */}
      {!s.closing && dialog.kind === 'closing' && closingTab && (
        <ClosingDialog
          what="tab"
          live={[{ id: closingTab.id, box: closingTab.box?.name ?? `tab ${closingTab.id}`, place: placeLabel(closingTab, s.boxes), words: tabLook(closingTab).words }]}
          idle={0}
          onClose={() => { port.cmd({ op: 'close', id: closingTab.id }); setDialog({ kind: 'none' }); }}
          onKeep={() => setDialog({ kind: 'none' })}
        />
      )}
      {dialog.kind === 'remove' && removing && (
        <RemoveBoxDialog
          box={removing}
          tabs={s.tabs.filter((t) => t.box?.id === removing.id).length}
          onRemove={() => { port.cmd({ op: 'removeBox', box: removing.id }); setDialog({ kind: 'none' }); }}
          onCancel={() => setDialog({ kind: 'none' })}
        />
      )}
      {s.check && dialog.kind === 'none' && (
        <CheckDialog key={s.check.boxId} c={s.check} act={{
          copy: () => port.cmd({ op: 'copyBlock', box: s.check!.boxId }),
          paste: (text) => port.cmd({ op: 'paste', box: s.check!.boxId, text }),
          again: () => port.cmd({ op: 'check', box: s.check!.boxId }),
          trust: () => port.cmd({ op: 'trust', box: s.check!.boxId }),
          trustThenVisit: () => port.cmd({ op: 'trustThenVisit', box: s.check!.boxId }),
          close: () => port.cmd({ op: 'closeCheck', box: s.check!.boxId }),
        }} />
      )}
      {s.link && (
        <LinkDialog l={s.link} act={{ open: () => port.cmd({ op: 'openLink' }), drop: () => port.cmd({ op: 'dropLink' }) }} />
      )}
      {s.paste && (
        <PasteDialog p={s.paste} act={{ send: () => port.cmd({ op: 'sendPaste' }), drop: () => port.cmd({ op: 'dropPaste' }) }} />
      )}
      {changedTab && changedBox && (
        <ChangedDialog name={changedBox.name} addr={`${changedBox.host}:${changedBox.port}`} pinType={changedBox.pinType} pinFingerprint={changedBox.pinFingerprint} pinnedAt={changedBox.pinnedAt} shownFingerprint={changedTab.link.shownFingerprint} onClose={() => { setSeenChanged([...seenChanged, changedTab.id]); setDialog({ kind: 'none' }); }} />
      )}
    </div>
  );
}
let pendingAdd = 0;

function TabStateMark(props: { t: TabInfo }) {
  return <span class={`conn conn-${tabLook(props.t).mark}`} />;
}

// The status line, as fields rather than as a sentence (Kami's #17: it should show, not talk). It said
// "round trip 0 ms, post-quantum" and "no answer for 12 s, the link is kept" — one phrase to be read left to
// right, where what he wants from a status line is a glance. Each fact now carries its own glyph and its own
// colour, which is how every other list in his work is read, and nothing here is new data: the round trip,
// the silence, post-quantum, what the terminal is doing and the bytes the engine could not keep were all in
// the state already and only one of them reached the screen.
interface StatusField { id: string; glyph: string; value: string; tone: string }
function statusFields(t: TabInfo): StatusField[] {
  const l = t.link;
  if (!t.box) return [{ id: 'state', glyph: 'network', value: t.state, tone: 'plain' }];
  if (l.phase !== 'up') {
    const words = l.phase === 'ended' ? ending(l.cause).short : tabLook(t).words;
    return [{ id: 'state', glyph: l.phase === 'ended' ? 'stop' : 'network', value: words, tone: l.phase === 'ended' ? 'problem' : 'quiet' }];
  }
  const out: StatusField[] = [];
  // A link that is kept while the box says nothing is the one thing here he has to notice, so it takes the
  // place the round trip would have had rather than standing beside it: the number is stale by definition.
  if (l.silentSinceMs > 0) out.push({ id: 'quiet', glyph: 'silent', value: `${Math.max(0, Math.round((Date.now() - l.silentSinceMs) / 1000))} s quiet`, tone: 'problem' });
  else if (l.rttMs >= 0) out.push({ id: 'rtt', glyph: 'network', value: `${l.rttMs} ms`, tone: 'plain' });
  if (l.postQuantum) out.push({ id: 'pq', glyph: 'lock', value: 'post-quantum', tone: 'checked' });
  // Typed bytes the engine could not keep for the box. The state says this is never hidden, and until now
  // the only place it was said was a fault line nobody reads.
  if (l.droppedBytes > 0) out.push({ id: 'dropped', glyph: 'stop', value: `${l.droppedBytes} B not sent`, tone: 'problem' });
  if (t.doing !== 'unknown') out.push({ id: 'doing', glyph: t.doing === 'running' ? 'running' : 'ok', value: t.doing, tone: t.doing === 'running' ? 'main' : 'quiet' });
  return out;
}

function App() {
  const [, setTick] = useState(0);
  redraw = () => setTick((n) => n + 1);
  const gate = gateNow;
  const shell = shellNow;
  // "working" keeps the screen the password was typed on, with its button saying so.
  const [screen, setScreen] = useState<'create' | 'unlock' | 'damaged' | 'notice'>('notice');
  useEffect(() => {
    if (gate.phase === 'create') setScreen('create');
    else if (gate.phase === 'locked') setScreen('unlock');
    else if (gate.phase === 'damaged') setScreen('damaged');
    else if (gate.phase !== 'working') setScreen('notice');
  }, [gate.phase]);
  document.documentElement.dataset['gate'] = gate.phase;
  if (gate.phase === 'unlocked') return <Unlocked s={shell} />;
  // Before the lock is open there is no bar, so the window's own three buttons are carried on a strip of their
  // own above these screens.
  const strip = <WindowStrip maximized={shell.maximized} act={{ ...noBar, window: (what) => port.cmd({ op: 'window', do: what }) }} />;
  const foot = <GateFoot gate={gate} />;
  if (screen === 'create' && (gate.phase === 'create' || gate.phase === 'working')) return <>{strip}<CreateScreen gate={gate} act={act} />{foot}</>;
  if (screen === 'unlock' && (gate.phase === 'locked' || gate.phase === 'working')) return <>{strip}<UnlockScreen gate={gate} act={act} />{foot}</>;
  if (screen === 'damaged' && (gate.phase === 'damaged' || gate.phase === 'working')) return <>{strip}<RestoreScreen gate={gate} act={act} />{foot}</>;
  return <>{strip}<GateNotice gate={gate} />{foot}</>;
}

render(<App />, document.getElementById('app')!);
watchView(port);
