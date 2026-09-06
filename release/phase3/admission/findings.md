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

## Resolved LIH-01: `launchIntentHash`/`agentAttestation` schema re-checked against the current live OpenAPI (2026-09-06)

H2 re-fetched `https://programmable.market/openapi/custom-launch-v4.json` directly (not from cache or memory) at `2026-09-06`, rather than relying on this file's prior (2026-09-05) snapshot alone, per the instruction that an old findings file is evidence of a prior gap, not proof no current answer exists.

Result: the live schema is unchanged in the relevant respect. `CustomLaunchCreateRequestV4.properties.launchIntentHash` is still only `{"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"}` — a format constraint, not a preimage formula. `agentAttestation`'s object shape matches exactly what `scripts/programmable/lib/package.mjs` already implements (`schemaVersion: "programmable.agent-launch-attestation.v2"`, `subjectLaunchIntentHash`, `agentId`, `checkedAt`, `checks[].{checkId,evidenceSha256}`, all `sha256:`-prefixed) — no schema drift found; the existing implementation's shape is current. The full route list (`GET capabilities`, `POST/GET custom-launches`, `GET custom-launches/{id}`, `GET finalized-custom-launches`) has no self-serve "compute intent hash" or "compute attestation" endpoint. `CustomLaunchPreflightV2`'s response does carry `requestHash` and `rawRequestSha256` (both `sha256:` pattern) — these are new facts not previously recorded here, but they describe a hash *of the submitted request*, returned *after* submission; they are not documented as the `launchIntentHash` preimage and must not be treated as one without an explicit provider statement.

New, concrete, sourced fact: `https://programmable.market/policies/custom-launch-agent-remediation-v1.json` (fetched 2026-09-06, credential-free) states explicitly, under `packConfig`:

```
"derivedValuesAreCliOwned": true,
"derivedValuesMustNotBeCopiedOrHandWritten": [
  "source descriptor", "manifest digest", "address locators", "CREATE2 addresses",
  "runtime hashes", "graph hash", "project metadata hash", "metadata-bound graph hash",
  "launch profile hash", "launch intent hash", "funding intent hash", "funding nonce",
  "verification bundle hash", "request bytes"
]
```

This is a direct, current, provider-published statement that `launchIntentHash` (and the request-bytes/graph/verification-bundle hashes around it) is a value the provider's own CLI computes, and that hand-deriving or copying it is against the provider's own policy — it is not merely undocumented, it is explicitly declared not-ours-to-derive. This is consistent with, and gives concrete cause for, the four open public-discovery activation blockers already recorded above in this file, one of which is literally `public-cli-release`: the CLI that owns this derivation is not yet publicly released. `agentAttestation.subjectLaunchIntentHash` is bound to that same CLI-owned value, so it inherits the same block.

**Updated resolution step (replaces the prior open-ended "obtain the preimage" framing):** this is not a research gap this task can close by reading more docs or reverse-engineering a hash function — it is blocked on the provider publicly releasing its own CLI (tracked as blocker `public-cli-release` in the public discovery document). No signature, hash, or attestation may be invented in its place. Re-check `activationStage`/`public-cli-release` on `https://programmable.market/.well-known/programmable.json` before the next funded attempt.

## Unverified boundaries

- The preflight probe was intentionally incomplete, so it is not an admission test for a real graph.
- Current provider source was fetched from the production branch. Its source hash is not a proof that the configured onchain runtimes currently match that source.
- The owner-recorded 10-basis-point acceptance is not a claim that a hook fee, the published
  20-basis-point default, or any fee path is payable, inclusive, additive, or enforceable onchain.
- No claim is made that USDG liquidity can be funded, approved, transferred, initialized, or minted through the current API.

## LIH-01 follow-up: v4.1 CLI verified released; native-fee-kernel/funding-plan architecture conflict identified (2026-09-06, H2)

Continuing LIH-01 per explicit coordinator direction that full v4.1 compatibility investigation is
in scope. All facts below are fresh reads (`curl`, `python3`/`node` JSON parsing, `tar -tzf`/`-xzOf`
listing — no execution of downloaded code) taken 2026-09-06, cross-checked against at least two
independent provider sources each.

### CLI release: verified, not blocked

