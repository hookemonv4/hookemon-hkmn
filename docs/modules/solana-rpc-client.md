# Solana Rpc Client

## Purpose

`packages/adapters/src/solana-rpc.mjs` provides dependency-injected Solana JSON-RPC reads, transaction construction helpers, and signed-byte broadcast. It holds no key material and never signs. Lifecycle stages use it to prove finality, validate provider blockhashes before signing, inspect token-account ownership, and reconcile exact atomic deltas.

## Public interface

- `createSolanaRpcClient({ rpcUrl?, fetchImpl?, timeoutMs?, commitment? })` creates a lightweight client with one explicit JSON-RPC request per call.
- Finality and liveness reads: `readLatestBlockhash`, `readBlockHeight`, `readBlockhashValidity`, `readUsableLatestBlockhash`, `readSignatureStatus`, `readFinalizedSignatureStatus`, `getFinalizedTransaction`, and `getFinalizedTokenBalanceChanges`.
- Asset reads: `getTransactionTokenBalanceChanges`, `getTransactionMplCoreTransfers`, `readMplCoreAssetOwner`, and `readAssociatedTokenAccount(owner, mint, { tokenProgramId? })`. The associated-account read verifies the derived address, token program, mint, owner, amount, and decimals; a missing account is returned as `exists: false`.
- Construction helpers: `deriveAssociatedTokenAddress`, `buildTransferCheckedInstruction`, `buildPriorityFeeInstructions({ computeUnitLimit, microLamports })`, and `buildUnsignedTransaction`.
- `submitSignedTransaction(client, signedTxBase64, { skipPreflight? })` broadcasts bytes that an external signer already produced.
- Typed failures are `SolanaAdapterError`, `SolanaNetworkError`, `SolanaRpcError`, and `SolanaMalformedResponseError`.

## Invariants

- Finalized helpers always request finalized commitment. A lower-confirmation signature is unresolved, not settlement evidence.
- A provider transaction is checked with `isBlockhashValid` before signing. A caller may fetch a fresh blockhash only before a transaction has been signed or sent; it must not replace signed bytes after an ambiguous send.
- Priority fees require an explicit positive compute-unit limit and canonical atomic-unit string. The helper adds only the standard Compute Budget instructions.
- Associated token-account validation fails closed on a missing, malformed, wrong-program, wrong-mint, or wrong-owner account.
- Token balance helpers preserve raw atomic strings and do not infer which asset represents the economic transfer. Lifecycle code attributes an exact owner and configured mint before recording a typed amount.
- Core asset support identifies transfer candidates and then verifies current owner. Compressed-asset parsing and provider-specific asset layouts are **UNVERIFIED** and must not be guessed.
- This module has no retry loop for a broadcast. Stages own durable attempt state and may retry only a not-yet-signed preflight read with a fresh blockhash.

## State transitions

The module is stateless. Its safe lifecycle use is:

`verify ATA and policy inputs -> obtain or validate usable blockhash -> construct/sign once -> broadcast signed bytes once -> observe finalized status and asset deltas`.

The durable stage journal owns all transitions around that sequence, including recovery after an ambiguous broadcast.

## Operational commands

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test packages/adapters/test/solana-rpc.test.mjs
```

## Recovery pointers

- A not-finalized or unavailable signature remains pending. Do not re-sign or substitute a new transaction merely because RPC observation is delayed.
- A stale blockhash discovered before signing can be replaced by a fresh blockhash under a bounded stage-owned retry. A stale blockhash after signing requires reconciliation of the recorded signed transaction.
- Fixture coverage is in `packages/adapters/test/solana-rpc.test.mjs`; update response-shape checks only from current RPC documentation or a pinned captured response.
