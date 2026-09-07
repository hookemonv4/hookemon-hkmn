# ADR-0025: Classify pre-effect transient failures apart from semantic-invalid holds

## Status

Proposed. Drafted for requirements revision 66, alongside ADR-0024. This
decision grants no deployment, credential use, signing, broadcast, asset
movement, spending, or publication authority, and is not itself an owner
approval of revision 66 — that remains true regardless of approval state.
Formal approval of the exact revision-66 `specs/requirements.json` bytes is
the `S5` item defined in `gates/spec.json`, evidenced solely by a
`decisions/owner-approvals/*` receipt bound to that exact current hash; check
that directory and `gates/runs/spec.json` directly for the current state
rather than inferring it from this document. This ADR does not itself grant
or record that approval.

Separately from requirements approval, the canonical
`docs/audit/2026-09-04/failure-matrix.json` is unchanged for every cell named
below and still requires the frozen `HELD_UNAVAILABLE`/owner-decision tuple
for each — that remains the currently deployed fallback contract regardless
of whether the requirements text above is approved. The proposed tuples this
ADR describes live only in the clearly non-canonical
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`,
which is not read by `packages/runner/test/cycle/failure-matrix.test.mjs`, any
CI gate, or any other conformance check. A tuple below must not be promoted
into the canonical matrix, and its owning work package must not be added to
that test file's `OPEN_FACT_CELL_KEYS` allowlist, until the runtime change
exists and an exact passing test citation replaces the current-behavior
citation.

Unlike ADR-0024, this ADR's target behavior is only partially implemented at
this head: for three of the four revision-65 failures, the low-level
`createStageDriver` primitive already leaves `terminalState=null` and the
cited attempt state exactly as the proposed pre-effect rows describe (see the
`currentBehaviorEvidence` field for each row in the draft artifact) — this is
necessary infrastructure for, but not proof of, either the frozen whole-cycle
hold or the proposed automatic classification below. What is missing is the
durable reason/classification record, scheduler/status projection, and the
named automatic next transitions (`refresh-after-readmission`,
`reconcile-then-replace`, and so on) actually being wired up and exercised
end-to-end.

## Context

Revision 65 holds four failure classes — an expired Relay quote, an expired
Solana blockhash, a lost wallet lease, and a denied/unavailable external
signer — as `HELD_UNAVAILABLE` pending an owner decision, identically to
semantic-invalid requests such as a wrong-asset or wrong-recipient
transaction-policy refusal (see ADR-0024 for that unaffected class). Requiring
a person to decide every pre-effect lease loss, unavailable signer, expired
pre-sign quote, or definitively expired/unlanded Solana transaction reimposes
a manual stop for conditions that either had no effect yet or are merely
ambiguous, not wrong. This ADR proposes replacing that with three explicit
recovery classes and assigns each of the four revision-65 failures — split
into seven named cases, because the lease and signer cells each collapse a
provable pre-effect case and a genuinely different case into one tuple today
— to exactly one class.

A source review of the checked-in Keychain broker additionally finds that a
signer timeout cannot be treated as canonically reconcilable the way a
stalled provider mutation can: no signer
idempotency key, durable receipt, or authenticated read-by-key API exists
anywhere in this repository, and an unbroadcast local signature cannot be
discovered from chain state. Waiting for "canonical reconciliation" to
resolve a signer timeout, as an earlier draft of this ADR proposed, has no
defined resolution source and could wait forever. The narrower, executable
alternative below is scoped to the one signer implementation whose separation
between signing and broadcast the checked-in source actually proves.

## Decision

Every recovery path is assigned to exactly one of three classes:

- **Semantic-invalid**: the request itself is wrong. Terminal `HELD_*` state
  with an owner decision. Unaffected by this ADR (wrong-asset, wrong-recipient,
  cross-cycle attribution failure, conflicting canonical evidence,
  unattributed deposit, missing predecessor evidence, snapshot failure — the
  exhaustive list from ADR-0024).
- **Effect-ambiguous**: the external outcome cannot yet be distinguished.
  Observation-only until canonical evidence resolves it; no owner decision is
  requested while ambiguity remains unresolved, because a person has no more
  information than the automated reconciler does, and no automatic retry or
  new provider mutation is permitted either.
- **Proven-pre-effect-transient**: no external effect occurred, or a retry is
  safe by construction regardless of whether it occurred (see the sign-only
  case below). The identical approved intent may retry automatically once the
  blocking condition clears.

Proposed classification (`terminal=null` in every row; none of this is
canonical yet):

| Case | Class | Attempt | Proposed next action |
| --- | --- | --- | --- |
| Relay quote expired before any request/signature | proven-pre-effect-transient | none | `refresh-after-readmission` |
| Solana blockhash expired past its validity boundary | effect-ambiguous | `BROADCAST` | `reconcile-then-replace` |
| Wallet lease/fencing token lost **before** a provider-mutation capability boundary | proven-pre-effect-transient | `NOT_SENT` | `retry-same-request-under-new-lease` |
| Wallet lease/fencing token lost **after** a provider-mutation capability boundary | effect-ambiguous | `SENT_UNKNOWN` | `reconcile-before-retry` |
| Wallet lease/fencing token lost after a *signing* capability boundary | *(governed by the chain-attempt state machine, not this taxonomy — see below)* | `PREPARED`/`SIGNED`/`BROADCAST`/`REFUSED` | n/a |
| External signer denial provable before any signature could exist | proven-pre-effect-transient | `NOT_SENT` | `retry-after-signer-readiness` |
| Sign-only timeout, verified owned Keychain broker only | proven-pre-effect-transient (sign-only bounded retry) | `NOT_SENT` | `retry-sign-only-with-durable-binding` |

A lease lost after a *signing* capability boundary is not a new row in this
taxonomy at all: `REQ-cycle-repository-1` already gives a chain attempt its
own `PREPARED`/`SIGNED`/`BROADCAST`/`REFUSED` states, and that existing
contract — not `SENT_UNKNOWN` — is what resolves the ambiguity, because
`SENT_UNKNOWN` is a provider-mutation-attempt state, not a chain-attempt
state.

### Sign-only bounded retry (scoped narrowly)

Reviewer option 1 for the signer timeout (a durable idempotency key with an
authenticated read-by-key result from the signer) is rejected for this
revision: no external signer protocol in this repository exposes that today,
for the Keychain broker or for any other signer. Reviewer option 2 is adopted
instead, narrowed to exactly the contract the checked-in source proves for
the Keychain broker: `createKeychainSignerClient` sends only an explicit
`operation: "sign"` request
(`packages/adapters/src/signing/keychain-signer.mjs:171-243`); the helper
process refuses an `operation: "broadcast"` request outright
(`packages/adapters/bin/hookemon-keychain-signer.mjs:203-215`); the Solana
and EVM signing children accept `sign` only to deserialize/partial-sign or
call `account.signTransaction` and return bytes, with no broadcast operation
(`packages/adapters/src/signing/operations-wallet-keychain-child.mjs:138-206`,
`packages/adapters/src/signing/keychain-child-evm.mjs:133-197`); and the
policy wrapper reaches a supplied broadcast callback only in its own
`broadcast()` method, wired separately by each call site after `sign()`
returns (`packages/adapters/src/signing/signer-client.mjs:565-595`,
`packages/adapters/src/app/stages/purchase.mjs:99-117,329-338`). Given that
proof, a timeout on the broker's sign-only
operation may retry the identical signing attempt automatically, but only
when the exact unsigned wire bytes, signer role/account identity, request
digest, policy/authorization digest, and validity context were durably
persisted **before** that operation was first invoked. The retry reuses those
exact values unchanged — it never regenerates the provider transaction,
blockhash, nonce, memo, or policy under the retry's identity — and it never
asserts that the prior attempt failed to produce a signature. A signature
returned by either attempt is captured exactly once through the existing
signed-bytes recovery record (`recordSignedTransactionWithRecoveryContext`),
which already rejects materially different signing material. This makes the
retry safe by construction (a duplicate signature is deduplicated, and
broadcast remains a separate guarded capability the retry never reaches),
not by proving the timed-out attempt had no effect.

This guarantee does **not** extend to an opaque or external-module signer.
`packages/adapters/src/signing/external-module-signer.mjs:1-15` documents
that its imported module is operator-written code and that whatever it does
to produce a signature happens entirely inside that module, outside this
repository's control or knowledge; a universal claim that signing cannot
mutate a provider is unsupported for it. Its timeout keeps the existing
no-automatic-retry, terminal whole-cycle class: canonical chain observation
cannot recover or rule out an unbroadcast signature for a signer whose
internals are not provably sign-only. This revision does not extend
automatic sign-only retry to any other signer; a future signer with durable
read-by-operation authority or a separately proven sign-only, idempotent
contract can receive it only through a later owner-approved spec revision
bound to that exact signer contract, never by an implementation-time claim
of equivalence.

Neither the Solana nor the EVM signing path in this repository currently
promises deterministic or idempotent repeated signing, and Collector purchase
keeps its generated unsigned provider bytes only in process memory today, not
durably. This guarantee is therefore enabled only once focused evidence — a
conformance test exercising exactly this durable-preimage, identical-retry,
dedup-on-signature contract for the Keychain broker — proves it; until then
it is proposed, not implemented, and the frozen fallback in the canonical
matrix and the existing per-runbook "Recovery contract" remain what is
actually enforced.

Broadcast or provider-send ambiguity is never resolved by this retry: it
remains its own `SENT_UNKNOWN` (provider mutation) or chain-attempt
`BROADCAST`/`REFUSED` state (a durable chain journal entry), observation-only,
and is never retried as if it were an unsigned request.

The lease and signer rows each split what is a single matrix cell today
because a provable pre-effect case and a genuinely different case do not
share one safe recovery tuple: retrying automatically after a provider
capability boundary was reached risks a duplicate provider mutation, and
retrying a chain-level signing ambiguity as a plain provider "sign again"
under the wrong state machine risks the same.

Quote refresh happens at the policy/admission boundary, not as a stage-local
quote swap, and only after proving no signed or broadcast attempt exists for
the same claimed principal; a quote is never silently substituted once signed
bytes exist. Solana replacement happens only behind an authoritative
expired-and-unlanded resolution recorded against the old attempt, creates
exactly one linked replacement, and retains the original signed bytes and
signature forever. The signer-unavailable reason is durable, redacted, and
UI-visible after restart, distinct from the scheduler's current generic
`TICK_FAILED` outage-backoff reason.

## Alternatives

### Restore all four revision-65 whole-cycle holds unchanged

Rejected: reimposes a per-cycle manual stop for conditions that provably had
no effect or remain merely ambiguous, not wrong, conflicting with the goal of
unattended bounded recovery for the accepted launch target.

### Reuse ADR-0024's held-position carve-out for these four failures

Rejected: these are whole-cycle transaction/lifecycle safety conditions, not
card-level holds; the target for them is bounded automatic recovery of the
whole cycle's own attempt, not a supplementary per-card settlement path.

### Treat a signer timeout as canonically reconcilable (reviewer option 1) for every signer

Rejected: no signer in this repository, including the checked-in Keychain
broker, exposes a durable idempotency key or authenticated read-by-key
result. Declaring the timeout "observation-only until reconciliation" without
naming what resolves it could wait forever and fails unattended bounded
recovery. Reserved for a future revision if a signer contract adds that
authority.

### Grant the sign-only bounded retry to every external signer generically

Rejected: the proof that `sign()` cannot itself submit a transaction holds
only for the checked-in Keychain broker's specific implementation. An
opaque or external-module signer may embed code that submits during
`sign()`, so a blanket retry could double-submit. This revision scopes the
guarantee to that one verified broker contract only; extending it to any
other signer, even one that appears to have an equivalent contract, requires
a later owner-approved spec revision naming that exact contract, not an
inference drawn from this ADR or from implementation evidence alone.

## Consequences

`docs/audit/2026-09-04/failure-matrix.json` is unchanged by this ADR and
remains the currently deployed fallback contract for all four failure
classes regardless of this ADR's approval state. Six of the seven classified
cases are new-cell-eligible proposed rows and live in
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`
until each row has its runtime change and an exact passing test citation.
`docs/runbooks/relay-quote-expired.md`, `solana-blockhash-expiry.md`,
`lease-expiry-mid-mutation.md`, and `keychain-user-interaction.md` each carry
a "Proposed revision 66" section citing that draft file and this ADR; their
existing "Recovery contract" sections describe the currently deployed
fallback tuple, which is not necessarily what the same file's cited
low-level test proves in isolation — treat any gap between the two as
documented contract/evidence drift, not as proof of end-to-end enforcement
either way. No runtime, stage-driver, scheduler, or test change is made by
this ADR. Suggested disjoint implementation ownership after approval:
policy/admission plus quote-refresh repository transition; return/Solana
expired-attempt resolution and replacement; stage-driver lease boundary
classification and the durable pre-invocation binding the sign-only retry
requires; scheduler/status projection; then one serial
failure-matrix/runbook integration owner who promotes rows out of the draft
file one at a time as their tests pass.
