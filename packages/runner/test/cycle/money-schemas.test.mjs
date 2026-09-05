import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAIN_TRANSACTION_ATTEMPT_STATES,
  CUSTODY_LEDGER_BUCKETS,
  CYCLE_TERMINAL_STATES,
  OPERATIONAL_CYCLE_STAGES,
  PROVIDER_MUTATION_ATTEMPT_STATES,
  assertChainTransactionAttempt,
  assertCustodyLedger,
  assertTransactionPolicy,
  assertTypedAmount,
  assertProviderMutationAttempt,
  createPreparedChainTransactionAttempt,
  transitionChainTransactionAttempt,
  transitionProviderMutationAttempt,
  RELAY_LEG_STATES,
  RELAY_LEG_TERMINAL_STATES,
  assertMoneyConfiguration,
  assertRelayLeg,
  assertReturnLegDestinationProof,
  assertStandingAuthorityDecision,
  assertWalletNonceReservation,
  attributeRelayLegSource,
  createRecordedRelayLeg,
  transitionRelayLeg,
} from '../../src/cycle/money-schemas.mjs';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;

function amount(overrides = {}) {
  return {
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:stablecoin',
    decimals: 6,
    amountAtomic: '1234567',
    ...overrides,
  };
}

function custodyLedger(overrides = {}) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId: 'cycle-contract-1',
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:stablecoin',
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
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
    ...overrides,
  };
}

test('freezes the operational stage sequence and terminal states', () => {
  assert.deepEqual(OPERATIONAL_CYCLE_STAGES, [
    'eligibility-snapshot',
    'claim-process',
    'outbound',
    'purchase',
    'open',
    'epic-gate',
    'buyback',
    'return',
    'payout',
  ]);
  assert.deepEqual(PROVIDER_MUTATION_ATTEMPT_STATES, ['PREPARED', 'NOT_SENT', 'SENT_UNKNOWN', 'RESPONSE_RECORDED', 'RECONCILED']);
  assert.deepEqual(CHAIN_TRANSACTION_ATTEMPT_STATES, ['PREPARED', 'SIGNED', 'BROADCAST', 'FINALIZED']);
  assert.ok(CYCLE_TERMINAL_STATES.includes('HELD_DATA_UNVERIFIED'));
  assert.ok(CYCLE_TERMINAL_STATES.includes('HELD_UNAVAILABLE'));
  assert.ok(CYCLE_TERMINAL_STATES.includes('HELD_OWNER_DECISION'));
});

test('validates atomic amounts and a per-cycle custody ledger with every required bucket', () => {
  assert.deepEqual(assertTypedAmount(amount()), amount());
  assert.throws(() => assertTypedAmount(amount({ amountAtomic: '01' })), /amountAtomic/);
  assert.throws(() => assertTypedAmount(amount({ decimals: '6' })), /decimals/);

  const ledger = custodyLedger({ claimed: '100', payoutLiability: '100' });
  assert.deepEqual(assertCustodyLedger(ledger), ledger);
  assert.deepEqual(CUSTODY_LEDGER_BUCKETS, [
    'claimed', 'bridgeOut', 'bridgeIn', 'packCost', 'buybackProceeds', 'returnInput',
    'returnReceived', 'refunds', 'residual', 'heldAssets', 'payoutLiability', 'dust', 'unattributed',
  ]);
  assert.throws(() => assertCustodyLedger({ ...ledger, unexpected: '0' }), /exact schema/);
  assert.throws(() => assertCustodyLedger({ ...ledger, dust: '-1' }), /dust/);
});

test('allows provider attempts to advance only through the write-ahead state machine', () => {
  const prepared = {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId: 'cycle-contract-1',
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: DIGEST_A,
    responseDigest: null,
    reconciliationDigest: null,
  };
  assert.deepEqual(assertProviderMutationAttempt(prepared), prepared);

  const notSent = transitionProviderMutationAttempt(prepared, 'NOT_SENT');
  assert.equal(notSent.state, 'NOT_SENT');
  assert.deepEqual(transitionProviderMutationAttempt(notSent, 'PREPARED'), prepared);

  const unknown = transitionProviderMutationAttempt(prepared, 'SENT_UNKNOWN');
  assert.equal(unknown.state, 'SENT_UNKNOWN');
  const recorded = transitionProviderMutationAttempt(unknown, 'RESPONSE_RECORDED', { responseDigest: DIGEST_B });
  const reconciled = transitionProviderMutationAttempt(recorded, 'RECONCILED', { reconciliationDigest: DIGEST_C });
  assert.equal(reconciled.state, 'RECONCILED');
  assert.throws(() => transitionProviderMutationAttempt(prepared, 'RECONCILED', { reconciliationDigest: DIGEST_C }), /transition/);
});

