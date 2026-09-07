import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAIN_TRANSACTION_ATTEMPT_STATES,
  CUSTODY_LEDGER_BUCKETS,
  CYCLE_TERMINAL_STATES,
  MAXIMUM_PACK_BATCH_SIZE,
  OPERATIONAL_CYCLE_STAGES,
  PROVIDER_MUTATION_ATTEMPT_STATES,
  SIGN_ONLY_INVOCATION_LEDGER_SCHEMA,
  SIGN_ONLY_PRE_SIGN_BINDING_SCHEMA,
  assertChainTransactionAttempt,
  assertCustodyBalanceObservation,
  assertCustodyLedger,
  assertOperationIdentity,
  assertPackBatchRequest,
  assertPackBatchRequestEntry,
  assertPublicAmount,
  assertPublicCardEvent,
  assertSignOnlyInvocationLedger,
  assertSignOnlyPreSignBinding,
  toPublicAmount,
  assertTransactionPolicy,
  assertTypedAmount,
  assertProviderMutationAttempt,
  createPreparedChainTransactionAttempt,
  createReservedSignOnlyInvocationLedger,
  packOperationId,
  transitionChainTransactionAttempt,
  transitionProviderMutationAttempt,
  transitionSignOnlyInvocationLedger,
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
    heldPositions: '0',
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
    'returnReceived', 'refunds', 'residual', 'heldAssets', 'heldPositions', 'payoutLiability', 'dust', 'unattributed',
  ]);
  assert.throws(() => assertCustodyLedger({ ...ledger, unexpected: '0' }), /exact schema/);
  assert.throws(() => assertCustodyLedger({ ...ledger, dust: '-1' }), /dust/);
});

function custodyBalanceObservation(overrides = {}) {
  return {
    schema: 'hookemon.custody-balance-observation.v1',
    account: '0x2222222222222222222222222222222222222222',
    balance: amount({ chainId: 'eip155:4663', assetId: 'eip155:4663/erc20:stablecoin', decimals: 6, amountAtomic: '12300000000' }),
    finality: { height: '18000000', hash: `0x${'3'.repeat(64)}`, timestampUnixSeconds: '1780000000' },
    ...overrides,
  };
}

function custodyLedgerV2(overrides = {}) {
  return custodyLedger({
    schema: 'hookemon.custody-ledger.v2',
    verifiedCurrentBalance: null,
    expectedCycleAsset: null,
    ...overrides,
  });
}

test('validates CustodyBalanceObservationV1 and its byte-for-byte identity against a row', () => {
  const observation = custodyBalanceObservation();
  assert.deepEqual(assertCustodyBalanceObservation(observation), observation);
  assert.throws(() => assertCustodyBalanceObservation({ ...observation, unexpected: '0' }), /exact schema/);
  assert.throws(() => assertCustodyBalanceObservation({ ...observation, schema: 'hookemon.custody-balance-observation.v2' }), /schema/);
  assert.throws(() => assertCustodyBalanceObservation({ ...observation, account: '' }), /account/);
  assert.throws(() => assertCustodyBalanceObservation({ ...observation, finality: { ...observation.finality, hash: '' } }), /finality/);
});

