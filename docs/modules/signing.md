# Signing

## Purpose

The signing module is the external sign-only boundary for the two Phase 3 Operations identities. It returns signatures over policy-approved EVM or Solana bytes without giving the application Node process custody of a signing secret. It decodes provider transactions, applies the runner-owned canonical policy and explicit adapter rules before signing, and revalidates the exact signed bytes before a guarded transport can broadcast them.

## Public interface

- Frozen but unimplemented interface names are `requestExternalSignature`,
  `checkSignOnlyReadiness`, and `verifyReturnedSignature`. Current clients expose `probe`, `sign`,
  and guarded `broadcast` through the concrete wrappers below.
- `packages/adapters/src/signing/signer-client.mjs` exports `wrapTransactionPolicySignerClient({ client, policy, rules, decodeOptions, broadcast? })`. `policy` is the runner-owned canonical envelope and `rules` are the explicit adapter-only decoded-transaction rules. It accepts only the broadcast-capable `operator-evm` and `operator-solana` roles, snapshots the request before its first asynchronous boundary, evaluates the decoded transaction before `sign()`, records the approved semantics under the returned bytes, returns a frozen envelope containing only `signedTx` or `signedTxBase64`, and revalidates the envelope before calling `client.broadcast()` or the supplied transport callback. Provider requests supply only `transaction`; they cannot replace trusted chain, lookup-table, token-metadata, blockhash, or height controls. `isTransactionPolicySignerClient(client)` recognizes only clients created by this wrapper, so direct money-stage call sites can reject raw signers. The compatibility API also exports `SIGNER_ROLES`, `ROLE_CAPABILITIES`, `wrapSignerClient`, `signRequestDigest`, `assertNoSecretLookingValue`, and `SignerClientError`; `operations-trigger` is a compatibility enum only and is absent from production composition.
- `wrapSignerClient` re-reads the active authority immediately before every backend `sign()` and
  `broadcast()` call. Operations roles require the generic frozen mutation authority;
  distribution-signer and verifier roles require the retained-custody authority and remain
  unavailable under the current Phase 3 boundary. External-module, keychain, and policy-wallet
  clients forward an optional authority only for tests. They accept only the exact fixture object
  while the Node test-runner context marker is present; that seam grants no deployment or live
  caller authority.
- `packages/adapters/src/signing/transaction-policy.mjs` exports `TRANSACTION_POLICY_SCHEMA` and `TRANSACTION_POLICY_VERSION` from the runner's `hookemon.transaction-policy.v1` contract, plus `createCanonicalTransactionPolicy`, `createTransactionPolicy`, `bindTransactionPolicy`, `readTransactionPolicyRules`, `TransactionPolicyError`, `decodeProviderTransaction(input)`, `evaluate(policy, decoded)`, `captureSolanaCoSignerSignatures(transactionBase64)`, and `revalidateSignedMessage(signedMessage, approved, options)`. The decoder accepts viem-decodable raw EVM transactions, unsigned EVM `{ to, data, value, chainId }` objects, and legacy or v0 Solana full transactions or bare messages encoded as base64. It returns `hookemon.transaction-policy.decode.v1` descriptions with chain and program identifiers, target or selector, source, destination, mint or token, nonce, typed atomic amounts, native value, gas, fee payer, signer slots, instructions, blockhash or deadline, and priority-fee data.
- The runner's `hookemon.transaction-policy.v1` validator owns the only policy envelope that crosses a signing boundary. `createTransactionPolicy` keeps frozen adapter rules in a process-local sidecar; `bindTransactionPolicy` accepts an explicit `{ policy, rules }` binding where composition must supply both. Adapter rules never become fields of the canonical policy object.
- The general repository chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal, and
  approval-digest fields are unavailable. `PREPARED` holds `requestDigest`; `SIGNED` adds raw bytes,
  one nonce or blockhash, and a hash; it then becomes `BROADCAST` and `FINALIZED`. Live Relay stages
  use the repository's combined signing record to persist their recovery authority with the signed
  bytes; that does not change the ordinary v1 schema.
