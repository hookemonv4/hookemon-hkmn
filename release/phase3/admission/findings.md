# Programmable V4 admission findings

This is read-only admission evidence for chain `4663`. It does not authorize deployment, signing, broadcast, funding, submission, or public promotion. The fetched response index is [provider-documents.json](provider-documents.json), and every route is listed in [route-log.json](route-log.json).

## Result

The V4 API is structurally capable of a project-owned token and hook graph, but it does not currently expose a fee-policy override, an ERC-20 funding authorization, or a released public CLI. Public discovery reports `publicAuthorization: false`, `publicWrites: false`, and `releaseReady: false`. A source-only V4 client candidate is not an admission or activation path.

The authenticated probe used only `POST https://api.programmable.market/v4/chains/4663/custom-launches/preflight`. The OpenAPI calls it `Side-effect-free server-authoritative preflight` and fixes `quotaConsumed`, `nonceAllocated`, and `persisted` to `false`. The intentionally incomplete three-target draft received `400 INVALID_REQUEST`; see [preflight-probe.json](preflight-probe.json). It did not create, reserve, or certify a launch.

## Resolved FEE-01: owner-recorded 10 bps route acceptance

The discovery evidence below is a historical snapshot of the published V4 schema. It shows that
the public request did not describe a client-selected fee override. On 2026-09-05 the owner
recorded Programmable's direct acceptance of the Phase 3 route and, on 2026-09-04, acceptance of
the 10-basis-point platform share in
[programmable-acceptance.json](../../../decisions/owner-inputs/programmable-acceptance.json).
That owner-recorded acceptance resolves FEE-01 for the revision-65 implementation baseline and
removes provider acceptance as a readiness input. It does not create a provider preimage,
credentials, a signature, a broadcast authorization, or an onchain enforcement claim.

The published 20-basis-point default remains historical schema evidence. It does not supersede the
accepted 10-basis-point route, and the source limitation remains relevant only when the provider
supplies the materialized graph preimage and any exact request binding.

The provider's V4 pack contract at `https://programmable.market/schemas/custom-launch/v4/pack-config.json` declares these fields verbatim where clean-room terminology permits:

```json
{
  "required": true,
  "status": "required-default-configuration",
  "appliesTo": "new-robinhood-v4-api-custom-launches-only",
  "changesExistingLaunches": false,
  "rateBps": 20,
  "ratePpm": 2000,
  "ratePercent": "0.20%",
  "recipient": "0xD88539d3c4C460136a733A3Fd60cf6BF269079da",
  "basis": null,
  "feeCurrency": null,
  "accountingMode": null,
  "rounding": null,
  "accrual": null,
  "claimMechanism": null,
  "enforcement": "not-guaranteed-onchain",
  "canonicalOnchainEnforcementProven": false,
  "guaranteedRevenue": false,
  "feeBehaviorClaim": false,
  "universalFeeBehaviorClaim": false
}
```

The API's `CustomLaunchCreateRequestV4` has `additionalProperties: false` and no `platformFeePolicy`, fee-rate, fee-recipient, fee-basis, fee-currency, rounding, accrual, or claim-mechanism property. Its preflight response has no policy-id or exception-binding property. Policy selection is server-side with `clientSelectable: false`. The capability response separately sets `feeBehaviorClaim: false` and `universalFeeBehaviorClaim: false`.

The source-only V4 request cannot represent a client-selected fee property or establish whether the
published default is inclusive or additive. It also cannot supply basis, currency, rounding,
accrual, or claim semantics. The published default is not an onchain fee guarantee. These source
limits do not negate the owner-recorded 10-basis-point acceptance.

Submitting a new top-level 10-basis-point property would fail the published schema because
additional properties are forbidden. The accepted route instead remains bound by the owner's
recorded acceptance until the provider supplies its materialized preimage and request data. No
create or submit route was called.

Before the owner-recorded acceptance, the following evidence would have resolved the discovery
question at the schema layer:

1. A current V4 profile or pack-contract revision that adds a fee-exception field and binds its rate, recipient, accounting semantics, and policy digest to the exact request; or
2. A valid candidate preflight response carrying a provider-signed exception or policy binding for the exact `launchIntentHash`, plus an API schema that defines that field.

The current preflight schema does not define either output. A successful structural preflight alone
would not prove a schema-level exception, but provider acceptance is no longer an unresolved
readiness input for revision 65.

## Graph, factory, and child-contract rules

`GET https://api.programmable.market/v4/chains/4663/capabilities` returns `minimumTargets: 3` and `maximumTargets: 16`. The V4 OpenAPI defines a graph as `One acyclic executable graph with exactly one token and one hook.` A target is one `graphBundle.targets[]` item. Each item requires `targetId`, `applicantSalt`, `creationBytecode`, `constructorArguments`, `initializerCalldata`, both address-locator arrays, two value fields, `expectedRuntimeCodeHash`, `componentKind`, and `declaredHookPermissions`. `componentKind` is `token`, `hook`, or `other`.

