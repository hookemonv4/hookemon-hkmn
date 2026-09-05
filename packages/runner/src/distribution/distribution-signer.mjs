// Owner-operated distribution-signer / verifier CLI and library.
//
// This module is deliberately NOT part of the always-on scheduler/worker process
// (design.md §2.3/§4.8, decision D7). It holds no private key material of its own —
// every signature is produced by an injected `signerClient` (a `{ role, sign(digest) }`
// object) resolved at call time from an operator-controlled module path, never embedded
// here. That is the structural separation the design requires: a compromised worker
// host that can read this file gains no signing capability, because there is nothing
// to steal — the actual key lives behind a seam this module only calls through.
//
// Two roles, two independent keys, never the same key:
//   - "distribution-signer": reads the compiled candidate inputs (closed proceeds basis,
//     finalized holder snapshot, per-holder entries) and the target on-chain domain
//     (hook/cycleId/payoutId), independently recomputes the candidate digest via
//     `reconcile.mjs`'s `deriveHolderDistributionCandidate`, and signs an approval.
//   - "verifier": given the compiled artifact and independently-submitted manifest
//     copies, independently reconstructs the same Merkle-sum tree via `manifest.mjs`'s
//     `verifyDistributionCopies` and signs a matching receipt only on an exact match.
//
// Both outputs use the exact schemas `manifest.mjs`/`cycle-runner.mjs` already validate
// (`hookemon.fixture-distribution-approval.v1` and
// `hookemon.fixture-distribution-verification.v1`), so they plug directly into
// `compileApprovedDistribution` and `CycleRunner.recordDistributionVerification` without
// any adaptation layer.
//
// WP-39: this Ed25519 scheme is used only under the fixture evidence profile. Under the
// production profile, the same two roles instead produce real secp256k1 signatures over the
// vault's own EIP-712 `PayoutDistribution` digest — the exact bytes `PegCycleVault.authorizePayout`
// verifies on-chain — so the same two signatures gate the manifest off-chain and the vault
// on-chain, rather than two different schemes that happen to agree. That production signing (and
// the corresponding `manifest.mjs` artifact builder, `buildProductionDistributionArtifact`) lives
// in `packages/adapters/src/signing/payout-distribution.mjs`/`payout-typed-data.mjs`, not here:
// this module stays dependency-free (no keccak256/secp256k1), and this file's own
// `DISTRIBUTION_SIGNER_ROLE`/`VERIFIER_ROLE` constants are the single source both the fixture and
// production paths import — never redeclared, so the two can never drift on what "verifier" means.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deriveHolderDistributionCandidate } from './reconcile.mjs';
import { distributionApprovalDigest, verifyDistributionCopies } from './manifest.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveRetainedCustodyMutationAuthority,
} from '../cycle/preflight.mjs';

export const DISTRIBUTION_SIGNER_ROLE = 'distribution-signer';
export const VERIFIER_ROLE = 'verifier';

const APPROVAL_SCHEMA = 'hookemon.fixture-distribution-approval.v1';
const APPROVAL_AUTHORITY = 'FIXTURE_OWNER_SIGNATURE';
const ROLES = Object.freeze([DISTRIBUTION_SIGNER_ROLE, VERIFIER_ROLE]);
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