- EVM decoding supports legacy and EIP-1559 envelopes. It rejects access lists, authorization lists, blob fields, other unmodeled typed-envelope fields, and unsafe JavaScript integer inputs. ERC-20 decoding requires explicit token metadata. Solana compute-unit prices use `native-microlamports-per-compute-unit` with 15 decimals. Solana v0 address lookup tables come from `lookupTableResolver` or `lookupTableRpc.getAddressLookupTable`; reads use finalized commitment and reject unresolved, mismatched, or inactive tables. `blockhashContextResolver` must return the transaction's exact blockhash with `lastValidBlockHeight`, and `currentBlockHeightResolver` must return a canonical non-negative height.
- `packages/adapters/src/signing/external-module-signer.mjs` exports `createExternalModuleSignerClient({ modulePath, role, liveMode, transactionPolicy, transactionPolicyRules, transactionDecodeOptions })`. It wraps the operator module with `wrapSignerClient` and adds the transaction-policy wrapper when a canonical policy and its separately named adapter rules are supplied. Digest-only and caller-owned integrations remain low-level until composition supplies policy, rules, and trusted decoding context.
- `packages/adapters/src/signing/keychain-signer.mjs` exports `createKeychainSignerClient({ role, liveMode, exec, command, account, args, timeoutMs, transactionPolicy, transactionPolicyRules, transactionDecodeOptions })`. Its executor receives `{ command, args, input, timeoutMs, signal }`; the default timeout is 10 seconds. `probe()` sends a non-broadcast readiness operation and accepts only `{ ready: true }`. Executor errors and stderr are bounded, and credential assignments, raw secret hex, and mnemonic-shaped text are redacted. The module imports neither `node:child_process` nor `node:fs`.
- `packages/adapters/src/signing/keychain-process-exec.mjs` exports `createProcessExec()`. Both keychain-backed command-line entry points use it. A timeout or abort sends `SIGTERM`, escalates to `SIGKILL` after 100 ms, and settles only after the child exits.
- `packages/adapters/bin/hookemon-keychain-signer.mjs` implements the keychain wire protocol for `operator-evm` and `operator-solana`. It accepts `<probe|sign|broadcast> --role <role> --account <account>` plus one JSON line `{ operation, role, account, digest, request }`, checks the request digest, returns `{ ready: true }` for a successful probe and signed transaction bytes for signing, and reports `broadcast_not_supported` because the RPC transport broadcasts. Its Solana route delegates raw non-live signing to the Operations child and refuses live requests because trusted policy resolver callbacks cannot cross the one-line JSON boundary. It uses the `hookemon-operations` service and checks the configured role-to-account binding.
- `packages/adapters/src/signing/keychain-child-evm.mjs` and `packages/adapters/src/signing/operations-wallet-keychain-child.mjs` create or read Operations credentials only in short-lived wallet or keychain helpers. They derive and validate the public identity, sign readiness or transaction payloads, and clear known secret buffers before exit.
- `packages/adapters/rehearsal/macos-keychain-solana-signer.mjs` exports `createSignerClient({ expectedAccount, externalSigner, transactionPolicy, transactionDecodeOptions, timeoutMs?, service?, account? })`. The rehearsal adapter accepts an injected secret-free external signer only; it does not accept a credential reader, reconstruct a `Keypair`, or create a Node child. It passes only public metadata and serialized transaction bytes, evaluates policy before the external call, revalidates the returned bytes, and exposes no broadcast path.
- `loadOperatorSignerClient(config, { exec? })` keeps external-module and keychain clients as low-level adapters in non-live composition. Live Operations loading accepts only the two configured Operations roles after pinned transaction policies and trusted decode context are wired; it rejects a raw or third Operations signer.

## Invariants

- The Phase 3 production transaction-policy surface exposes exactly Operations EVM and Operations
  Solana. `operations-trigger` remains an exported compatibility enum outside production
  composition and cannot be wrapped by `wrapTransactionPolicySignerClient`; payout therefore
  refuses the third-identity route rather than accepting an unguarded signer.
