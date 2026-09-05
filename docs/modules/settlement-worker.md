# Settlement Worker

## Purpose

The settlement-worker module retains an earlier Merkle entitlement flow for fixture verification and
audit evidence. Phase 3 direct payout owns the approved recipient payout path; this worker cannot
submit an entitlement under the active Phase 3 authority.

## Public interface

- `settleDistribution(...)` verifies an artifact, paired approval, receipt, and local proof before
  it can call an injected `submitEntitlement` client.
- A Node-test fixture may supply the exact retained test authority to exercise durable journal and
  retry behavior. Production callers omit it.
- Direct-payout owns recipient preparation, signature, broadcast, finality, and frozen-recipient
  quarantine.

## Invariants

- Immediately before every injected `submitEntitlement` call, the worker re-reads the retained
  custody mutation authority. The provisional Phase 3 authority refuses before the client is
  called.
- A copied or caller-created test authority cannot bypass that check. A generic frozen authority
  cannot reactivate this retained Merkle path; a future design needs a separately approved runtime
  interface.
- This worker cannot construct a Phase 3 payout, select a recipient, sign, broadcast, or mark
  funds paid.
- It is excluded from the deployment manifest, composition root, and active scheduler path.
- A former settlement record cannot override a frozen Phase 3 manifest or recipient journal.

## State transitions

- `PROVISIONAL_PHASE3_PENDING_FEASIBILITY` refuses before an entitlement submission.
- Fixture runs can write only their injected local journal after the exact test authority is
  accepted.
- A new settlement design requires a new approved architecture and does not reactivate this worker
  in place.

## Operational commands

```sh
cd packages/runner
node --test --test-timeout=120000 test/distribution/settlement-worker.test.mjs
```

## Recovery pointers

- Recover interrupted recipient work from the direct-payout journal, not from this worker.
- Keep frozen-recipient liabilities quarantined until a later approved handling path exists.
- Reject any runtime composition that attempts to route a Phase 3 payout through this module.
