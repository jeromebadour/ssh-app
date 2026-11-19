import type { BoxDraft, Place } from './boxes';

// The whole list of messages a view may exchange with main. A message not listed here does not exist.
// Views get no Node and no Electron object: each preload exposes only the functions below.

export const CH = {
  tabInput: 'tab:input', // tab view to main: bytes typed (Uint8Array, at most INPUT_MAX)
  tabOutput: 'tab:output', // main to tab view: bytes for the terminal
  tabState: 'tab:state', // main to tab view: its engine's state
  shellCmd: 'shell:cmd', // shell view to main: new, select or close a tab
  shellState: 'shell:state', // main to shell view: the tabs and their states
  tabShown: 'tab:shown', // main to tab view: you were just brought to the front, or put behind another tab
  tabLink: 'tab:link', // tab view to main: Ctrl+click on an address its box printed
  tabPaste: 'tab:paste', // main to tab view: put this text in, as a paste (main read the clipboard itself)
  tabPasteMode: 'tab:paste-mode', // tab view to main: whether its box asked for protected paste
  tabAgain: 'tab:again', // main to tab view: this is a new session on the same box, from here on
  tabReopen: 'tab:reopen', // tab view to main: open a new session now, or stop the one that is coming
  tabPace: 'tab:pace', // main to tab view: the share of its time a tab behind may spend on output (1: all of it)
  tabBanner: 'tab:banner', // main to tab view: the box's sign-in text, for the terminal only
  tabTaken: 'tab:taken', // tab view to main: output bytes taken in all (a number)
  tabResize: 'tab:resize', // tab view to main: the terminal's size in cells (two numbers)
  tabCopy: 'tab:copy', // tab view to main: text selected in the terminal, for the clipboard (plain text, size-limited)
  // The tab's own file browser, on the box's files. Its asks and the pages that answer them: a listing arrives
  // a page at a time, so a folder of thousands of files is drawn as it is read.
  tabFileAsk: 'tab:file-ask', // tab view to main: list this folder, say what this path is, or stop an ask
  // A file dragged in from Windows and dropped on a tab's file browser. The paths are resolved by that
  // tab's preload, never by its page: a page may not name a file on this PC (plan B2.7), and a File a
  // page made for itself has no path at all, so this channel can only ever carry something the system
  // really dropped on the window.
  tabDropped: 'tab:dropped', // tab preload to main: these paths were dropped into this folder
  tabDoing: 'tab:doing', // tab view to main: waiting at a prompt, running something, or it cannot tell
  tabWhole: 'tab:whole', // main to tab view: select the whole terminal and copy it (Ctrl+Shift+A)
  tabSaveAsk: 'tab:save-ask', // main to tab view: hand over the whole terminal to be saved as a file (Ctrl+Shift+S)
  tabSave: 'tab:save', // tab view to main: text to put in a file he picks, and what it is (plain text, size-limited)
  tabFilePage: 'tab:file-page', // main to tab view: one page of an answer, saying which ask it belongs to
  tabDrag: 'tab:drag', // tab view to main: a file this tab brought over is being dragged out, named by its ask
  tabDragAll: 'tab:drag-all', // tab view to main: several of them at once, each named by its ask
  tabSettings: 'tab:settings', // main to tab view: the settings a tab needs: how big its list starts, and its columns
  tabColumns: 'tab:columns', // tab view to main: a column of its file list was dragged to this width
  // The terminal's own right-button menu. Main's `context-menu` event is the only thing in Berth that can
  // start a paste, and it carries no modifier and no idea what is under the pointer, so main asks the view
  // what the press landed on and the view answers within a moment. A press that asked for a menu opens one
  // on the window's own surface, where the press on Paste is one main sees itself; anything else, and no
  // answer at all, pastes, which is what a right press in a terminal has always done here (plan B2.7, B3).
  tabRightClick: 'tab:right-click', // main to tab view: a right press main saw; say what it landed on
  tabRightClickWas: 'tab:right-click-was', // tab view to main: 'menu', 'paste' or 'none', and what a menu could offer
  tabCopyAsk: 'tab:copy-ask', // main to tab view: hand over what is selected now, for the clipboard
  tabClear: 'tab:clear', // main to tab view: clear this terminal
  tabBlockAsk: 'tab:block-ask', // main to tab view: the block the right press was on, asked for one of its four
  meterReport: 'meter:report', // any view to main: its worst numbers since the last report (numbers only)
  meterFrame: 'meter:frame', // any view to main: I have painted (the first frame, or the one after tab:shown)
  // The password. Shell view only: it is the one screen that exists before unlock (plan B2.4).
  gateState: 'gate:state', // main to shell view: where the lock is
  gateCreate: 'gate:create', // shell view to main: the first password (Uint8Array), to make the list
  gateUnlock: 'gate:unlock', // shell view to main: the password (Uint8Array)
  gatePickBackup: 'gate:pick-backup', // shell view to main: open the system's folder chooser for the backup folder
  gatePickRestore: 'gate:pick-restore', // shell view to main: open the system's file chooser for a backup to restore
  gateUsePrevious: 'gate:use-previous', // shell view to main: restore from the copy saved before this one
  gateForgetRestore: 'gate:forget-restore', // shell view to main: put the chosen backup aside and choose again
  gateRestore: 'gate:restore', // shell view to main: the chosen backup's password (Uint8Array)
  // The passphrase of a chosen key file (plan O1). Its own channel, as every password has: it travels as raw
  // bytes, is used at once and is wiped, and is never part of a command a view builds.
  keyPassphrase: 'key:passphrase', // shell view to main: the passphrase (Uint8Array)
} as const;

