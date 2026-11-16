import { contextBridge, ipcRenderer } from 'electron';
import { CH, INPUT_MAX, type TabInfo, type TabPort } from '../common/ipc';

const port: TabPort = {
  sandboxed: process.sandboxed === true,
  send(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > INPUT_MAX) return;
    ipcRenderer.send(CH.tabInput, bytes);
  },
  onOutput(cb) {
    ipcRenderer.on(CH.tabOutput, (_e, bytes: Uint8Array) => cb(bytes));
  },
  onState(cb) {
    ipcRenderer.on(CH.tabState, (_e, info: TabInfo) => cb(info));
  },
  onShown(cb) {
    ipcRenderer.on(CH.tabShown, (_e, front: unknown) => cb(front === true));
  },
  onPace(cb) {
    ipcRenderer.on(CH.tabPace, (_e, share: unknown) => cb(typeof share === 'number' && share > 0 && share <= 1 ? share : 1));
  },
  onBanner(cb) {
    ipcRenderer.on(CH.tabBanner, (_e, bytes: Uint8Array) => cb(bytes));
  },
  resize(cols, rows) {
    ipcRenderer.send(CH.tabResize, Number(cols), Number(rows));
  },
  copy(text) {
    ipcRenderer.send(CH.tabCopy, String(text));
  },
  taken(total) {
    ipcRenderer.send(CH.tabTaken, Number(total));
  },
  meter(n) {
    ipcRenderer.send(CH.meterReport, { longTaskMs: Number(n.longTaskMs), reactionMs: Number(n.reactionMs), reactionKind: Number(n.reactionKind), reactionWaitMs: Number(n.reactionWaitMs), reactionHandlerMs: Number(n.reactionHandlerMs) });
  },
  frame() {
    ipcRenderer.send(CH.meterFrame);
  },
};

contextBridge.exposeInMainWorld('tabPort', port);
