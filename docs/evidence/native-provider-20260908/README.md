# Native provider evidence, 2026-09-08

This packet establishes current public provider policy, two unsigned Relay scenario quotes, and current native route source/runtime identity. It does not establish Hookemon admission, a verified solver signature, finalized delivery, funding, or permission to sign. Task: ETH-PROVIDER-EVIDENCE. Collector remains Solana USDC. The approved market remains seeded full-range permanent custody with an inclusive 250/40/10 bp split.

## Programmable admission

The selected public profile is revision 2, version 4.1.0; discovery reports public writes and authorization available. `programmable-selected-profile.json` preserves the relevant fields; `sources.json` records exact source URLs, response hashes and fetch times. The full original documents remain local and uncommitted. Fetch the indexed URLs to reproduce a new observation, and compare hashes before assuming they describe this snapshot.

The current guide and discovery require a 20 bp native kernel, rounded up per successful gross native buy/sell and separate from creator/LP fees. They require an atomic initial buy of at least USD 1 at permit authorization, with positive minimum output to the launch wallet. This differs from Hookemon's agreed 10 bp inclusive platform share and deployment followed by a separate seed. This is a conflict with the selected public profile, not proof that every possible exact-model exception is unavailable. The historical owner-recorded 10 bp agreement remains preserved; no current request-specific exception was obtained here. Old `/v4/` documents remain available and must not replace the selected `/v4.1/` profile.

OPEN FACT: exact current admission for Hookemon. Materialize a complete current-profile native graph and send its exact bytes to `POST https://api.programmable.market/v4/chains/4663/custom-launches/preflight` with the authorized backend key. The current OpenAPI calls this side-effect-free. Bind source, verification, graph, native funding plan, actual liquidity model and launch intent. Do not invent an exception property. Retain request/response hashes, profile, disposition, gate results and precise findings. An incomplete schema probe cannot test economics; a successful response must actually cover the economic distinction before being treated as admission. If the result cannot bind the existing agreement, prepare an unsent request for the provider's documented exact exception route. Independent native accounting and custody tests can continue unchanged.

Funding under the selected public profile includes the initial buy once inside launch value, distinct from liquidity, reserve and gas. The server reference quote is at most 60 seconds old; it does not guarantee USD value at wallet execution. No budget increase, oracle addition or changed fee split follows from this evidence.

## Relay scenarios

The coordinator fetched both quotes at 08:22:02 UTC; `quote-sources.json` preserves exact hashes. These requests use historical role addresses for scenarios only. No current wallet ownership or balance proof is implied.

| Leg | Source | Destination | Scope |
| --- | --- | --- | --- |
| Outbound | 10,243,579,001,330,370 wei on 4663 | 25,000,000 USDC atoms on Solana | EXACT_OUTPUT; one native deposit, no token approval |
| Return | 25,000,000 USDC atoms on Solana | Expected 10,069,426,712,596,615 wei; minimum 9,868,038,178,344,683 | EXACT_INPUT scenario; no acquired card or actual buyback proceeds |

Outbound request ID is `0x1788855721934154fda7a13517e518e9387b51e84ffed24c86c3b03f82ffe3da`; order ID is `0x54c4f52e6e04cd211f7552eb6280e62d19dcd4a311c3b419c1bec2b12419b3e8`. The transaction targets `0x4cd00e387622c35bddb9b4c962c136462338bc31` and decodes as `depositNative(Operations, orderId)` with selector `0x49290c1c` and the exact input value. Outbound quote principal is approximately USD 25.327249; the quote's separate gas estimate is 8,023,708,000,000 wei. These are dated estimates, not a total cycle budget or a gas ceiling. Do not add relayerGas and relayerService on top of their already aggregated relayer fee.