// A password is at least this many characters (counted as the key process counts them) and at most this many bytes.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX_BYTES = 1024;

export type GatePhase =
  | 'starting' // the key process has not answered yet
  | 'create' // no list yet: the first start
  | 'locked' // a list is there: the password opens it
  | 'working' // a password is being worked on (about a second, on purpose)
  | 'unlocked'
  | 'damaged' // the list cannot be read; detail says how
  | 'fault'; // the key process is not there; detail says why

export interface GateState {
  phase: GatePhase;
  wrong: boolean; // the last password was wrong
  waitMs: number; // how long, from when this was sent, until the next password is looked at
  backupDir: string; // create: where backups will be written
  backupOk: boolean; // create: that folder can be written to
  detail: string;
  hasPrevious: boolean; // damaged: the copy saved before this one is there
  restoreFrom: string; // damaged: the backup chosen to be opened, as main knows it; '' until one is chosen
}

export const INPUT_MAX = 64 * 1024;
export const COPY_MAX = 4 * 1024 * 1024; // characters a tab may put on the clipboard at once
// Characters a tab may hand over for a file at once. A terminal holds 30,000 rows, so the whole of one is
// well inside this; what it holds off is a page handing main something no person ever typed or read.
export const SAVE_MAX = 8 * 1024 * 1024;
export const TABS_MAX = 12;

export type EngineState = 'starting' | 'ready' | 'not-answering' | 'gone';

// Where a tab's link to its box stands. Every word in it comes from a fixed list or is a number, except
// detail, ours and theirs: those may hold text a box sent, and are shown only escaped and marked as the box's.
export type LinkPhase = 'none' | 'connecting' | 'key-exchange' | 'signing-in' | 'up' | 'ended';
export const LINK_CAUSES = ['refused', 'unreachable', 'timed-out', 'weak-offer', 'identity-changed', 'sign-in-failed', 'no-signature', 'reset', 'closed-by-box', 'silent-too-long', 'cancelled', 'protocol', 'no-shell', 'shell-exited'] as const;
export interface LinkInfo {
  phase: LinkPhase;
  cause: string; // ended: one of LINK_CAUSES
  endedIn: string; // ended: the phase it happened in
  detail: string;
  what: string; // a weak offer: which list
  ours: string[];
  theirs: string[];
  shownFingerprint: string; // identity-changed: what the box showed in place of the pinned identity
  keyExchange: string; // up: what was agreed
  cipher: string;
  postQuantum: boolean;
  silentSinceMs: number; // up: 0, or when the silence began (the link is kept)
  rttMs: number; // up: the last round trip, -1 before the first
  waitingOnWindow: boolean; // the box is made to wait for this window
  exitStatus: number; // the shell's exit status, -1 while unknown
  droppedBytes: number; // typed bytes the engine could not keep for the box (it was silent too long): never hidden
  fault: string; // the id of the line in the local log for the failure that ended it, or empty: main's own
}
export const NO_LINK: LinkInfo = { phase: 'none', cause: '', endedIn: '', detail: '', what: '', ours: [], theirs: [], shownFingerprint: '', keyExchange: '', cipher: '', postQuantum: false, silentSinceMs: 0, rttMs: -1, waitingOnWindow: false, exitStatus: -1, droppedBytes: 0, fault: '' };

