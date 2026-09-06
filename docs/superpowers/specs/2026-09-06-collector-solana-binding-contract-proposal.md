# Collector purchase binding and Solana finalized-balance observation — joint contract-identity proposal

**Status: DRAFT. Not an approval. Not a requirements/architecture revision. Not a claim of
production or launch readiness.** This document proposes owner approval of two already-integrated,
still-unwired, offline artifacts as exact, pinned contracts, so that any later authoritative patch
(requirements, architecture, bindings, ADR, module cards) can cite them unambiguously by source
identity instead of by informal description. Approving this document approves the two contracts
below and nothing else: no live Collector identity, no live Solana custody identity, no
composition, signing, or readiness fact becomes true by this proposal being accepted.

## 1. Exact integrated source identity

Base repository commit at proposal time: `bc7fdcaa41cb822f57315a4f8168711ebfafad48`.

Both artifacts below are already merged into that commit's history through two integration
commits, each an exact cherry-pick of an independently reviewed candidate:

- `4edd52900ea152608bb0a8263293f6b56a34c5fc` — "feat(adapters): add offline Collector purchase
  policy binding", cherry-picked from reviewed candidate `6105b0ae6f46e18d9933fb617a398d335c1079a9`.
  Files: `docs/superpowers/specs/2026-09-06-collector-purchase-binding-contract.md`,
  `packages/adapters/src/signing/collector-purchase-policy.mjs`,
  `packages/adapters/test/signing/collector-purchase-policy.test.mjs`.
- `e86156da59b98f9b872058869fb44b5737f2e9e3` — "feat(adapters): add pure Solana finalized
  custody-balance observation helper", cherry-picked from reviewed candidate
  `40740c06108a41a1da714e3334fab69612bfb275`. Files:
  `docs/modules/solana-custody-balance-observation.md`,
  `packages/adapters/src/solana-custody-balance-observation.mjs`,
  `packages/adapters/test/solana-custody-balance-observation.test.mjs`,
  `product/SOLANA_CUSTODY_CURRENT_BALANCE_OBSERVATION_DRAFT.md`.

Immutable SHA-256 digests of the repository file bytes at `bc7fdcaa41cb822f57315a4f8168711ebfafad48`
for the files this proposal binds:

| Path | SHA-256 |
| --- | --- |
| `packages/adapters/src/signing/collector-purchase-policy.mjs` | `e2528a63151b385098ceb2dc84accaf227c94c9ec08bab4c3fcb51b0debf2ae2` |
| `docs/superpowers/specs/2026-09-06-collector-purchase-binding-contract.md` | `ebd83065d687bcfa1e84c31a87160b13e91858d4d9dccf6a3889954fef6036f9` |
| `packages/adapters/src/solana-custody-balance-observation.mjs` | `08b85e992141a3e2abc8122d857cb3fd8c7d9e165b7cb44dd3fa7c75f54e0274` |
| `docs/modules/solana-custody-balance-observation.md` | `b801f1450be8f3a96029f0c8ee3ff6909e5f28a74212dbf419a4d98801bc0b25` |
| `product/SOLANA_CUSTODY_CURRENT_BALANCE_OBSERVATION_DRAFT.md` | `3a5d829aaf7d4b5657eb0355a47788bf414131ded02a655bdc3fae14f2497af5` |

## 2. Exact contracts proposed for approval

Two independent offline contracts, approved separately and only as described here:

**(a) `CollectorPurchaseBindingV1` validation/factory**, from
`packages/adapters/src/signing/collector-purchase-policy.mjs`:
`COLLECTOR_PURCHASE_BINDING_SCHEMA`, `COLLECTOR_PURCHASE_BINDING_VERSION`,
`CollectorPurchasePolicyError`, `assertCollectorPurchaseBindingV1(bindingInput, expectedDigest)`,
`createCollectorPurchasePolicy({ binding, expectedDigest, cycleFacts, blockhashContext })`.

**(b) The pure two-source finalized observation combiner/retry interface**, from
`packages/adapters/src/solana-custody-balance-observation.mjs`:
`combineFinalizedBalanceObservation(sideA, sideB, { chainId, assetId, decimals, mint, owner, tokenProgramId, expectedGenesisHash? })`,
`observeFinalizedBalanceWithRetry(readRound, request, { maxAttempts? })`,
`SolanaCustodyObservationError`.

Approving this proposal fixes these exact exports, at the exact digests above, as the named
target for any future authoritative work that needs to refer to "the Collector purchase binding
contract" or "the Solana finalized-balance observation contract." It does not merge, compose, or
otherwise relate the two contracts to each other beyond both being pinned by this one document.

## 3. Trust-direction restatement

For (a): binding input and its expected digest must come from two independently supplied sources
(the binding bytes are never trusted to declare their own digest); candidate transaction bytes are
never a legal argument anywhere in this contract and enter only the existing, already-approved
`transaction-policy.mjs` decode/evaluate kernel, unchanged.

