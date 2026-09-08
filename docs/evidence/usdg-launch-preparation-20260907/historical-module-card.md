# Launch preparation

The preparation package in `release/launch-preparation-20260907/` records public metadata candidates, the frozen market parameters, semantic unsigned transaction steps and their evidence. Its interface consists of `parameters.json`, `unsigned-transactions.preview.json`, `costs.json`, `open-facts.json` and the SHA-256 `integrity.json` inventory.

A package with a missing current provider context, USDG route, source identity, deployment derivation, admission or complete funding bound cannot become signable. Historical provider bindings and local simulations retain their original scope. Caller statements never create provider admission or owner approval. All transaction calldata and unresolved target addresses remain null while their derivation inputs are missing.

Preparation progresses from source/evidence candidates to an exact documented request, then independent provider preflight/admission and a fresh wallet review. This package records only the first state. It executes no transaction. Read `README.md` for sources and `open-facts.json` for recovery paths; retain exact request bytes and idempotency identity once a future request exists. There is no launch execution command in this package.

`constructor-bindings.json` maps the compiled ABIs and immutable offsets to recorded inputs; it excludes manifest-only fields from ABI encoding. `finalization.md` describes request derivation, independent admission, wallet review and receipt-backed postconditions. The latest provider context and earlier unavailable responses are retained separately so provider availability cannot be mistaken for project admission.
