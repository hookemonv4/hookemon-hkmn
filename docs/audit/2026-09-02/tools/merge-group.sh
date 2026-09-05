#!/bin/zsh
# Usage: merge-group.sh <integration-worktree> <branch>...  (merges serially with --no-ff; auto-resolves docs/modules/index.json)
set -u
ROOT=$1; shift
S=<scratch>
export PATH=<node24-bin>:$PATH
for b in "$@"; do
  echo "=== merging $b"
  if git -C "$ROOT" merge --no-ff --no-edit "$b" >/dev/null 2>&1; then
    echo "merged clean: $(git -C "$ROOT" rev-parse --short HEAD)"
    continue
  fi
  conflicts=$(git -C "$ROOT" diff --name-only --diff-filter=U)
  echo "conflicts: $conflicts"
  others=$(echo "$conflicts" | grep -v '^docs/modules/index.json$' || true)
  if [ -z "$others" ]; then
    node $S/sync-module-index.mjs "$ROOT" && git -C "$ROOT" add docs/modules/index.json && git -C "$ROOT" -c core.editor=true commit --no-edit >/dev/null && echo "merged with index resync: $(git -C "$ROOT" rev-parse --short HEAD)"
  else
    echo "MANUAL RESOLUTION REQUIRED for $b"; git -C "$ROOT" merge --abort; echo "aborted $b"
  fi
done