// Which box a tab is on, for its label. Null for the skeleton's tab with no box (the self-test's).
export interface TabBox {
  id: string;
  name: string;
  colour: number;
  place: string;
  addr: string; // host:port, for the tab to say what it connected to
  user: string;
  folder: string; // the place's folder, or the box's starting folder
  pinType: string; // 'ED25519' or 'RSA': the kind of identity pinned for this box
  keepsRunning: boolean; // a tmux place: what runs in it survives a link that is truly gone (plan B2.5, line 2)
}

export interface TabInfo {
  id: number;
  own: string; // what he called this tab; empty when it goes by its box and place
  ownColour: number; // the colour he gave it, 1 to BOX_COLOURS; 0 when it goes by its box's colour
  againAt: number; // when a new session opens by itself (ms since the epoch); 0 when none is coming
  state: EngineState;
  cause: string; // why it is gone, in plain words; empty otherwise
  box: TabBox | null;
  link: LinkInfo;
  // What this tab's terminal is doing, as the tab itself reads this box's prompt: 'idle' waiting at a
  // prompt, 'running' with something in it, 'unknown' when the prompt could not be learned. A reading aid,
  // never a proof (plan A5), and what the mark on a background tab is drawn from.
  doing: 'unknown' | 'idle' | 'running';
  // A tab that is not in front and has something to say: something finished in it (with how long it took),
  // or it printed while nobody was looking. Both are cleared the moment the tab is looked at.
  finishedMs: number; // 0 when nothing finished unseen
  unseen: boolean; // it printed while this tab was not in front
}

// A box as the shell may draw it: no key, nothing secret. The identity is told only once it is pinned.
export interface BoxView {
  id: string;
  name: string;
  colour: number;
  host: string;
  port: number;
  user: string;
  folder: string;
  places: Place[]; // each with its folder, so Edit box shows what a place really is
  pinned: boolean;
  pinFingerprint: string;
  pinType: string; // 'ED25519' or 'RSA' once pinned
  pinnedAt: string;
}

// The one first-connection check open in a dialog. What the box showed is in it only after a paste was compared.
export interface CheckShown {
  boxId: string;
  name: string;
  addr: string;
  block: string; // the one block to run on the box, with its key in it
  step: 'idle' | 'reaching' | 'reached' | 'unreachable' | 'match' | 'mismatch';
  phase: string;
  cause: string;
  detail: string;
  what: string;
  ours: string[];
  theirs: string[];
  shownType: string;
  shownFingerprint: string;
  pasted: string[];
  askedAt: string[]; // when the box was asked (UTC), the latest last
}

// The first visit (decision O2). It never carries a password: what is typed goes straight to main and is not
// kept, so there is nothing here to leak into a window's state or into a picture of it.
export interface FirstVisitShown {
  box: string; // the box's id
  name: string; // and its name, for the screen
  user: string;
  addr: string;
  phase: '' | 'asking' | 'visiting' | 'answering' | 'proving' | 'done' | 'failed';
  said: string; // what the box printed back, escaped and capped: a box's own words
  error: string; // why it did not work, in one word from a written list
  detail: string;
  // The box asked its own questions at sign-in: a code from a phone, or a question of its own. These are
  // the box's own words, escaped and capped, shown on this one screen and nowhere else. `show` says whether
  // the box wants that answer seen as it is typed; an answer the box wants hidden is a password's twin and
  // is drawn as one.
  asked: { question: string; show: boolean }[];
}

