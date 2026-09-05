# Programmable V4 admission plan

## Status

Evidence is captured for the chain `4663` V4 API. The provider interface is available for capability discovery and read-only preflight, but public launch writes are not active. This document is an admission handoff, not a launch plan or authorization.

## Verified admission contract

- The active profile is `programmable.custom-launch.robinhood-mainnet.v1`, revision `1`, version `4.0.0`.
- A graph has 3 to 16 targets, exactly one token, and exactly one hook. Each target is fresh creation-bytecode input with an applicant salt and expected runtime hash.
- The configured graph factory is `0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd`; the configured stamp router is `0x34965F2A2ee9254522232C32F02056E92BE0C98a`.
- The request may bind an existing contract only as a verified external reference located in a target constructor or initializer. It does not admit an existing factory as a graph target.
- Funding supports only `none` and `wallet-transaction-value`. No request field carries a USDG transfer, payer, Permit2 allowance, or spender.
- The API pins `solc` `0.8.26+commit.8a97fa7a` and requires exact Standard JSON input bytes and source/runtime materialization evidence.
- The owner signs a separate exact wallet envelope. The service does not sign or broadcast.

The evidence index is [provider-documents.json](../../../release/phase3/admission/provider-documents.json); the complete interpretation is [findings.md](../../../release/phase3/admission/findings.md).

## FEE-01 decision

The public V4 pack contract declares a required default of 20 bps to `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`, but leaves its basis, asset, accounting, rounding, accrual, and claim mechanism null. The V4 create and preflight schemas do not expose a per-launch fee override. The agreed 10 bps destination `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c` is therefore not representable as provider configuration today.

Do not choose between a 300 bps project total and a 310 bps total by inference. The provider must first bind whether the published default is active for this graph and, if so, whether it is additive or inclusive. An exception must be expressed in a current V4 profile field or a provider-signed response bound to the candidate's `launchIntentHash`.

## Candidate package sequence

1. Keep the graph to fresh token, hook, and initializer targets unless the provider supplies an approved external-contract route.
2. Reproduce the reference compiler settings, preserve the exact Standard JSON input, and generate per-target runtime materialization evidence.
3. Select `funding.mode: "none"` and an empty-pool liquidity declaration until an ERC-20 funding envelope is documented.
4. Build a complete public package with source manifest, metadata image, profile and chain bindings, external-contract evidence, graph bundle, verification bundle, funding, liquidity model, and agent attestation.
5. Run authenticated V4 preflight only after the full candidate is frozen. Treat `supported` as structural admission only unless it contains a documented fee-exception binding.
6. If the response returns `needs_evidence`, follow its exact gates and remediations. The local architecture review remains supporting evidence and cannot substitute for a provider receipt.
7. Ask the owner to review the exact wallet envelope only after a valid provider response. The envelope must bind chain, sender, destination runtime, selector, calldata, value, expiry, and every source, graph, metadata, verification, funding, and intent commitment.

## Public activation gate

Public discovery currently reports:

- `publicAuthorization: false`
- `publicWrites: false`
- `releaseReady: false`

The listed activation blockers are `public-cli-release`, `generated-release-evidence`, `clean-room-end-to-end-proof`, and `public-indexing-canary`. The capability route's `readiness.status: "ready"` is service readiness, not public-write authorization.

## OPEN FACTs

1. A provider-defined fee exception or policy binding for the 10 bps destination.
2. A documented USDG funding path, including payer, authorization, spender, and atomicity with pool initialization and position mint.
3. A V4 rule for runtime-created child contracts and existing LiquidityLauncher or UERC20Factory use.
4. A provider-declared compiler policy for applicant hooks beyond the exact-source bundle requirement.
5. A published V4 architecture-review route or a complete preflight response that identifies its review gate.
6. A public release record that clears the four public activation blockers.

Each fact has its resolving provider URL and closest verified alternative in [findings.md](../../../release/phase3/admission/findings.md).
