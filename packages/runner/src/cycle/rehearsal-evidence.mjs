import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from './journal.mjs';
import { assertTypedAmount, OPERATIONAL_CYCLE_STAGES } from './money-schemas.mjs';

const residueClassifications = new Set(['none', 'dust', 'held', 'refunded', 'unattributed']);
const liveCollectorOnlySkippedStages = new Set(['eligibility-snapshot', 'claim-process', 'outbound', 'return']);
const liveCollectorOnlySettlementAsset = Object.freeze({
  chainId: 'solana-mainnet',
  assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
});
const decimalPattern = /^(0|[1-9][0-9]*)$/;

function requireDescription(value, { allowReadyToComplete = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rehearsal evidence cycle description is invalid');
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error('rehearsal evidence cycleId is invalid');
  if (value.mode !== 'rehearsal') throw new Error('rehearsal evidence requires a rehearsal cycle');
  if (value.providerMode !== 'fake' && value.providerMode !== 'live') {
    throw new Error('rehearsal evidence requires a persisted fake or live provider mode');
  }
  if (!allowReadyToComplete && (value.completed !== true || value.terminalState !== 'COMPLETED')) {
    throw new Error('rehearsal evidence requires a completed cycle');
  }
  if (allowReadyToComplete && !((value.completed === true && value.terminalState === 'COMPLETED')
    || (value.completed === false && (value.terminalState === null || value.terminalState === undefined)))) {
    throw new Error('rehearsal evidence cycle terminal state is invalid');
  }
  if (!(value.stages instanceof Map) || !(value.operationalAttempts instanceof Map) || !(value.chainAttempts instanceof Map)) {
    throw new Error('rehearsal evidence durable projections are invalid');
  }
  return value;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireNonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function requireDecimal(value, label) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireLiveSettlementAmount(value, label, { positive = false } = {}) {
  const amount = assertTypedAmount(value, label);
  if (amount.chainId !== liveCollectorOnlySettlementAsset.chainId
    || amount.assetId !== liveCollectorOnlySettlementAsset.assetId
    || amount.decimals !== liveCollectorOnlySettlementAsset.decimals) {
    throw new Error(`${label} must use the live collector-only settlement asset`);
  }
  if (positive && BigInt(amount.amountAtomic) === 0n) throw new Error(`${label} must be positive`);
  return Object.freeze(amount);
}

function sameLiveAmount(left, right) {
  return left.chainId === right.chainId
    && left.assetId === right.assetId
    && left.decimals === right.decimals
    && left.amountAtomic === right.amountAtomic;
}

function requireLiveStage(cycle, stage, { readOnly = false } = {}) {
  const record = cycle.stages.get(stage);
  if (record?.status !== 'COMPLETE') throw new Error(`live rehearsal evidence stage ${stage} is incomplete`);
  const operational = cycle.operationalAttempts.get(stage);
  if (readOnly) {
    if (operational !== undefined && operational?.attempt?.state !== 'RECONCILED') {
      throw new Error(`live rehearsal evidence read-only stage ${stage} has an unresolved provider attempt`);
    }
  } else if (operational?.attempt?.state !== 'RECONCILED') {
    throw new Error(`live rehearsal evidence stage ${stage} provider attempt is not reconciled`);
  }
  return requirePlainObject(record.evidence, `live rehearsal evidence stage ${stage}`);
}

function requireLiveSkippedStage(cycle, stage) {
  const evidence = requireLiveStage(cycle, stage, { readOnly: stage === 'eligibility-snapshot' });
  if (evidence.skipped !== true || evidence.rehearsalMode !== 'collector-only' || evidence.stage !== stage
    || typeof evidence.reason !== 'string' || evidence.reason.length === 0) {
    throw new Error(`live rehearsal evidence stage ${stage} must contain canonical no-effect evidence`);
  }
  return Object.freeze({ stage, reason: evidence.reason });
}

function requireFinalizedChainAttempts(cycle) {
  for (const { attempt } of cycle.chainAttempts.values()) {
    if (attempt?.state !== 'FINALIZED') throw new Error('rehearsal evidence requires every chain attempt finalized');
  }
}

function collectLiveCollectorOnlyEvidence(cycle) {
  requireFinalizedChainAttempts(cycle);
  const skipped = [...liveCollectorOnlySkippedStages].map(stage => requireLiveSkippedStage(cycle, stage));

  const purchase = requireLiveStage(cycle, 'purchase');
  const purchaseMemo = requireNonemptyString(purchase.memo, 'live purchase memo');
  const purchaseSignature = requireNonemptyString(purchase.signature, 'live purchase signature');
  if (purchase.expectedCardCount !== 1) throw new Error('live purchase must bind exactly one expected card');
  const packCost = requireLiveSettlementAmount(purchase.packCost, 'live purchase pack cost', { positive: true });
  if (packCost.amountAtomic !== requireDecimal(cycle.releaseAmount, 'live rehearsal release amount')) {
    throw new Error('live purchase pack cost must equal the cycle release amount');
  }

  const open = requireLiveStage(cycle, 'open');
  if (open.memo !== purchaseMemo) throw new Error('live open memo does not match the purchase');
  const openSignature = requireNonemptyString(open.signature, 'live open signature');
  const mint = requireNonemptyString(open.mint, 'live opened card mint');
  if (open.assetKind !== 'spl' && open.assetKind !== 'mpl-core') throw new Error('live opened card asset kind is invalid');

  const epicGate = requireLiveStage(cycle, 'epic-gate');
  if (epicGate.memo !== purchaseMemo || epicGate.mint !== mint || epicGate.decision !== 'sell') {
    throw new Error('live epic decision does not bind the opened card and sell path');
  }
  const offer = requireLiveSettlementAmount(epicGate.offer, 'live epic buyback offer', { positive: true });
  const insuredValue = requireLiveSettlementAmount(epicGate.insuredValue, 'live epic insured value', { positive: true });

  const buyback = requireLiveStage(cycle, 'buyback');
  if (buyback.memo !== purchaseMemo || buyback.mint !== mint) throw new Error('live buyback does not bind the opened card');
  const buybackSignature = requireNonemptyString(buyback.signature, 'live buyback signature');
  const quote = requireLiveSettlementAmount(buyback.quote, 'live buyback quote', { positive: true });
  const refundAmount = requireLiveSettlementAmount(buyback.refundAmount, 'live buyback refund amount', { positive: true });
  const proceeds = requireLiveSettlementAmount(buyback.proceeds, 'live buyback proceeds', { positive: true });
  if (!sameLiveAmount(offer, quote) || !sameLiveAmount(quote, refundAmount) || !sameLiveAmount(refundAmount, proceeds)) {
    throw new Error('live buyback amounts do not match the finalized offer and proceeds');
  }
  const projection = requirePlainObject(buyback.proceedsProjection, 'live rehearsal evidence requires a dedicated Solana proceeds projection');
  const proceedsAccount = requireNonemptyString(projection.account, 'live dedicated proceeds account');
  const beforeAtomic = requireDecimal(projection.beforeAtomic, 'live dedicated proceeds balance before');
  const afterAtomic = requireDecimal(projection.afterAtomic, 'live dedicated proceeds balance after');
  const projectedDelta = requireLiveSettlementAmount(projection.delta, 'live dedicated proceeds delta', { positive: true });
  if (BigInt(afterAtomic) - BigInt(beforeAtomic) !== BigInt(projectedDelta.amountAtomic) || !sameLiveAmount(projectedDelta, proceeds)) {
    throw new Error('live dedicated proceeds projection does not match the finalized buyback delta');
  }

  const payout = requireLiveStage(cycle, 'payout');
  const payoutSignature = requireNonemptyString(payout.signature, 'live payout signature');
  if (payout.buybackSignature !== buybackSignature || payout.sourceTokenAccount !== proceedsAccount || payout.proceedsAccount !== proceedsAccount) {
    throw new Error('live payout does not debit the dedicated finalized proceeds account');
  }
  const payoutProceeds = requireLiveSettlementAmount(payout.proceeds, 'live payout proceeds', { positive: true });
  const allocated = requireLiveSettlementAmount(payout.allocated, 'live payout allocation', { positive: true });
  if (!sameLiveAmount(payoutProceeds, proceeds) || !sameLiveAmount(allocated, proceeds)) {
    throw new Error('live payout conservation does not match the finalized proceeds delta');
  }
  if (!Array.isArray(payout.recipients) || payout.recipients.length === 0) {
    throw new Error('live payout requires at least one recipient allocation');
  }
  const recipientIds = new Set();
  const recipientAccounts = new Set();
  let allocatedAtomic = 0n;
  const recipients = payout.recipients.map((entry, index) => {
    const recipient = requireNonemptyString(entry?.recipient, `live payout recipient ${index}`);
    const tokenAccount = requireNonemptyString(entry?.tokenAccount, `live payout recipient ${index} token account`);
    if (recipient === proceedsAccount || tokenAccount === proceedsAccount || recipientIds.has(recipient) || recipientAccounts.has(tokenAccount)) {
      throw new Error('live payout recipients must be distinct from the dedicated proceeds account and each other');
    }
    const amount = requireLiveSettlementAmount(entry.amount, `live payout recipient ${index} amount`, { positive: true });
    recipientIds.add(recipient);
    recipientAccounts.add(tokenAccount);
    allocatedAtomic += BigInt(amount.amountAtomic);
    return Object.freeze({ recipient, tokenAccount, amount });
  });
  if (allocatedAtomic !== BigInt(allocated.amountAtomic)) throw new Error('live payout recipient allocations do not exactly conserve proceeds');

  return Object.freeze({
    schema: 'hookemon.rehearsal-evidence.v1',
    cycleId: cycle.cycleId,
    mode: cycle.mode,
    providerMode: cycle.providerMode,
    releaseAmount: packCost,
    skippedStages: Object.freeze(skipped),
    purchase: Object.freeze({ memo: purchaseMemo, signature: purchaseSignature, packCost }),
    open: Object.freeze({ memo: purchaseMemo, signature: openSignature, mint, assetKind: open.assetKind }),
    epicGate: Object.freeze({ memo: purchaseMemo, mint, offer, insuredValue }),
    buyback: Object.freeze({ memo: purchaseMemo, mint, signature: buybackSignature, quote, refundAmount, proceeds }),
    proceeds: Object.freeze({ account: proceedsAccount, beforeAtomic, afterAtomic, delta: projectedDelta }),
    payout: Object.freeze({ signature: payoutSignature, recipients: Object.freeze(recipients), proceeds: payoutProceeds, allocated }),
  });
}

function requireEvidence(value, cycleId, stage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`rehearsal evidence stage ${stage} is invalid`);
  if (!['hookemon.rehearsal-stage-evidence.v1', 'hookemon.rehearsal-stage-evidence.v2'].includes(value.schema) || value.cycleId !== cycleId || value.stage !== stage) {
    throw new Error(`rehearsal evidence stage ${stage} identity is invalid`);
  }
  if (typeof value.effectId !== 'string' || value.effectId.length === 0) throw new Error(`rehearsal evidence stage ${stage} effectId is invalid`);
  if (!Array.isArray(value.finalizedDeltas) || !Array.isArray(value.residues)) {
    throw new Error(`rehearsal evidence stage ${stage} amounts are invalid`);
  }
  const finalizedDeltas = value.finalizedDeltas.map(amount => assertTypedAmount(amount, `rehearsal evidence ${stage} finalized delta`));
  const residues = value.residues.map(residue => {
    if (!residue || typeof residue !== 'object' || Array.isArray(residue)) throw new Error(`rehearsal evidence ${stage} residue is invalid`);
    const { classification, ...amount } = residue;
    if (!residueClassifications.has(classification)) throw new Error(`rehearsal evidence ${stage} residue classification is invalid`);
    return Object.freeze({ ...assertTypedAmount(amount, `rehearsal evidence ${stage} residue`), classification });
  });
  return Object.freeze({ value, finalizedDeltas, residues });
}

function sameAmount(left, right) {
  return canonicalJson(assertTypedAmount(left, 'rehearsal payout amount')) === canonicalJson(assertTypedAmount(right, 'rehearsal payout amount'));
}

/** Derives the durable, self-contained evidence document for one completed rehearsal cycle. */
export function collectRehearsalEvidence(description, { allowReadyToComplete = false } = {}) {
  if (typeof allowReadyToComplete !== 'boolean') throw new Error('rehearsal evidence readiness option is invalid');
  const cycle = requireDescription(description, { allowReadyToComplete });
  if (cycle.providerMode === 'live') return collectLiveCollectorOnlyEvidence(cycle);
  const native = [...cycle.stages.values()].some(record => record.evidence?.schema === 'hookemon.rehearsal-stage-evidence.v2');
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    const record = cycle.stages.get(stage);
    if (record?.status !== 'COMPLETE') throw new Error(`rehearsal evidence stage ${stage} is incomplete`);
    if (native && record.evidence?.schema !== 'hookemon.rehearsal-stage-evidence.v2') throw new Error('native rehearsal evidence cannot mix historical stage units');
    const operational = cycle.operationalAttempts.get(stage);
    if (operational?.attempt?.state !== 'RECONCILED') {
      throw new Error(`rehearsal evidence stage ${stage} provider attempt is not reconciled`);
    }
  }
  for (const { attempt } of cycle.chainAttempts.values()) {
    if (attempt?.state !== 'FINALIZED') throw new Error('rehearsal evidence requires every chain attempt finalized');
  }

  const effectIds = [];
  const seenEffectIds = new Set();
  const finalizedDeltas = [];
  const residues = [];
  let payout = null;
  let releaseAmount = null;
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    const record = cycle.stages.get(stage);
    const evidence = requireEvidence(record.evidence, cycle.cycleId, stage);
    if (seenEffectIds.has(evidence.value.effectId)) throw new Error('rehearsal evidence contains a duplicate fake effect');
    seenEffectIds.add(evidence.value.effectId);
    effectIds.push(evidence.value.effectId);
    finalizedDeltas.push(...evidence.finalizedDeltas);
    residues.push(...evidence.residues);
    if (stage === 'eligibility-snapshot') {
      const candidate = evidence.finalizedDeltas[0] ?? null;
      if (candidate === null || candidate.amountAtomic !== cycle.releaseAmount) {
        throw new Error('rehearsal evidence release amount is not attributable');
      }
      releaseAmount = assertTypedAmount(candidate, 'rehearsal release amount');
    }
    if (stage === 'payout') {
      const conservation = evidence.value.payoutConservation;
      if (!conservation || !sameAmount(conservation.proceeds, conservation.allocated)) {
        throw new Error('rehearsal evidence payout conservation is not exact');
      }
      if (typeof evidence.value.proceedsAccount !== 'string' || evidence.value.proceedsAccount.length === 0) {
        throw new Error('rehearsal evidence payout proceeds account is invalid');
      }
      payout = Object.freeze({
        proceedsAccount: evidence.value.proceedsAccount,
        proceeds: assertTypedAmount(conservation.proceeds, 'rehearsal payout proceeds'),
        allocated: assertTypedAmount(conservation.allocated, 'rehearsal payout allocation'),
      });
    }
  }
  if (payout === null) throw new Error('rehearsal evidence requires payout evidence');
  if (releaseAmount === null) throw new Error('rehearsal evidence requires an attributable release amount');
  return Object.freeze({
    schema: native ? 'hookemon.rehearsal-evidence.v2' : 'hookemon.rehearsal-evidence.v1',
    cycleId: cycle.cycleId,
    mode: cycle.mode,
    providerMode: cycle.providerMode,
    releaseAmount,
    effectIds: Object.freeze(effectIds),
    finalizedDeltas: Object.freeze(finalizedDeltas),
    residues: Object.freeze(residues),
    payout,
  });
}

