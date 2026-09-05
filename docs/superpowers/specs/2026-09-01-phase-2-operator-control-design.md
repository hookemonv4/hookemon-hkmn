# Product Phase 2 Manual Operator Control Design

**Status:** Owner-approved local scope. Requirements binding and implementation evidence are recorded separately. No external action is authorized by this document.

## Outcome

Phase 2 adds the smallest control surface needed to operate repeated manual cycles without weakening the Phase 1 money path:

- inspect one exact pack snapshot and select one pack;
- edit the selected pack and money parameters while the cycle is a draft;
- freeze one canonical cycle plan before any money-moving action;
- keep at most one active cycle;
- recover and reconcile the exact same cycle after interruption; and
- after an evidenced terminal failure, prepare a new cycle with a fresh cycle identifier, nonce, and isolated return escrow.

The implementation is local and fixture-backed. It does not sign, broadcast, deploy, spend, call a production provider, or claim production readiness.

## Scope boundary

### Included

- One manually supplied, content-addressed pack snapshot.
- Manual selection of exactly one pack code present in that snapshot.
- Quantity `1` and `turbo: false`.
- Draft editing of pack selection, process amount, minimum receives, native-gas caps, expiry, and the existing frozen route and binding digests.
- One canonical freeze operation that makes every execution field immutable.
- One active cycle across the local operator state and the hook-bound vault coordinator.
- Durable journal recovery, unresolved-intent reconciliation, and same-cycle resume.
- A fresh cycle after `PAYOUT_COMMITTED` or an evidenced terminal `FAILED` state.
- A unique immutable `CREATE2` return escrow for each cycle.
- Permissionless cleanup of an expired, unfunded pending authorization while keeping its cycle identifier and nonce consumed.
- Authorizer-only, exact-subject deadline renewal for a `FUNDED` outbound authorization or `RETURNED` payout authorization, using a fresh nonce.
- Local status output derived from frozen plan, durable journal, and verified contract observations.

### Excluded

- Dashboard, browser UI, HTTP service, database, scheduler, daemon, background refresh, alerts, or automatic retries.
- Automatic pack selection, ranking, pricing strategy, route discovery, route optimization, turbo mode, multiple packs per cycle, or concurrent cycles.
- A generic transaction builder, wallet connection, private key, signer, broadcast path, credential loader, production Collector mutation, or production Robinhood RPC integration.
- Reusing a failed cycle identifier, nonce, escrow, receipt, or authorization.
- Crediting delayed or unsolicited funds to another cycle.
- Rescue, sweep, reassignment, or recovery of funds that arrive in a failed or cancelled cycle escrow.
- Changing any frozen field during deadline renewal, reissuing an external action, or treating renewal as evidence that an unresolved action failed.

## Operator artifacts

All artifacts use the existing bounded canonical JSON and SHA-256 digest functions. Unknown properties, duplicate pack codes, noncanonical values, and digest mismatches fail before state changes.

### Pack snapshot

The operator imports one exact observation:

```text
schema: "hookemon.pack-snapshot.v1"
source: "collector"
observedAt: UTC timestamp
sourcePayloadDigest: sha256 digest of the exact source bytes
packs: unique records sorted by code
  code: provider pack identifier
snapshotDigest: sha256 over the canonical artifact without snapshotDigest
```

The first increment needs only the exact pack code. It does not persist price, inventory, rank, or a refresh policy. Importing a newer snapshot creates a different digest and never changes an already frozen plan.

### Draft and frozen plan

A draft contains the existing Phase 1 identities plus:

```text
schema: "hookemon.cycle-draft.v1"
cycleId: unique nonzero identifier
authorizationNonce: fresh nonzero nonce
packSnapshotDigest: exact imported snapshot digest
pack: one code present in that snapshot
quantity: 1
turbo: false
amount: positive USDG base-unit integer
minimumRobinhoodReceive: positive integer
minimumSolanaReceive: positive integer
minimumReturnUsdg: positive integer
robinhoodNativeGasCap: positive integer
solanaNativeGasCap: positive integer
expiresAt: future timestamp
bindingManifestDigest: existing approved binding digest
outboundActionDigest: exact outbound action digest
returnActionDigest: exact return action digest
operationsTrigger: frozen trigger identity
cycleVaultAccount: immutable coordinator address
returnAccount: computed cycle escrow address
```

Draft replacement is allowed only before freeze. Freeze validates the complete draft, verifies the pack against the named snapshot, recomputes the deterministic escrow address, and emits `hookemon.frozen-cycle-plan.v1` with a `planDigest`. There is no edit or unfreeze operation. Any changed field requires a new cycle identifier and nonce.

Secrets, signatures, credentials, raw provider responses, and unrestricted transaction bytes are not plan fields.

## Cycle custody

### Coordinator and per-cycle escrow

