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

## Proposed revision 66

`decisions/ADR-0025-bounded-transient-recovery-classification.md` splits this single canonical cell into two proposed cases that must not share one tuple, because a timeout cannot prove a signature was not returned the way a synchronous denial can. **Provable denial before any signature could exist** (proven-pre-effect-transient): no broadcast occurred; proposed `terminal=null`, `attempt=NOT_SENT`, `next=retry-after-signer-readiness` — persist a bounded, redacted signer-unavailable reason and next retry time, probe the same approved signer identity after bounded backoff, then retry the identical request once readiness returns; never export a key, substitute a signer, or create a new request.

**Timeout, or any outcome that cannot prove no signature was returned** (new proposed cell `External signer:keychain-interaction-timeout`): proposed `terminal=null`, `attempt=NOT_SENT`, `next=retry-sign-only-with-durable-binding`, scoped **only** to the verified owned Keychain sign-only broker — the checked-in source proves its `sign` operation only deserializes/signs/re-serializes bytes (`packages/adapters/src/signing/keychain-signer.mjs:171-243`, `operations-wallet-keychain-child.mjs:138-206`, `keychain-child-evm.mjs:133-197`) and that a `broadcast` operation sent to the same broker is explicitly refused (`packages/adapters/bin/hookemon-keychain-signer.mjs:203-215`), with every real broadcast wired as a separate later step the broker's `sign()` never reaches (`signer-client.mjs:565-595`, `stages/purchase.mjs:99-117,329-338`). Given that proof, a timeout may retry the identical signing attempt only once the exact unsigned wire bytes, signer role/account identity, request digest, policy/authorization digest, and validity context were durably persisted **before** the sign-only call, reusing those exact values unchanged — never regenerating the provider transaction, blockhash, nonce, memo, or policy — and never asserting the prior attempt produced no signature; a signature from either attempt is deduplicated exactly once by the existing signed-bytes recovery record. This is a bounded-retry guarantee made safe by construction, not a claim that reconciliation can discover an unbroadcast signature — no signer idempotency key or read-by-key API exists anywhere in this repository. It grants no broadcast authority; a subsequent broadcast/provider-send outcome that cannot be distinguished stays its own observation-only `SENT_UNKNOWN` or chain-attempt state. An opaque or external-module signer does **not** inherit this guarantee and keeps the current no-automatic-retry, terminal whole-cycle class, because canonical chain observation cannot recover or rule out an unbroadcast signature for it.

The "Recovery contract" above is the frozen revision-65 contract and the currently deployed fallback: it is binding today and stays binding regardless of whether this proposal is later owner-approved, until an implementation and promoted matrix cells supersede it. Its cited test itself proves only that the low-level `createStageDriver` primitive leaves `terminalState=null`, `NOT_SENT`, and the cycle active/retryable for a synchronous helper denial — not that the frozen whole-cycle hold above is exercised end-to-end, and it does not cover a timeout at all; the current build has no durable pre-invocation binding (Collector purchase keeps unsigned bytes only in process memory), so the sign-only retry above is not implemented. Both unimplemented proposed rows live only in the non-canonical `docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`.

This section is authoritative only once a `decisions/owner-approvals/*` receipt approves the exact current `specs/requirements.json` hash under `gates/spec.json`'s `S5` item AND each case has an implemented, passing, non-`OPEN FACT` citation promoted into the canonical matrix; check both directly rather than inferring either from this document's wording.
