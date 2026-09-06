# CI fork proof

## Detection

`fork-proof` is the enforced post-merge fork gate on `main`. It fails when
`ROBINHOOD_FORK_RPC_URL` is absent, the pinned archive bundle is invalid, or the
archive suite fails. Pull requests never trigger this workflow. The current-head
canary reports endpoint or pin drift only from `main`.

## Safe stop

Pull requests require `control-gate`, `identity-gate`, and `gates`. Main requires `control-gate`, `identity-gate`, `gates`, and `fork-proof`.
Configure the ruleset with these exact check names: `control-gate`, `identity-gate`, `gates`, and `fork-proof`.

Do not merge while a pull-request status is pending or failed. Do not put an
endpoint in repository files, workflow logs, issue comments, or local fixtures.

## Runner behavior

`.github/workflows/fork-proof.yml` triggers on pushes to `main` and on
`workflow_dispatch`. Its first step rejects any ref other than `refs/heads/main`,
so a manual run must select `main`. The job uses GitHub Environment `fork-proof`,
sets `ROBINHOOD_FORK_PINNED=true`, verifies every regular Git blob in the pinned
`verify-fork-pin.mjs` import closure, validates the archive pin, and runs the
archive suite without FFI. A missing endpoint exits nonzero.

`.github/workflows/fork-pin-canary.yml` remains main-only. Its scheduled and
manual runs check `refs/heads/main` before observing current-head drift.

`identity-gate` and `control-gate` protect pull requests without endpoint
access. They execute base-defined checks and treat the proposed revision as Git
data, not executable workflow code.

For a zero `before` SHA or parentless pushed revision, range gates use the Git
empty tree, scan every reachable commit, and record the explicitly trusted
pushed base in the identity and control job summaries. Do not bypass a failed
initial-push range check; an unset `fork-proof` endpoint is independent.

## Coordinator checkpoint

At every checkpoint, the coordinator runs the pinned verifier and archive suite
locally, then records both results in the checkpoint report:

```sh
ROBINHOOD_FORK_PINNED=true node scripts/verify-fork-pin.mjs
ROBINHOOD_FORK_PINNED=true FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts -vv --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol'
```

The endpoint remains in the process environment. Do not print or persist it.

## Operator recovery

The repository is private on a plan that does not offer environment approval rules.
Configure GitHub Environment `fork-proof` with **Selected branches and tags** set
to `main` only, then store `ROBINHOOD_FORK_RPC_URL` as its environment secret.
The post-merge `fork-proof` status is the enforced fork gate. A manual proof is
valid only when dispatched from `main`.

Keep the transitional identity check until the owner registers `identity-gate` and
`control-gate` as required statuses on `main`; the no-override launch verifier remains the release gate after owner preflight.

## Escalation

Escalate an archive pin mismatch, archive-suite failure, unavailable endpoint, or a
fork-proof run from a non-main ref. Re-run the local checkpoint commands after fixing configuration or pin material.

## Evidence

The workflow source proves the trigger boundary and fail-closed behavior; the
owner configures the environment and protected statuses. GitHub documents
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow?tool=webui).
## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP16
Expected outcome: terminal=none; attempt=none; next=owner-decision
Test: scripts/tests/workflow-security.test.mjs — fork-proof runs only after a main push or a manual main dispatch and fails closed without its endpoint
Alarm reason/code: `CANARY_DRIFT` for endpoint, archive-pin, or archive-suite failure.
Resume command: `rerun fork-proof from main after the environment secret and archive material are valid`.
