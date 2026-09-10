# Assisted launch revision 0.1.2

This bounded revision supersedes submission `45ddd161-e5bb-4cb0-ad92-8f4eb044d82e` (0.1.1), following `e13314d0-af87-4635-ac40-d1cb5f4715ec` (0.1.0). The reviewed source baseline is `6f81c3fe86e541043847b140d4b6bc2f69ed846a`. Historical submissions, snapshots and their hashes stay unchanged.

The owner's 2026-09-10 preparation request expressly selects inclusive 300 bps: 20 Programmable, 40 Treasury, 240 process, on buys and sells. Programmable's immutable beneficiary is `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`. Independent cumulative quotient/remainder accounting, native backing, exactness handling and claim authorization stay intact. The rationale for requirements revision 75 is that the current platform allocation replaces the old 10/40/250 split without adding a surcharge. `requirements.patch` records the source diff. This authorization covers preparation and affected test expectations; it grants no live action or control waiver.

The coordinator confirms `processClaimMaxCount=24` per rolling six hours, using the selection the owner asked to confirm. This is an explicit revision choice within the existing 1..64 contract range; the older phrase "owner did not object" is not approval evidence.

`decisions/owner-inputs/launch-inputs-owner.json#assistedLaunchRevision` preserves the exact inventory, native caps, separate dynamic USD budget and manual gas configuration. Native caps are fixed wei quantities, and $2,509.82 is a dated ETH/USD calculation reference, not a peg. Launch/Treasury and its gas wallet remain `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729`; Operations remains `0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384`. There is no automatic refill.

Production targets are selected by source path and contract name: `src/HookemonHook.sol:HookemonHook`, `src/launch/HKMNToken.sol:HKMNToken`, and `src/bindings/RobinhoodBindings.sol:PermanentPositionCustody`. The other compiler-closure `HKMNToken` is not the launch token. Hook permissions stay `0x20cc` and constructor ABIs stay unchanged.

Required order and callers:

1. `token.allocate(hook)` by the token's immutable `issuanceAuthority`.
2. `custody.configureBindingHook(hook)` by the custody's recorded deployer.
3. `hook.initializeGraphLaunch(custody, sqrtPriceX96)` by the hook's immutable `graphInitializer`.
4. `hook.seedCanonicalLiquidity(params)` by the unchanged launch authority, with zero ETH.

The assisted route may separate deployment/initialization from inventory transactions. Platform mapping must make those exact caller roles possible without replacing the customer's authority wallet. Route namespaces, binding/runtime commitments, CREATE2 bindings, permits, deployment addresses and final transaction payloads remain platform supplied. Launch time, optional purchase, live deadlines and wallet nonces stay unset. They are not preparation prerequisites.

Buyer routing retains actual native presettlement: explicit native `SETTLE`, `SWAP_EXACT_IN_SINGLE`, then `TAKE_ALL` for HKMN. Buyer ETH must settle before fee collection. Mock-router and local pinned PoolManager results do not prove the deployed UniversalRouter or its exact ABI; Programmable performs that integration. Standard JSON compiler inputs are compiler data, not an API launch request.

No new customer economic choice is needed for this preparation. Exact platform integration and later wallet review remain before any transaction. Deployment, funding, live launch requests and signatures are outside this revision.
