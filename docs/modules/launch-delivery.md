# Launch delivery

The delivery assembler snapshots the current native launch source and release bytes for coordination and review. It keeps compiler inputs, each inline Solidity source, the three artifacts, release records, package tools, requirements, owner inputs and the existing metadata image together. It reads no environment file, API key, wallet or runtime observation.

`assemble-launch-delivery.mjs --source WORKTREE --output NEW_DIRECTORY` creates a new directory atomically after rechecking every input. `--verify DIRECTORY --source WORKTREE` verifies all file hashes and detects changes in the source revision or package inputs. An existing output is never replaced. Refresh after another worker completes its changes; retain previous snapshots as evidence of their exact bytes.

The manifest records the source commit and the actual file bytes, including uncommitted inputs. Compiler source mismatch, inconsistent artifact settings, symlinks, unsafe paths, unexpected snapshot files and credential-like text are refused. The source tree is read twice before publication to detect concurrent edits. Runtime sizes and unresolved request fields are reported; null fields alone do not determine schema validity.

Every output is `PREPARATION_SNAPSHOT`, with `readyForPreflight: false`. Integrity is not compiler reproduction, an authenticated runtime observation, provider admission or wallet authorization. The assembler neither creates a new request nor upgrades a template to a signable launch. The final producer retains its original runtime-observation authority and financial inputs.

The official [4.1 launch workflow](https://programmable.market/docs/developers/custom-launch-quickstart) requires a complete pack configuration, `pack --config CONFIG --output launch.json --receipt receipt.json`, then `validate launch.json --config CONFIG`. V4 validation rebuilds the exact request from that configuration; validating only request shape does not establish readiness. Remote preflight, submission and the wallet signature remain separate operations. This delivery tool never changes the confirmed project fee agreement.

If verification reports `STALE`, assemble into a new directory from the completed source lane and rerun the applicable package checks. Do not edit snapshot bytes or reuse a previous admission response for a changed request. If assembly catches an in-progress upstream edit, wait for that worker's completion handoff before refreshing.
