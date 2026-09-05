# Robinhood Rpc Client

## Purpose

`packages/adapters/src/robinhood-rpc.mjs` is the viem-based read/broadcast wrapper for Robinhood
Chain (EVM, chain id 4663). It reads ERC20 balances, latest/finalized blocks, transactions and
receipts, and broadcasts pre-signed raw transactions — it never signs anything and holds no key
material (see `packages/adapters/README.md`). Every fact this module's behavior depends on was
independently re-verified live against `https://rpc.mainnet.chain.robinhood.com` on 2026-09-02
(see `scratchpad/w1/summaries/external-facts.json`), most importantly a confirmed negative fact:
`eth_getBlockByNumber` accepts the `"finalized"`/`"safe"`/`"latest"` tags, but every *state* read
(`eth_call`, `eth_getCode`, `eth_getProof`) on this public RPC serves only `"latest"` — a
`"finalized"` or explicit historical-block state read fails with `"metadata is not found"`. The
public client therefore never supplies historical token state as settlement evidence; direct
payout proof requires a separately injected archive-capable or independent evidence client.

## Public interface

- `createRobinhoodClient({ rpcUrl, transport })` — a viem `PublicClient` bound to
  `robinhoodChain` (id 4663). `transport` may be supplied directly (e.g. `custom({ request })`)
  instead of `rpcUrl`, which is how this module is unit-tested without any real network.
- `readChainId(client)` — `eth_chainId`.
- `readLatestBlock(client)` / `readFinalizedBlock(client)` — `eth_getBlockByNumber` at `"latest"`
  / `"finalized"`; both confirmed live to work for block fetches. `readFinalizedBlock` wraps any
  failure in `RobinhoodFinalityUnavailableError`, never a bare `Error`.
- `readBlockByNumber(client, blockNumber)` — normalizes an explicit block identity for metadata
  and log-paging checks. It never performs a historical state read.
- `selectFinalizedSnapshotBlock(client, { finalityDepth })` — reads both `latest` and
  `finalized`, rejects a `latest - finalityDepth` candidate above the finalized head, and returns
  the selected block with `{ finalizedHead: { number, hash, timestamp } }` evidence.
- `readTokenBalanceAtLatest(client, { token, account })` — an ERC20 `balanceOf` read, always at
  `"latest"` (the only tag the public RPC accepts for state), returning `{ value, blockNumber,
  blockHash }` — the block context travels with the value so a caller can never mistake a
  `"latest"` read for a finalized one.
- `readTokenTotalSupplyAtLatest(client, { token })` (WP-36) — an ERC20 `totalSupply()` read, same
  `"latest"`-only shape and same accompanying `{ value, blockNumber, blockHash }`. This is the
  independent ground-truth total supply `snapshot-indexer.mjs`'s `buildHolderSnapshot` cross-checks
  a folded `Transfer` log set against — and, because the public RPC cannot read state "as of" an
  arbitrary historical block, its own accompanying `blockNumber` is the anchor a caller pages
  `getTransferLogs` up through, not a separately-chosen block.
- `confirmReadFinalized(client, blockNumber)` — compares a previously-read block number against a
  fresh `readFinalizedBlock` call; this is how a `"latest"` read is ever confirmed finalized, since
  the state read itself cannot ask for `"finalized"` directly.
- `getTransferLogs(client, { token, fromBlock, toBlock, pageSize?, maxRetriesPerPage? })` (WP-36) —
  pages `eth_getLogs` (raw `client.request`, topic-filtered to the ERC20 `Transfer` event
  `ERC20_TRANSFER_TOPIC`) across `[fromBlock, toBlock]` in `pageSize`-block windows (default 5000).
  Each page's own `toBlock` block hash is read *twice* — immediately before and immediately after
  the `eth_getLogs` call — and compared; a mismatch (a reorg mid-fetch) retries the whole page (up
  to `maxRetriesPerPage`, default 3) before giving up with `RobinhoodFinalityUnavailableError`, so a
  returned page's own recorded block hash is always the one the logs on it were actually read
  against. Returns `{ blockHash, pages, logs }`: `logs` is every decoded `{blockNumber, logIndex,
  from, to, value}` Transfer (canonical ascending order — the exact shape
  `snapshot-indexer.mjs`'s `buildHolderSnapshot` requires), `pages` is each page's own
  `{fromBlockNumber, toBlockNumber, blockHash}` for audit, `blockHash` is the final page's
  confirmed hash. Deliberately bypasses viem's higher-level `getLogs({event})` action (found, while
  implementing this function, not to forward a raw `topics` filter at all on the pinned viem
  version, and to silently drop an undecodable log unless `strict:true` is passed) in favor of a
  raw `client.request({method:'eth_getLogs'})` call and manual, explicit decoding — this module's
  own house style. This function performs no finality check of its own (only reorg detection during
  the read); never call it with a `toBlock` more recent than a separately-confirmed
  `readFinalizedBlock`/`confirmReadFinalized` result.
- `getPinnedTransferLogs(client, { token, fromBlock, toBlock, snapshotHash, pageSize?,
  maxRetriesPerPage? })` — verifies the selected block hash before and after the complete paged
  scan and rejects when the page scan's final hash differs from the caller-pinned snapshot hash.
- `readTransaction(client, hash)` / `readTransactionReceipt(client, hash)` — `eth_getTransactionByHash`
  / `eth_getTransactionReceipt`.
- `readFinalizedTransactionReceipt(client, hash)` — reads the receipt, a fresh finalized head, the
  canonical inclusion block, then the receipt and inclusion block again. It reports
  `{ receipt, finalized, reason, receiptBlockNumber, receiptBlockHash, finalizedBlockNumber,
  finalizedBlockHash }`. `finalized` is false when the receipt is pending, orphaned, or unstable.
