// Pictures of the whole window, from the real app. The window is several sealed views, each drawn by its own
// process, so no single view can take the picture: main asks each view for its pixels and the easel (a lab-only
// page) puts them together where they sit. Lab and development builds only; reached from the self-test.
import { ipcMain, session, WebContentsView, type BaseWindow, type Session } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EaselJob, EaselLayer } from '../lab/easel-job';

export interface Shot {
  view: WebContentsView;
}

let easel: WebContentsView | null = null;

async function easelView(dist: string, harden: (ses: Session) => void): Promise<WebContentsView> {
  if (easel) return easel;
  const ses = session.fromPartition('easel', { cache: false });
  harden(ses);
  const view = new WebContentsView({
    webPreferences: { session: ses, preload: path.join(dist, 'preload-easel.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, backgroundThrottling: false },
  });
  await view.webContents.loadURL('app://easel/index.html');
  easel = view;
  return view;
}

async function pixels(view: WebContentsView): Promise<EaselLayer & { scale: number }> {
  const bounds = view.getBounds();
  const image = await view.webContents.capturePage();
  const size = image.getSize();
  const scale = size.width / Math.max(1, bounds.width);
  return { x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale), width: size.width, height: size.height, bgra: image.toBitmap(), scale };
}

// Takes one picture of the whole window and writes it as a PNG. `views` are given back to front.
export async function takePicture(opts: { win: BaseWindow; views: WebContentsView[]; file: string; strip: string; dist: string; harden: (ses: Session) => void }): Promise<{ width: number; height: number; scale: number }> {
  const content = opts.win.getContentBounds();
  const layers = [];
  for (const v of opts.views) layers.push(await pixels(v));
  const scale = layers[0]?.scale ?? 1;
  const job: EaselJob = {
    width: Math.round(content.width * scale),
    height: Math.round(content.height * scale),
    strip: opts.strip,
    stripHeight: Math.round(36 * scale),
    layers: layers.map(({ scale: _s, ...layer }) => layer),
  };
  const view = await easelView(opts.dist, opts.harden);
  const png = await new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the easel did not answer')), 20_000);
    ipcMain.once('easel:done', (e, data: unknown) => {
      clearTimeout(timer);
      if (e.sender.id !== view.webContents.id || !(data instanceof Uint8Array)) return reject(new Error('not the easel'));
      resolve(data);
    });
    view.webContents.send('easel:job', job);
  });
  await writeFile(opts.file, png);
  return { width: job.width, height: job.height + job.stripHeight, scale };
}
