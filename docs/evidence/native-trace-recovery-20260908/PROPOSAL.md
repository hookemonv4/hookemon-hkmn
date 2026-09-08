# Native trace recovery proposal

This read-only inventory covers all 80 canonical tasks whose requirement array was empty at capture: 67 completed and 13 ready. It proposes 41 narrow product contributions, distinguishes 33 operational or provenance tasks, identifies six ready product scopes lacking current completion evidence, and qualifies two Collector contributions through their explicitly verified PR39 implementation ancestors rather than their completion carrier diffs. No task binding, approval, receipt, completion, or generated projection was changed.

The baseline is main `b2cb737a298522e3944652e862c4eeab195667d8`, which still contains requirements revision 70. The reference for native scope is the exact revision 71 working-tree snapshot from `eth-interface-20260908`, recorded with its source HEAD and SHA-256 in `inventory.json` and copied as `requirements-71.snapshot.json`. This audit does not promote that snapshot to main or renew its owner authority. `requirement-clauses.json` contains the complete statement and measurement of every proposed requirement ID, not merely matching titles.

## Apply-order proposal

Preserve the two Collector integration-ancestor links below and handle the two PR38 rows through their separate unsigned historical archive proposals (`7504f3d2`). For framework, policy, CI, integration, formatting, and owner-evidence tasks, use the existing operational acceptance/provenance path with exact support and prestate. Do not attach `REQ-transaction-policy-1` or a release requirement just to eliminate an empty array.

For product contributions, review the specific invariant and named assertion at its exact commit, then ask the coordinator to prepare the supported binding descriptor against the current canonical prestate. These are partial contributions; a task may support a requirement without satisfying every statement or measurement. Current native closure additionally needs its actual integrated code, current tests and explicit requirement acceptance. No historical USDG test is treated as a native ETH payment, valuation, gas-reserve or full-graph proof.

The captured canonical ledger was read through SQLite `mode=ro` in one read transaction. `inventory.json` retains all attempts and their existing provenance, the last successful completion, exact changed paths, Git existence/ancestry and inspected code/test/doc references. Merge or rebind carrier diffs alone are not treated as task patches. All completion objects except the two explicitly archived PR38 commits are reachable from baseline main. Local native successor heads are labeled separately and are not main reachability or execution evidence.

## Thirteen priority BOT contributions

All thirteen prior candidate IDs and exact full completion hashes were verified. The proposed IDs below refer to revision 71 clauses, with only the stated contribution supported. Full test definitions and blob identities are in the inventory; this audit inspected source and assertions but did not rerun their suites.

