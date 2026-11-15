// The whole list of messages a view may exchange with main. A message not listed here does not exist.
// Views get no Node and no Electron object: each preload exposes only the functions below.

export const CH = {
  tabInput: 'tab:input', // tab view to main: bytes typed (Uint8Array, at most INPUT_MAX)
  tabOutput: 'tab:output', // main to tab view: bytes for the terminal
  tabState: 'tab:state', // main to tab view: its engine's state
  shellCmd: 'shell:cmd', // shell view to main: new, select or close a tab
  shellState: 'shell:state', // main to shell view: the tabs and their states
  tabShown: 'tab:shown', // main to tab view: you were just brought to the front
  meterReport: 'meter:report', // any view to main: its worst numbers since the last report (numbers only)
  meterFrame: 'meter:frame', // any view to main: I have painted (the first frame, or the one after tab:shown)
} as const;

export const INPUT_MAX = 64 * 1024;
export const TABS_MAX = 12;

export type EngineState = 'starting' | 'ready' | 'not-answering' | 'gone';

export interface TabInfo {
  id: number;
  state: EngineState;
  cause: string; // why it is gone, in plain words; empty otherwise
}

export interface ShellState {
  tabs: TabInfo[];
  active: number; // tab id, or 0 for none
}

export type ShellCmd = { op: 'new' } | { op: 'select'; id: number } | { op: 'close'; id: number };

// What a view may tell the meter: two numbers, in milliseconds.
export interface ViewNumbers {
  longTaskMs: number;
  reactionMs: number;
}

export interface TabPort {
  readonly sandboxed: boolean;
  send(bytes: Uint8Array): void;
  onOutput(cb: (bytes: Uint8Array) => void): void;
  onState(cb: (info: TabInfo) => void): void;
  onShown(cb: () => void): void;
  meter(n: ViewNumbers): void;
  frame(): void;
}

export interface ShellPort {
  readonly sandboxed: boolean;
  cmd(c: ShellCmd): void;
  onState(cb: (s: ShellState) => void): void;
  meter(n: ViewNumbers): void;
  frame(): void;
}
