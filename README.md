# ssh-app

A desktop SSH client for Windows: one sealed tab per server, each with its own terminal and its own file browser.
Private; the name is a working name.

**Stage: the sealed skeleton.** No SSH yet. What exists is the shape everything else is built into, with its proofs:

- Every tab is its own processes: a view sealed in Chromium's sandbox (no Node, its own session and origin, no
  network, no navigation, no permissions) and an engine process (Go) that it alone can reach.
- One message format between the processes, in Go and TypeScript, run against the same test vectors.
- The window never waits: nothing in the app's code may block, and a check enforces it.
- Watchdogs show, they never restart: a frozen or dead engine is shown on its tab and nothing else is touched.

## Build and check

Everything is pinned: packages by `package-lock.json`, Electron's binary by the checksums inside its package, the Go
toolchain by hash in `toolchain/go.env`. Install scripts are off.

```bash
npm ci --ignore-scripts
node node_modules/electron/install.js
bash scripts/get-go.sh
bash scripts/check.sh    # types, no blocking calls, Go vet and tests, a short fuzz run, TypeScript tests
bash scripts/build.sh    # dist/: the engine (Linux and Windows), main, preloads, views
bash scripts/smoke.sh    # the real app on a virtual screen, sandbox on, running its self-test
```

CI runs the same scripts on every pull request (`checks` and `lab`). A pull request is merged, by a workflow, only
after both passed on its head commit; on `main`, CI fails any commit that did not come from a merged pull request.

## Layout

- `engine/`: the Go engine. `internal/frame` is the message format; `cmd/sshapp-engine` is the tab's process.
- `src/main/`: the main process: the window, the views, the engines, the routing, the self-test.
- `src/tab/`, `src/shell/`: the views and their preloads. `src/common/`: the frame format and the message list.
- `protocol/vectors.json`: the test vectors both languages run.
- `scripts/`, `toolchain/`, `.github/workflows/`: build, checks, pins, CI.

No server, address, user or key of any real machine belongs in this repository, in code, tests, docs or commits.
