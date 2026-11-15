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
};

contextBridge.exposeInMainWorld('tabPort', port);
