# ssh-app

A desktop SSH client for Windows: one sealed tab per server, each with its own terminal and its own file browser.
Private; the name is a working name.

**Stage: the sealed skeleton.** No SSH yet. What exists is the shape everything else is built into, with its proofs:

- Every tab is its own processes: a view sealed in Chromium's sandbox (no Node, its own session and origin, no
  network, no navigation, no permissions) and an engine process (Go) that it alone can reach.
- One message format between the processes, in Go and TypeScript, run against the same test vectors.
- The window never waits: nothing in the app's code may block, and a check enforces it.
- Watchdogs show, they never restart: a frozen or dead engine is shown on its tab and nothing else is touched.
- The app measures its own promises as it runs (the meter): how late main ever was, the longest busy stretch in a
  view, how long a real click or key took to be painted, a tab switch, the start. The lab checks them against the
  plan's budgets under a seven-tab flood, times one stated factor for slow test machines
  (`toolchain/test-machine-factor`).

## Build and check

Everything is pinned: packages by `package-lock.json`, Electron's binary by the checksums inside its package, the Go
toolchain by hash in `toolchain/go.env`. Install scripts are off.

```bash
npm ci --ignore-scripts
node node_modules/electron/install.js
bash scripts/get-go.sh
bash scripts/check.sh    # the dependency gate, types, no blocking calls, Go vet and tests, a short fuzz run
bash scripts/build.sh    # dist/: the engine (Linux and Windows), main, preloads, views
bash scripts/smoke.sh dev       # the real app on a virtual screen, sandbox on, running its self-test
node scripts/package.mjs        # out/: four packages (lab and release, Linux and Windows), one app archive
bash scripts/smoke.sh lab       # the same self-test in the lab package; a swapped engine must be refused
bash scripts/smoke.sh release   # the release package: no debugger, no test hook, exits on any argument
```

**Two packages from one commit.** The lab and the release package hold the same app archive, byte for byte. A lab
package's binary keeps the inspect fuse on and has a marker file beside the archive, so the test driver can attach;
a release binary has neither, takes no arguments at all, and stays a release build whatever is put beside it. No
packaging tool is used: Electron's files come from its own release (checked against the checksums in its package),
the archive is written by `scripts/lib/asar.mjs` (same files, same bytes), the fuses by Electron's own fuse tool,
and on Windows the archive's hash goes into the program file for Electron's integrity check.

**The dependency gate** (`scripts/gate.mjs`, with `toolchain/reviewed.json`, `exceptions.json` and `support.json`)
fails the checks if a package appears that nobody reviewed, if any version is younger than 14 days, if a package
lacks its registry hash, or if a compiler or runtime is past its maker's support date. npm's own advisory and
registry-signature checks run beside it.

**The Windows run** (`scripts/smoke-windows.mjs`, CI's `windows` job) is asked for by changing
`toolchain/windows-run` in a pull request; Windows runner time costs more, so it does not run on every one. It
builds everything again on a Windows machine, requires its Windows packages to be file for file the ones the Linux
job built, runs the engine's tests on Windows, then runs the lab and the release package there, including what only
Windows can show: Electron refusing an app archive with one byte changed.

CI runs the same scripts on every pull request (`checks` and `lab`). A pull request is merged, by a workflow, only
after both passed on its head commit; on `main`, CI fails any commit that did not come from a merged pull request.

## Layout

- `engine/`: the Go engine. `internal/frame` is the message format; `cmd/sshapp-engine` is the tab's process.
- `src/main/`: the main process: the window, the views, the engines, the routing, the self-test.
- `src/tab/`, `src/shell/`: the views and their preloads. `src/common/`: the frame format and the message list.
- `protocol/vectors.json`: the test vectors both languages run.
- `scripts/`, `toolchain/`, `.github/workflows/`: build, packaging, checks, pins, CI.

No server, address, user or key of any real machine belongs in this repository, in code, tests, docs or commits.
