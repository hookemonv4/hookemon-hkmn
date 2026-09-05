# Hookemon

Hookemon is a clean-room project for a programmable launch on chain ID `4663`.

## Current product state

Product Phase 3 is open at requirements revision `60` and architecture revision `7`. It specifies an Operations-wallet money path: the immutable hook retains the 2.5% process liability, current Operations can claim it under a bounded six-hour rolling policy, and a separate Operations Solana identity runs the external leg through a journaled policy-controlled runner.

The runtime set is content-addressed. It includes the immutable token, hook, permanent launch-position custody, and the bounded external operations path. The prior vault, escrow, route, commitment, settlement, and Merkle family remains frozen source evidence and is not deployed in Phase 3.

The fee design uses gross USDG quote volume across all supported swap forms, independent 10/40/250 basis-point lifetime remainders, and whole-swap reversion for partial fills. The launch path permits hook-self initialization only inside the authorized atomic transaction that initializes, mints through Permit2, settles, binds the actual position to permanent custody, and stamps launch completion.

Offchain execution has one authoritative `CycleRepository`, a policy engine, semantic transaction allowlisting, and exactly two external signing identities. A cycle follows `claim-process`, `outbound`, `purchase`, `open`, `epic-gate`, `buyback`, `return`, and `payout`. Holder eligibility freezes at a finalized block before claim; payout is direct USDG transfer from the frozen manifest after a finalized cycle-attributed return.

`repairMergeEligible` measures code and integration readiness. `launchEligible` additionally requires provider admission, deployment-manifest verification, operational canaries, and separately governed live prerequisites. Neither state authorizes deployment, signing, broadcast, spending, or publication.

## Open facts

FEE-01 remains open pending provider-bound confirmation of the platform recipient, rate, basis, rounding, accrual, and claim mechanism. The plan default remains the 10/40/250 split within 300 basis points; fee- and graph-dependent work waits for that confirmation. Provider bindings, launch admission, archive-log evidence, and the live insured-value field mapping remain evidence work, not assumptions.

## Source boundary

Only current `product/`, `decisions/`, `architecture/`, `specs/`, `gates/`, and `protocol/` artifacts can become normative for this product. Historical repository content is retained solely for recoverability and technical study.

See [product/SOURCE_BOUNDARY.md](product/SOURCE_BOUNDARY.md) and [decisions/ADR-0022-operations-wallet-money-path.md](decisions/ADR-0022-operations-wallet-money-path.md).

## Security

Do not commit credentials, private keys, seed phrases, signing payloads, or private operator data. A credential exposed in chat or logs is compromised and must be rotated before use.
