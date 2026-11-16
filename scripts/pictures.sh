#!/usr/bin/env bash
# Takes pictures of the whole window from the real app (the Linux lab package), at the agreed window sizes and
# Windows scalings: 1280x720 and 1920x1080, at 100 %, 125 % and 150 %. Each picture names itself in a strip.
# Needs: scripts/build.sh and node scripts/package.mjs. Pictures land in out/pictures/.
#
#   scripts/pictures.sh            all six
#   scripts/pictures.sh 1280x720 1 one size, one scaling
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

pkg=out/Berth-linux-x64-lab
[ -x "$pkg/Berth" ] || { echo "pictures: no lab package (run: node scripts/package.mjs)" >&2; exit 1; }
if [ "$(stat -c '%U:%a' "$pkg/chrome-sandbox")" != "root:4755" ]; then
  if [ "$(id -u)" = 0 ]; then chown root:root "$pkg/chrome-sandbox" && chmod 4755 "$pkg/chrome-sandbox"; else sudo chown root:root "$pkg/chrome-sandbox" && sudo chmod 4755 "$pkg/chrome-sandbox"; fi
fi
as_user=()
if [ "$(id -u)" = 0 ]; then
  id sshapp-lab >/dev/null 2>&1 || useradd -m -s /bin/bash sshapp-lab
  as_user=(runuser -u sshapp-lab --)
fi

dir="$(pwd)/out/pictures"
mkdir -p "$dir" && chmod 777 "$dir"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo uncommitted)"

shoot() {
  local size="$1" scale="$2"
  local percent; percent="$(awk "BEGIN { printf \"%d\", $scale * 100 }")"
  local file="$dir/skeleton-dark-${size}-${percent}.png"
  local strip="Skeleton (scaffolding, not a design)  |  dark  |  window ${size} at ${percent} %  |  commit ${commit}"
  local log; log="$(mktemp)"
  rm -f "$file"
  timeout 90 "${as_user[@]}" xvfb-run -a --server-args='-screen 0 3000x1800x24' env -u NODE_OPTIONS \
    SSHAPP_SELFTEST=picture SSHAPP_WINDOW="$size" SSHAPP_PICTURE="$file" SSHAPP_PICTURE_STRIP="$strip" \
    "$pkg/Berth" --lab "--force-device-scale-factor=$scale" >"$log" 2>&1 || true
  if [ -s "$file" ] && grep -aq '^SELFTEST .*"ok":true' "$log"; then
    echo "ok    $(basename "$file")  $(grep -a '^SELFTEST ' "$log" | sed -E 's/.*a picture of the whole window: ([^"]+)".*/\1/')"
  else
    echo "FAIL  $(basename "$file")" >&2
    grep -a '^SELFTEST \|^MAINFAULT' "$log" >&2 || tail -15 "$log" >&2
    exit 1
  fi
}

if [ $# -eq 2 ]; then shoot "$1" "$2"; else
  for size in 1280x720 1920x1080; do for scale in 1 1.25 1.5; do shoot "$size" "$scale"; done; done
fi
echo "pictures: in out/pictures/"
