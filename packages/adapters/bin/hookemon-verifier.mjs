#!/usr/bin/env node
// The distribution verifier's own, separate process (WP-33 part 3, decision D7): "the verifier is
// a SEPARATE automated verifier process with its own key ... that independently recomputes the
// snapshot and manifest from chain data and signs only on an exact match." This process never
// shares a signer client, a role, or (when run as documented — a distinct host/account from the
// scheduler) a machine with `bin/hookemon-runner.mjs`; it holds only a `verifier`-role signer
// client and refuses to start with anything else.
//
// It watches a "distribution directory" for verification requests the runner (or an operator)
// drops there, independently reconstructs each candidate distribution via
// packages/runner/src/distribution/distribution-signer.mjs's `signDistributionVerification`
// (itself calling `manifest.mjs`'s `verifyDistributionCopies`, which throws — never silently
// accepts — on any reconstruction mismatch), and writes the signed receipt back. The runner side
// consumes that receipt exactly as `distribution-signer.mjs`'s own doc header describes: paired
// against a distribution-signer approval via `assertPairedDistributionApproval`.
//
// Directory contract (relative to --dir; created on demand):
//   pending/<requestId>.json   { artifact, copies, context } (fixture profile) or
//                              { profile: 'production', closedProceedsBasis, snapshot, entries,
//                              domain, payoutId, fields, distributionDigest, distributionSignature }
//                              (WP-39 production profile) — written by the runner/operator.
//   receipts/<requestId>.json  the signed verification receipt this process writes back — the
//                              fixture Ed25519 receipt shape, or (production) { profile:
//                              'production', digest, signature }.
//   failed/<requestId>.json    { error } if verification/signing failed for that request.
// A request that already has a receipts/ or failed/ file is never reprocessed — restarting this
// process, or running more than one pass against the same directory, is always safe.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { VERIFIER_ROLE, signDistributionVerification } from '../../runner/src/distribution/distribution-signer.mjs';
import { buildProductionDistributionArtifact, verifyProductionDistributionArtifactReconstruction } from '../../runner/src/distribution/manifest.mjs';
import { createExternalModuleSignerClient } from '../src/signing/external-module-signer.mjs';
import { createKeychainSignerClient } from '../src/signing/keychain-signer.mjs';
import { createProcessExec } from '../src/signing/keychain-process-exec.mjs';
import { signProductionDistributionVerification } from '../src/signing/payout-distribution.mjs';

const USAGE = [
  'usage:',
  '  node hookemon-verifier.mjs once  --dir <path> --live-mode --signer-backend module   --signer-module <path>',
  '  node hookemon-verifier.mjs once  --dir <path> --live-mode --signer-backend keychain --keychain-command <path> --keychain-account <id>',
  '  node hookemon-verifier.mjs watch --dir <path> --live-mode ... [--interval-ms <n>]',
  '',
  'This process only ever holds a "verifier"-role signer client — never the runner\'s operator or',
  'distribution-signer roles — and refuses to start without one. "--live-mode" is required and has',
  'no default: this tool exists only to actually sign verification receipts, so a missing flag',
  'fails loudly rather than constructing a signer that silently refuses every request.',
].join('\n');

const KNOWN_FLAGS = new Set([
  'dir', 'signer-backend', 'signer-module', 'keychain-command', 'keychain-account', 'interval-ms', 'live-mode',
]);
const BOOLEAN_FLAGS = new Set(['live-mode']);

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const key = flag?.startsWith('--') ? flag.slice(2) : undefined;
    if (!key || !KNOWN_FLAGS.has(key)) throw new Error(`unknown argument: ${flag}\n\n${USAGE}`);
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }
    index += 1;
    options[key] = rest[index];
  }
  return { mode, options };
}

