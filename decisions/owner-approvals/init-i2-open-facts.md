# I2 assumptions reconfirmation — open facts (companion to `init-i2-assumptions-reconfirmation-draft.json`)

This file is deliberately kept OUTSIDE the schema-exact `v4-owner-approval-v2` draft (which allows only
`schema, authority, action, phase, itemId, rationale, approvalToken, subjectHashes` — no extra keys). It
records context the reviewer needs, without adding fields the approval schema would reject and without the
approval record silently omitting a fact A already knows.

## What A4 already verified (preserved, unchanged by this note)

- The current `product/PRD.md` and `policy/policy.json` byte content is identical to the content the owner
  approved on 2026-09-02 (`decisions/owner-approvals/closeout-revision-58-init-i2-approved.json`). Only the
  `gates/init.json` hash differs, and only because of additive gate inventory (new gate entries), not because
  any previously-approved assumption changed.
- This means the reconfirmation the owner is being asked for is narrow: "the same assumptions you already
  approved are still the same assumptions," not a new substantive decision.

## Open fact: provider4.1 compatibility is unresolved, and the owner's provider choice is pending

Per the coordinator's dispatch (`/private/tmp/hookemon-launch-repair-20260906/A-inbox.md`, A3-terra-review
follow-up): "Current assumptions should reflect provider4.1 incompatibility OPEN FACT, not assume current
USDG hook is admitted. Owner provider-choice remains pending."

A records this exactly as an open fact, not as an assumption to silently fold into the I2 reconfirmation:

- `product/PRD.md` already states the live-mode precondition correctly and conservatively: live mode
  requires "Programmable reporting Robinhood Chain (`4663`) launch readiness as available; neither is true
  at the time of writing" (see `product/PRD.md` around the live-mode section), and the integration status
  table marks the live Launchpad/admission/callback/fee interfaces `INTEGRATION_PENDING`.
- A did **not** find, in this worktree, an explicit repo-tracked artifact that names a specific "provider4.1"
  version number or documents the exact nature of its incompatibility with the current USDG hook design.
  The only versioned provider-adjacent artifact A could locate is the vendored review-target builder manifest
  (`scripts/programmable/vendor/programmable-v4-hook-builder/manifest.json`, `source.ref: refs/tags/v0.4.0`),
  which is a build/verification tool, not the live Launchpad provider itself — A is not asserting these are
  the same thing, and is flagging this as a genuine evidence gap rather than guessing.
- A is therefore **not** asserting the current USDG hook is admitted by whatever the owner ultimately selects
  as the provider version, and is **not** treating I2's reconfirmation as covering that separate, pending
  provider-choice decision. The I2 reconfirmation draft's `subjectHashes` binds only `gates/init.json`,
  `policy/policy.json`, and `product/PRD.md` as they exist today — it does not, and must not be read to,
  resolve the provider-compatibility question.

## Second open fact: I2 requires an explicit `## Assumptions` block that the current PRD does not have

Per Terra's independent review (`A3-terra-review.md`, "I2 owner decision preparation"): I2 is owner-only and
requires an `ASSUMPTIONS` block per `gates/init.json:22-35`, but `product/PRD.md` currently has no
`## Assumptions` section — only the integration-status table recording pending external bindings. The prior
approval (`closeout-revision-58-init-i2-approved.json`) describes a different, superseded Phase-2 autonomous
rebuild and binds an obsolete `gates/init.json` hash, so it cannot simply be rebound to current content either.

This means the reconfirmation-only framing above (comparing current vs. 2026-09-02 PRD/policy bytes) is
necessary but not sufficient on its own: a genuinely reviewable I2 owner-gate request likely also needs a
proposed explicit `## Assumptions` section text, drawn from the current pending bindings, for the owner to
confirm or correct — not an assumption A infers and asserts unilaterally. A is recording this gap rather than
either (a) silently treating the byte-identical PRD/policy finding as sufficient, or (b) drafting assumptions
text on the owner's behalf without being asked to in this turn's scope.

## What a later, reviewable owner-gate request on this topic would need

To make a future request about provider4.1 compatibility reviewable (not a blanket phase approval), A expects
it will need, at minimum:

1. A concrete identification of which provider version(s) are being compared (the live Launchpad's actual
   reported version/interface set vs. whatever "provider4.1" refers to) — sourced from an official,
   attributable statement, not inferred from vendored tooling version tags.
2. An explicit, enumerated list of the specific incompatibilities (interface signature, callback shape, fee
   accounting field, or admission precondition differences) rather than a general "incompatible" label.
3. A statement of which side of the incompatibility the current USDG hook / PRD assumptions would need to
   change on, if any — or confirmation that no PRD assumption changes, only an implementation detail changes.
4. The owner's actual provider choice (which version to build/launch against), since A cannot infer this and
   has been instructed not to.

A will not treat silence on this topic as authorization to proceed under either provider assumption, and will
not fold a future provider-choice approval into a phase-wide claim; each remains a separate, narrow gate item.
