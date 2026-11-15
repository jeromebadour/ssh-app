import { app } from 'electron';
import { readFile } from 'node:fs/promises';

// Memory, counted fairly: memory shared between processes (mostly the browser engine's own code) is counted
// once, not once per process. Linux gives that as "Pss"; elsewhere each process's private bytes are summed.
// `plainMB` is the plain per-process sum: the number a task manager shows.
export async function memory(extraPids: number[] = []): Promise<{ fairMB: number; plainMB: number; how: string }> {
  const metrics = app.getAppMetrics();
  const plainMB = Math.round(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024);
  if (process.platform === 'linux') {
    let kb = 0;
    for (const pid of [...metrics.map((m) => m.pid), ...extraPids]) {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => '');
      kb += Number(/^Pss:\s+(\d+) kB/m.exec(rollup)?.[1] ?? 0);
    }
    return { fairMB: Math.round(kb / 1024), plainMB, how: 'shared memory counted once' };
  }
  const kb = metrics.reduce((sum, m) => sum + (m.memory.privateBytes ?? 0), 0);
  return { fairMB: Math.round(kb / 1024), plainMB, how: 'private memory, engines not counted' };
}
