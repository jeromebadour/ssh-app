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
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const layer of job.layers) {
    const rgba = new Uint8ClampedArray(layer.bgra.length);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = layer.bgra[i + 2]!;
      rgba[i + 1] = layer.bgra[i + 1]!;
      rgba[i + 2] = layer.bgra[i]!;
      rgba[i + 3] = 255;
    }
    ctx.putImageData(new ImageData(rgba, layer.width, layer.height), layer.x, layer.y + job.stripHeight);
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
