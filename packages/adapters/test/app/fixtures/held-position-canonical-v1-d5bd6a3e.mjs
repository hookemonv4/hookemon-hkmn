// Provenance: this fixture is the exact `held-position-recorded` event payload the real
// `CycleRepository` produced at pinned base commit d5bd6a3e (the commit BOT-HELD-CUSTODY's canonical
// identity fix built on), captured once and committed verbatim -- never a reimplemented digest.
//
// Generation method (not run by any test; a one-time capture reproducible from git history):
//   1. `git show d5bd6a3e:packages/adapters/src/app/cycle-repository.mjs` was written to a temp
//      sibling module under `src/app/` (so its relative imports resolved against the otherwise
//      -unaffected dependency tree) and dynamically imported to get that commit's real
//      `CycleRepository` class.
//   2. `createCycle({ releaseAmount: '1', mode: 'production', cycleId: 'fixture-held-canonical-v1-d5bd6a3e' })`
//      then `recordHeldPosition(cycleId, { ..., ledgerAsset: { chainId: 'eip155:4663', assetId:
//      'eip155:4663/erc20:0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 } })` were called
//      against that pinned-base repository -- at that commit, `heldPositionCustodyLedger` had no
//      identity-aware branching at all, so an absent row always became `hookemon.custody-ledger.v1`
//      regardless of the identity's shape, which is exactly the historical shape under test here: a
//      v1 row at what is now the recognized canonical EVM USDG identity.
//   3. `DurableCycleStore.open(directory).readCycle(cycleId).entries` was read back and the
//      `held-position-recorded` entry's `payload` ({evidence, ledger, position}) below is its exact,
//      unedited JSON -- the `digest`/`index`/`previousDigest` envelope fields are not reproduced
//      here because a real append recomputes those for wherever the event is chained into (this
//      fixture is replayed via `CycleJournal.propose`, the same primitive every other raw-injection
//      test in cycle-repository.test.mjs already uses, never a hand-built digest).
//
// If this exact base commit is ever pruned from history, this file remains the durable evidence of
// its historical output; it does not need to be regenerated.

export const HELD_POSITION_CANONICAL_V1_FIXTURE = Object.freeze({
  evidence: Object.freeze({
    stage: 'buyback',
    status: 'sent-unknown',
  }),
  ledger: Object.freeze({
    schema: 'hookemon.custody-ledger.v1',
    cycleId: 'fixture-held-canonical-v1-d5bd6a3e',
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    decimals: 6,
    claimed: '0',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    heldPositions: '17',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  }),
  position: Object.freeze({
    positionId: 'held:e32400e7508a165bb103383beba6eca0215b705dd7a97ccfe09ca34711d53b50',
    cycleId: 'fixture-held-canonical-v1-d5bd6a3e',
    packId: 'pack-1',
    memo: 'memo-1',
    mint: 'mint-1',
    cardRef: 'mint-1',
    costMicroUsdg: '17',
    valueMicroUsdg: '17',
    insuredValue: null,
    reason: 'SENT_UNKNOWN_DEADLINE',
    terminalState: 'HELD_UNRESOLVED',
    evidenceDigest: 'sha256:db3efd4c63dcc7068951ed8f78ca1c5213d047452f25ce5f1a87e2ba93816485',
    openedAtMs: 1_700_000_000_000,
    positionRevision: 0,
    ownerDecision: null,
    resolution: null,
  }),
});
