#!/usr/bin/env bash
# Puts the pinned Go toolchain in .tools/go. Does nothing if it is already there at the pinned version.
# The download is refused unless its SHA-256 is the one written in toolchain/go.env.
# Linux x86_64, and Windows x86_64 under Git Bash (the Windows job in CI).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source toolchain/go.env

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)            url="$GO_LINUX_X64_URL"; sum="$GO_LINUX_X64_SHA256"; go=go;     kind=tgz ;;
  MINGW*-x86_64|MSYS*-x86_64) url="$GO_WIN32_X64_URL"; sum="$GO_WIN32_X64_SHA256"; go=go.exe; kind=zip ;;
  *) echo "get-go: no pinned Go for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

if [ -x ".tools/go/bin/$go" ] && [ "$(cat .tools/go/.pinned 2>/dev/null)" = "$sum" ]; then
  echo "get-go: Go $GO_VERSION already in place"
  exit 0
fi

mkdir -p .tools
tmp="$(mktemp -d .tools/go-download.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/go.pkg" "$url"
echo "$sum  $tmp/go.pkg" | sha256sum -c - >/dev/null || { echo "get-go: the download does not match the pinned hash" >&2; exit 1; }
mkdir "$tmp/go"
if [ "$kind" = tgz ]; then tar -xzf "$tmp/go.pkg" -C "$tmp/go"; else unzip -q "$tmp/go.pkg" -d "$tmp/go"; fi
got="$("$tmp/go/bin/$go" env GOVERSION)"
[ "$got" = "go$GO_VERSION" ] || { echo "get-go: expected go$GO_VERSION, the archive holds $got" >&2; exit 1; }
if [ -e .tools/go ]; then mv .tools/go "$tmp/old"; fi
mv "$tmp/go" .tools/go
echo "$sum" > .tools/go/.pinned
echo "get-go: Go $GO_VERSION in place"
