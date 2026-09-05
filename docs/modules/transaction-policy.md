# Transaction Policy

## Purpose

`packages/runner/src/cycle/transaction-policy-schema.mjs` names the canonical
`hookemon.transaction-policy.v1` envelope and delegates its validation to
`money-schemas.mjs`. Adapter decoding produces a separate transaction description and the adapter
keeps detailed matching rules beside, never inside, the canonical policy. `createTransactionPolicy`
stores those frozen rules in a process-local sidecar; `bindTransactionPolicy` validates an explicit
`{ policy, rules }` binding when composition supplies the pair. The canonical envelope remains the
only policy object that crosses a signing boundary.

The same runner module owns `MoneyConfigurationV1`. Environment parsing constructs the record from
explicit asset metadata and atomic values; composition revalidates that one record before a
production or rehearsal service can open durable state.

## Public interface

- `decodeProviderTransaction(input)` supports EVM legacy and EIP-1559 transactions plus unsigned
  EVM objects, and Solana legacy or v0 messages encoded as base64.
- `evaluate(policy, decoded, options?)` validates the canonical runner policy and its explicit
  adapter-rule sidecar or `{ policy, rules }` binding against every decoded semantic field.
- `captureSolanaCoSignerSignatures(transactionBase64)` validates and preserves pre-existing
  required co-signer slots before Operations signing.
- `revalidateSignedMessage(signedMessage, approved, options)` requires exact signed EVM bytes or a
  full signed Solana transaction, decodes them with trusted controls, and compares the semantics
  with the approved record.
- `wrapTransactionPolicySignerClient()` retains a policy approval record for signed bytes.
  `readTransactionPolicyApprovalContext()` returns its durable digest form and
  `recoverTransactionPolicyApproval()` decodes and re-evaluates exact retained bytes without
  calling `sign()`, so the guarded caller still owns the broadcast boundary.
  `recoverTransactionPolicyBroadcast()` is the direct-client convenience form.
- Broadcast result fields named `transactionHash` or `txHash` are public transaction identifiers.
  The signer boundary permits those fields even though their 32-byte hexadecimal shape resembles
  private-key material; unnamed secret-shaped output remains rejected.
- `assertCanonicalTransactionPolicy()` delegates to the runner validator for
  `hookemon.transaction-policy.v1`. `createCanonicalTransactionPolicy()` derives that exact shape
  from a decoded request, and `createTransactionPolicy()` or `bindTransactionPolicy()` associates
  the separate adapter rules without changing the canonical object.
- `validateMoneyConfiguration(value)` wraps the canonical `assertMoneyConfiguration()` result in a
  frozen configuration value. It is exported from the environment boundary and re-exported by the
  composition root. Invalid input raises `MoneyConfigurationRejected` before adapter composition.
- `MoneyConfigurationV1` carries typed USDG and Solana-stablecoin assets, three typed receive
  minima, EVM `perTransactionGasPriceCap` and `nativeReserve`, plus Solana `priorityFeeCap` and
  `lamportReserve`. The configured Relay quote must use the decimal precision from this record's
  route asset, not a separate default.

## Invariants

- Amounts are typed `{ chainId, assetId, decimals, amountAtomic }` values. Atomic quantities are
  canonical integer strings.
- Production and rehearsal have no implicit money defaults. The frozen USDG binding supplies the
  EVM asset metadata; the operator supplies the Solana mint and decimals. All three minima and all
  four native-fee controls are present, and atomic value `1` is rejected as a placeholder. The
  production return minimum is the revision-63 explicit zero-valued typed USDG amount: every
  nonzero return minimum is a configuration error.
- Policies bind chain, nonce, programs, lookup tables, target, selector, source, destination,
  mint, token, amount, native value, gas, fee payer, required signers, co-signers, instruction
  order, extra instructions, blockhash, deadline, and priority fee.
- EVM decoding rejects unsupported typed-envelope fields and unsafe JavaScript numeric inputs.
  ERC-20 transfers require explicit token metadata.
- Solana revalidation requires a full serialized transaction. Every required signature is nonzero
  and cryptographically valid over the serialized message. Captured co-signer signatures must not
  change.
- A `deadline.notExpired` rule requires a canonical observed height. A current-height resolver and
  blockhash-context resolver are required for signed Solana revalidation, so cached state cannot
  authorize broadcast.
