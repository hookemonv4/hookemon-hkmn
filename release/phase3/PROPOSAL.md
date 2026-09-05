# Hookemon Phase 3 programmable launch proposal

Hookemon proposes a three-target v4 launch graph on chain 4663: a fixed-supply HKMN token, a canonical-pool hook, and permanent custody for the resulting LP position. The launch wallet is also the treasury beneficiary. The graph has three ABI-derived calls in order: `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody,sqrtPriceX96)`.

Requirements revision 65 records the owner's 2026-09-05 decision that all `1000000000000000000000000000` atomic HKMN enter the canonical market and no other HKMN allocation exists. The separate owner seed is `240000000` atomic USDG from a 300 USD total budget. The full-range seed uses an exact address-order price tuple, so graph-mode seeding reverts instead of transferring a residual HKMN balance.

The pool has zero LP fee, tick spacing 60, and full-range ticks from `-887220` through `887220`. The hook collects a 300 bps gross quote-side fee. The immutable Programmable recipient receives 10 bps, accepted with the owner on 2026-09-04; the remaining 290 bps is split into 40 bps treasury and 250 bps process liabilities.

The package is `ADDRESS_DERIVATION_PENDING`. The only provider-side launch intent input still missing is the encoded preimage: route namespace, route nonce, topology hash, target-id hashes, and serialized graph calls. The package also retains the execution-only API key, owner wallet funding, and public builder identity inputs as unverified. It contains no request, signature, or deployment authorization.

## Launch sequence

After provider preimage and preflight inputs are available, the launch wallet reviews the zero-value `launchAndStampV1` graph call against the approved three-call sequence, target order, runtime hashes, and gas settings. After graph finality, it checks the hook permission mask, resolved PoolKey and PoolId, and the exact Permit2 allowance before signing the owner seed. The selected exact tuple consumes all HKMN and at most `240000000` USDG, with unused USDG returned to the payer.

## Authority and recovery boundaries

The platform recipient is immutable. The launch wallet controls only its own graph and seed signatures; it cannot change the fee recipient or allocation. A mismatch in the provider preimage, code hashes, hook mask, pool configuration, Permit2 allowance, or complete-supply allocation prevents the seed. A failed graph review leaves the pool unseeded and requires a new reviewed graph.
