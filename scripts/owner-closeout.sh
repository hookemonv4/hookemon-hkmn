#!/usr/bin/env bash
# Phase 3 owner closeout. The owner runs this once from the main checkout that owns the ledger.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'EOF'
Usage: bash scripts/owner-closeout.sh [--confirm]

Without --confirm, print the approval and gate summary without changing files.
With --confirm, materialize the current formal owner approvals, refresh each v4 gate in order,
and stop at the first gate that does not pass.
EOF
}

if [ "$#" -eq 0 ]; then
  MODE="dry-run"
elif [ "$#" -eq 1 ] && [ "$1" = "--confirm" ]; then
  MODE="confirm"
elif [ "$#" -eq 1 ] && [ "$1" = "--help" ]; then
  usage
  exit 0
else
  usage >&2
  exit 2
fi

NODE_BIN="${HOOKEMON_NODE_BIN:-node}"
if [ "$($NODE_BIN --version 2>/dev/null || true)" != "v24.19.0" ]; then
  echo "[owner-closeout] Node v24.19.0 is required; found $($NODE_BIN --version 2>/dev/null || echo none)." >&2
  exit 1
fi

if ! TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "[owner-closeout] this directory is not a Git checkout." >&2
  exit 1
fi
if [ "$TOPLEVEL" != "$REPO_ROOT" ]; then
  echo "[owner-closeout] script root does not match the Git checkout root." >&2
  exit 1
fi

GIT_DIR="$(git rev-parse --absolute-git-dir)"
GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$GIT_COMMON_DIR" ]; then
  GIT_COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
