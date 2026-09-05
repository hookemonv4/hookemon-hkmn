# Programmable preflight evidence

`node scripts/programmable/preflight.mjs` loads the committed V4 request template and sends a body to the advertised read-only preflight route only after every required field is resolved. It writes one timestamped JSON record here for accepted responses and provider rejections. The record contains the V4 body, live capabilities, provider response, and numbered mismatches with secret-looking fields removed.

The command reads `PROGRAMMABLE_API_KEY` only from its process environment. It does not open credential files, print the credential, or store it. Evidence removes secret-looking response fields and records only that the environment key was redacted.

Every dry-run or preflight requires the public source provenance flags:

```sh
node scripts/programmable/preflight.mjs \
  --repository-url https://github.com/hookemonv4/hookemon-hkmn \
  --source-commit "$(git rev-parse HEAD)" \
  --source-tree "$(git rev-parse HEAD^{tree})" \
  --dry-run
```

The command accepts only a public HTTPS repository URL, a source commit that resolves to `HEAD`, and either the matching Git tree or the repository root. Those flags prove repository provenance but cannot derive the provider's source descriptor or source bundle manifest without the retained nested provider contract. An EVM account transaction count does not establish the required provider nonce; the command rejects it rather than padding it into the V4 field. It prints a request only when the template is fully resolved. Run `node scripts/programmable/preflight.mjs --status <requestId>` only after a provider request ID exists.

## How the V4 format was learned

The ten ordered request-response records from the advertised preflight route are retained outside the repository (the provider responses echo retired chain names that the clean-room policy forbids); the coordinator holds them as evidence. Each record redacts `Authorization`; before a request, the helper atomically reserves its ID and rate slot, enforces at least ten seconds between requests, and caps the log at sixty requests. It fails closed if another reservation lock exists, rather than reclaiming a possibly live lock. A transport failure becomes a redacted record rather than an untracked retry. The investigation stopped after ten requests when three digest-recipe differentials reached the same unresolved provider boundary. It never called a create route, signed a payload, or broadcast a transaction.

| Field | Provider result | Probes |
| --- | --- | --- |
| `nonce` | Nonzero lowercase bytes32 | `001` |
| `sourceDescriptor` | Object with `schemaVersion`, `kind`, `controllerWallet`, `sourceLineageNonce`, `sourceBundleDigest`, `bundleContentSha256`, and `publicOriginCommitment` | `002`, `004` |
| `sourceBundleManifest` | Nonempty `2.0.0` object with file entries containing `path`, `kind`, `mode`, `byteLength`, `contentSha256`, and `symlinkTarget` | `005`, `006`, `008`, `010` |

The source probe used the public repository `https://github.com/hookemonv4/hookemon-hkmn`, commit `37c0f955f76410e9c9863e77cdc33fd48ffd1306`, and tree `d3b513143bc9d0bd57acac02235c74788fdb259d`. Those facts establish the probe input provenance only. They do not establish the provider's source-bundle digest preimage.

OPEN FACT: `sourceDescriptor` and `sourceBundleManifest` still require the provider's digest binding recipe. The exact response from each of probes `008`, `009`, and `010` was `sourceBundleManifest digest does not match sourceDescriptor`. Resolve it with the provider's V4 digest preimage or a provider-generated source descriptor, then repeat a read-only probe against the same manifest. The verified alternative is to retain the accepted field shapes and explicit nulls in `create-request.json`; do not construct a launch source commitment.

OPEN FACT: probe `001` establishes only the V4 nonce's nonzero lowercase-bytes32 shape, not a derivation from an EVM account transaction count. Obtain the provider's nonce rule or a provider-generated nonce and validate it in a new read-only probe. The verified alternative is to retain a null materialized nonce and reject any padded account count. No non-error preflight response or wallet handoff was reached.

OPEN FACT: the committed Phase 3 package remains `ADDRESS_DERIVATION_PENDING`. Its request template contains reproducible bytecode and Standard JSON evidence, but lacks materialized provider deployment data, graph targets and salts, route fields, the source digest binding, runtime materialization, and launch intent. Resolve: retain the canonical capability copy, the provider source-digest preimage, and the graph preimage, then regenerate and commit the request. Verified alternative: retain the explicit-null template and the numbered probe log.
