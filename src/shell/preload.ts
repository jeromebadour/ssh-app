import { contextBridge, ipcRenderer } from 'electron';
import { CH, type GateState, type ShellCmd, type ShellPort, type ShellState } from '../common/ipc';

const port: ShellPort = {
  sandboxed: process.sandboxed === true,
  cmd(c: ShellCmd) {
    ipcRenderer.send(CH.shellCmd, c);
  },
  onState(cb) {
    ipcRenderer.on(CH.shellState, (_e, s: ShellState) => cb(s));
  },
  onGate(cb) {
    ipcRenderer.on(CH.gateState, (_e, g: GateState) => cb(g));
  },
  gateCreate(password) {
    ipcRenderer.send(CH.gateCreate, password);
  },
  gateUnlock(password) {
    ipcRenderer.send(CH.gateUnlock, password);
  },
  gatePickBackup() {
    ipcRenderer.send(CH.gatePickBackup);
  },
  gatePickRestore() {
    ipcRenderer.send(CH.gatePickRestore);
  },
  gateUsePrevious() {
    ipcRenderer.send(CH.gateUsePrevious);
  },
  keyPassphrase(passphrase) {
    ipcRenderer.send(CH.keyPassphrase, passphrase);
  },
  gateRestore(password) {
    ipcRenderer.send(CH.gateRestore, password);
  },
  gateForgetRestore() {
    ipcRenderer.send(CH.gateForgetRestore);
  },
  meter(n) {
    ipcRenderer.send(CH.meterReport, { longTaskMs: Number(n.longTaskMs), reactionMs: Number(n.reactionMs), reactionKind: Number(n.reactionKind), reactionWaitMs: Number(n.reactionWaitMs), reactionHandlerMs: Number(n.reactionHandlerMs) });
  },
  frame() {
    ipcRenderer.send(CH.meterFrame);
  },
};

contextBridge.exposeInMainWorld('shellPort', port);
