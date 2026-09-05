# Control Authority Boundary

Owner approval artifacts use the `v4-owner-approval-v2` schema. Its canonical `subjectHashes` map binds every exact repository path the owner approved to the current SHA-256 of its bytes. The v4 CLI accepts an approval only when its schema, authority, action, phase, item, rationale, explicit token, repository path, file type, subject set, and subject hashes match the operation exactly. This is exact content binding, not a cryptographic signature or proof of who authored the approval.

Approval provenance must be enforced by the protected pull-request and merge process. Repository write access, branch protection, and approval of changes under `decisions/owner-approvals/` therefore sit outside the local CLI trust boundary. The CLI does not introduce a signing key, secret, or external approval service.

Workflow verification inside a candidate revision compares the workflow bytes with the manifest digest and the verifier's supported digest. A candidate can change all three values together, so this repository-local check does not provide external immutability.

Release requires a protected pull-request and merge process that requires the trusted gate, plus an immutable external repository rule that candidate changes cannot alter. These controls sit outside the local repository trust boundary. The repository does not claim that either release prerequisite is configured or active.
