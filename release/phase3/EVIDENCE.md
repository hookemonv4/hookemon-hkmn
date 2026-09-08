# Native release evidence

The pinned local launch compilation binds HKMNToken, PermanentPositionCustody and HookemonHook. The compiler is solc 0.8.26+commit.8a97fa7a, optimizer runs 1000, Cancun, with metadata disabled. `build-info/launch.json` embeds the standard JSON input; target artifacts retain creation and runtime templates. Actual constructor-bound runtime identities require the final graph.

The native market allocates the full one-billion HKMN stock, uses native ETH as currency0 and permanently custodies the full-range LP position. No native seed amount or wei claim ceiling has been selected. `feasibility/native-funding/` records a local experiment with real contracts and synthetic graph bindings; it proves neither a live complete cycle nor an all-in budget.

`native-interface-build-binding.json` under `feasibility/` binds the revision-72 build inputs provisionally. Its historical freeze and offchain amendment provide no current native feasibility credit. `verify-launch-package.mjs --allow-unverified` checks draft consistency while returning `readyForPreflight:false`; it is not a release pass. `review-target.json` inventories package files and exact digests.

The three target artifacts are checked against pinned chain deployment size limits retained in `genesis-evidence.json`. `scripts/verify-deployment-manifest.mjs` computes code and initcode headroom locally. Current required CI on the exact candidate supplies contract, adapter, runner, web, archive-fork and control evidence; an older passing head does not approve a changed candidate.

The incomplete provider request needs exact source/runtime commitments, graph derivation, metadata, native funding choices, identity and current admission. `feasibility/native-provider-admission/README.md` records the actual public schema and model difference. Credentials are separate execution inputs and are not package contents. Current block-bound runtime observations, exact unsigned transactions and actual cycle receipts remain to be collected.

The owner plans EUR 250 and prioritizes functional testing before complete cost analysis. Revision 72 records the deferred affordability decision without selecting live amounts. `launch-plan.md` defines the staged test and required observations; no signature, spend or launch is evidenced here.
