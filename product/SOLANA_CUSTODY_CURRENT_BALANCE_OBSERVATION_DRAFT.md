# Solana custody current-balance observation — DRAFT, non-authoritative

**Status: DRAFT.** This names an unresolved contract for discussion. It is not an approved
requirements/architecture revision, not a spec-sync (R2) proposal, and grants no authority to
write custody ledger rows. `packages/adapters/src/solana-custody-balance-observation.mjs` is a
pure combiner built ahead of this approval; it performs no chain identity selection and is usable
only once a caller supplies canonical `{chainId, assetId, decimals, mint, owner, tokenProgramId}`
and two independently produced read sides.

## What is open

Per the Solana finalized-balance feasibility review and the Solana custody writer identities
review (external coordination reports, not part of this repository):

- No canonical Solana custody chain/asset identity is approved. Existing writers disagree:
  Relay transport uses chain id `792703809`; the Collector-facing buyback-proceeds writer uses
  `solana-mainnet`. This draft does not resolve which (if either) is the custody-ledger identity;
  it only requires a caller to supply one explicitly before any observation is produced.
- No two-endpoint operational-independence policy is approved (how many providers, how they are
  configured, what proves they are not the same upstream).
- No bounded-retry count, backoff, or "do not move the accepted height backward" rule is approved
  for a durable producer; `observeFinalizedBalanceWithRetry`'s `maxAttempts` is caller-supplied and
  carries no default policy weight.
- No requirements/interfaces/ADR-0026 Solana counterpart revision exists yet naming this contract
  as custody evidence (`decisions/ADR-0026-custody-ledger-v2-migration.md:163-179` leaves the
  Solana producer, finalized-slot reader, and reorg rule as an explicit open fact).

## Verified RPC semantics this draft relies on

Official Solana JSON-RPC HTTP docs (observed 2026-09-06):

- `getAccountInfo`: https://solana.com/docs/rpc/http/getaccountinfo
- `getMultipleAccounts`: https://solana.com/docs/rpc/http/getmultipleaccounts
- `getBlock`: https://solana.com/docs/rpc/http/getblock

Each read returns `context.slot`; `getBlock` returns `blockhash` and a nullable `blockTime`.
`minContextSlot` is a lower bound on a node's context, not an exact historical-state selector, and
must never be treated as one.

## What a future approval must still decide

1. The one canonical Solana custody asset identity, and an explicit one-way mapping from the
   Relay `792703809` and Collector `solana-mainnet` labels to it (or a decision that neither maps).
2. The source-independence policy for the two configured RPC endpoints.
3. The durable producer's retry/backoff bound and monotonic-height rule.
4. The requirements/interfaces/ADR-0026 revision binding this contract to `REQ-cycle-runner-3`'s
   `verifiedCurrentBalance`.

None of the above is decided by this document or by the helper it describes.