export interface ShellState {
  tabs: TabInfo[];
  active: number; // tab id, or 0 for none
  boxes: BoxView[];
  boxesFault: string; // the boxes in the list could not be read: said, never guessed at
  check: CheckShown | null;
  added: { req: number; ok: boolean; id: string; error: string; fields: Record<string, string> } | null;
  done: string; // the last thing done, for the status line; empty for nothing yet
  paste: PasteShown | null; // the one paste waiting to be looked at before it is sent
  termMenu: TermMenuShown | null; // the terminal's right-button menu, drawn by the window because one line of it pastes
  // When the last word on the status line was said, as milliseconds since the epoch, or 0 when nothing has
  // been said yet. His own rule for his console: a line saying what happened carries the time it happened,
  // or there is no telling it from one an hour old (2026-11-18, what the two windows side by side turned up).
  doneAt: number;
  link: LinkAsked | null; // the one address a box printed, waiting to be looked at before anything opens
  maximized: boolean; // the window fills the screen: the restore glyph is shown in place of the maximize one
  closing: ClosingAsked | null; // the window was asked to close while sessions are open: what would end
  keyFile: KeyFileChosen | null; // a key file chosen for the box being added (plan O1)
  replacing: ReplaceAsked | null; // a file is already where one is being sent: what is there, and what is coming
  firstVisit: FirstVisitShown | null; // decision O2: the one screen that ever asks for a box's own password
  settings: AppSettings; // what the app remembers about itself; the defaults until the list is open
  settingsOpen: boolean; // the settings are on screen
  downloadsNow: string; // where downloads land as things stand, default or chosen: the folder, written out
  // The morning: what was open when he last used the app, offered to open again. It is there only while no
  // tab is open at all, because once he has opened one the morning is over and the offer is in the way.
  reopen: { box: string; name: string; colour: number; place: string; own: string; ownColour: number }[];
  // The list is open and this state is the real one. Until it is true the window knows nothing of his boxes,
  // so the screen that offers them draws nothing to press: a button drawn from a state the app does not have
  // yet is a button that moves out from under the press when the real state lands.
  ready: boolean;
}

// Sending a file where a file of that name already is. Replacing one on a box cannot be undone from here, so
// Berth asks first and puts both files in front of the person rather than taking one press for it
// (BUILD-RULES 2.20). Keeping what is there has the focus.
export interface ReplaceAsked {
  tab: number;
  box: string;
  folder: string; // the folder on the box, as the box names it
  name: string; // the name both files have
  bytes: number; // what is on the box now
  changed: number; // when it last changed, as the box says (seconds)
  sendingBytes: number; // what would go in its place
}

// A key file the person chose for the box being added. Its bytes live in main alone and are never told to a
// view: what a view learns is the file's name, the public half of the key inside it, and what is in the way.
export interface KeyFileChosen {
  name: string; // the file's own name, not its path
  publicKey: string; // the public half, once the file has opened; empty until then
  keyType: string; // the kind of key it is, as SSH names it; empty until then
  fingerprint: string; // SHA256:..., worked out by main from the key's own bytes; empty until the file opens
  needsPassphrase: boolean; // the file has a passphrase and none, or the wrong one, has been given
  wrongPassphrase: boolean; // one was given and it did not open the file
  fault: string; // why the file cannot be used at all; empty when it can
}

// Closing the window while sessions are open. Berth asks first and names what would go, rather than ending them
// on one press (BUILD-RULES 2.20); nothing is closed until the answer comes back.
export interface ClosingAsked {
  live: { id: number; box: string; place: string; words: string }[]; // the sessions that would end, as the bar says them
  idle: number; // the other tabs open, which have nothing to lose
}

