# Native release threat model

An incorrect source closure, runtime authority, constructor, salt or provider graph can produce a different deployment from the reviewed candidate. Independently verify the approved prebinding and runtime commitments before deriving the hook, and bind the final addresses, runtime code, graph and PoolKey afterwards without circular preimages. The provider graph must preserve exactly token allocation, custody configuration and hook initialization in order.

The separate seed carries native value equal to its reviewed maximum. Its boundary includes the hook mask, deterministic price, exact full-stock debt, full-range liquidity, payer, refund and deadline. HKMN approvals are temporary and cleared; native ETH has no Permit2 allowance. Custody cannot withdraw, approve or delegate the position. A mismatch or rejected refund reverts the seed-local transaction.

Fee accounting preserves cumulative 10/40/250-bps liabilities on gross native quote volume, exact-output behavior, partial-fill refusal, callback settlement and same-pool call restrictions. Published provider fees are a separate admission question; the package cannot invent an exception.

Every external cycle effect requires the configured policy authority, fresh bound quotes, exact recipient/amount, gas and rent reserves, durable intent and once-only reconciliation. Expired or uncertain signed effects are recovered from their original journal; no replacement signature or optimistic duplicate transfer is inferred. Held cards and unknown proceeds remain actual custody, never assumed cash. A second cycle waits for reconciliation of the first.

The package contains no private key, provider credential or transaction authorization. Signing and broadcasting require a separately approved concrete transaction or bounded test scope. Deferring complete-process affordability analysis leaves per-action funding, fee, loss and authorization limits intact. A successful archive fork or local hash test cannot establish live deployment, finality or provider admission.
