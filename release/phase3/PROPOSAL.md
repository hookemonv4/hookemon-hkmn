# Native Hookemon launch proposal

The proposed chain-4663 graph deploys HKMNToken, permanent position custody and HookemonHook. Its three initializers run atomically in that order: `token.allocate(hook)`, `custody.configureBindingHook(hook)`, then `hook.initializeGraphLaunch(custody,sqrtPriceX96)`. The complete one-billion HKMN stock enters the canonical market; there is no other allocation.

A separate payable owner seed uses native ETH as currency0 and HKMN as currency1. Its reviewed maximum is explicit wei, with `msg.value == amount0Max`; only HKMN uses temporary token approvals. The deterministic tuple consumes the complete HKMN stock, sends exact native debt to PositionManager and refunds excess native value to the payer. Any residual HKMN or rejected refund reverts the seed. The full-range position remains in permanent custody.

The project fee is 300 bps of gross native quote volume: 10 Programmable, 40 treasury and 250 process, with existing cumulative rounding. The canonical pool has zero LP fee, spacing 60 and ticks -887220 through 887220. Current published provider terms differ from this inclusive fee model and separate seed; exact-request admission remains required and is not inferred from prior owner agreement.

The package is `ADDRESS_DERIVATION_PENDING`. Real compiled templates exist, while final commitments, graph preimages, native amounts, runtime materializations and provider admission remain incomplete. The owner prioritizes one or two controlled functional cycles and defers complete-process affordability analysis; this selects no seed or claim amount and grants no signature or broadcast authority. See `launch-plan.md` for the concrete review sequence and `feasibility/native-provider-admission/README.md` for field-level evidence.