// An address a box printed, Ctrl+clicked, and shown whole before anything opens (plan B2.7). A box can print
// anything, so the address is Berth's to show and the person's to allow; the app itself opens nothing.
export interface LinkAsked {
  tab: number;
  box: string;
  place: string;
  url: string;
  host: string; // its host alone, which is what decides where it really goes
  scheme: string;
}

// The terminal's menu, as the window draws it. Where the press landed is in the window's own coordinates,
// and what the menu may offer is what the terminal really has: nothing in it is a line that cannot be used
// (BUILD-RULES 2.8).
export interface TermMenuShown {
  tab: number;
  box: string;
  x: number;
  y: number;
  selection: boolean; // something is selected in it, so Copy has something to copy
  held: boolean; // the terminal holds something, so Select all, Save output and Clear have something to act on
  // The press was on one command's own mark, so the menu is about that command and nothing else. The mark
  // is Berth's own drawing rather than the box's text, which is why a plain press on it opens this and a
  // plain press anywhere else in the terminal still pastes.
  block: boolean;
}

// A paste of more than one line, shown before it is sent: its own lines, and what in it cannot be seen by
// looking (plan B3). The text itself is main's; the shell only draws it and says yes or no.
export interface PasteShown {
  tab: number;
  box: string; // the box it would go to, by name
  place: string;
  lines: string[];
  endsWithLineEnding: boolean;
  odd: { line: number; at: number; what: string; shown: string }[];
  cut: boolean;
  controlsRemoved: number;
  protectedPaste: boolean; // the box asked for protected paste, so a shell can tell it was pasted
}

export type ShellCmd =
  | { op: 'new' } // the skeleton's tab with no box: the self-test's
  | { op: 'select'; id: number }
  | { op: 'close'; id: number }
  // What he calls one tab, and the colour he gives it. A name of '' puts it back to its box and place,
  // a colour of 0 back to its box's own. Both are saved with the tabs the morning offers to open again.
  | { op: 'nameTab'; id: number; name: string; colour: number }
  | { op: 'open'; box: string; place: string } // a tab on a pinned box, in one of its places or its starting folder
  | { op: 'overlay'; on: boolean } // a menu or dialog is open: the shell must be above the tabs
  | { op: 'addBox'; req: number; draft: BoxDraft } // a new box: its key is made and it goes straight to its check
  | { op: 'editBox'; req: number; box: string; draft: BoxDraft } // save what changed about a box
  | { op: 'forgetIdentity'; box: string } // a rebuilt box: forget the identity pinned for it
  | { op: 'removeBox'; box: string } // delete a box: it and its key go together
  | { op: 'check'; box: string } // open the first-connection check for a box, and ask it who it is
  | { op: 'paste'; box: string; text: string }
  | { op: 'openLink' } // the address being shown: open it in the browser
  | { op: 'dropLink' } // the address being shown: open nothing
  | { op: 'sendPaste' } // the paste being shown: send it to its box
  | { op: 'dropPaste' } // the paste being shown: send nothing
  // One line of the terminal's menu was pressed, on the window's own surface, so main saw the press itself.
  | { op: 'termMenu'; line: 'copy' | 'paste' | 'all' | 'save' | 'clear' | 'blockCommand' | 'blockBoth' | 'blockSave' }
  | { op: 'shutTermMenu' } // the terminal's menu went without a line being pressed
  | { op: 'trust'; box: string } // pin the identity that matched, then open a tab on the box
  | { op: 'trustThenVisit'; box: string } // pin it, then open the first visit (decision O2) instead of a tab
  | { op: 'closeCheck'; box: string }
  | { op: 'copyBlock'; box: string }
  | { op: 'window'; do: 'minimize' | 'maximize' | 'close' } // the window's own three buttons, which Berth draws
  | { op: 'closeApp' } // the asking answered: close for real, ending the sessions named
  | { op: 'firstVisit'; box: string } // decision O2: open the one screen that ever asks for a box's password
  | { op: 'firstVisitGo'; box: string; password: string } // use it once, to put Berth's key on that box
  | { op: 'firstVisitAnswers'; box: string; answers: string[] } // the answers to a box's own questions at sign-in
  | { op: 'firstVisitClose' } // the screen is closed; nothing is kept
  | { op: 'settings'; show: boolean } // open or close the settings; nothing is changed by opening it
  | { op: 'pickDownloads' } // choose where downloads land: main opens the system's own chooser
  | { op: 'defaultDownloads' } // put the download folder back to Berth's own default
  | { op: 'paneSize'; size: number } // how big the list's text starts in a new tab
  | { op: 'keepApp' } // the asking answered: keep everything open
  | { op: 'pickKeyFile' } // open the system's file chooser for a key file to bring in (plan O1)
  | { op: 'dropKeyFile' } // the chosen key file is put aside; the box gets a key Berth makes
  | { op: 'replaceFile' } // the file being sent may go in over the one on the box
  | { op: 'keepFile' } // the file on the box is left exactly as it is, and nothing is sent
  | { op: 'reopen'; which: number[] } // the morning: open these of the last session's tabs again
  | { op: 'dropReopen' }; // the morning's offer is put away; what was open is forgotten

