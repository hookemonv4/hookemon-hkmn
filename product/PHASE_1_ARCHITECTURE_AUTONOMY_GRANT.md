# Phase 1 Architecture Autonomy Grant

## Owner approval

On 30 August 2026, the owner unambiguously answered `ja` to the proposed architecture-only autonomy scope.

## Target

Complete the v4 framework Architecture phase and reach a passing Architecture gate for Hookemon Product Phase 1 only.

## Included decisions

- Derive stable module boundaries, dependency direction, provisional interfaces, operational failure questions, project risk classes, trust boundaries, abuse cases, and module contract cards from the approved Phase 1 specification.
- Treat architecture revisions that only clarify or partition already approved Phase 1 behavior as pre-approved within this grant.
- Keep every provider-dependent value `INTEGRATION_PENDING` and keep all interfaces `PROVISIONAL` until feasibility evidence freezes them.
- Preserve the approved single immutable custody boundary and keep Product Phase 2 and Product Phase 3 behavior non-operative.

## Exclusions

- Feasibility, red-team, task planning, build, and ship phases.
- Product Phase 2 and Product Phase 3 behavior.
- Production implementation.
- Pushes, pull requests, and other external writes.
- Spending, secrets, signatures, deployment, broadcast, and any on-chain action.
- Gate overrides and scope changes.

## Hard stops

The grant never authorizes external writes, spending, secret access, signatures, deployment, broadcast, on-chain actions, gate overrides, or scope changes. Any such action requires a new explicit owner decision.

## Scope note (2026-08-30 policy update)

This grant predates the AGENTS.md baseline adopted later on 2026-08-30. Under that baseline, phases chain automatically on PASSED gates, and pushing codex/ branches plus opening or updating draft pull requests is always allowed — neither needs a grant anymore, so the phase and push/PR exclusions above no longer apply. Everything else stays excluded: merging to main, spending, secrets, signatures, deployment, broadcast, on-chain actions, gate overrides, and scope changes still require explicit owner action.
