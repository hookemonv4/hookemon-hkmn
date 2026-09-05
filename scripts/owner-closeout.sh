#!/usr/bin/env bash
# Owner closeout for Hookemon Phase 2 requirements revision 58.
#
# Run this from the main checkout that holds .v4/ledger.db -- never from a worktree under
# .worktrees/. See docs/superpowers/plans/owner-closeout.md for the full runbook: which five
# approval files the owner signs first, the exact token string, and the launch-gating checklist
# this script does not itself enforce.
#
# This script walks the eight v4 phase gates in order (init, spec, architecture, feasibility,
# redteam, tasks, build, ship), stops at the first FAILED result, and -- only for feasibility,
# redteam, and ship, the three phases known to need one at this revision -- drafts an
# override-approval template under decisions/owner-approvals/closeout-<phase>-override-draft.json
# with the exact subjectHashes an override needs to validate. It never itself writes an
# approvalToken: the owner reads the drafted rationale, edits it if needed, sets
# "approvalToken": "OWNER APPROVED" by hand, and re-runs this script. Once every gate reads PASSED
# or OVERRIDDEN it promotes the P1-011 dashboard-deferral rebind and runs the defer command, then
# prints status. It stops at the first failure and never changes any approvalToken on its own.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f .v4/ledger.db ]; then
  echo "[owner-closeout] .v4/ledger.db not found in $REPO_ROOT -- run this from the main checkout, never a worktree." >&2
  exit 1