`https://programmable.market/.well-known/programmable.json` → `customLaunchApi.versions.v4` now
reports `activationBlockers: []` (previously named `public-cli-release` among others — see the
"Activation gate" section above). `cli.release` names GitHub release `programmable-launch-v4.1.0`
in `programmablehq/PROGRAMMABLE`, tarball `programmable-launch-4.1.0.tgz`,
sha256 `9d7d26a74b0b4aaa3b3d8acddc80f821cbd79511ee1ada6acc7b935aeb21cac5`. Downloaded that exact
tarball and its published `.sha256` file directly from GitHub Releases: both the file's own hash
and the separately-published checksum file match the discovery document's inline digest exactly
(three independent sources agreeing). This is genuine evidence the CLI is released and installable,
not merely a marketing claim; the `public-cli-release` blocker is stale and should be dropped from
any future reference to it. No package was installed or executed — only listed (`tar -tzf`) and
individual JSON/Solidity files were read (`tar -xzOf`).

### Profile digests updated from 4.0.0 to 4.1.0

Live `GET https://api.programmable.market/v4/chains/4663/capabilities` and the fetched
`https://programmable.market/openapi/custom-launch-v4.1.json` (`CustomLaunchPreflightV2.properties.profile`)
report identical, current values: `profileRevision: 2`, `profileVersion: "4.1.0"`, and four new
`admission*Digest` consts plus a new `profileDigest`. `release/phase3/admission/provider-documents.json`
(`capabilities.profile`, `capabilities.funding.modes`) and the regenerated
`release/phase3/package/create-request.json`/`package-manifest.json` now carry these values.
`capabilities.funding.modes` on the live endpoint is now `["wallet-transaction-value"]` only —
`"none"` is no longer advertised as a supported funding mode for new launches, though it remains a
syntactically valid schema enum value (`CustomLaunchCreateRequestV4.properties.funding.properties.mode.enum`
still lists both). This distinction — schema-valid vs. currently-advertised-supported — is recorded
precisely rather than collapsed into one claim.

### `fundingPlan`: new required field, schema captured, template left null

`CustomLaunchCreateRequestV4` in the v4.1 OpenAPI adds a required `fundingPlan` object
(`programmable.robinhood-funding-plan.v1`, fetched from
`https://programmable.market/schemas/custom-launch/v4.1/funding-plan.json`): `capitalSource` enum
(`buyer-funded`/`creator-funded`/`hybrid`/`custom`), `pricingModel` enum
(`concentrated-liquidity`/`custom-curve`/`auction`/`custom`), `nativeAllocations` (four wei-string
fields), `maxLaunchValueWei`, `maxGasCostWei`, and `launchMode`
(`fund-and-launch`/`build-only`). The schema's own `description` states: "Build-only permits local
pack/preflight only; fresh create must reject before persistence or signing," and a conditional
(`allOf`/`if`/`then`) requires `nativeAllocations.initialBuyWei` to be nonzero when
`launchMode: "fund-and-launch"`. `scripts/programmable/lib/create-request-materializer.mjs` now
validates this exact shape (schema version, enum membership against `provider-documents.json`,
the nonzero-initial-buy conditional) and `provider-documents.json`'s `v4RequestContract` records
the same enums as a new `fundingPlan` descriptor, mirroring the existing `funding`/`liquidityModel`
pattern. The materialized Phase 3 template itself sets `fundingPlan: null` — like `nonce` or
`sourceDescriptor`, this is a genuinely unresolved fact, not an oversight: which `launchMode`
applies is exactly the open decision below.

### Genuinely unresolved decision: native-ETH platform fee kernel vs. our USDG-quoted pool

