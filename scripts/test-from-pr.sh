#!/usr/bin/env bash
# Tests scripts/from-pr.sh against a stand-in for gh that plays GitHub's answers. No network.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "test-from-pr: jq is needed" >&2; exit 1; }

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
# The stand-in: prints $FAKE_PULLS through the real jq, with the --jq filter the script passes.
cat > "$dir/gh" <<'STUB'
#!/usr/bin/env bash
filter=""
while [ $# -gt 0 ]; do case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac; done
[ "${FAKE_FAIL:-}" = 1 ] && { echo "gh: HTTP 500" >&2; exit 1; }
printf '%s' "$FAKE_PULLS" | jq -r "$filter"
STUB
chmod +x "$dir/gh"

sha=1111111111111111111111111111111111111111
run() { PATH="$dir:$PATH" REPO=o/r SHA=$sha FAKE_PULLS="$1" FAKE_FAIL="${2:-}" bash scripts/from-pr.sh >/dev/null 2>&1; }
expect() { local want="$1" name="$2"; shift 2; local got=0; run "$@" || got=$?; [ "$got" = "$want" ] || { echo "test-from-pr: FAIL: $name (exit $got, want $want)"; exit 1; }; }

expect 0 "the merge commit of a merged pull request"       "[{\"merged_at\":\"2026-01-01T00:00:00Z\",\"merge_commit_sha\":\"$sha\",\"base\":{\"ref\":\"main\"}}]"
expect 1 "no pull request at all (a direct push)"           "[]"
expect 1 "a pull request that is still open"                "[{\"merged_at\":null,\"merge_commit_sha\":\"$sha\",\"base\":{\"ref\":\"main\"}}]"
expect 1 "a commit that was only part of a pull request"    "[{\"merged_at\":\"2026-01-01T00:00:00Z\",\"merge_commit_sha\":\"2222222222222222222222222222222222222222\",\"base\":{\"ref\":\"main\"}}]"
expect 1 "a pull request merged into another branch"        "[{\"merged_at\":\"2026-01-01T00:00:00Z\",\"merge_commit_sha\":\"$sha\",\"base\":{\"ref\":\"work/x\"}}]"
expect 1 "GitHub does not answer"                           "[]" 1
echo "test-from-pr: 6 cases held"
