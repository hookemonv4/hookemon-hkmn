# Role Control

## Purpose

Role control defines the bounded Treasury and Operations authorities for the Phase 3 money path. Operations controls its EVM and Solana signing identities and may custody only its earned 2.4 percent process share; Treasury controls the constrained claim safeguards. This card covers `REQ-role-control-1` through `REQ-role-control-4` and `REQ-operations-wallet-1` through `REQ-operations-wallet-3`.

## Public interface

`packages/contracts/src/access/MoneyRoles.sol` defines the role handovers and beneficiary authorization, and `packages/contracts/src/HookemonHook.sol` exposes the role-gated process-claim controls.

- Treasury and Operations retain explicit successor handovers for future authority. An ordinary Operations proposal and acceptance are unavailable while a Treasury-scheduled Operations rotation is pending.
- Treasury alone may call `setProcessClaimLimit(uint256)`, `pauseProcessClaims()`, and `unpauseProcessClaims()`. A decrease or zero applies immediately, an increase no greater than immutable `processClaimLimitMax` activates after 21,600 seconds (six hours), and claims cannot resume while an Operations rotation is pending.
- Treasury alone may call `scheduleOperationsRotation(address)` and `executeOperationsRotation()`.
  Scheduling and execution auto-pause process claims; the immutable constructor delay is 43200
  seconds. Scheduling clears an ordinary Operations proposal and freezes ordinary Operations
  handover. Operations cannot cancel, replace, propose, or accept an ordinary handover while a
  rotation is pending; only a new explicit Treasury emergency-rotation intent may supersede it
  with a fresh delay.
- Operations may request a bounded process claim only through `claimProcess(bytes32 cycleId,uint256 amountAtomicUsdg,address destination)` with `destination == msg.sender`.
- `remainingProcessClaimCapacity()`, `activeProcessClaimLimit()`, and `scheduledOperationsRotation()` expose the current bounded-claim and pending-rotation state. Constructor fields `processClaimLimit6h`, `processClaimLimitMax`, `processClaimMaxCount`, and `operationsRotationDelay` configure the initial native cap, immutable native maximum, active-entry count hard-capped at 64, and immutable 43200-second rotation delay.
- Programmable and Treasury beneficiaries select a nonzero destination for their own claims; the exact transfer target is recorded.

## Invariants

- Only the current Operations identity can claim its process share, and only to itself. It has no authority over another liability class.
- Every beneficiary claim is caller-bound. Programmable and Treasury beneficiaries may select any nonzero transfer destination; a historical Treasury beneficiary retains only its accrued liability.
- A process claim counts against capacity exactly while `block.timestamp - claimedAt < 21,600`; an entry at equality is expired. Active entries are bounded by `processClaimMaxCount`, which is at most 64.
- Process-claim history, consumed capacity, and permanently used cycle identifiers survive every handover, limit change, pause, and Operations rotation.
- An emergency rotation cannot become active before its immutable 43200-second delay, cannot be
  cancelled by Operations, clears any ordinary Operations proposal, prevents ordinary Operations
  handover while pending, and never silently resumes process claims.
- No role can alter the fee split, clear a remainder, erase history, redirect another beneficiary's liability, or grant a generic call, approval, withdrawal, rescue, upgrade, or delegatecall authority.

The selected assisted launch configures `processClaimMaxCount=24`, initial six-hour cap `9960873688152935270` wei and immutable maximum `19921747376305870540` wei. These ETH contract limits remain separate from the dynamic bot-side rolling six-hour budget of $25,000, adjustable up to $50,000. No onchain USD oracle or automatic Treasury-to-Operations refill exists.

## State transitions

- A valid ordinary proposal changes only the future active role when the named successor accepts.
  No ordinary Operations proposal, acceptance, replacement, or cancellation is valid while an
  emergency rotation is pending.
- Treasury may apply a decrease or zero cap immediately; either action clears a still-pending increase. A valid increase becomes active only after 21,600 seconds (six hours).
- Emergency rotation moves from scheduled to executable after 43200 seconds, then changes
  Operations while leaving claims paused and history intact. Only a new Treasury emergency intent
  may replace a pending rotation and starts a new delay.
- Treasury cannot unpause process claims while an emergency Operations rotation is pending.
- Invalid caller, zero destination, stale proposal, Operations cancellation, early activation,
  over-`Xmax` limit, count above 64, or history reset attempt leaves role and claim state unchanged.

## Operational commands

```sh
forge test --root packages/contracts --match-path test/access/MoneyRoles.t.sol -vv
forge test --root packages/contracts --match-path test/access/ProcessClaims.t.sol -vv
FOUNDRY_PROFILE=launch forge test --root packages/contracts --match-path test/access/ProcessClaims.t.sol -vv
```

The suites cover the full caller matrix, the 21,600-second equality boundary, bounded active entries, immediate decreases, delayed increases, strict delayed rotation, automatic pauses, stale-rotation rejection, frozen historical claims, permanent cycle replay protection, and preservation of usage across every role transition.

The delayed-limit regression snapshots time with `vm.getBlockTimestamp()` and checks the exact pre-activation and activation timestamps under the launch compiler profile. Foundry time travel must not depend on the compiler treating `block.timestamp` as constant within a test transaction.

## Recovery pointers

- Pause process claims before resolving a compromised Operations identity.
- Use the scheduled rotation path for future authority and preserve all claim and liability history.
- Do not restore access by clearing usage, replacing a beneficiary record, or adding unrestricted administrator authority.
