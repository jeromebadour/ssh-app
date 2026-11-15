#!/usr/bin/env bash
# Starts the app for real (its own window on a virtual screen, Chromium's sandbox on) and checks it.
#
#   scripts/smoke.sh dev       the built tree, run by Electron directly: the self-test
#   scripts/smoke.sh lab       the lab package: the same self-test, in a packaged app; then a swapped engine
#   scripts/smoke.sh release   the release package, with no debugger and no test hook: it starts, says it is a
#                              release build, ignores the self-test switch, and exits on any argument
#
# Never run as root: Chromium's sandbox refuses root, and a test with the sandbox off would prove nothing about
# the sealed views. When started as root (the build workspace), it runs the app as an unprivileged user.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
mode="${1:-dev}"

as_user=()
if [ "$(id -u)" = 0 ]; then
  id sshapp-lab >/dev/null 2>&1 || useradd -m -s /bin/bash sshapp-lab
  as_user=(runuser -u sshapp-lab --)
fi

# Linux needs Chromium's sandbox helper owned by root with the setuid bit.
helper() {
  if [ "$(stat -c '%U:%a' "$1")" != "root:4755" ]; then
    if [ "$(id -u)" = 0 ]; then chown root:root "$1" && chmod 4755 "$1"; else sudo chown root:root "$1" && sudo chmod 4755 "$1"; fi
  fi
}

# start <seconds> <log> <env...> -- <program> <args...>   runs the app on a virtual screen; prints its exit code.
start() {
  local secs="$1" log="$2"; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  local code=0
  timeout "$secs" "${as_user[@]}" xvfb-run -a --server-args='-screen 0 1440x900x24' env -u NODE_OPTIONS "${envs[@]}" "$@" >"$log" 2>&1 || code=$?
  echo "$code"
}

# selftest <log> <program> <args...>   runs the self-test and prints its probes; fails unless all held.
selftest() {
  local log="$1"; shift
  local code line
  code="$(start 150 "$log" SSHAPP_SELFTEST=1 -- "$@")"
  line="$(grep -a '^SELFTEST ' "$log" | tail -1 || true)"
  if [ -z "$line" ]; then
    echo "smoke: the app gave no result (exit code $code)." >&2
    grep -a -A12 '^MAINFAULT' "$log" >&2 || tail -40 "$log" >&2
    return 1
  fi
  node -e '
    const r = JSON.parse(process.argv[1].slice(9));
    for (const x of r.results) console.log((x.ok ? "ok    " : "FAIL  ") + x.name + (x.ok ? "" : "   -> " + x.detail));
    const bad = r.results.filter((x) => !x.ok).length;
    console.log(bad ? `smoke: ${bad} of ${r.results.length} probes FAILED (${r.kind})` : `smoke: all ${r.results.length} probes held (${r.kind})`);
    process.exit(bad ? 1 : 0);
  ' "$line"
  [ "$code" = 0 ] || { echo "smoke: the app exited with code $code" >&2; return 1; }
}

say() { echo "ok    $*"; }
fail() { echo "FAIL  $*" >&2; exit 1; }
work="$(mktemp -d)"
chmod 755 "$work"
trap 'rm -rf "$work"' EXIT
log="$work/app.log"

case "$mode" in
  dev)
    electron=node_modules/electron/dist/electron
    [ -x "$electron" ] || { echo "smoke: Electron's binary is missing (run: node node_modules/electron/install.js)" >&2; exit 1; }
    [ -f dist/main.js ] || { echo "smoke: nothing built (run scripts/build.sh)" >&2; exit 1; }
    helper node_modules/electron/dist/chrome-sandbox
    selftest "$log" "$electron" .
    ;;

  lab)
    pkg=out/ssh-app-linux-x64-lab
    [ -x "$pkg/ssh-app" ] || { echo "smoke: no lab package (run: node scripts/package.mjs)" >&2; exit 1; }
    helper "$pkg/chrome-sandbox"
    selftest "$log" "$pkg/ssh-app" --lab
    grep -aq '^READY kind=lab$' "$log" || fail "the lab package did not say it is a lab build"

    # A swapped engine: the same package with one byte of its engine changed must refuse to start it.
    cp -a "$pkg" "$work/swapped"
    helper "$work/swapped/chrome-sandbox"
    printf '\x00' | dd of="$work/swapped/resources/engine/sshapp-engine" bs=1 seek=4096 conv=notrunc status=none
    start 150 "$log" SSHAPP_SELFTEST=1 -- "$work/swapped/ssh-app" --lab >/dev/null
    grep -a '^SELFTEST ' "$log" | grep -q 'the engine file is not the one this app was built with' \
      && say "a swapped engine is not started, and the tab says why" \
      || fail "a swapped engine was not refused"
    echo "smoke: the lab package held"
    ;;

  release)
    pkg=out/ssh-app-linux-x64-release
    [ -x "$pkg/ssh-app" ] || { echo "smoke: no release package (run: node scripts/package.mjs)" >&2; exit 1; }
    helper "$pkg/chrome-sandbox"

    # 1. Plain start: it comes up, says what it is, stays up, and the self-test switch does nothing.
    code="$(start 12 "$log" SSHAPP_SELFTEST=1 -- "$pkg/ssh-app")"
    [ "$code" = 124 ] || fail "the release package did not stay up for 12 s (exit $code)"
    grep -aq '^READY kind=release$' "$log" || fail "the release package did not come up as a release build"
    say "it starts and stays up as a release build"
    ! grep -aq '^SELFTEST ' "$log" || fail "the release package ran the self-test"
    say "the self-test switch does nothing in it"
    ! grep -aq '^MAINFAULT' "$log" || fail "the release package reported a fault"
    say "no fault in main"

    # 2. Any argument ends it at once: ours, Node's, Chromium's, and the lab's own word.
    for arg in --anything --inspect=0 --remote-debugging-port=9333 --lab "--lab --remote-debugging-port=9333" /tmp/some-file; do
      t0=$(date +%s%N)
      # shellcheck disable=SC2086
      code="$(start 20 "$log" SSHAPP_SELFTEST=1 -- "$pkg/ssh-app" $arg)"
      ms=$(( ($(date +%s%N) - t0) / 1000000 ))
      [ "$code" = 64 ] || fail "started with '$arg' it did not exit with 64 (exit $code)"
      ! grep -aq '^READY\|^SELFTEST\|Debugger listening\|DevTools listening' "$log" || fail "started with '$arg' it came up, or opened a debugger"
      say "exits on: $arg (${ms} ms, nothing listening)"
    done
    # 3. A release binary with the lab's marker file put beside it is still not a lab package: its fuse says so.
    cp -a "$pkg" "$work/marked"
    helper "$work/marked/chrome-sandbox"
    cp out/ssh-app-linux-x64-lab/resources/lab "$work/marked/resources/lab"
    code="$(start 20 "$log" SSHAPP_SELFTEST=1 -- "$work/marked/ssh-app" --lab)"
    [ "$code" = 64 ] || fail "a release binary with the lab marker beside it did not exit (exit $code)"
    ! grep -aq '^READY\|^SELFTEST' "$log" || fail "a release binary with the lab marker beside it came up"
    say "the lab marker beside a release binary changes nothing"
    echo "smoke: the release package held"
    ;;

  *)
    echo "usage: scripts/smoke.sh dev|lab|release" >&2
    exit 2
    ;;
esac