- Production signing occurs outside the application Node process unless a recorded owner exception permits another location. No secret, raw key, generic signer, or unrelated identity enters repository state or the dashboard.
- A policy wrapper receives a plain immutable request snapshot. The backend receives that snapshot rather than the caller's mutable input, and broadcast receives a separate frozen signed-byte envelope.
- A signature is bound to one decoded message, policy digest, cycle journal entry, and nonce or blockhash context. Transaction policy is default-deny: scalar fields, nonces, programs, accounts, signer lists, instruction order, and opaque call data match exactly. Amount rules are exact or use an explicit atomic minimum or maximum while retaining the same `chainId`, `assetId`, and decimals. Solana public keys compare as canonical base58 bytes and are never lowercased.
- Every signed Solana message is a complete serialized transaction. Every required Ed25519 signature slot is nonzero and verifies over the serialized message. Pre-existing co-signer signatures are captured before signing and must remain byte-identical at broadcast.
- No unresolved Solana v0 lookup table reaches a signer. Finalized lookup-table reads must return the requested active table. The resolver contract does not yet carry account-owner or raw-data-digest evidence, so live composition remains refused until that contract is frozen and implemented.
- Solana policy validation resolves trusted blockhash context and current height before signing, then refreshes current height immediately before broadcast. The refreshed observation is excluded from semantic equality. A missing, mismatched, or expired context is rejected; a blockhash is valid through `lastValidBlockHeight` and expires after it, and a `deadline: null` rule cannot bypass that expiry check.
- Signed bytes are revalidated and reevaluated before guarded broadcast. The process-local approval cache retains an approval only until its matching broadcast succeeds. Changed recipient, mint, amount, instruction, chain, fee payer, blockhash, signer set, co-signer signature, or unapproved signed bytes never reach the transport.
- The approval context's `signedMessageDigest` is SHA-256 over raw decoded transaction bytes: EVM
  hexadecimal is decoded before hashing and Solana base64 is decoded before hashing. Its
  `approvalDigest` then binds that byte digest with the policy and approved semantics. Boundary
  tests calculate the raw-byte digest independently.
- Keychain calls have finite, inspectable failures. They pass an abort signal and deadline, reap timed-out children, preserve benign operating-system errors, and redact credential-shaped text before including bounded diagnostics.
- A keychain interaction denial reaches the stage driver as a pre-call failure. The driver records
  `NOT_SENT`, holds the cycle `HELD_UNAVAILABLE`, retains only redacted operating-system text, and
  invokes no broadcast.
- The Operations wallet writer sends `/usr/bin/security -i` a command through standard input and never places the credential in a process argument. It requires the default Keychain to equal the login Keychain, passes the verified login-Keychain path explicitly, and clears known secret buffers after writing.
- The policy wrapper's approval cache and direct-payout derived-policy cache are process-local. An
  ordinary CycleRepository v1 signing record persists signed bytes but not the frozen policy or
  semantic-approval digest, so its restart rebroadcast remains closed. Built-in Relay routes persist
  matching recovery authority through the repository's combined signing record. Direct-payout
  recovery first reads the authoritative paged repository state, then checks the matching signed
  recipient record and its persisted approval context; neither cache authorizes restart recovery.
- A signer wrapper cannot reach its backend while the active authority is provisional or digestless.
  It checks at each sign and broadcast call, after request preparation and immediately before the
  external effect.

## State transitions

- A provider transaction becomes signable after an immutable snapshot is approved by the policy
  engine, decoded, and explicitly approved by transaction policy.
- Transaction-authorized signing follows **provider transaction** → **immutable snapshot** → **decoded semantics** → **policy approval** → **external signature** → **frozen signed envelope** → **fresh signed-byte revalidation** → **policy recheck** → **guarded broadcast**. A failure stops the request before the next transition.
- The rehearsal path stops after fresh signed-byte revalidation because it has no broadcast method.
- A returned signature becomes `SIGNED` only when its bytes, required signature slots, co-signers, identity, and trusted chain context verify exactly. An unavailable, timed-out, malformed, expired, or changed response leaves the transaction unsigned; a stage-level pre-call failure records `NOT_SENT` and its terminal hold before recovery.
- A current durable chain record advances only
  `PREPARED -> SIGNED -> BROADCAST -> FINALIZED`. Frozen v2 adds the fenced `REFUSED` record.
