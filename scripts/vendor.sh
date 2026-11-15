#!/usr/bin/env bash
# engine/vendor: the Go modules the engine is built from, kept in the repo so that every build uses only what
# is here (plan B2.1). This script is the only thing that fetches them, and only CI runs it: from Go's module
# proxy, every module checked against Go's public checksum log. Checksum verification is never switched off.
#
#   vendor.sh make    writes engine/go.sum and engine/vendor (the Vendor workflow then commits them)
#   vendor.sh check   throws both away, fetches again, and fails if the result differs from what is committed
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
export GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOFLAGS=-mod=mod
unset GONOSUMDB GONOSUMCHECK GONOPROXY GOPRIVATE GOINSECURE GONOSUMDB

mode="${1:-}"
case "$mode" in
  make) ;;
  check) rm -rf engine/go.sum engine/vendor ;;
  *) echo "usage: vendor.sh make|check" >&2; exit 2 ;;
esac

(cd engine && go mod tidy && go mod vendor && go mod verify)

if [ "$mode" = check ]; then
  changed="$(git status --porcelain --ignored -- engine)"
  if [ -n "$changed" ]; then
    echo "vendor: what is committed is not what Go's proxy and checksum log give:" >&2
    echo "$changed" >&2
    git diff --stat -- engine >&2 || true
    exit 1
  fi
  echo "vendor: engine/go.sum and engine/vendor are exactly what a fresh, checked fetch gives ($(grep -c '^# ' engine/vendor/modules.txt) modules)"
fi
