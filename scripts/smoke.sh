#!/usr/bin/env bash
# Starts the built app for real (its own window on a virtual screen, the Chromium sandbox on) and runs the
# self-test inside it. Needs scripts/build.sh first. Never run as root: Chromium's sandbox refuses root, and a
# test with the sandbox off would prove nothing about the sealed views.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

electron=node_modules/electron/dist/electron
helper=node_modules/electron/dist/chrome-sandbox
[ -x "$electron" ] || { echo "smoke: Electron's binary is missing (run: node node_modules/electron/install.js)" >&2; exit 1; }
[ -f dist/main.js ] || { echo "smoke: nothing built (run scripts/build.sh)" >&2; exit 1; }

# Linux needs Chromium's sandbox helper owned by root with the setuid bit.
if [ "$(stat -c '%U:%a' "$helper")" != "root:4755" ]; then
  if [ "$(id -u)" = 0 ]; then chown root:root "$helper" && chmod 4755 "$helper"
  else sudo chown root:root "$helper" && sudo chmod 4755 "$helper"; fi
fi

run=(xvfb-run -a --server-args='-screen 0 1440x900x24' env -u NODE_OPTIONS SSHAPP_SELFTEST=1 "$electron" .)
if [ "$(id -u)" = 0 ]; then
  id sshapp-lab >/dev/null 2>&1 || useradd -m -s /bin/bash sshapp-lab
  run=(runuser -u sshapp-lab -- "${run[@]}")
fi

log="$(mktemp)"
set +e
timeout 150 "${run[@]}" >"$log" 2>&1
code=$?
set -e

line="$(grep -a '^SELFTEST ' "$log" | tail -1 || true)"
if [ -z "$line" ]; then
  echo "smoke: the app gave no result (exit code $code)." >&2
  grep -a -A12 '^MAINFAULT' "$log" >&2 || tail -40 "$log" >&2
  exit 1
fi
node -e '
  const r = JSON.parse(process.argv[1].slice(9));
  for (const x of r.results) console.log((x.ok ? "ok    " : "FAIL  ") + x.name + (x.ok ? "" : "   -> " + x.detail));
  const bad = r.results.filter((x) => !x.ok).length;
  console.log(bad ? `smoke: ${bad} of ${r.results.length} probes FAILED` : `smoke: all ${r.results.length} probes held`);
  process.exit(bad ? 1 : 0);
' "$line"
[ "$code" = 0 ] || { echo "smoke: the app exited with code $code" >&2; exit 1; }