fi
case "$REPO_ROOT" in
  */.worktrees/*)
    echo "[owner-closeout] refusing to run from a worktree: $REPO_ROOT." >&2
    exit 1
    ;;
esac
if [ "$GIT_DIR" != "$GIT_COMMON_DIR" ]; then
  echo "[owner-closeout] refusing to run from a linked worktree; use the main checkout that owns .v4/ledger.db." >&2
  exit 1
fi
if [ ! -f .v4/ledger.db ]; then
  echo "[owner-closeout] .v4/ledger.db is missing; run from the main checkout that owns the ledger." >&2
  exit 1
fi
if [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then
  echo "[owner-closeout] refusing a dirty checkout; commit or discard unrelated changes before closeout." >&2
  exit 1
fi

echo "[owner-closeout] ${MODE} summary for $REPO_ROOT"
"$NODE_BIN" scripts/lib/owner-closeout.mjs summary
if [ "$MODE" = "dry-run" ]; then
  echo "--- release readiness snapshot ---"
  set +e
  DRY_RELEASE_READY="$($NODE_BIN scripts/verify-release-ready.mjs 2>&1)"
  DRY_RELEASE_STATUS=$?
  set -e
  printf '%s\n' "$DRY_RELEASE_READY"
  if [ "$DRY_RELEASE_STATUS" -ne 0 ]; then
    echo "[owner-closeout] Dry-run readiness is not READY; the verifier output above identifies the current repository evidence gaps."
  fi
  echo "[owner-closeout] Dry run: no approvals or receipts were written. Re-run with --confirm after reviewing this summary."
  exit 0
fi

json_field() {
  "$NODE_BIN" -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(String(value[process.argv[2]] ?? ""));' "$1" "$2"
}

run_step() {
  local label="$1"
  shift
  local step_output
  local step_exit
  set +e
  step_output="$("$@" 2>&1)"
  step_exit=$?
  set -e
  printf '%s\n' "$step_output"
  if [ "$step_exit" -ne 0 ]; then
    echo "[owner-closeout] $label failed. Closeout stopped before later steps; preserve and commit any record this step wrote before a fresh dry run." >&2
    exit 1
  fi
  STEP_OUTPUT="$step_output"
}

GATES=(init spec architecture feasibility redteam tasks build ship)
for phase in "${GATES[@]}"; do
  if [ "$phase" = "spec" ]; then
    echo "--- materialize spec S5 approval ---"
    run_step "spec S5 approval materialization" "$NODE_BIN" scripts/lib/owner-closeout.mjs materialize-spec
    SPEC_RESULT="$STEP_OUTPUT"
    SPEC_PATH="$(json_field "$SPEC_RESULT" output)"
    SPEC_RATIONALE="$(json_field "$SPEC_RESULT" rationale)"
    echo "--- gate owner-authorize spec S5 ---"
    run_step "spec S5 authorization" "$NODE_BIN" scripts/v4.mjs gate owner-authorize spec \
      --item S5 \
      --rationale "$SPEC_RATIONALE" \
      --approval "$SPEC_PATH" \
      --input specs/requirements.json
  fi

  if [ "$phase" = "tasks" ]; then
    echo "--- materialize P1-011 deferral rebind ---"
    run_step "P1-011 deferral rebind" "$NODE_BIN" scripts/lib/owner-closeout.mjs materialize-p1-rebind
  fi

  echo "--- gate check $phase ---"
  set +e
  RESULT="$($NODE_BIN scripts/v4.mjs gate check "$phase" 2>&1)"
  STATUS=$?
  set -e
  printf '%s\n' "$RESULT"
  if [ "$STATUS" -ne 0 ]; then
    echo "[owner-closeout] $phase gate did not pass. Closeout stopped before later phases; preserve and commit its receipt before a fresh dry run." >&2
    exit 1
  fi
done

echo "--- status check ---"
run_step "state projection" "$NODE_BIN" scripts/v4.mjs status --check

echo "--- materialize redteam review attestation ---"
run_step "redteam review attestation" "$NODE_BIN" scripts/lib/owner-closeout.mjs materialize-redteam-attestation
ATTESTATION_REUSED="$(json_field "$STEP_OUTPUT" reused)"
ATTESTATION_HASH="$(json_field "$STEP_OUTPUT" artifactHash)"

echo "--- verify release readiness ---"
set +e
RELEASE_READY="$($NODE_BIN scripts/verify-release-ready.mjs 2>&1)"
RELEASE_STATUS=$?
set -e
printf '%s\n' "$RELEASE_READY"
if [ "$RELEASE_STATUS" -ne 0 ] || ! "$NODE_BIN" -e '
const report = JSON.parse(process.argv[1]);
process.exit(report?.result === "READY" && Array.isArray(report.errors) && report.errors.length === 0 ? 0 : 1);
' "$RELEASE_READY"; then
  if [ "$ATTESTATION_REUSED" = "false" ]; then
    echo "--- discard newly generated redteam review attestation ---"
    set +e
    DISCARD_RESULT="$($NODE_BIN scripts/lib/owner-closeout.mjs discard-redteam-attestation --expected-hash "$ATTESTATION_HASH" 2>&1)"
    DISCARD_STATUS=$?
    set -e
    printf '%s\n' "$DISCARD_RESULT"
    if [ "$DISCARD_STATUS" -ne 0 ]; then
      echo "[owner-closeout] release readiness is not READY. The newly generated redteam attestation could not be discarded safely; preserve it and the prior records before repairing the verifier findings." >&2
      exit 1
    fi
    echo "[owner-closeout] discarded newly generated redteam attestation after failed release readiness." >&2
  fi
  echo "[owner-closeout] release readiness is not READY. Closeout stopped after the report above; preserve and commit prior records before repairing the verifier findings and starting a fresh dry run." >&2
  exit 1
fi

echo "--- external preflight inputs ---"
set +e
PREFLIGHT_INPUTS="$($NODE_BIN scripts/lib/owner-closeout.mjs external-preflight-inputs 2>&1)"
PREFLIGHT_STATUS=$?
set -e
printf '%s\n' "$PREFLIGHT_INPUTS"
if [ "$PREFLIGHT_STATUS" -ne 0 ]; then
  echo "[owner-closeout] the external preflight input record is malformed or unclassified; closeout stopped without treating it as an external readiness result." >&2
  exit 1
fi
echo "[owner-closeout] Repository release readiness is READY. External preflight inputs remain; they do not authorize a deployment, signature, broadcast, asset movement, spending, or publication."
