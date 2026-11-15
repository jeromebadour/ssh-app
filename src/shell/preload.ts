import { contextBridge, ipcRenderer } from 'electron';
import { CH, type ShellCmd, type ShellPort, type ShellState } from '../common/ipc';

const port: ShellPort = {
  sandboxed: process.sandboxed === true,
  cmd(c: ShellCmd) {
    ipcRenderer.send(CH.shellCmd, c);
  },
  onState(cb) {
    ipcRenderer.on(CH.shellState, (_e, s: ShellState) => cb(s));
  },
  meter(n) {
    ipcRenderer.send(CH.meterReport, { longTaskMs: Number(n.longTaskMs), reactionMs: Number(n.reactionMs) });
  },
  frame() {
    ipcRenderer.send(CH.meterFrame);
  },
};

contextBridge.exposeInMainWorld('shellPort', port);