The return source instruction uses Solana program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2` and an address lookup table. Existing legacy-only return validation refuses such a plan. Either resolve a documented supported route without a table or implement and review exact lookup-table validation under the native bot task; silently dropping the table is invalid. Its instruction carries the scenario order ID, but full Solana account/program and signature verification was not performed here.

Both protocol orders include `orderSignature`, exact payments and refund recipients. Signature presence is not signature verification: this packet does not independently reproduce the order digest or recover an authenticated solver. Both order outputs also contain a deadline about seven days after retrieval; do not treat that as the quote's safe valuation TTL. Refund lists permit both origin and destination assets with zero minimum refund amounts. Therefore these orders do not promise a full origin-asset refund, even though `refundTo` was specified. Any different asset or unproved credit must follow the existing held-state policy.

## Native source/runtime findings

The chain-list snapshot advertises chain 4663, native ETH zero address/18 decimals, public RPC `https://rpc.mainnet.chain.robinhood.com`, the above depository and router `0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f`. The return output and native refund `extraData` carry that router address. This is route metadata, not a finalized call.

`relay-runtime-rpc.json` retains the exact read-only RPC requests and responses. The public endpoint reports chain ID 4663. It returned a finalized block but rejected `eth_getCode` at that block with `metadata is not found`. Code at `latest` succeeded. This establishes current code, not historical code at a future payment's finality checkpoint.

Sourcify returned depository match ID 43725858 (`exact_match`, verified 2026-08-17) and router match ID 46998805 (runtime `match`, verified 2026-09-01). `relay-source-runtime-binding.json` retains the provider labels, exact source endpoint/hash, code, transformations and compilation information. Both provider onchain bytecodes equal the current public RPC bytes. Applying the depository's supplied immutable replacements makes its recompiled bytes identical; router recompiled bytes are already identical. This is a checked provider-native source binding, not a fresh local compilation or two-provider finalized runtime proof. Only relevant verified source files are retained. The archived official GitHub reference was inspected but is not substituted for the deployed source.

In verified `RelayDepository`, `depositNative` emits the credited depositor, `msg.value` and supplied order ID. `RelayCallExecuted` is emitted only after its individual low-level call succeeds. Its event ID is the withdrawal CallRequest struct hash, not automatically the Relay order ID. A successful outer receipt can contain failed calls when their `allowFailure` flag is true; an unrelated successful event cannot credit our cycle.

In verified `RelayRouterV3`, `cleanupNative` calls reverting `safeTransferETH` before emitting `SolverNativeTransfer` and `FundsMovement(router, recipient, address(0), amount, metadata)`. A canonical final successful receipt with the exact router event, recipient, native currency, amount and authenticated request metadata can therefore prove the native transfer occurred, provided the runtime matches the source at that checkpoint. `receive()` also emits `SolverNativeTransfer` to the router itself, so that event alone is insufficient. `cleanupNativeViaCall` has different evidence semantics and emits no FundsMovement; do not accept an arbitrary route by analogy. Multicall per-call failure flags require inspecting the specific successful payment event or successful trace.

OPEN FACT: actual route request attribution and finality. For the real future quote, verify its signature/digest and exact assets/recipients; retain the source deposit proof and authenticated destination/refund pointer. Decode the actual destination call and exact payment event metadata, prove linkage to the recorded request/order, runtime at the canonical checkpoint and unique positive credit, and reserve the source/destination identity across cycles. Use a pinned archive RPC or an independently supported runtime proof to resolve the finalized-code read. Until those facts exist, retain the leg without crediting custody or paying holders. A balance delta, provider success status, quote signature or current source match does not settle it.

## Reproduction and validation

Run `python3 docs/evidence/native-provider-20260908/verify-evidence.py` from the repository root. It checks retained raw quote hashes, RPC chain identity, source hashes, source-provider bytecodes against RPC, immutable transformations, and the outbound calldata/order/value bindings. It does not contact a provider, verify a solver signature or prove a live payment. This check passed on 2026-09-08. No runtime behavior changed, so no application tests were run.

Full source documents and raw Sourcify responses are kept uncommitted in the same local directory; their raw hashes and URLs are retained for provenance. They are not runtime configuration. The selected evidence files are sufficient to repeat the local checks; new network observations must carry fresh timestamps and hashes.
