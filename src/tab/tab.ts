// Scaffolding for the skeleton stage: shows the bytes its engine sends back, as inert text.
// The terminal, the file browser and the transfers strip replace this once their pictures are approved.
import type { TabPort } from '../common/ipc';
import { painted, watchView } from '../common/meter-view';

declare global {
  interface Window {
    tabPort: TabPort;
  }
}

const KEEP = 64 * 1024; // characters kept on screen
const out = document.getElementById('out') as HTMLPreElement;
const state = document.getElementById('state') as HTMLDivElement;
const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

// Output is taken at once and painted at most once a frame: however fast bytes arrive, the page does one small
// piece of work per frame and stays free for input.
let text = '';
let scheduled = false;
window.tabPort.onOutput((bytes) => {
  text += decoder.decode(bytes, { stream: true });
  if (text.length > KEEP) text = text.slice(text.length - KEEP);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    out.textContent = text;
    out.scrollTop = out.scrollHeight;
  });
});

window.tabPort.onState((info) => {
  state.textContent = info.cause ? `${info.state}: ${info.cause}` : info.state;
});

out.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const bytes = e.key === 'Enter' ? encoder.encode('\r\n') : e.key.length === 1 ? encoder.encode(e.key) : null;
  if (!bytes) return;
  e.preventDefault();
  window.tabPort.send(bytes);
});

out.focus();
watchView(window.tabPort);
window.tabPort.onShown(() => painted(window.tabPort));
