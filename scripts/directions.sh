#!/usr/bin/env bash
# The direction pictures: Berth's main window in use, in each direction, from the real app (the Linux lab
# package). Two pictures a direction: 1280x720 at 125 % with a dialog open, and 1920x1080 at 100 % with the
# path bar's pinned and recent folders open. Each names itself in its strip. Pictures land in out/directions/.
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
declare -A NAME=([a]="A  Chart" [b]="B  Lamp" [c]="C  Drydock")

shoot() {
  local d="$1" size="$2" scale="$3" scene="$4"
  local percent; percent="$(awk "BEGIN { printf \"%d\", $scale * 100 }")"
  local file="$dir/berth-${d}-dark-${size}-${percent}-${scene}.png"
  local strip="Berth, direction ${NAME[$d]}   |   dark   |   window ${size} at ${percent} %   |   ${scene/paths/pinned and recent folders open}   |   commit ${commit}"
  strip="${strip/dialog/a dialog open}"
  local log; log="$(mktemp)"; rm -f "$file"
  timeout 90 "${as_user[@]}" xvfb-run -a --server-args='-screen 0 3000x1800x24' env -u NODE_OPTIONS \
    SSHAPP_SELFTEST=direction SSHAPP_DIRECTION="$d" SSHAPP_SCENE="$scene" SSHAPP_WINDOW="$size" SSHAPP_PICTURE="$file" SSHAPP_PICTURE_STRIP="$strip" \
    "$pkg/ssh-app" --lab "--force-device-scale-factor=$scale" >"$log" 2>&1 || true
  if [ -s "$file" ] && grep -aq '^SELFTEST .*"ok":true' "$log"; then echo "ok    $(basename "$file")"; else
    echo "FAIL  $(basename "$file")" >&2; grep -a '^SELFTEST \|^MAINFAULT' "$log" >&2 || tail -15 "$log" >&2; exit 1; fi
}

for d in ${1:-a b c}; do
  shoot "$d" 1280x720 1.25 dialog
  shoot "$d" 1920x1080 1 paths
done
