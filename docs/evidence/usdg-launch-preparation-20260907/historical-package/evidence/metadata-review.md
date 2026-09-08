# Public metadata review

Scope: supplied source copies only; no current-chain verification, repository edits, tests, secrets, or network requests. All paths below are relative to `/private/tmp/hookemon-mainnet-readiness-20260907/preflight-inputs/`.

## Proposed editorial tags

`Hookemon`, `HKMN`, `Robinhood Chain`, `Uniswap v4`, `USDG`, `Gacha`, `Collectible Cards`.

These are proposed public discovery labels, not fields in a Programmable request. No supported provider tag schema is established by the supplied metadata. `Gacha` and `Collectible Cards` describe the stated project purpose, not verified live operations. Do not use `Bonding Curve`, `Guaranteed Yield`, `Passive Income`, `Zero Fees`, or `Live` as launch claims.

## Conservative description proposal

“Hookemon is a gacha card project with the HKMN token. Its planned USDG market on Robinhood Chain uses a Uniswap v4 hook to collect trading fees for card operations, treasury and Programmable.”

This is an editorial proposal, not an approved replacement for the owner text. The existing description's intended holder-proceeds model can be preserved separately as a project intention: “The project intends to buy and open packs, sell the cards and distribute proceeds to HKMN holders.” Do not describe that full cycle as operational until the collector and bot evidence supports it.

## Verified economic model in the supplied release

`git/release/phase3/launch-inputs.json` records chain ID 4663, a USDG/HKMN Uniswap v4 pool, fee field 0, tick spacing 60, and full-range position ticks -887220 to 887220. This is a seeded liquidity pool, with pool price evolving through swaps; no separate issuance/redemption bonding-curve contract is evidenced here. The zero pool fee field does not mean fee-free trading: `compiler-sources/src/accounting/FeeAccounting.sol` defines 300 basis points of gross executed USDG, split into 250 bps process, 40 bps treasury and 10 bps Programmable. Fees use carried fractional remainders, so an individual atomic fee should not be represented as a simple independently rounded 3% multiplication. `compiler-sources/src/market/CanonicalMarket.sol` binds the canonical zero-fee pool and fee collection.

`compiler-sources/src/launch/HKMNToken.sol` fixes one billion HKMN, 18 decimals, with the complete supply allocated once to the canonical market. Initial receipt by the hook and final position mint are distinct steps. The supplied release contains a historical 240 USDG seed and both possible currency orderings. It leaves the selected ordering, pool key and pool ID unresolved pending address derivation. Do not present those historical price/liquidity values as the current funding decision, or equate USDG quantities to dollars.

## Metadata claims requiring correction or qualification

1. The current description says the project “buys ... opens ... sells ... pays” in the present tense. The supplied hook exposes role-controlled process claims and internal liability accounting; these sources alone do not prove the live purchase, sale and holder distribution cycle. In particular, internal payout-ledger primitives are not proof of a working public holder payout service.
2. “Trading fees fund the packs” omits the treasury and provider allocation. The process receives 2.5 percentage points of the 3% fee rate; the other 0.5 points go to treasury and Programmable. The text should avoid suggesting every fee unit buys packs.
3. `derived/projectMetadata.json` calls name and symbol `not-deterministically-extractable`. In the supplied `HKMNToken.sol` they are explicit constant strings, `Hookemon` and `HKMN`. That generic binding label should not be repeated as a claim that the source name is unknown. Retain post-deployment readback and exact bytecode binding requirements; source inspection alone does not establish a deployed identity.
4. The release icon OPEN_FACT is older than the derived image descriptor: the latter supplies a 512×512 PNG, 172568 bytes, SHA-256 `d21a88989a104f6534741861cb9966bf0d3b12fe86457d73d143de2fe83ed2ad`, pinned to commit `9b5161749dbbf50a92c4b17e96e3f2102deb9898`. This review reads that descriptor and does not independently re-hash or fetch the image. No banner is established by these two JSON files.
5. Website `https://hookemon.com` and X `https://x.com/hookemon4` are declared links. The supplied copies establish their intended use, not current availability or account control.
6. The source's fixed-supply allocation supports a one-billion-supply statement, not claims that all tokens are already pooled, launch is complete, a quoted initial price is final, or LP custody has already been deployed and bound.

No provider tags field, route override, current target address, signer payload, or spending approval is inferred by this review.
