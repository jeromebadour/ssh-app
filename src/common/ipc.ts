import type { BoxDraft } from './boxes';

// The whole list of messages a view may exchange with main. A message not listed here does not exist.
// Views get no Node and no Electron object: each preload exposes only the functions below.

export const CH = {
  tabInput: 'tab:input', // tab view to main: bytes typed (Uint8Array, at most INPUT_MAX)
  tabOutput: 'tab:output', // main to tab view: bytes for the terminal
  tabState: 'tab:state', // main to tab view: its engine's state
  shellCmd: 'shell:cmd', // shell view to main: new, select or close a tab
  shellState: 'shell:state', // main to shell view: the tabs and their states
  tabShown: 'tab:shown', // main to tab view: you were just brought to the front
  tabBanner: 'tab:banner', // main to tab view: the box's sign-in text, for the terminal only
  tabTaken: 'tab:taken', // tab view to main: output bytes taken in all (a number)
  tabResize: 'tab:resize', // tab view to main: the terminal's size in cells (two numbers)
  tabCopy: 'tab:copy', // tab view to main: text selected in the terminal, for the clipboard (plain text, size-limited)
  meterReport: 'meter:report', // any view to main: its worst numbers since the last report (numbers only)
  meterFrame: 'meter:frame', // any view to main: I have painted (the first frame, or the one after tab:shown)
  // The password. Shell view only: it is the one screen that exists before unlock (plan B2.4).
  gateState: 'gate:state', // main to shell view: where the lock is
  gateCreate: 'gate:create', // shell view to main: the first password (Uint8Array), to make the list
  gateUnlock: 'gate:unlock', // shell view to main: the password (Uint8Array)
  gatePickBackup: 'gate:pick-backup', // shell view to main: open the system's folder chooser for the backup folder
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
}

export interface TabInfo {
  id: number;
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
  places: string[];
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
}

export type ShellCmd =
  | { op: 'new' } // the skeleton's tab with no box: the self-test's
  | { op: 'select'; id: number }
  | { op: 'close'; id: number }
  | { op: 'open'; box: string; place: string } // a tab on a pinned box, in one of its places or its starting folder
  | { op: 'overlay'; on: boolean } // a menu or dialog is open: the shell must be above the tabs
  | { op: 'addBox'; req: number; draft: BoxDraft }
  | { op: 'check'; box: string } // open the first-connection check for a box, and ask it who it is
  | { op: 'paste'; box: string; text: string }
  | { op: 'trust'; box: string } // pin the identity that matched, then open a tab on the box
  | { op: 'closeCheck'; box: string }
  | { op: 'copyBlock'; box: string };

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
  onShown(cb: () => void): void;
  onBanner(cb: (bytes: Uint8Array) => void): void; // the box's sign-in text: for the terminal only
  resize(cols: number, rows: number): void;
  copy(text: string): void; // selected text, offered for the clipboard: taken only from the tab in front of an active window
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
  meter(n: ViewNumbers): void;
  frame(): void;
}
