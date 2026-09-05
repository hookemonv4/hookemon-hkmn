# V4 Evidence Control

## Purpose

The evidence control records immutable, content-addressed receipts and projects the current phase from reproducible gate results. It is the authority for `STATE.md` and `state.json`.

## Public interface

- `node scripts/v4.mjs receipt add --type <type> --phase <phase> --input <path>` creates non-gate evidence.
- `node scripts/v4.mjs gate evidence <phase> --item <id> --input <path>` records system-authority evidence allowed by that exact gate item.
- `node scripts/v4.mjs gate owner-authorize <phase> --item <id> --rationale <text> --approval <path> --input <path>` records owner-authority evidence from a matching structured approval artifact.
- `node scripts/v4.mjs gate check <phase>` evaluates a gate and appends its result.
- `node scripts/v4.mjs gate override <phase> --rationale <text> --approval <path>` records an explicit owner override of the current failed evaluation.
- `node scripts/v4.mjs gate authorize-not-applicable <phase> --item <id> --rationale <text> --approval <path>` records an item-specific owner authorization and updates the gate run.
- `node scripts/v4.mjs status --check` regenerates the state projections and fails for any non-passing authoritative result other than `PENDING`.

## Invariants

- Receipt files are regular `100644` blobs named with one contiguous numeric sequence beginning at `r-00001.json`.
- A receipt is never modified, deleted, renamed, replaced, or linked through a symlink.
- Every recorded input is repository-relative, remains inside the repository after symlink resolution, and is bound by SHA-256.
- Generic receipt creation rejects every receipt type reserved by any gate definition. Reserved types are writable only behind the validating gate and owner commands.
- A gate item accepts only its declared receipt type, authority, proof schema, exact artifact allowlist, required inputs, matching phase and item, passing result, and fresh transitive evidence.
- Architecture A6 accepts a module index only when its entries follow the capability map's topological order and the capability declarations contain the same unique module set.
- A passing gate receipt reproduces the current definition, run, evidence set, problems, and result exactly.
- Owner evidence, overrides, and `NOT_APPLICABLE` require a regular repository-internal `v4-owner-approval-v2` JSON artifact. Its canonical `subjectHashes` map has exactly the derived subject paths and the current lowercase SHA-256 for each path. Missing, extra, malformed, mismatching, or changed subjects fail closed.
- Gate evidence binds the gate definition, authority policy, and exact approved artifact inputs. `NOT_APPLICABLE` binds the gate definition and authority policy.
- Spec decision evidence binds every normative ADR for the active requirements revision.
- An escalated item binds every currently resolvable exact required input, so an override expires when that evidence changes.
- An override binds the complete evaluated closure: gate definition, existing run, referenced evidence or `NOT_APPLICABLE` receipts, every currently resolvable transitive receipt input, and authority policy. The new override approval is excluded from its own subject map and bound once as the receipt's authority input. An override cannot replace a passing gate.
- A currently missing nested path is represented by the bound parent receipt, run, and evaluation problems. If the path appears, the recomputed override subject set changes and the override is no longer authoritative.
- Owner receipt verification recomputes the operation subject set, matches approval hashes to receipt hashes, and checks current content. A later definition, run, evidence, policy, approval, or subject change invalidates the authorization.
- Approval provenance must be enforced by the protected pull-request and merge process described in `docs/control-authority.md`; the local CLI does not claim cryptographic authorship.
- Generated state files are projections. Receipts remain authoritative.

## State transitions

1. System or owner evidence is appended through its authority-specific command with content hashes.
2. A gate run maps each item to `RUN`, `INHERITED`, `NOT_APPLICABLE`, or `ESCALATE`.
3. Gate evaluation appends `PASSED` or `FAILED`; an owner can append an `OVERRIDDEN` result for a concrete failed evaluation.
4. A bound input change makes a previously passing or overridden result `STALE`.
5. The first phase without an authoritative passing or overridden result becomes the current phase.

## Operational commands

```sh
node scripts/v4.mjs gate evidence init --item I1 --input product/PRD.md
node scripts/v4.mjs gate owner-authorize init --item I2 --rationale "<exact owner rationale>" --approval decisions/owner-approvals/<approval>.json --input product/PRD.md
node scripts/v4.mjs gate check init
node scripts/v4.mjs status --check
node scripts/check-append-only.mjs <base-sha> <head-sha>
```

## Recovery pointers

- Do not edit a stale receipt. Append replacement evidence, update the gate run to the new receipt IDs, and run the gate again.
- A malformed or noncanonical receipt must be corrected before commit. Once committed, preserve it and append a valid successor only if the repository policy permits that recovery.
- A failed state projection is regenerated with `status --check` after the evidence chain is repaired.
