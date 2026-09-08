# Collector Purchase Binding Contract

**Status: DRAFT. Not approved. Not runtime authority.** This document proposes a schema and
construction contract for an offline, unwired module. No field, digest, or address in this
document is a live Collector binding, and nothing here authorizes signing, broadcast, or
production wiring. Every key and digest shown as an example uses synthetic, isolated test data.

## Why this proposal exists

`packages/adapters/src/signing/transaction-policy.mjs` already enforces the full exact-rule shape
and instruction order needed to evaluate a decoded Collector purchase transaction
(`RULE_FIELDS`, `ruleConstraint`). What the repository does not yet have is a trusted way to turn
one frozen, provider-specific binding into that canonical policy without ever trusting the
candidate transaction being evaluated. This proposal freezes that parser and factory contract so
the evaluation kernel can be exercised end to end against a purchase-only binding, entirely
offline. It does not touch `collector-policy-loader.mjs`, which remains evidence-only for the
reasons already recorded in `docs/modules/transaction-policy.md`.

## Scope boundary

### Included

- The exact-key `CollectorPurchaseBindingV1` schema and its validator.
- Canonical `sha256:` digest verification of a binding against an externally supplied expected
  digest.
- `createCollectorPurchasePolicy`, which builds one canonical `hookemon.transaction-policy.v1`
  policy and its complete adapter rule sidecar for the `purchase` stage from a validated binding,
  durable per-cycle facts, and independently trusted blockhash/deadline context.
- Refusal behavior for malformed, incomplete, unknown-role, non-plain, or digest-mismatched
  input.

### Excluded (deliberately, until separately approved)

- Any live Collector program ID, settlement account, provider co-signer key, or mint address.
  Every account in this document and its accompanying test suite is a freshly generated,
  synthetic Solana key that exists only for the digest and parser check below.
- Reading the binding from a repository file path, environment variable, or preflight-supplied
  digest. `expectedDigest` is a caller-supplied argument only; no fixed lookup path exists yet.
- Wiring this module into `compose.mjs`, `purchase.mjs`, environment configuration,
  `architecture/interfaces.json`, or `bindings/index.json`.
- `open`, `buyback`, or any non-purchase Collector action.
- A `runtime-ready` status, a rehearsal, or any claim that a live signer may use this policy.

## `CollectorPurchaseBindingV1` schema

The binding is JSON text or a plain object with exactly these top-level fields (no self-declared
digest field — the digest is always computed by the caller and passed in separately, so a binding
can never assert its own authenticity):

| Field | Type | Constraint |
| --- | --- | --- |
| `schema` | string | exactly `hookemon.collector-purchase-binding.v1` |
| `version` | number | exactly `1` |
| `provider` | string | exactly `collector-crypt` |
| `chainId` | string | exactly `solana-mainnet` |
| `format` | string | exactly `legacy` (no v0/address-lookup-table transactions) |
| `addressLookupTables` | array | exactly `[]` |
| `settlement` | object | `{ destination, mint, decimals }`, each a valid Solana public key / integer 0-255 |
| `providerCoSigner` | string | a valid Solana public key |
| `instructions` | array | exactly 4 templates, in this fixed order (see below) |

Each instruction template has the exact fields `kind`, `programId`, `accounts`,
`computeUnitLimit`, `priorityFeeCapAtomic`, `memoPrefix` (unused fields for a given `kind` are
`null`). The four fixed positions are:

1. `compute-budget-set-unit-limit` — Compute Budget program, no accounts, an exact
   `computeUnitLimit` (1-1,400,000).
2. `compute-budget-set-unit-price` — Compute Budget program, no accounts, a
   `priorityFeeCapAtomic` **ceiling** in micro-lamports per compute unit (the actual fee paid may
   be anything from 0 up to this cap; it is not fixed).
3. `spl-transfer-checked` — a supported SPL Token program, with exactly the account roles
   `source-ata`, `settlement-mint`, `settlement-destination`, `operator-fee-payer` in that order.
4. `unknown` (memo) — the Solana memo program, with a fixed `memoPrefix`; the full memo text is
   `memoPrefix` concatenated with the per-cycle `memoValue` fact.

