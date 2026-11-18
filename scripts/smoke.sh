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
# The stated multiplier for budgets on test machines: the last line of toolchain/test-machine-factor.
factor="$(grep -v '^#' toolchain/test-machine-factor | tail -1)"

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
  # The app's whole network stack is pointed at the canary: whatever it tries to reach by itself is written down.
  # The lab's stand-in for a box: the self-test starts it and connects to it as to any box.
  local labbox=(SSHAPP_LABBOX="$(pwd)/.build/labbox/labbox")
  local net=(http_proxy="$canary" https_proxy="$canary" HTTP_PROXY="$canary" HTTPS_PROXY="$canary" ALL_PROXY="$canary" all_proxy="$canary" no_proxy= NO_PROXY=)
  timeout "$secs" "${as_user[@]}" xvfb-run -a --server-args="-screen 0 ${selftest_screen:-1440x900}x24" env -u NODE_OPTIONS "${net[@]}" "${labbox[@]}" "${envs[@]}" "$@" >"$log" 2>&1 || code=$?
  echo "$code"
}

# selftest <log> <program> <args...>   runs the self-test and prints its probes; fails unless all held.
selftest() {
  local log="$1"; shift
  local code line
  local prof=()
  [ -n "${selftest_profile:-}" ] && prof=(SSHAPP_PROFILE="$selftest_profile")
  [ -n "${selftest_window:-}" ] && prof+=(SSHAPP_WINDOW="$selftest_window")
  [ -n "${selftest_pictures:-}" ] && prof+=(SSHAPP_PICTURES="$selftest_pictures" SSHAPP_PICTURE_COMMIT=smoke)
  # How long one run of the self-test may take before it is cut off from outside. It is the app's own ceiling
  # (five minutes times the machine factor) with a minute on top, so the app always reaches its own limit first
  # and says which probe it was on: a run cut off from out here says nothing at all about why.
  code="$(start "$(( 360 * factor ))" "$log" SSHAPP_SELFTEST="${selftest_mode:-all}" SSHAPP_BUDGET_FACTOR="$factor" "${prof[@]}" -- "$@")"
  line="$(grep -a '^SELFTEST ' "$log" | tail -1 || true)"
  if [ -z "$line" ]; then
    echo "smoke: the app gave no result (exit code $code)." >&2
    grep -a -A12 '^MAINFAULT' "$log" >&2 || tail -40 "$log" >&2
    return 1
  fi
  # The result line is given to node on its standard input, never as an argument: a probe that says a lot
  # about why it failed would otherwise be a result line too long for the system to pass as one, and the run
  # would end with "argument list too long" instead of with the probe that failed.
  printf '%s' "$line" | node -e '
    const r = JSON.parse(require("node:fs").readFileSync(0, "utf8").slice(9));
    for (const x of r.results) console.log((x.ok ? "ok    " : "FAIL  ") + x.name + (x.ok ? "" : "   -> " + x.detail));
    const bad = r.results.filter((x) => !x.ok).length;
    console.log(bad ? `smoke: ${bad} of ${r.results.length} probes FAILED (${r.kind})` : `smoke: all ${r.results.length} probes held (${r.kind})`);
    process.exit(bad ? 1 : 0);
  '
  [ "$code" = 0 ] || { echo "smoke: the app exited with code $code" >&2; return 1; }
}

say() { echo "ok    $*"; }
fail() { echo "FAIL  $*" >&2; exit 1; }
work="$(mktemp -d)"
chmod 755 "$work"
log="$work/app.log"

