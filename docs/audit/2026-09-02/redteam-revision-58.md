# Red-team refresh, requirements revision 58 (WP-26)

Fresh-context STRIDE pass over every new surface this revision introduces: automation,
escrow, chunked payout, open-router/optional-hookData, and the distribution-signer/verifier
split. Reviewer did not author WP-02..WP-36. Report only — no product code changed.
Full detail: `qa/redteam/revision-58-findings.json`, classified findings and dispositions:
`decisions/redteam/findings.json`.

## Headline result

The design's core money-safety claim for this revision — "a compromised worker host can
never redirect a cycle's payout on its own" (design.md section 2.3) — does not hold against
the code as merged. Two critical, independent gaps combine to defeat it:

1. **No on-chain check of the distribution-signer/verifier pair.** `PegCycleVault.authorizePayout`
   and `PayoutCommitment.commitPayoutChunk` trust `msg.sender == pegCycleVault.authorizer()`
   alone. The vault-authorizer identity is the always-on worker's own key
   (`packages/adapters/src/app/stages/funding.mjs` and `payout.mjs` both sign with
   `signerClient.evm`). That one key can author and commit an arbitrary payout manifest and
   settle it to itself. (RT-R58-01)
2. **The off-chain verification keys are public.** `packages/runner/src/distribution/manifest.mjs`
   checks a distribution-signer approval and a verifier receipt against two hardcoded Ed25519
   public keys. The matching private keys are committed in plaintext in this repository's own
   test fixtures (`packages/runner/test/cycle/fixture-crypto.mjs`,
   `packages/runner/test/distribution/manifest.test.mjs`) and are never overridden by a
   production key anywhere in the live path. (RT-R58-02)

Either gap alone lets a single actor redirect a cycle's entire returned proceeds; together
they mean the two-key custody split (decision D7) provides no real protection today. This
directly violates WP-26's own acceptance criterion — no finding may show a path for one
compromised key to redirect proceeds — so that criterion is **not met** by the code as
currently merged.

## Directed tests, both closed clean

- **Can the open-router/optional-hookData relaxation (WP-05) bypass fee accrual?** No. Fee
  collection and liability accrual are derived from the pool's own authenticated balance
  delta, never from hookData; `swapRouter` is dead state, unread outside the constructor.
- **Can a DEGRADED or quarantined balance be swept?** No. `PegCycleReturnEscrow` exposes only
  `sendOutbound`/`sendPayout`, both vault-gated by a lifecycle state machine that never lets a
  DEGRADED (or FAILED) cycle's escrow re-enter `FUNDED` or `RETURNED`. No rescue/sweep
  function exists anywhere in the escrow, vault, or route executor.

## Additional findings

- **RT-R58-03 (medium, availability):** the composition root has only one EVM signer role,
  used for both the vault-authorizer calls and the operations-trigger call — but the contract
  requires those to be different addresses. As composed, no configuration lets a live cycle
  complete both `authorizeFunding`/`authorizePayout` and `executeOutbound`. Fails closed, does
  not enable redirection, but blocks the live path entirely.
- **RT-R58-04 (medium, trade-off):** `recordDegradedReturn`'s `acceptDegraded` flag is trusted
  from the authorizer with no on-chain check that a real human confirmation happened, as
  design.md section 2.5 requires operationally. Can freeze funds, never steal them.
  Recommend naming this trust boundary explicitly in the ADR-0021 text if left as-is.
- **RT-R58-08 (in progress, referencing WP-37):** the live holder-snapshot builder excludes
  only the vault, hook, and current escrow — not pool, treasury, or prior escrows. WP-37 (not
  yet merged onto this branch) already scopes this fix; tracked here, not re-derived.

## RT-R55-02/05/06, re-scoped

- **RT-R55-02** (compromised Operations can release the full process liability, no on-chain
  cap): unchanged, still open. The new standing-authority caps are an off-chain policy check
  only.
- **RT-R55-05** (durable proof recovery): unchanged, still open. WP-27's durable cycle store
  fixes a different, operational ~16-cycle ceiling, not public manifest retention/recovery.
- **RT-R55-06** (production router proof): partially mitigated, still open. WP-05 removes the
  pool's dependency on one specific router; WP-24's pinned-block and current-head fork suites
  prove the real PoolManager callback path. What remains is a genuine live confirmation once
  Programmable's chain-4663 profile is launch-ready — blocked on external readiness, not code.

## Scope note

This review covers the tree as merged through WP-36 (composition root, signing subsystem,
production evidence profile, escrow observation, all eight live stage paths). WP-37 is
in flight on a separate branch and is not re-derived here — see RT-R58-08.
