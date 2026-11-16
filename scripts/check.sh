#!/usr/bin/env bash
# Every check that needs no window: the dependency gate, types, the no-blocking-calls rule, Go format, vet (for
# Linux and for Windows), tests, a short fuzz run, and the TypeScript tests. The same script runs in the workspace and in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

echo "check: the dependency gate"
node scripts/test-gate.mjs
node scripts/gate.mjs
npm audit --audit-level=low >/dev/null || { npm audit; exit 1; }
echo "npm audit: no advisory"
if [ "${CI:-}" = "true" ]; then
  npm audit signatures | tail -3
else
  echo "npm audit signatures: runs in CI only (its key store cannot be reached from this workspace)"
fi

echo "check: types"
node_modules/.bin/tsc -p .

echo "check: no blocking calls in the app's code"
node scripts/no-sync.mjs

echo "check: Go format, vet, tests"
unformatted="$(cd engine && gofmt -l cmd internal)"
[ -z "$unformatted" ] || { echo "not gofmt-formatted: $unformatted" >&2; exit 1; }
(cd engine && go vet ./... && GOOS=windows go vet ./... && go test -count=1 ./...)

echo "check: lab tools are in no program that ships"
shipped="$(cd engine && go list -deps ./cmd/... && GOOS=windows go list -deps ./cmd/...)"
! grep -q 'internal/lab' <<<"$shipped" || { echo "a shipped program imports a lab package" >&2; exit 1; }

echo "check: a short fuzz run on the frame reader"
(cd engine && go test -run '^$' -fuzz '^FuzzRead$' -fuzztime 5s ./internal/frame | tail -2)

echo "check: a short fuzz run on opening the locked list"
(cd engine && go test -run '^$' -fuzz '^FuzzOpen$' -fuzztime 5s ./internal/vault | tail -2)

echo "check: a short fuzz run on what a key may be asked to sign"
(cd engine && go test -run '^$' -fuzz '^FuzzSign$' -fuzztime 5s ./internal/keys | tail -2)

echo "check: TypeScript tests"
rm -rf .build/tests && mkdir -p .build/tests
for t in tests/*.test.ts; do
  node_modules/.bin/esbuild "$t" --bundle --platform=node --format=esm --log-level=warning --outfile=".build/tests/$(basename "${t%.ts}").mjs"
done
node --test .build/tests/*.mjs | grep -E '^(not ok|# (tests|pass|fail))'

echo "check: the rule that a commit on main must come from a pull request"
bash scripts/test-from-pr.sh

echo "check: all passed"
