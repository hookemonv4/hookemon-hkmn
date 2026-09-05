import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../cycle/journal.mjs';

const commandFlags = new Map([
  ['status', new Set()],
  ['reconcile', new Set(['expected-revision'])],
  ['pause', new Set(['expected-revision', 'request-id'])],
  ['resume', new Set(['expected-revision', 'request-id'])],
  ['kill', new Set(['expected-revision', 'request-id'])],
  ['update-configuration', new Set(['expected-revision', 'request-id', 'input'])],
  ['manual-approval', new Set(['expected-revision', 'request-id', 'input'])],
  ['held-owner-decision', new Set(['expected-revision', 'request-id', 'input'])],
  ['resume-cycle', new Set(['expected-revision', 'request-id'])],
  ['run-cycle-now', new Set(['expected-revision', 'request-id'])],
]);
const auditedCommands = new Set([
  'pause',
  'resume',
  'kill',
  'update-configuration',
  'manual-approval',
  'held-owner-decision',
  'resume-cycle',
  'run-cycle-now',
]);
const inputCommands = new Set(['update-configuration', 'manual-approval', 'held-owner-decision']);
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireCycleDescription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cycle recovery description is invalid');
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error('cycle recovery cycleId is invalid');
  if (!(value.operationalAttempts instanceof Map) || !(value.chainAttempts instanceof Map)) {
    throw new Error('cycle recovery attempt projections are invalid');
  }
  return value;
}

/**
 * Returns the only safe recovery posture derived from the durable journal. A provider attempt that
 * may have reached its provider is reconciliation-only; a signed or broadcast chain attempt must
 * be observed or rebroadcast from its persisted bytes by the stage owner, never replaced by a new
 * signature.
 */
export function inspectCycleRecovery(description) {
  const cycle = requireCycleDescription(description);
  if (cycle.mode !== 'production' && cycle.mode !== 'rehearsal') {
    return Object.freeze({ resumable: false, reason: 'CYCLE_MODE_UNRESOLVED', reconciliationOnly: false });
  }
  if (cycle.terminalState !== null && cycle.terminalState !== undefined) {
    return Object.freeze({ resumable: false, reason: 'CYCLE_TERMINAL', reconciliationOnly: false });
  }
  for (const { attempt } of cycle.chainAttempts.values()) {
    if (!attempt || attempt.state !== 'FINALIZED') {
      return Object.freeze({ resumable: false, reason: 'CHAIN_ATTEMPT_UNRESOLVED', reconciliationOnly: false });
    }
  }
  for (const { attempt } of cycle.operationalAttempts.values()) {
    if (!attempt || !['RECONCILED'].includes(attempt.state)) {
      return Object.freeze({ resumable: true, reason: null, reconciliationOnly: true });
    }
  }
  return Object.freeze({ resumable: true, reason: null, reconciliationOnly: false });
}

