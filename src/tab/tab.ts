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

// Output is taken at once and shown at most once a frame: however fast bytes arrive, the page does one small
// piece of work per frame and stays free for input. Taking output never waits for a frame, though: a tab that is
// not in front may get no frames at all for a while, so a timer shows what arrived within a quarter of a second.
let text = '';
let frame = 0;
let timer = 0;
const show = () => {
  cancelAnimationFrame(frame);
  clearTimeout(timer);
  frame = 0;
  out.textContent = text;
  out.scrollTop = out.scrollHeight;
};
window.tabPort.onOutput((bytes) => {
  text += decoder.decode(bytes, { stream: true });
  if (text.length > KEEP) text = text.slice(text.length - KEEP);
  if (frame !== 0) return;
  frame = requestAnimationFrame(show);
  timer = window.setTimeout(show, 250);
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