- An Operations wallet helper follows **start** → **generate or keychain read** → **derive and validate public identity** → **readiness or transaction signature** → **clear known secret buffers** → **exit**.

## Operational commands

- Check sign-only readiness before a signable runner or money stage. Submit only the exact approved bytes persisted with the cycle journal, and revalidate them before transport.
- Use `node packages/adapters/bin/hookemon-wallet.mjs generate|show|probe --identity operations-evm|operations-solana` only on the owner-approved Mac. `probe` creates a fixed internal signature and never broadcasts; `export-public --out <absolute-path>` writes only public data.
- Configure `packages/adapters/bin/hookemon-keychain-signer.mjs` only with the corresponding public account bindings. Use its Solana route for probe and non-live raw signing; keep live Solana signing closed until an authenticated policy-and-context transport is frozen. It accepts no secret configuration.
- Run the focused signing-boundary checks with:

  ```sh
  cd packages/adapters
  node --test --test-timeout=120000 \
    test/app/environment.test.mjs \
    test/app/return-degraded.test.mjs \
    test/app/stages-collector-lifecycle.test.mjs \
    test/app/stages-rehearsal.test.mjs \
    test/rehearsal-signer.test.mjs \
    test/signing/hookemon-verifier.test.mjs \
    test/signing/keychain-process-exec.test.mjs \
    test/signing/keychain-signer.test.mjs \
    test/signing/transaction-policy.test.mjs
  ```

- Run `node --test test/wallet-cli.test.mjs test/signing/hookemon-keychain-signer.test.mjs` from `packages/adapters` to verify wallet generation, public-only output, overwrite protection, wire-protocol digest checks, account binding, and non-broadcast behavior.
- Decoder implementation references are Solana `TransactionMessage` and `MessageV0`, the Solana address lookup table APIs, and viem `parseTransaction` and `decodeFunctionData` at the versions pinned in `package-lock.json`.

## Recovery pointers

- Use the incident-specific recovery contract for a
  [keychain interaction failure](../runbooks/keychain-user-interaction.md),
  [stale Solana blockhash](../runbooks/solana-blockhash-expiry.md),
  [dropped EVM transaction](../runbooks/evm-transaction-dropped.md), a
  [replaced EVM transaction](../runbooks/evm-transaction-ambiguity.md), or
  [nonce interference](../runbooks/evm-nonce-interference.md). Each contract records the
  supported resume command or its absence.
- Keep an uncertain signing request out of broadcast until the external boundary proves whether it produced a signature. Refuse replacement signatures over changed bytes while an earlier request is unresolved.
- If signed-byte revalidation fails, do not retry the transport. Obtain a new provider transaction and approve it under an explicit reviewed policy.
- If height, blockhash context, or a lookup table is unavailable, treat the transaction as unbroadcastable and obtain fresh trusted chain state. Do not substitute cached state.
- Rebuild an interrupted signing attempt from its durable record. Keep ordinary v1 rebroadcast
  closed because it has no persisted `approvedSemanticsDigest`; reconcile it instead of constructing
  replacement bytes. Relay recovery may rebroadcast only when its combined durable recovery record
  still matches the exact bytes. Direct-payout recovery must reread the authoritative paged
  repository state and matching signed recipient record before it can use the persisted context.
- Record and review any owner exception before changing the signing location. Never bypass the
  wrapper to recover from a policy refusal; reconstruct the provider transaction and review the
  exact adapter rule or bounded amount instead.
- For a v0 lookup-table refusal, supply the requested table through the read-only resolver and
  inspect its returned table key before approval. For an expired Solana blockhash, obtain and
  approve a new provider transaction; the wrapper will not broadcast the old signed message.
- If a keychain helper times out or reports `User interaction is not allowed`, restore interactive access or correct access controls, then run its sign-only probe before another attempt.
- A rehearsal account mismatch requires correcting `expectedAccount` or the external signer
  binding; transaction policy cannot repair an identity mismatch.
- If the owner Mac or login Keychain is unavailable, do not export a secret. Generate replacements, rotate the Operations EVM address through the approved path, and update the Solana policy and public bindings before funding or signing.
