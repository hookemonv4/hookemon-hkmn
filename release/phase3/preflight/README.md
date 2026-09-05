# Programmable preflight evidence

`node scripts/programmable/preflight.mjs` writes one timestamped JSON record here after the provider returns a valid JSON preflight response. The record binds the checked-out commit and trees, the package roots and digests, the capability profile, the provider response, and any numbered mismatches.

The command reads `PROGRAMMABLE_API_KEY` only from its process environment. It does not open credential files, print the credential, or store it. Evidence removes secret-looking response fields and records only that the environment key was redacted.

Run `node scripts/programmable/preflight.mjs --dry-run` to inspect the POST body without a network request. Run `node scripts/programmable/preflight.mjs --status <requestId>` only after a provider request ID exists.

OPEN FACT: the committed Phase 3 package remains `ADDRESS_DERIVATION_PENDING`, while the provider's documented V4 request requires materialized route, nonce, intent, verification, and graph fields. The current command sends the exact committed package binding for read-only validation and records the provider result; it cannot turn the draft into a signable request. Resolve this by committing a materialized request that satisfies the provider's published V4 request contract, then rerun preflight against that commit.
