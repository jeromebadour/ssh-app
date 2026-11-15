# Sourced by the other scripts: the pinned Go first on PATH, and nothing fetched behind our back.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/.tools/go/bin:$PATH"
export GOTOOLCHAIN=local   # never download another Go
export GOPROXY=off         # never fetch a module: what builds is what is in the repo
export GOFLAGS=-mod=vendor # modules come from engine/vendor only (made and checked by scripts/vendor.sh in CI)
export CGO_ENABLED=0
unset NODE_OPTIONS