That means an existing Uniswap LiquidityLauncher or UERC20Factory cannot itself occupy a graph target: graph targets require fresh creation bytecode, an applicant salt, and a post-deployment runtime hash. The request can instead bind an existing contract through `externalContracts[]`, but each reference needs its chain, address, runtime hash, source-evidence digest, role, start and audit blocks, mutability evidence, and a constructor or initializer locator. The V4 documents do not name either factory as an allowed principal or show a complete request that invokes it.

The provider's configured graph factory is `0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd`; the configured launch stamp router is `0x34965F2A2ee9254522232C32F02056E92BE0C98a`. Current provider source at `https://raw.githubusercontent.com/programmablehq/PROGRAMMABLE/cbcabd3cfc166124485c6f7e7c3951810cf60dc1/contracts/src/robinhood-custom-launch/ProgrammableLaunchStampRouterV1.sol` shows that `launchAndStampV1` checks `msg.sender == permit.launchWallet`, then calls the factory from the router. The factory source at `https://raw.githubusercontent.com/programmablehq/PROGRAMMABLE/cbcabd3cfc166124485c6f7e7c3951810cf60dc1/contracts/src/ProgrammableCreate2GraphDeployerV1.sol` requires `msg.sender == authorization.authorizedLauncher`; the router sets that launcher to its own address.

For a graph target, the source derives the effective salt from the chain id, factory address, route namespace, route nonce, target-id hash, applicant salt, and authorized launcher. The factory is the CREATE2 deployer. It deploys every target, then runs each initializer in reviewed order; a failure reverts the transaction. This is source evidence for the current reference implementation, not a substitute for a finalized runtime match.

OPEN FACT G-01: The V4 API documents neither a rule permitting nor a rule prohibiting runtime-created child contracts. It also does not document a route that calls existing LiquidityLauncher or UERC20Factory contracts for initial liquidity. Resolve with a provider-authored V4 graph rule or a complete candidate preflight that includes the exact initializer and external-contract bindings. The closest verified alternative is a target-only graph with no runtime child creation and no unbound external factory call.

## Funding and initial liquidity

The only advertised funding modes are `none` and `wallet-transaction-value`. The request's `funding` object contains only `schemaVersion`, `mode`, and `valueWei`. It has no USDG asset field, ERC-20 payer, Permit2 authorization, allowance, spender, or allowance-lifecycle field. The chain descriptor names Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3`, but that address alone proves none of those funding semantics.

The V4 liquidity model can declare `project-provided-liquidity`, `hook-owned-liquidity`, `externally-managed-position`, or `liquidity-provided-by-launch`. These are declarations, not a USDG transfer authorization. The reference router executes the graph atomically inside `launchAndStampV1`, requires the pool to be uninitialized before graph execution, and requires it to be initialized afterwards. It does not document a USDG Permit2 flow or guarantee that a PositionManager mint is an accepted initializer in the same wallet transaction.

OPEN FACT F-02: The documented API does not establish how initial USDG liquidity enters the graph, who supplies it, which contract spends it, or whether approval, transfer, pool initialization, and mint form one transaction. Resolve with a V4 funding schema that names the ERC-20 path or an exact candidate preflight whose returned wallet envelope commits those operations. The closest verified alternative is `funding.mode: "none"`, zero native value, and an uninitialized empty pool.

## Compiler and source-verification profile

The capability document pins `solc` `0.8.26+commit.8a97fa7a`. V4 requires each exact-source compilation unit to include `compilerVersion`, `standardJsonInputBase64`, and `standardJsonInputSha256`; its verification bundle binds every graph component to that compilation input, constructor arguments, materialized runtime bytes, immutable references, and runtime hash.

The current provider reference chain profile and standard JSON inputs use optimizer enabled with `runs: 1000`, `viaIR: false`, `evmVersion: "cancun"`, `metadata.appendCBOR: false`, `metadata.bytecodeHash: "none"`, and `metadata.useLiteralContent: false`. These settings are reference-source evidence. The V4 API's documented acceptance contract requires an exact Standard JSON input, but does not state that every applicant custom hook must use those particular settings. Do not silently treat the reference settings as an API promise.

OPEN FACT C-03: Whether a project hook must use the reference compiler settings is not specified in the V4 capabilities, OpenAPI, pack contract, or admission descriptor. Resolve with a V4 compiler-policy field or a valid exact-candidate preflight that accepts a full verification bundle. The closest verified alternative is to reproduce the reference settings and retain the exact Standard JSON input as evidence.

## Package, submission, and architecture review

