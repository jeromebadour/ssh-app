// Scaffolding for the skeleton stage: a row of tab buttons, so several sealed tabs can be opened and switched.
// The real tab bar, box list and settings replace this once their pictures are approved.
import type { ShellPort, ShellState } from '../common/ipc';

declare global {
  interface Window {
    shellPort: ShellPort;
  }
}

const bar = document.getElementById('bar') as HTMLDivElement;

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function draw(s: ShellState): void {
  bar.replaceChildren();
  for (const t of s.tabs) {
    const b = button(`tab ${t.id} (${t.state})`, () => window.shellPort.cmd({ op: 'select', id: t.id }));
    b.dataset['tab'] = String(t.id);
    b.dataset['state'] = t.state;
    b.setAttribute('aria-selected', String(t.id === s.active));
    b.addEventListener('auxclick', (e) => e.preventDefault());
    bar.append(b);
    const x = button('close', () => window.shellPort.cmd({ op: 'close', id: t.id }));
    x.dataset['close'] = String(t.id);
    bar.append(x);
  }
  const add = button('new tab', () => window.shellPort.cmd({ op: 'new' }));
  add.id = 'new';
  bar.append(add);
}

window.shellPort.onState(draw);
draw({ tabs: [], active: 0 });