fi
case "$REPO_ROOT" in
  */.worktrees/*)
    echo "[owner-closeout] refusing to run inside a .worktrees/* path ($REPO_ROOT)." >&2
    exit 1
    ;;
esac

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

NODE_BIN="${HOOKEMON_NODE_BIN:-node}"
if [ "$(node_major "$NODE_BIN")" -lt 24 ]; then
  echo "[owner-closeout] Node 24+ is required (found: $("$NODE_BIN" -v 2>/dev/null || echo 'none')). Put Node 24's bin directory first on PATH, or set HOOKEMON_NODE_BIN to its node binary." >&2
  exit 1
fi

GATES=(init spec architecture feasibility redteam tasks build ship)
OVERRIDE_EXPECTED=(feasibility redteam ship)

is_override_expected() {
  local phase="$1" candidate
  for candidate in "${OVERRIDE_EXPECTED[@]}"; do
    [ "$candidate" = "$phase" ] && return 0
  done
  return 1
}

json_field() {
  # json_field <file> <field> -- reads one top-level string field with node, no jq dependency.
  "$NODE_BIN" -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))[process.argv[2]])" "$1" "$2"
}

draft_override_template() {
  local phase="$1"
  local draft_path="decisions/owner-approvals/closeout-${phase}-override-draft.json"
  PHASE="$phase" DRAFT_PATH="$draft_path" "$NODE_BIN" --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { listReceipts, resolveReceiptInput } from './scripts/lib/receipts.mjs';

const root = process.cwd();
const phase = process.env.PHASE;
const draftPath = process.env.DRAFT_PATH;

function sha256(inputPath) {
  return createHash('sha256').update(readFileSync(resolveReceiptInput(root, inputPath))).digest('hex');
}

const receipts = listReceipts(root);
const latest = [...receipts].reverse().find((r) => r.type === 'gate' && r.phase === phase);
if (!latest) {
  console.error(\`[owner-closeout] no gate receipt found for \${phase} -- gate check \${phase} should have just written one.\`);
  process.exit(1);
}

// Reproduce scripts/lib/gates.mjs's own receiptInputClosure: walk every input the FAILED gate
// receipt named, plus policy/policy.json, following any input that is itself a receipt file --
// the exact set overrideGate() requires an override approval's subjectHashes to bind exactly.
const receiptByInput = new Map(receipts.map((r) => [\`receipts/\${r.id}.json\`, r]));
const closure = new Set([...Object.keys(latest.inputHashes ?? {}), 'policy/policy.json']);
const queue = [...closure].filter((input) => receiptByInput.has(input));
while (queue.length > 0) {
  const r = receiptByInput.get(queue.shift());
  for (const input of Object.keys(r.inputHashes ?? {})) {
    if (closure.has(input)) continue;
    closure.add(input);
    if (receiptByInput.has(input)) queue.push(input);
  }
}
const subjectHashes = {};
for (const input of [...closure].sort()) {
  try {
    subjectHashes[input] = sha256(input);
  } catch {
    // Input no longer resolves to a real file; overrideApprovalSubjectInputs drops these too.
  }
}

const draft = {
  schema: 'v4-owner-approval-v2',
  authority: 'OWNER',
  action: 'GATE_OVERRIDE',
  phase,
  itemId: null,
  rationale: 'REPLACE_WITH_OWNER_RATIONALE -- see docs/superpowers/plans/owner-closeout.md section 4 for the carried-forward text for this phase.',
  approvalToken: 'DRAFT_UNSIGNED_NOT_YET_APPROVED',
  subjectHashes,
};
writeFileSync(draftPath, \`\${JSON.stringify(draft, null, 2)}\n\`);
console.log(\`drafted \${draftPath}\`);
"
}

record_spec_s5_evidence() {
  # gates/spec.json's S5 item ("the owner approved the spec revision with an unambiguous yes")
  # needs its own OWNER evidence receipt bound to the CURRENT specs/requirements.json content --
  # the existing r-NNNNN receipt for S5 (if any) is bound to whatever revision was current when it
  # was recorded and goes STALE the moment specs/requirements.json changes underneath it, which is
  # exactly what happened between revision 56 and 58. Signing the four decisions/owner-approvals/
  # revision-58-*.json drafts in section 2 of the plan is necessary but not sufficient by itself:
  # gates/spec.json's S5 evidencePolicy allows only specs/requirements.json as an artifact input,
  # and scripts/lib/gates.mjs's ownerEvidenceSubjectInputs requires the evidence approval's
  # subjectHashes to be exactly {gates/spec.json, policy/policy.json, specs/requirements.json} --
  # none of the four drafts' own subjectHashes match that shape (three cite
  # decisions/ADR-0021-autonomous-cycle-authority.md, which S5 does not allow as an input; the
  # baseline draft cites product/ and decisions/task-deferrals/ paths S5 does not allow either).
  # This function folds the substance of all four already-reviewed drafts into one real S5
  # evidence approval with the correct subject shape, using the same draft-then-wait pattern as
  # draft_override_template above -- it never sets the token itself.
  local approval_path="decisions/owner-approvals/phase-2-revision-58-spec-s5-approved.json"
  if [ -f "$approval_path" ]; then
    local token
    token="$(json_field "$approval_path" approvalToken)"
    if [ "$token" = "OWNER APPROVED" ]; then
      local rationale
      rationale="$(json_field "$approval_path" rationale)"
      "$NODE_BIN" scripts/v4.mjs gate owner-authorize spec \
        --item S5 --rationale "$rationale" --approval "$approval_path" --input specs/requirements.json
      return 0
    fi
    echo ""
    echo "[owner-closeout] $approval_path already exists but is not yet signed."
    echo "Read its rationale (it folds in the four revision-58-*.json drafts from section 2), set approvalToken to \"OWNER APPROVED\", then re-run this script." >&2
    exit 1
  fi

  APPROVAL_PATH="$approval_path" "$NODE_BIN" --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveReceiptInput } from './scripts/lib/receipts.mjs';

const root = process.cwd();
const approvalPath = process.env.APPROVAL_PATH;
const drafts = [
  'decisions/owner-approvals/revision-58-baseline.json',
  'decisions/owner-approvals/revision-58-hookdata-relaxation.json',
  'decisions/owner-approvals/revision-58-standing-authority.json',
  'decisions/owner-approvals/revision-58-distribution-signer-custody.json',
];
const rationale = [
  'Owner approves requirements revision 58 as a whole (spec gate item S5), combining the four',
  'individually reviewed decision drafts below into one evidence record because gates/spec.json\'s',
  'S5 evidence policy allows only specs/requirements.json as an artifact input:',
  '',
  ...drafts.map((path) => \`\${path}:\n\${JSON.parse(readFileSync(path, 'utf8')).rationale}\`),
].join('\n\n');
const subjectInputs = ['gates/spec.json', 'policy/policy.json', 'specs/requirements.json'].sort();
const subjectHashes = {};
for (const input of subjectInputs) {
  subjectHashes[input] = createHash('sha256').update(readFileSync(resolveReceiptInput(root, input))).digest('hex');
}
const approval = {
  schema: 'v4-owner-approval-v2',
  authority: 'OWNER',
  action: 'GATE_EVIDENCE',
  phase: 'spec',
  itemId: 'S5',
  rationale,
  approvalToken: 'DRAFT_UNSIGNED_NOT_YET_APPROVED',
  subjectHashes,
};
writeFileSync(approvalPath, \`\${JSON.stringify(approval, null, 2)}\n\`);
console.log(\`drafted \${approvalPath}\`);
"
  echo ""
  echo "[owner-closeout] drafted $approval_path -- read its rationale (it folds in the four" >&2
  echo "revision-58-*.json drafts from section 2 of the plan), set approvalToken to \"OWNER APPROVED\", then re-run this script." >&2
  exit 1
}

echo "[owner-closeout] running from $REPO_ROOT with $("$NODE_BIN" -v)"

# Project tasks.json from the ledger BEFORE any receipt is recorded: task evidence binds to the
# task fingerprint in the projection, and a projection written afterwards marks it stale.
echo "--- task project ---"
"$NODE_BIN" scripts/v4.mjs task project

# Every done task needs an evidence receipt with result PASSED bound to the current requirements
# revision; the gate cascade below cannot repair a trace gap.
echo "--- trace check ---"
TRACE_JSON="$("$NODE_BIN" scripts/v4.mjs trace check 2>&1 || true)"
if [ "$TRACE_JSON" != '{"gaps":[]}' ]; then
  echo "$TRACE_JSON"
  echo "[owner-closeout] trace check reports gaps. For each done task without valid evidence run" >&2
  echo "  node scripts/v4.mjs receipt add --type evidence --result PASSED --task <id> --commit <completion commit> --input <verification artifact>..." >&2
  echo "(at least one input besides specs/requirements.json), register new tasks in product/delivery-boundary.json, then re-run this script." >&2
  exit 1
fi

for phase in "${GATES[@]}"; do
  echo "--- gate check $phase ---"
  set +e
  RESULT_JSON="$("$NODE_BIN" scripts/v4.mjs gate check "$phase" 2>&1)"
  STATUS=$?
  set -e
  echo "$RESULT_JSON"
  [ $STATUS -eq 0 ] && continue

  if [ "$phase" = "spec" ]; then
    record_spec_s5_evidence
    echo "--- re-checking spec after S5 evidence ---"
    set +e
    RECHECK_JSON="$("$NODE_BIN" scripts/v4.mjs gate check "$phase" 2>&1)"
    RECHECK_STATUS=$?
    set -e
    echo "$RECHECK_JSON"
    if [ $RECHECK_STATUS -eq 0 ]; then
      continue
    fi
    echo ""
    echo "[owner-closeout] spec still failed after recording S5 evidence -- read the problems printed above." >&2
    echo "S1-S4 are SYSTEM-authority items verified from code and cannot be satisfied by an owner approval; this is not something this script can fix for you." >&2
    exit 1
  fi

  if [ "$phase" = "tasks" ]; then
    # T1/T2/T3/T5 are SYSTEM items bound to tasks.json. `task project` above rewrites tasks.json
    # with a fresh generatedAt on every run, so their evidence can only be recorded here, after
    # the projection and before the tasks gate check, never by hand before the script starts.
    echo "--- re-recording tasks evidence against the current projection ---"
    "$NODE_BIN" scripts/v4.mjs gate evidence tasks --item T1 --input specs/requirements.json --input tasks.json
    "$NODE_BIN" scripts/v4.mjs gate evidence tasks --item T2 --input tasks.json
    "$NODE_BIN" scripts/v4.mjs gate evidence tasks --item T3 --input tasks.json
    "$NODE_BIN" scripts/v4.mjs gate evidence tasks --item T5 --input specs/requirements.json --input tasks.json
    echo "--- re-checking tasks ---"
    set +e
    RECHECK_JSON="$("$NODE_BIN" scripts/v4.mjs gate check "$phase" 2>&1)"
    RECHECK_STATUS=$?
    set -e
    echo "$RECHECK_JSON"
    if [ $RECHECK_STATUS -eq 0 ]; then
      continue
    fi
    echo ""
    echo "[owner-closeout] tasks still failed after re-recording T1/T2/T3/T5 -- read the problems printed above." >&2
    exit 1
  fi

  if is_override_expected "$phase"; then
    draft_path="decisions/owner-approvals/closeout-${phase}-override-draft.json"
    if [ -f "$draft_path" ]; then
      TOKEN="$(json_field "$draft_path" approvalToken)"
      if [ "$TOKEN" = "OWNER APPROVED" ]; then
        RATIONALE="$(json_field "$draft_path" rationale)"
        "$NODE_BIN" scripts/v4.mjs gate override "$phase" --rationale "$RATIONALE" --approval "$draft_path"
        # Do not run `gate check` again here: it would append a fresh FAILED gate
        # receipt after the OVERRIDDEN one and the later phases would then see
        # the failure as the latest feasibility result.
        echo "[owner-closeout] $phase overridden with $draft_path"
        continue
      fi
      echo ""
      echo "[owner-closeout] $draft_path already exists but is not yet signed."
      echo "Read its rationale, edit it if it no longer matches reality, set approvalToken to \"OWNER APPROVED\", then re-run this script." >&2
      exit 1
    fi
    echo ""
    echo "[owner-closeout] $phase gate failed -- expected at this point in the revision-58 closeout."
    draft_override_template "$phase"
    echo "Read docs/superpowers/plans/owner-closeout.md section 4 for the carried-forward rationale for $phase," >&2
    echo "replace the placeholder rationale in $draft_path, set approvalToken to \"OWNER APPROVED\", then re-run this script." >&2
    exit 1
  fi

  echo ""
  echo "[owner-closeout] $phase gate failed unexpectedly -- every gate except feasibility/redteam/ship should already pass at this revision." >&2
  echo "This is not a known revision-58 gap; read the problems printed above before doing anything else." >&2
  exit 1
done

echo "--- all eight gates PASSED or OVERRIDDEN ---"

DASHBOARD_APPROVAL="decisions/owner-approvals/phase-2-revision-58-dashboard-deferral-approved.json"
DASHBOARD_TOKEN="$(json_field "$DASHBOARD_APPROVAL" approvalToken)"
if [ "$DASHBOARD_TOKEN" != "OWNER APPROVED" ]; then
  echo "[owner-closeout] $DASHBOARD_APPROVAL is not yet signed (approvalToken must be \"OWNER APPROVED\")." >&2
  echo "Sign it (section 2 of the plan) before the P1-011 deferral can be rebound." >&2
  exit 1
fi

REBIND="decisions/task-deferrals/P1-011-revision-58-rebind.json"
LIVE="decisions/task-deferrals/P1-011.json"
if ! cmp -s "$REBIND" "$LIVE"; then
  echo "--- promoting $REBIND over $LIVE ---"
  cp "$REBIND" "$LIVE"
fi

RATIONALE="$(json_field "$LIVE" rationale)"
echo "--- task defer P1-011 ---"
"$NODE_BIN" scripts/v4.mjs task defer P1-011 \
  --record "$LIVE" \
  --approval "$DASHBOARD_APPROVAL" \
  --rationale "$RATIONALE"

echo "--- status ---"
"$NODE_BIN" scripts/v4.mjs status
"$NODE_BIN" scripts/v4.mjs status --check
echo "[owner-closeout] complete. Commit receipts/, STATE.md, state.json, and the signed approval/deferral files (section 5 of the plan), then push."
