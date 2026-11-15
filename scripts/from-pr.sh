#!/usr/bin/env bash
# Says whether a commit on main is the merge of a pull request. Exit 0 if it is, 1 if it is not.
# Why it exists: GitHub offers no ruleset for a private repo on the free plan, so nothing there blocks a direct
# push to main. This makes such a push loud instead: CI on main fails, and nothing is built or released from it.
# Needs: gh, GH_TOKEN, REPO (owner/name), SHA.
set -euo pipefail
: "${REPO:?}" "${SHA:?}"

merged="$(gh api "repos/$REPO/commits/$SHA/pulls" \
  --jq "[.[] | select(.merged_at != null and .merge_commit_sha == \"$SHA\" and .base.ref == \"main\")] | length")"

if [[ "$merged" =~ ^[0-9]+$ ]] && [ "$merged" -ge 1 ]; then
  echo "from-pr: commit $SHA is the merge of a pull request."
  exit 0
fi
echo "::error::Commit $SHA reached main without a merged pull request. Nothing may be built or released from it."
exit 1
