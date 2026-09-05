# ADR-0021: Autonomous cycle authority

## Status

Proposed. Requirements revision 58 records this decision's normative requirements now; this ADR itself, the standing signing-authority grant it depends on, and the distribution-signer/verifier key assignment all require a separate, explicit owner signature (`decisions/owner-approvals/revision-58-standing-authority.json`, currently an unsigned draft) before any autonomous action may run live. This ADR alone authorizes no deployment, credential, signing, broadcast, asset movement, spending, or publication.

## Context

Phase 1 and revision 57's Phase 2 increment require a human to trigger every cycle stage. The owner wants a fully autonomous loop: an unattended scheduler that opens cycles, buys and opens a Collector Crypt pack, sells it through the standard buyback, bridges proceeds back, and pays holders pro rata, on a fixed interval, within owner-approved caps, stoppable at any time.

Granting a scheduler standing signing authority is a genuine increase in what an always-on, network-reachable process can do compared to today's model, where every mutation needs a fresh human signature. This ADR states exactly what changes and, as importantly, what does not: every autonomous action still passes through the same schema-bound, domain-separated, single-use authorization and the same durable journal that a manual action already requires. Autonomy changes *who* produces that authorization. It does not remove the requirement, and it does not add a new kind of authority that today's reviewed trust-boundary catalogue does not already contemplate.

## Decision

### Five-identity custody model

No autonomous action collapses two of the following identities into one key, and no identity below moves value outside the checks REQ-cycle-control-1 and REQ-process-budget-1..6 already require:

1. **Operations trigger** — the scheduler process's own hot identity. It calls `openPegCycle`/`executeOutbound`-adjacent functions but can never equal `cycleVaultAccount` or `policyAccount` (`packages/runner/src/cycle/bindings.mjs:validateCycleCustody`, unchanged). It only triggers; it never holds principal.
2. **Vault authorizer** — the identity that signs `authorizeFunding`, `authorizePayout`, and `recordDegradedReturn` on `PegCycleVault`. A policy-constrained signer, logically separate from Operations, bounded by the vault balance and the immutable route executor.
3. **Policy-bound execution signer(s)** — one EVM signer and one Solana signer, schema-bound (`allowedDestinations`/`allowedFunctions`/`allowedAssets`/`maxAmount`). They sign and broadcast the outbound (buy pack) and return (bridge back) legs and never receive raw key material in their own configuration.
4. **Distribution-signer and verifier** — the pair that approves which addresses receive one cycle's entire returned proceeds. Per the owner's binding correction to the original synthesis draft (recorded here because it changes the custody story materially): the **distribution-signer signature is produced by the worker's own automated process**, not by a separate owner-held key. The **verifier is a separate, independently automated process holding its own key, designed to run on a different host from the worker**, which independently recomputes the snapshot and manifest from chain data and signs only on an exact match against the worker's candidate. No human signs per cycle by default. An optional manual/human-signed verifier mode may exist as an operator override; it is never the default path, and the ADR's default-live configuration does not depend on it existing. This is a deliberate correction from an earlier synthesis draft that assumed both halves were owner-held — the owner corrected that reading before this revision was authored, and REQ-distribution-2 states the corrected behavior.
5. **Owner standing-authority key** — a distinct, higher-privilege key that appears only in (a) this ADR's own one-time owner approval, (b) periodic re-approval of spend caps, and (c) the manual, cryptographic "kick a stuck cycle" `supersedeUnobservedIntent` path, which stays deliberately heavy (a manual unstick, not a dashboard button).

No key in this list is ever also the Programmable-fee-liability claim key (`0x4957f49620AFf3Adbbe8195a4f633E49cc93376c`) or the treasury claim key; those claim paths stay fully separate and are never automated. The always-on worker holds identities 1, 2, the Solana leg of identity 3, and the distribution-signer half of identity 4. It never holds the treasury or Programmable claim keys, the owner standing-authority key, or the verifier's key.

### Two-layer kill switch

1. **Off-chain, immediate:** a `paused` boolean in the operator state file. The scheduler checks it before starting any new cycle-triggering call; an in-flight cycle finishes its current stage — never a hard-kill mid-transfer — and then halts. This is the dashboard's pause control (REQ-dashboard-2).
2. **On-chain, structural:** the vault authorizer and policy-wallet signer keys are the actual capability to move money. Revoking or rotating them, through the already-implemented two-step `MoneyRoles.sol` handover, is the real kill switch. Revocation is checked by the signer service on every signing request, never cached, so a compromised worker host cannot patch around a stale in-process authority check.

Neither layer recalls an already-broadcast transaction. The safety property is: caps stay small, every step is schema-bound before signing, and a paused scheduler plus revoked signer authority stops the *next* cycle stage from starting.

### No new on-chain pause role