The discovery document's `platformFeePolicy` (`required: true`,
`status: "required-exact-native-fee-kernel"`, `appliesTo: "new-robinhood-v4.1-api-custom-launches-only"`)
is not marketing text — it is backed by a concrete reference contract shipped inside the verified
CLI tarball itself: `package/examples/robinhood-v4-native20/project/src/robinhood-fee-v1/RobinhoodNativeFeeHookV1.sol`.
Reading that source directly: its `_requirePool` check requires
`Currency.unwrap(key.currency0) == address(0)` (Solidity's native-ETH sentinel) — i.e. the pool this
reference kernel enforces **must** have native ETH as currency0. The same example's `README.md`
states plainly: "This example builds a real ETH/token Uniswap v4 market... zero ETH supplied as
starting liquidity... The launch wallet funds the first real ETH buy in the same atomic launch
transaction." The mandatory `initialBuy` object in the discovery document
(`minimumUsd: "1"`, `execution: "atomic-full-native-input-and-minimum-token-output"`,
`assessmentBase: "gross-native-initial-buy-at-admission"`) matches this exactly.

Our current, owner-accepted design is a **USDG/HKMN pool** (`packages/contracts/src/market/CanonicalMarket.sol`,
`FeeAccounting.sol`'s 300 bps split — 10 bps Programmable, 40 bps treasury, 250 bps process — all
USDG-denominated) with `funding.mode: "none"` and no atomic native-ETH initial buy. No currency in
our pool is native ETH. I found no written provider statement that a non-ETH-quoted pool can satisfy
the "exact native fee kernel" requirement via an alternative mechanism (e.g. a wrapped/bridged
equivalent, or an `externalContracts[]`-bound adapter); the only concrete reference implementation
shipped is ETH-quoted. I did **not** conclude the two are definitely incompatible — I could not find
that written anywhere either — but I also did not find a supported path to reconcile them, and I am
not inventing one.

**This is the exact genuinely unresolved financial/architecture decision requiring an owner/coordinator
call, not a scoped code fix:**

1. Adopt the provider's native-ETH-quoted pool + `RobinhoodNativeFeeHookV1`-style kernel pattern for
   a real (`fund-and-launch`) v4.1 launch — this would mean redesigning `CanonicalMarket.sol`/
   `FeeAccounting.sol`'s USDG-denominated economics to an ETH-quoted pool, a materially different
   contract change outside H's authority to make unilaterally (no reproduced defect, this is a new
   design); or
2. Confirm directly with the provider (support channel, not inferred from schema) whether a
   USDG-quoted pool can satisfy `platformFeePolicy`/`fundingPlan` through some other accepted
   mechanism this task did not find documented; or
3. Use `fundingMode: "build-only"` indefinitely for local pack/preflight validation only, and
   accept that a real (`fund-and-launch`) v4.1 Robinhood self-serve launch is not currently reachable
   with the existing USDG-quoted architecture.

No signature, hash, approval, or economic redesign was fabricated to resolve this. HKMN's existing
300 bps USDG-denominated economics are preserved unchanged in source; only the request template's
new required field is populated with schema-valid, zero-value, `build-only`-shaped test fixtures
(in `scripts/tests/programmable-package.test.mjs`), never asserted as the real launch's committed
choice.

## LIH-01 resolved: exact `launchIntentHash` preimage formula, read from the verified CLI source (2026-09-06, H4)

Continuing LIH-01 with a genuine offline CLI invocation, per explicit coordinator authorization to
install pinned dependencies and run build-only/local commands in an isolated workspace. No network
write, sign, submit, or status/admission call was made; the only network activity was the same
credential-free `GET` of the CLI tarball already verified in the prior LIH-01 entries, plus
`npm ci --ignore-scripts --no-audit --no-fund` against the tarball's own committed
`npm-shrinkwrap.json` (its single runtime dependency is `viem@2.55.5`) in a `/tmp` workspace outside
this repository. Nothing was installed or run inside this repository or against the provider API.

**The CLI's `pack` command is fully offline.** `src/cli.mjs`'s `pack` branch calls `packLaunch` from
`src/pack.mjs`, which imports only local modules (`build.mjs`, `canonical-json.mjs`, `graph.mjs`,
`io.mjs`, `source-bundle.mjs`, `project-metadata.mjs`, `verification.mjs`, `pack-v4.mjs`) — no
`api-client.mjs` import. Only `validate --remote`, `submit`, and `status` touch the network.

**The exact preimage, read verbatim from `src/v4-contract.mjs`:**

```js
export function buildV4LaunchIntentHash(value) {
  return sha256Digest(Buffer.concat([
    Buffer.from(V4_LAUNCH_INTENT_HASH_DOMAIN, "utf8"),   // "programmable.custom-launch-intent.v4"
    Buffer.from([0]),
    Buffer.from(canonicalizeJson(value), "utf8"),
  ]));
}
```

