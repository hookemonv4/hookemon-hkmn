# Phase 3 launch handoff

Status: do not sign. This is a deterministic preparation record, not deployment authority. Requirements revision 65 records the owner's 2026-09-05 decision: the complete 1,000,000,000 HKMN supply is allocated to the canonical market and no other HKMN allocation exists. The DRAFT_UNSIGNED revision-65 baseline records subject hashes only.

## Fixed inputs

The launch wallet and treasury beneficiary are `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729`. Operations is `0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384`. The immutable Programmable recipient is `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c` at 10 bps of the 300 bps hook fee; FEE-01 was accepted with the owner on 2026-09-04. The canonical pool uses zero LP fee, spacing 60, and full-range ticks `-887220` through `887220`.

The owner budget is 300 USD. The seed reserves 240 USDG (`240000000` atomic units, 6 decimals). The graph allocates `1000000000000000000000000000` atomic HKMN to the hook, and permanent custody receives only the minted v4 LP position.

## Transaction 1: graph deployment and pool initialization

| Field | Value |
| --- | --- |
| Chain ID | `4663` |
| From | `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729` |
| To | `0x34965F2A2ee9254522232C32F02056E92BE0C98a` |
| Method | `launchAndStampV1` |
| Value | `0` native atomic units |
| Calldata digest | UNSET until provider launch-intent preimage fields are supplied |
| Expected addresses | UNSET until provider derivation completes |
| Wallet nonce and gas fields | UNSET at signing time |

The graph target order is `HKMNToken`, `PermanentPositionCustody`, then `HookemonHook`. Its required initializer sequence is `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody,selectedSqrtPriceX96)`. The ABI selector, targets, arguments, call count, and order must match the provider encoding before any call data is signed.

## Transaction 2: owner seed and custody binding

| Field | USDG currency0 | HKMN currency0 |
| --- | ---: | ---: |
| sqrtPriceX96 | `161723809515207654588927258648643645224` | `38813714284914462669` |
| Liquidity | `489897948556635619` | `489897948572597439` |
| USDG maximum | `240000000` | `240000000` |
| HKMN maximum | `1000000000000000000000000000` | `1000000000000000000000000000` |

The selected address order consumes both maximums exactly. Permit2 allowance must equal the selected USDG maximum and name the resolved hook. Unused USDG is returned to the payer. In graph mode, any HKMN residual reverts the full seed rather than being transferred elsewhere.

## Inputs still required before signing

| Input | Resolve it by | Verified alternative now |
| --- | --- | --- |
| `UNVERIFIED_LAUNCH_INTENT_PREIMAGE` | Obtain the provider route namespace, route nonce, topology hash, target-id hashes, and serialized graph calls | Retain null graph calldata, addresses, and transaction payload |
| `PROVIDER_API_KEY_PENDING` | Supply an execution-only preflight API key | Persist no credential in the package |
| `OWNER_WALLET_FUNDING_PENDING` | Fund the launch wallet and record final nonce, gas, deadline, and exact Permit2 allowance after preflight | Retain the 900-second deadline ceiling and exact allowance rule |
| `BUILDER_IDENTITY_PENDING` | Provide public builder contact details for preflight | Retain null builder identity fields |

After transaction 1, do not seed if code hashes, hook mask `0x20cc`, the PoolKey, selected tuple, or exact Permit2 allowance differs from the reviewed package. After transaction 2, do not attempt a compensating withdrawal or approval broadening; record the final transaction hashes, PoolKey, PoolId, custody position identifier, balances, and runtime hashes before enabling trading.

## Owner preflight steps

Before either wallet action, run `export $(cat ~/.hookemon/programmable.env) && node scripts/programmable/preflight.mjs`. It first reads the provider capabilities for chain 4663 and uses only the advertised non-persisting preflight route. It writes a redacted evidence record under `release/phase3/preflight/` and exits nonzero with numbered mismatches when a package root, digest, caller, deployer, transaction target/value, seed allowance, deadline, or refund destination differs.

In Rabby, compare the handoff with the displayed transaction: chain 4663, recipient, native value, calldata and graph digests, expected addresses, nonce, gas, and deadline for the graph transaction; then exact 240 USDG Permit2 allowance, a deadline no longer than 900 seconds, and the refund destination for the seed. The owner alone decides whether to sign or broadcast. A matching preflight does not authorize either action.

The checked-in package is still `ADDRESS_DERIVATION_PENDING`. The provider route, nonce, intent preimage, materialized target addresses, and unsigned transaction data remain OPEN FACTs. Commit the materialized request and repeat the command against that commit before signing.