// What a view may tell the meter: numbers only, in milliseconds.
// The slowest reaction also says where its time went, so that a slow one can be explained and not guessed at:
//   reactionKind       which kind of event it was, as its place in REACTION_KINDS
//   reactionWaitMs     from the event reaching the page to its handlers starting (the page was busy)
//   reactionHandlerMs  inside the handlers
//   the rest of reactionMs is the wait for the next painted frame
export interface ViewNumbers {
  longTaskMs: number;
  reactionMs: number;
  reactionKind: number;
  reactionWaitMs: number;
  reactionHandlerMs: number;
}

// The events that are a click or a key, which is what the promise is about (plan A1, B8). A fixed list: a view
// names an event by its place here, never by a text of its own. The pointer merely passing over a view (enter,
// leave, over, out) is not in it: nobody pressed anything, and a view that has just been hidden gets one of those
// with no frame left to answer it.
export const REACTION_KINDS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend'] as const;

export interface TabPort {
  readonly sandboxed: boolean;
  send(bytes: Uint8Array): void;
  onOutput(cb: (bytes: Uint8Array) => void): void;
  onState(cb: (info: TabInfo) => void): void;
  onShown(cb: (front: boolean) => void): void; // brought to the front, or put behind another tab
  onPace(cb: (share: number) => void): void; // how much of its time a tab behind may spend on output
  onAgain(cb: () => void): void; // a new session has begun on the same box
  onPaste(cb: (text: string) => void): void; // put this text in, as a paste
  onRightClick(cb: () => void): void; // main saw a right press on this view: say what it landed on
  // 'none' is the answer when the press was not on the terminal at all: the file pane's own menu answers
  // for its rows, and a press on a grip, a pane's head or its foot means nothing, so nothing should happen.
  rightClickWas(what: 'menu' | 'paste' | 'none', selection: boolean, held: boolean, block: boolean): void;
  onBlockAsk(cb: (what: 'command' | 'command-and-output' | 'output-to-file') => void): void;
  onCopyAsk(cb: () => void): void; // hand over what is selected now, for the clipboard
  onClear(cb: () => void): void; // clear this terminal
  pasteMode(protectedPaste: boolean): void; // its box asked for protected paste, or stopped asking
  reopen(now: boolean): void; // now: open a new session at once; otherwise: stop the one that is coming
  onBanner(cb: (bytes: Uint8Array) => void): void; // the box's sign-in text: for the terminal only
  files(ask: FileAsk): void; // ask the box's files for something
  // Files dropped on this tab from Windows. The page hands over what the drop gave it and the folder on
  // the box they are for; the preload works out where each one lives on this PC and tells main. The page
  // never learns a path, and a File it made itself has none, so it cannot name a file of its own
  // choosing. Answers how many of them really had a path, so the pane can say when a drop was of
  // something that is not a file at all.
  dropped(files: readonly File[], folder: string): number;
  // What this tab's terminal is doing, as its own reading of this box's prompt sees it, and how long the
  // command that just finished took. It is used for the mark on a tab that is not in front and for the one
  // notification when something long ends; main writes every word of both (plan B2.7). A view that lies here
  // gains a wrong mark and nothing else.
  doing(doing: string, finishedMs: number): void;
  onWhole(cb: () => void): void; // main says Ctrl+Shift+A was pressed: select the whole terminal and copy it
  onSaveAsk(cb: () => void): void; // main says Ctrl+Shift+S was pressed: hand over the whole terminal to save
  // Text for a file. The view never names a file: it hands over what to write and what to call it in words,
  // and main asks him where it goes (the same rule the key file and the downloads folder follow, plan B2.7).
  save(text: string, what: string): void;
  onFilePage(cb: (page: FilePage) => void): void; // one page of an answer
  drag(ask: number): void;
  dragAll(asks: number[]): void; // several files this tab brought over, dragged out together // begin dragging out the file this tab's own ask brought over; a view names no path
  onSettings(cb: (s: { paneSize: number; columns: AppSettings['columns']; columnsOff: AppSettings['columnsOff'] }) => void): void;
  // A column of the file list was dragged to a new width: every tab is told, and the next one starts there.
  columns(widths: AppSettings['columns'], off: AppSettings['columnsOff']): void;
  resize(cols: number, rows: number): void;
  copy(text: string): void;
  link(url: string): void; // Ctrl+click on an address its box printed // selected text, offered for the clipboard: taken only from the tab in front of an active window
  taken(total: number): void; // how many output bytes this view has taken in all: the box sends ahead of this by a fixed amount at most
  meter(n: ViewNumbers): void;
  frame(): void;
}

