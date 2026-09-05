# Hook Contract Client

## Purpose

The hook-contract-client module builds typed reads and calldata for the immutable Phase 3 hook interfaces. It translates verified repository intents into constrained contract requests without signing, broadcasting, or deciding policy.

## Public interface

- It reads process claim capacity, claim state, pause state, Operations rotation state, and immutable hook configuration.
- `buildClaimProcessCall(hook, cycleId, amountAtomicUsdg, destination)` encodes
  `claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)` from typed
  values; it neither signs nor broadcasts the candidate transaction.
- The claim stage journals the resulting EIP-1559 transaction as `PREPARED → SIGNED → BROADCAST
  → FINALIZED`. Before finality it checks the persisted transaction hash, Operations sender, hook
  target, exact calldata, zero native value, one matching `ProcessClaimed` event, and one exact
  USDG transfer from the hook to Operations.
- It reads launch and custody postconditions, including the one-time launch stamp and permanent position binding.
- It rejects unsupported generic calls, arbitrary destinations, and untyped amount values.

## Invariants

- `claimProcess` rejects a zero cycle identifier or nonpositive amount and preserves the exact
  nonzero cycle identifier, positive atomic USDG amount, and Operations-self destination from the
  repository intent.
- The client does not expose an external initialization call; hook-self initialization is valid only inside the authorized atomic launch leg.
- The client treats the before-initialize permission mask `0x20CC` and permanent custody surface as immutable interface facts.
- Calldata is only a candidate until transaction-policy, policy-engine, external signing, and finality checks complete.
- A claim receipt is final only when its receipt block hash equals the canonical block hash at that
  height. A matching block number alone is not canonical-chain evidence.

## State transitions

- A verified repository intent becomes typed calldata after all local shape checks pass.
- Typed calldata becomes a prepared chain attempt after the repository records its stable request
  digest. The nonce and fee candidate is then decoded and accepted by transaction-policy before a
  signer sees it.
- The approved transaction becomes signed bytes, then a broadcast record, and only then finalized
  claim evidence after canonical receipt, event, and USDG-transfer checks pass. The stage records
  the typed EVM USDG `claimed` custody ledger before its finality record, so policy exposure cannot
  omit a finalized Operations credit.
- A rejected shape or mismatch produces no provider request, signature request, or hook mutation.

## Operational commands

- Generate calldata from repository records and compare it with the policy-approved decoded transaction.
- Query hook state before preparing a process claim or launch transition.
- Keep ABI, runtime hash, and chain configuration pinned to the verified deployment manifest.

## Recovery pointers

- Rebuild calldata from the stored intent after a restart; do not hand-edit a destination, amount,
  or cycle identifier. Re-broadcast only the exact signed raw bytes retained by the
  CycleRepository chain-attempt journal.
- Reject an ABI or runtime-hash mismatch and return to provider-binding evidence.
- Preserve an unresolved signed request in CycleRepository rather than issuing a fresh claim call.
  Reject a receipt that lacks the exact event, transfer, canonical block hash, or semantic
  transaction binding.
