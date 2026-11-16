// The shell view: the password before anything else, then the bar of tabs. It only draws: what the lock says
// and which tabs exist come from main, and everything it asks goes through the few messages in common/ipc.ts.
// The tab bar here is still the skeleton's (plain numbered tabs): boxes, places and the Boxes menu replace it
// when Add box is built.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { GateState, ShellPort, ShellState } from '../common/ipc';
import { watchView } from '../common/meter-view';
import { CreateScreen, GateNotice, UnlockScreen } from '../ui/gate';
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
let gateNow: GateState = { phase: 'starting', wrong: false, waitMs: 0, backupDir: '', backupOk: false, detail: '', hasPrevious: false };
let shellNow: ShellState = { tabs: [], active: 0 };
let redraw = (): void => undefined;
port.onGate((g) => {
  gateNow = g;
  redraw();
});
port.onState((s) => {
  shellNow = s;
  redraw();
});
const act = { create: (p: Uint8Array) => port.gateCreate(p), unlock: (p: Uint8Array) => port.gateUnlock(p), pickBackup: () => port.gatePickBackup() };

function Bar(props: { s: ShellState }) {
  return (
    <header class="tabbar scaffold" id="bar">
      <div class="brand"><Mark /><span class="wordmark">Berth</span></div>
      <div class="tab-groups">
        {props.s.tabs.map((t) => (
          <span class={`tab ${t.id === props.s.active ? 'active' : ''}`} key={t.id} data-tab={t.id} data-state={t.state} aria-selected={t.id === props.s.active} style={{ '--hue': 'var(--box-1)' }} onClick={() => port.cmd({ op: 'select', id: t.id })}>
            <span class={`conn conn-${t.state === 'ready' ? 'connected' : t.state === 'starting' ? 'connecting' : 'gone'}`} />
            <span class="tab-box">tab {t.id}</span>
            <span class="tab-place">{t.state}</span>
            <span class="tab-end">
              <button type="button" class="tab-close" data-close={t.id} aria-label={`Close tab ${t.id}`} onClick={(e) => { e.stopPropagation(); port.cmd({ op: 'close', id: t.id }); }}><Glyph name="close" class="tab-x" /></button>
            </span>
          </span>
        ))}
        <button type="button" class="new-tab" id="new" aria-label="New tab" onClick={() => port.cmd({ op: 'new' })}><Glyph name="plus" /></button>
      </div>
    </header>
  );
}

function App() {
  const [, setTick] = useState(0);
  redraw = () => setTick((n) => n + 1);
  const gate = gateNow;
  const shell = shellNow;
  // "working" keeps the screen the password was typed on, with its button saying so.
  const [screen, setScreen] = useState<'create' | 'unlock' | 'notice'>('notice');
  useEffect(() => {
    if (gate.phase === 'create') setScreen('create');
    else if (gate.phase === 'locked') setScreen('unlock');
    else if (gate.phase !== 'working') setScreen('notice');
  }, [gate.phase]);
  document.documentElement.dataset['gate'] = gate.phase;
  if (gate.phase === 'unlocked') return <Bar s={shell} />;
  if (screen === 'create' && (gate.phase === 'create' || gate.phase === 'working')) return <CreateScreen gate={gate} act={act} />;
  if (screen === 'unlock' && (gate.phase === 'locked' || gate.phase === 'working')) return <UnlockScreen gate={gate} act={act} />;
  return <GateNotice gate={gate} />;
}

render(<App />, document.getElementById('app')!);
watchView(port);
