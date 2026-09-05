# Phase 3 evidence record

## Pinned local evidence

The Phase 3 draft binds `HKMNToken`, `PermanentPositionCustody`, and `HookemonHook` in provider order. The launch profile is solc `0.8.26+commit.8a97fa7a`, optimizer runs `1000`, Cancun, and metadata disabled. `release/phase3/build-info/launch.json` is the single build-info record. The address manifest binds sorted source-content SHA-256 and each target's artifact, creation-bytecode, and runtime-template hashes.

Requirements revision 65 binds `1000000000000000000000000000` atomic HKMN to the canonical market with zero other allocation. The owner selected a `240000000` atomic USDG seed from a 300 USD total budget. The generated candidates consume the complete HKMN maximum for either address order, and the graph seed rejects any residual HKMN. Permanent custody holds only the initial v4 position.

The package remains `ADDRESS_DERIVATION_PENDING`. It retains exactly four readiness inputs: provider launch-intent preimage, execution-only provider API key, owner wallet funding, and builder identity. The launch-intent preimage specifically needs the provider route namespace, route nonce, topology hash, target-id hashes, and serialized graph calls. The approved X profile is persisted as `https://x.com/hookemon4`.

## Generated records

`scripts/programmable/rebuild-phase3-release.mjs` rebuilds the artifacts, source commitment, launch inputs, address manifest, graph draft, submission, deployment manifest, and Solidity release constants from the pinned compiler profile. The review target is generated after the release records and closure verification recomputes every listed digest and the submission digest.

## Robinhood genesis deployment limits

[`genesis-evidence.json`](genesis-evidence.json) pins the official [Robinhood genesis](https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-genesis.json), its SHA-256 digest, and its 2026-09-05 retrieval date. The pinned limits are a 30,000,000 block-gas limit, 98,304 runtime-code bytes, and 196,608 initcode bytes.

`node scripts/verify-deployment-manifest.mjs` derives runtime and initcode size headroom plus runtime code-deposit-gas headroom for the token, custody, and hook artifacts. The launch-profile deployment test measures each constructor under the same compiler profile. Neither check reads network state.

## Open facts

- `UNVERIFIED_LAUNCH_INTENT_PREIMAGE` remains limited to the provider route and encoded graph-call fields named above.
- `PROVIDER_API_KEY_PENDING` is an execution-only preflight input and is never stored in the repository.
- `OWNER_WALLET_FUNDING_PENDING` covers owner funding and the final wallet-side values created after preflight.
- `BUILDER_IDENTITY_PENDING` retains null builder identity fields until the owner supplies public details.
