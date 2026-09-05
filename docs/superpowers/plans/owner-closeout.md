# Owner closeout for Phase 3 requirements revision 65

Run the closeout only from the clean main checkout that owns `.v4/ledger.db`.
It records repository evidence only. It does not deploy, use credentials, sign a
transaction, broadcast, move assets, spend, or publish anything.

Node `v24.19.0` must already be first on `PATH`. Do not run this procedure from
a linked worktree.

## Owner commands

Run these two commands in order:

```sh
bash scripts/owner-closeout.sh
bash scripts/owner-closeout.sh --confirm
```

The first command is the dry run. It writes nothing. It reports the exact
approval inventory, the validator result for each candidate, the release-ready
snapshot, and every record that a confirmed run may create.

`--confirm` is the explicit confirmation for this local repository-evidence
operation. It refuses a dirty checkout, a linked worktree, a missing ledger, or
any Node version other than `v24.19.0`. It recomputes hashes immediately before
each formal record is written. It is not permission for a deployment, wallet
signature, broadcast, asset movement, spending, credential use, or publication.

## What the dry run reports

At revision 65 the inventory contains 12 unsigned owner-approval artifacts and
five historical artifacts that combine a formal token with `DRAFT_UNSIGNED`.
It also reports the three P1-011 rebind drafts, the stale uppercase feasibility
override draft, and the absence or presence of a `controlGatePinBump` record.
There are no revision-60 or revision-61 owner-approval baseline files.

The 12 unsigned approval artifacts are the revision-59 baseline, fee-policy,
operations-wallet, and snapshot-payout drafts; revision-62 through revision-65
baselines; the revision-58, revision-62, and revision-63 dashboard drafts; and
the revision-64 redteam attestation. The five contradictory historical records
are the revision-58 baseline, distribution-signer-custody, hookdata-relaxation,
standing-authority, and Phase 2 S5 records.

The output validates artifacts through `readOwnerApproval` where that validator
can apply. P1 rebind drafts intentionally cannot validate directly: the
deferral validator accepts only the canonical `decisions/task-deferrals/P1-011.json`
descriptor and a matching formal approval. The stale feasibility override is
reported, not reused, because an override must bind the current failed-gate
closure and use a lowercase formal approval path.

## Records a confirmed closeout can create

Historical drafts remain unchanged. ADR-0022 requires current separate records;
changing a historical token would not bind the current requirements.

- `decisions/owner-approvals/closeout-revision-65-spec-s5-approved.json`
  authorizes S5 with exactly `gates/spec.json`, `policy/policy.json`, and
  `specs/requirements.json` as subjects. The closeout records the matching S5
  evidence receipt before checking the spec gate.
- `decisions/owner-approvals/phase-3-revision-65-dashboard-deferral-approved.json`
  accompanies a regenerated canonical P1-011 descriptor. If the owner ledger
  still has P1-011 deferred, the closeout transactionally changes only its
  deferral pointers after validator approval. It preserves task status, lease
  token, and attempt history. The operation is skipped when P1-011 is absent.
- `decisions/owner-approvals/redteam-review-attestation-65.json` attests to the
  current redteam bundle and reviewed tree only after every gate and the state
  projection pass.

The script does not create a later record before its gate boundary: it checks
`init` first, creates S5 immediately before `spec`, and rebinds P1-011
immediately before `tasks`.

The closeout does not create a pin-bump record. A control pin bump must bind the
exact committed protected-base and candidate trees, pin bytes, base checker blob,
and changed digest set. It belongs to the candidate control change, not a clean
main-checkout closeout.

## Gate and readiness messages

After confirmation, the script calls `node scripts/v4.mjs` for `init`, `spec`,
`architecture`, `feasibility`, `redteam`, `tasks`, `build`, and `ship`, in that
order. A message such as `redteam gate did not pass` means the script stopped at
that real failure. Later phases were not evaluated or refreshed.

Each gate check appends a receipt, including a failed check. A later failure can
also leave a current formal approval or deferral record. Preserve and commit
those records through the protected repository process before repairing the
reported evidence and starting a fresh dry run. Do not delete them merely to
make the checkout appear clean.

After the eight gates pass, `status --check` regenerates the state projections.
Only then does the closeout create the redteam attestation, so its reviewed-tree
hash includes the final state. No successful-path write follows the attestation.
If the immediate release check is not `READY` and this invocation created the
attestation, the script verifies its current hashes, the exact hash it just
wrote, and that the artifact is still untracked before removing only that new
attestation. It retains the gate receipts and any current S5 or P1-011 record
for the protected commit and recovery process.

`node scripts/verify-release-ready.mjs` must return `READY` with no errors. The
closeout never treats a free-form verifier error as external. Once repository
release readiness is `READY`, it prints the four explicit external preflight
inputs from `release/phase3/package/package-manifest.json`:
`UNVERIFIED_LAUNCH_INTENT_PREIMAGE`, `PROVIDER_API_KEY_PENDING`,
`OWNER_WALLET_FUNDING_PENDING`, and `BUILDER_IDENTITY_PENDING`. These remain
OPEN FACTs for the provider or owner workflow and do not turn repository
readiness into launch authority.

## After the command

Review the newly appended receipts and current formal approval records, then
commit them from the main checkout through the protected repository process. Do
not edit an existing receipt or rewrite a historical unsigned draft.
