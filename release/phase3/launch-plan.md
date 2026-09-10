# Assisted-launch preparation and platform handoff

Status: source and compiler artifacts prepared for integration; no signable launch transaction is present. Revision 0.1.2 supersedes `45ddd161-e5bb-4cb0-ad92-8f4eb044d82e` in the same Hookemon / HKMN lineage. The approved current scope is `decisions/assisted-launch-v012/README.md`. No deployment, funding transfer, live launch request or wallet signature is requested. Launch time and any optional initial purchase will be selected after integration and are not preparation requirements.

## Fixed review inputs

| Item | Selected value |
| --- | --- |
| Chain | Robinhood Chain, ID 4663; native ETH |
| Launch/Treasury and gas wallet | `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729` |
| Operations | `0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384` |
| Programmable recipient | `0xD88539d3c4C460136a733A3Fd60cf6BF269079da` |
| Token | Hookemon / HKMN, 1,000,000,000 tokens, 18 decimals, atomic supply `1000000000000000000000000000` |
| Inventory funding | Buyer-funded; creator ETH contributed to initial liquidity exactly zero; no new creator token allocation |
| Pool | Native ETH currency0, HKMN currency1, zero LP fee, tick spacing 60 |
| Inventory ticks | Lower 133500; upper 161220 |
| Initial sqrtPriceX96 | `250929875796514805540091219040452` |
| Position liquidity | `421035394154913054639875` |
| Custody | Permanent LP position custody and 115 atomic HKMN of rounding dust |
| Fee | 300 bps inclusive on buys and sells: 20 Programmable, 30 Treasury, 250 process; no extra surcharge or 1% buyback fee |
| Initial six-hour native claim cap | `9960873688152935270` wei |
| Maximum native claim cap | `19921747376305870540` wei |
| processClaimMaxCount | 24 per rolling six hours |
| Operations rotation delay | 43200 seconds; existing role restrictions and cap-change delays retained |
| Bot budget | Separate dynamic rolling six-hour USD budget $25,000, adjustable up to $50,000; no onchain USD oracle |
| Gas | Separate and manually funded; no automatic Treasury-to-Operations refill |

The unchanged curve uses $2,509.82 ETH/USD as a dated calculation reference, not a peg. Historical funded-seed experiments and affordability notes do not alter the selected zero-ETH inventory or fixed native claim caps.

## Constructor and caller mapping

Select the production targets by both source path and contract name:

- `src/launch/HKMNToken.sol:HKMNToken`: constructor `(address issuanceAuthority_, address expectedQuoteCurrency_, uint8 decimals_, uint160 launchSqrtPriceX96_)`. Use native quote address zero, decimals 18 and the fixed price above. The supplied issuanceAuthority must equal the deployment caller. Another HKMNToken in the source closure is not this target.
- `src/bindings/RobinhoodBindings.sol:PermanentPositionCustody`: constructor `(address manager, uint256 tokenId)`. Platform mapping supplies the verified PositionManager and initial token-ID binding. The contract records its deployment caller as deployer.
- `src/HookemonHook.sol:HookemonHook`: constructor `(ConstructorConfig config)`, one tuple containing the following 18 fields in ABI order. Preserve hook permission mask `0x20cc`.

| Hook field | Configuration source |
| --- | --- |
| `manager` | Platform-verified PoolManager |
| `positionManager` | Platform-verified PositionManager |
| `permit2` | Platform-verified Permit2 |
| `quoteCurrency` | Native ETH address zero |
| `hkmn` | Platform-derived address of the fully qualified launch token |
| `tickSpacing` | 60 |
| `programmable` | Fixed Programmable recipient above |
| `treasury` | Fixed Launch/Treasury wallet above |
| `operations` | Fixed Operations wallet above |
| `launchAuthority` | Unchanged customer Launch/Treasury wallet above |
| `issuanceAuthority` | Platform mapping consistent with deployment caller and graph mode |
| `expectedDecimals` | 18 |
| `bindingDigest` | Authoritative platform binding commitment; unset until supplied |
| `runtimeDigest` | Authoritative platform runtime commitment; unset until supplied |
| `processClaimLimit6hWei` | `9960873688152935270` |
| `processClaimLimitMaxWei` | `19921747376305870540` |
| `processClaimMaxCount` | 24 |
| `operationsRotationDelay` | 43200 |

The required call order is:

1. `token.allocate(hook)` by the token's immutable issuanceAuthority.
2. `custody.configureBindingHook(hook)` by the custody's recorded deployer.
3. `hook.initializeGraphLaunch(custody, sqrtPriceX96)` by the hook's immutable graphInitializer.
4. `hook.seedCanonicalLiquidity(params)` by launchAuthority with zero ETH and `msg.value == amount0Max == 0`.

The assisted route may use separate deployment/initialization and inventory transactions. Preserve the caller roles without changing the customer authority wallet to force one transaction. Platform mapping must match the actual constructor checks, final deployed code, graph and pool. Permits, CREATE2 bindings, route namespaces and final transaction payloads come from authoritative platform records.

## Integration sequence

1. Bind the final repository commit, focused PR, revised source package and descriptor. Reproduce exact Standard JSON input, complete inline source closure and pinned dependencies with Solidity 0.8.26+commit.8a97fa7a, Cancun, optimizer 200 runs, viaIR true, metadata.bytecodeHash none and metadata.appendCBOR false.
2. Include ABI, creation bytecode, deployed-runtime templates, link references and compiler-emitted immutable references for all three targets. Regenerate source and artifact hashes. Compiler inputs are not an API launch request; templates are not final constructor-bound runtimes.
3. Attach affected tests and required CI outcomes on that same commit, including fee conservation/backing/claims, both swap directions and exactness modes, zero-ETH initialization, permanent position/dust custody and role restrictions. Identify pending or failing checks explicitly.
4. Retain the buyer-routing fixture: explicit native SETTLE, SWAP_EXACT_IN_SINGLE, then TAKE_ALL for HKMN. Actual buyer ETH must settle before the hook collects its fee. Distinguish mock-router results from actual deployed-router tests. Programmable verifies the deployed UniversalRouter and its exact ABI, complete deployment/seeding/buyer flow and authorization mapping; no platform adapter is implemented here.
5. Keep unsupported platform values unset. If packaging or preflight produces an error, retain its exact text and request ID. Do not patch a CLI gate to manufacture a complete request. Reuse current project metadata and image.
6. After platform integration passes, select the launch window and optional initial purchase. Prepare wallet transactions with exact addresses, actions, amounts and costs for the owner's review before signing. Live deadlines and wallet nonces remain unset until that stage.

No further customer economic decision is needed for package preparation. Platform mapping and integration remain open work with the platform; wallet review remains a separate later action. Old submissions, snapshots and their hashes stay unchanged, and historical test results retain their original source binding.
