#!/usr/bin/env bash
# Puts the pinned Go toolchain in .tools/go. Does nothing if it is already there at the pinned version.
# The download is refused unless its SHA-256 is the one written in toolchain/go.env.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source toolchain/go.env

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "get-go: only Linux x86_64 is pinned so far" >&2
  exit 1
fi
if [ -x .tools/go/bin/go ] && [ "$(cat .tools/go/.pinned 2>/dev/null)" = "$GO_LINUX_X64_SHA256" ]; then
  echo "get-go: Go $GO_VERSION already in place"
  exit 0
fi

mkdir -p .tools
tmp="$(mktemp -d .tools/go-download.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/go.tgz" "$GO_LINUX_X64_URL"
echo "$GO_LINUX_X64_SHA256  $tmp/go.tgz" | sha256sum -c - >/dev/null || { echo "get-go: the download does not match the pinned hash" >&2; exit 1; }
mkdir "$tmp/go"
tar -xzf "$tmp/go.tgz" -C "$tmp/go"
got="$("$tmp/go/bin/go" env GOVERSION)"
[ "$got" = "go$GO_VERSION" ] || { echo "get-go: expected go$GO_VERSION, the archive holds $got" >&2; exit 1; }
if [ -e .tools/go ]; then mv .tools/go "$tmp/old"; fi
mv "$tmp/go" .tools/go
echo "$GO_LINUX_X64_SHA256" > .tools/go/.pinned
echo "get-go: Go $GO_VERSION in place"
