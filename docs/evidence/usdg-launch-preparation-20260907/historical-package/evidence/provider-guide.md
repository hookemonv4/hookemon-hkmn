# MultiRole Custom Launch API v2

The additive MultiRole API prepares an exact controller-wallet transaction for a graph whose physical contracts can carry multiple roles. It uses chain `4663`, CAIP-2 `eip155:4663`, route ID `custom-launch:create:multi-role-v2`, and Router protocol `programmable.multi-role-launch-stamp-router.v2`. A combined token/hook is one physical component with role mask `3`.

Discover the current deployment before constructing a request. `GET /v4/chains/4663/multi-role-custom-launches/capabilities` is public. An unregistered deployment returns HTTP 200 with `context: null`, `readiness.status: "unavailable"`, and reason codes. A reachable capabilities route does not establish that launches are enabled. A ready context identifies the independently configured release; each request still requires its own source, economic, custody, simulation and finality checks.

This guide describes the implemented MultiRole transport and offline request packer. It does not change the existing V4 routes, frozen public CLI 4.1, or Builder Skill. The transport example sends prepared request bytes; the separately downloadable packer constructs those bytes from complete explicit project inputs.

## Public downloads

Read the [MultiRole guide](https://programmable-custom-launch-api.fly.dev/v4/chains/4663/multi-role-custom-launches/guide.md), download the [Node 24 transport example](https://programmable-custom-launch-api.fly.dev/v4/chains/4663/multi-role-custom-launches/client.mjs), and obtain the packer/reference/build files listed below from the same verified API origin as capabilities. These routes are public and remain available while launch admission is disabled. They accept exact `GET` requests without query parameters and return the original Markdown, JavaScript or JSON file directly. A successful download does not enable launch admission.

The capabilities `documentation` descriptor publishes the original five files' `path`, `mediaType` and `contentSha256`. The strong `ETag` is the quoted `sha256:...` digest of those exact response bytes; save and check it before using a downloaded client. These files are pinned to the reviewed API source and included in its immutable runtime image. Keep the guide, client and capabilities from the same deployment revision.

`documentation.requestPackaging.status: "published"` identifies the downloadable, versioned offline packer described in this guide. It builds request/source/image/intent commitments from explicit compiler and graph declarations. It has no production authority, and its availability does not change launch `readiness`. The reference includes both complete config examples and their exact source inventory; a new project must supply its own consistent graph, compiler, context and funding inputs.

## Discover the exact context

Use the complete capabilities `context` unchanged. It contains `chainId`, `caip2`, `chainDeploymentId`, the full `profile`, `chainDeployment` and `providerProfile` documents, and `chainBindings`. Request `contextCommitments` bind those complete documents. The backend compares them with its independently configured context; the request cannot select a new Router, provider, signer or deployment authority.

Production contexts include `profile.runtimeRelease` with `schemaVersion: "programmable.multi-role-runtime-release-instance.v2"`, `sourceCommit` and `sourceTree` identifying that backend release. Changed backend source receives a new `contextHash`. For a deliberate new request, fetch the latest complete capabilities context; never synthesize or manually edit this release instance. For historical status and replay, preserve the original request bytes, context and idempotency key exactly, including an older context without this field. A backend update does not rewrite existing release records or prepared requests. The downloadable local references remain inert examples with `productionAuthority: false`.

If context is absent or readiness is unavailable, inspect its reason codes and wait for the published release. Do not substitute historical V1, nested Router V2 or another V4 profile. For an existing request, retain its original context and use historical status/replay recovery.

## Routes and credentials

The base path is `/v4/chains/4663/multi-role-custom-launches`. Protected routes use `Authorization: Bearer <API key>`. Grant the key the required scope for chain `4663` and bind it to the request's `launchWallet`. The example supports wallet API keys from `PROGRAMMABLE_API_KEY`; existing server-side partner credential support is a separate credential-management contract.

| Method and path | Scope | Result |
| --- | --- | --- |
| `GET /capabilities` | Public | Context, route discovery and current readiness. |
| `GET /guide.md` | Public | This guide as exact UTF-8 Markdown, with its SHA-256 ETag. |
| `GET /client.mjs` | Public | The Node 24 transport example as exact UTF-8 JavaScript, with its SHA-256 ETag. |
| `GET /request-packer.mjs` | Public | Self-contained Node 24 request packer, with its SHA-256 ETag. |
| `GET /request-packer-reference.json` | Public | Inert zero-value and atomic-buy reference inputs with the exact 40-source MIT closure and notices. |
| `GET /request-packer-build.json` | Public | Packer/reference hashes, input digests and build/dependency provenance. |
| `POST /preflight` | `custom-launch:create` | Synchronous parsing, image admission and exact source evaluation; no reservation or permit signature. |
| `POST /` | `custom-launch:create`; wallet handoff also requires `custom-launch:read` | Creates or recovers the exact durable request. HTTP 202 for a new reservation, HTTP 200 for an exact replay; `Location` points to its status route. |
| `GET /` | `custom-launch:read` | Owner-scoped list. `limit` is 1–25, default 10; reuse the opaque `nextCursor`. |
| `GET /{launchId}` | `custom-launch:read` | Original resource, stored source assessment and separate finality state. |
| `POST /{launchId}/transaction-hints` | `custom-launch:create` and `custom-launch:read` | Registers a non-authoritative transaction hash; HTTP 202 does not assert inclusion or finality. |
| `GET /{launchId}/finality` | `custom-launch:read` | Protected finality projection, or 404 when no accessible record exists. |

Use the lowercase launch UUID returned by create or list. Routes other than list reject query parameters. The transaction-hint body is limited to 1 KiB and uses this exact schema:

```json
{"schemaVersion":"programmable.multi-role-transaction-hint.v2","transactionHash":"0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
```

Normal authorized key rotation preserves access only through the original controller, credential lineage and granted scopes. It does not expand authority or replace request identity. A valid replacement key can recover an existing authorized request; a revoked key cannot. Issuance/rotation plaintext is delivered through the established one-time key-management flow. Replays of that operation do not reveal the secret again. The example does not issue or rotate keys; update its environment and start a new invocation after rotation.

## Preserve request bytes and idempotency

Create and preflight consume the canonical JSON body with schema `programmable.multi-role-custom-launch-create-request.v2`. The request includes the exact context and commitments, controller, nonce and permit window, source descriptor/manifest, external contracts, graph bundle, project metadata and image bytes, exact compiler verification bundle, funding/liquidity plan, launch-intent hash and agent attestation. Optional behavioral inputs and their hash must appear together.

Build that complete request with the public offline packer described below and save its canonical UTF-8 bytes once. The transport example validates canonical serialization and sends the original file bytes without reformatting. Whitespace, a trailing newline, duplicate keys, reordered object keys, or changed values can invalidate canonical bytes or change identity. The request limit is 16 MiB.

The public packaging status identifies the released producer and its config schema. Callers that already have a complete compatible request can use the transport operations directly.

`POST` create requires `Idempotency-Key`: 16–128 ASCII letters, digits, `.`, `_`, `:` or `-`. An exact retry uses the same bytes and key. Different bytes under the same key return `IDEMPOTENCY_CONFLICT`. Preflight does not need an idempotency key and does not reserve a launch.

The example's default key is `mr-v2-` plus SHA-256 of the original request bytes. It is deterministic across process restarts and credential rotation; it does not contain the credential. You can supply a stable explicit key for create. A deliberate new request requires new request commitments and a new key. A timeout or unavailable authority is a reason to recover the original request, not to regenerate its nonce, window or signature.

The original permit window is bounded to a maximum lifetime of 3,600 seconds. At reservation, `validAfter` must be no earlier than 3,600 seconds before creation and no later than 60 seconds after creation; `deadline` must be at least 60 seconds after creation. Handoff must remain within the original window. Expired permits do not become usable through a replay. Historical reads and finality verification retain the original identity and evaluate inclusion against the original window, including its endpoints.

When protected historical recovery is configured, owner-scoped reads, lists, transaction hints and exact completed create replays remain available independently of the current admission, provider or custody context. They preserve the original request and wallet bytes. New creates and preflight still require current launch readiness. An incomplete exact create replay can return HTTP 503 with its original `statusUrl`; follow that URL and retain the unchanged request rather than creating another signature.

## Preflight, admission and actionable findings

A successful preflight returns `programmable.multi-role-custom-launch-preflight.v2` with `source.disposition`, `source.findingCodes`, a source receipt and a remediation message. `readiness` remains `independent-admission-required`; `permitSigned`, `walletTransactionProduced` and `transactionBroadcast` are false. `source_supported` is a source-recognition result, not production admission.

Create reserves a durable request and binds the original source evaluation. Protected source/economic admission may arrive asynchronously. `MULTI_ROLE_ADMISSION_PENDING` means the caller should respect `Retry-After`, inspect status, and, when appropriate, repeat create with exactly the same bytes and key to resume that original operation. The service uses a durable custody fence; the client must not loop over new permits or replacement signatures.

When status is `action_required`, inspect the stored `sourceAssessment` on create/replay/get/list:

```text
schemaVersion: programmable.multi-role-source-assessment.v2
disposition: evidence_required
findingCodes: bounded source finding codes
receiptHash: digest of the original source-evaluation receipt
remediation: required evidence or correction
productionAuthority: false
```

`sourceAssessment` is null before a source decision exists. It is derived from the original durable receipt and remains available for historical reads. Use its concrete finding codes and remediation to correct the evidence, then submit a deliberate new request. The original receipt and status remain available; retrying unchanged rejected evidence does not make it acceptable. Preflight also exposes the detailed source result for a request whose context is currently available.

The source recognizer covers the combined Native20 recipe and the inventory-funded V3 model described below. Both require independent compilation and exact source, constructor, runtime, role and funding bindings. Their source-derived fee-vault child must also be observed after deployment. Unknown economic or behavioral mechanisms return `evidence_required`; this is a platform coverage boundary, not a verdict that the project is unsafe. A valid graph alone does not establish support for arbitrary token or hook logic.

## Runtime instruction policy

When the published MultiRole path is ready, the API checks the complete materialized runtime of every physical graph target before permit custody, including combined token/hook contracts and auxiliary targets. The supported Router policy applies the same instruction scan to deployed graph outputs. `SELFDESTRUCT` (`0xff`), `CALLCODE` (`0xf2`) and `DELEGATECALL` (`0xf4`) fail this policy. Bytes consumed as `PUSH1`–`PUSH32` immediate data are skipped; those data bytes alone do not cause rejection. The scan continues through the complete runtime without removing Solidity CBOR metadata or excluding bytes based on reachability. Capabilities publish this requirement as `runtimeInstructionPolicy`; its presence does not enable launch admission.

If appended compiler metadata triggers this conservative scan, rebuild reproducibly with `settings.metadata.appendCBOR: false` and `settings.metadata.bytecodeHash: "none"` in the Solidity Standard JSON input. Regenerate the matching creation bytecode, materialized runtimes, graph and request commitments, then submit a new request with a new idempotency key. Do not remove bytes from compiler output after compilation. The published Native20 reference already uses these compiler settings.

Passing this check does not establish post-transaction liveness or support for an arbitrary architecture. Exact source and constructor authority, the current admission recipe, economic evidence and required child-runtime observations remain mandatory. A forbidden runtime instruction returns `MULTI_ROLE_RUNTIME_OPCODE_FORBIDDEN` before permit custody; additional review evidence cannot override this Router requirement.

## Wallet handoff and finality

The resource returns `wallet` only after protected admission, scoped permit custody, exact durable persistence and provider simulation. The wrapper binds the original request/context/artifact hashes and the exact `wallet.walletTransaction` core. Preserve its `from`, `to`, chain, value and calldata. The permit-authority signature inside calldata does not sign the controller's EVM transaction.

The launch controller must review and sign that transaction using its own wallet. Neither an API key nor the example signs or broadcasts it. Before owner signing, review the exact chain, target, value, decoded effects and original expiry. After the controller submits it, register the resulting hash as a transaction hint.

The separate `finality` projection has schema `programmable.multi-role-finality-status.v2` and states:

| State | Meaning |
| --- | --- |
| `pending` | A hash may be registered; no accepted canonical inclusion is asserted. |
| `included` | The protected observer has a bound L2 inclusion. It is not [redacted-label] finality. |
| `[redacted-label]_finalized` | The observer accepted the exact signed transaction, V2 Router events/getters/runtime, required child runtime, independent provider agreement, canonical L1 posting and [redacted-label] finalized checkpoint. |

Only protected `[redacted-label]_finalized` projects the resource's `status` to `finalized`. The original resource/wallet timestamps remain intact; finality's own `finalizedAt` records that later event. A receipt, transaction hash, L2 confirmation count, successful simulation or one provider response cannot replace this proof. Missing records, provider disagreement, timeouts and reorgs require recovery; they are not evidence that a launch is absent or finalized.

## Public finalized metadata

The separately composed public reader exposes `GET /v4/chains/4663/multi-role-custom-launches/finalized`, `GET /finalized/{onchainLaunchId}` under the same base, and `GET /finalized/{onchainLaunchId}/image/{sha256hex}`. These reads are unauthenticated. The list accepts an integer `limit` from 1–25, default 25, and an opaque cursor.

Metadata uses `programmable.multi-role-finalized-metadata.v2`; the list uses `programmable.multi-role-finalized-metadata-list.v2`. Keep `apiLaunchId` (the API UUID) distinct from `onchainLaunchId` (the lowercase 32-byte Router launch ID). Only protected finality plus matching original source/image/request/artifact/window records can supply this projection. Historical finalized records retain their original context and remain readable after release expiry, disabling or a version change.

The projection includes project metadata, the admitted image reference, market/components, provenance hashes and the [redacted-label] posting/finalized summary. It does not expose signatures, submitted source or provider observation payloads. Sourcify and Blockscout publication statuses remain `not_verified`, and indexer publication remains `not_claimed`. This reader does not activate an unavailable deployment. The transport example covers authenticated lifecycle reads; these public metadata reads are a separate consumer contract.

## Pack a canonical request

Download the [offline request packer](https://programmable-custom-launch-api.fly.dev/v4/chains/4663/multi-role-custom-launches/request-packer.mjs), [reference inputs](https://programmable-custom-launch-api.fly.dev/v4/chains/4663/multi-role-custom-launches/request-packer-reference.json) and [build manifest](https://programmable-custom-launch-api.fly.dev/v4/chains/4663/multi-role-custom-launches/request-packer-build.json). Save them as `multi-role-request-packer-v2.mjs`, `multi-role-request-packer-reference-v2.json` and `multi-role-request-packer-v2.build.json`. Verify each SHA-256 against the corresponding `documentation.packer`, `documentation.reference` or `documentation.buildManifest` entry. The build manifest also records the packer and reference digests. The packer requires only Node 24; the build manifest is informational and is not loaded by the executable.

Run these commands to reproduce an inert local reference:

```sh
node multi-role-request-packer-v2.mjs --help
node multi-role-request-packer-v2.mjs reference --input multi-role-request-packer-reference-v2.json --case zero --out config.zero.json
node multi-role-request-packer-v2.mjs pack --config config.zero.json --out request.zero.canonical.json
node multi-role-request-packer-v2.mjs reference --input multi-role-request-packer-reference-v2.json --case buy --out config.buy.json
node multi-role-request-packer-v2.mjs pack --config config.buy.json --out request.buy.canonical.json
```

The two cases retain their original local-fixture context, controller, nonce, permit window, graph and constructor/runtime bindings. `zero` has transaction value `0`; `buy` declares `10000000000000000` wei for its local atomic-buy case. Neither case grants production authority or asserts that those addresses or windows can be used for a live launch. They demonstrate the complete input shape and reproducible packing. Preserve the included MIT source notices when redistributing these reference files.

For a new launch, construct `config.json` for your own project using the complete currently ready capabilities context, your authorized controller, an explicitly chosen nonce and permit window, and your funded launch plan. A changed context, source, constructor, salt or immutable value can require a different graph and bytecode binding. The packer checks the declared graph; it does not compile contracts, mine deployment salts or choose missing constructor/immutable bindings.

The config schema is `programmable.multi-role-request-pack-config.v2`. It is closed: unknown or missing fields fail. Config JSON may be formatted; duplicate properties, invalid UTF-8, excessive depth, inconsistent declarations and inputs over 16 MiB fail. The downloadable reference contains complete examples of every required nested structure.

| Config field | Required value |
| --- | --- |
| `schemaVersion` | `programmable.multi-role-request-pack-config.v2`. |
| `context` | The complete published capabilities context for a new launch; preserve the reference context only for local reproduction. |
| `launchWallet`, `nonce`, `permitWindow` | The authorized controller, canonical nonce, and explicit original `validAfter`/`deadline` values. |
| `source` | Exactly `sourceLineageNonce`, `publicOriginCommitment`, `imagePath`, and `additionalFiles`. Each additional file is `{path, base64}`. |
| `compiler` | Exactly `compilationUnits` and `components`. Each unit is `{compilationUnitId, compilerVersion, standardJsonInputBase64}`; components carry exact V2 target, constructor and runtime-materialization declarations. |
| `externalContracts`, `graphBundle` | All external dependency bindings and the complete canonical graph, including salts, role assignments, creation bytecode and expected runtimes. |
| `projectMetadata` | Project metadata and its declared PNG/GIF image properties; `source.imagePath` selects the actual image bytes. |
| `funding`, `fundingPlan`, `liquidityModel` | The explicit transaction value, spending/gas/liquidity allocations and liquidity model, consistent with the graph. |
| `attestation` | Exactly `agentId`, `checkedAt`, and `checks`; each check is `{checkId, evidenceSha256}`. This remains your caller attestation. |
| `behaviorScenarioInputs` | Optional behavioral inputs; the packer derives their paired hash when present. |

All Standard JSON source contents plus explicit additional files form one deterministic source bundle. Paths are sorted by UTF-8 bytes and entries are regular files with mode `100644`. Compiler input bytes are preserved and their hashes are derived. The graph's source hash must match this bundle. Image bytes, metadata, source descriptor/manifest, context commitments, verification bundle, intent hash and attestation subject are checked or derived from the same input.

Pack your complete input once:

```sh
node multi-role-request-packer-v2.mjs pack --config config.json --out request.canonical.json
```

The output is canonical request JSON without a trailing newline. Output files must be new and are created with mode `0600`. Standard output contains `programmable.multi-role-request-pack-report.v2` with request/source/context/artifact hashes, byte length and the stable `mr-v2-...` idempotency key. The report explicitly has `productionAuthority: false`, `walletSigning: false` and `compilerExecution: "required-on-server"`. No network request, credential access, wallet signature or broadcast occurs. The API independently compiles source, checks economic evidence, enforces release readiness and authorizes custody.

Use the resulting file with the transport example's preflight and create commands below. Preserve that exact file and idempotency key for retries. `MULTI_ROLE_PACK_CONFIG_INVALID` means the explicit inputs are incomplete or inconsistent; fix the reported input groups before submitting. `MULTI_ROLE_PACK_IO_ERROR` means the input could not be read as a bounded regular file or the new output could not be created. CLI argument/reference errors use `MULTI_ROLE_PACK_ARGUMENTS_INVALID` or `MULTI_ROLE_PACK_REFERENCE_INVALID`. Errors use `programmable.multi-role-request-pack-error.v2` and never echo source content, credentials or private filesystem paths.

## Build an inventory-funded project

The inventory V3 model deploys three physical contracts: a fixed-supply OpenZeppelin ERC-20 token, a separate hook, and a one-shot liquidity initializer. Projects choose their own supply, aligned tick range and tick spacing. All initial liquidity comes from the token inventory. The pool begins at the upper tick with no ETH seed. Set `initialBuyWei` and `minimumTokensOut` to `"0"` to launch without a purchase; gas still applies to the controller transaction. A positive purchase requires a positive minimum output and spends exactly the declared value atomically.

This model uses the existing `RobinhoodNativeFeeHookV1` compatibility kernel: its platform fee is 20 basis points, and immutable creator buy/sell fees are independently selectable from 0 to 1,000 basis points. It does not select a module or the separate module fee-split model. Liquidity and residual rounding inventory have no withdrawal path. The inventory builder derives the source closure, constructor arguments, runtime immutable words, CREATE2 addresses, permission-bearing hook salt, role locators and exact request commitments from one input.

| Inventory parameter | Meaning and limits |
| --- | --- |
| `inventoryRaw` | Fixed supply in raw units with 18 decimals. Positive and within signed 128-bit bounds; resulting liquidity must also fit the PoolManager per-tick limit. |
| `tickLower`, `tickUpper`, `tickSpacing` | Ordered, aligned ticks inside TickMath bounds, spacing 1 through 32,767. The upper bound is strictly below the maximum tick. Token-per-ETH price is `1.0001^tick`; an excessively narrow range or large supply can exceed the per-tick liquidity cap. |
| `creatorRecipient`, `creatorBuyFeeBps`, `creatorSellFeeBps` | Nonzero recipient and immutable creator fees; neither source admission nor an API key may replace these bindings. |
| `initialBuyWei`, `minimumTokensOut` | Both zero for no purchase; otherwise both positive. Minimum output protects execution, and failure rolls back the entire launch. |

The server derives `liquidity = floor(inventoryRaw * 2^96 / (sqrtUpperX96 - sqrtLowerX96))`, checks the signed and PoolManager per-tick limits, and verifies rounded token settlement does not exceed the inventory. It reconstructs every target runtime and the child vault from the compiled source and constructor values. A caller-provided digest or local builder report cannot issue admission.

Download these assets from the same API origin and revision as this guide:

| Asset | Route | SHA-256 of exact bytes |
| --- | --- | --- |
| [Node 24 inventory builder](https://api.programmable.market/v4/chains/4663/multi-role-custom-launches/inventory-builder.mjs) | `/v4/chains/4663/multi-role-custom-launches/inventory-builder.mjs` | `sha256:d2bf74210fa1b806d93a4db2b2c0ea2316211b1107c84e9994c2e61e0c4bd262` |
| [Two inert project inputs](https://api.programmable.market/v4/chains/4663/multi-role-custom-launches/inventory-projects.json) | `/v4/chains/4663/multi-role-custom-launches/inventory-projects.json` | `sha256:c3011c6e52ba7bd74b5a329ef1948e870938a6bc7cd905254f5f02e905a071d8` |
| [Builder provenance](https://api.programmable.market/v4/chains/4663/multi-role-custom-launches/inventory-build.json) | `/v4/chains/4663/multi-role-custom-launches/inventory-build.json` | `sha256:5d93e576af0475f7caf1f634b2a55fc6153c1c8b792dc6618d8eca157ae0d25b` |

The additive download descriptors above keep the existing capabilities contract unchanged. Verify the guide against its capabilities pin, then verify these downloads against the guide. Save them as `inventory-builder.mjs`, `inventory-projects.json` and `inventory-build.json`. The standalone executable has no npm installation, private repository, compiler, network, credential or wallet dependency. Its embedded Solidity sources retain their licenses.

Extract one example and build an inert local request:

```sh
node --input-type=module -e 'import fs from "node:fs"; const x = JSON.parse(fs.readFileSync("inventory-projects.json", "utf8")); fs.writeFileSync("project.json", JSON.stringify(x.cases.atlas, null, 2), {flag:"wx", mode:0o600});'
node inventory-builder.mjs --input project.json --out request.canonical.json
```

`cases.cedar` is an independent supply, range, spacing and creator-fee example. For a real project, replace the example's complete context with current capabilities, use your authorized controller, fresh nonce and permit window, real metadata, website/X links, image bytes and truthful attestation. Choose supply, range, creator fees and optional purchase deliberately. The input schema is `programmable.inventory-project-input.v3`; all fields shown in a case are required. Unknown fields fail. The builder emits a normal MultiRole V2 request and the existing request-pack report with predicted addresses. It writes no trailing newline and never overwrites an output file. Use the unchanged transport example below for preflight/create and retain the resulting bytes and idempotency key for retries.

This admission model covers a single pool, fixed token supply, immutable fees and inventory-funded liquidity. Custom mint/burn/tax logic, stateful modules, custom curves, auctions, multiple pools and no-pool settlement need separate model evidence. `MULTI_ROLE_ECONOMIC_RECIPE_EVIDENCE_REQUIRED` identifies missing platform coverage; repeating submission or rotating a key cannot supply it. `MULTI_ROLE_INVENTORY_BINDINGS_REQUIRE_CORRECTION` means the known inventory code is present but its role, source/runtime, economics or funding bindings need correction. These are finding codes within the existing `evidence_required` response, not new HTTP error envelopes. Resolve the specific input inconsistency and deliberately build a fresh request; adding ETH is not required for zero-buy admission.

## Run the Node transport example

Use Node 24. Supply `PROGRAMMABLE_API_BASE_URL` as the integration-approved HTTPS API origin, and inject `PROGRAMMABLE_API_KEY` through your environment or secret manager. Avoid putting the key in command-line arguments or shell history. Capabilities works without a key.

Save the public client download as `multi-role-api-v2.mjs`, verify its SHA-256 against the capabilities descriptor, and run it from that directory:

```sh
node multi-role-api-v2.mjs capabilities --save-response capabilities.private.json
node multi-role-api-v2.mjs preflight --request request.canonical.json --save-response preflight.private.json
node multi-role-api-v2.mjs create --request request.canonical.json --save-wallet wallet.private.json --save-response launch.private.json
node multi-role-api-v2.mjs get --launch-id 12345678-1234-4234-8234-123456789abc
node multi-role-api-v2.mjs list --limit 10 --save-response launches.private.json
node multi-role-api-v2.mjs transaction-hints --launch-id 12345678-1234-4234-8234-123456789abc --transaction-hash 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
node multi-role-api-v2.mjs finality --launch-id 12345678-1234-4234-8234-123456789abc
```

Replace the illustrative UUID and hash with the values from the original launch. To retry create, repeat the same command with the unchanged request file. If you used `--idempotency-key`, retain its exact value. If a wallet is not yet available, `walletSaved` is false and no wallet file is created. Existing output files are never overwritten; use a new output filename or inspect the file already saved.

The example performs one operation per invocation. It has a 30-second total HTTP deadline, bounded response streaming, HTTPS-only origin validation and disabled redirects. It prints a compact status summary rather than the credential, calldata or full wallet. Requested JSON output files are exclusively created with mode `0600`. It reports `Retry-After` guidance but does not schedule retries, create new nonces/windows, invoke custody repeatedly, sign, broadcast or automatically publish anything.

## Versioned MultiRole error catalog

API errors use `programmable.api-error.v1`; MultiRole details use `programmable.multi-role-custom-launch-error-details.v2` with `routeId`, chain and remediation. Honor the response's `Retry-After` header for retryable errors. HTTP 503 can follow a durable reservation, so retain the original identity even when no successful create response arrived.

| Code | HTTP | Retryable | Remediation |
| --- | --- | --- | --- |
| `MULTI_ROLE_INTEGRATION_PENDING` | 503 | Yes | Wait for the published release and verified Router, provider, custody and admission authorities. |
| `MULTI_ROLE_AUTHORITY_UNAVAILABLE` | 503 | Yes | Retry the exact request/key after release authorities recover. |
| `MULTI_ROLE_ADMISSION_PENDING` | 503 | Yes | Retry the original request/key and retain its original window. |
| `MULTI_ROLE_ADMISSION_REJECTED` | 422 | No | Resolve source/economic evidence; submit a new request/key. |
| `MULTI_ROLE_SOURCE_INVALID` | 422 | No | Rebuild the exact source bundle, constructors and runtimes. |
| `MULTI_ROLE_RUNTIME_OPCODE_FORBIDDEN` | 422 | No | Remove forbidden runtime instructions. For metadata-triggered matches, rebuild with `settings.metadata.appendCBOR=false` and `settings.metadata.bytecodeHash="none"`; regenerate exact bytecode, graph and request bindings, then use a new request and idempotency key. Never strip compiled bytes. |
| `MULTI_ROLE_SOURCE_UNAVAILABLE` | 503 | Yes | Retry the same request/key when compiler capacity returns. |
| `MULTI_ROLE_EVIDENCE_REQUIRED` | 422 | No | Provide the reported behavioral/economic evidence; source parsing does not authorize custody. |
| `MULTI_ROLE_BUILD_ONLY` | 409 | No | Confirm a funded launch plan and spending budget; repack with a new key. |
| `MULTI_ROLE_PERMIT_WINDOW_INVALID` | 409 | No | Repack a deliberate new request with a valid fresh window/key. |
| `MULTI_ROLE_PERMIT_EXPIRED` | 409 | No | Use a new request/key for a new launch; retain the original for historical recovery. |
| `MULTI_ROLE_PREPARATION_PENDING` | 503 | Yes | Poll or retry unchanged; do not request another signature. |
| `MULTI_ROLE_CUSTODY_RECOVERY_REQUIRED` | 503 | Yes | Recover the original committed result; do not replace its signature. |
| `MULTI_ROLE_SIMULATION_UNAVAILABLE` | 503 | Yes | Retry simulation of the same stored transaction; no replacement signature. |
| `MULTI_ROLE_FINALITY_UNAVAILABLE` | 503 | Yes | Retain the original hash and retry the hint/read after processing recovers. |
| `MULTI_ROLE_CONTEXT_UNAVAILABLE` | 409 | No | Follow the original `statusUrl`. A deliberate new preparation uses the published context and a new key; retain the original unchanged. |

Shared transport/authentication errors remain separate: `UNAUTHENTICATED` (401), `INSUFFICIENT_SCOPE`/`WALLET_BINDING_MISMATCH`/`MULTI_ROLE_CREDENTIAL_DENIED` (403), `IDEMPOTENCY_CONFLICT` (409), `MULTI_ROLE_WALLET_NOT_PREPARED` (409), `MULTI_ROLE_CAPACITY_EXCEEDED` (429), and input/size/content-type errors. Correct the specific authorization or input problem rather than retrying in a loop. A 404 finality response does not prove transaction failure. For an uncertain network result, check status and reuse the exact original create bytes/key.

Public documentation downloads can return `DOCUMENTATION_UNAVAILABLE` (503) when the release asset cannot be verified. Retry after the deployment recovers. The download routes return `INVALID_QUERY` (400) for query parameters or fragments and `METHOD_NOT_ALLOWED` (405) for methods other than `GET`. `INVALID_CONDITIONAL_REQUEST` (400) means the cache validator exceeds the permitted format or size; remove it and request the exact route again.
