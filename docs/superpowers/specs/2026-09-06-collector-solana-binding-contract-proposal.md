# Collector purchase binding and custody-ledger evidence-construction contract — requirements revision 67 candidate

**Status: DRAFT candidate for owner approval. Not itself an approval.** An independent review will
first decide whether the exact bytes described below are ready before any owner question is asked.
This document was corrected from an earlier draft that only promised future authoritative edits and
that incorrectly stated `decisions/ADR-0026-custody-ledger-v2-migration.md` did not exist in this
repository or on any branch; it exists at reviewed source `ce428937b40cf5ef1518791f3aa97736a0bdaf7f`
and has been imported byte-for-byte (§1). This document now describes concrete, already-made edits,
not a plan to make edits later.

## 1. Exact commit chain and imported bytes

- Prior base: `bc7fdcaa41cb822f57315a4f8168711ebfafad48`.
- `0d27f812` — the prior (corrected-from) DRAFT proposal commit on this branch.
- ADR import commit (byte-for-byte, separate Conventional Commit) — imports, unmodified, from
  reviewed source `ce428937b40cf5ef1518791f3aa97736a0bdaf7f`:
  - `decisions/ADR-0026-custody-ledger-v2-migration.md` —
    `sha256:1157569815b5da153388ab6431a19a09eedeeefbf39cda494a67e636bdf23ef5` — verified identical to
    the source commit's blob (`git hash-object` matches `git rev-parse ce428937:<path>` exactly).
  - `docs/audit/2026-09-04/custody-ledger-v2-shape-DRAFT.json` —
    `sha256:a10c11db4867f1e46c6c9203c4b61872220c22cbce263cf47cc21ba3c7879dce` — same verification.
- Requirements/interfaces candidate commit (this commit) — amends `specs/requirements.json` and
  `architecture/interfaces.json` and this proposal document, per §2 below.

The two files above are imported exactly as reviewed in `custody-spec-ready-report.md` and
`custody-spec-ready-money-review.md` (both PASS for an owner decision on the EVM-only storage
shape, no requirements/architecture amendment, no test run). This proposal does not alter either
imported file's text.

## 2. Exact candidate diff

**`specs/requirements.json`:** `revision` 66 → 67. Two requirement records amended, both moved from
`status: "approved"` to `status: "proposed"` (no other requirement record touched):

- `REQ-transaction-policy-1` — adds one sentence requiring a provider-specific purchase policy
  (e.g. a Collector-crypt purchase binding) to be constructed only from binding bytes independently
  digest-pinned against a separately supplied expected digest, plus durable per-cycle facts and an
  independently observed RPC blockhash context — never from candidate transaction semantics, with
  the candidate used only by the existing canonical decode/evaluate kernel. Adds matching edge
  cases (binding digest mismatch; construction attempted from candidate-derived semantics) and a
  matching negative-measurement clause.
- `REQ-cycle-runner-3` — adds sentences naming, for the canonical EVM USDG row only,
  `hookemon.custody-ledger.v2` per ADR-0026's `verifiedCurrentBalance`
  (`CustodyBalanceObservationV1 | null`) and singular `expectedCycleAsset` (`TypedAmount | null`,
  never a collection), and the `unvaluedExposure` admission rule. Names
  `packages/adapters/src/solana-custody-balance-observation.mjs`'s pure
  `combineFinalizedBalanceObservation`/`observeFinalizedBalanceWithRetry` combiner as an *allowed
  evidence-construction contract* for a future non-EVM `verifiedCurrentBalance` — explicitly not
  itself a durable producer, canonical chain/asset identity source, custody-ledger writer,
  valuation, or live readiness proof. States a non-EVM-USDG row stays on `v1`, or, if migrated,
  stays permanently unvalued and fail-closed until a separately approved evidence producer exists.
  Adds a matching edge case and negative-measurement clause.

**`architecture/interfaces.json`:** `requirementsRevision` 65 → 67; `architectureRevision` 9 → 10.
Minimal field additions only, under the two existing interfaces named — no new module ID created:

