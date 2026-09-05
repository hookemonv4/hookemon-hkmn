# Rehearsal Stage

## Purpose

`packages/adapters/src/app/stages/rehearsal.mjs` retains the older collector-only payout helper.
`packages/runner/src/cycle/rehearsal-stage-driver.mjs` is the runner path for bounded rehearsal
cycles. It uses the same durable cycle repository and automation service as production. The fake
profile invokes sealed fake Relay and Collector providers, records their write-ahead transitions,
and never contacts live providers. The helper is selectable only by the declared rehearsal profile;
production never selects it.

## Public interface

- `createRehearsalSkipHandler(stage)` returns probe and reconciliation evidence for a skipped rehearsal leg; its mutation method is unreachable.
- `probeRehearsalPayout({ adapters, config, cycleRepository, context })` reports whether finalized buyback proceeds are observable and whether every configured recipient has a valid associated token account.
- `mutateRehearsalPayout({ liveMode, adapters, config, signerClient, cycleRepository, context })` creates one equal-split payout plan, requires a pinned Solana transaction policy, signs through a guarded Operations signer, and broadcasts the revalidated bytes once only after the active live mutation authority passes.
- `reconcileLiveRehearsalPayout({ adapters, cycleRepository, context })` returns finalization evidence or records an on-chain failure.
- `hookemon-runner run --mode rehearsal --cycles <n> --cap-usdg <atomic> [--collector-only]
  [--restart-inject]` creates immutable rehearsal cycles through the production runner and policy
  engine. `--collector-only` selects the declared fake collector rehearsal providers. A live
  rehearsal profile is refused before signer construction until a dedicated Solana proceeds
  projection and finalized evidence path exist.
- The runner writes one evidence JSON record per completed rehearsal cycle under the state
  directory before it archives the cycle. It contains the cycle ID, persisted fake provider mode,
  finalized attributable deltas, classified residuals, payout conservation result, and
  irreversible-effect identifiers.
- `HOOKEMON_PROVIDER_MODE=fake` is required for the collector-only rehearsal path.
  `HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT` is required and must name a distinct Solana account rather
  than the Operations account or a payout recipient.

## Invariants

- Live rehearsal is unavailable rather than fabricating dedicated-account proceeds evidence. The
  fake profile carries synthetic reconciliation evidence solely to test durable recovery and
  duplicate-effect prevention.
- All recipients and the operator source must have verified associated token accounts with the configured settlement mint and decimals before signing.
- An optional configured priority fee is represented by the standard Compute Budget instructions.
- The stage obtains a usable blockhash before signing and retries that pre-sign read at most once. Once bytes are signed or broadcast, it never creates replacement payout bytes.
- The stage binds the freshly read `(blockhash, lastValidBlockHeight)` pair and reads current block
  height before signing and again before broadcast. A signer response that changes the plan cannot
  reach `sendTransaction`.
- `config.solana.chainId` and `config.rehearsal.payoutPolicy` are required for a live rehearsal
  payout. Missing policy or chain context fails before the external signer is called.
- The active mutation authority is revalidated immediately before signing and again before broadcast.
- The owning CycleRecord is created with immutable `rehearsal` mode. This helper refuses a
  production cycle, and production services refuse rehearsal cycles.
- The collector-only payout helper is not the production direct-payout or Relay recovery contract.
  It signs and broadcasts one policy-checked Solana transaction, then the stage driver records its
  response. It does not persist a signed-byte approval context for restart rebroadcast; an
  interrupted attempt stays unresolved rather than receiving another signature.
- Recipients receive an equal integer-atomic split; any remainder goes to the first configured recipient.
- The module remains a compiling, fixture-tested rehearsal helper beside the dedicated payout-stage
  implementation; it does not activate production payout behavior.
- Rehearsal and production modes are persisted, mutually exclusive, and never inferred from a
  process-local `liveMode` flag. The policy engine enforces the rehearsal cap, pause controls, and
  applicable manual approval before an effect.
- Rehearsal proceeds use a dedicated Solana settlement account. The fake payout evidence binds that
  account instead of a wallet-wide Operations balance or a provider-reported amount.
- Restart injection records a durable rehearsal session and ends the worker after each
  response-recorded effect boundary. The supervisor starts a fresh worker with the same session;
  the session fixes the cap and cycle count across exits. A `PREPARED` or `SENT_UNKNOWN` fake
  attempt has no response evidence and is never synthesized as reconciled.
