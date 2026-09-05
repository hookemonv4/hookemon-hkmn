# Control Supply Chain

## Purpose

The control supply chain content-addresses selected Node and Gitleaks executables, remote actions, five CI workflows, scanner policy, the commit-identity checker, the complete fork-pin verifier import closure, the complete control-verifier import closure, the archive proof, and the vendored base pack. Verification fails closed on a mismatch.

## Public interface

- `node scripts/verify-control-dependencies.mjs` verifies runtime and control pins.
- `node scripts/verify-control-dependencies.mjs --write` refreshes the deterministic local verification artifact.
- `.github/workflows/v4-gates.yml` runs required state, trace, clean-room, append-only, secret, test, launch-package, and closure checks.
- `.github/workflows/fork-proof.yml` runs the mandatory archive fork proof after a main push or a manual main dispatch.
- `.github/workflows/identity-gate.yml` runs base-defined commit-identity validation for pull requests and main pushes.
- `.github/workflows/control-gate.yml` runs base-defined control-surface validation for pull requests and main pushes.
- `.github/workflows/fork-pin-canary.yml` observes current-head archive-fork drift only from `main`.
- `node scripts/verify-fork-pin.mjs` validates the archive fork bundle after each fork workflow verifies every regular Git blob in its pinned import closure.
- `node scripts/verify-control-dependencies.mjs --base-control <base-tree> <candidate-tree>` reads candidate control inputs as Git blobs using base-defined code.
- `node scripts/test-manifest.mjs check` proves that every declared suite root is a non-empty repository directory, every tracked Node test has exactly one suite owner, and the test tree contains only regular files and directories.
- `node scripts/verify-release-ready.mjs` evaluates deployment-manifest, traceability, receipt-bound red-team review, and owner-artifact readiness; a nonzero exit is the release refusal.
- `scripts/check-commit-identity.mjs <base-sha> <head-sha>` scans a commit range with the protected-base identity allowlist.
- `node scripts/programmable/verify-launch-package.mjs --allow-unverified` validates the draft launch package in CI; the no-override command is the release gate.
- `node scripts/verify-release-package-closure.mjs` validates release-package closure.
- `node scripts/check-append-only.mjs <base-sha> <head-sha> [--require-ancestor]` verifies receipt history.

## Invariants

