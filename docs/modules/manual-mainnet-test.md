# Manual mainnet test

## Purpose and public interface

The manual controller reserves at most one test request. It provides `status`, `request`, `recover`, `stop` and `settled` to the composed private dashboard. The fixed requested plan is one 25-dollar `pokemon_25` pack funded by the existing Operations wallet on chain 4663, with proportional rewards for the top 100 eligible holders of Programmable V4 (`0xC60bA256B44334A0Cd2C7242E98B88f031abB006`). It is separate from the ordinary Hookemon automation.

## Invariants and transitions

An exclusive file creation and sync persist `manual-cycle-request.json` before admission. The stored plan, operator revision, configuration revision, cycle ID and digest bind the request. Concurrent or repeated requests cannot create a second cycle. An unreadable or uncertain record refuses new admission. The file is never automatically removed, including after completion.

The first admitted call uses `runOnce`. All subsequent attempts use recovery of that same cycle only. Pending effects receive at most 12 recovery attempts at five-second intervals; holds, unknown errors and shutdown stop the attempt. A completed journal can reconcile a request after a crash. Unknown execution is reported as uncertain rather than rejected. No success status is inferred from an HTTP acceptance.

## Operational commands and limits

The production command is `node packages/adapters/bin/hookemon-runner.mjs run --mode production --manual-start`. It does not start the autonomous scheduler. It still requires authentic production configuration, preflight and signer readiness. Do not run it merely to inspect an unavailable deployment.

The current engine does not implement funding this test directly from existing wallet balance or substituting V4 holder evidence for the HKMN launch snapshot. The composition therefore always reports those missing capabilities and cannot start this requested live cycle. The manual controls and fixture tests are preparation, not proof of an executable mainnet test.

Holder preview rows contain exact integer balance numerators and the selected-holder denominator. Human-readable percentages are only display values. Actual payouts must be derived from confirmed attributable proceeds with existing integer rounding and dust accounting. A preview reconstructed from one RPC is not a verified payout snapshot.

## Recovery and website reporting

Keep the request file, audit records and cycle journal together. Never delete a request to retry a purchase or erase a payment. Recover only the bound cycle after resolving its concrete readiness or custody condition. A later reset may hide or archive a test display while preserving financial evidence and duplicate-payment protection. Website results require actual finalized transactions; no preview is published as a purchase, sale or payout result.

The file operations use the documented Node 24 `open` exclusive flags and `FileHandle.sync` APIs: https://nodejs.org/docs/latest-v24.x/api/fs.html. The project runtime is pinned to Node 24.19.0; the currently hosted major-version reference is newer, and the used operations predate that runtime.