# The network canary (scripts/lib/net-canary.mjs): it runs for the whole smoke run and must stay silent.
canary_log="$work/net-canary.log"
coproc CANARY { exec node scripts/lib/net-canary.mjs "$canary_log"; }
read -r canary_port <&"${CANARY[0]}"
[[ "$canary_port" =~ ^[0-9]+$ ]] || { echo "smoke: the network canary did not start" >&2; exit 1; }
canary="http://127.0.0.1:$canary_port"
trap 'kill "$CANARY_PID" 2>/dev/null; rm -rf "$work"' EXIT
# canary_hears: runs a program of its own, behind the same proxy, and fails unless the listener wrote it down.
# Without this, a listener that hears nothing because it is broken looks exactly like one that hears nothing
# because the app is quiet, which is the whole claim being made here.
canary_hears() {
  local code
  code="$(start 60 "$log" -- "$1" scripts/lib/net-control)"
  grep -aq '^NET-CONTROL answered' "$log" || { echo "FAIL  the control program could not reach the listener through the proxy (exit $code):" >&2; grep -a '^NET-CONTROL' "$log" >&2 || tail -5 "$log" >&2; exit 1; }
  grep -q 'the-canary-must-hear-this' "$canary_log" || { echo "FAIL  the control program reached out and the listener wrote nothing down" >&2; exit 1; }
  say "the listener hears: a program behind the same proxy reached out and landed in it"
  : >"$canary_log" # the app's own run starts from silence
}

# quiet_network: fails if the app tried to reach anything by itself since the smoke run began.
quiet_network() {
  if [ -s "$canary_log" ]; then
    echo "FAIL  the app tried to reach the network by itself:" >&2
    sort -k2 "$canary_log" | cut -d' ' -f2- | sort | uniq -c | head -10 >&2
    exit 1
  fi
  say "the app made no network connection of its own"
}