test('requires signed chain material before broadcast and never permits substitution after signing', () => {
  const prepared = createPreparedChainTransactionAttempt({
    cycleId: 'cycle-contract-1',
    stage: 'claim-process',
    requestDigest: DIGEST_A,
  });
  assert.deepEqual(assertChainTransactionAttempt(prepared), prepared);

  const signed = transitionChainTransactionAttempt(prepared, 'SIGNED', {
    rawBytes: '0xabcdef',
    nonce: '8',
    blockhash: null,
    hash: '0xdeadbeef',
  });
  const broadcast = transitionChainTransactionAttempt(signed, 'BROADCAST');
  const finalized = transitionChainTransactionAttempt(broadcast, 'FINALIZED');
  assert.equal(finalized.state, 'FINALIZED');
  assert.throws(() => transitionChainTransactionAttempt(prepared, 'BROADCAST'), /transition/);
  assert.throws(
    () => transitionChainTransactionAttempt(signed, 'BROADCAST', { rawBytes: '0x010203' }),
    /evidence/,
  );
  assert.throws(
    () => transitionChainTransactionAttempt(prepared, 'SIGNED', {
      rawBytes: '0xabcdef', nonce: null, blockhash: null, hash: '0xdeadbeef',
    }),
    /requires exactly one nonce or blockhash/,
  );
});

test('freezes a transaction policy against a typed amount and one expected recipient', () => {
  const policy = {
    schema: 'hookemon.transaction-policy.v1',
    chainId: 'eip155:4663',
    stage: 'claim-process',
    requestDigest: DIGEST_A,
    expectedRecipient: '0x0000000000000000000000000000000000000001',
    amount: amount(),
    allowedTargets: ['0x0000000000000000000000000000000000000002'],
    allowedPrograms: [],
  };
  assert.deepEqual(assertTransactionPolicy(policy), policy);
  assert.throws(() => assertTransactionPolicy({ ...policy, amount: amount({ chainId: 'solana:mainnet' }) }), /amount chainId/);
});

test('names the four Relay-leg holds as cycle terminal states', () => {
  for (const state of ['HELD_RELAY_PARTIAL', 'HELD_RELAY_REFUND', 'HELD_RELAY_LATE', 'HELD_RELAY_WRONG_ASSET']) {
    assert.ok(CYCLE_TERMINAL_STATES.includes(state), state);
    assert.ok(RELAY_LEG_TERMINAL_STATES.includes(state), state);
  }
  assert.deepEqual(RELAY_LEG_STATES, ['RECORDED', 'SETTLED', ...RELAY_LEG_TERMINAL_STATES]);
});

function relayLegInput(overrides = {}) {
  return {
    cycleId: 'cycle-relay-1',
    direction: 'outbound',
    relayRequestId: `0x${'1'.repeat(64)}`,
    quoteDigest: DIGEST_A,
    source: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '25000000' },
    destination: { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic: '24694978' },
    ...overrides,
  };
}