| Task | Exact requirement contribution | Completion | Scope |
| --- | --- | --- | --- |
| `BOT-AUTHORITY-READY` | `REQ-cycle-repository-1` | `63d4b5b351cfccf661434830edd613b76dbf22b8` | Readiness refuses before nonce reservation; lease loss/revocation leaves zero signer and broadcast calls. |
| `BOT-BATCH-GUARD` | `REQ-cycle-repository-1` | `72c77dfe36ee5f5f60bb6fc004355f788173315c` | Stale policy vetoes generateYoloPacks after initial admission while preserving NOT_SENT. |
| `BOT-PACK-QUANTITY` | `REQ-cycle-runner-3`; `REQ-policy-engine-1` | `acc6bd6552858f3432a90160b4417609835026bc` | Purchase uses immutable cycle admission quantity, bounds it, and refuses contradictory configuration or missing production admission before catalog access. |
| `BOT-CLAIM-LEGACY-REFUSAL` | `REQ-cycle-runner-3`; `REQ-cycle-repository-1` | `da553027ab1e4ed5747d6980e5b4a11b2634b69d` | Competing raw custody identity refuses claim reconciliation, including all-zero and historical-return rows; no second canonical identity is manufactured. |
| `BOT-HELD-CUSTODY` | `REQ-cycle-runner-3`; `REQ-cycle-repository-1` | `227a8f6f2daeb99ea58b5a3d934ae898632db7c0` | Held-position replay and canonical attribution count once and refuse conflicting identities. Historical USDG bucket amount semantics do not establish native USD-cost/wei separation. |
| `BOT-LIABILITY` | `REQ-operations-wallet-1` | `19babb99cbe263cc598767e871679ffa484b58b0` | Finalized hook liability and capacity bound admission and the pre-sign claim recheck; a wallet balance cannot substitute for hook attribution. |
| `BOT-PAYOUT-RETRY` | `REQ-direct-payout-1`; `REQ-cycle-runner-3` | `7d5657a1578f37fccd7da34fc12d00ce2389df0c` | Completed zero-recipient payout reconciliation requires an existing canonical backing row, refuses raw/missing/conflicting identities across restart, and checks the frozen runtime Operations/asset identity. It does not invent a custody observation during reconciliation. |
| `BOT-PAYOUT-AVAILABILITY` | `REQ-direct-payout-1`; `REQ-cycle-runner-3` | `1bb79342757e4c6343b6c02f0eebe5078acfa6f5` | Availability binds cycle return provenance and permitted prior dust, including exact consume-only restart without consuming dust twice. |
| `BOT-PAYOUT-QUARANTINE` | `REQ-direct-payout-1`; `REQ-cycle-repository-1` | `bb21ba30952184c44d02acc7eff012504a55b76f` | Quarantine reserves backed custody without erasing other obligations and refuses conflicting identity/evidence or shortfall. Historical USDG transfer proofs do not prove native payment. |
| `BOT-RETURN-CHAIN-IDENTITY` | `REQ-cycle-runner-3`; `REQ-cycle-repository-1` | `16031d8a7aed97b734cd301c62f40eb1d1ede07f` | Return takes the exact native Solana USDC ledger delta, excludes held positions, rejects competing wire-identity rows and false zero proceeds. Native here describes Solana identity, not ETH payment proof. |
| `BOT-COLLECTOR-PRODUCTION` | `REQ-transaction-policy-1` | `edebcf2077f0cddece884d95be993565745422bc` | Independently pinned Collector purchase/buyback policies pass through the ordinary loader; synthetic-only identity and outward network confinement are checked. This is not live provider or native release authority. |
| `BOT-N2-PRODUCTION` | `REQ-transaction-policy-1`; `REQ-direct-payout-1`; `REQ-cycle-runner-3` | `52ba4186d2a073445c6b052340cdd5e0c4b84b2d` | Test-only ordinary/held N=2 flow exercises the real loader, CLI restarts, signed-message identity and supplementary payout. Historical graph fixture is not current native full-flow acceptance. |
| `BOT-SUPPLEMENTARY-COMPLETE-DISPATCH` | `REQ-direct-payout-1`; `REQ-cycle-repository-1` | `b9029abf80e47f8f719c27a1dc749b9d57cc01cb` | Terminal supplementary payout identity is validated without redispatching an already completed settlement. |

## Ready tasks affecting closure

A ready task has no successful completion attempt in this snapshot. Existing related code or a previous owner's proposal cannot silently complete it. The six product scopes below have concrete existing contract/code pointers, but require the listed work before closure. The remaining seven ready rows are operational/specification provenance and keep empty product candidate arrays deliberately.

| Ready task | Proposed scope or authority route | Exact evidence and next action |
| --- | --- | --- |
| `BOT-BUYBACK-FIXTURE` | `REQ-cycle-repository-1` | `packages/adapters/test/app/stages-collector-lifecycle.test.mjs` at `edebcf2077f0cddece884d95be993565745422bc`. Matching custody keys are supporting fixtures only; no successful completion attempt is recorded. |
| `BOT-FAILURE-MATRIX` | `REQ-cycle-repository-2`; `REQ-policy-engine-2` | `packages/adapters/test/app/launch-failure-matrix.test.mjs` at `0a54d74a8f1048bd755f96af6c4a033acf1898b3`. Historical frozen-USDG cases require native principal/gas replacements plus the same outage/restart assertions; current native full failure matrix is not established here. |
| `BOT-GRAPH` | `REQ-cycle-runner-3`; `REQ-direct-payout-1`; `REQ-transaction-policy-1` | `packages/adapters/test/app/launch-production-graph.test.mjs` at `f76786df7b9119512caef806f4e75f525cd1bb4f`. Existing N=2 graph is historical USDG; native claim/return/payout proofs and exact cost basis must execute together before completion. |
| `BOT-HELD-SPEC` | Operational / provenance; no invented product ID | A spec proposal must bind its owner decision; a product requirement cannot retrospectively authorize the revision. |
| `BOT-INTERFACE-FIXTURE-CLOSURE` | Operational / provenance; no invented product ID | Interface amendment/approval fixture closure requires exact evidence support, not a generic transaction-policy requirement. |
| `BOT-OFFLINE-HELPER-DOCS` | `REQ-transaction-policy-1` | `docs/modules/signing.md` at `5b5e3a32b8dd0e9b11b4308a51c386c7f56b4561`. Existing module documents independently pinned synthetic loader confinement; requires exact doc contribution and module-index verification, not live readiness. |
| `BOT-RECOVERY-CONTRACT` | `REQ-cycle-repository-2` | `docs/runbooks/README.md` at `67139d53e106094ed38a84a51df7b1b53e2b8a21`. Current71 explicitly distinguishes semantic-invalid, effect-ambiguous and proven-pre-effect-transient; require a clause-by-clause current-native recovery matrix before completion. |
| `BOT-SOLANA-MONEY` | `REQ-cycle-runner-3`; `REQ-transaction-policy-1` | `packages/adapters/src/app/stages/solana-money-controls.mjs` at `74cd4ec9cdef361447d232a459a0ea194e33c2f6`. Closed Collector solana-mainnet/Relay792703809 mapping is a concrete boundary; require native MoneyConfigurationV2 tests and no USDC/USD or ETH parity. |
| `BOT-SPEC66-INTEGRATION` | Operational / provenance; no invented product ID | Integration of owner-approved historical revision66 is operational authority work; current71 implementation acceptance is separate. |
| `CLEANROOM-PROVENANCE` | Operational / provenance; no invented product ID | Explicit owner-approved composite provenance is an operational disposition, not a product requirement. |
| `PRACTICAL-TEST-PREP` | Operational / provenance; no invented product ID | Operational preparation of an owner test; no live action or product acceptance follows from a prepared packet. |
| `WEB-PR32-INTEGRATION` | Operational / provenance; no invented product ID | Merge conflict resolution must reference exact reviewed branches and CI; not a fabricated product requirement. |
| `WEB28-CI-REPAIR` | Operational / provenance; no invented product ID | Fixture/navigation assertion repair requires the exact patch and CI evidence; no specific product requirement for gallery anchor formatting. |

