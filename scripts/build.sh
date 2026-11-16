#!/usr/bin/env bash
# Builds everything into dist/: the engine (for this machine and for Windows), main, the preloads, the views.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

rm -rf dist
mkdir -p dist/engine dist/shell dist/tab dist/lab

# The engine. No C code, no paths, no build id, no version-control stamp: the same source gives the same file.
go_build() { (cd engine && GOOS="$1" GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "../dist/engine/$2" ./cmd/sshapp-engine); }
go_build linux sshapp-engine
go_build windows sshapp-engine.exe

# The engines' hashes go into the app's own code: main refuses to start an engine that does not match.
node -e '
  const { createHash } = require("node:crypto"); const { readFileSync, writeFileSync } = require("node:fs");
  const h = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  writeFileSync("dist/engine-hashes.json", JSON.stringify({ "linux-x64": h("dist/engine/sshapp-engine"), "win32-x64": h("dist/engine/sshapp-engine.exe") }, null, 2) + "\n");
'

esb() { node_modules/.bin/esbuild "$@" --bundle --log-level=warning --legal-comments=none; }
esb src/main/main.ts      --platform=node    --format=cjs  --target=node24    --external:electron --outfile=dist/main.js
esb src/tab/preload.ts    --platform=node    --format=cjs  --target=node24    --external:electron --outfile=dist/preload-tab.js
esb src/shell/preload.ts  --platform=node    --format=cjs  --target=node24    --external:electron --outfile=dist/preload-shell.js
esb src/tab/tab.ts        --platform=browser --format=iife --target=chrome156 --outfile=dist/tab/tab.js
esb src/shell/shell.tsx   --platform=browser --format=iife --target=chrome156 --jsx=automatic --jsx-import-source=preact --outfile=dist/shell/shell.js
cp src/tab/index.html src/tab/tab.css dist/tab/
cp src/shell/index.html dist/shell/
# Berth's one stylesheet and its typefaces, beside every page that uses them.
ui_into() { mkdir -p "$1/fonts"; cp src/ui/berth.css src/ui/fonts.css "$1/"; while read -r f; do [ -n "$f" ] && cp "node_modules/$f" "$1/fonts/"; done < src/ui/fonts.list; }
ui_into dist/shell
# The easel: a lab-only page that puts pictures of the window together. Served to no one in a release build.
esb src/lab/preload.ts    --platform=node    --format=cjs  --target=node24    --external:electron --outfile=dist/preload-easel.js
esb src/lab/easel.ts      --platform=browser --format=iife --target=chrome156 --outfile=dist/lab/easel.js
cp src/lab/index.html dist/lab/
# The direction pictures: Berth's main window in its chosen direction, for approval. Lab only.
mkdir -p dist/directions/fonts
esb src/directions/app.tsx --platform=browser --format=iife --target=chrome156 --jsx=automatic --jsx-import-source=preact --outfile=dist/directions/directions.js
cp src/directions/index.html dist/directions/
ui_into dist/directions

echo "build: done"
