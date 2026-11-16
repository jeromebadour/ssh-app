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
    ipcRenderer.on(CH.tabShown, () => cb());
  },
  meter(n) {
    ipcRenderer.send(CH.meterReport, { longTaskMs: Number(n.longTaskMs), reactionMs: Number(n.reactionMs), reactionKind: Number(n.reactionKind), reactionWaitMs: Number(n.reactionWaitMs), reactionHandlerMs: Number(n.reactionHandlerMs) });
  },
  frame() {
    ipcRenderer.send(CH.meterFrame);
  },
};

contextBridge.exposeInMainWorld('tabPort', port);
