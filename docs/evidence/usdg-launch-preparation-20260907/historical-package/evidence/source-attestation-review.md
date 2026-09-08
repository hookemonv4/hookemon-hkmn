# Source identity and caller evidence review

The hash-pinned current V2 packer validates sourceLineageNonce as a uint256 decimal string and publicOriginCommitment as a lowercase bytes32 (lines 4648–4659). It copies both caller values unchanged (5745–5746). Neither this parser nor the published guide supplies an algorithm deriving them from a Git commit or public URL. Public Git availability proves availability, not a particular undocumented commitment preimage. Keep those two fields unset until the provider documents the lineage allocation and origin commitment convention.

The caller attestation parser (4083–4114) accepts 1–64 unique check identifiers with SHA-256 evidence hashes, an identifier-shaped agentId, an actual ISO timestamp with milliseconds, and the exact final launchIntentHash. It publishes no mandatory named check list. These are caller claims, not owner approvals and not the provider's protected economic/source admission.

`preflight-attestation-evidence-candidates.json` hashes three existing evidence files and limits their claims to source provenance, image integrity and published code-size limits. It is deliberately not an agentAttestation: no final intent exists and no invented timestamp/agent identity is inserted.

The repository's `scripts/tests/phase3-bytecode-binding.test.mjs` recompiles the three targets under FOUNDRY_PROFILE=launch, without cache, then compares creation/runtime-template hashes and artifact hashes against address-manifest, graph and release-plan commitments. An actual green CI run of that test can support a bytecode-reproducibility check, provided its exact run URL/head and relevant log are retained. Source equality across a later bot-only commit does not itself prove that CI ran. No duplicate build was executed for this review.

The public V2 packer manifest construction includes compiler sources plus explicitly chosen additionalFiles. The public attestation parser does not itself require an evidence file for every check inside that bundle. The existing local release coverage contract does require attestation evidence paths; retain that project constraint unless deliberately revised. This is not an additional provider requirement. Real evidence files can be added after their claims are finalized, then bundle digests must be regenerated.

The remaining source-identity fact is precise: provider convention for sourceLineageNonce and publicOriginCommitment. Existing verified source, image and size evidence is ready to reuse; current CI output can close the bytecode evidence entry without another local compilation.
