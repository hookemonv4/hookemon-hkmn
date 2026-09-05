# Operator CLI

## Purpose

`packages/runner/src/operator/cli.mjs` parses bounded operator commands and forwards them to an
injected composed authority. It does not construct a cycle repository, signer, scheduler, or local
cycle lifecycle. The adapter entry point also exposes repository-backed recovery commands without
creating a second authority.

## Public interface

- `runOperatorCli(argv, { operatorControl, executeAudited })` accepts an injected control service.
- `status` calls `operatorControl.status()`.
- `reconcile --expected-revision <n>` calls the read-only `operatorControl.execute()` path.
- `pause`, `resume`, `kill`, `update-configuration`, `manual-approval`, `resume-cycle`, and
  `run-cycle-now` require `--expected-revision` and `--request-id`, then call
  `executeAudited({ requestId, expectedRevision, command, effect })`. The executor invokes
  `effect()` only after it has durably recorded the request.
- `held-owner-decision` requires `--expected-revision`, `--request-id`, and a canonical JSON
  `--input` containing the cycle ID, held-evidence digest, cycle revision, and choice.
- `update-configuration`, `manual-approval`, and `held-owner-decision` require a canonical JSON
  `--input` path.
- `hookemon-runner operator [--state <absolute-path>] <operator-command> [operator flags]` builds
  the composition and supplies its `operatorControl` and durable `executeAudited` facade to this
  module. It does not start a dashboard listener. Its audit ledger defaults to
  `<stateDir>/dashboard-audit.log`; `HOOKEMON_DASHBOARD_AUDIT_LOG_PATH` supplies an exact
  listener-free override without requiring dashboard credentials.
- `hookemon-runner status [--cycle <cycle-id>]` reads only the cycle repository and returns
  persisted cycle, stage, attempt, custody, mode, provider profile, and evidence facts. It does not
  load a signer or provider.
- `hookemon-runner resume <cycle-id>` requests recovery through the composed repository-backed
  runner. It reads the persisted mode and provider profile, refuses a profile mismatch or unresolved
  chain attempt before signer construction, and permits an unresolved provider attempt only for
  reconciliation. `hookemon-runner abort-cycle <cycle-id> --reason <text>` records a bounded
  explicit operator stop. Both respect the active lease and fencing token.

## Invariants

- The CLI rejects effectful commands when no audited executor is injected.
- The audited executor persists and deduplicates the dispatch before it calls the control service.
- The command and its deferred effect share an immutable snapshot, so an executor cannot audit one
  command and invoke another.
- The request ID flows to both the audit executor and the authority effect. A held owner decision
  therefore binds its persisted repository transition to the same idempotency key as its audit
  record.
- `reconcile` is the only non-status command allowed without an audited executor and remains
  read-only.
- Status uses a pure repository peek and cannot run archival recovery as a side effect.
- Input paths are absolute regular files. JSON bytes must equal canonical JSON followed by one
  newline. Diagnostics are limited to 512 bytes.
- Direct execution without an injected composed authority fails instead of using a standalone state
  file.
- A recovery command never creates a new signature, nonce, blockhash, request digest, or provider
  send while its cycle has a `SENT_UNKNOWN` provider attempt or an unresolved `SIGNED` chain
  attempt. A provider attempt can enter reconciliation-only recovery; it cannot create a new
  effect.
- A status request is read-only, does not acquire a mutation lease, and cannot trigger a canary,
  signer probe, provider request, or dashboard action.
- `abort-cycle` supplies its lease assertion to the repository hold append. The repository checks
  it before replay, immediately before the durable append, and after the append returns.

## State transitions

- The CLI has no state transition of its own.
- A control command changes durable state only through its injected authority.
- A duplicate request ID returns the previously persisted audited result and does not reach the
  control service again.
- When a dashboard listener is composed, it and the listener-free CLI must use the same audit
  ledger. The dashboard verifies its hash chain before rebuilding its SQLite projection.
- `hookemon-runner tick` is prohibited. Use the audited `operator run-cycle-now` command when an
  explicit one-off cycle trigger is needed.
- `resume` either continues the journal from a reconciled boundary or refuses with the unresolved
  attempt state. `abort-cycle` records the reason without deleting attempt or custody evidence.

## Operational commands

```sh
node --test --test-timeout=120000 packages/runner/test/operator/cli.test.mjs
node packages/adapters/bin/hookemon-runner.mjs operator status
node packages/adapters/bin/hookemon-runner.mjs operator pause --expected-revision <n> --request-id <id>
node packages/adapters/bin/hookemon-runner.mjs status --cycle <cycle-id>
node packages/adapters/bin/hookemon-runner.mjs resume <cycle-id>
node packages/adapters/bin/hookemon-runner.mjs abort-cycle <cycle-id> --reason "provider reconciliation failed"
```

- Invoke operator-control effects through the installed `hookemon-runner operator` path, which
  supplies both dependencies from the composition root.
- Keep `--request-id` stable when retrying an effectful command after a lost response.

## Recovery pointers

- If the audit executor is unavailable, do not run an effect command directly. Restore the composed
  authority and retry through `hookemon-runner operator` with the same request ID.
- If canonical input validation fails, regenerate the input from the source record rather than
  editing whitespace by hand.
- Use `reconcile` to inspect durable repository facts before requesting a recovery effect.
- Start with `status` after a restart. For `SENT_UNKNOWN`, inspect provider and independent chain
  evidence; for `SIGNED`, inspect the exact stored bytes, nonce or blockhash, and hash. Resume
  only after the repository marks the attempt safe to advance.
