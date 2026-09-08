import { readReleaseBoundRelaySourceDebit } from '../../native-payment-proof.mjs';
import { createQuoteUsdValuation, readProcessQuoteUsdProvenance } from '../../relay-client.mjs';
import { digest as canonicalDigest } from '../../../../runner/src/cycle/journal.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import { assertQuoteUsable, DIRECTIONS, RELAY_CONSTANTS } from '../../relay-client.mjs';
import {
  buildRelayLegacyTransaction,
  readBlockHeight,
  readUsableLatestBlockhash,
  signedSolanaTransactionSignature,
} from '../../solana-rpc.mjs';
import { readTransactionPolicyApprovalContext, recoverTransactionPolicyBroadcast } from '../../signing/signer-client.mjs';
import {
  advanceDirectPayout,
  createDirectPayoutState,
  evaluateDirectPayoutNativeGasAdmission,
  isDirectPayoutComplete,
} from './payout.mjs';
import {
  assertReturnBoundaryEvidence,
  assertSettlement,
  createSupplementaryPayoutStore,
  prepareSupplementaryPayoutRequest,
  SUPPLEMENTARY_FINALIZED_RETURN_SCHEMA,
  SUPPLEMENTARY_RETURN_BOUNDARY_SCHEMA,
} from './supplementary-payout.mjs';
import {
  assertReturnBroadcastHash,
  assertReturnConfiguration,
  assertReturnLamportReserve,
  assertReturnMoneyConfiguration,
  assertReturnQuote,
  canonicalPositiveInteger,
  createReturnPolicySigner,
  extractRelaySolanaInstructionPlan,
  readReturnLegDestinationProof,
  isProcessRpcReturnLegDestinationProof,
  returnPolicyRecoveryContext,
  returnRecoveryContext,
  typedAmount,
} from './return.mjs';

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;
// The canonical transaction policy's `stage` field is validated against runner-owned
// OPERATIONAL_CYCLE_STAGES (money-schemas.mjs), a fixed, shared enum -- 'supplementary-return' is
// not a member and money-schemas.mjs is not D-owned to extend. Reuse the existing 'return' value:
// per-transaction replay protection comes from requestDigest (position-scoped, embedded in the
// policy), not from this label, so reusing it is safe, not merely convenient.
const RETURN_STAGE = 'return';
const RETURN_ATTEMPT_SCHEMA = 'hookemon.supplementary-return-attempt.v2';

export class SupplementaryMoneyError extends Error {}

function fail(message) {
  throw new SupplementaryMoneyError(message);
}

/**
 * The exact 48-hex-char paged-payout-state stage shape `persistPagedPayoutState`/
 * `readPagedPayoutState` requires (`supplementaryPayoutPagedStagePattern` in
 * `cycle-repository.mjs`). Derived from `positionId + ':return-leg'`, never from the same 48-hex
 * slice `supplementaryPayoutStageId` uses, so a position's return-leg attempt record and its
 * payout-leg recipient state never share one (cycleId, stage) key even though both live in the
 * same durable paged-payout-state store.
 */
export function supplementaryReturnStageId(positionId) {
  return `supplementary-${canonicalDigest({ schema: 'hookemon.supplementary-return-stage.v1', positionId }).slice(7, 55)}`;
}

/**
 * Builds the immutable, position-attributed return-bridge request from CS's own confirmed-sale
 * reconciliation (`reconcileSupplementaryBuybackSale`'s `{status:'CONFIRMED', memo, mint,
 * signature, proceeds, createdAt}` result -- see CS-interface.json). This is the sole permitted
 * source for the amount a supplementary return leg may bridge: never a wallet-wide Solana balance,
 * never the main cycle's custody ledger. Pure: does not call any adapter, sign anything, or touch
 * the repository.
 */
