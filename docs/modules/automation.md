# Automation

## Purpose

`AutomatedCycleService` runs one durable operational cycle through the shared `CycleRepository`.
It owns stage sequencing, the exclusive lease, and policy checks around execution; it does not own a
signer or a provider client.

## Public interface

- `new AutomatedCycleService(config)` requires an explicit `liveMode` and exposes `runOnce` and
  `recoverActiveCycle`.
- An explicit `dryRun` permits a production-profile service with fake providers. It persists that
  flag when creating the cycle and refuses a recovered cycle whose flag does not match the service.
- Live mode additionally requires a policy engine and selected pack id.
- Stage contexts contain the current lease, stable `fencingToken`, cycle release amount, pack id,
  stage name, `assertLease`, and async `assertMutationAllowed`.
- `EvmPolicyWallet` and `SolanaPolicyWallet` bind a policy, intent, owner authorization, signed-bytes
  checkpoint, and injected signer client. Their optional `preflightAuthority` accepts only the exact
  fixture authority while running under the Node test runner.

## Invariants

- The service acquires one lease before inspecting or creating a cycle and releases it on exit.
- Each cycle has an immutable `production` or `rehearsal` mode. A production service refuses a
  rehearsal cycle and a rehearsal service refuses a production cycle.
- It evaluates policy before a new cycle, admits policy before `claim-process`, evaluates policy
  before `purchase`, invokes the execution guard immediately before `stageDriver.execute`, and
  supplies that guard to the driver for the final check before a live provider mutation, signature,
  or broadcast.
- Each stage context carries a fencing token that remains stable across lease renewals. A replaced
  or expired lease makes its mutation guard fail.
- The mutation guard validates its cycle, stage, amount, pack, and fencing-token context before it
  rereads policy and lease state. Once the stage driver has frozen a canonical request, the guard
  also carries that request digest into each signature and broadcast check.
- A live production service may receive a `beforeMutation` canary boundary. A paused or frozen USDG
  result holds the active cycle before stage execution, signing, or broadcast.
- Completed stages are reconciled rather than executed again. Stage joins still require eligibility
  evidence before claim and eligibility plus return evidence before payout.
- Policy-wallet signing and broadcast read the active mutation authority immediately before invoking
  the injected signer client. A provisional or digestless authority refuses before either client call.

## State transitions

- A ready budget is policy-checked before `createCycle`; a refusal returns `POLICY_REFUSED` with no
  new cycle record.
- An incomplete stage is prepared, reconciled, optionally executed, reconciled again, committed,
  and completed in the frozen order.
- A lease renewal updates the lease tuple exposed to an in-flight context without changing its
  fencing token.
- A pre-call failure records `NOT_SENT` before the capability boundary. The same request may return
  to `PREPARED` for a lease-fenced retry. Post-send ambiguity records `SENT_UNKNOWN` and is
  observation-only through `RESPONSE_RECORDED` and `RECONCILED`.
  A generic chain attempt records `PREPARED(requestDigest)`, then
  `SIGNED(rawBytes, nonce or blockhash, hash)`, `BROADCAST`, and `FINALIZED`. The general
  chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal, and approval-digest fields
  are unavailable. Built-in outbound and return use the repository's combined Relay signing
  record for their recovery authority.

## Operational commands

```sh
node --test packages/runner/test/automation/automated-cycle-service.test.mjs \
  packages/runner/test/automation/exclusive-lease.test.mjs
```

- Run production work through the composition root so its policy engine and state reader are wired.
- Use `recoverActiveCycle` after an interrupted process; do not construct a parallel cycle store.

## Recovery pointers

- On a fence failure, stop the in-flight worker and reconcile the repository under the replacement
  lease.
- On `POLICY_REFUSED`, repair the recorded control or custody fact before retrying.
- Live stage code receives guard-wrapped signer and adapter clients. A signature, broadcast, or
  known direct provider/RPC mutation invokes `assertMutationAllowed` immediately before its call.
  Built-in stages whose integrations remain unavailable refuse before provider mutation. Outbound
  and return are active chain-journal routes and complete only when reconciliation returns canonical
  Relay settlement evidence.
  `claim-process` is the chain-journal exception: it records a guarded EVM claim transaction
  through signing, raw broadcast, canonical finality, and custody-ledger reconciliation.
- On restart, keep generic v1 live rebroadcast closed because it has no persisted approval digest.
  Outbound and return may reauthorize only their exact bytes with a matching combined Relay recovery
  record; direct payout reads its exact authority from the self-contained recipient record. A held
  terminal state advances only through an idempotent owner decision.