The public pack contract requires chain and profile bindings, a public source root and paths, compilation units, 3 to 16 targets, an exact pool description, project metadata, funding, a liquidity model, and an agent attestation. The API request contains the materialized form of that package and requires a source bundle manifest, external-contract evidence, a verification bundle, metadata hash and image artifact, funding, liquidity model, launch-intent hash, and attestation.

The source package at `https://raw.githubusercontent.com/programmablehq/PROGRAMMABLE/cbcabd3cfc166124485c6f7e7c3951810cf60dc1/packages/launch/package.json` names `@programmable/launch` `4.0.0`, requires Node `>=24.14.0 <25`, and exposes `programmable-launch`. Its example documents `pack`, `validate`, `submit`, and `status`, but says the 4.0.0 source candidate is unpublished and non-installable. It never signs or broadcasts.

The provider admission descriptor says `unknownFindingDisposition: "needs-evidence"` and `noveltyIsNotARejectionReason: true`. For a custom hook, the documented route is a complete, authenticated candidate package followed by preflight. Any server finding then follows the response's `gates` and `remediations`. No provider document identifies a public human-review queue or an architecture-review endpoint. The local builder's architecture-review records are supplemental project evidence, not a provider admission receipt.

OPEN FACT P-04: There is no published V4 architecture-review submission route, reviewer identity, or required human-review artifact for a custom hook. Resolve with a provider-authored review guide or a V4 preflight response for a full candidate that names a review gate. The closest verified alternative is a local review package plus preflight evidence marked `needs_evidence` until the provider supplies a route.

## Wallet handoff, transaction count, and finality

The capability document says `separateWalletSignatureRequired: true`; API safety says the service does not produce wallet signatures or broadcast transactions. `ExactWalletTransactionV4` binds the chain, sender, destination, value, selector, calldata, transaction-preimage hash, router runtime hash, expiry, and source, graph, metadata, verification, funding, and launch-intent commitments. The API key is not a wallet.

The reference router source has one payable `launchAndStampV1` entry point and calls the graph factory within it. For a graph containing all needed initializers and no external asset approval, that source path is atomic. The V4 API does not promise that every project requires only one owner transaction. In particular, USDG approval or transfer steps are not represented by the funding contract, so their count remains unverified.

`GET https://api.programmable.market/v4/chains/4663/readiness` publishes the finality reference `robinhood-stage-finality-v1`, revision `1`, digest `sha256:537d531423d1285a3808556a57303ec68f1e6bdeea3c9aaf6320f9e5a0e47153`. The public API publishes this reference, not a standalone policy document. Current provider source at `https://raw.githubusercontent.com/programmablehq/PROGRAMMABLE/cbcabd3cfc166124485c6f7e7c3951810cf60dc1/contracts/scripts/robinhood-custom-launch-postdeploy-core.mjs` validates an exact L2 checkpoint, positive batch number, two ordered L2-provider readbacks with positive L1 confirmations, two ordered EVM-L1-provider readbacks, the rollup and sequencer-inbox identities, the L1 posting transaction, block and log index, a finalized L1 checkpoint at or after the posting block, and evidence digests. This source is useful implementation evidence, but the release state still prevents treating it as an active public policy guarantee.

OPEN FACT W-05: The provider has not published a standalone immutable document for the finality policy or a V4 guarantee for the number of owner transactions when ERC-20 funding is involved. Resolve with a policy URL whose content hashes to the published digest and an exact wallet envelope for a complete candidate. The closest verified alternative is an empty-pool graph whose router call is one atomic source path.

## Activation gate

The capability route reports API `readiness.status: "ready"`. The public discovery document reports a different axis: `status: "release-candidate"`, `activationStage: "pending-public-discovery-promotion"`, `publicAuthorization: false`, `publicWrites: false`, and `releaseReady: false`. Its exact activation blockers are:

- `public-cli-release`
- `generated-release-evidence`
- `clean-room-end-to-end-proof`
- `public-indexing-canary`

The reference promotion code ties `publicAuthorization`, `publicWrites`, and `releaseReady` to its production-authorized promotion state. API readiness therefore means the service can answer its capability/readiness interface; it does not make public launch writes available.

OPEN FACT A-06: The provider has not published a date, release artifact, or owner-visible transition criterion for these four blockers. Resolve through the public discovery document after a promoted release or a provider release record binding all four artifacts. Until then, no public submission path is available.

## Unverified boundaries

- The preflight probe was intentionally incomplete, so it is not an admission test for a real graph.
- Current provider source was fetched from the production branch. Its source hash is not a proof that the configured onchain runtimes currently match that source.
- The owner-recorded 10-basis-point acceptance is not a claim that a hook fee, the published
  20-basis-point default, or any fee path is payable, inclusive, additive, or enforceable onchain.
- No claim is made that USDG liquidity can be funded, approved, transferred, initialized, or minted through the current API.