- Evidence fails closed unless cycle IDs are unique, every residual is classified, finalized payout
  allocations exactly conserve the observed attributable proceeds, and all irreversible-effect IDs
  are unique.
- The upstream Collector lifecycle keeps `insured_value` untyped until it reconciles the buyback quote against the selected machine's `instantBuyback` rate.
- The gate considers two candidates for the provider value: whole dollars scaled by `10^6`, and an already-atomic value. It floors the candidate multiplied by each rate within one percentage point of the machine value.
- Exactly one candidate must match the typed buyback quote. Zero or two matches produce `HELD_DATA_UNVERIFIED`; the gate records the selected unit and matched rate with the typed insured amount.
- Numeric and numeric-string prize tiers map to Epic, Rare, Uncommon, and Common. A tier and string-rarity conflict produces `HELD_DATA_UNVERIFIED`.
- The owner threshold applies only to an Epic record: hold when `offerAtomic * 100 < insuredAtomic * 40`; equality follows the sell path. The buyback request digest binds the unit reconciliation fields before a provider transaction can be signed.
- Purchase planning records the selected machine's expected card count. The current open path requires exactly one expected card because its independent provider and chain evidence models a single award.
- A response-recorded open without a memo-bound mint holds `HELD_DATA_UNVERIFIED` without retry.
  A `SENT_UNKNOWN` open that cannot prove a mint after its guarded recovery path also holds and
  preserves the original unknown attempt.
- The [EVM API documentation](https://docs.collectorcrypt.com/gacha/evm-api) says that calling `openPack` twice returns the same award. After an open `SENT_UNKNOWN`, the Solana lifecycle permits a guarded retry only when the persisted request digest binds the purchase memo and the returned card address matches fresh memo-bound status evidence.

## State transitions

`rehearsal cycle opened -> fixed operational stages -> write-ahead provider attempts -> reconciled
evidence -> dedicated-proceeds payout evidence -> evidence sealed -> cycle completed`.

Within the collector payout helper, the stage path is `purchase planned card count -> open
memo-bound award -> epic unit reconciliation -> buyback finalized -> payout plan -> active
authority -> PREPARED provider attempt -> policy-checked sign and broadcast ->
RESPONSE_RECORDED(signature) -> finalized signature reconciliation`, or a held failure.

At a restart boundary, the runner reloads the same journal and reconciles the recorded attempt.
Missing accounts, unavailable finalized buyback evidence, an unclassified residual, or an on-chain
failure stop this path without issuing a replacement payout.

## Operational commands

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test --test-timeout=120000 test/app/stages-rehearsal.test.mjs
node packages/adapters/bin/hookemon-runner.mjs run --mode rehearsal --cycles 1 --cap-usdg 25000000 --collector-only --restart-inject
```

## Recovery pointers

- If finality is delayed, leave the recorded signature pending and reconcile it. Do not construct a second payout transaction.
- If a recipient account is missing or malformed, correct the recipient configuration or account provisioning before a new rehearsal attempt.
- `packages/runner/test/cycle/rehearsal-stage-driver.test.mjs` and
  `packages/runner/test/cycle/rehearsal-runner.integration.test.mjs` cover sealed fake-provider
  dispatch, restart recovery, manual-approval gating, and evidence invariants.
- For a Collector unit or rarity conflict, keep the card held and inspect the memo-bound machine, card, quote, and finalized transaction evidence. Documentation excerpts and unresolved-provider facts are recorded in `packages/adapters/test/fixtures/collector-crypt/docs-evidence-2026-09-04.json`.
- For a missing mint, use the [already-opened](../runbooks/collector-already-opened.md) or
  [unknown-open missing-mint](../runbooks/collector-missing-mint-sent-unknown.md) recovery contract;
  neither path authorizes another open request.
- Use `hookemon-runner status --cycle <cycle-id>` after an injected restart. If the payout provider
  attempt is `SENT_UNKNOWN` or a recorded signature lacks finality, reconcile its existing record;
  do not create a second payout, signature, or buyback request.
- If the runner prints `AWAITING_MANUAL_APPROVAL`, submit its exact digest through the approved
  operator-control path and resume that cycle. Then rerun the exact bounded rehearsal command so
  its durable session records the completed evidence and starts only the remaining cycles. The
  digest is bound to the persisted cycle ID and release amount.
