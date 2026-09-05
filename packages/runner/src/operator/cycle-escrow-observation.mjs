import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { canonicalJson, digest } from '../cycle/journal.mjs';

const observationFields = [
  'schema',
  'authority',
  'requirementsRevision',
  'runnerCycleId',
  'onchainCycleId',
  'cycleVaultAccount',
  'returnAccount',
  'method',
  'verificationDigest',
  'verificationSignature',
];
const runnerCyclePattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const decimalPattern = /^(?:0|[1-9][0-9]*)$/;
const zeroBytes32 = `0x${'0'.repeat(64)}`;
const zeroAddress = `0x${'0'.repeat(40)}`;
const zeroDigest = `sha256:${'0'.repeat(64)}`;
const publicKey = createPublicKey({
  key: Buffer.from('302a300506032b65700321005d95b14f73b748dbc80b64c6fa875223d98c0d262a2d06ba963d9ca5c9564729', 'hex'),
  format: 'der',
  type: 'spki',
});

function exactObject(value, fields = observationFields, label = 'fixture cycle escrow observation') {
  canonicalJson(value);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))
  ) throw new Error(`${label} must use the exact schema`);
  return value;
}

export function fixtureCycleEscrowObservationDigest(value) {
  const { verificationDigest: _verificationDigest, verificationSignature: _verificationSignature, ...observation } = value ?? {};
  return digest({ domain: 'hookemon.fixture-cycle-escrow-observation.v1', observation });
}

export function verifyFixtureCycleEscrowObservation(value) {
  const observation = exactObject(value);
  if (
    observation.schema !== 'hookemon.fixture-cycle-escrow-observation.v1'
    || observation.authority !== 'hookemon-fixture-cycle-escrow-reader'
    || observation.requirementsRevision !== 57
    || observation.method !== 'computeCycleEscrow(bytes32)'
  ) throw new Error('fixture cycle escrow observation authority or revision is invalid');
  if (typeof observation.runnerCycleId !== 'string' || !runnerCyclePattern.test(observation.runnerCycleId)) throw new Error('fixture cycle escrow observation runner cycle is invalid');
  if (typeof observation.onchainCycleId !== 'string' || !bytes32Pattern.test(observation.onchainCycleId) || observation.onchainCycleId === zeroBytes32) throw new Error('fixture cycle escrow observation onchain cycle is invalid or zero');
  for (const field of ['cycleVaultAccount', 'returnAccount']) {
    if (typeof observation[field] !== 'string' || !addressPattern.test(observation[field]) || observation[field] === zeroAddress) throw new Error(`fixture cycle escrow observation ${field} is invalid or zero`);
  }
  if (observation.cycleVaultAccount === observation.returnAccount) throw new Error('fixture cycle escrow observation return account must differ from the coordinator');
  if (typeof observation.verificationDigest !== 'string' || !digestPattern.test(observation.verificationDigest)) throw new Error('fixture cycle escrow observation verification digest is invalid');
  const expectedDigest = fixtureCycleEscrowObservationDigest(observation);
  if (observation.verificationDigest !== expectedDigest) throw new Error('fixture cycle escrow observation verification digest mismatch');
  if (typeof observation.verificationSignature !== 'string' || !signaturePattern.test(observation.verificationSignature)) throw new Error('fixture cycle escrow observation verification signature is invalid');
  const signatureBytes = Buffer.from(observation.verificationSignature, 'base64url');
  if (signatureBytes.toString('base64url') !== observation.verificationSignature || !verifySignature(null, Buffer.from(expectedDigest, 'utf8'), publicKey, signatureBytes)) throw new Error('fixture cycle escrow observation signature verification is invalid');
  return Object.freeze(structuredClone(observation));
}

// ---------------------------------------------------------------------------------------------------
// Production cycle escrow observation (WP-34). Unlike the fixture observation above, this carries no
// bundled signature — there is no production reader key to embed, and inventing one would mean signing
// with a key this repository does not actually hold (forbidden). Instead its structural shape is exact
// and self-consistent (`assertProductionCycleEscrowObservationShape`, deps-free — safe to re-run on every
// journal replay, exactly like the fixture check), and its *authenticity* — that `returnAccount` really is
// `PegCycleVault.computeCycleEscrow(onchainCycleId)` for `cycleVaultAccount`, and that the recorded USDG
// balance/transfer-logs/block genuinely came from that escrow on Robinhood Chain — is anchored in an
// injected EVM chain observer's own confirmation (`verifyProductionCycleEscrowObservation`, deps
// required), never a hardcoded key. `blockNumber` and `usdgBalance` are canonical unsigned-integer decimal
// strings (never a bigint/number); `blockHash` and `transferLogsDigest` are this repository's internal
// `sha256:` digest form, not raw EVM hex — the same normalization `preflight.mjs`'s release evidence
// already uses for its own `blockHash`/`transactionId` fields. `finalized` records that the observer
// completed the two-step read-then-confirm pattern `packages/adapters/src/robinhood-rpc.mjs` documents (a
// `latest` state read, block hash recorded, then independently re-confirmed against a fresh `finalized`
// block read) — this module never accepts a `finalized` state read directly, since the public Robinhood
// RPC does not serve one.
export const PRODUCTION_CYCLE_ESCROW_OBSERVATION_SCHEMA = 'hookemon.production-cycle-escrow-observation.v1';

