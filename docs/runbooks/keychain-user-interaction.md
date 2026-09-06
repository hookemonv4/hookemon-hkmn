# Keychain user interaction unavailable

## Detection

- Alert reason: the external signer returns `User interaction is not allowed`, another retained OS error, or a timeout during sign-only readiness or signing.
- Journal state: the prepared transaction remains unsigned and the cycle records `HELD_UNAVAILABLE`.

## Safe stop

- Mark the path unavailable and do not invoke a live runner before another signing boundary. An execution-pause control is planned (WP10b).
- Do not export a key, switch to an unapproved signer, or broadcast bytes without a verified signature.

## Runner behavior

- The signer retains bounded, redacted OS error text, enforces its timeout, and stops before
  broadcast. The stage records `NOT_SENT` and holds the cycle `HELD_UNAVAILABLE`.
- The runner refuses a replacement signature while the prepared request remains unresolved.

## Operator recovery

- Restore an interactive macOS Keychain session or its access control, then run
  `node packages/adapters/bin/hookemon-wallet.mjs probe --identity operations-evm` or the matching
  `operations-solana` identity.
- Reconciliation control is planned (WP10b) after readiness is clear. A resume control for this recovery path is planned (WP12); no signing bypass is allowed.

## Escalation

Escalate the retained error class, signer role, cycle identifier, and journal digest to the macOS keychain administrator and signing owner. Do not include credentials or raw requests.

## Evidence

- Failure-matrix cell: `External signer:keychain-interaction` expects `HELD_UNAVAILABLE` and is owned by WP08a.
- Traceability: L3-M17 and L4-M5.

## Recovery contract

Failure-matrix cells: External signer:keychain-interaction
Owning work package: WP08a
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=NOT_SENT; next=owner-decision
Test: packages/adapters/test/app/stage-driver.test.mjs — holds a keychain interaction denial with redacted OS text before any broadcast
Alarm reason/code: OPEN FACT (WP08a): no dedicated alert code is emitted for a signing error.
Resume command: none supported; restore signer readiness before a new signature is prepared.

## Proposed revision 66 (not implemented; not canonical)

`decisions/ADR-0025-bounded-transient-recovery-classification.md` splits this
single canonical cell into two proposed cases that must not share one tuple,
because a timeout cannot prove a signature was not returned the way a
synchronous denial can:

- **Provable denial before any signature could exist**
  (proven-pre-effect-transient): no broadcast occurred, so an owner decision
  is not required to make progress. Proposed target: `terminal=null`,
  `attempt=NOT_SENT`, `next=retry-after-signer-readiness` — persist a
  bounded, redacted signer-unavailable reason and next retry time, probe the
  same approved signer identity after bounded backoff, then retry the
  identical request once readiness returns. This never exports a key,
  substitutes a signer, or creates a new request.
- **Timeout, or any outcome that cannot prove no signature was returned**
  (effect-ambiguous, new proposed cell
  `External signer:keychain-interaction-timeout`): a signature might have
  been produced. Proposed target: `terminal=null`, `attempt=NOT_SENT`,
  `next=reconcile-before-retry` — observation-only, no new signature or
  provider mutation until canonical reconciliation resolves the durable chain
  attempt.

No implementation exists yet for either case, and the current build does not
distinguish them; the current, canonical control above (recorded unchanged in
`docs/audit/2026-09-04/failure-matrix.json`) records a redacted `NOT_SENT`
denial for both while the scheduler treats the thrown error as generic
`TICK_FAILED` with 5s-to-300s outage backoff, and the specific reason is not
durable or UI-visible after restart. Both proposed rows are recorded in the
non-canonical
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`,
not in the canonical matrix. This section is a draft citation only — do not
resume a held cycle against it until the revision is owner-approved through
`gates/spec.json`'s `S5` item and this specific behavior is implemented and
tested.