One candidate design for this revision proposed a new on-chain `guardian` pause role on `ProcessBudget`. This ADR does not adopt it. `architecture/trust-boundaries.md`'s **TB-07 (`privileged-identity-to-bounded-method`)** states explicitly that the minimal caller matrix has "no unintended success and no V1 admin, automation, or pause role." A revision that wants a new privileged role must amend TB-07 directly, with its own rationale and its own red-team pass — not introduce the role through an unrelated automation ADR that never engages the boundary it would weaken. This ADR keeps TB-07 exactly as written and relies only on the two-layer kill switch above, which uses mechanisms the existing trust-boundary catalogue already reviewed (off-chain pause flag, on-chain key revocation via the already-audited `MoneyRoles.sol` handover). If the owner later wants a true on-chain circuit breaker, that is a distinct, explicitly-scoped follow-up that amends TB-07 by name, with its own ADR and its own red-team pass.

### Autonomy changes who signs, not what is checked

Every field REQ-cycle-control-1's manual authorization already requires — requirements revision, binding-manifest digest, chain, hook, vault, cycle identifier, nonce, Operations trigger identity, exact amount, route and request digests, return destination, gas caps, minimum receives, and expiry — is still present, still checked, and still journaled on every autonomously triggered stage under REQ-cycle-control-2. The only thing that changes is that a policy-bound signer produces the signature on a scheduler's trigger instead of a human producing it on demand. `packages/runner/src/cycle/bindings.mjs:validateCycleCustody` and the exact-authorization checks in `PegCycleVault.sol` are unchanged by this ADR; REQ-cycle-control-2 is additive to REQ-cycle-control-1, not a replacement for it.

### Caps and defaults

The first live standing authority is capped at one $25 pack purchase plus bridge fees per cycle, a maximum of 72 cycles per day, and both figures are dashboard-editable within the ceiling this ADR's owner-approval grant sets — the dashboard can tighten either cap but cannot widen it past what the signed standing authority allows. Chunked payouts (REQ-payout-commitment-7/8) ship built and tested but inactive (chunk count fixed at one) at first launch; dust from floor-rounding carries forward into the next cycle's distributable pool rather than being swept anywhere.

## Supersession

This ADR supersedes only:

- ADR-0018's "no scheduler, no continuous or unattended operation" clause, specifically and only for the Phase 2 autonomous increment this ADR and its accompanying owner-approval grant authorize. ADR-0018's deferral of the dashboard as a Phase 1 obligation, and its `REQ-dashboard-1` permanent-reservation clause, are untouched — `REQ-dashboard-1` stays reserved; the new dashboard requirement is `REQ-dashboard-2`.
- ADR-0019's exact-zero `recordTerminalFailure` clause, specifically and only for the degraded-return quarantine path REQ-process-budget-6 adds (`recordDegradedReturn`). ADR-0019's immutable custody, exact-authorization, trigger-only-Operations, and payout-conservation decisions remain in force unchanged.

Every other prior ADR (0001 through 0020) remains fully in force. Nothing in this ADR touches the fixed HKMN supply, the zero-LP-fee market, the Merkle-sum payout conservation invariant, the minimal role matrix, or the immutable-successor lifecycle.

## Alternatives

### Add a new on-chain guardian/pause role

Rejected. See "No new on-chain pause role" above — it would silently amend TB-07 without engaging it, which is exactly the failure mode the trust-boundary catalogue exists to prevent.

### Owner-held distribution-signer and owner-held verifier (the original synthesis draft's framing)

Rejected by the owner's explicit correction. Two owner-held keys for every cycle would make full autonomy impossible in practice — a human would need to act on every single payout, which is the manual bottleneck this ADR exists to remove. The adopted model keeps the verifier genuinely independent of the worker (a separate process, a separate key, ideally a separate host) while letting the distribution-signer half run unattended, so autonomy is real without collapsing the dual-builder requirement into one actor.

### Fold the vault authorizer into the same automated layer as Operations with no held-back check

Rejected. This was the single sharpest gap an earlier design comparison identified: a compromised worker host that is also the sole authority over payout could both compute a fraudulent manifest and authorize its own payout for it. Keeping the verifier's key off the worker host, and keeping identities 1-3 structurally distinct from the owner standing-authority key, closes that gap.

### No cap, or an owner-named cap higher than the legacy canary's proven scale

Rejected for the first live grant. Starting at the legacy canary's proven one-pack, ~$25 scale and widening only after several observed clean cycles keeps the blast radius of any undiscovered bug small while the automation is new.

## Consequences

- A scheduler may run unattended once the accompanying owner-approval grant (`decisions/owner-approvals/revision-58-standing-authority.json`) is actually signed; until then, every REQ-cycle-control-2 code path ships and passes tests but the signer service refuses to produce a live signature for it.
- The distribution-signer and verifier processes must run as genuinely separate deployments (different keys; the verifier ideally on a different host) before this ADR's default automated mode may go live — a design that runs both on the same host with the same key does not satisfy this ADR.
- `REQ-dashboard-1` stays permanently reserved; `REQ-dashboard-2` is the active dashboard requirement and authorizes only a read-only public surface plus an owner-authenticated config/control surface — never a direct fund-movement route.
- TB-07 is unmodified. Any future request for an on-chain pause role must amend TB-07 directly rather than layer around it.
