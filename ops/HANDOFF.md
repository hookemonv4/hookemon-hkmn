# Phase 1 Local Operations Handoff

## Status

Local-only preparation; not operating and not live. The repository records build evidence and unresolved blockers, not a deployed service or production-ready release.

## See status

Run `node scripts/v4.mjs status --check` from the repository root. The command refreshes `state.json` and exits nonzero while any authoritative phase is failed, stale, or otherwise non-passing. Read the named gate receipt before acting; a local release-verifier PASS does not override the projected phase state.

## Stop locally

Use Ctrl-C to stop the current foreground verifier or fixture runner. Do not start another action while a journal intent is unresolved; reconcile the recorded state first. No background service or scheduler is configured. The external-action stop record is a policy boundary, not a runtime kill switch.

## Paging

Paging is not configured and therefore fails closed. Nobody is paged automatically. No alert channel has been test-fired, so H2 remains unsatisfied; escalate a blocker to the owner manually without claiming alert coverage.

## Receipts

Gate evidence receipts live under `receipts/`. Gate item projections live under `gates/runs/`, and the aggregate local projection is `state.json`. Local release verification results live under `qa/reviews/`; the induced local failure drill is `qa/drills/induced-failure.json`.

## Authority

This handoff supports local inspection and stopping only. It does not authorize deployment, publication, credential access, signing, broadcast, spending, or a live cycle.