function requireDistributionSigningAuthority(options = {}) {
  if (options?.preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('fixture distribution signing authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (options?.preflightAuthority !== undefined) throw new Error('fixture distribution signing test authority is invalid');
  return requireLiveRetainedCustodyMutationAuthority();
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}

function assertSignerClient(signerClient, expectedRole) {
  if (!ROLES.includes(expectedRole)) throw new Error(`unknown signer role: ${expectedRole}`);
  if (
    !signerClient
    || typeof signerClient !== 'object'
    || typeof signerClient.sign !== 'function'
  ) {
    throw new Error(
      `${expectedRole} requires an injected signer client exposing { role, sign(digest) }; `
      + 'this service holds no key material of its own',
    );
  }
  if (signerClient.role !== expectedRole) {
    throw new Error(
      `${expectedRole} signer client role mismatch: expected "${expectedRole}", got "${signerClient.role}"`,
    );
  }
}

/**
 * Independently recomputes the distribution candidate and assembles the exact
 * `hookemon.fixture-distribution-approval.v1` payload (unsigned) the vault-authorizer
 * side (`manifest.mjs`'s `compileApprovedDistribution`) will re-derive and compare
 * against on its own. Exported separately from `signDistributionApproval` so a caller
 * (or a test) can inspect the recomputed candidate before any signature is produced.
 */
export function buildDistributionApprovalPayload({
  closedProceedsBasis, snapshot, entries, hook, cycleId, payoutId,
} = {}) {
  const candidate = deriveHolderDistributionCandidate({ closedProceedsBasis, snapshot, entries });
  const payload = {
    schema: APPROVAL_SCHEMA,
    authority: APPROVAL_AUTHORITY,
    candidateDigest: candidate.candidateDigest,
    closedProceedsBasisDigest: candidate.closedProceedsBasisDigest,
    entriesDigest: candidate.entriesDigest,
    chainId: candidate.snapshot.chainId,
    hook,
    cycleId,
    payoutId,
    snapshotNumber: candidate.snapshot.blockNumber,
    snapshotHash: candidate.snapshot.blockHash,
  };
  return { candidate, payload };
}

/**
 * distribution-signer mode: reads the compiled candidate inputs and the finalized
 * return amount (folded into `closedProceedsBasis.finalCredit`), independently
 * recomputes the root sum's candidate digest, and signs an approval with the
 * caller-injected distribution-signer key. Never touches the verifier's key or role.
 */
export async function signDistributionApproval(input, signerClient, options = {}) {
  assertSignerClient(signerClient, DISTRIBUTION_SIGNER_ROLE);
  const { payload } = buildDistributionApprovalPayload(input ?? {});
  const approvalDigest = distributionApprovalDigest(payload);
  requireDistributionSigningAuthority(options);
  const signature = await signerClient.sign(Buffer.from(approvalDigest, 'utf8'));
  assertNonEmptyString(signature, 'distribution-signer signature');
  return { ...payload, approvalDigest, signature };
}

/**
 * verifier mode: given the compiled artifact (built from the distribution-signer's
 * approval) and independently-submitted manifest copies, independently reconstructs
 * the same Merkle-sum tree (`manifest.mjs`'s `verifyDistributionCopies` — which
 * throws, rather than silently accepting, on any reconstruction mismatch) and signs
 * a matching receipt with the caller-injected verifier key. Never touches the
 * distribution-signer's key or role.
 */
export async function signDistributionVerification(artifact, copies, context, signerClient, options = {}) {
  assertSignerClient(signerClient, VERIFIER_ROLE);
  const receipt = verifyDistributionCopies(artifact, copies, context);
  requireDistributionSigningAuthority(options);
  const signature = await signerClient.sign(Buffer.from(receipt.receiptDigest, 'utf8'));
  assertNonEmptyString(signature, 'verifier signature');
  return { ...receipt, verificationSignature: signature };
}

/**
 * Enforces that a distribution-signer approval and a verifier receipt reference the
 * exact same compiled artifact — same candidate, same owner-approval linkage, and
 * critically the same `rootHash`/`rootSum`/`manifestDigest` — before the pair is
 * considered usable in a `PayoutAuthorization`. This is a pure cross-check: it signs
 * nothing and mutates nothing, it only refuses to vouch for a mismatched pair.
 */
export function assertPairedDistributionApproval(approval, artifact, verification) {
  if (!approval || typeof approval !== 'object') throw new Error('a distribution-signer approval is required');
  if (!artifact || typeof artifact !== 'object') throw new Error('a compiled distribution artifact is required');
  if (!verification || typeof verification !== 'object') throw new Error('a verifier receipt is required');
  if (
    approval.approvalDigest !== artifact.ownerApprovalDigest
    || approval.candidateDigest !== artifact.candidateDigest
    || verification.candidateDigest !== artifact.candidateDigest
    || verification.ownerApprovalDigest !== artifact.ownerApprovalDigest
    || verification.manifestDigest !== artifact.manifest.digest
    || verification.rootHash !== artifact.root.hash
    || verification.rootSum !== artifact.root.sum
  ) {
    throw new Error(
      'distribution-signer approval and verifier receipt do not agree on the same rootHash/rootSum; '
      + 'refusing to treat this pair as usable in a PayoutAuthorization',
    );
  }
  return {
    candidateDigest: artifact.candidateDigest,
    manifestDigest: artifact.manifest.digest,
    rootHash: artifact.root.hash,
    rootSum: artifact.root.sum,
  };
}

// --- CLI -------------------------------------------------------------------
//
// The signer backend is always an operator-supplied module path (never a default,
// never embedded), loaded only inside `runCli`/`loadSignerClient` — an explicit,
// per-invocation seam. In production that module resolves an OS-keychain-backed (or
// remote policy-wallet-provider-backed) signer per decision D3; nothing about that
// resolution lives in this file.

const USAGE = [
  'usage:',
  '  node distribution-signer.mjs distribution-signer --input <candidate.json> --signer <signer-module.mjs> [--out <file>]',
  '  node distribution-signer.mjs verifier --artifact <artifact.json> --copies <copies.json> --context <context.json> --signer <signer-module.mjs> [--out <file>]',
].join('\n');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const key = flag?.startsWith('--') ? flag.slice(2) : undefined;
    if (!key || !['input', 'artifact', 'copies', 'context', 'signer', 'out'].includes(key)) {
      throw new Error(`unknown argument: ${flag}\n\n${USAGE}`);
    }
    index += 1;
    options[key] = rest[index];
  }
  return { mode, options };
}