/** A read-only, secret-free status projection suitable for the operator CLI. */
export function projectCycleRepositoryStatus(description) {
  const cycle = requireCycleDescription(description);
  const stages = Object.fromEntries([...cycle.stages.entries()].map(([stage, value]) => [stage, value.status]));
  const providerAttempts = [...cycle.operationalAttempts.values()].map(({ attempt }) => Object.freeze({
    stage: attempt.stage,
    state: attempt.state,
    requestDigest: attempt.requestDigest,
  }));
  const chainAttempts = [...cycle.chainAttempts.values()].map(({ attempt }) => Object.freeze({
    stage: attempt.stage,
    state: attempt.state,
    requestDigest: attempt.requestDigest,
    hash: attempt.hash,
  }));
  const custody = cycle.custodyLedgers instanceof Map
    ? [...cycle.custodyLedgers.values()].map(ledger => Object.freeze(structuredClone(ledger)))
    : [];
  return Object.freeze({
    cycleId: cycle.cycleId,
    mode: cycle.mode ?? null,
    providerMode: cycle.providerMode ?? null,
    releaseAmount: cycle.releaseAmount,
    terminalState: cycle.terminalState ?? null,
    terminalEvidence: cycle.terminalEvidence === null || cycle.terminalEvidence === undefined
      ? null
      : Object.freeze(structuredClone(cycle.terminalEvidence)),
    completed: cycle.completed === true,
    archived: cycle.archived === true,
    stages: Object.freeze(stages),
    providerAttempts: Object.freeze(providerAttempts),
    chainAttempts: Object.freeze(chainAttempts),
    custody: Object.freeze(custody),
    recovery: inspectCycleRecovery(cycle),
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseRevision(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('expected revision must be a canonical nonnegative integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('expected revision exceeds the safe integer range');
  return parsed;
}

function parseCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 1) throw new Error('operator command is required');
  const command = argv[0];
  const allowed = commandFlags.get(command);
  if (!allowed) throw new Error('operator command is not allowed');
  if ((argv.length - 1) % 2 !== 0) throw new Error('operator flags require one value each');

  const flags = {};
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (typeof token !== 'string' || !token.startsWith('--') || token.length <= 2) throw new Error('operator flag is invalid');
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error('operator flag is not allowed for this command');
    if (Object.hasOwn(flags, name)) throw new Error('operator flag must not be duplicated');
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('operator flag value is invalid');
    flags[name] = value;
  }

  if (command !== 'status' && !Object.hasOwn(flags, 'expected-revision')) throw new Error('expected revision is required');
  if (Object.hasOwn(flags, 'expected-revision')) flags.expectedRevision = parseRevision(flags['expected-revision']);
  if (auditedCommands.has(command)) {
    if (!Object.hasOwn(flags, 'request-id') || !requestIdPattern.test(flags['request-id'])) {
      throw new Error('operator request id is invalid');
    }
  }
  if (inputCommands.has(command) && !Object.hasOwn(flags, 'input')) throw new Error('operator input path is required');
  if (Object.hasOwn(flags, 'input') && !isAbsolute(flags.input)) throw new Error('operator input path must be absolute');
  return Object.freeze({ command, flags: Object.freeze(flags) });
}

async function readCanonicalInput(path) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error('operator input must be a regular non-symlink file');
  const text = await readFile(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('operator input contains corrupt JSON');
  }
  if (text !== `${canonicalJson(parsed)}\n`) throw new Error('operator input must be canonical JSON plus one newline');
  return parsed;
}

function requireOperatorControl(value) {
  if (!value || typeof value.status !== 'function' || typeof value.execute !== 'function') {
    throw new Error('operator composed authority is required');
  }
  return value;
}

function commandFromInput(command, input) {
  if (command === 'update-configuration') return { type: command, configuration: input };
  if (command === 'manual-approval') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('manual approval input is invalid');
    return { type: command, cycleId: input.cycleId, cycleDigest: input.cycleDigest };
  }
  if (command === 'held-owner-decision') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('held owner decision input is invalid');
    return {
      type: command,
      cycleId: input.cycleId,
      heldEvidenceDigest: input.heldEvidenceDigest,
      expectedCycleRevision: input.expectedCycleRevision,
      choice: input.choice,
    };
  }
  return { type: command };
}

export async function runOperatorCli(argv, { operatorControl = undefined, executeAudited = undefined } = {}) {
  const { command, flags } = parseCommand(argv);
  const control = requireOperatorControl(operatorControl);
  if (command === 'status') return control.status();

  const input = Object.hasOwn(flags, 'input') ? await readCanonicalInput(flags.input) : null;
  const controlCommand = deepFreeze(commandFromInput(command, input));
  if (command === 'reconcile') {
    return control.execute({ expectedRevision: flags.expectedRevision, command: controlCommand });
  }
  if (typeof executeAudited !== 'function') throw new Error('operator audited executor is required for effectful commands');
  return executeAudited({
    requestId: flags['request-id'],
    expectedRevision: flags.expectedRevision,
    command: controlCommand,
    effect: () => control.execute({
      expectedRevision: flags.expectedRevision,
      requestId: flags['request-id'],
      command: controlCommand,
    }),
  });
}

function boundedDiagnostic(error) {
  const raw = error instanceof Error ? error.message : 'operator command failed';
  let safe = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'operator command failed';
  while (Buffer.byteLength(`${safe}\n`, 'utf8') > 512) safe = safe.slice(0, -1);
  return `${safe}\n`;
}

async function main() {
  try {
    const result = await runOperatorCli(process.argv.slice(2));
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    process.stderr.write(boundedDiagnostic(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