- A Solana blockhash remains valid at its recorded `lastValidBlockHeight` and expires only after
  the observed height is greater than that boundary.
- A durable approval context contains the active `policyDigest`, the decoded
  `approvedSemanticsDigest`, an exact `signedMessageDigest`, and an `approvalDigest` over those
  values. Recovery requires every digest to match the freshly decoded signed bytes and active
  policy. A changed byte string, policy, semantic description, or deadline remains unapproved.
- `signedMessageDigest` hashes raw decoded transaction bytes, not their hex or base64 text. The
  approval context then binds that raw-byte digest to policy and approved semantics; the boundary
  suite includes an independently computed raw-byte test vector.
- Generic chain attempts record `PREPARED(requestDigest)`, then
  `SIGNED(rawBytes, nonce or blockhash, hash)`, followed by `BROADCAST` and `FINALIZED`. Relay
  attempts use their combined signing record; direct-payout recipient records retain their durable
  approval and fencing context with those bytes. A plain attempt without that context remains
  non-rebroadcastable after restart.
- The chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal, and approval-digest fields are unavailable.
- v0 lookup tables are resolved at finalized commitment and must match the requested key and be
  active. The current resolver result lacks owner and raw-account-data digest evidence; a live
  policy path must remain unavailable until the frozen resolver interface provides both.

## State transitions

`undecoded -> decoded -> canonical policy plus adapter rules -> PREPARED -> SIGNED -> BROADCAST -> FINALIZED`

Money configuration follows `explicit input -> MoneyConfigurationV1 validation -> frozen
composition value`. A missing field, mismatched asset identity or decimals, placeholder atomic
value, or nonzero return minimum terminates at `MoneyConfigurationRejected` before a transaction
policy or signer is reached. Claim checks both EIP-1559 fee fields against the typed EVM gas-price
cap and requires `gasLimit * maxFeePerGas + nativeReserve` before signing. Return, purchase, and
buyback require the configured Solana stablecoin asset, cap the decoded priority fee, and require
the lamport reserve plus the maximum decoded priority fee before signing.

Any malformed message, missing signature, changed co-signer slot, unavailable chain context, or
semantic difference returns the transaction to recovery handling without submitting bytes. A
durable Relay or direct-payout attempt may transition from `SIGNED` or `BROADCAST` through
exact-byte reauthorization to broadcast; it never creates another signature during that recovery.

## Operational commands

```sh
cd packages/adapters && node --test --test-timeout=120000 test/signing/transaction-policy.test.mjs
cd packages/adapters && node --test --test-timeout=120000 test/signing/transaction-policy-schema-boundary.test.mjs
```

The suite uses independently authored EVM, legacy-Solana, and v0-with-ALT policies. It includes a
one-field mismatch matrix for every adapter-rule category and wire-level negatives for recipient,
mint, amount, extra instruction, expiry, fee payer, lookup-table resolution, and signatures.

## Recovery pointers

- Use the specific recovery boundary for a
  [wrong recipient](../runbooks/transaction-policy-wrong-recipient.md),
  [wrong asset](../runbooks/relay-wrong-asset.md),
  [stale blockhash](../runbooks/solana-blockhash-expiry.md),
  [dropped or replaced transaction](../runbooks/evm-transaction-ambiguity.md),
  [nonce interference](../runbooks/evm-nonce-interference.md), or
  [signer interaction failure](../runbooks/keychain-user-interaction.md). Each recovery contract
  records the supported resume command or its absence.
- Obtain a new provider transaction after expiry or a changed signed message. Do not reuse the old
  approval for altered bytes.
- Treat missing height, blockhash-pair, or lookup-table evidence as unavailable state. Do not infer
  validity from a prior observation.
- On restart, require a persisted approval context and revalidate the exact retained bytes. If the
  context is absent or any digest differs, keep broadcast closed rather than using the in-memory
  signer cache or creating a replacement signature.
- Direct-payout restart recovery also requires the authoritative paged payout state from the
  repository. A process-local derived-policy cache or caller-supplied payout state cannot authorize
  a recovered broadcast.
- Correct a rejected money configuration at the environment boundary. Do not restore removed
  defaults or use the legacy native-cap projection in place of EVM gas-price/native-reserve or
  Solana priority-fee/lamport-reserve controls.
