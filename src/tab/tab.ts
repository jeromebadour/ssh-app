// Scaffolding for the skeleton stage: shows the bytes its engine sends back, as inert text.
// The terminal, the file browser and the transfers strip replace this once their pictures are approved.
import type { TabPort } from '../common/ipc';

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

window.tabPort.onOutput((bytes) => {
  const text = (out.textContent ?? '') + decoder.decode(bytes, { stream: true });
  out.textContent = text.length > KEEP ? text.slice(text.length - KEEP) : text;
  out.scrollTop = out.scrollHeight;
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
