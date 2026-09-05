# Finding Traceability

## Purpose

Finding traceability binds each confirmed or contested audit finding to one phase-three work package, a recorded resolution, an owner decision, a fail-closed open fact, or a deployment exclusion.

## Public interface

- `node scripts/build-traceability.mjs` rebuilds `docs/audit/2026-09-04/traceability.json` from the sanitized finding reports.
- `node scripts/build-traceability.mjs --import <l3-report> <combined-report>` imports the six required finding fields, sanitizes clean-room markers, and rebuilds the matrix.
- `node scripts/verify-traceability.mjs` checks the committed matrix against both source reports.

## Invariants

- Each source record retains `id`, `severity`, `tag`, `verdict`, `title`, and `where`.
- A source lane contains only its lane identifier and verified records; extra or missing fields fail validation.
- Every `CONFIRMED` and `CONTESTED` finding appears exactly once in the generated matrix.
- A work-package disposition names only an identifier from the plan's embedded work-package list and includes a non-empty acceptance criterion.
- A non-work-package disposition has exactly one of `resolved`, `ownerOverride`, `openFailClosed`, or `notApplicable` with a non-empty reason.
- The committed matrix is byte-for-byte reproducible from the sanitized source reports and the generator's disposition table.

## State transitions

1. Verified audit inputs are compacted to the six retained fields and sanitized before entering the repository.
2. The generator joins eligible findings to its plan-derived disposition table and writes the matrix in stable finding-ID order.
3. The verifier rejects missing, duplicate, malformed, stale, or unknown-work-package dispositions.

## Operational commands

```sh
node scripts/build-traceability.mjs
node scripts/verify-traceability.mjs
node --test scripts/tests/traceability.test.mjs
```

## Recovery pointers

- Update the disposition table when an approved plan revision changes a finding's treatment, then regenerate the matrix.
- Re-import the verified reports when their source evidence changes; do not hand-edit the generated matrix.
- If verification fails, repair the source projection or disposition table named by the reported finding ID and rerun the generator.