function requireAbsolute(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} is required\n\n${USAGE}`);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return path;
}

export { createProcessExec };

async function buildSignerClient(options) {
  const liveMode = options['live-mode'] === true;
  if (!liveMode) {
    throw new Error(
      '--live-mode is required: hookemon-verifier only ever runs to actually sign verification '
      + `receipts, so it never constructs a signer that would silently refuse every request.\n\n${USAGE}`,
    );
  }
  const backend = options['signer-backend'] ?? 'module';
  if (backend === 'module') {
    const modulePath = requireAbsolute(options['signer-module'], '--signer-module');
    return createExternalModuleSignerClient({ modulePath, role: VERIFIER_ROLE, liveMode: true });
  }
  if (backend === 'keychain') {
    const command = requireAbsolute(options['keychain-command'], '--keychain-command');
    const account = options['keychain-account'];
    if (!account) throw new Error(`--keychain-account is required for the keychain backend\n\n${USAGE}`);
    return createKeychainSignerClient({ role: VERIFIER_ROLE, liveMode: true, exec: createProcessExec(), command, account });
  }
  throw new Error(`unknown --signer-backend: ${backend}\n\n${USAGE}`);
}

function ensureDirectories(dir) {
  for (const sub of ['pending', 'receipts', 'failed']) mkdirSync(join(dir, sub), { recursive: true });
}

function listPendingRequestIds(dir) {
  const pendingDir = join(dir, 'pending');
  if (!existsSync(pendingDir)) return [];
  return readdirSync(pendingDir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .sort();
}

function alreadyAnswered(dir, requestId) {
  return existsSync(join(dir, 'receipts', `${requestId}.json`)) || existsSync(join(dir, 'failed', `${requestId}.json`));
}

function atomicWriteJson(path, value) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, path);
}

/**
 * WP-39 production profile: independently rebuilds the Merkle-sum artifact from the request's own
 * candidate inputs (`closedProceedsBasis`/`snapshot`/`entries`/`domain`/`payoutId` — never trusting
 * the requester's own artifact, because there is none in the request: this function builds its
 * own), asserts the rebuild is internally self-consistent
 * (`verifyProductionDistributionArtifactReconstruction`), cross-checks the resulting manifestDigest/
 * rootHash/rootSum against the `fields` the distribution-signer claims to have signed, and only
 * then signs the identical EIP-712 digest with this process's own `verifier`-role signer client.
 * A mismatch at any step throws before the signer client is ever called.
 */
async function processOneProductionRequest(request, signerClient, { preflightAuthority } = {}) {
  const { closedProceedsBasis, snapshot, entries, domain, payoutId, fields, distributionDigest } = request;
  const rebuilt = buildProductionDistributionArtifact({ closedProceedsBasis, snapshot, entries, domain, payoutId });
  verifyProductionDistributionArtifactReconstruction(rebuilt);
  if (
    fields.manifestDigest !== rebuilt.manifest.digest
    || fields.rootHash !== rebuilt.root.hash
    || String(fields.rootSum) !== String(rebuilt.root.sum)
  ) {
    throw new Error('independently rebuilt manifestDigest/rootHash/rootSum does not match the distribution-signer\'s claimed fields');
  }
  const { digest, signature } = await signProductionDistributionVerification(fields, signerClient, { preflightAuthority });
  if (digest !== distributionDigest) throw new Error('independently computed EIP-712 digest does not match the distribution-signer\'s digest');
  return { profile: 'production', digest, signature };
}

async function processOneRequest(dir, requestId, signerClient, { preflightAuthority } = {}) {
  const requestPath = join(dir, 'pending', `${requestId}.json`);
  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, 'utf8'));
  } catch (error) {
    atomicWriteJson(join(dir, 'failed', `${requestId}.json`), { error: `could not read/parse request: ${error.message}` });
    return { requestId, status: 'FAILED', error: error.message };
  }
  try {
    if (request?.profile === 'production') {
      const receipt = await processOneProductionRequest(request, signerClient, { preflightAuthority });
      atomicWriteJson(join(dir, 'receipts', `${requestId}.json`), receipt);
      return { requestId, status: 'VERIFIED' };
    }
    const { artifact, copies, context } = request ?? {};
    const receipt = await signDistributionVerification(artifact, copies, context, signerClient, { preflightAuthority });
    atomicWriteJson(join(dir, 'receipts', `${requestId}.json`), receipt);
    return { requestId, status: 'VERIFIED' };
  } catch (error) {
    atomicWriteJson(join(dir, 'failed', `${requestId}.json`), { error: error.message });
    return { requestId, status: 'FAILED', error: error.message };
  }
}

/** One full pass: verify every not-yet-answered request currently in `pending/`. Safe to call
 * repeatedly (idempotent by construction — an already-answered request is skipped, never
 * re-verified or re-signed). */
export async function runOnePass({ dir, signerClient, preflightAuthority }) {
  if (!signerClient || signerClient.role !== VERIFIER_ROLE) {
    throw new Error(`hookemon-verifier requires a signer client bound to role "${VERIFIER_ROLE}", got "${signerClient?.role}"`);
  }
  ensureDirectories(dir);
  const results = [];
  for (const requestId of listPendingRequestIds(dir)) {
    if (alreadyAnswered(dir, requestId)) continue;
    // eslint-disable-next-line no-await-in-loop -- requests are processed one at a time, in
    // deterministic id order, so a directory listing racing a concurrent writer never interleaves
    // two receipts for the same request.
    results.push(await processOneRequest(dir, requestId, signerClient, { preflightAuthority }));
  }
  return results;
}

/** The long-running mode: poll `pending/` every `intervalMs` until `signal` aborts. Exists as its
 * own function (separate from the CLI's `run` glue) so a test can drive it directly with a short
 * interval and a real `AbortController`, without spawning a subprocess. */
export async function runWatch({ dir, signerClient, preflightAuthority, intervalMs = 5000, signal }) {
  ensureDirectories(dir);
  while (!signal?.aborted) {
    // eslint-disable-next-line no-await-in-loop -- a genuine sequential poll loop.
    await runOnePass({ dir, signerClient, preflightAuthority });
    if (signal?.aborted) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolveWait => {
      const timer = setTimeout(resolveWait, intervalMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolveWait(); }, { once: true });
    });
  }
}

export async function runCli(argv, { signal } = {}) {
  const { mode, options } = parseArgs(argv);
  if (!['once', 'watch'].includes(mode)) throw new Error(`unknown mode: ${mode ?? '(none)'}\n\n${USAGE}`);
  const dir = requireAbsolute(options.dir, '--dir');
  const signerClient = await buildSignerClient(options);
  if (mode === 'once') {
    const results = await runOnePass({ dir, signerClient });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return results;
  }
  const intervalMs = options['interval-ms'] ? Number(options['interval-ms']) : 5000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('--interval-ms must be a positive number');
  await runWatch({ dir, signerClient, intervalMs, signal });
  return undefined;
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(resolvePath(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  runCli(process.argv.slice(2), { signal: controller.signal }).catch(error => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
