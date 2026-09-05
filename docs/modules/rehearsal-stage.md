# Rehearsal Stage

## Purpose

`packages/adapters/src/app/stages/rehearsal.mjs` and the rehearsal stage driver run the bounded
Collector-only cycle through the ordinary durable repository. A live profile with a verified
transaction-policy bundle performs the Collector purchase, open, and buyback using the Operations
Solana signer, then distributes only the finalized delta from the configured dedicated proceeds
account. Fake providers remain a sealed test path for restart and duplicate-effect coverage.

The stage does not claim funds, bridge assets, or execute an EVM payout. Those legs are explicit
collector-only skips and are not evidence for production settlement.

## Public interface

- `createRehearsalSkipHandler(stage)` records explicit no-op evidence for a collector-only leg that
  the profile excludes from this rehearsal.
- `probeRehearsalPayout({ adapters, config, cycleRepository, context })` verifies the exact
  configured source token account and recipient token accounts before a payout plan is prepared.
- `mutateRehearsalPayout({ liveMode, adapters, config, signerClient, cycleRepository, context })`
  prepares the equal-split payout from the dedicated proceeds account, validates its transaction
  policy, and records the journal state before signing or broadcasting.
- `reconcileLiveRehearsalPayout({ adapters, cycleRepository, context })` accepts only finalized
  source-account and recipient evidence; it does not infer proceeds from a wallet-wide balance.
- `hookemon-runner preflight` is the read-only owner check for the live `collector-only` profile.
  It refuses before provider reads when the trusted execution bundle is absent.
  `hookemon-runner operator initialize-collector-only-policy` creates the exact one-pack policy
  only in an absent dedicated state file.
  `hookemon-runner run --mode rehearsal --cycles 1 --cap-usdg 25000000 --collector-only` executes
  exactly one bounded cycle after manual approval.

## Invariants

- A live rehearsal requires the exact `collector-only` profile, the Operations Keychain child,
  `operator-solana`, and public key `BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE`. The runner
  does not use the legacy rehearsal signer module or read private key material.
- The policy engine requires manual approval before the purchase effect, `maxBoostersPerCycle = 1`,
  a single explicit pack-code allowlist entry, and the `25000000` atomic-unit cycle cap.
- The profile has one typed settlement asset and explicit fee controls. It refuses missing money
  metadata, a changed selected pack price, an insufficient SOL reserve, or an insufficient
  settlement-token balance.
- The proceeds account is an Operations-owned settlement token account, distinct from the
  Operations public key and every recipient. The payout source must match that exact account.
- A buyback becomes available for payout only after a positive finalized balance delta at that exact
  account. Provider-reported proceeds, another token account, and an aggregate wallet balance are
  never substitutes.
- Every recipient must already have the expected token account. Allocations use equal integer
  atomic units, with any remainder assigned deterministically to the first recipient, and must
  exactly conserve the finalized source delta.
- Provider and chain effects follow the durable write-ahead protocol. An uncertain send remains
  `SENT_UNKNOWN`; recovery reconciles the recorded request instead of issuing a replacement effect
  or signature. A card-specific open, Epic, buyback-data, unavailable-buyback, or overdue
  `SENT_UNKNOWN` result is recorded as a held position attributed to the original cycle. Its
  evidence is forwarded through the later card stages without a second provider mutation, while
  any settled card proceeds remain independent.
- The held-position carve-out does not relax the collector-only rehearsal contract:
  `maxBoostersPerCycle = 1` and `maxCyclesPerDay = 1` remain required. A held card never permits a
  second pack, replacement card, or cross-cycle use of its custody value.
- The live profile runs its collector-only canaries and a Keychain sign-only check before it can
  construct a transaction-capable signer. The stage rechecks the request-bound policy at signing
  and broadcast.
- The trusted execution bundle contains process-bound purchase, buyback, and payout policies with
  their rule sidecars, buyback program and recipient bindings, Epic-field bindings, and Solana
  transaction-context resolvers. A template environment cannot construct it.
- Restart injection is a fake-provider test facility. It exercises a process exit after each
  response-recorded irreversible effect without authorizing a second effect.

## State transitions

`policy initialized -> preflight passed -> cycle opened -> manual approval recorded -> purchase prepared -> purchase
reconciled -> open prepared -> open reconciled -> buyback prepared -> buyback finalized at the
dedicated account -> payout prepared -> signed -> broadcast -> recipient finality -> evidence
sealed -> cycle completed`.

Any missing account, policy mismatch, data conflict, incomplete finality, or payout-conservation
failure enters a held or unresolved state. It never advances by using a replacement request.

For an attributable held card, `open`, `epic-gate`, and `buyback` record or forward the same
position evidence without another collector request. The main settlement follows its zero-proceeds
route when every card is held; it does not borrow custody from another rehearsal cycle.

## Operational commands

```sh
cp packages/adapters/rehearsal/rehearsal.env.example "$HOME/.hookemon/rehearsal.env"
. "$HOME/.hookemon/rehearsal.env"
mkdir -p "$HOOKEMON_STATE_DIR"
node packages/adapters/bin/hookemon-runner.mjs operator initialize-collector-only-policy
node packages/adapters/bin/hookemon-runner.mjs preflight
node packages/adapters/bin/hookemon-runner.mjs run \
  --mode rehearsal --cycles 1 --cap-usdg 25000000 --collector-only
```

The detailed manual-approval and recovery procedure is
[`docs/rehearsal/collector-only.md`](../rehearsal/collector-only.md).

## Recovery pointers

- Inspect `hookemon-runner status --cycle <cycle-id>` before `resume`.
- Keep a recorded purchase, open, buyback, signature, or payout pending until its own provider or
  chain evidence resolves it. Do not create replacement bytes.
- At the configured unresolved-card deadline, reconcile a `SENT_UNKNOWN` card into its original
  held position before any replacement request. A temporarily unavailable provider status remains
  unresolved before that deadline.
- Correct a missing recipient account, a refused Keychain interaction, or a configuration mismatch
  before opening a new rehearsal cycle.
- OPEN FACT: available provider material does not prove that the buyback destination field accepts
  an exact Solana token-account address. Resolve it with versioned provider confirmation. Until
  then, the exact-account delta gate is the verified safe alternative and an unmatched result holds
  without payout.
- OPEN FACT: provider evidence does not yet establish transaction policy anchors for the selected
  live purchase and buyback. Resolve it with versioned provider transaction documentation and a
  controlled specimen. Until then, preflight refuses before the Keychain probe or provider read.