For (b): the observation helper receives a caller-pinned canonical `{chainId, assetId, decimals,
mint, owner, tokenProgramId}` identity plus two independently configured read sides; it performs no
RPC I/O, selects no chain/asset identity itself, and binds its output only to the identity the
caller already supplied after both sides are proven to agree with each other and with that
identity.

## 4. Preserved Collector limitations (unchanged by this proposal)

`CollectorPurchaseBindingV1` v1 supports only the legacy Solana transaction format with an empty
address-lookup-table set; a `v0`/ALT transaction is refused, not degraded. This proposal does not
approve, and this module cannot supply: any live Collector program ID, settlement destination,
mint, provider co-signer, or account layout; a repository file path or environment/preflight source
for `expectedDigest`; any wiring into `compose.mjs`, `purchase.mjs`, `architecture/interfaces.json`,
or `bindings/index.json`; `open`, `buyback`, or any non-purchase action; or any `runtime-ready`
status. The sanitized `/api/status` evidence obtained under the owner's approved-reads exception
(machineStatus `running`, 72 gachas, observed open pack codes `pokemon_25`/`pokemon_50`/`pokemon_100`
at numeric prices 25/50/100, no currency field) proves only that catalog observation. It does not
prove total cycle costs, an immutable signing identity, or any provider instruction/account
binding, and this proposal does not treat it as such.

## 5. Preserved Solana observation limitations (unchanged by this proposal)

No canonical Solana custody chain/asset identity is approved by this or any prior document: Relay
transport's `792703809` and the Collector-facing buyback-proceeds writer's `solana-mainnet` remain
unreconciled, and this proposal does not pick one or map between them. Also unapproved: an
endpoint-independence policy for the two configured RPC read sides; a durable producer; a
monotonic persisted-height/reorg rule; a repository writer that persists this helper's output as
custody evidence; or any Solana custody valuation. The pure helper in (b) validates agreement
between two supplied sides and a caller-supplied identity — it cannot itself supply or satisfy any
of the missing custody-ledger evidence above.

## 6. Future authoritative patch plan (after owner approval of this document, and separately again after real binding facts exist)

This proposal is exactly one step: **contract approval** — fixing the shape and trust rule of two
offline artifacts. It is distinct from, and does not authorize, a later, separately reviewable
**live binding approval** (real Collector program/account/co-signer/mint identity, a real
`expectedDigest` and its source, a real Solana custody chain/asset identity and endpoint-
independence policy), which is in turn distinct from overall **launch readiness** (composition,
signing, broadcast, and the rest of `authoritative-launch-handoff.md`'s acceptance criteria).

Only after both this contract approval and the corresponding live binding approval exist should a
later change:

- Amend `REQ-transaction-policy-1` and/or add a Collector-scoped requirement that names the
  approved `expectedDigest` source and repository binding path for a live `collector-crypt`
  binding.
- Amend `REQ-cycle-runner-3` to bind its `verifiedCurrentBalance` custody-ledger fact to the
  approved canonical Solana custody chain/asset identity and the (b) contract's output shape.
- Add `transaction-policy`-style module-interface entries for `collector-purchase-policy` and
  `solana-custody-balance-observation` to `architecture/interfaces.json`, each carrying the digests
  in §1 as their pinned source identity.
- Add an entry to `bindings/index.json` (following the existing `schemaVersion: 1` shape used by
  `robinhood-chain-r54-a3`) once a real binding file, path, and digest exist.
- Create the Solana counterpart of the custody-ledger migration decision — no
  `decisions/ADR-0026-*.md` file exists in this repository yet, only the open questions already
  recorded in `product/SOLANA_CUSTODY_CURRENT_BALANCE_OBSERVATION_DRAFT.md` — and update
  `docs/modules/collector-purchase-policy.md` (does not yet exist) and
  `docs/modules/solana-custody-balance-observation.md` from its current DRAFT framing once live
  facts exist, registering both in `docs/modules/index.json`.

None of the five patch items above is performed by this proposal or by its approval.

## 7. Suggested owner question

"Do you approve, exactly as pinned to commits `4edd52900ea152608bb0a8263293f6b56a34c5fc` and
`e86156da59b98f9b872058869fb44b5737f2e9e3` and the digests in §1: (a) the five-export
`CollectorPurchaseBindingV1` parser/factory and its externally-supplied-digest trust rule, and (b)
the `combineFinalizedBalanceObservation` / `observeFinalizedBalanceWithRetry` /
`SolanaCustodyObservationError` two-independent-source finalized-observation trust rule — as two
independent offline contracts only, leaving every live Collector identity, every live Solana
custody identity, all composition/signing, and all readiness unapproved and separately
reviewable?"
