import { contextBridge, ipcRenderer } from 'electron';
import type { EaselJob } from './easel-job';

contextBridge.exposeInMainWorld('easelPort', {
  onJob(cb: (job: EaselJob) => void) {
    ipcRenderer.on('easel:job', (_e, job: EaselJob) => cb(job));
  },
  done(png: Uint8Array) {
    ipcRenderer.send('easel:done', png);
  },
});