test('a recorded Relay leg carries every frozen field and settles only with both finalized deltas', () => {
  const leg = createRecordedRelayLeg(relayLegInput());
  assert.equal(leg.schema, 'hookemon.relay-leg.v1');
  assert.equal(leg.state, 'RECORDED');
  assert.deepEqual(Object.keys(leg).sort(), [
    'cycleId', 'destinationAmountAtomic', 'destinationAssetId', 'destinationChainId', 'destinationDecimals', 'destinationTxHash',
    'direction', 'finalizedAtDestination', 'finalizedAtSource', 'netDeltaAtomic', 'quoteDigest', 'relayRequestId', 'schema',
    'sourceAmountAtomic', 'sourceAssetId', 'sourceChainId', 'sourceDecimals', 'sourceTxHash', 'state',
  ]);
  assert.deepEqual(assertRelayLeg(leg), leg);
  assert.throws(() => createRecordedRelayLeg(relayLegInput({ direction: 'sideways' })), /direction/);
  assert.throws(() => createRecordedRelayLeg(relayLegInput({ source: { ...relayLegInput().source, amountAtomic: '0' } })), /positive/);

  const finality = { height: '100', hash: `0x${'b'.repeat(64)}`, timestampUnixSeconds: '1788963000' };
  const sourceAttributed = attributeRelayLegSource(leg, { sourceTxHash: `0x${'c'.repeat(64)}` });
  assert.equal(sourceAttributed.state, 'RECORDED');
  assert.throws(() => attributeRelayLegSource(sourceAttributed, { sourceTxHash: `0x${'d'.repeat(64)}` }), /already/);
  assert.throws(
    () => transitionRelayLeg(sourceAttributed, 'SETTLED', { finalizedAtSource: finality, destinationTxHash: 'sig', finalizedAtDestination: null, netDeltaAtomic: '24694978' }),
    /finalizedAtDestination/,
  );
  const settled = transitionRelayLeg(sourceAttributed, 'SETTLED', {
    finalizedAtSource: finality,
    destinationTxHash: 'destination-signature',
    finalizedAtDestination: { height: '250', hash: 'slot-hash', timestampUnixSeconds: '1788963100' },
    netDeltaAtomic: '24694978',
  });
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.netDeltaAtomic, '24694978');
  assert.throws(() => transitionRelayLeg(settled, 'HELD_RELAY_LATE', {}), /transition/);

  const held = transitionRelayLeg(sourceAttributed, 'HELD_RELAY_PARTIAL', {
    finalizedAtSource: finality,
    destinationTxHash: 'destination-signature',
    finalizedAtDestination: { height: '250', hash: 'slot-hash', timestampUnixSeconds: '1788963100' },
    netDeltaAtomic: '5',
  });
  assert.equal(held.state, 'HELD_RELAY_PARTIAL');
  const refunded = transitionRelayLeg(sourceAttributed, 'HELD_RELAY_REFUND', {
    finalizedAtSource: finality,
    destinationTxHash: 'refund-signature',
    finalizedAtDestination: { height: '251', hash: 'refund-slot-hash', timestampUnixSeconds: '1788963200' },
    netDeltaAtomic: '-1',
  });
  assert.equal(refunded.netDeltaAtomic, '-1');
  assert.throws(
    () => transitionRelayLeg(leg, 'HELD_RELAY_REFUND', { finalizedAtSource: finality, destinationTxHash: null, finalizedAtDestination: null, netDeltaAtomic: null }),
    /sourceTxHash/,
  );
  assert.throws(
    () => transitionRelayLeg(sourceAttributed, 'SETTLED', {
      finalizedAtSource: finality, destinationTxHash: 'x', finalizedAtDestination: finality, netDeltaAtomic: '0',
    }),
    /netDeltaAtomic/,
  );
  assert.throws(
    () => transitionRelayLeg(sourceAttributed, 'SETTLED', {
      finalizedAtSource: finality, destinationTxHash: 'x', finalizedAtDestination: finality, netDeltaAtomic: '-1',
    }),
    /positive/,
  );
});

test('a return Relay leg persists its request window and accepts only a terminal-status receipt proof', () => {
  const returnIntent = {
    schema: 'hookemon.relay-intent.v1',
    requestId: 'relay-return-proof-1',
    orderId: `0x${'e'.repeat(64)}`,
    direction: 'RETURN',
    originChainId: 792703809,
    destinationChainId: 4663,
    originAssetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    originDecimals: 6,
    destinationAssetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    destinationDecimals: 6,
    originAmount: '17',
    quotedDestinationAmount: '16',
    quotedDestinationMinimumAmount: '16',
    sender: '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto',
    recipient: '0x000000000000000000000000000000000000dead',
    deadlineUnixSeconds: 1_800_000_000,
  };
  const leg = createRecordedRelayLeg({
    cycleId: 'cycle-return-proof-1',
    direction: 'return',
    relayRequestId: returnIntent.requestId,
    quoteDigest: DIGEST_A,
    source: { chainId: '792703809', assetId: returnIntent.originAssetId, decimals: 6, amountAtomic: '17' },
    destination: { chainId: '4663', assetId: returnIntent.destinationAssetId, decimals: 6, amountAtomic: '16' },
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent: returnIntent,
      requestCreatedAtUnixSeconds: '1700000000',
      maxSettlementWindowSeconds: '600',
    },
  });
  assert.equal(leg.returnAttribution.intent.requestId, returnIntent.requestId);
  assert.throws(
    () => createRecordedRelayLeg({
      cycleId: 'cycle-return-proof-mismatched-intent',
      direction: 'return',
      relayRequestId: returnIntent.requestId,
      quoteDigest: DIGEST_A,
      source: { chainId: '792703809', assetId: returnIntent.originAssetId, decimals: 6, amountAtomic: '18' },
      destination: { chainId: '4663', assetId: returnIntent.destinationAssetId, decimals: 6, amountAtomic: '16' },
      returnAttribution: {
        schema: 'hookemon.return-leg-attribution-context.v1',
        intent: returnIntent,
        requestCreatedAtUnixSeconds: '1700000000',
        maxSettlementWindowSeconds: '600',
      },
    }),
    /origin.*amount|intent.*source/i,
  );

  const proof = {
    schema: 'hookemon.return-leg-destination-proof.v1',
    relayRequestId: returnIntent.requestId,
    terminalStatus: { status: 'SUCCESS', destinationTxHash: `0x${'a'.repeat(64)}` },
    sourceTxHash: 'return-source-signature',
    sourceFinality: { height: '52', hash: 'source-slot-hash', timestampUnixSeconds: '1700000010' },
    destinationTxHash: `0x${'a'.repeat(64)}`,
    destinationFinality: { height: '100', hash: `0x${'b'.repeat(64)}`, timestampUnixSeconds: '1700000020' },
    transferCount: 1,
    observedToken: returnIntent.destinationAssetId,
    observedRecipient: returnIntent.recipient,
    observedAmountAtomic: '16',
  };
  assert.deepEqual(assertReturnLegDestinationProof(proof), proof);
  assert.throws(
    () => assertReturnLegDestinationProof({ ...proof, terminalStatus: { status: 'PENDING', destinationTxHash: proof.destinationTxHash } }),
    /terminalStatus/,
  );
});