- `readFinalizedErc20TransferCredit(client, { hash, token, recipient })` — preserves the
  receipt-local credit interface used by the return stage. It accepts only a successful canonical
  receipt and returns matching transfer logs; it is not a direct-payout settlement proof.
- `readFinalizedErc20TransferProof(client, { hash, token, source, recipient, amountAtomic,
  evidenceClient })` — direct-payout settlement proof. `evidenceClient` must implement
  `readErc20BalanceAtBlock({ token, account, blockNumber, blockHash })` against an archive-capable
  or independent source. Terminal `finalized: true` requires a stable canonical receipt, matching
  source/recipient `Transfer` logs, and exact source debit and recipient credit over the receipt
  block. It returns the receipt/finality identities, predecessor block identity, and all four
  before/after amounts plus both atomic deltas for durable persistence. Missing or inadequate
  evidence returns `finalized: false`, `receiptFinalized: true`, and a reason, so the caller keeps
  the attempt unresolved.
- `sendRawTransaction(client, signedTx)` — `eth_sendRawTransaction`; only ever broadcasts bytes an
  injected signerClient already produced.
- Typed errors: `RobinhoodRpcError`, `RobinhoodFinalityUnavailableError`,
  `RobinhoodMalformedResponseError`.
- `ROBINHOOD_CONSTANTS` — `ROBINHOOD_CHAIN_ID` (4663), `ROBINHOOD_TESTNET_CHAIN_ID` (46630),
  `ROBINHOOD_MAINNET_RPC_URL`, `ROBINHOOD_GENESIS_HASH`. `ERC20_TRANSFER_TOPIC` (WP-36) — the fixed
  `keccak256("Transfer(address,address,uint256)")` topic0, not a repo binding value.

## Invariants

- The public Robinhood client never receives `"finalized"` or an explicit historical block number
  for a state-reading RPC method (`eth_call` under the hood of `readContract`, `eth_getCode`,
  `eth_getProof`). Only block metadata uses those selectors. `readFinalizedErc20TransferProof`
  routes historical balance reads only to its explicit evidence client.
- Every state read reports the exact block number/hash it was read at; "finalized" is always a
  separately-confirmed fact (`confirmReadFinalized`/`readFinalizedTransactionReceipt`), never
  implied by the read itself.
- A transaction receipt is not final merely because its block height is behind the finalized head:
  the receipt must carry a valid block hash that equals the canonical block hash at that exact
  height. A conflicting or missing hash is rejected or reported as not finalized.
- `readFinalizedErc20TransferCredit` trusts only Transfer logs in that one canonical successful
  receipt, with the requested token and exact recipient. It does not infer a credit from a wallet
  balance or provider status.
- A snapshot candidate is accepted only when a fresh finalized-head response includes that block.
  `selectFinalizedSnapshotBlock` returns both identities so its caller can persist the proof with
  the snapshot record.
- This module never signs a transaction and accepts no private-key-shaped configuration field —
  `sendRawTransaction` only ever broadcasts a hex string a caller supplies.
- Every address argument is validated (`isAddress`) before use; every transaction-hash argument is
  validated (32-byte `0x`-prefixed hex) before an RPC call is made — a malformed argument is a
  `RobinhoodRpcError` before any network I/O, never a confusing RPC-side error.
- `getTransferLogs` never returns a page whose own block hash was not confirmed stable across the
  read (WP-36) — a reorg detected mid-page always retries that page from scratch (fresh hash read,
  fresh `eth_getLogs`), never mixes a stale hash with a fresh log set or vice versa.
- A direct payout is never final from receipt logs alone. The receipt hash must match a canonical
  block at or below the finalized head, the second read must preserve its inclusion and settlement
  material, and the archive/independent evidence source must return the exact pre/post USDG
  balances for both transfer parties at the canonical predecessor and inclusion blocks.

## State transitions

This module holds no state of its own between calls. Receipt finality transitions from unobserved
to unresolved or canonical: it reads the receipt, reads the finalized head, verifies the canonical
inclusion block, rereads the receipt, and verifies the inclusion block again. Direct payout proof
then reads source and recipient balances at the predecessor and inclusion blocks from the separate
historical evidence client. Any missing, changed, or mismatched observation remains unresolved;
the module never upgrades it to settlement evidence.

## Operational commands

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test --test-timeout=120000 test/robinhood-rpc.test.mjs
```

## Recovery pointers

- Use the incident runbooks for a [reorganization](../runbooks/robinhood-rpc-reorg.md),
  [log gap](../runbooks/robinhood-rpc-incomplete-logs.md), or
  [latest-only response](../runbooks/robinhood-rpc-latest-only.md). Each recovery contract records
  the supported resume command or its absence.
- If the public RPC's finality behavior ever changes (e.g. `"finalized"` starts working for state
  reads), the fix is additive: add a direct finalized-state read path alongside the existing
  latest-then-confirm one, never remove the latter — a caller pinned to the old behavior must not
  silently start trusting an unconfirmed read.
- `RobinhoodFinalityUnavailableError` is the signal that the finalized-block RPC call itself
  failed (network/timeout/malformed response) — distinct from `finalized: false`, which is the
  normal, expected outcome while a block is still pending finality.
- Keep a transaction pending when its receipt block hash does not match the canonical block at the
  same height. Do not substitute a wallet-wide balance change for `readFinalizedErc20TransferCredit`
  when a stage needs transfer evidence.
- If `readFinalizedErc20TransferProof` returns `receiptFinalized: true` with `finalized: false`,
  retain the signed attempt and configure or repair the archive/independent evidence client. Do
  not replace receipt-local logs with a latest-state balance read and do not mark the payout paid.