- Node and Gitleaks downloads use fixed HTTPS release URLs plus archive and executable SHA-256 checks.
- The local runtime executable must match the pinned platform digest.
- Every remote GitHub Action invocation uses an allowlisted full commit SHA. Unsupported action syntax, local actions, workflow container keys, and symlink aliases fail closed.
- The permitted workflow set is `.github/workflows/v4-gates.yml`, `.github/workflows/fork-proof.yml`, `.github/workflows/identity-gate.yml`, `.github/workflows/control-gate.yml`, and `.github/workflows/fork-pin-canary.yml`; each is a regular repository-internal file.
- The commit-identity checker and its candidate digest must match the supported release. `identity-gate` checks out the exact pull-request base SHA or push merge-base, disables replacement refs, extracts the checker from that base tree, and treats the proposed commit only as Git data.
- The `fork-pin` verifier import closure must match the supported release. The `fork-proof` job and canary reject symlinks, require `100644` Git blobs whose object IDs match the working files, check every closure digest, and only then execute the verifier.
- `control-gate` checks out only the protected base, fetches the candidate as Git data, and runs the control verifier and its complete local import closure extracted from that base tree. It validates candidate `v4-gates.yml`, `fork-proof.yml`, `fork-pin-canary.yml`, `identity-gate.yml`, `control-gate.yml`, the complete fork-pin verifier closure, the complete control-verifier closure, the archive fork test, and `dependency-pins.json`. A pin bump requires an exact owner-approved `controlGatePinBump` record bound to the base checker blob, tree hashes, pin bytes, and changed digest set.
- `v4-gates.yml` retains a transitional base identity check until the owner registers `identity-gate` and `control-gate` as required statuses on `main`.
- Pull requests require `control-gate`, `identity-gate`, and `gates`.
- Main requires `control-gate`, `identity-gate`, `gates`, and `fork-proof`.
- The `fork-proof` workflow triggers on pushes to `main` and manual dispatch. It rejects any ref other than `refs/heads/main`, uses GitHub Environment `fork-proof` restricted to **Selected branches and tags** `main`, requires `ROBINHOOD_FORK_RPC_URL`, sets `ROBINHOOD_FORK_PINNED=true`, validates the pin, and runs the archive suite without FFI. Missing endpoint configuration fails the status.
- The general Forge suite excludes the archive proof because the separate protected `fork-proof` status owns it. `test/integration/LaunchLegFork.t.sol`, `test/integration/RobinhoodV4Fork.t.sol`, and `test/integration/RobinhoodV4ForkSmoke.t.sol` remain opt-in focused suites that may skip when their optional endpoint inputs are absent; none is mandatory release proof.
- The scheduled and manually dispatched canary is guarded to `refs/heads/main`, checks that ref again in shell, and fails when its endpoint is unavailable or the archived head drifts.
- Gitleaks uses the exact content-addressed default policy with no repository allowlists. Tree and complete commit-range scans ignore inline allow directives and repository ignore files.
- Push ranges require the previous SHA to be an ancestor of the new SHA. Every new receipt is a regular `100644` Git blob; every prior receipt remains byte-identical across every commit and merge parent.
- Init control evidence binds every active Phase 1 module contract card, including the current CI, release, and test-manifest controls.
- The CI job uses the `ubuntu-24.04` GitHub-hosted runner label, read-only contents permission, no persisted checkout credential, a timeout, and cancelable concurrency. The repository does not pin the runner image by digest.
- Workflow digests are repository-local consistency checks. A workflow digest does not provide external immutability; protected review and main-only environment configuration provide the external boundary. The commit-identity checker has a second defense: its supported digest is static and CI loads the checker from the protected base or merge-base before it scans candidate commits.
- Every declared test-suite root exists and contains at least one `.test.mjs` file. A test path cannot belong to more than one suite.
- Release readiness derives red-team status only from the latest authoritative redteam gate receipt. It accepts a pass or valid override; a failure is eligible only when its exact problem set and unresolved current-cycle findings are limited to the three manifest dispositions.
- The findings record pins an exact current and predecessor review bundle. Current finding, bundle, resolution, and termination identifiers must be equal before status evaluation; every transition begins at the predecessor status.
- A revision-specific owner attestation binds the complete reviewed tree and current review bundle. A draft token, an invalid subject hash, or rewritten review material remains not ready.
- The bundle pins resolutions, termination, and per-finding evidence references. R1 through R5 evidence receipts are semantically revalidated, must precede the selected gate receipt, and each referenced manifest test must exist at the attested tree.
- Owner-approval enumeration requires a real directory inside the repository and rejects unreadable, symlinked, or non-regular JSON entries.

## State transitions

1. Dependency pins define the accepted artifacts and workflow constants for the candidate revision.
2. Verification compares the active runtime, workflows, checker, files, and package closure with those pins.
3. Pull requests run `identity-gate`, `control-gate`, and `gates` without endpoint access; a main push extracts identity controls from its merge base.
4. The coordinator records the local pinned verifier and archive-suite results at every checkpoint before merging.
5. A main push or manual main dispatch starts `fork-proof`; it verifies its closure, then either proves the archived fork or fails nonzero.
6. Release readiness verifies the owner-attested current and predecessor review bundles, the R1–R5 receipt chain, and owner-artifact filesystem safety before deciding whether the manifest dispositions can remain non-blocking.
7. Any mismatch, unavailable mandatory endpoint, unsupported executable dependency, secret finding, identity error, receipt mutation, package failure, or test failure stops its gate.

## Operational commands

```sh
node scripts/verify-control-dependencies.mjs
node scripts/test-manifest.mjs check
node scripts/verify-release-ready.mjs
node scripts/check-commit-identity.mjs <base-sha> <head-sha>
node scripts/check-append-only.mjs <base-sha> <head-sha>
ROBINHOOD_FORK_PINNED=true node scripts/verify-fork-pin.mjs
ROBINHOOD_FORK_PINNED=true FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts -vv --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol'
node scripts/programmable/verify-launch-package.mjs --allow-unverified
node scripts/verify-release-package-closure.mjs
node --test scripts/tests/*.test.mjs
```

## Recovery pointers

- Configure the main-only environment as described in [the fork-proof runbook](../runbooks/ci-fork-proof.md); never place the endpoint in tracked files.
- Update a dependency only from official release evidence, then change the manifest, workflow constants, tests, verification artifact, and receipt chain together.
- Never add a secret allowlist to make a gate pass. Remove and rotate the secret.
- A non-fast-forward main update is rejected; restore a forward-only history through a reviewed branch.
- Append replacement evidence when control inputs change, then regenerate the phase gate and state projections.
- For a release-readiness refusal, repair the current review bundle or receipt chain instead of editing `state.json`; projections do not authorize release.