test('a standing-authority decision binds its digests and both reservations exactly', () => {
  const decision = {
    schema: 'hookemon.standing-authority-decision.v1',
    authorityDigest: DIGEST_A,
    verifiedAt: '2026-09-05T10:00:00.000Z',
    intentDigest: DIGEST_B,
    dayCapReservation: { day: '2026-09-05', reservationKey: DIGEST_C },
    nonceReservation: { nonce: 'cycle-1-outbound-nonce', reservationKey: `sha256:${'d'.repeat(64)}` },
  };
  assert.deepEqual(assertStandingAuthorityDecision(decision), decision);
  assert.throws(() => assertStandingAuthorityDecision({ ...decision, verifiedAt: 'yesterday' }), /verifiedAt/);
  assert.throws(() => assertStandingAuthorityDecision({ ...decision, dayCapReservation: { day: '2026-09-06', reservationKey: DIGEST_C } }), /day/);
  assert.throws(() => assertStandingAuthorityDecision({ ...decision, extra: true }), /exact schema/);
});

test('a wallet nonce reservation names one wallet, one cycle, one stage, and one fence', () => {
  const reservation = {
    schema: 'hookemon.wallet-nonce-reservation.v1',
    chainId: '4663',
    wallet: `0x${'a'.repeat(40)}`,
    cycleId: 'cycle-lock-1',
    stage: 'outbound',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    leaseAcquiredAtMs: 1_700_000_000_000,
    leaseExpiresAtMs: 1_700_000_060_000,
    state: 'HELD',
  };
  assert.deepEqual(assertWalletNonceReservation(reservation), reservation);
  assert.throws(() => assertWalletNonceReservation({ ...reservation, stage: 'funding' }), /stage/);
  assert.throws(() => assertWalletNonceReservation({ ...reservation, leaseExpiresAtMs: reservation.leaseAcquiredAtMs }), /leaseExpiresAtMs/);
  assert.throws(() => assertWalletNonceReservation({ ...reservation, state: 'PENDING' }), /state/);
});

function moneyConfiguration(overrides = {}) {
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
  const solana = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin: solana },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...solana, amountAtomic: '0' },
      returnUsdg: { ...usdg, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2000000000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '50000000000000000' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '50000' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '20000000' },
    },
    ...overrides,
  };
}

test('money configuration is explicit typed amounts; a literal 1 or a missing cap is a configuration error', () => {
  const configuration = moneyConfiguration();
  assert.deepEqual(assertMoneyConfiguration(configuration), configuration);
  assert.throws(
    () => assertMoneyConfiguration(moneyConfiguration({ minimums: { ...configuration.minimums, returnUsdg: { ...configuration.minimums.returnUsdg, amountAtomic: '1' } } })),
    /placeholder/,
  );
  assert.throws(
    () => assertMoneyConfiguration(moneyConfiguration({ minimums: { ...configuration.minimums, returnUsdg: { ...configuration.minimums.returnUsdg, amountAtomic: '2' } } })),
    /returnUsdg.*zero/,
  );
  assert.throws(
    () => assertMoneyConfiguration(moneyConfiguration({ evm: { perTransactionGasPriceCap: configuration.evm.perTransactionGasPriceCap } })),
    /nativeReserve/,
  );
  assert.throws(
    () => assertMoneyConfiguration(moneyConfiguration({ solana: { ...configuration.solana, priorityFeeCap: { ...configuration.solana.priorityFeeCap, amountAtomic: '1' } } })),
    /placeholder/,
  );
  assert.throws(
    () => assertMoneyConfiguration(moneyConfiguration({ minimums: { ...configuration.minimums, solanaReceive: { ...configuration.minimums.solanaReceive, assetId: 'different-solana-stablecoin-mint' } } })),
    /solanaReceive/,
  );
  assert.throws(
    () => assertMoneyConfiguration(moneyConfiguration({ evm: { ...configuration.evm, nativeReserve: { ...configuration.evm.nativeReserve, chainId: '1' } } })),
    /nativeReserve/,
  );
});