/** Writes one immutable evidence JSON file below the operator state directory. */
export async function writeRehearsalEvidence({ stateDir, evidence }) {
  if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) throw new Error('rehearsal evidence stateDir must be absolute');
  if (!evidence || !['hookemon.rehearsal-evidence.v1', 'hookemon.rehearsal-evidence.v2'].includes(evidence.schema) || typeof evidence.cycleId !== 'string') {
    throw new Error('rehearsal evidence document is invalid');
  }
  const directory = join(stateDir, 'rehearsal-evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${evidence.cycleId}.json`);
  try {
    await writeFile(path, `${canonicalJson(evidence)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`rehearsal evidence already exists for ${evidence.cycleId}`);
    throw error;
  }
  return path;
}

/** Writes an evidence document exactly once, or verifies the already-written immutable copy. */
export async function ensureRehearsalEvidence({ stateDir, evidence }) {
  try {
    return await writeRehearsalEvidence({ stateDir, evidence });
  } catch (error) {
    if (!/already exists/.test(error?.message ?? '')) throw error;
  }
  const path = join(stateDir, 'rehearsal-evidence', `${evidence.cycleId}.json`);
  let existing;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('rehearsal evidence already exists but is unreadable');
  }
  if (canonicalJson(existing) !== canonicalJson(evidence)) {
    throw new Error('rehearsal evidence already exists with different content');
  }
  return path;
}
