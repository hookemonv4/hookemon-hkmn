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

Run `node --test packages/runner/test/config/pack-plan.test.mjs` for the contract checks. This module performs no IO; it does not connect the UI, persist operator configuration, or admit a cycle by itself.

## Recovery pointers

The durable configuration integration is pending coordinated ownership of `config/state-schema.mjs`. The integration proposal is an explicit operator-configuration v5 with a required `packPlan` field. Validate historical v4 with its original exact shape before migration; initialize only an empty revision-zero plan, preserve existing limits and ledgers, and persist the migrated document through the existing atomic operator-state writer. Never infer executable orders from `allowedPackIds` or `requestedOrders`. Older money schemas retain their existing non-executable handling. The configuration edit path must own revision changes and reject client-supplied plan revisions. Required integration tests cover v4 read/migration, persisted v5 reload, unchanged retry reconciliation, revision conflicts, empty admission, and retained old cycle snapshots. This proposal is not an authoritative spec revision or a completed integration.