function readJsonFile(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} file path is required\n\n${USAGE}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Dynamically imports an operator-supplied module and asks it for a signer client
 * bound to `expectedRole`. This is the only place a real key could ever enter the
 * process, and it happens only on explicit invocation with an explicit path — never
 * implicitly, never with a bundled default.
 */
export async function loadSignerClient(modulePath, expectedRole) {
  if (typeof modulePath !== 'string' || modulePath.length === 0) {
    throw new Error(
      `a --signer module path is required for role "${expectedRole}"; `
      + 'this service holds no key material itself and will not fabricate a signer',
    );
  }
  const moduleUrl = pathToFileURL(resolvePath(modulePath)).href;
  const loaded = await import(moduleUrl);
  const factory = loaded.createSignerClient ?? loaded.default;
  if (typeof factory !== 'function') {
    throw new Error(`signer module "${modulePath}" must export createSignerClient(role) or a default factory`);
  }
  const signerClient = await factory(expectedRole);
  assertSignerClient(signerClient, expectedRole);
  return signerClient;
}

function writeOutput(options, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, text);
  else process.stdout.write(text);
}

export async function runCli(argv) {
  const { mode, options } = parseArgs(argv);
  if (mode === DISTRIBUTION_SIGNER_ROLE) {
    const input = readJsonFile(options.input, 'candidate input');
    const signerClient = await loadSignerClient(options.signer, DISTRIBUTION_SIGNER_ROLE);
    const approval = await signDistributionApproval(input, signerClient);
    writeOutput(options, approval);
    return approval;
  }
  if (mode === VERIFIER_ROLE) {
    const artifact = readJsonFile(options.artifact, 'artifact');
    const copies = readJsonFile(options.copies, 'copies');
    const context = readJsonFile(options.context, 'context');
    const signerClient = await loadSignerClient(options.signer, VERIFIER_ROLE);
    const receipt = await signDistributionVerification(artifact, copies, context, signerClient);
    writeOutput(options, receipt);
    return receipt;
  }
  throw new Error(`unknown mode: ${mode ?? '(none)'}\n\n${USAGE}`);
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(resolvePath(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