export function prepareSupplementaryReturnRequest({ settlement, confirmedSale, config }) {
  const normalizedSettlement = assertSettlement(settlement);
  if (normalizedSettlement.state !== 'BUYBACK_SENT_UNKNOWN') {
    fail('supplementary return requires a buyback-sent-unknown settlement');
  }
  if (!confirmedSale || confirmedSale.status !== 'CONFIRMED') {
    fail('supplementary return requires a confirmed buyback sale');
  }
  const { memo, mint, signature, proceeds, createdAt } = confirmedSale;
  if (typeof memo !== 'string' || memo.length === 0) fail('supplementary confirmed sale memo is invalid');
  if (typeof signature !== 'string' || signature.length === 0) fail('supplementary confirmed sale signature is invalid');
  if (typeof createdAt !== 'string' || createdAt.length === 0) fail('supplementary confirmed sale createdAt is invalid');
  if (!proceeds || typeof proceeds !== 'object' || Array.isArray(proceeds)) fail('supplementary confirmed sale proceeds is invalid');
  const configured = assertReturnConfiguration(config);
  const money = assertReturnMoneyConfiguration(config, configured);
  if (mint !== configured.solanaMint || proceeds.assetId !== configured.solanaMint) {
    fail('supplementary confirmed sale mint does not match the configured Solana settlement asset');
  }
  if (proceeds.chainId !== COLLECTOR_CRYPT_SETTLEMENT_ASSET.chainId) {
    fail('supplementary confirmed sale proceeds chainId is invalid');
  }
  if (proceeds.assetId !== COLLECTOR_CRYPT_SETTLEMENT_ASSET.assetId
    || proceeds.decimals !== COLLECTOR_CRYPT_SETTLEMENT_ASSET.decimals
    || proceeds.decimals !== money.assets.solanaStablecoin.decimals) {
    fail('supplementary confirmed sale proceeds decimals do not match MoneyConfigurationV1');
  }
  if (typeof proceeds.amountAtomic !== 'string' || !ATOMIC.test(proceeds.amountAtomic) || proceeds.amountAtomic === '0') {
    fail('supplementary confirmed sale proceeds amountAtomic is invalid');
  }
  return Object.freeze({
    schema: 'hookemon.supplementary-return-request.v2',
    positionId: normalizedSettlement.positionId,
    cycleId: normalizedSettlement.cycleId,
    manifestId: normalizedSettlement.manifestId,
    memo,
    sourceSignature: signature,
    createdAt,
    solanaMint: mint,
    solanaAmountAtomic: proceeds.amountAtomic,
    operations: configured.evm,
    solanaAccount: configured.solana,
  });
}

function returnAttemptEnvelope(base, overrides = {}) {
  return {
    schema: RETURN_ATTEMPT_SCHEMA,
    positionId: base.positionId,
    cycleId: base.cycleId,
    manifestId: base.manifestId,
    requestDigest: base.requestDigest,
    relayRequestId: base.relayRequestId,
    inputAmount: base.inputAmount,
    destinationAmount: base.destinationAmount,
    destinationUsd: base.destinationUsd,
    destinationUsdEvidence: base.destinationUsdEvidence,
    intent: base.intent,
    solanaInstructionPlan: base.solanaInstructionPlan,
    state: 'PREPARED',
    rawSignedBytes: null,
    rawSignedBytesHash: null,
    blockhash: null,
    blockhashLastValidHeight: null,
    sourceTransactionHash: null,
    recoveryContext: null,
    // persistPagedPayoutState/assertPagedPayoutState require a `recipients` array field on every
    // paged-payout-state value (it pages the outer recipient list for real payout states); this
    // attempt envelope has no recipients of its own, so it declares the empty case explicitly
    // rather than borrowing an unrelated shape.
    recipients: [],
    ...overrides,
  };
}

/**
 * Drives the real Solana source leg of one held position's return bridge: quotes the exact
 * confirmed-sale proceeds through Relay (never a wallet-wide balance), signs through the real B
 * policy/canary-guarded Solana signer, and durably records signed bytes -- via
 * `persistPagedPayoutState` under a position-scoped return-leg stage id, never the payout-leg
 * stage id -- before ever broadcasting. Resumable: a restart after PREPARED or SIGNED reuses the
 * exact persisted attempt instead of re-quoting or re-signing.
 */