case "$mode" in
  dev)
    electron=node_modules/electron/dist/electron
    [ -x "$electron" ] || { echo "smoke: Electron's binary is missing (run: node node_modules/electron/install.js)" >&2; exit 1; }
    [ -f dist/main.js ] || { echo "smoke: nothing built (run scripts/build.sh)" >&2; exit 1; }
    helper node_modules/electron/dist/chrome-sandbox
    selftest "$log" "$electron" .
    # The box screens, by real clicks and keys, against the lab's SSH server. Each screen is pictured on the
    # way, so the picture tool itself is run and checked (a picture must show the tab through the shell).
    # The pictures of each screen. They go with the run unless a folder is named, which is how they are looked
    # at: the run's own folder is removed when it ends.
    shots="${SSHAPP_PICTURES:-$work/pictures}"
    mkdir -p "$shots" && chmod 777 "$shots"
    selftest_mode=boxes-ui selftest_pictures="$shots" selftest "$log" "$electron" .
    # Before requiring silence, the listener is proven able to hear: a program of its own, behind the same
    # proxy, reaches out once and must land in its log. A listener that is broken is silent too, and Berth's
    # own code has no such call anywhere (check.sh fails the build if the app ever sets a proxy of its own).
    canary_hears "$electron"
    quiet_network
    ;;

  lab)
    pkg=out/Berth-linux-x64-lab
    [ -x "$pkg/Berth" ] || { echo "smoke: no lab package (run: node scripts/package.mjs)" >&2; exit 1; }
    helper "$pkg/chrome-sandbox"
    selftest "$log" "$pkg/Berth" --lab
    grep -aq '^READY kind=lab ' "$log" || fail "the lab package did not say it is a lab build"

    # A swapped engine: the same package with one byte of its engine changed must refuse to start it.
    cp -a "$pkg" "$work/swapped"
    helper "$work/swapped/chrome-sandbox"
    printf '\x00' | dd of="$work/swapped/resources/engine/sshapp-engine" bs=1 seek=4096 conv=notrunc status=none
    code="$(start 60 "$log" SSHAPP_SELFTEST=engine-must-be-refused -- "$work/swapped/Berth" --lab)"
    [ "$code" = 0 ] && grep -a '^SELFTEST ' "$log" | grep -q '"ok":true' \
      && say "a swapped engine is not started, and the tab says why" \
      || { grep -a '^SELFTEST ' "$log" >&2 || tail -20 "$log" >&2; fail "a swapped engine was not refused (exit $code)"; }
    # Seven tabs at once.
    selftest_mode=seven selftest "$log" "$pkg/Berth" --lab
    # The box screens, by real clicks and keys.
    selftest_mode=boxes-ui selftest "$log" "$pkg/Berth" --lab
    # The same seven in the narrowest window the app allows, on a small screen (GitHub's Windows machine has
    # 1024 x 768; a 1280-wide window at 125 % scaling is 1024 wide too): every tab must still be there to press.
    selftest_mode=seven selftest_window=800x500 selftest_screen=1024x768 selftest "$log" "$pkg/Berth" --lab

    # The lock across two starts on one profile: the first start makes the password, the second must ask for it.
    prof="$work/two-starts"; mkdir -p "$prof"; chmod 777 "$prof"
    code="$(start 150 "$log" SSHAPP_SELFTEST=all SSHAPP_BUDGET_FACTOR="$factor" SSHAPP_PROFILE="$prof" -- "$pkg/Berth" --lab)"
    [ "$code" = 0 ] || { grep -a '^SELFTEST ' "$log" >&2 || tail -20 "$log" >&2; fail "the first start on a kept profile failed (exit $code)"; }
    selftest_mode=gate-unlock selftest_profile="$prof" selftest "$log" "$pkg/Berth" --lab
    # And from outside the app: nothing in that profile holds the lab's password.
    ! grep -rqa 'berth-lab-canary' "$prof" || fail "a file in the profile holds the password: $(grep -rla 'berth-lab-canary' "$prof" | head -3)"
    [ -s "$prof/profile/list.berth" ] && [ -s "$prof/backups/Berth list backup.berth" ] || fail "the list or its backup is missing after two starts"
    say "nothing in the profile holds the password; the list and its backup are there"

    # A list that cannot be read, and the way back from it. One byte of the sealed contents is changed here,
    # from outside the app, as a half-written file or a failing disk would: the seal then refuses it, and the
    # copy saved beside it is what opens.
    [ -s "$prof/profile/list.berth.previous" ] || fail "no copy was saved beside the list, so there is nothing to restore from"
    mkdir -p "$work/pictures" && chmod 777 "$work/pictures"
    # The byte is changed, not set: writing 0xff over a byte that was already 0xff changes nothing, the list
    # opens as it always did, and the probe fails for a reason that is nobody's fault and happens about once
    # in every 256 runs. (It did, on 2026-11-18, and passed on a re-run of the very same commit.)
    was=$(dd if="$prof/profile/list.berth" bs=1 skip=200 count=1 status=none | od -An -tu1 | tr -d ' ')
    now=$(( (was + 1) % 256 ))
    printf "$(printf '\\x%02x' "$now")" | dd of="$prof/profile/list.berth" bs=1 seek=200 conv=notrunc status=none
    [ "$(dd if="$prof/profile/list.berth" bs=1 skip=200 count=1 status=none | od -An -tu1 | tr -d ' ')" != "$was" ] || fail "the list was not damaged, so the way back from a damaged list would not be tried"
    selftest_mode=gate-restore selftest_profile="$prof" selftest_pictures="$work/pictures" selftest "$log" "$pkg/Berth" --lab

    # Children end with their parent: main is ended by force, and its engines must be gone within five seconds.
    ( start 60 "$log" SSHAPP_SELFTEST=hold -- "$pkg/Berth" --lab >/dev/null ) &
    holder=$!
    held=""
    for _ in $(seq 1 150); do held="$(grep -a '^HOLD ' "$log" 2>/dev/null | tail -1 || true)"; [ -n "$held" ] && break; sleep 0.2; done
    [[ "$held" == *"ok=true"* ]] || { tail -20 "$log" >&2; fail "the app did not come up with two engines"; }
    main_pid="$(sed -E 's/.* main=([0-9]+).*/\1/' <<<"$held")"
    engine_pids="$(sed -E 's/.* engines=([0-9,]+).*/\1/' <<<"$held" | tr ',' ' ')"
    # shellcheck disable=SC2086
    for p in $main_pid $engine_pids; do kill -0 "$p" 2>/dev/null || fail "process $p was not running before the test"; done
    kill -9 "$main_pid"
    gone=no
    for _ in $(seq 1 25); do
      gone=yes
      # shellcheck disable=SC2086
      for p in $engine_pids; do kill -0 "$p" 2>/dev/null && gone=no; done
      [ "$gone" = yes ] && break
      sleep 0.2
    done
    wait "$holder" || true # that one only: the network canary is a child too, and runs until the end
    [ "$gone" = yes ] && say "main ended by force: its engines and its key process ended with it" || fail "engines or the key process outlived main"
    quiet_network
    echo "smoke: the lab package held"
    ;;

  release)
    pkg=out/Berth-linux-x64-release
    [ -x "$pkg/Berth" ] || { echo "smoke: no release package (run: node scripts/package.mjs)" >&2; exit 1; }
    helper "$pkg/chrome-sandbox"

    # 1. Plain start: it comes up, says what it is, stays up, and the self-test switch does nothing.
    code="$(start 12 "$log" SSHAPP_SELFTEST=all -- "$pkg/Berth")"
    [ "$code" = 124 ] || fail "the release package did not stay up for 12 s (exit $code)"
    grep -aq '^READY kind=release ' "$log" || fail "the release package did not come up as a release build"
    say "it starts and stays up as a release build"
    ! grep -aq '^SELFTEST ' "$log" || fail "the release package ran the self-test"
    say "the self-test switch does nothing in it"
    ! grep -aq '^MAINFAULT' "$log" || fail "the release package reported a fault"
    say "no fault in main"
    grep -aq '^GATE \(create\|locked\)$' "$log" || fail "the release package did not come up at the lock: $(grep -a '^GATE' "$log" || echo 'no GATE line')"
    say "it comes up at the lock ($(grep -a '^GATE ' "$log" | head -1 | cut -d' ' -f2)), and nowhere else"

    # 2. Any argument ends it at once: ours, Node's, Chromium's, and the lab's own word.
    for arg in --anything --inspect=0 --remote-debugging-port=9333 --lab "--lab --remote-debugging-port=9333" /tmp/some-file; do
      t0=$(date +%s%N)
      # shellcheck disable=SC2086
      code="$(start 20 "$log" SSHAPP_SELFTEST=all -- "$pkg/Berth" $arg)"
      ms=$(( ($(date +%s%N) - t0) / 1000000 ))
      [ "$code" = 64 ] || fail "started with '$arg' it did not exit with 64 (exit $code)"
      ! grep -aq '^READY\|^SELFTEST\|Debugger listening\|DevTools listening' "$log" || fail "started with '$arg' it came up, or opened a debugger"
      # The refusal comes before Chromium starts anything: a refusal that waited showed here as Chromium's
      # launcher being asked for the graphics process while the app was already going down.
      ! grep -aq 'gpu-process' "$log" || fail "started with '$arg' Chromium had begun starting its processes before the refusal"
      say "exits on: $arg (${ms} ms, nothing listening)"
    done
    # 3. A release binary with the lab's marker file put beside it is still not a lab package: its fuse says so.
    cp -a "$pkg" "$work/marked"
    helper "$work/marked/chrome-sandbox"
    cp out/Berth-linux-x64-lab/resources/lab "$work/marked/resources/lab"
    code="$(start 20 "$log" SSHAPP_SELFTEST=all -- "$work/marked/Berth" --lab)"
    [ "$code" = 64 ] || fail "a release binary with the lab marker beside it did not exit (exit $code)"
    ! grep -aq '^READY\|^SELFTEST' "$log" || fail "a release binary with the lab marker beside it came up"
    ! grep -aq 'gpu-process' "$log" || fail "a release binary with the lab marker beside it had begun starting Chromium's processes before the refusal"
    say "the lab marker beside a release binary changes nothing"
    # 4. The control for the Windows run. There, Electron must refuse an app archive with one byte changed. Here
    #    on Linux Electron has no such check, so the same changed archives must start: that shows the change is
    #    harmless by itself, and that only the check can be what refuses it on Windows.
    for what in index file; do
      cp -a "$pkg" "$work/changed-$what"
      helper "$work/changed-$what/chrome-sandbox"
      node scripts/lib/change-archive.mjs "$work/changed-$what/resources/app.asar" "$what" >/dev/null
      code="$(start 8 "$log" -- "$work/changed-$what/Berth")"
      [ "$code" = 124 ] && grep -aq '^READY kind=release ' "$log" || fail "the control did not start with a changed archive ($what, exit $code)"
      say "control: an archive with one harmless byte changed ($what) still starts on Linux"
      rm -rf "$work/changed-$what"
    done
    quiet_network
    echo "smoke: the release package held"
    ;;

  *)
    echo "usage: scripts/smoke.sh dev|lab|release" >&2
    exit 2
    ;;
esac
