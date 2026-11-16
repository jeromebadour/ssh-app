// The easel: a page that exists only in the lab. It puts the pictures of the window's separate views together
// into one picture of the whole window, exactly where each view sits, with a strip above that names it.
// It never runs in a release build's window; it draws nothing of its own but the strip.
import type { EaselJob } from './easel-job';

declare global {
  interface Window {
    easelPort: { onJob(cb: (job: EaselJob) => void): void; done(png: Uint8Array): void };
  }
}

window.easelPort.onJob(async (job) => {
  const canvas = new OffscreenCanvas(job.width, job.height + job.stripHeight);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = /^#[0-9a-fA-F]{6}$/.test(job.background) ? job.background : '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Back to front, each drawn over what is behind it: where a view is clear (the shell's middle, over a tab),
  // what is behind shows, as it does in the window. (Until 2026-11-16 each layer replaced what was under it,
  // and the tab under the shell came out black in every picture.)
  for (const layer of job.layers) {
    const bitmap = await createImageBitmap(new Blob([layer.png as BlobPart], { type: 'image/png' }));
    ctx.drawImage(bitmap, layer.x, layer.y + job.stripHeight);
    bitmap.close();
  }

  // The strip: what this picture is, so it can be told apart wherever it is opened.
  ctx.fillStyle = '#1b1f24';
  ctx.fillRect(0, 0, canvas.width, job.stripHeight);
  ctx.fillStyle = '#d7dce3';
  ctx.font = `600 ${Math.round(job.stripHeight * 0.42)}px system-ui, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(job.strip, Math.round(job.stripHeight * 0.4), job.stripHeight / 2);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  window.easelPort.done(new Uint8Array(await blob.arrayBuffer()));
});