export async function mutateSupplementaryReturn({
  liveMode, adapters, config, signerClient, cycleRepository, context, confirmedSale, now = Date.now, preflightAuthority,
}) {
  if (liveMode !== true) fail('supplementary return mutation requires liveMode');
  if (typeof cycleRepository?.readSupplementarySettlement !== 'function'
    || typeof cycleRepository?.readSupplementarySettlementEvidence !== 'function'
    || typeof cycleRepository?.readPagedPayoutState !== 'function'
    || typeof cycleRepository?.persistPagedPayoutState !== 'function') {
    fail('supplementary return mutation requires cycleRepository supplementary/paged-payout-state methods');
  }
  const rawSettlement = await cycleRepository.readSupplementarySettlement(context.positionId);
  if (!rawSettlement) fail('supplementary return mutation requires a known settlement');
  const durableSale = await cycleRepository.readSupplementarySettlementEvidence(context.positionId);
  if (durableSale?.state !== 'BUYBACK_SENT_UNKNOWN' || !durableSale.evidence) {
    fail('supplementary return mutation requires durable confirmed-sale evidence');
  }
  if (canonicalDigest(durableSale.evidence) !== canonicalDigest(confirmedSale)) {
    fail('supplementary return mutation confirmed sale does not match durable settlement evidence');
  }
  const request = prepareSupplementaryReturnRequest({ settlement: rawSettlement, confirmedSale, config });
  const stage = supplementaryReturnStageId(request.positionId);
  const configured = assertReturnConfiguration(config);
  const money = assertReturnMoneyConfiguration(config, configured);
  const requestDigest = canonicalDigest({
    schema: 'hookemon.supplementary-return-request-digest.v2',
    positionId: request.positionId,
    cycleId: request.cycleId,
    manifestId: request.manifestId,
    sourceSignature: request.sourceSignature,
    solanaAmountAtomic: request.solanaAmountAtomic,
  });
  let attempt = await cycleRepository.readPagedPayoutState(request.cycleId, stage);
  if (attempt === null || attempt === undefined) {
    if (!adapters?.relay || typeof adapters.relay.quoteReturnBridge !== 'function') {
      fail('supplementary return requires a configured Relay client');
    }
    const quote = await adapters.relay.quoteReturnBridge({
      user: configured.solana,
      recipient: configured.evm,
      amount: request.solanaAmountAtomic,
      originCurrency: configured.solanaMint,
    });
    assertReturnQuote(quote, configured, money);
    assertQuoteUsable({ quote, nowMs: now() });
    const execution = adapters.relay.prepareExecution({ quote, liveMode: true });
    const destinationUsd = createQuoteUsdValuation({ quote, side: 'destination', amount: typedAmount(quote.destination), rounding: 'down', nowMs: now() });
    const solanaInstructionPlan = extractRelaySolanaInstructionPlan({ steps: execution.steps, requestId: quote.requestId });
    attempt = returnAttemptEnvelope({
      positionId: request.positionId,
      cycleId: request.cycleId,
      manifestId: request.manifestId,
      requestDigest,
      relayRequestId: quote.requestId,
      inputAmount: typedAmount(quote.origin),
      destinationAmount: typedAmount(quote.destination),
      destinationUsd,
      destinationUsdEvidence: { ...readProcessQuoteUsdProvenance(destinationUsd), quote },
      intent: execution.intent,
      solanaInstructionPlan,
    });
    await cycleRepository.persistPagedPayoutState(request.cycleId, stage, attempt);
  }
  if (attempt.requestDigest !== requestDigest) {
    fail('supplementary return attempt does not match the prepared request');
  }
  const client = adapters?.solana?.client;
  if (!client) fail('supplementary return requires a configured Solana RPC client');

  if (attempt.state === 'PREPARED') {
    const latest = await readUsableLatestBlockhash(client);
    const blockhashLastValidHeight = canonicalPositiveInteger(
      String(latest.lastValidBlockHeight),
      'supplementary return latest blockhash last valid height',
    );
    const transaction = buildRelayLegacyTransaction({
      feePayer: configured.solana,
      recentBlockhash: latest.blockhash,
      instructionPlan: attempt.solanaInstructionPlan,
    });
    const approved = await createReturnPolicySigner({
      nativePaymentBinding: config.nativePaymentBinding,
      signerClient,
      client,
      configured,
      request: { intent: attempt.intent, inputAmount: attempt.inputAmount, solanaInstructionPlan: attempt.solanaInstructionPlan },
      transaction,
      requestDigest,
      blockhash: latest.blockhash,
      blockhashLastValidHeight,
      money,
      now,
      stage: RETURN_STAGE,
      preflightAuthority,
    });
    await assertReturnLamportReserve({ client, configured, money, decoded: approved.decoded });
    const signed = await approved.sign();
    if (typeof signed?.signedTxBase64 !== 'string' || signed.signedTxBase64.length === 0) {
      fail('supplementary return signer did not return serialized Solana bytes');
    }
    const approval = readTransactionPolicyApprovalContext(approved.policySigner, signed);
    const rawSignedBytesHash = approval.signedMessageDigest;
    const recoveryContext = returnRecoveryContext({
      context,
      requestDigest,
      rawSignedBytesHash,
      approval,
      blockhashLastValidHeight,
      stage: RETURN_STAGE,
    });
    attempt = {
      ...attempt,
      state: 'SIGNED',
      rawSignedBytes: signed.signedTxBase64,
      rawSignedBytesHash,
      blockhash: latest.blockhash,
      blockhashLastValidHeight,
      recoveryContext,
    };
    await cycleRepository.persistPagedPayoutState(request.cycleId, stage, attempt);
  }

  if (attempt.state === 'SIGNED') {
    const currentBlockHeight = await readBlockHeight(client);
    if (currentBlockHeight > BigInt(attempt.blockhashLastValidHeight)) {
      fail('supplementary return signed bytes have expired and cannot be re-signed automatically');
    }
    const approved = await createReturnPolicySigner({
      nativePaymentBinding: config.nativePaymentBinding,
      signerClient,
      client,
      configured,
      request: { intent: attempt.intent, inputAmount: attempt.inputAmount, solanaInstructionPlan: attempt.solanaInstructionPlan },
      transaction: attempt.rawSignedBytes,
      requestDigest,
      blockhash: attempt.blockhash,
      blockhashLastValidHeight: attempt.blockhashLastValidHeight,
      money,
      now,
      stage: RETURN_STAGE,
      preflightAuthority,
    });
    await assertReturnLamportReserve({ client, configured, money, decoded: approved.decoded });
    const policyRecovery = returnPolicyRecoveryContext(attempt.recoveryContext);
    const result = await recoverTransactionPolicyBroadcast({
      client: approved.policySigner,
      signed: { signedTxBase64: attempt.rawSignedBytes },
      recoveryContext: policyRecovery,
    });
    const sourceTransactionHash = signedSolanaTransactionSignature(attempt.rawSignedBytes);
    assertReturnBroadcastHash(result, sourceTransactionHash);
    attempt = { ...attempt, state: 'BROADCAST', sourceTransactionHash };
    await cycleRepository.persistPagedPayoutState(request.cycleId, stage, attempt);
  }
  return attempt;
}