## Two qualified Collector integration contributions

Both tasks intentionally record integration completion `fc05cf5b27151cad2b61b9f32a79724056a3ee87`. Its own diff changes only `gates/init.json`; the product evidence is in reviewed PR39 ancestors. The coordinator note at `.session/eth-execution-20260908/COORDINATOR.md:55` identifies these tasks as the PR39 integration claims, and line 74 records their completion after that merge. Existing task attempts remain unchanged.

| Task | Requirement contribution | Exact implementation and tests |
| --- | --- | --- |
| `BOT-COLLECTOR-ORIGINAL-BLOCKHASH` | `REQ-transaction-policy-1`: original message preservation and independently observed blockhash validity before signing/broadcast | `339de8e0fe9b83e2aeec4c4625a784f565af7d54` changes RPC, policy, signer and purchase wiring. `collector-original-blockhash.test.mjs` checks direct original-hash RPC observation; purchase policy tests reject invented expiry, injected validity and expiry before transport. `purchase-collector-policy-wiring.test.mjs` proves unchanged serialized message bytes. `56f185e07dfafe5533df617ec1dad473ecb63f68` aligns the composed positive/negative tests. |
| `BOT-COLLECTOR-PURCHASE-LIVE-SHAPE` | `REQ-transaction-policy-1`: independently bound exact generatePack semantics and co-signer preservation | `581b70302d7d243d221f4c2b2772344391fe2b29` changes `collector-purchase-policy.mjs` and its tests: exact instruction order, duplicate operator roles/flags, memo suffix and provider signature, with positive exact-profile and negative mutation cases. |

Git ancestry was verified separately for each implementation commit to reviewed PR39 baseline `56f185e07dfafe5533df617ec1dad473ecb63f68`, that baseline to recorded completion `fc05cf5b27151cad2b61b9f32a79724056a3ee87`, and that completion to main `b2cb737a298522e3944652e862c4eeab195667d8`. The inventory records exact source/test/doc blobs and implementation patch hashes. This is qualified requirement support through preserved integration history, not a claim that the completion carrier itself changed those files or an invented attempt-provenance receipt. Neither contribution establishes full native funding, live provider admission, or complete requirement acceptance.

## Limits and validation

The historical held/payout/custody fixes support identity, replay, and conservation invariants only within their demonstrated asset model. In particular, the old held USDG ledger increments do not prove frozen USD purchase cost separated from native principal, and a Solana "native" namespace in a return test does not mean an ETH payment was authenticated. The historical N=2 graph and owner-capital/gas artifacts cannot establish current native full-flow execution or a complete USD 250 budget.

This is an inventory and proposed repair scope, not ready-to-apply owner descriptors. Canonical prestate preparation remains with the coordinator. Re-read live task state before preparing a descriptor; this snapshot may become stale as other tasks complete. No live endpoint, private credential, signer, contract deployment or wallet was used.