`PegCycleVault` remains the immutable hook-bound coordinator and authorization verifier. It no longer acts as the shared token return address. For every accepted cycle identifier it computes and deploys one `PegCycleReturnEscrow` with `CREATE2`.

The escrow binds these constructor values:

- coordinator (`PegCycleVault`);
- USDG token;
- bound hook;
- immutable typed route executor;
- cycle identifier.

Its salt is the cycle identifier and its init-code hash includes every immutable identity. `computeCycleEscrow(cycleId)` returns the address before authorization. A funding authorization is valid only when `returnDestination` equals that address.

The escrow exposes only coordinator-gated exact transfers to the immutable route executor and the immutable hook. It has no generic recipient, approval, call, delegatecall, upgrade, rescue, sweep, owner, or successor path.

### Funding and return flow

1. The authorizer records one exact funding authorization whose return destination is the computed escrow.
2. `ProcessBudget.openPegCycle` atomically debits process liability and transfers the exact amount to that escrow, not to Operations and not to the coordinator.
3. Funding confirmation requires the escrow balance to have increased from zero by exactly the authorized amount.
4. Outbound execution asks the escrow to send the exact principal to the immutable route executor. The route remains bound to the same escrow as its return destination.
5. Exact attributable returned USDG arrives in that escrow.
6. Payout authorization requires the escrow balance to equal the authorized root sum. The escrow transfers that sum only to the bound hook while the hook records the matching payout liability.

Unexpected funds never become authority. A nonzero prefunding balance, an incorrect funding delta, or a balance that differs from independently evidenced attributable return blocks progress. The authorizer may not fold dust or unrelated transfers into the payout root. A blocked or failed escrow stays isolated.

### Historical and active state

The coordinator keeps one active slot and historical records keyed by cycle identifier:

- escrow address;
- terminal lifecycle;
- committed payout evidence; or
- terminal failure receipt digest.

`PAYOUT_COMMITTED` and `FAILED` close the active cycle. A later authorization may start only with an unused cycle identifier and unused nonce, producing a different escrow. The previous escrow and its terminal record remain unchanged.

Ordinary funding authorization remains unavailable in `FAILED`. The authorizer must use the dedicated failed-cycle recovery authorization with the exact predecessor cycle identifier and its stored nonzero failure receipt digest. The coordinator records the predecessor-to-successor binding before the hook can fund the successor. If that pending recovery authorization expires unfunded, cleanup removes the pending successor binding so another fresh cycle may be authorized from the same failed predecessor; neither expired cycle identifier nor nonce becomes reusable.

A delayed return to failed cycle A remains in escrow A. It cannot change escrow B's funding balance, returned amount, payout root, or lifecycle. This isolation is the reason shared-vault reopening is not permitted.

## Authorization expiry

An authorization that expires before funding would otherwise occupy the pending slot indefinitely. The minimal cleanup operation is:

```text
cancelExpiredFundingAuthorization(cycleId)
```

Any caller may invoke it only after the matching pending authorization has expired and while funding is not in progress. It deletes only the pending record and emits an event. The cycle identifier, nonce, and any deployed escrow remain consumed, so the authorization cannot be replayed. A later draft must use a fresh cycle identifier and nonce.

This operation cannot cancel `FUNDED`, `OUTBOUND`, or `RETURNED` state. If a later-state deadline expires, the cycle stays visible and fail-closed; an operator cannot silently replace it with a new cycle. Only the exact renewal below can restore liveness.

### Exact same-cycle renewal

An expired deadline must not permanently strand funds that are already isolated in a live cycle. The immutable authorizer may renew only the deadline for these two states:

```text
renewFundingAuthorizationDeadline(FundingAuthorization renewal)
renewPayoutAuthorizationDeadline(PayoutAuthorization renewal)
```

The first operation is valid only in `FUNDED`; the second is valid only in `RETURNED`. In each case, the renewal must retain the same cycle identifier and every frozen authorization field except `expiresAt` and `nonce`. The new deadline must be in the future and the nonce must be nonzero, unused, and different from the prior nonce. The coordinator consumes that nonce and replaces only the stored deadline-bound authorization digest.

Renewal does not execute, rebroadcast, or retry anything. It cannot run in `OUTBOUND`, because an outbound external action may already be unresolved and must be reconciled from evidence. It cannot alter pack, amount, trigger, escrow, routes, minimum receives, gas caps, payout, manifest, root, or receipt. A mismatch fails without state mutation.

## Durable local control

One atomic JSON state file is sufficient. It stores the current pack snapshot, optional draft, optional frozen plan, terminal cycle summaries, and the existing `FixtureCycleStore.snapshot`. Writes use an exclusive lock, expected state revision, temporary file, file sync, rename, and directory sync. A stale writer cannot replace newer state.

The local CLI exposes only:

```text
packs list
cycle prepare
cycle freeze
cycle start
cycle status
cycle resume
cycle reconcile
```

