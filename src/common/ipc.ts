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
  tabFilePage: 'tab:file-page', // main to tab view: one page of an answer, saying which ask it belongs to
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
}
export const NO_LINK: LinkInfo = { phase: 'none', cause: '', endedIn: '', detail: '', what: '', ours: [], theirs: [], shownFingerprint: '', keyExchange: '', cipher: '', postQuantum: false, silentSinceMs: 0, rttMs: -1, waitingOnWindow: false, exitStatus: -1, droppedBytes: 0 };

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
}

export interface TabInfo {
  id: number;
  againAt: number; // when a new session opens by itself (ms since the epoch); 0 when none is coming
  state: EngineState;
  cause: string; // why it is gone, in plain words; empty otherwise
  box: TabBox | null;
  link: LinkInfo;
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

export interface ShellState {
  tabs: TabInfo[];
  active: number; // tab id, or 0 for none
  boxes: BoxView[];
  boxesFault: string; // the boxes in the list could not be read: said, never guessed at
  check: CheckShown | null;
  added: { req: number; ok: boolean; id: string; error: string; fields: Record<string, string> } | null;
  done: string; // the last thing done, for the status line; empty for nothing yet
  paste: PasteShown | null; // the one paste waiting to be looked at before it is sent
  link: LinkAsked | null; // the one address a box printed, waiting to be looked at before anything opens
  maximized: boolean; // the window fills the screen: the restore glyph is shown in place of the maximize one
  closing: ClosingAsked | null; // the window was asked to close while sessions are open: what would end
  keyFile: KeyFileChosen | null; // a key file chosen for the box being added (plan O1)
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
  | { op: 'trust'; box: string } // pin the identity that matched, then open a tab on the box
  | { op: 'closeCheck'; box: string }
  | { op: 'copyBlock'; box: string }
  | { op: 'window'; do: 'minimize' | 'maximize' | 'close' } // the window's own three buttons, which Berth draws
  | { op: 'closeApp' } // the asking answered: close for real, ending the sessions named
  | { op: 'keepApp' } // the asking answered: keep everything open
  | { op: 'pickKeyFile' } // open the system's file chooser for a key file to bring in (plan O1)
  | { op: 'dropKeyFile' }; // the chosen key file is put aside; the box gets a key Berth makes

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
  pasteMode(protectedPaste: boolean): void; // its box asked for protected paste, or stopped asking
  reopen(now: boolean): void; // now: open a new session at once; otherwise: stop the one that is coming
  onBanner(cb: (bytes: Uint8Array) => void): void; // the box's sign-in text: for the terminal only
  files(ask: FileAsk): void; // ask the box's files for something
  onFilePage(cb: (page: FilePage) => void): void; // one page of an answer
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
  do: 'list' | 'stat' | 'space' | 'cancel';
  path: string;
}

export interface FileRow {
  name: string;
  kind: 'file' | 'folder' | 'link' | 'pipe' | 'device' | 'socket' | 'unknown';
  size: number;
  mode: number;
  mtime: number;
}

export interface FilePage {
  id: number;
  rows?: FileRow[];
  done?: boolean;
  error?: string; // one word for why it stopped: no-such-file, denied, too-many, unsupported, no-answer, failed
  where?: string; // a listing: the folder as the box itself names it
  space?: { total: number; free: number };
  attrs?: FileRow;
}
