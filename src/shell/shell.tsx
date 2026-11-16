// The shell view: the password before anything else, then the bar of tabs. It only draws: what the lock says
// and which tabs exist come from main, and everything it asks goes through the few messages in common/ipc.ts.
import { render } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { GateState, ShellPort, ShellState, TabInfo } from '../common/ipc';
import { ending } from '../common/link-words';
import { Bar, placeLabel, tabLook, WindowStrip, type BarActions } from '../ui/bar';
import { AddBoxDialog, ChangedDialog, CheckDialog, RemoveBoxDialog } from '../ui/boxdialogs';
import { LinkDialog } from '../ui/linkdialog';
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
let shellNow: ShellState = { tabs: [], active: 0, boxes: [], boxesFault: '', check: null, added: null, done: '', paste: null, link: null, maximized: false };
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
  addBox: () => undefined,
  editBox: () => undefined,
  removeBox: () => undefined,
  menu: () => undefined,
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
type Dialog = { kind: 'none' } | { kind: 'add'; req: number } | { kind: 'edit'; box: string; req: number } | { kind: 'remove'; box: string } | { kind: 'changed'; tab: number };

let nextReq = 1;

function Unlocked(props: { s: ShellState }) {
  const s = props.s;
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [seenChanged, setSeenChanged] = useState<number[]>([]);
  // A dialog or the check is open: the shell is above the tabs, so no tab can draw over it or take its clicks.
  const over = dialog.kind !== 'none' || s.check !== null;
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
    select: (id) => port.cmd({ op: 'select', id }),
    close: (id) => port.cmd({ op: 'close', id }),
    open: (box, place) => {
      const b = s.boxes.find((x) => x.id === box);
      if (b && !b.pinned) port.cmd({ op: 'check', box });
      else port.cmd({ op: 'open', box, place });
    },
    addBox: () => setDialog({ kind: 'add', req: nextReq++ }),
    editBox: (box) => setDialog({ kind: 'edit', box, req: nextReq++ }),
    removeBox: (box) => setDialog({ kind: 'remove', box }),
    menu: (open) => port.cmd({ op: 'overlay', on: open || over }),
    window: (what) => port.cmd({ op: 'window', do: what }),
  };
  const front = s.tabs.find((t) => t.id === s.active);
  const adding = (dialog.kind === 'add' || dialog.kind === 'edit') && s.added?.req !== dialog.req;
  const refusal = (dialog.kind === 'add' || dialog.kind === 'edit') && s.added?.req === dialog.req && !s.added.ok ? s.added : null;
  const editing = dialog.kind === 'edit' ? s.boxes.find((b) => b.id === dialog.box) : undefined;
  const removing = dialog.kind === 'remove' ? s.boxes.find((b) => b.id === dialog.box) : undefined;
  const changedTab = dialog.kind === 'changed' ? s.tabs.find((t) => t.id === dialog.tab) : undefined;
  const changedBox = changedTab?.box ? s.boxes.find((b) => b.id === changedTab.box!.id) : undefined;
  return (
    <div class="window live">
      <Bar s={s} act={act} />
      <main class="middle">
        {s.tabs.length === 0 && (
          <div class="first-use" id="first-use">
            <Mark />
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
            <button type="button" class={`btn ${s.boxes.length === 0 ? 'primary' : 'quiet'}`} id="first-add" onClick={act.addBox}><Glyph name="plus" />Add box</button>
          </div>
        )}
      </main>
      <footer class="status" id="status">
        {front ? (
          <>
            <span class="s-tab"><TabStateMark t={front} />{front.box ? `${front.box.name}, ${placeLabel(front, s.boxes)}` : `tab ${front.id}`}</span>
            <span>{statusWords(front)}</span>
          </>
        ) : <span />}
        <span class="s-last" id="status-done">{s.done}</span>
      </footer>
      {dialog.kind === 'add' && <AddBoxDialog taken={s.boxes.map((b) => b.name)} working={adding && pendingAdd === dialog.req} refused={refusal?.fields ?? {}} error={refusal && Object.keys(refusal.fields).length === 0 ? refusal.error : ''} onAdd={(draft) => { pendingAdd = dialog.req; port.cmd({ op: 'addBox', req: dialog.req, draft }); }} onCancel={() => setDialog({ kind: 'none' })} />}
      {/* The same dialog, with the box in it: one way of drawing a box's fields, for adding and for editing. */}
      {dialog.kind === 'edit' && editing && (
        <AddBoxDialog
          key={editing.id}
          taken={s.boxes.filter((b) => b.id !== editing.id).map((b) => b.name)}
          working={adding && pendingAdd === dialog.req}
          refused={refusal?.fields ?? {}}
          error={refusal && Object.keys(refusal.fields).length === 0 ? refusal.error : ''}
          editing={{
            draft: { name: editing.name, colour: editing.colour, host: editing.host, port: String(editing.port), user: editing.user, folder: editing.folder, places: editing.places.map((p) => ({ name: p.name, folder: p.folder })) },
            pinType: editing.pinType,
            pinFingerprint: editing.pinFingerprint,
            pinnedAt: editing.pinnedAt,
            onForget: () => port.cmd({ op: 'forgetIdentity', box: editing.id }),
          }}
          onAdd={(draft) => { pendingAdd = dialog.req; port.cmd({ op: 'editBox', req: dialog.req, box: editing.id, draft }); }}
          onCancel={() => setDialog({ kind: 'none' })}
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

function statusWords(t: TabInfo): string {
  const l = t.link;
  if (!t.box) return t.state;
  if (l.phase === 'up') {
    if (l.silentSinceMs > 0) return `no answer for ${Math.max(0, Math.round((Date.now() - l.silentSinceMs) / 1000))} s, the link is kept`;
    return `${l.rttMs >= 0 ? `round trip ${l.rttMs} ms` : 'connected'}${l.postQuantum ? ', post-quantum' : ''}`;
  }
  if (l.phase === 'ended') return ending(l.cause).short;
  return tabLook(t).words;
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