/**
 * Verifies the real, independent finality of a broadcast supplementary return leg -- the actual
 * Solana source debit and the actual EVM destination credit, through the exact same generic
 * proof-reading primitives (`readFinalizedRelaySourceDebit`, `readReturnLegDestinationProof`) the
 * main cycle's return reconciliation uses -- then durably records the proven boundary. Read-only
 * except for that one final durable write; safe to call any number of times before the proof is
 * available (returns `null`).
 */
export async function reconcileSupplementaryReturn({ adapters, config, cycleRepository, context }) {
  if (typeof cycleRepository?.readPagedPayoutState !== 'function'
    || typeof cycleRepository?.readSupplementarySettlement !== 'function') {
    fail('supplementary return reconciliation requires cycleRepository paged-payout-state and settlement reads');
  }
  const stage = supplementaryReturnStageId(context.positionId);
  const attempt = await cycleRepository.readPagedPayoutState(context.cycleId, stage);
  if (!attempt || !['SIGNED', 'BROADCAST'].includes(attempt.state)) return null;
  if (!adapters?.solana?.client) return null;
  const configured = assertReturnConfiguration(config);
  // A transport can accept the bytes then lose its response. The signature is deterministically
  // encoded in the persisted signed transaction, so probe it before deciding that an expired
  // blockhash needs any action. This is reconciliation only: it neither signs nor rebroadcasts.
  const sourceTransactionHash = attempt.state === 'BROADCAST'
    ? attempt.sourceTransactionHash
    : signedSolanaTransactionSignature(attempt.rawSignedBytes);
  let source;
  try {
    source = await readReleaseBoundRelaySourceDebit({ client: adapters.solana.client, binding: config.nativePaymentBinding,
      signature: sourceTransactionHash,
      owner: configured.solana,
      mint: attempt.inputAmount.assetId,
      amountAtomic: attempt.inputAmount.amountAtomic,
      signedTransactionBase64: attempt.rawSignedBytes,
    });
  } catch {
    return null;
  }
  if (!adapters?.relay || !adapters?.robinhood?.client) return null;
  let proof;
  try {
    adapters.relay.restoreIntent({ intent: attempt.intent });
    const pointer = await adapters.relay.getTerminalDestinationTransactionPointer({ intentDigest: attempt.intent.requestId });
    if (pointer === null) return null;
    proof = await readReturnLegDestinationProof({
      client: adapters.robinhood.client,
      pointer,
      leg: { schema: 'hookemon.relay-leg.v2', relayRequestId: attempt.relayRequestId, sourceTxHash: sourceTransactionHash,
        sourceAssetId: attempt.inputAmount.assetId, sourceAmountAtomic: attempt.inputAmount.amountAtomic,
        destinationAssetId: 'native', destinationDecimals: 18, returnAttribution: { intent: attempt.intent } },
      sourceProof: source,
      nativePaymentBinding: config.nativePaymentBinding,
    });
  } catch {
    return null;
  }
  if (proof === null) return null;
  const assetId = config?.moneyConfiguration?.assets?.eth?.assetId;
  if (assetId !== 'native') fail('supplementary return requires native ETH');
  const expectedToken = 'native';
  const expectedRecipient = configured.evm.toLowerCase();
  if (proof.observedToken?.toLowerCase() !== expectedToken
    || proof.observedRecipient?.toLowerCase() !== expectedRecipient) {
    fail('supplementary return destination proof does not credit configured Operations native ETH');
  }
  if (BigInt(proof.observedAmountAtomic) < BigInt(attempt.destinationAmount.amountAtomic)) {
    fail('supplementary return destination proof is below the durable Relay quote minimum');
  }
  if (attempt.state === 'SIGNED') {
    await cycleRepository.persistPagedPayoutState(context.cycleId, stage, {
      ...attempt,
      state: 'BROADCAST',
      sourceTransactionHash,
    });
  }
  const settlement = await cycleRepository.readSupplementarySettlement(context.positionId);
  if (!settlement) return null;
  return recordSupplementaryReturnBroadcast({
    cycleRepository,
    settlement,
    finalizedReturnEvidence: {
      operations: configured.evm,
      assetId: assetId.toLowerCase(),
      amountAtomic: proof.observedAmountAtomic,
      finalityEvidence: proof,
    },
  });
}

