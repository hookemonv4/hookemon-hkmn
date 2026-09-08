# Phase 3 incident runbooks

Use these runbooks before resuming a held cycle or resolving a held position.
Each one records the detection signal, safe stop, automatic runner behavior,
operator recovery boundary, escalation point, and the evidence that proves the
expected result.

Current controls are named exactly. A control marked `planned (WP12)` or
`planned (WP10b)` does not exist yet and must not be substituted with an
ad-hoc transaction or dashboard action.

A runbook's own body describes the current, implemented behavior. A "Proposed
revision 66" section, where present, describes an unapproved
`specs/requirements.json` revision-66 candidate whose only authority is the
owner's `S5` approval receipt for the exact requirements hash (`gates/spec.json`).
That is separate from whether the runtime already implements the described
target: for the held-position sections below, most of the target behavior is
already implemented and tested at this head, and revision 66 mainly catches
the frozen spec text up to it; for the four transient-recovery runbooks
(expired quote, blockhash expiry, lease expiry, keychain interaction), the
proposed target is not implemented yet. Each section says which is true; do
not assume either without checking.

## CI

- [Fork proof](ci-fork-proof.md)

## Relay

- [Delay](relay-delay.md)
- [Partial finalized delta](relay-partial.md)
- [Refund finalized delta](relay-refund.md)
- [Late finalized delta](relay-late.md)
- [Wrong asset](relay-wrong-asset.md)
- [Wrong-asset finalized delta](relay-wrong-asset-finalized.md)
- [Expired quote](relay-quote-expired.md)

## Collector

- [Already opened](collector-already-opened.md)
- [Missing mint after an unknown open](collector-missing-mint-sent-unknown.md)
- [Timeout](collector-timeout.md)
- [Schema drift](collector-schema-drift.md)
- [Blocked request](collector-blocked.md)

## Solana

- [Blockhash expiry](solana-blockhash-expiry.md)
- [EVM dropped transaction](evm-transaction-dropped.md)
- [EVM replaced transaction](evm-transaction-ambiguity.md)
- [EVM nonce interference](evm-nonce-interference.md)
- [RPC 429](solana-rpc-429.md)
- [Dropped transaction](solana-dropped-transaction.md)
- [Missing associated token account](solana-ata-missing.md)

## Robinhood RPC

- [Latest-only response](robinhood-rpc-latest-only.md)
- [Reorganization](robinhood-rpc-reorg.md)
- [Incomplete logs](robinhood-rpc-incomplete-logs.md)

## USDG and pool controls

- [Paused USDG](usdg-paused.md)
- [Frozen USDG account](usdg-frozen.md)
- [USDG implementation change](usdg-upgraded.md)
- [Nonzero pool protocol fee](pool-protocol-fee.md)

## Cycle and payout controls

- [Provider pre-call failure](provider-pre-call-failure.md)
- [Standing authority replay after expiry](standing-authority-replay-after-expiry.md)
- [Keychain interaction denial](keychain-user-interaction.md)
- [Crash after provider call](provider-call-journal-crash.md)
- [Lease expiry during mutation](lease-expiry-mid-mutation.md)
- [Repository state-directory loss](repository-state-directory-loss.md)
- [Held epic card](epic-card-held.md)
- [Epic threshold equality](epic-threshold-equality.md)
- [Wrong transaction recipient](transaction-policy-wrong-recipient.md)
- [Frozen payout recipient](payout-recipient-frozen.md)
- [Holder count above payout envelope](payout-holder-envelope.md)
- [Unattributed deposit](unattributed-deposit.md)

## Held positions (implemented at this head; documented by proposed revision 66)

Most of this section describes runtime behavior that is **already implemented
and tested** at this exact head, not a future change: `recordHeldPosition`
carves an unresolved card into its own attributed position without
terminally holding the cycle, a completed cycle already retains open
positions for supplementary recovery, and the first accepted `sell` decision
for a position already creates one position-keyed supplementary settlement
atomically (see `packages/adapters/src/app/cycle-repository.mjs`, and the
`Held position:*`, `Claim admission:*`, `Cycle settlement:*`, and
`Cycle custody:*` cells in `docs/audit/2026-09-04/failure-matrix.json` for the
exact passing test citations). Requirements revision 66 exists mainly to
bring the frozen `specs/requirements.json` text — which previously said "a
held card blocks new claims" — into agreement with that already-built
behavior, so that a held or unknown card is documented as not blocking the
settled portion of the same cycle's return and payout. The two exceptions,
called out below, are genuinely unimplemented. This section previews the
revision-66 wording; the requirements text itself is authoritative for the
proposal's exact language and is not yet owner-approved.

- Detection: an open held position shows its reason class, terminal state,
  age, attributed cycle, evidence digest, and position revision. A cycle can
  legitimately be `COMPLETED` while a held position remains open and its
  settled cards have already paid out.
- Limit refusal: `HELD_LIMIT` means the open-position count has reached
  `maxHeldPositions` (capped at 10, the verified capacity-safe value for the
  16-entry DurableCycleStore — a higher configuration is refused, not merely
  discouraged) or the attributed USDG control value exceeds
  `maxHeldValueMicroUsdg`. Do not bypass the refusal with a new claim; resolve
  a position or adjust the owner-controlled limit configuration instead.
- Decision: request `sell` or `keep-holding` for one position, bound to its
  evidence digest and position revision. `keep-holding` leaves the position
  counted against the limits without releasing custody. The first accepted
  `sell` request atomically creates that position's own supplementary
  settlement exactly once; an exact replay returns the same settlement, a
  conflicting or later `sell` for that position fails, and a resolved
  position can never create a second one. It never authorizes a manual
  provider request or transfer.
- Supplementary payout: the position-scoped settlement reuses the original
  cycle's frozen eligibility snapshot and pays from a manifest distinct from
  the main cycle's payout. It becomes immutable at its first broadcast. The
  finalized position return and any permitted dust are bound to one atomic,
  position-aware consumption record shared by every supplementary manifest
  for that position, so at most one supplementary manifest is ever funded per
  held position and per return source.
- Late resolution: a position whose provider mutation stayed `SENT_UNKNOWN`
  past the configured deadline can later be recorded sold, refunded, or never
  sent from durable evidence. OPEN FACT: no production observation-only
  provider reconciler yet collects that evidence automatically; until it
  exists, keep the position open and do not resend the provider mutation.
- Escalation: escalate a missing, conflicting, or stale evidence record, or an
  unexpected cross-cycle attribution, to the cycle owner with the position ID,
  cycle ID, and durable evidence references.

Every semantic-invalid whole-cycle class is unrelated to card separation and
unchanged by this proposal: wrong-asset and wrong-recipient transaction-policy
holds (Wrong transaction recipient, above), cross-cycle attribution failure,
conflicting canonical evidence, an unattributed deposit, missing predecessor
evidence, and a snapshot failure all keep their existing terminal whole-cycle
`HELD_*` owner-decision runbooks unchanged.

- [Held pack and continuing cycle](held-pack-cycle-continuation.md)

- [Held-position admission limits](held-position-admission-limits.md)

- [Supplementary payout restart](supplementary-payout-restart.md)

- [Unknown card mutation deadline](card-mutation-deadline.md)

- [Late held-position resolution](held-position-late-resolution.md)

- [All cards held settlement](all-cards-held-settlement.md)

- [Interleaved held custody](interleaved-held-custody.md)
