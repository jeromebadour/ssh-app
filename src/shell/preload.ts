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
};

contextBridge.exposeInMainWorld('shellPort', port);