Called (in `src/pack-v4.mjs`) with exactly this field set, in this order:
`schemaVersion, chainId, caip2, chainDeploymentId, chainDeploymentDescriptorDigest, profile,
launchWallet, nonce, permitWindow, sourceDescriptor, sourceBundleManifest, externalContracts,
graphBundleHash` (a hash, not the full graph bundle), `projectMetadataHash,
projectMetadataImageArtifact`, optionally `behaviorScenarioInputsHash`, `verificationBundleHash`
(a hash, not the full bundle), `funding`, optionally `fundingPlan`, `liquidityModel`.
`agentAttestation.subjectLaunchIntentHash` is then set to exactly this value — confirming the field
relationship our own `validateRecordedV4RequestTemplate` already enforces
(`request.agentAttestation.subjectLaunchIntentHash === request.launchIntentHash`, in
`scripts/programmable/lib/package.mjs`) is correct and matches the real implementation, not a
guess.

**This is genuine, sourced, computable-without-signature evidence — read from the provider's own
released and checksum-verified tool, not reverse-engineered or invented.** It resolves the
"CLI-owned, must-not-be-hand-written" tension recorded earlier: the formula itself is public (it
ships in an MIT-licensed, publicly released package); what remains CLI-owned is the *canonical
input values* (`chainDeploymentId`, `chainDeploymentDescriptorDigest`, `graphBundleHash`,
`verificationBundleHash`, and others), most of which are still null in our committed template
because their prerequisite facts (graph target addresses, resolved chain deployment) are
themselves unresolved.

Invoked `buildV4LaunchIntentHash` directly (the CLI's real exported function, not a
reimplementation) against our own `materializePhaseThreeCreateRequest({ root: '.' })` output,
substituting `null` for `graphBundleHash`/`verificationBundleHash` (not yet computed anywhere in
our pipeline) to match the function's expected shape. It ran without error and produced a hash. This
demonstrates only that **the mechanism is invokable against our request shape**; the resulting
digest is a preview over an object containing 11 of 19 null fields
(`chainDeploymentId, chainDeploymentDescriptorDigest, nonce, sourceDescriptor, sourceBundleManifest,
externalContracts, graphBundleHash, projectMetadataHash, projectMetadataImageArtifact,
verificationBundleHash, fundingPlan`) and is **not** recorded as a candidate `launchIntentHash` —
doing so would misrepresent a hash-of-mostly-nulls as meaningful evidence. No hash was hand-written
into any committed file; `launchIntentHash`/`agentAttestation` remain `null` in the actual template,
exactly as before this investigation.

## LIH-01: independent verification sharpens the conclusion to definitive incompatibility (2026-09-06)

Independent review (`H-provider-sol-decision.md`, not duplicated in full here) went one step
further than the H investigation above: it hashed the actual admission-descriptor and
business-policy documents bound by the live capabilities digests
(`raw.githubusercontent.com/programmablehq/Launch-Policy/main/policy/custom-launch-admission-v4.1.json`
and `.../policy/robinhood-custom-launch-economics-v1.json`) and confirmed both hash to the exact
`admissionDescriptorDigest`/`admissionPolicyDigest` values recorded above — i.e. these are not just
"an example," they are the server-bound policy text itself. That policy states
`conformance.requiredForEveryFreshLaunch: true`, `platformFee.waiverAllowed: false`, and
`firstBuy.requiredForEveryFreshLaunch: true`. It also found the released CLI enforces this
unconditionally in code — `pack-v4.mjs` calls `assertRobinhoodNativeFeeKernelBuildV1` regardless of
`fundingPlan.launchMode`, so `build-only` does not bypass the kernel check; the official packer
rejects `HookemonHook`/our USDG PoolKey before it can emit even a local, unsigned `launch.json`.

This corrects and replaces the H investigation's earlier, more tentative framing ("I did not
conclude the two are definitely incompatible... I also did not find it explicitly ruled out"): the
current route is **definitively incompatible at local pack time**, not merely undocumented. Only
whether Programmable will publish a different, compatible future profile remains open. The three
options recorded above stand unchanged; option 3 (direct provider clarification) now has an exact
drafted question, recorded in `H-provider-sol-decision.md`, ready for an authorized support
channel. No code, contract, or economics changed as a result — this is a sharpened diagnosis, not a
new decision.
