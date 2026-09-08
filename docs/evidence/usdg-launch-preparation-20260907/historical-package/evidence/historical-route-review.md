# Fresh Hookemon route review

Read-only review of the 2026-09-07 public deployment, without API key access or protected calls. The saved MultiRole guide and downloaded request packer exactly match the SHA256 digests in new-key-multi-role.json. Packer hash: sha256:747c2e15b9f0ae04e6416550535d4ad9382130889cfc5d6b49d081d9b5f6e55c. No downloaded code was modified or executed.

MultiRole V2 is now ready with non-null context, runtime release3e1384626f6a60befe4234346074a53a463a99bf and Router0x9Fd629Cd1EB47fb20813c2403153714B523f681E. The exact prospective protected route is POST https://api.programmable.market/v4/chains/4663/multi-role-custom-launches/preflight, request schema programmable.multi-role-custom-launch-create-request.v2. Preflight requires custom-launch:create, does not reserve or sign a permit, and exposes source findings; independent admission remains separate.

## What is newly compatible

The actual published graph parser accepts1–16 targets, exactly one token role and one hook role, including separate physical contracts. Hookemon can retain token:['token'], custody:[], hook:['hook'] rather than combining contracts. See packer3255–3285 and3325–3363. Three targets are not the present mismatch.

FundingPlanV2 supports firstBuy:after-launch with initialBuyWei:0, funding.mode:none/valueWei:0, and creator-funded/project-provided liquidity declarations. Launch mode still requires a positive gas budget and actual declared launch liquidity. See5390–5435. This is materially more flexible than V4.1; no native initial buy should be invented for Hookemon. Whether the unchanged seed flow meets the exact deployment call graph must still be materialized and verified.

## Exact unresolved USDG request surface

The transport is not mandatory: guide says callers with a complete compatible request may use transport directly. However, both the published request parser and config are closed. REQUEST_KEYS at5540–5570 includes context, source/compiler/graph, funding, liquidity, intent and attestation plus paired optional behavior inputs; no marketOverride, quoteAsset, PoolKey or controller transaction calldata field exists. graphBundle.pool permits only tokenTargetId, hookTargetId, fee, tickSpacing (3274). Target initializerCalldata can encode project calls; it is not the stamped PoolKey selection.

The internal prepareCustomGraphLaunchV2 accepts a fifth marketOverrideInput argument (5047). Its preparePoolKey supports a generic token/quote pair when supplied (5339–5357), but the published packer call at5774–5779 passes only four arguments. Therefore the exact published packer chooses currency0:zero-address/currency1:token. The request parser preparation object at5628–5636 likewise exposes no override. Adding an undeclared field or patching the packer is not a valid request.

This proves an absent documented caller-controlled USDG PoolKey surface, not that a protected backend cannot derive an approved USDG override from exact source evidence. The current guide says only pinned Native20 is automatically recognized; other economics return evidence_required. No documented API-key-specific economics grant or client bypass field was found. A successful owner-scoped list proves credentials/read scope, not this backend admission behavior.

## Existing artifacts are not ready to POST

The existing /private/tmp/hookemon-p3-package.{H0fgf4,WnPU7F,rnsUhE}/package/create-request.json are profile4.0 drafts, not V2: nonce and permit timestamps null, sourceDescriptor null, sourceBundleSha256 null, applicant salts and constructor locators null, agentAttestation null, no fundingPlan, and liquidity declared state null. They contain compiler/source material worth reusing, but none is an honest current complete preflight request. Do not insert guessed values or POST these drafts.

## Precise provider question

“For unchanged Hookemon on4663 (separate token/custody/hook, USDG pool and existing USDG fee split), does the new MultiRoleV2 backend derive the USDG PoolKey through protected source/economic admission? The published request/config schemas have no marketOverride/quoteAsset and request-packer hash747c2e15… calls prepareCustomGraphLaunchV2 without its fifth argument, defaulting to native/token. Please identify the supported current route plus exact request field or source-derived admission recipe and its context/release binding; if this support is controller/key-specific, how is that scope confirmed before creating a launch? We can supply the exact unchanged source bundle to a documented non-reserving preflight.”

Next concrete work: obtain that exact supported mapping (or updated pinned schema/packer), then materialize the existing three-target source/constructor/runtime declarations and source/image/attestation commitments under the current context. Choose a fresh explicit preflight nonce/window only when packaging is complete. Preserve the USDG economics and owner budget; no ready request or launch admission is claimed here.
