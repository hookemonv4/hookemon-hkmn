# Phase 1 Shared-Schema Completeness Grant

## Owner authorization

The owner approved the following unambiguous authorization on 2026-08-30:

> JA, PHASE-1 SHARED-SCHEMA COMPLETENESS GENEHMIGT

## Authorized target

Complete the shared schema freeze required by the already approved Phase 1 tasks. The P1-001 artifact may grow beyond a previously counted interface set when named Phase 1 completeness requires it.

The authorization includes:

- every callback selected by the approved Hookemon permission mask, including initialization and swap callbacks;
- exact official callback selectors, tuple components, packed deltas, signs, ordering, and static-fee boundaries;
- the token-issuance interfaces already consumed by P1-003;
- recursive ABI, event, read-interface, schema, and digest verification;
- explicit downstream ownership and production-blocking status for behavior that P1-001 cannot prove locally; and
- test-first closure of interface, custody, PoolKey, proof, and source-boundary inconsistencies found during P1-001 review.

## Exclusions

This grant does not authorize:

- Product Phase 2 or Phase 3 behavior;
- a new product requirement, economic rule, role, administrator, pause path, upgrade path, or recovery authority;
- deployment, submission, approval, launch, signing, broadcast, publication, push, pull request, or another external write;
- spending, secret access, credential use, or an onchain action;
- a gate override or a `NOT_APPLICABLE` classification; or
- treating an unresolved provider, runtime, custody, fee, route, buyer, or settlement fact as production-ready.

## Completion rule

The implementation remains fail-closed. Schema completeness can pass locally while production remains blocked. P1-001 may produce a candidate only after targeted RED-to-GREEN evidence, regenerated artifacts and digests, a clean staged diff, and independent review against the exact candidate.

## Scope note (2026-08-30 policy update)

This grant predates the AGENTS.md baseline adopted later on 2026-08-30. Under that baseline, phases chain automatically on PASSED gates, and pushing codex/ branches plus opening or updating draft pull requests is always allowed — neither needs a grant anymore, so the push and pull-request exclusions above no longer apply. Everything else stays excluded: merging to main, spending, secrets, signatures, deployment, broadcast, on-chain actions, gate overrides, and scope changes still require explicit owner action.
