# ADR-0023: Exclude the vault family from the Phase 3 deployment manifest

## Status

Accepted

## Context

Phase 3 deploys only the HKMN token, `HookemonHook`, and `PermanentPositionCustody` through the Programmable CREATE2 graph. The two-transaction launch uses the graph transaction first and the owner seed transaction second. The earlier process-contract family remains source evidence only and has no deployed runtime.

## Decision

`release/phase3/deployment-manifest.json` is the authoritative runtime set. It excludes the vault, escrow, route-executor, Merkle payout, and settlement contracts. The deployment-manifest validator rejects an excluded contract in `deployed` before accepting the content digest.

## L2 findings made moot by this deployment boundary

| Finding | Summary | Disposition |
|---|---|---|
| L2-01 | Relay transaction bytes cannot satisfy the process route decoder. | not deployed / excluded by manifest |
| L2-03 | A process route cannot establish Relay attribution for a contract sender. | not deployed / excluded by manifest |
| L2-04 | A funded process cycle has no abort, route replacement, or recovery transition. | not deployed / excluded by manifest |
| L2-05 | An unsolicited USDG atomic unit can prevent execution through the shared route executor. | not deployed / excluded by manifest |
| L2-07 | Process return proceeds lack finalized, cycle-specific attribution. | not deployed / excluded by manifest |
| L2-08 | Process residue and degraded-return balances can remain locked. | not deployed / excluded by manifest |
| L2-11 | The payout authorizer can redirect a committed Merkle payout root. | not deployed / excluded by manifest |
| L2-13 | Settlement records payment after RPC acceptance rather than finality. | not deployed / excluded by manifest |

## Consequences

These dispositions do not accept the findings as safe for the retired process design. A future manifest that adds any excluded runtime requires a new decision and a fresh review of the corresponding L2 findings.
