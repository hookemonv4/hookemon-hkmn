# CI fork proof

## Detection

`fork-proof` is a required status for pull requests and main pushes. Full-scope
changes require the archive suite; an unavailable `ROBINHOOD_FORK_RPC_URL`, invalid
pin or failing suite fails the status. Protected presentation-only classification
reports the archive proof as NOT RUN and creates no financial evidence. The
current-head canary observes drift only from `main`.

## Safe stop

Pull requests require `control-gate`, `identity-gate`, `gates`, and `fork-proof`. Main requires `control-gate`, `identity-gate`, `gates`, and `fork-proof`.

Do not merge while a pull-request status is pending or failed. Do not put an
endpoint in repository files, workflow logs, issue comments, or local fixtures.

## Runner behavior

`.github/workflows/fork-proof.yml` triggers on pull requests, main pushes and
`workflow_dispatch`. Classification runs from the protected event base. Manual
runs must select `main` and always require the full proof. The applicable archive
worker uses GitHub Environment `fork-proof`, sets `ROBINHOOD_FORK_PINNED=true`,
verifies every regular Git blob in the pinned `verify-fork-pin.mjs` import closure,
validates the archive pin and runs the archive suite without FFI. A missing
endpoint exits nonzero. The terminal status rejects failed, missing, cancelled or
wrongly skipped applicable results.
`.github/workflows/fork-pin-canary.yml` remains main-only. Its scheduled and
manual runs check `refs/heads/main` before observing current-head drift.

For a relevant archive-proof failure, run the pinned verifier and archive suite
as needed to diagnose the affected behavior. Reuse successful current CI rather
than repeating it locally. The endpoint stays in the process environment and must
not be printed or persisted:

```sh
ROBINHOOD_FORK_PINNED=true node scripts/verify-fork-pin.mjs
ROBINHOOD_FORK_PINNED=true FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts -vv --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol'
```

## Operator recovery

Preserve the existing GitHub Environment `fork-proof`, its configured
**Selected branches and tags** restrictions and environment-secret binding for
`ROBINHOOD_FORK_RPC_URL`. Reuse the owner's explicit fork-test approval within its
scope; this authorizes archive tests, not a mainnet transaction. No repository-plan
or protection change is needed for the classified CI workflow. A manual proof
is valid only when dispatched from `main`. The four ordinary required contexts
are already configured on `main`.
When the owner moves `main` from a temporary migration set of required
contexts back to the ordinary set (`control-gate`, `identity-gate`, `gates`,
`fork-proof`), follow this order: (1) run an ordinary pull request against
the newly protected base and let all four ordinary required contexts pass
with no override; (2) only after all four pass, restore the ordinary
required-status configuration on `main` (drop the temporary contexts); (3)
only after that restoration, land the tested head with an ordinary non-force
fast-forward — never a GitHub UI or API merge, which fabricates a merge
commit whose author/committer fail the identity check; (4) confirm the
post-push `main` checks (including `fork-proof`) pass on the new head.
A GitHub-generated merge commit already in history is not rewritten; history
stays append-only. The remedy is forward-only via the fast-forward path above.

## Escalation

Escalate an archive pin mismatch, archive-suite failure, unavailable endpoint,
or a manual fork-proof run from a non-main ref. Recheck the affected proof
after fixing configuration or pin material.

## Evidence

The workflow source proves the trigger boundary and fail-closed behavior. The
owner configures the environment and protected statuses. GitHub documents
branch-filtered `push` events and manual workflow dispatch in its
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
and [manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow?tool=webui).

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP16
Expected outcome: terminal=none; attempt=none; next=owner-decision
Test: scripts/tests/workflow-security.test.mjs — fork-proof runs the same read-only archive proof for a main push, a manual main dispatch, and a pull request head, and fails closed without its endpoint
Alarm reason/code: `CANARY_DRIFT` for endpoint, archive-pin, or archive-suite failure.
Resume command: `rerun fork-proof from main after the environment secret and archive material are valid`.