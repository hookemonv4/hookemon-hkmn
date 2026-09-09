# Restoration proposal validation

Baseline: `20eb8e4e`, Node v24.19.0, 2026-09-09. No restored selector or payout implementation exists in this change.

The existing native characterization suite passed: 27 tests, zero failures, zero skips. Command:

```sh
node --test packages/runner/test/distribution/payout-plan.test.mjs packages/runner/test/distribution/eligibility-holder-set.test.mjs packages/runner/test/distribution/eligibility-manifest.test.mjs
```

This confirms existing native floor-rounding dust, manifest validation and full-holder behavior on the baseline. It does not prove top-N selection, new schema migration, new dashboard persistence or real EVM payment execution. The first status call using ambient Node v20.20.2 failed because node:sqlite was unavailable; the pinned Node v24.19.0 status call succeeded. Canonical ledger task creation persisted despite the pre-existing unreachable historical completion preventing projection; claim succeeded with token 1.

`git apply --check docs/proposals/reward-recipient-restoration/requirements.patch` verifies that the proposed revision applies to the recorded baseline without changing the authoritative spec. A parse check verifies revision 71 to 72, no added/deleted requirements, and exactly the four stated requirement changes. `git diff --check` validates the committed proposal formatting.

An independent read-only review found no financial or compatibility defect in the contract. It found one unrelated JSON escape normalization in the proposed diff; the patch was regenerated preserving every unrelated serialized line, and its applicability was rechecked. This is proposal review only, not the final implementation money-path review.

## Implementation acceptance to run after approval

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
