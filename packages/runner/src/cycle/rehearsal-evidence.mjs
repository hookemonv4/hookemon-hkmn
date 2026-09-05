import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from './journal.mjs';
import { assertTypedAmount, OPERATIONAL_CYCLE_STAGES } from './money-schemas.mjs';

const residueClassifications = new Set(['none', 'dust', 'held', 'refunded', 'unattributed']);

function requireDescription(value, { allowReadyToComplete = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rehearsal evidence cycle description is invalid');
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error('rehearsal evidence cycleId is invalid');
  if (value.mode !== 'rehearsal') throw new Error('rehearsal evidence requires a rehearsal cycle');
  if (value.providerMode !== 'fake') {
    if (value.providerMode === 'live') {
      throw new Error('live rehearsal evidence requires a dedicated Solana proceeds projection');
    }
    throw new Error('rehearsal evidence requires a persisted fake provider mode');
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

function requireEvidence(value, cycleId, stage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`rehearsal evidence stage ${stage} is invalid`);
  if (value.schema !== 'hookemon.rehearsal-stage-evidence.v1' || value.cycleId !== cycleId || value.stage !== stage) {
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
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    const record = cycle.stages.get(stage);
    if (record?.status !== 'COMPLETE') throw new Error(`rehearsal evidence stage ${stage} is incomplete`);
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
    schema: 'hookemon.rehearsal-evidence.v1',
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
  if (!evidence || evidence.schema !== 'hookemon.rehearsal-evidence.v1' || typeof evidence.cycleId !== 'string') {
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
