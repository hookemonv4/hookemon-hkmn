# Historical USDG launch preparation

This archive preserves the historical USDG preparation from PR38. It grants no native ETH launch, deployment, signing, or broadcast authority. The native ETH release package will supersede this preparation. Candidate payloads remain historical evidence and must not be submitted as current transactions.

`historical-package/` contains exact Git blob copies of `release/launch-preparation-20260907/` from commit `e142bfa101f87c80b121e9c558b2a681f9ee07dd`. The original text, redactions, paths, provider snapshots, and internal references are unchanged. Repository-relative references still refer to their original repository context; this archive does not promise that old external links or live provider facts remain current.

`manifest.json` records each original path, Git blob, byte length, SHA-256, archive path, and comparison with cleanup commit `34fc4006e3f05a60d6a3cd9fc8383b445330aa62`. The package integrity file covers its original listed files; the outer manifest also covers files omitted from that internal list, including the integrity file itself.

The two source trees differ in three package files:

- `evidence/provider-capabilities-resume.json` applies the later public dependency digest redaction. The original value is not reproduced in this index.
- `evidence/normalization.json` documents that redaction while retaining the earlier normalization provenance.
- `integrity.json` records the resulting changed byte lengths and hashes.

All other package files match the cleanup commit exactly. This archive does not establish whole-patch equivalence, merge ancestry, task completion, or approval for a ledger rebind. The original source commits remain the provenance for any later disposition of `PR38-EVIDENCE-CLEANUP` and `PR38-PUBLIC-HASH-REDACTION`.

`historical-module-card.md` preserves the original PR38 module card byte-for-byte. It is historical evidence and is not registered in the active module index. Together with the 24 package files, this covers all 25 paths introduced by the PR38 source commit. The manifest records it separately from the unchanged package integrity list.
