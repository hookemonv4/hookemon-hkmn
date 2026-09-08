# Pack plan

## Purpose

Represent the owner's persistent selection as a versioned set of unit purchase counts. A plan describes repeated future execution, not purchase authorization or an amount of money.

## Public interface

`packages/runner/src/config/pack-plan.mjs` exports `assertPackPlan`, `createEmptyPackPlan`, `replacePackPlan`, and `packPlanFromSelection`. The exact JSON record is `{schema: "hookemon.pack-plan.v1", revision, orders: [{pack, quantity}]}`. `revision` is a nonnegative safe integer; quantities are positive safe integers. Orders are sorted by unique pack code. The total quantity cannot exceed the shared `MAXIMUM_PACK_BATCH_SIZE` execution limit of 64.

## Invariants

An empty plan supplies no orders for new admission. A checkbox adds quantity one, preserves quantities already explicit in the plan, and removes unchecked packs. An allowlist never implies an executable plan. The plan carries no money amount, credential, or approval. Quantities count unit purchases; they do not change a Collector binding's supported quantity.

Validation returns a detached, deeply frozen value. A caller can retain that snapshot for a cycle while a later configuration uses a different plan. Durable cycle replay still requires the caller to journal the snapshot and bind it to the cycle's existing identity.

## State transitions

Replacing orders increments the plan revision once only when the orders change. An identical replacement leaves the revision unchanged so command retry reconciliation remains idempotent. Neither reading a plan nor completing a cycle consumes or resets it. Revision overflow is rejected.

## Operational commands

Run `node --test packages/runner/test/config/pack-plan.test.mjs` for the contract checks. The plan module performs no IO. Operator configuration v5 embeds its required `packPlan`; the existing atomic operator state writer persists it. Use `node --test packages/runner/test/config/state-schema.test.mjs packages/runner/test/config/pack-plan-persistence.test.mjs packages/runner/test/operator/state-file.test.mjs` for migration, revision conflicts, and fresh-process persistence checks. UI and scheduler integration use this contract separately.

## Recovery pointers

`migrateOperatorConfiguration` accepts an exact native v4 configuration, validates all existing fields, and supplies an empty revision-zero plan. `readOperatorState` commits that migration through its existing locked atomic writer, advancing the state revision once while preserving configuration revision, limits, and ledgers. A second read performs no migration. Earlier money schemas remain rejected for executable state. Malformed v4 records or records with an injected plan are rejected. No orders are inferred from `allowedPackIds` or `requestedOrders`.

Submit edits as `configuration: {packPlan: {orders: [{pack, quantity}]}}`; schema and plan revision are server-owned. Unchanged orders retain their plan revision, so the control layer's existing functional retry comparison remains valid. The operator-state compare-and-swap revision rejects stale edits. Active-cycle callers retain their detached snapshot; changing stored configuration cannot mutate it. Scheduler adoption and durable cycle snapshot binding are separate integration work.

Adding a new pack or increasing its quantity uses the existing operator-control exposure guard and requires safety telemetry. Reducing or clearing the plan remains available during telemetry outages. Plan storage never expands the independent allowed-pack list or spend caps.
