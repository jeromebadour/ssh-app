#!/usr/bin/env bash
# The direction pictures: Berth's main window in use, in each direction, from the real app (the Linux lab
# package). Three pictures: the Boxes menu open (1920x1080), a dialog open and the pinned and recent folders open
# (both 1280x720 at 125 %). Each names itself in its strip. Pictures land in out/directions/.
# With "step2": step 2's screens instead (the password, Add box, the first connection, a tab's link states).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

pkg=out/ssh-app-linux-x64-lab
[ -x "$pkg/ssh-app" ] || { echo "directions: no lab package (run: node scripts/package.mjs)" >&2; exit 1; }
if [ "$(stat -c '%U:%a' "$pkg/chrome-sandbox")" != "root:4755" ]; then chown root:root "$pkg/chrome-sandbox" && chmod 4755 "$pkg/chrome-sandbox"; fi
as_user=()
if [ "$(id -u)" = 0 ]; then id sshapp-lab >/dev/null 2>&1 || useradd -m -s /bin/bash sshapp-lab; as_user=(runuser -u sshapp-lab --); fi
dir="$(pwd)/out/directions"; mkdir -p "$dir" && chmod 777 "$dir"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo uncommitted)"
declare -A NAME=([a]="A  Chart, calm")

shoot() {
  local d="$1" size="$2" scale="$3" scene="$4"
  local percent; percent="$(awk "BEGIN { printf \"%d\", $scale * 100 }")"
  local file="$dir/berth-${d}-dark-${size}-${percent}-${scene}.png"
  local strip="Berth, direction ${NAME[$d]}   |   dark   |   window ${size} at ${percent} %   |   ${scene/paths/pinned and recent folders open}   |   commit ${commit}"
  strip="${strip/dialog/a dialog open}"; strip="${strip/boxes/the Boxes menu open}"; strip="${strip/logs/a log streaming, word colouring on}"
  case "$scene" in
    create) strip="${strip/create/first start: make the password}" ;;
    unlock) strip="${strip/unlock/every start: unlock}" ;;
    wrong) strip="${strip/wrong/unlock: a wrong password}" ;;
    addbox) strip="${strip/addbox/Add box}" ;;
    trust) strip="${strip/trust/the first connection: checking the box}" ;;
    changed) strip="${strip/changed/a box whose identity changed}" ;;
    connecting) strip="${strip/connecting/a new tab opening}" ;;
    fresh) strip="${strip/fresh/a new tab just opened, the sign-in text folded}" ;;
    noanswer) strip="${strip/noanswer/no answer: the link kept}" ;;
    dropped) strip="${strip/dropped/the link gone: reconnecting}" ;;
    mismatch) strip="${strip/mismatch/the first-connection check: another box answered}" ;;
    unreachable) strip="${strip/unreachable/the first-connection check: the box cannot be reached}" ;;
    sevenopen) strip="${strip/sevenopen/seven tabs in a small window, the four on relay-fra opened}" ;;
    seven) strip="${strip/seven/seven tabs in a small window, a box with several folded into one}" ;;
  esac
  local log; log="$(mktemp)"; rm -f "$file"
  timeout 90 "${as_user[@]}" xvfb-run -a --server-args='-screen 0 3000x1800x24' env -u NODE_OPTIONS \
    SSHAPP_SELFTEST=direction SSHAPP_DIRECTION="$d" SSHAPP_SCENE="$scene" SSHAPP_WINDOW="$size" SSHAPP_PICTURE="$file" SSHAPP_PICTURE_STRIP="$strip" \
    "$pkg/ssh-app" --lab "--force-device-scale-factor=$scale" >"$log" 2>&1 || true
  if [ -s "$file" ] && grep -aq '^SELFTEST .*"ok":true' "$log"; then echo "ok    $(basename "$file")"; else
    echo "FAIL  $(basename "$file")" >&2; grep -a '^SELFTEST \|^MAINFAULT' "$log" >&2 || tail -15 "$log" >&2; exit 1; fi
}

if [ "${1:-}" = step2 ]; then
  # Step 2's screens, for a yes or no (2026-11-16).
  for scene in addbox trust changed connecting fresh noanswer dropped; do
    shoot a 1280x720 1.25 "$scene"
  done
  exit 0
fi
if [ "${1:-}" = boxes ]; then
  # The screens step 2 had not pictured: for a yes or no (2026-11-16).
  for scene in mismatch unreachable seven sevenopen; do shoot a 1280x720 1.25 "$scene"; done
  exit 0
fi
shoot a 1920x1080 1 boxes
shoot a 1280x720 1.25 dialog
shoot a 1280x720 1.25 paths
shoot a 1920x1080 1 logs