`cycle start` creates or restores the runner for the frozen plan but grants no external authority. `cycle resume` reconstructs the runner with `CycleRunner.recover(cycleId, entries, { cycleStore })`. If the durable journal contains an unresolved external attempt, `cycle reconcile` must resolve that same request digest from verified fixture evidence before any later transition. It never prepares a replacement action while the earlier action might have executed.

Terminal failure is not a CLI flag. The controller accepts it only from the verified terminal contract observation and nonzero failure receipt digest. Once recorded, `cycle prepare` permits a new draft only with a different cycle identifier and nonce.

Status is a read-only projection of the exact state file. It reports the plan digest, cycle identifier, cycle stage, journal version and head, unresolved request digest when present, terminal evidence, and whether `start`, `resume`, `reconcile`, or `prepare-new` is the only safe next operation.

## State transitions

```text
DRAFT --freeze--> FROZEN --start--> ACTIVE
ACTIVE --crash/restart--> ACTIVE (same cycleId, same planDigest)
ACTIVE --unresolved attempt--> RECONCILE_REQUIRED
RECONCILE_REQUIRED --verified reconciliation--> ACTIVE
ACTIVE(FUNDED or RETURNED) --exact deadline renewal--> ACTIVE (same cycleId, same frozen subject)
ACTIVE --payout committed--> PAYOUT_COMMITTED
ACTIVE --verified terminal failure--> FAILED
PAYOUT_COMMITTED --fresh id + nonce--> DRAFT
FAILED --fresh id + nonce--> DRAFT
```

There is no `FAILED -> ACTIVE` transition for the same cycle. There is no `RECONCILE_REQUIRED -> retry` transition.

## Failure behavior

| Condition | Result |
| --- | --- |
| Pack code is absent from the exact snapshot | Draft or freeze fails without mutation |
| Pack or money field changes after freeze | Rejected; a new cycle is required |
| Another cycle is active | Start and new-cycle preparation fail |
| Process restarts with a valid state file | Same cycle and journal are recovered |
| Prior external attempt is unresolved | Only reconciliation is allowed |
| Terminal failure lacks verified receipt evidence | Cycle remains active or unresolved |
| A failed cycle receives a delayed return | Funds remain quarantined in its escrow |
| A new cycle reuses a cycle identifier or nonce | Authorization fails |
| Pending authorization expires before funding | Permissionless pending cleanup; identifier and nonce remain consumed |
| `FUNDED` or `RETURNED` authorization expires | Only an authorizer-approved exact-subject renewal with a fresh nonce may restore liveness |
| Renewal changes any field other than deadline and nonce | Renewal fails without mutation |
| State-file revision or journal head is stale | Write fails without replacing current state |

## Acceptance criteria

- Two snapshots with the same canonical bytes have the same digest; changing the pack list changes the digest.
- Only a pack present in the named snapshot can be frozen.
- Draft fields can change before freeze and no frozen execution field can change afterward.
- Quantity other than one and turbo mode fail.
- A restart reconstructs the exact cycle, plan digest, journal head, authorizations, and consumed receipts.
- An unresolved attempt blocks every retry and later action until exact reconciliation succeeds.
- At most one cycle is active.
- Cycles A and B compute different escrow addresses.
- After an evidenced failure of A, B can start only with a fresh cycle identifier and nonce.
- A recovery authorization with the wrong failed predecessor, failure receipt digest, caller, or already-bound successor fails without mutation.
- A late return or direct transfer to A cannot fund, return, or pay B.
- Expired pending authorization cleanup is unavailable before expiry, cannot affect funded state, and does not free the old identifier or nonce for reuse.
- A `FUNDED` or `RETURNED` renewal accepts only a future deadline and fresh nonce over the byte-identical frozen subject; it performs no external action.
- The operator package imports no signer, wallet, network mutation, broadcast, database, scheduler, or server dependency.
- Production Collector and Robinhood actions continue to fail with `INTEGRATION_PENDING`.

## Rejected alternatives

### Reopen the shared vault after failure

A delayed return from failed cycle A could arrive while cycle B uses the same balance and be misattributed to B. Balance-zero checks only prove one instant and do not isolate later transfers. Rejected.

### Deploy a complete cycle factory or support concurrent cycles

A factory, lease manager, per-cycle budgets, and concurrency policy would add authority and recovery states that the owner did not request. One coordinator with deterministic isolated escrows provides the required safety with less code. Rejected.

### Add a dashboard, database, scheduler, or automatic pack strategy

These surfaces do not make manual pack selection or same-cycle recovery safer. They add persistence, hosting, access, freshness, and unattended-authority decisions. Deferred.

### Permit editable or automatic renewal

Editable renewal could change custody or economics after freeze, while automatic renewal would extend authority without a fresh authorizer decision. Rejected. The narrow renewal changes only deadline and nonce for the same funded or returned cycle.