- `cycleExecution.custodyLedger` gains `scope`, an expanded `verifiedCurrentBalance` description,
  a corrected singular `expectedCycleAssets` description, `admissionRule`,
  `nonEvmEvidenceConstructionContract` (pinning
  `packages/adapters/src/solana-custody-balance-observation.mjs` by
  `sha256:08b85e992141a3e2abc8122d857cb3fd8c7d9e165b7cb44dd3fa7c75f54e0274`, its three exports, its
  trust inputs, and its explicit non-producer/non-identity/non-writer/non-valuation/non-readiness
  status), `source` (`decisions/ADR-0026-custody-ledger-v2-migration.md`, pinned by
  `sha256:1157569815b5da153388ab6431a19a09eedeeefbf39cda494a67e636bdf23ef5`), and `liveBindingStatus`
  stating no `bindings/index.json` entry exists until a real, independently approved binding path,
  digest, and value exist.
- `transactionPolicy` gains `providerSpecificPurchasePolicy`, pinning
  `packages/adapters/src/signing/collector-purchase-policy.mjs` by
  `sha256:e2528a63151b385098ceb2dc84accaf227c94c9ec08bab4c3fcb51b0debf2ae2`, its five exports, its
  trust inputs, `integrationStatus: "UNWIRED_OFFLINE_MODULE_ONLY"`, and a `liveBindingStatus`
  stating no live Collector identity or `bindings/index.json` entry exists.

**This proposal document:** rewritten in the requirements/interfaces candidate commit to describe
the above as done, not promised.

No other file is part of this candidate. `bindings/index.json`,
`architecture/provisional-interfaces.json`, any module card or `docs/modules/index.json`, gates,
product delivery projection, runtime, tests, package files, receipts, and generated projections are
untouched.

## 3. Validation performed

- Both amended/imported JSON files parse (`jq empty specs/requirements.json`,
  `jq empty architecture/interfaces.json`; both succeeded).
- `jq` spot-checks confirm `revision: 67`, both amended requirement records' `status: "proposed"`,
  and `interfaces.json`'s `requirementsRevision: 67` / `architectureRevision: 10`.
- The imported ADR/JSON pair's blob identity against `ce428937` was verified with
  `git hash-object`/`git rev-parse` (exact match, §1).
- `node`-based repository structural checks (e.g. `scripts/v4.mjs trace check`) could not be run in
  this environment: every `node` invocation beyond `node --version` was blocked by this session's
  permission gate, including with sandbox restrictions disabled. This is recorded as an actual
  limitation, not a passed check. A manual `jq` query against `tasks.json` shows neither
  `REQ-transaction-policy-1` nor `REQ-cycle-runner-3` is currently referenced by any task entry —
  unchanged from before this candidate, since `tasks.json` is not part of this candidate and was not
  edited.
- No adapter test was run, per instruction.

## 4. Preserved scope and open facts (unchanged in substance from the prior draft)

- This is a **contract-shape candidate**, not a **live binding approval**, and not **launch
  readiness**. No live Collector program/account/co-signer/mint identity, no `expectedDigest`
  source or repository path, no canonical Solana custody chain/asset identity or Relay-label
  mapping, no endpoint-independence policy, no durable producer, no monotonic-height/reorg
  persistence, and no repository writer for any non-EVM row is approved or created by this
  candidate.
- ADR-0026's own scope statement stands as imported: the EVM USDG row is the only row this revision
  gives a real `verifiedCurrentBalance` producer for; every other row is fail-closed and
  permanently unvalued until a future, separately reviewed producer exists.
- The Solana finalized-observation contract is bound here by its runtime source digest
  (`packages/adapters/src/solana-custody-balance-observation.mjs`,
  `sha256:08b85e992141a3e2abc8122d857cb3fd8c7d9e165b7cb44dd3fa7c75f54e0274`) and by
  `product/SOLANA_CUSTODY_CURRENT_BALANCE_OBSERVATION_DRAFT.md`, not by
  `docs/modules/solana-custody-balance-observation.md`'s current path: a separate documentation
  cleanup may fold that module card into the existing custody-ledger module card and delete the
  redundant standalone card, and this candidate's identity does not depend on that path surviving.
- The sanitized Collector `/api/status` evidence remains catalog-only: machineStatus `running`, 72
  gachas, open `pokemon_25`/`pokemon_50`/`pokemon_100` at prices 25/50/100, no currency field. It
  does not prove cycle costs, a signing identity, or any provider instruction/account binding.
- No owner approval, approval receipt, runtime-ready flag, binding value, or provider identity is
  fabricated by this document.

## 5. Owner question

**Withheld.** An independent review will first decide whether the exact bytes in §1–§2 are ready
for an owner decision. No owner question is posed in this revision of the document.