/**
 * Durably records a proven return boundary and advances the settlement to `RETURN_BROADCAST`.
 * `finalizedReturnEvidence` must already carry a real, independently verifiable EVM destination
 * proof for the bridged native ETH credit -- this function only binds and persists it, it does not
 * originate or verify the cross-chain transfer itself. Idempotent: replaying the identical
 * evidence for a settlement already at `RETURN_BROADCAST` is a no-op (enforced by
 * `cycleRepository.advanceSupplementarySettlement`).
 */
export async function recordSupplementaryReturnBroadcast({ cycleRepository, settlement, finalizedReturnEvidence }) {
  const normalizedSettlement = assertSettlement(settlement);
  if (typeof cycleRepository?.advanceSupplementarySettlement !== 'function') {
    fail('supplementary return requires cycleRepository.advanceSupplementarySettlement');
  }
  if (!finalizedReturnEvidence || typeof finalizedReturnEvidence !== 'object' || Array.isArray(finalizedReturnEvidence)) {
    fail('supplementary return requires finalized return evidence');
  }
  const attempt = await cycleRepository.readPagedPayoutState(normalizedSettlement.cycleId, supplementaryReturnStageId(normalizedSettlement.positionId));
  const proof = finalizedReturnEvidence.finalityEvidence;
  if (!attempt || !isProcessRpcReturnLegDestinationProof(proof, {
    relayRequestId: attempt.relayRequestId,
    sourceTxHash: attempt.sourceTransactionHash ?? signedSolanaTransactionSignature(attempt.rawSignedBytes),
  }) || proof.nativePaymentProof?.amountWei !== finalizedReturnEvidence.amountAtomic
    || proof.nativePaymentProof?.recipient !== finalizedReturnEvidence.operations?.toLowerCase()) {
    fail('supplementary return requires the current authenticated native payment proof for its persisted attempt');
  }
  const evidence = {
    schema: SUPPLEMENTARY_RETURN_BOUNDARY_SCHEMA,
    positionId: normalizedSettlement.positionId,
    cycleId: normalizedSettlement.cycleId,
    manifestId: normalizedSettlement.manifestId,
    finalizedReturnEvidence: {
      schema: SUPPLEMENTARY_FINALIZED_RETURN_SCHEMA,
      positionId: normalizedSettlement.positionId,
      cycleId: normalizedSettlement.cycleId,
      manifestId: normalizedSettlement.manifestId,
      ...finalizedReturnEvidence,
    },
  };
  assertReturnBoundaryEvidence(evidence, normalizedSettlement, 'supplementary return broadcast evidence');
  return cycleRepository.advanceSupplementarySettlement(normalizedSettlement.positionId, {
    expectedState: 'BUYBACK_SENT_UNKNOWN',
    nextState: 'RETURN_BROADCAST',
    evidence,
  });
}