test('hookemon.custody-ledger.v2 requires exactly twenty-one fields and canonical row identity', () => {
  const v2 = custodyLedgerV2();
  assert.deepEqual(assertCustodyLedger(v2), v2);
  assert.equal(Object.keys(assertCustodyLedger(v2)).length, 21);

  // Missing either new field is rejected -- exact field count, none fewer.
  const { verifiedCurrentBalance, ...missingBalance } = v2;
  assert.throws(() => assertCustodyLedger(missingBalance), /exact schema/);
  const { expectedCycleAsset, ...missingExpected } = v2;
  assert.throws(() => assertCustodyLedger(missingExpected), /exact schema/);

  // A third schema string, and a v1 row carrying a v2 field, are both rejected.
  assert.throws(() => assertCustodyLedger({ ...v2, schema: 'hookemon.custody-ledger.v3' }), /schema/);
  assert.throws(() => assertCustodyLedger({ ...custodyLedger(), verifiedCurrentBalance: null }), /exact schema/);

  // verifiedCurrentBalance.balance and expectedCycleAsset must equal the row's own identity exactly.
  const observation = custodyBalanceObservation();
  const valued = custodyLedgerV2({ verifiedCurrentBalance: observation });
  assert.deepEqual(assertCustodyLedger(valued), valued);
  assert.throws(
    () => assertCustodyLedger(custodyLedgerV2({ verifiedCurrentBalance: { ...observation, balance: { ...observation.balance, decimals: 18 } } })),
    /verifiedCurrentBalance/,
  );
  assert.throws(
    () => assertCustodyLedger(custodyLedgerV2({ verifiedCurrentBalance: { ...observation, balance: { ...observation.balance, chainId: 'eip155:1' } } })),
    /verifiedCurrentBalance/,
  );
  const expectation = amount({ chainId: 'eip155:4663', assetId: 'eip155:4663/erc20:stablecoin', decimals: 6, amountAtomic: '498000000' });
  assert.deepEqual(assertCustodyLedger(custodyLedgerV2({ expectedCycleAsset: expectation })).expectedCycleAsset, expectation);
  assert.throws(
    () => assertCustodyLedger(custodyLedgerV2({ expectedCycleAsset: { ...expectation, assetId: 'eip155:4663/erc20:other' } })),
    /expectedCycleAsset/,
  );
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

function signOnlyPreSignBindingFixture(overrides = {}) {
  return {
    schema: SIGN_ONLY_PRE_SIGN_BINDING_SCHEMA,
    cycleId: 'cycle-contract-1',
    stage: 'claim-process',
    requestDigest: DIGEST_A,
    role: 'operator-evm',
    account: 'hookemon-operator-primary',
    unsignedWireBytes: '{"to":"0x1"}',
    unsignedRequestDigest: DIGEST_B,
    policyDigest: DIGEST_A,
    validityContextDigest: DIGEST_B,
    ...overrides,
  };
}

test('assertSignOnlyPreSignBinding requires the exact ADR-0025 schema and every digest field', () => {
  const binding = signOnlyPreSignBindingFixture();
  assert.deepEqual(assertSignOnlyPreSignBinding(binding), binding);

  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, schema: 'wrong' }), /schema is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, stage: 'not-a-stage' }), /stage is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, requestDigest: 'not-a-digest' }), /requestDigest is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, role: '' }), /role is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, account: '' }), /account is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, unsignedWireBytes: '' }), /unsignedWireBytes is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, unsignedRequestDigest: 'nope' }), /unsignedRequestDigest is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, policyDigest: 'nope' }), /policyDigest is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, validityContextDigest: 'nope' }), /validityContextDigest is invalid/);
  assert.throws(() => assertSignOnlyPreSignBinding({ ...binding, extra: 'field' }), /exact schema/);
});

