import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileLiveReturn} from '../../src/app/stages/return.mjs';
import {preparePayoutRequest} from '../../src/app/stages/payout.mjs';
import {createNativePayoutAmount} from '../../../runner/src/distribution/payout-plan.mjs';
import {digest as canonicalDigest} from '../../../runner/src/cycle/journal.mjs';
const EVM_ACCOUNT=`0x${'d'.repeat(40)}`, SOLANA_ACCOUNT='8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SOLANA_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', TOKEN=`0x${'a'.repeat(40)}`;
const EVM_CHAIN_ID='4663',SOLANA_CHAIN_ID='792703809',CANONICAL_CHAIN_ID='4663',CANONICAL_ASSET_ID='native',CANONICAL_KEY='4663\0native';
const PAYOUT_RECIPIENT_A=`0x${'2'.repeat(40)}`,PAYOUT_RECIPIENT_B=`0x${'3'.repeat(40)}`;
function testConfig() {
  const usdg = { chainId: EVM_CHAIN_ID, assetId: 'native', decimals: 18 };
  const solanaStablecoin = { chainId: SOLANA_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 };
  return {
    chainId: 4663,
    accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
    contracts: { usdg: TOKEN },
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v2',
      assets: { eth: usdg, solanaStablecoin },
      minimums: {
        robinhoodReceive: { ...usdg, amountAtomic: '0' },
        solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
        returnEth: { ...usdg, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { chainId: EVM_CHAIN_ID, assetId: 'native', decimals: 18, amountAtomic: '100' },
        nativeReserve: { chainId: EVM_CHAIN_ID, assetId: 'native', decimals: 18, amountAtomic: '1000' },
      },
      solana: {
        priorityFeeCap: { chainId: SOLANA_CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
        lamportReserve: { chainId: SOLANA_CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '1000' },
      },
    },
  };
}

function payoutManifest(cycleId) {
  const entries = [
    { recipient: PAYOUT_RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '2' } },
    { recipient: PAYOUT_RECIPIENT_B, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
  ];
  const total = entries.reduce((sum, entry) => sum + BigInt(entry.hkmnBalance.amountAtomic), 0n).toString();
  const estimatedNativeFee = (BigInt(entries.length) * 250_000n).toString();
  const requiredNativeAmount = (BigInt(estimatedNativeFee) + 10n).toString();
  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId,
    snapshotBlock: '12',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: total },
    entries,
    exclusions: [],
    feasibility: {
      recipientCount: entries.length,
      transactionCount: entries.length,
      maxRecipientCount: entries.length,
      maxTransactionCount: entries.length,
      measuredTransferGas: '50000',
      maxGasPriceWei: '5',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: estimatedNativeFee },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'c'.repeat(64)}`, logCount: entries.length },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    launchManifestDigest: `sha256:${'e'.repeat(64)}`,
  };
}

function payoutCycleRepositoryFor(cycleId, returnEvidence) {
  const manifest = payoutManifest(cycleId);
  return {
    async readStage(readCycleId, stage) {
      assert.equal(readCycleId, cycleId);
      if (stage === 'eligibility-snapshot') return { status: 'COMPLETE', evidence: manifest };
      if (stage === 'return') return { status: 'COMPLETE', evidence: returnEvidence };
      throw new Error(`unexpected stage ${stage}`);
    },
    async readPayoutDust() { return createNativePayoutAmount({ assetId: 'native', amountAtomic: '0' }); },
  };
}

/**
 * A synthetic SETTLED return leg that satisfies the preserved canonical custody association
 * (ADR-0026) by construction, so each refusal test below isolates exactly one of the new payout
 * -evidence guards -- cycle identity, finality, or destination asset identity -- rather than
 * re-exercising the pre-existing custody-association check.
 */
function syntheticSettledReturnRepository(legPatch) {
  const leg = {
    relayRequestId: 'relay-return-payout-evidence-synthetic',
    direction: 'return',
    cycleId: 'cycle-return-payout-evidence-synthetic',
    state: 'SETTLED',
    sourceTxHash: 'return-source-payout-evidence-synthetic',
    destinationChainId: EVM_CHAIN_ID,
    destinationAssetId: 'native',
    destinationDecimals: 18,
    destinationAmountAtomic: '20',
    netDeltaAtomic: '20',
    finalizedAtSource: { hash: 'solana-finality-hash', height: '5', timestampUnixSeconds: '1700000000' },
    finalizedAtDestination: { hash: `0x${'d'.repeat(64)}`, height: '50', timestampUnixSeconds: '2000000000' },
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent: { recipient: EVM_ACCOUNT },
    },
    ...legPatch,
  };
  const custodyLedgers = new Map([[CANONICAL_KEY, {
    schema: 'hookemon.custody-ledger.v3',
    chainId: CANONICAL_CHAIN_ID,
    assetId: CANONICAL_ASSET_ID,
    decimals: 18,
  }]]);
  const returnLegLedgerKeys = new Map([[leg.relayRequestId, CANONICAL_KEY]]);
  return {
    async describeCycle() {
      return { relayLegs: new Map([[leg.relayRequestId, leg]]), custodyLedgers, returnLegLedgerKeys, chainAttempts: new Map() };
    },
  };
}

test('a genuine zero-proceeds return evidence still binds real preparePayoutRequest to a zero credit', async () => {
  const cycleId = 'cycle-return-payout-evidence-zero';
  const zeroEvidence = Object.freeze({
    schema: 'hookemon.return-zero-proceeds-evidence.v2',
    cycleId,
    finalized: true,
    noBridge: true,
    destinationAccount: EVM_ACCOUNT,
    destinationAsset: 'native',
    destinationCreditAmount: '0',
  });

  const request = await preparePayoutRequest({
    config: testConfig(),
    cycleRepository: payoutCycleRepositoryFor(cycleId, zeroEvidence),
    context: { cycleId },
  });

  assert.equal(request.plan.returnEvidence.evidenceDigest, canonicalDigest({
    schema: 'hookemon.direct-payout-finalized-return.v2',
    cycleId,
    returnEvidence: zeroEvidence,
  }));
});

test('reconcileLiveReturn refuses a SETTLED leg missing finalized source or destination evidence', async () => {
  const cycleRepository = syntheticSettledReturnRepository({ finalizedAtDestination: null });
  await assert.rejects(
    () => reconcileLiveReturn({
      adapters: null,
      config: testConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-return-payout-evidence-synthetic' },
    }),
    /return leg is missing finalized source or destination evidence/,
  );
});

test('reconcileLiveReturn refuses a SETTLED leg whose cycleId does not match the reconciling cycle', async () => {
  const cycleRepository = syntheticSettledReturnRepository({ cycleId: 'cycle-return-payout-evidence-other' });
  await assert.rejects(
    () => reconcileLiveReturn({
      adapters: null,
      config: testConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-return-payout-evidence-synthetic' },
    }),
    /return leg cycleId does not match the reconciling cycle/,
  );
});

test('reconcileLiveReturn refuses a SETTLED leg whose destination asset does not match the configured native ETH identity', async () => {
  const cycleRepository = syntheticSettledReturnRepository({ destinationAssetId: `0x${'5'.repeat(40)}` });
  await assert.rejects(
    () => reconcileLiveReturn({
      adapters: null,
      config: testConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-return-payout-evidence-synthetic' },
    }),
    /return leg destination asset does not match the configured native ETH identity/,
  );
});

test('native settled return replay produces the identical immutable payout binding',async()=>{
 const cycleId='cycle-return-payout-evidence-synthetic';const repository=syntheticSettledReturnRepository({});
 const input={adapters:null,config:testConfig(),cycleRepository:repository,context:{cycleId}};
 const first=await reconcileLiveReturn(input),replay=await reconcileLiveReturn(input);
 assert.deepEqual(first,replay);assert.equal(first.destinationCreditAmount,'20');assert.equal(first.destinationAsset,'native');
 const request=await preparePayoutRequest({config:testConfig(),cycleRepository:payoutCycleRepositoryFor(cycleId,first),context:{cycleId}});
 assert.equal(request.plan.returnDelta.amountAtomic,'20');assert.equal(request.plan.returnDelta.decimals,18);
 assert.equal(request.plan.returnEvidence.evidenceDigest,canonicalDigest({schema:'hookemon.direct-payout-finalized-return.v2',cycleId,returnEvidence:first}));
});
test('historical USDG evidence cannot prepare a native payout',async()=>{
 const cycleId='historical-refusal';
 await assert.rejects(()=>preparePayoutRequest({config:testConfig(),cycleRepository:payoutCycleRepositoryFor(cycleId,{schema:'hookemon.return-zero-proceeds-evidence.v1',finalized:true,destinationAccount:EVM_ACCOUNT,destinationAsset:TOKEN,destinationCreditAmount:'0'}),context:{cycleId}}),/native ETH credit/);
});
