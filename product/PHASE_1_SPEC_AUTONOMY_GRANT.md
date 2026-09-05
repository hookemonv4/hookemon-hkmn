# Phase 1 Spec Autonomy Grant

## Owner approval

The owner explicitly approved the token `AUTO-SCOPE PHASE-1-SPEC APPROVED` on 30 August 2026.

## Target

Complete the v4 framework Spec phase and reach a passing Spec gate for Hookemon product Phase 1 only.

## Included decisions

- Convert the approved Phase 1 PRD into stable, typed, measurable requirements without introducing new product behavior.
- Treat requirement revisions that only clarify or test the approved Phase 1 behavior as pre-approved within this grant.
- Keep every provider-dependent value marked `INTEGRATION_PENDING` and fail closed until official, versioned Robinhood and Programmable evidence exists.
- Keep Product Phase 2 and Product Phase 3 behavior outside the effective Phase 1 specification.

## Exclusions

- Product Phase 2 and Product Phase 3 behavior.
- Architecture, feasibility, red-team, task planning, build, and ship phases.
- Production implementation.
- Pushes, pull requests, and other external writes.
- Spending, secrets, signatures, deployment, broadcast, and any on-chain action.
- Gate overrides and scope changes.

## Hard stops

The grant never authorizes external writes, spending, secret access, signatures, deployment, broadcast, on-chain actions, gate overrides, or scope changes. Any such action requires a new explicit owner decision.

## Scope note (2026-08-30 policy update)

This grant predates the AGENTS.md baseline adopted later on 2026-08-30. Under that baseline, phases chain automatically on PASSED gates, and pushing codex/ branches plus opening or updating draft pull requests is always allowed — neither needs a grant anymore, so the phase and push/PR exclusions above no longer apply. Everything else stays excluded: merging to main, spending, secrets, signatures, deployment, broadcast, on-chain actions, gate overrides, and scope changes still require explicit owner action.