test('the sign-only invocation ledger only ever advances ORDINAL_1_ALLOCATED -> ORDINAL_1_TIMED_OUT -> ORDINAL_2_ALLOCATED -> ORDINAL_2_TIMED_OUT', () => {
  const ordinal1 = createReservedSignOnlyInvocationLedger({ cycleId: 'cycle-contract-1', stage: 'claim-process', requestDigest: DIGEST_A });
  assert.deepEqual(ordinal1, {
    schema: SIGN_ONLY_INVOCATION_LEDGER_SCHEMA,
    cycleId: 'cycle-contract-1',
    stage: 'claim-process',
    requestDigest: DIGEST_A,
    state: 'ORDINAL_1_ALLOCATED',
  });
  assert.deepEqual(assertSignOnlyInvocationLedger(ordinal1), ordinal1);

  const ordinal1TimedOut = transitionSignOnlyInvocationLedger(ordinal1, 'ORDINAL_1_TIMED_OUT');
  assert.equal(ordinal1TimedOut.state, 'ORDINAL_1_TIMED_OUT');
  const ordinal2 = transitionSignOnlyInvocationLedger(ordinal1TimedOut, 'ORDINAL_2_ALLOCATED');
  assert.equal(ordinal2.state, 'ORDINAL_2_ALLOCATED');
  const ordinal2TimedOut = transitionSignOnlyInvocationLedger(ordinal2, 'ORDINAL_2_TIMED_OUT');
  assert.equal(ordinal2TimedOut.state, 'ORDINAL_2_TIMED_OUT');

  // No transition skips a state, runs backwards, or continues past the terminal ordinal-2 outcome.
  assert.throws(() => transitionSignOnlyInvocationLedger(ordinal1, 'ORDINAL_2_ALLOCATED'), /transition is invalid/);
  assert.throws(() => transitionSignOnlyInvocationLedger(ordinal1, 'ORDINAL_2_TIMED_OUT'), /transition is invalid/);
  assert.throws(() => transitionSignOnlyInvocationLedger(ordinal1TimedOut, 'ORDINAL_1_ALLOCATED'), /transition is invalid/);
  assert.throws(() => transitionSignOnlyInvocationLedger(ordinal2TimedOut, 'ORDINAL_1_ALLOCATED'), /transition is invalid/);
  assert.throws(() => transitionSignOnlyInvocationLedger(ordinal2TimedOut, 'ORDINAL_2_ALLOCATED'), /transition is invalid/);

  assert.throws(() => assertSignOnlyInvocationLedger({ ...ordinal1, schema: 'wrong' }), /schema is invalid/);
  assert.throws(() => assertSignOnlyInvocationLedger({ ...ordinal1, state: 'BOGUS' }), /state is invalid/);
  assert.throws(() => assertSignOnlyInvocationLedger({ ...ordinal1, requestDigest: 'nope' }), /requestDigest is invalid/);
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

function packBatchEntry(overrides = {}) {
  return { packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: 'pokemon_25', ...overrides };
}

test('pack batch requests are bounded, index-ordered, and memo-unique', () => {
  const batch = [packBatchEntry(), packBatchEntry({ packIndex: 1, memo: 'memo-1' })];
  assert.deepEqual(assertPackBatchRequest(batch), batch);
  assert.throws(() => assertPackBatchRequest([]), /non-empty/);
  assert.throws(
    () => assertPackBatchRequest(Array.from({ length: MAXIMUM_PACK_BATCH_SIZE + 1 }, (_, index) => packBatchEntry({ packIndex: index, memo: `memo-${index}` }))),
    /at most/,
  );
  assert.throws(() => assertPackBatchRequest([packBatchEntry({ packIndex: 1 })]), /packIndex must equal/);
  assert.throws(
    () => assertPackBatchRequest([packBatchEntry(), packBatchEntry({ packIndex: 1, memo: 'memo-0' })]),
    /unique/,
  );
});

test('pack batch request entries accept the canonical pack-code grammar, hyphen and underscore alike', () => {
  for (const packType of ['return-fixture', 'pokemon_50']) {
    const entry = packBatchEntry({ packType });
    assert.deepEqual(assertPackBatchRequestEntry(entry), entry);
  }
});

test('pack batch request entries refuse a pack code outside the canonical grammar', () => {
  for (const packType of ['Pokemon_25', 'pokemon 25', '-pokemon25', '_pokemon25', 'pokemon/25', 'pokemon.25', 'p', 'p'.repeat(65)]) {
    assert.throws(
      () => assertPackBatchRequestEntry(packBatchEntry({ packType })),
      /packType is invalid/,
    );
  }
});

test('operation identity and public card events bind a stable per-pack identity', () => {
  const operationId = packOperationId('cycle-1', 2);
  assert.equal(operationId, 'pack:cycle-1:2');
  const identity = { cycleId: 'cycle-1', operationId, packIndex: 2, memo: 'memo-2', mint: null };
  assert.deepEqual(assertOperationIdentity(identity), identity);
  const event = {
    ...identity,
    eventId: 'sha256:'.padEnd(71, '0'),
    sequence: '1',
    state: 'PURCHASED',
    name: null,
    imageUrl: null,
    observedAt: '2026-09-06T00:00:00.000Z',
    finalizedAt: null,
    transactionId: null,
    proceeds: null,
  };
  assert.deepEqual(assertPublicCardEvent(event), event);
  assert.throws(() => assertPublicCardEvent({ ...event, state: 'UNKNOWN' }), /state is invalid/);
  assert.equal(packOperationId('cycle-1', 2), operationId);
});

test('the public Amount contract uses units, never amountAtomic, and toPublicAmount preserves full precision', () => {
  const internal = { chainId: 'solana-mainnet', assetId: 'mint', decimals: 6, amountAtomic: '900719925474099312345678' };
  const publicAmount = toPublicAmount(internal);
  assert.deepEqual(publicAmount, { chainId: 'solana-mainnet', assetId: 'mint', decimals: 6, units: '900719925474099312345678' });
  assert.equal(Object.hasOwn(publicAmount, 'amountAtomic'), false);
  assert.deepEqual(assertPublicAmount(publicAmount), publicAmount);
  assert.throws(() => assertPublicAmount(internal), /public amount.*is invalid|must use the exact schema/);
  assert.equal(toPublicAmount(null), null);

  const event = {
    cycleId: 'cycle-1', operationId: 'pack:cycle-1:0', packIndex: 0, memo: 'memo-0', mint: 'mint',
    eventId: `sha256:${'0'.repeat(64)}`, sequence: '1', state: 'SOLD', name: null, imageUrl: null,
    observedAt: '2026-09-06T00:00:00.000Z', finalizedAt: '2026-09-06T00:00:01.000Z', transactionId: 'sig',
    proceeds: publicAmount,
  };
  assert.deepEqual(assertPublicCardEvent(event), event);
  assert.throws(() => assertPublicCardEvent({ ...event, proceeds: internal }), /must use the exact schema/);
});