export interface ShellPort {
  readonly sandboxed: boolean;
  cmd(c: ShellCmd): void;
  onState(cb: (s: ShellState) => void): void;
  onGate(cb: (g: GateState) => void): void;
  gateCreate(password: Uint8Array): void;
  gateUnlock(password: Uint8Array): void;
  gatePickBackup(): void;
  gatePickRestore(): void;
  gateUsePrevious(): void;
  gateRestore(password: Uint8Array): void;
  keyPassphrase(passphrase: Uint8Array): void; // the passphrase of the chosen key file (plan O1)
  gateForgetRestore(): void;
  meter(n: ViewNumbers): void;
  frame(): void;
}


// What a tab may ask of its box's files, and what comes back. Every ask carries its own number, and every page
// says which ask it belongs to: a person moving quickly through folders leaves earlier listings still
// arriving, and the window keeps the newest and drops the rest.
export interface FileAsk {
  id: number;
  do: 'list' | 'stat' | 'space' | 'read' | 'get' | 'put' | 'hash' | 'delete' | 'trash' | 'restore' | 'empty' | 'cancel' | 'unqueue' | 'grab' | 'rename' | 'folder';
  name?: string; // restore: which thing in the trash to put back; rename and folder: the one name a person typed. Never a path
  which?: 'sha256' | 'md5'; // a hash asked for: which one. Only these two may ever be asked of a box
  path: string;
}

// One thing in a box's trash. The record lives on the box, inside the trash itself, so it survives this app
// being reinstalled: what a view is told here is only what to draw.
export interface Trashed {
  name: string; // what it is called inside the trash
  from: string; // the whole path it was deleted from
  when: number; // when it was deleted
  size: number;
  kind: string;
}

export interface FileRow {
  name: string;
  kind: 'file' | 'folder' | 'link' | 'pipe' | 'device' | 'socket' | 'unknown';
  size: number;
  mode: number;
  mtime: number;
  // Who owns it. The protocol carries the owner as a number alone; the name is only ever in the long form a
  // box prints for `ls -l`, so it is there when the box wrote that line in the usual shape and absent when it
  // did not. A window shows the name, falls back to the number, and shows nothing when the box said neither:
  // an owner of 0 is root, so a missing owner must never be drawn as one.
  owner?: string;
  uid?: number;
  hasid?: boolean;
}

