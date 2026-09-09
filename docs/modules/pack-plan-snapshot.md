# Pack plan snapshot

The snapshot binds an operator's exact pack plan revision and orders to one cycle before the cycle opens. It is off-chain configuration evidence, not purchase authorization, a quote, or monetary evidence.

`createPackPlanSnapshot({ cycleId, plan })` returns a detached, deeply frozen `hookemon.pack-plan-snapshot.v1` object containing `cycleId`, validated `plan`, and the canonical SHA-256 `digest` of schema, identity, and plan. `assertPackPlanSnapshot(value, { cycleId })` validates the exact schema, digest, and optional expected identity.

`CycleRepository.createCycle({ ..., packPlan })` stores the snapshot in the initial `cycle-opened` event. An explicitly supplied invalid plan is rejected before a cycle is written. The event cannot be repeated; there is no setter to replace or attach a snapshot later. Replay validates the stored snapshot against the journal's cycle identity. `readActiveCycle` and `describeCycle` expose the original snapshot after restart. Changing operator settings does not alter it.

Legacy cycles opened without `packPlan` remain without a snapshot. Recovery never derives one from current settings. Execution callers must pass the selected plan at cycle creation and consume the stored snapshot on recovery; this module does not connect the scheduler, execute orders, or admit purchases.

Run `/opt/homebrew/bin/node --test packages/runner/test/automation/pack-plan-snapshot.test.mjs packages/adapters/test/app/pack-plan-snapshot.test.mjs` from the repository root. Adapter dependencies must be installed from their lockfile.

If replay rejects the digest or cycle identity, retain the original journal for diagnosis and use the cycle repository recovery procedures. Do not rewrite the journal or substitute the latest configured plan.
