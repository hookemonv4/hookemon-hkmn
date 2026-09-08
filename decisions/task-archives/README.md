# Unsigned historical PR38 archive decisions

These two descriptors are **UNSIGNED proposals with no approval authority**. They request only the explicit historical USDG classification supported by `TASK_ARCHIVE_HISTORICAL_USDG_COMPLETION`. No owner-approval artifact has been created, no archive disposition has been applied, and neither document completes current native ETH work.

Both bind the coordinator's canonical prepared task state to target commit `b2cb737a298522e3944652e862c4eeab195667d8` and preserved archive commit `c797b6c0a9c856752d05ee2ddd18dd2411571d6f`. The coordinator produced `pr38-cleanup-archive-prestate.json` and `pr38-redaction-archive-prestate.json` under `.session/eth-execution-20260908/`. The descriptors retain those exact prestates and inventories; no task state was inferred or recreated locally.

| Descriptor | Original completion | Changed source paths | Prestate fingerprint |
| --- | --- | --- | --- |
| `PR38-EVIDENCE-CLEANUP.json` | `34fc4006e3f05a60d6a3cd9fc8383b445330aa62` | Five exact archived counterparts and three pinned later-normalized counterparts | `bc5aef8af482f4321247c17fed644ef838b58e5cdbb43d0853f9bbc9a0ca02b2` |
| `PR38-PUBLIC-HASH-REDACTION.json` | `e142bfa101f87c80b121e9c558b2a681f9ee07dd` | All 25 paths have exact archived counterparts | `2e3a54522d9c6be1d3a793e8003b14cf03ba8db9be18c7eacd23e5ee9429ae6d` |

Each inventory authenticates the complete 27-file archive, including its manifest and historical module card. For cleanup, the three later counterparts are `evidence/normalization.json`, `evidence/provider-capabilities-resume.json` and `integrity.json`. Their differences are restricted to the documented public dependency digest redaction, its explanation and recomputed inventory. The original cleanup blobs remain separately identified; they are not represented as byte-identical to the later archive.

| Descriptor | SHA-256 of descriptor file bytes | SHA-256 of inventory JSON |
| --- | --- | --- |
| `PR38-EVIDENCE-CLEANUP.json` | `f27f4cc676698d58e452c41b8bd05dd2608080b3d2ceadaf2ff792ff39d63fe5` | `c96580a4a764f37cd2d5154d89ec998dc8c4e644598bb897fc80a7d2e10f1d95` |
| `PR38-PUBLIC-HASH-REDACTION.json` | `227355913bf453a78aa6a1ccd2cdf586837f786920d0e5c5cb3dd1d32be54cba` | `4952bf98678a6e9ed4b8833874ff1c08c9287e43558561c0d732da72e3275303` |

Inventory and prestate hashes use SHA-256 of `JSON.stringify(value)`, matching `scripts/lib/historical-usdg-archive.mjs`. File hashes include the final newline. The production inventory verifier was run read-only against the exact Git objects and matched both coordinator inventories, including archive modes, blob identities, normalization semantics and absence of superseded active guidance. Descriptor shape, prestate hashes and working archive bytes were also checked without accessing a task ledger.

A later owner decision must bind the exact descriptor bytes and rationale through the supported approval mechanism. Application remains a separate coordinator action. Re-prepare before that action if canonical task state changes; a stale fingerprint is not repaired by editing the proposal. Nothing here restores the historical package as active guidance or authorizes a fee-model change, deployment, credential use, signing, broadcast or spend.
