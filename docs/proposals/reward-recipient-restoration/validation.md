# Restoration proposal validation

Baseline: `20eb8e4e`, Node v24.19.0, 2026-09-09. The initial proposal was owner-approved and its implementation is now present. Local EVM acceptance and isolated Docker/browser checks are complete. Final integrated CI and the HTTPS deployment remain pending.

The existing native characterization suite passed: 27 tests, zero failures, zero skips. Command:

```sh
node --test packages/runner/test/distribution/payout-plan.test.mjs packages/runner/test/distribution/eligibility-holder-set.test.mjs packages/runner/test/distribution/eligibility-manifest.test.mjs
```

This confirms existing native floor-rounding dust, manifest validation and full-holder behavior on the baseline. It does not prove top-N selection, new schema migration, new dashboard persistence or real EVM payment execution. The first status call using ambient Node v20.20.2 failed because node:sqlite was unavailable; the pinned Node v24.19.0 status call succeeded. Canonical ledger task creation persisted despite the pre-existing unreachable historical completion preventing projection; claim succeeded with token 1.

`git apply --check docs/proposals/reward-recipient-restoration/requirements.patch` verifies that the proposed revision applies to the recorded baseline without changing the authoritative spec. A parse check verifies revision 71 to 72, no added/deleted requirements, and exactly the four stated requirement changes. `git diff --check` validates the committed proposal formatting.

An independent read-only review found no financial or compatibility defect in the contract. It found one unrelated JSON escape normalization in the proposed diff; the patch was regenerated preserving every unrelated serialized line, and its applicability was rechecked. This is proposal review only, not the final implementation money-path review.

## Acceptance boundaries

| Boundary | Required evidence |
| --- | --- |
| Shared policy and operator CAS | All ten settings persist through read/restart. Strings, fractions, 0, 50, 99, 101, 150, 1100 and stale revisions cause no mutation. |
| Version migration | Native v4/v5 future settings migrate to v6 without losing pack plans or safety controls. Pre-native state remains non-executable. Existing native cycles/manifests/plans preserve exact bytes and digests. |
| Frozen cycle | Creation binds limit, configuration revision, cycle identity and digest atomically. Mid-cycle edits, restarts and cross-cycle snapshot substitutions cannot change active policy. |
| Full replay and selected set | Excess/fewer/no eligible holders, exclusions, tied and zero balances. Recompute full snapshot, top N, counts and supply partition. Reject tampered policy/evidence digests and altered full/selected lists. |
| Allocation and gas | Selected-balance denominator; native floor-and-carry; zero-rounding selected holders; conservation and independent gas reserves. Insufficient gas holds before claim without reducing the selected set. |
| Durable payout recovery | New and historical manifest/plan versions rebuild deterministically. Supplementary payouts reuse original selection. Signed/finalized evidence remains unchanged. |
| Local EVM, actual native handler | N=100,200,300,400,500,600 with excess eligible holders and positive allocations. Exactly one finalized payment per selected holder, no unselected payment, unique nonces, correct principal/dust/gas accounting and interrupted recovery without duplicates. |
| Browser and local Docker | Backend option list, authenticated save/readback, reload, visible failed saves and stale revisions, distinct saved/active settings. Supported backed-up state migration and container restart persistence over HTTPS. |
| Final integration | Independent implementation money-path review, only reproduced fixes and affected retests, current required CI, serial non-draft merge under applicable authority. |

The isolated EVM uses test-only assets/accounts and local endpoint configuration. No live wallet or mainnet broadcast belongs to these acceptance tests. Synthetic FINALIZED records alone are insufficient for the actual-handler row. Capacity PR59 remains independently useful, not restoration acceptance evidence.

## Implementation checks

Core selection and legacy distribution validation passed 118 focused tests. Cycle freezing, adapter eligibility, direct/supplementary handler compatibility and automation passed 124 focused tests. Composed service, production graph and stage-driver regression checks passed 143 tests. Operator configuration/API/persistence checks cover all ten values and fresh-process restart. Dashboard DOM checks passed 15 tests, including both alternating pack/reward saves without reload after the independently reproduced CAS defect was fixed. The local-only selection command guard passed 12 tests.

The independent source money-path review found no allocation, frozen-cycle, legacy compatibility, supplementary or authorization defect. Its one reproduced dashboard CAS issue was fixed and the reviewer closed it. The opt-in Anvil suite exercises the actual native handler; see `docs/evidence/reward-selection-native/README.md` for its command and explicit fixture boundaries. All six requested sizes now have passing local-EVM results: the first run passed 100 through 500 and lost the Anvil socket during 600; after bounding historical account-state retention, the unchanged 600-recipient assertions passed in 338.4 seconds. The failure cause was not proven. Together the successful cases finalized 2,100 payments and verified historical receipts, unique nonces, conservation and recovery without duplicate broadcasts.

The isolated Docker candidate passed all ten settings through authenticated HTTP and browser save/readback. Restart preserved 600; a fresh browser page read the authoritative 200 value. An unavailable API visibly reported `Not confirmed: Failed to fetch`; a stale revision reported `Not confirmed: COMMAND_REJECTED`, without overwriting the saved value. These candidate checks do not establish the final HTTPS deployment or a connected live runner.

The initial CI test suites passed, but integration checks rejected a stale native requirements binding and exact clean-room recognition after the approved spec delta. Clean-room checks also found two developer-home paths in the proposal and harness; those paths were removed. The binding and recognition refresh must preserve the reviewed final native/spec integration before the current required CI is considered complete.
