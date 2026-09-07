# Collector production binding implementation

On 2026-09-07, the owner explicitly approved the proposed production Collector binding loader and isolated full-flow test: “Ja, diese Anbindung und den isolierten Volltest umsetzen”. The approval answered the coordination question referencing `collector-production-frontier-review.md`.

Purchase and buyback use separate policies built from independently pinned bindings and durable facts. Buyback additionally binds finalized open facts and a separately authorized sell decision. Candidate transactions cannot supply their own authority. Synthetic bindings exercise the ordinary CLI and production execution machinery only within isolated external services and cannot authorize live execution. Historical evidence-only bundles remain non-authoritative.

This decision authorizes implementation and the isolated proof. It approves no real provider addresses, live binding digest, credential access, signatures, spend, broadcast, or deployment. Requirements revision 68 records this boundary; implementation field names remain subject to review.

The source proposal is retained at `/private/tmp/hookemon-launch-coord-20260907/collector-production-frontier-review.md`, SHA-256 `c74d2e7b1fc2fde29494dccab9c0968d04d3235611d520f20a5ec1e9cbff6ac0`.
