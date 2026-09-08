# Unsigned Relay legacy encoding feasibility

The captured scenario in `relay-return-instruction-case.json` serializes and decodes with the adapter's pinned `@solana/web3.js` 1.98.4 as a 483-byte legacy transaction, below 1232 bytes. The test retains all supplied instructions, account occurrences and data, uses a synthetic all-zero test blockhash, and produces only a null signature placeholder. It preserves the original ALT list unchanged.

Decoded program IDs, data and ordered accounts match exactly. Effective signer/writable privileges match the transaction-wide union of supplied metas and payer privileges. The payer appears twice in the provider instruction with different flags; both decoded occurrences therefore have its effective signer/writable privileges. Per-occurrence flag equality is not a property of the Solana compiled message format.

One focused test passed, including missing key fields, missing data, detection of an omitted account against the original plan, and SDK refusal of an oversized instruction. This establishes offline SDK encoding feasibility only. It does not establish provider acceptance, blockhash validity, executable route, ALT contents, simulation success or finality. Production ALT refusal and Collector co-signed bytes remain unchanged.

Run with Node 24 and installed adapter dependencies:

```sh
node --test packages/adapters/test/native/relay-legacy-sdk-feasibility.test.mjs
```

For this isolated worktree the existing dependency installation in `../bot-n2-production/packages/adapters/node_modules` was used through `NODE_PATH`; the test independently asserts SDK version 1.98.4. No dependencies were installed or changed, and no network requests, signatures or broadcasts occurred.
