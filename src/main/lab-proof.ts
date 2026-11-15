// Is this program a lab package? Asked once, at the very top of main, before Electron has done anything, and
// answered there and then.
//
// This is the one place in the app that reads a file with a blocking call (scripts/no-sync.mjs names it, and
// allows nothing else). The reason: a release build must refuse arguments before the event loop turns once.
// While the answer was awaited instead, Chromium went on starting behind it (its zygote, its graphics process,
// whatever its own switches asked for) and the refusal then landed in the middle of that start-up: seen as a
// release binary given "--lab --remote-debugging-port" that did not exit on GitHub's machine, and as exit
// code 5 instead of 64 under load. Nothing exists yet that this could hold up: no window, no tab, no engine.
//
// A lab package has the inspect fuse left on in its binary and a marker file beside the app archive. Both are
// outside the archive, so lab and release hold the same app code byte for byte. A release binary never
// passes: its fuse is off, whatever files sit beside it.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { FUSE_NODE_CLI_INSPECT, fuseIn } from './fuse';

export function isLabPackageNow(resourcesPath: string, execPath: string): boolean {
  try {
    statSync(path.join(resourcesPath, 'lab'));
    return fuseIn(readFileSync(execPath), FUSE_NODE_CLI_INSPECT) === 'on';
  } catch {
    return false;
  }
}
