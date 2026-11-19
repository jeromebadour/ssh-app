import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CH, INPUT_MAX, MOST_AT_ONCE, type TabInfo, type TabPort } from '../common/ipc';

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
    ipcRenderer.on(CH.tabShown, (_e, front: unknown) => cb(front === true));
  },
  onPaste(cb) {
    ipcRenderer.on(CH.tabPaste, (_e, text: unknown) => cb(String(text)));
  },
  pasteMode(protectedPaste) {
    ipcRenderer.send(CH.tabPasteMode, protectedPaste === true);
  },
  onAgain(cb) {
    ipcRenderer.on(CH.tabAgain, () => cb());
  },
  reopen(now) {
    ipcRenderer.send(CH.tabReopen, now === true);
  },
  onPace(cb) {
    ipcRenderer.on(CH.tabPace, (_e, share: unknown) => cb(typeof share === 'number' && share > 0 && share <= 1 ? share : 1));
  },
  onBanner(cb) {
    ipcRenderer.on(CH.tabBanner, (_e, bytes: Uint8Array) => cb(bytes));
  },
  files(ask) {
    ipcRenderer.send(CH.tabFileAsk, ask);
  },
  // Where a dropped file really is on this PC is worked out here, in the preload, and goes straight to main.
  // The page sees only what the drop handed it, which is the one thing it cannot forge: a File a page builds
  // for itself has no path, so webUtils gives back an empty string for it and nothing is sent. That is what
  // keeps plan B2.7 true while a drag from Windows works as it does in MobaXterm.
  dropped(files, folder) {
    if (typeof folder !== 'string' || folder === '' || folder.length > 4096) return 0;
    const paths: string[] = [];
    for (const f of files ?? []) {
      let at = '';
      try {
        at = webUtils.getPathForFile(f);
      } catch {
        at = '';
      }
      if (typeof at === 'string' && at !== '') paths.push(at);
      if (paths.length >= MOST_AT_ONCE) break;
    }
    if (paths.length > 0) ipcRenderer.send(CH.tabDropped, { folder, paths });
    return paths.length;
  },
  doing(doing, finishedMs) {
    ipcRenderer.send(CH.tabDoing, String(doing), Number(finishedMs));
  },
  onWhole(cb) {
    ipcRenderer.on(CH.tabWhole, () => cb());
  },
  onRightClick(cb) {
    ipcRenderer.on(CH.tabRightClick, () => cb());
  },
  // What the right press landed on, and what a menu over it could offer. Three plain values and nothing
  // else: the page cannot say where the menu goes, because main already knows where the press was.
  rightClickWas(what, selection, held, block) {
    ipcRenderer.send(CH.tabRightClickWas, what === 'menu' ? 'menu' : 'paste', Boolean(selection), Boolean(held), Boolean(block));
  },
  onBlockAsk(cb) {
    ipcRenderer.on(CH.tabBlockAsk, (_e, what) => cb(what === 'command' || what === 'command-and-output' ? what : 'output-to-file'));
  },
  onCopyAsk(cb) {
    ipcRenderer.on(CH.tabCopyAsk, () => cb());
  },
  onClear(cb) {
    ipcRenderer.on(CH.tabClear, () => cb());
  },
  onSaveAsk(cb) {
    ipcRenderer.on(CH.tabSaveAsk, () => cb());
  },
  save(text, what) {
    ipcRenderer.send(CH.tabSave, String(text), String(what));
  },
  onFilePage(cb) {
    ipcRenderer.on(CH.tabFilePage, (_e, page) => cb(page));
  },
  drag(ask) {
    ipcRenderer.send(CH.tabDrag, Number(ask));
  },
  dragAll(asks) {
    ipcRenderer.send(CH.tabDragAll, (Array.isArray(asks) ? asks : []).map((a) => Number(a)));
  },
  onSettings(cb) {
    ipcRenderer.on(CH.tabSettings, (_e, s) => cb(s));
  },
  columns(widths, off) {
    ipcRenderer.send(CH.tabColumns, { widths, off });
  },
  resize(cols, rows) {
    ipcRenderer.send(CH.tabResize, Number(cols), Number(rows));
  },
  link(url) {
    ipcRenderer.send(CH.tabLink, String(url));
  },
  copy(text) {
    ipcRenderer.send(CH.tabCopy, String(text));
  },
  taken(total) {
    ipcRenderer.send(CH.tabTaken, Number(total));
  },
  meter(n) {
    ipcRenderer.send(CH.meterReport, { longTaskMs: Number(n.longTaskMs), reactionMs: Number(n.reactionMs), reactionKind: Number(n.reactionKind), reactionWaitMs: Number(n.reactionWaitMs), reactionHandlerMs: Number(n.reactionHandlerMs) });
  },
  frame() {
    ipcRenderer.send(CH.meterFrame);
  },
};

contextBridge.exposeInMainWorld('tabPort', port);