const productionObservationFields = [
  'schema',
  'authority',
  'requirementsRevision',
  'chainId',
  'runnerCycleId',
  'onchainCycleId',
  'cycleVaultAccount',
  'returnAccount',
  'method',
  'blockNumber',
  'blockHash',
  'usdgBalance',
  'transferLogsDigest',
  'finalized',
];

export function assertProductionCycleEscrowObservationShape(value) {
  const observation = exactObject(value, productionObservationFields, 'production cycle escrow observation');
  if (
    observation.schema !== PRODUCTION_CYCLE_ESCROW_OBSERVATION_SCHEMA
    || observation.authority !== 'production-robinhood-rpc-observer'
    || observation.requirementsRevision !== 57
    || observation.chainId !== '4663'
    || observation.method !== 'computeCycleEscrow(bytes32)'
    || observation.finalized !== true
  ) throw new Error('production cycle escrow observation authority, revision, chain, method, or finality is invalid');
  if (typeof observation.runnerCycleId !== 'string' || !runnerCyclePattern.test(observation.runnerCycleId)) throw new Error('production cycle escrow observation runner cycle is invalid');
  if (typeof observation.onchainCycleId !== 'string' || !bytes32Pattern.test(observation.onchainCycleId) || observation.onchainCycleId === zeroBytes32) throw new Error('production cycle escrow observation onchain cycle is invalid or zero');
  for (const field of ['cycleVaultAccount', 'returnAccount']) {
    if (typeof observation[field] !== 'string' || !addressPattern.test(observation[field]) || observation[field] === zeroAddress) throw new Error(`production cycle escrow observation ${field} is invalid or zero`);
  }
  if (observation.cycleVaultAccount === observation.returnAccount) throw new Error('production cycle escrow observation return account must differ from the coordinator');
  if (typeof observation.blockNumber !== 'string' || !decimalPattern.test(observation.blockNumber)) throw new Error('production cycle escrow observation block number must be a canonical unsigned integer');
  if (typeof observation.blockHash !== 'string' || !digestPattern.test(observation.blockHash) || observation.blockHash === zeroDigest) throw new Error('production cycle escrow observation block hash is invalid or zero');
  if (typeof observation.usdgBalance !== 'string' || !decimalPattern.test(observation.usdgBalance)) throw new Error('production cycle escrow observation USDG balance must be a canonical unsigned integer');
  if (typeof observation.transferLogsDigest !== 'string' || !digestPattern.test(observation.transferLogsDigest)) throw new Error('production cycle escrow observation transfer logs digest is invalid');
  return Object.freeze(structuredClone(observation));
}

// Verifies a production cycle escrow observation against an injected Robinhood (EVM) chain observer:
// `deps.observers.evm.confirmCycleEscrow({ cycleVaultAccount, onchainCycleId })` must independently
// re-derive the exact same escrow address (a live `computeCycleEscrow(onchainCycleId)` read, or
// equivalent), block, USDG balance, and transfer-logs digest the observation claims — never a bundled
// signature. `deps.observers.evm` is the same synchronous, already-resolved chain-observer client shape
// `evidence-profile.mjs`'s production evidence profile and `preflight.mjs`'s `verifyProductionCycleRelease`
// already require (the caller resolves any live RPC round trip before calling this).
export function verifyProductionCycleEscrowObservation(value, deps = {}) {
  const observation = assertProductionCycleEscrowObservationShape(value);
  const observer = deps.observers?.evm;
  if (!observer || typeof observer.confirmCycleEscrow !== 'function') throw new Error('injected Robinhood chain observer is required to verify a production cycle escrow observation');
  const confirmation = observer.confirmCycleEscrow({ cycleVaultAccount: observation.cycleVaultAccount, onchainCycleId: observation.onchainCycleId });
  if (
    !confirmation
    || confirmation.escrowAddress !== observation.returnAccount
    || confirmation.blockNumber !== observation.blockNumber
    || confirmation.blockHash !== observation.blockHash
    || confirmation.usdgBalance !== observation.usdgBalance
    || confirmation.transferLogsDigest !== observation.transferLogsDigest
    || confirmation.finalized !== true
  ) throw new Error('production cycle escrow observation does not match the injected chain observer confirmation');
  return observation;
}