Each `accounts` entry declares `{ role, isSigner, isWritable }`. `role` must be one of
`operator-fee-payer`, `source-ata`, `provider-co-signer`, `settlement-destination`,
`settlement-mint` — any other role is refused. `isSigner`/`isWritable` are declared by the
binding and checked byte-for-byte against the decoded candidate at evaluation time; they are not
inferred or defaulted.

## Digest domain

`assertCollectorPurchaseBindingV1(bindingInput, expectedDigest)`:

1. Parses `bindingInput` (JSON text or object) and rejects any accessor property or non-plain
   prototype in the resulting object graph, so a getter cannot return one value for the digest
   check and a different value for later use.
2. Computes `sha256:<hex>` over the canonical JSON form of the parsed object (the same
   canonicalization `packages/runner/src/cycle/journal.mjs` uses elsewhere) and requires it to
   equal the caller-supplied `expectedDigest` exactly. There is no field in the schema the binding
   could use to declare its own digest, so this check can never degrade to trusting the input's
   opinion of itself.
3. Only after the digest matches does it validate the exact-key schema above.

A future approval step must decide where `expectedDigest` comes from in production (frozen
preflight authority is the current candidate, per `collector-policy-offline-implementation-scope.md`)
and freeze one repository binding file path. Neither exists yet; this proposal only fixes the
shape the eventual approved value must satisfy.

## Trust inputs to `createCollectorPurchasePolicy`

```
createCollectorPurchasePolicy({ binding, expectedDigest, cycleFacts, blockhashContext })
```

Exactly these four keys are accepted; any additional key (in particular anything that looks like
a candidate transaction, decoded semantics, or raw bytes) is refused before any other input is
read. No candidate transaction is ever a legal argument to this function.

- `binding` / `expectedDigest`: as above.
- `cycleFacts` (durable, per-cycle, exact keys): `operatorFeePayer`, `sourceAta`, `amountAtomic`,
  `memoValue`, `requestDigest`. These are the only fields that vary between purchases; everything
  else is fixed by the binding.
- `blockhashContext` (independently trusted, e.g. from a just-queried RPC, exact keys):
  `blockhash`, `lastValidBlockHeight`, `currentBlockHeight`. Construction refuses a context whose
  `currentBlockHeight` already exceeds `lastValidBlockHeight` — an already-dead window is never
  turned into a policy.

## Output

The canonical policy and its rule sidecar are built field-by-field from the three inputs above
and passed directly to `createTransactionPolicy` — `createCanonicalTransactionPolicy`'s
candidate-derived defaults are never invoked, because there is no candidate to derive them from.
The returned value is exactly what `evaluate()` and `readTransactionPolicyRules()` from
`transaction-policy.mjs` already accept; this module adds no new evaluation path.

## Refusal behavior

Construction refuses: a binding whose digest does not match, an unknown or missing binding field,
an unknown account role, an invalid Solana public key anywhere a key is expected, a `v0` format or
non-empty address-lookup-table declaration, an accessor/non-plain binding object, a missing
`cycleFacts` or `blockhashContext` field, and an incoherent (already-expired) blockhash context.
Evaluation of a real candidate against the resulting policy still goes through the existing
`transaction-policy.mjs` kernel unchanged, so a mismatched destination, account flag, amount,
mint, decimals, memo, compute/priority fee, blockhash, deadline, instruction order, or extra
instruction is refused exactly as it already is for every other transaction policy in this
repository.

## What remains before this can wire into anything live

- Owner approval of this schema and digest domain.
- A real Collector `collector-crypt` binding: its actual settlement destination, mint, provider
  co-signer, and program/account layout, together with an owner-approved `expectedDigest` and its
  source of truth (frozen preflight authority is proposed above, not yet implemented).
- A fixed repository path for that binding file and the corresponding `architecture/interfaces.json`
  / `bindings/index.json` / `environment.mjs` entries — all currently untouched by this proposal.
- Replacing the current evidence-only `collector-policy-loader.mjs` stage lookup with this factory
  once the above exists, as a separate, explicitly reviewed change.

None of the above exists today. This document does not claim otherwise.