function directPayoutStoreAdapter(supplementaryStore, request) {
  return Object.freeze({
    load: () => supplementaryStore.load(request),
    persist: state => supplementaryStore.persist(request, state),
  });
}

/**
 * Drives one held position's supplementary payout to completion through the real direct-payout
 * engine (`advanceDirectPayout`/`isDirectPayoutComplete`), reusing the exact same recipient
 * lifecycle, signed-byte durability, and restart-without-re-signing guarantees as the main cycle's
 * payout -- through `createSupplementaryPayoutStore`'s separate paged namespace, never the main
 * payout's store. Always fully serial (`inFlightWindow` 1): a supplementary settlement's recipient
 * count is small and bounded by one held position, so the main cycle's bounded in-flight window is
 * not needed here.
 */
export async function mutateSupplementaryPayout({
  liveMode,
  adapters,
  config,
  signerClient,
  cycleRepository,
  context,
}) {
  if (liveMode !== true) fail('supplementary payout mutation requires liveMode');
  if (typeof cycleRepository?.readSupplementarySettlement !== 'function'
    || typeof cycleRepository?.advanceSupplementarySettlement !== 'function') {
    fail('supplementary payout mutation requires cycleRepository supplementary settlement methods');
  }
  const rawSettlement = await cycleRepository.readSupplementarySettlement(context.positionId);
  if (!rawSettlement) fail('supplementary payout mutation requires a known settlement');
  const settlement = assertSettlement(rawSettlement);
  if (!['RETURN_BROADCAST', 'PAYOUT_BROADCAST'].includes(settlement.state)) {
    fail('supplementary payout mutation requires a return-broadcast settlement');
  }
  const request = prepareSupplementaryPayoutRequest({
    settlement: rawSettlement,
    eligibilityManifest: context.eligibilityManifest,
    returnBoundary: context.returnBoundary,
  });
  const supplementaryStore = createSupplementaryPayoutStore({ cycleRepository, settlement: rawSettlement });
  const payoutStore = directPayoutStoreAdapter(supplementaryStore, request);
  let state = await payoutStore.load();
  const initializing = state === null || state === undefined;
  if (initializing) {
    const plan = request.plan.payoutPlan;
    const operations = plan.returnEvidence.operations;
    const assetId = plan.returnEvidence.assetId;
    const firstNonce = plan.payableRecipientCount === 0
      ? '0'
      : await (async () => {
        const client = adapters?.robinhood?.client;
        if (!client || typeof client.getTransactionCount !== 'function') {
          fail('supplementary payout requires getTransactionCount before initializing recipient state');
        }
        return client.getTransactionCount({ address: operations, blockTag: 'pending' });
      })();
    state = createDirectPayoutState({
      plan,
      operations,
      assetId,
      firstNonce: String(firstNonce),
    });
  }
  const unresolved = state.recipients.filter(entry => !['FINALIZED', 'REFUSED', 'NONCE_INTERFERENCE'].includes(entry.state));
  if (unresolved.length > 0) {
    const client = adapters?.robinhood?.client;
    if (!client || typeof client.getBalance !== 'function') {
      fail('supplementary payout requires getBalance before persisting or advancing recipient state');
    }
    const paid = state.recipients.filter(entry => entry.state === 'FINALIZED')
      .reduce((sum, entry) => sum + BigInt(entry.amount.amountAtomic), 0n);
    const remainingPrincipal = BigInt(state.distributablePool.amountAtomic) - paid;
    const remainingGas = BigInt(state.plan.feasibility.measuredTransferGas)
      * BigInt(state.plan.feasibility.maxGasPriceWei) * BigInt(unresolved.length);
    const required = remainingPrincipal + remainingGas
      + BigInt(state.plan.feasibility.nativeReserve.amountAtomic);
    const observedRaw = await client.getBalance({ address: state.operations });
    if ((typeof observedRaw !== 'bigint' && typeof observedRaw !== 'string')
      || !/^(0|[1-9][0-9]*)$/.test(String(observedRaw))) {
      fail('supplementary payout native balance is invalid');
    }
    const admission = evaluateDirectPayoutNativeGasAdmission({
      requiredNativeAmount: required.toString(), observedNativeBalance: String(observedRaw),
    });
    if (admission.outcome !== 'OK') {
      fail(`supplementary payout native balance does not cover remaining principal plus gas and reserve by ${admission.deficit} wei`);
    }
  }
  if (initializing) await payoutStore.persist(state);
  while (!isDirectPayoutComplete(state)) {
    const target = state.recipients.find(entry => entry.state !== 'FINALIZED' && entry.state !== 'REFUSED');
    if (!target) fail('supplementary payout has no unresolved recipient before terminal conservation');
    const before = JSON.stringify(state);
    state = await advanceDirectPayout({
      payoutStore,
      recipient: target.recipient,
      adapters,
      signerClient,
      config,
      cycleRepository,
    });
    // Waiting on an external confirmation (a not-yet-mined receipt, a not-yet-observed nonce) is
    // not an error: it just means this pass is done until the next scheduled retry, exactly like
    // the main cycle's payout dispatch loop.
    if (JSON.stringify(state) === before) return state;
  }
  if (settlement.state === 'RETURN_BROADCAST') {
    await cycleRepository.advanceSupplementarySettlement(settlement.positionId, {
      expectedState: 'RETURN_BROADCAST',
      nextState: 'PAYOUT_BROADCAST',
      evidence: { schema: 'hookemon.supplementary-payout-broadcast-evidence.v2', planDigest: state.planDigest },
    });
  }
  await cycleRepository.advanceSupplementarySettlement(settlement.positionId, {
    expectedState: 'PAYOUT_BROADCAST',
    nextState: 'COMPLETE',
    evidence: { schema: 'hookemon.supplementary-payout-complete-evidence.v2', planDigest: state.planDigest },
  });
  return state;
}
