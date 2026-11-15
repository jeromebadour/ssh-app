#!/usr/bin/env bash
# Every check that needs no window: types, the no-blocking-calls rule, Go format, vet, tests, a short fuzz run,
# and the TypeScript tests. The same script runs in the workspace and in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

echo "check: types"
node_modules/.bin/tsc -p .

echo "check: no blocking calls in the app's code"
node scripts/no-sync.mjs

echo "check: Go format, vet, tests"
unformatted="$(cd engine && gofmt -l .)"
[ -z "$unformatted" ] || { echo "not gofmt-formatted: $unformatted" >&2; exit 1; }
(cd engine && go vet ./... && go test -count=1 ./...)

echo "check: a short fuzz run on the frame reader"
(cd engine && go test -run '^$' -fuzz '^FuzzRead$' -fuzztime 5s ./internal/frame | tail -2)

echo "check: TypeScript tests"
rm -rf .build/tests && mkdir -p .build/tests
for t in tests/*.test.ts; do
  node_modules/.bin/esbuild "$t" --bundle --platform=node --format=esm --log-level=warning --outfile=".build/tests/$(basename "${t%.ts}").mjs"
done
node --test .build/tests/*.mjs | grep -E '^(not ok|# (tests|pass|fail))'

echo "check: the rule that a commit on main must come from a pull request"
bash scripts/test-from-pr.sh

echo "check: all passed"
