Task 1 completed with a fixture-only correction in `scripts/tests/final-review.test.mjs`. The two active T1 fixtures now bind `REQ-proof-1` and `REQ-token-core-1`, respectively.

The focused final-review suite passes (24/24), and the full suite passes (259/259). Tests were run with `OPENSSL_CONF=/dev/null` because the managed environment cannot read the system OpenSSL configuration path.

Committed as `test(tasks): bind final review task fixtures`.

Follow-up validation gaps were closed in `scripts/lib/ledger.mjs`, `scripts/lib/reqs.mjs`, and `scripts/check-delivery-boundary.mjs`, with regression coverage in the corresponding ledger, requirements, and delivery-boundary tests. Deferral is now restricted to P1-011, deferred rows still validate known requirement IDs and owner authority, and delivery-boundary exclusion is fail-closed.

Focused suites pass (65/65); the full suite passes (262/262). Follow-up commit: `fix(tasks): close deferred validation gaps`.

Added shared projected-task deferral validation in `scripts/lib/gates.mjs` and routed both trace and delivery-boundary checks through it. Regression fixtures now cover projected metadata tampering and valid-looking non-P1-011 authority.

Focused suites pass (66/66); the full suite passes (263/263). Follow-up commit: `fix(tasks): bind deferred projections to approval`.
