# Phase 1 Local Integration Plan

## Goal

Integrate the last Phase 1-only tree onto the current `origin/main`, restore every local gate and release proof, and fast-forward the verified result into local `main`. Keep Product Phase 2 closed and exclude the v4 hook, automation, provider, and later release changes.

## Integration shape

Use `6094af8` as the exact Phase 1 source and preserve its history. `origin/main` at `ec13a1a` is its direct ancestor, and all later Phase 2 work remains excluded.

Ten historical commits in this fixed range predate the project Git identity. Add only SHA- and rule-specific exceptions for those commits to the identity scanner. Never permit a wildcard identity, attribution trailer, or unknown commit.

The authoritative order is:

1. exact Phase 1 history through `6094af8`
2. narrow gate, identity, and evidence repairs on `codex/phase1-fast-forward`
3. local fast-forward into `main`

No remote push, deployment, signature, broadcast, spend, or publication is part of this plan.

## Constraints

- Use the pinned Node 24, Forge, solc, and clean v4-core dependency recorded by the repository.
- Change generated projections and append receipts only through `scripts/v4.mjs`.
- Preserve Phase 2 as closed in `product/delivery-boundary.json` and the release manifest.
- Write a failing regression test before any behavior-changing gate fix.
- Record technical evidence locally, but never manufacture owner approval or an override.
- Keep the release binding non-circular: source commit, candidate digest, reproducibility report, then evidence receipts.

## Tasks

### 1. Preserve and classify

- Confirm that `6094af8` contains no commit from `6094af8..a2dce43` and no v4 hook implementation.
- Reproduce the identity failure for the full integration range.
- Add exact historical exceptions with negative regression coverage and update the identity module contract.

### 2. Restore local gates

- Run the pinned script tests, delivery-boundary checks, trace check, Foundry format, contract tests, runner tests, and control dependency verification.
- Classify environment failures separately from code or policy failures.
- Repair only reproducible Phase 1 failures. Stop for an exact owner decision if clean-room policy or a gate requires owner authority.

### 3. Refresh release evidence if needed

- Retain the existing candidate digest and reproducibility source when all manifest-covered inputs remain byte-identical.
- If any covered input changes, generate a fresh candidate manifest, commit its immutable source state, reproduce it twice with pinned offline dependencies, and append new evidence through the ledger.
- Never change manifest-covered inputs after their source commit.

### 4. Close and review

- Obtain only the exact content-hash-bound owner approvals or override rationales still required by the refreshed gates.
- Regenerate projections through the CLI and confirm the complete gate chain.
- Request an independent severe-risk review of the final diff.
- Run the full local CI-equivalent suite once, inspect the final diff and Git identity range, then fast-forward local `main`.

### 5. Begin Phase 2

- Conduct the fresh Phase 2 scope interview required by the delivery boundary.
- Write a new requirements revision and Phase 2 ADRs, obtain exact owner approval, then evolve the delivery-boundary schema and tests.
- Run architecture, feasibility, red-team, and task gates before claiming the first Phase 2 build task.
- Treat existing P2 commits as technical references only; re-evaluate and port them under the approved Phase 2 requirements.