// How many files one chooser may hand over to one box at a time. A person picking a folder's worth gets them
// all; a person who picked ten thousand by accident gets as many as this and a line saying the rest were
// left. Main holds to it and the window names it, so it is written once, here.
// What the app remembers about itself, beside the boxes, inside the same locked list. It is small on purpose:
// a setting exists here only when leaving it to a default would be wrong for him, never because an app of this
// kind usually has one (his own rule: no feature he does not use).
export interface AppSettings {
  downloads: string; // where everything brought over from a box lands; empty means the default folder
  paneSize: number; // how big the list's text starts in a new tab, as a share of its own size; 0 means 1
  // How wide each column of the file list is, in pixels, for the columns he has dragged. A column he has
  // not touched is not in here at all and takes the width its contents ask for. Saved because a column he
  // set and found reset in the morning is a column he has to set again.
  columns: Partial<Record<'name' | 'size' | 'changed' | 'owner', number>>;
  // The columns he has turned off. Name is never in here: a list of files without their names is not a
  // list. Saved beside the widths, for the same reason: a column he turned off and found back in the
  // morning is a column he has to turn off again.
  columnsOff: ('size' | 'changed' | 'owner')[];
}

export const SETTINGS_DEFAULT: AppSettings = { downloads: '', paneSize: 1, columns: {}, columnsOff: [] };

export const MOST_AT_ONCE = 64;

// How big a file may be and still be fetched by a press, so it can be dragged out of the window. Bigger than
// this is a download, with its own line and its own Stop. Written once, here, and read by both sides.
export const GRAB_MAX = 4 * 1024 * 1024;

export interface FilePage {
  id: number;
  rows?: FileRow[];
  done?: boolean;
  error?: string; // one word for why it stopped: no-such-file, denied, too-many, unsupported, no-answer, failed
  fault?: string; // the id of the line in the local log, for a failure that leaves nothing to act on: main's own
  // The whole of what went wrong, in the words of whatever said so: often a box's own, so it is shown as
  // text and never acted on, and it is capped and stripped by the engine before it ever gets here.
  detail?: string;
  where?: string; // a listing: the folder as the box itself names it
  space?: { total: number; free: number };
  attrs?: FileRow;
  data?: string; // a file being read: a piece of it, base64, in order from its start
  more?: boolean; // a file being read: it goes on past what Berth will read into a viewer
  // A file being brought over to the PC.
  got?: number; // bytes written to the PC so far
  of?: number; // how big the box says the file is
  landed?: string; // the name it was given on the PC, once it is really there
  mark?: string; // "checked", "changed" or "not-checked": what its hash proved
  markWhy?: string; // why it could not be checked, where it could not
  into?: string; // the folder everything brought over lands in; main's word, never a view's
  renamed?: string; // why the name it landed under is not the box's name for it
  replaced?: boolean; // a file sent to a box: it went in over a file that was already there
  there?: FileRow; // a file sent to a box: what is already at that name, when something is
  asking?: string; // a file sent to a box: it is waiting on a question about this name, and nothing is moving
  hash?: string; // a hash asked for: the box's own hash of the file
  which?: string; // a hash asked for: which one it is
  resumedAt?: number; // a transfer taken up again: how much of it was already there
  trashed?: Trashed; // a delete or a restore: the one thing that moved
  trash?: Trashed[]; // what is in the trash now, newest first
  emptied?: number; // an emptying: how many things went
  freed?: number; // an emptying: how much they were holding
  alsoSending?: string; // more than one file was chosen: a transfer main began on its own, under this name
  droppedInto?: string; // this transfer began with a drop from Windows, into this folder on the box
  waiting?: number; // more than one file was chosen: how many are still waiting their turn
  tooMany?: number; // more than one chooser may hand over was chosen: how many were left behind
  unqueued?: number; // what was waiting to be sent was dropped: how many were dropped
  draggable?: boolean; // a download that landed: this ask's file is on the PC and can be dragged out of the window
  dragGone?: boolean; // a drag was asked for a file that is no longer in the download folder
  carrying?: boolean; // this page belongs to a file fetched only so it can be dragged, not to a download
}
