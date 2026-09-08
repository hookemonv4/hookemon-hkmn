import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCollectorPurchaseBindingV1 } from './collector-purchase-policy.mjs';
import { assertCollectorBuybackBindingV1 } from './collector-buyback-policy.mjs';

export const COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA = 'hookemon.collector-production-binding-registry.v1';
export const COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA = 'hookemon.collector-production-binding-entry.v1';
export const COLLECTOR_PRODUCTION_BINDING_REGISTRY_VERSION = 1;
export const COLLECTOR_PRODUCTION_BINDING_ENTRY_VERSION = 1;

/** The only authority ever entitled to gate a real operator broadcast. No entry using this
 * identity is approved anywhere in this repository, and none exists that is independently pinned
 * outside the bytes it would gate. Both `loadCollectorProductionBindingRegistry` and
 * `resolveCollectorProductionBinding` refuse this identity unconditionally: a caller cannot supply
 * live authority beside its own bytes and recompute a matching digest, because that only proves
 * self-consistency, never independent approval. This constant exists so the refusal, and any future
 * separately pinned live-authority mechanism, has a single named identity to refer to -- it grants
 * nothing by itself. */
export const COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE = 'live';

/** Explicitly distinguishable from `COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE`: an entry using
 * this identity can only ever be resolved after `assertCollectorOfflineExecutionBoundary` passes
 * every one of its independent, composite checks. It can never authorize a live deployment. */
export const COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE = 'synthetic-offline';

const REGISTRY_AUTHORITIES = Object.freeze([
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE,
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
]);
const REGISTRY_STAGES = Object.freeze(['purchase', 'buyback']);
const REGISTRY_FIELDS = Object.freeze(['schema', 'version', 'entries']);
const ENTRY_FIELDS = Object.freeze(['schema', 'version', 'authority', 'stage', 'chainId', 'provider', 'binding', 'expectedDigest']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
// URL#hostname brackets a literal IPv6 host ("[::1]"), it never returns the bare form; both are
// listed so the loopback check matches what the URL API actually produces.
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOCAL_PROTOCOLS = new Set(['http:', 'https:']);
const STAGE_BINDING_VALIDATORS = Object.freeze({
  purchase: assertCollectorPurchaseBindingV1,
  buyback: assertCollectorBuybackBindingV1,
});
/** Fixed, module-root-derived paths to the real production Keychain wire-protocol child, the real
 * wallet-generation CLI, and the reviewed isolated fake `security` command -- never a
 * caller-supplied path. `createIsolatedKeychainChildSetup` always spawns exactly these files, so
 * no caller-selected copy (whose top-level bytes might match while its relative imports or
 * interpreter do not) and no caller-chosen security backend (real or otherwise) can ever be
 * substituted. */
const KEYCHAIN_SIGNER_BIN_URL = new URL('../../bin/hookemon-keychain-signer.mjs', import.meta.url);
const WALLET_BIN_URL = new URL('../../bin/hookemon-wallet.mjs', import.meta.url);
const SECURITY_FIXTURE_URL = new URL('../../test/fixtures/keychain/security', import.meta.url);

/** The exact, fixed set of variables `createIsolatedKeychainChildSetup` ever places in a spawned
 * child's environment. Asserted against the actually-constructed environment object immediately
 * before every spawn (`assertAllowlistedChildEnv`), so a future edit that starts spreading extra
 * variables in -- `NODE_OPTIONS`, `NODE_PATH`, a caller-supplied `PATH`, or anything else -- fails
 * loudly instead of silently widening what an isolated evidence run's child processes can see or
 * load. */
const CHILD_ENV_ALLOWED_KEYS = Object.freeze(new Set([
  'PATH',
  'HOOKEMON_OPERATIONS_SECURITY_COMMAND',
  'HOOKEMON_TEST_KEYCHAIN_RECORD_PATH',
  'HOOKEMON_TEST_KEYCHAIN_STORE_PATH',
  'HOOKEMON_TEST_KEYCHAIN_PATH',
  'HOOKEMON_TEST_KEYCHAIN_PID_PATH',
  'HOOKEMON_TEST_KEYCHAIN_MODE',
]));

/** Module-private capability set: only `createIsolatedKeychainChildSetup`'s own return value is
 * ever a member. `assertOfflineSignerCapability` requires membership rather than matching a caller
 * label or a hash of caller-supplied bytes, so a lookalike object built any other way is refused
 * regardless of what its fields claim. */
const OWNED_ISOLATED_CHILD_SETUPS = new WeakSet();

/**
 * Fixed synthetic credential values `environment.mjs` requires for the Collector/Relay inline API
 * keys whenever the synthetic-offline authority is selected -- a caller cannot pass through an
 * arbitrary or real credential value merely because every endpoint is loopback. Exported so the
 * one isolated fixture setup that ever legitimately supplies these values (the ordinary CLI's own
 * synthetic launch) uses the identical literal, not a re-typed copy.
 */
export const COLLECTOR_SYNTHETIC_API_KEY = 'hookemon-synthetic-offline-collector-key';
export const RELAY_SYNTHETIC_API_KEY = 'hookemon-synthetic-offline-relay-key';

/** Every config field an actual production-profile transport call reads (`buildAdapters`,
 * `packages/adapters/src/app/compose.mjs`): the Collector API, the primary and archive Robinhood
 * RPCs (the archive endpoint is not optional in the production profile --
 * `assertProductionHistoricalEvidenceClient` refuses a null historical evidence client), the Solana
 * RPC, and the Relay base URL. Listed explicitly, rather than "whatever happens to be set", so a
 * missing endpoint refuses instead of silently passing this check while `buildAdapters` still goes
 * on to construct a client from whatever default the field would otherwise carry. */
const REQUIRED_LOCAL_ENDPOINT_FIELDS = Object.freeze([
  ['collectorCrypt', 'baseUrl'],
  ['robinhood', 'rpcUrl'],
  ['robinhood', 'archiveRpcUrl'],
  ['solana', 'rpcUrl'],
  ['relay', 'baseUrl'],
]);

export class CollectorProductionBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectorProductionBindingError';
  }
}

function fail(message) {
  throw new CollectorProductionBindingError(message);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, fields, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function parseRegistryInput(registryInput) {
  if (typeof registryInput === 'string') {
    try {
      return JSON.parse(registryInput);
    } catch {
      fail('Collector production binding registry text must be valid JSON');
    }
  }
  if (registryInput === null || typeof registryInput !== 'object' || Array.isArray(registryInput)) {
    fail('Collector production binding registry must be JSON text or a plain object');
  }
  return registryInput;
}

/**
 * Validates and digest-verifies every entry of a Collector production binding registry, using the
 * same strict per-stage schema/digest validators the purchase and buyback policy factories already
 * enforce. Never trusts a digest stored beside its own bytes as approval: each entry's
 * `expectedDigest` is checked by the stage validator against that entry's own `binding` content,
 * exactly the way `assertCollectorPurchaseBindingV1`/`assertCollectorBuybackBindingV1` already
 * require from any other caller -- this loader adds no alternate trust path.
 *
 * An entry declaring `COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE` refuses to load at all: proving
 * that bytes match a digest supplied beside those same bytes is only self-consistency, never
 * independent approval, and no separate live-authority pinning mechanism exists in this codebase to
 * check against instead. `resolveCollectorProductionBinding` refuses that authority unconditionally
 * too, so this is not deferred to a resolve-time check a mutated registry object could bypass.
 */
export function loadCollectorProductionBindingRegistry(registryInput) {
  const parsed = parseRegistryInput(registryInput);
  exactKeys(parsed, REGISTRY_FIELDS, 'Collector production binding registry');
  if (parsed.schema !== COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA) {
    fail('Collector production binding registry schema is invalid');
  }
  if (parsed.version !== COLLECTOR_PRODUCTION_BINDING_REGISTRY_VERSION) {
    fail('Collector production binding registry version is invalid');
  }
  if (!Array.isArray(parsed.entries)) fail('Collector production binding registry entries must be an array');

  const seen = new Set();
  const entries = parsed.entries.map((entry, index) => {
    const label = `Collector production binding registry entries[${index}]`;
    exactKeys(entry, ENTRY_FIELDS, label);
    if (entry.schema !== COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA) fail(`${label}.schema is invalid`);
    if (entry.version !== COLLECTOR_PRODUCTION_BINDING_ENTRY_VERSION) fail(`${label}.version is invalid`);
    if (!REGISTRY_AUTHORITIES.includes(entry.authority)) fail(`${label}.authority is invalid`);
    // No independently pinned live-authority mechanism exists outside this same JSON payload, so a
    // caller cannot grant itself live authority by choosing bytes, recomputing expectedDigest to
    // match them, and labeling the result "live" -- that only proves internal consistency. Refuse
    // unconditionally at load time rather than deferring to a resolve-time check that a mutated or
    // substituted registry object could bypass.
    if (entry.authority === COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE) {
      fail(`${label}.authority "live" is never approved: no independently pinned live entry exists in this codebase`);
    }
    if (!REGISTRY_STAGES.includes(entry.stage)) fail(`${label}.stage is invalid`);
    if (entry.chainId !== 'solana-mainnet') fail(`${label}.chainId is invalid`);
    if (entry.provider !== 'collector-crypt') fail(`${label}.provider is invalid`);
    if (typeof entry.expectedDigest !== 'string' || !DIGEST_PATTERN.test(entry.expectedDigest)) {
      fail(`${label}.expectedDigest must be a canonical sha256 digest`);
    }
    const identity = `${entry.authority}\u0000${entry.stage}`;
    if (seen.has(identity)) fail(`${label} duplicates an already declared authority/stage identity`);
    seen.add(identity);
    const validate = STAGE_BINDING_VALIDATORS[entry.stage];
    const binding = validate(entry.binding, entry.expectedDigest);
    return Object.freeze({
      authority: entry.authority,
      stage: entry.stage,
      chainId: entry.chainId,
      provider: entry.provider,
      expectedDigest: entry.expectedDigest,
      binding,
    });
  });

  return deepFreeze({
    schema: parsed.schema,
    version: parsed.version,
    entries,
  });
}

function readNestedField(config, [section, field]) {
  return config?.[section]?.[field];
}

/**
 * Requires `value` to be present -- a missing or null endpoint refuses, it is never treated as "not
 * used" -- and to be an explicit loopback `http:`/`https:` URL carrying no embedded userinfo. This
 * proves the configured endpoint field is local; it does not by itself prove the constructed
 * transport client can never be redirected outward at request time (a raw HTTP client following a
 * redirect is a transport-confinement concern this static field check cannot resolve, and is not
 * claimed as covered here).
 */
function assertLocalOnlyUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`offline execution boundary requires an explicit local endpoint for ${label}`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL to check for the offline execution boundary`);
  }
  if (!LOCAL_PROTOCOLS.has(parsed.protocol)) {
    fail(`offline execution boundary refuses the non-HTTP endpoint protocol for ${label}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail(`offline execution boundary refuses embedded userinfo in ${label}`);
  }
  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    fail(`offline execution boundary refuses the nonlocal endpoint ${label}`);
  }
}

/** `directory` must be an absolute, existing, non-symlinked directory -- the root every fixed
 * store/record path and the wrapper itself live inside. A symlinked root could quietly redirect
 * all of those writes and reads somewhere the caller does not control, defeating every later fixed
 * path built from it. */
function assertIsolatedRootDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0 || !directory.startsWith('/')) {
    fail('isolated child setup requires an absolute isolated root directory');
  }
  let stats;
  try {
    stats = lstatSync(directory);
  } catch {
    fail('isolated child setup requires an existing isolated root directory');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail('isolated child setup requires a real directory, not a symlink');
  }
}

/**
 * Refuses to spawn any wallet/security child if one of this setup's own fixed store/record/pid
 * paths inside `directory` already exists as a symlink or other nonregular file. The checked-in
 * fake `security` fixture follows these paths via plain `readFileSync`/`writeFileSync`/
 * `appendFileSync`, and it appends to the record path before it even dispatches on the requested
 * command -- so a symlinked path there would quietly redirect a real read or write outside
 * `directory` before the first wallet subprocess is even spawned, not just after. An absent path is
 * fine (a fresh isolated root has none of these yet, and a later `mkdirSync`/`writeFileSync` inside
 * the fixture creates it as an ordinary file); an already-existing ordinary regular file is fine (an
 * ordinary restart reopening its own prior store).
 */
function assertRegularOrAbsentChildPath(path, label) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail(`isolated child setup refuses a nonregular ${label} path`);
  }
}

/** Refuses to run with any environment key this module did not itself put there. `env` is always
 * built entirely by `createIsolatedKeychainChildSetup` from fixed inputs -- this exists as a
 * standing guard against a future edit accidentally spreading in something wider (a caller
 * environment, `NODE_OPTIONS`, an inherited `PATH`), not because any caller input reaches this
 * check today. */
function assertAllowlistedChildEnv(env) {
  for (const key of Object.keys(env)) {
    if (!CHILD_ENV_ALLOWED_KEYS.has(key)) fail(`isolated child setup refuses the non-allowlisted child environment variable "${key}"`);
  }
}

function execIsolatedChild(command, args, env) {
  return new Promise(resolveExec => {
    execFile(command, args, { encoding: 'utf8', env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
      resolveExec({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Reopens an already-provisioned ephemeral identity from a prior launch (`wallet show`) so a
 * restarted CLI process reuses the same fixture-backed keys instead of minting a replacement pair
 * every time it starts; only generates a fresh identity (`wallet generate`) the first time a given
 * isolated root is used, when nothing is stored there yet. Both calls run through the same real,
 * unmodified `bin/hookemon-wallet.mjs`, against the same fixed security backend and minimal
 * allowlisted environment. */
async function readOrGenerateIdentity({ walletBinPath, securityCommandPath, childEnv, identity }) {
  const shown = await execIsolatedChild(process.execPath, [
    walletBinPath, 'show', '--identity', identity, '--keychain-command', securityCommandPath,
  ], childEnv);
  if (shown.code === 0 && shown.stdout.trim().length > 0) {
    try {
      return JSON.parse(shown.stdout);
    } catch {
      fail(`isolated child setup could not parse the stored ${identity} identity`);
    }
  }
  const generated = await execIsolatedChild(process.execPath, [
    walletBinPath, 'generate', '--identity', identity, '--keychain-command', securityCommandPath,
  ], childEnv);
  if (generated.code !== 0) {
    fail(`isolated child setup could not generate the ephemeral ${identity} identity: ${generated.stderr.trim() || 'unknown error'}`);
  }
  try {
    return JSON.parse(generated.stdout);
  } catch {
    fail(`isolated child setup could not parse the generated ${identity} identity`);
  }
}

function isolatedChildWrapperSource(signerBinPath, childEnv) {
  return [
    `#!${process.execPath}`,
    "import { spawn } from 'node:child_process';",
    `const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(signerBinPath)}, ...process.argv.slice(2)], { stdio: 'inherit', env: ${JSON.stringify(childEnv)} });`,
    "child.once('close', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));",
    '',
  ].join('\n');
}

function wrapperSourceDigest(source) {
  return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

/**
 * Constructs the one caller-visible executable an offline evidence run may configure as
 * `config.signer.keychain.command`, entirely from fixed inputs derived from this module's own
 * repository root and the caller-supplied isolated root directory -- there is no `securityCommand`
 * or `securityEnv` parameter to override: the security backend is always the reviewed isolated
 * fake `security` fixture at `SECURITY_FIXTURE_URL`, and its store/record paths are always fixed
 * subpaths of `directory`, never caller-chosen locations.
 *
 * - Resolves `bin/hookemon-keychain-signer.mjs`, `bin/hookemon-wallet.mjs`, and the fixture
 *   `security` command from this module's own `import.meta.url` root (`realpath`'d) -- never a
 *   caller-supplied path.
 * - Refuses a `directory` that does not exist, is not an absolute path, or is a symlink
 *   (`assertIsolatedRootDirectory`).
 * - Builds the fixed store/record paths inside `directory` and the minimal child environment
 *   (`HOOKEMON_OPERATIONS_SECURITY_COMMAND` plus the fixture's own `HOOKEMON_TEST_KEYCHAIN_*`
 *   variables, never a spread of this process's own `process.env`), and asserts that environment
 *   against a fixed allowlist before any subprocess is spawned (`assertAllowlistedChildEnv`).
 * - Refuses, before any subprocess is spawned, if the fixed store/record-log/pid paths already
 *   exist as a symlink or other nonregular file (`assertRegularOrAbsentChildPath`) -- an absent path
 *   or an ordinary regular file (a genuine restart reopening its own prior store) both pass.
 * - Reuses an already-provisioned identity from a prior launch at the same `directory` rather than
 *   minting a fresh one on every restart (`readOrGenerateIdentity`).
 * - Writes the wrapper deterministically (identical content for identical inputs, so a restart
 *   reusing the same `directory` reproduces the same file) and records a digest of its own written
 *   content on the returned object.
 *
 * The returned object is minted into `OWNED_ISOLATED_CHILD_SETUPS`; `assertOfflineSignerCapability`
 * requires that exact membership (never a value or shape match) and re-hashes the wrapper file at
 * the point of use against the digest captured here, so a lookalike object, or the same object
 * pointed at a since-modified wrapper file, is refused either way.
 */
export async function createIsolatedKeychainChildSetup({ directory }) {
  assertIsolatedRootDirectory(directory);

  const signerBinPath = await realpath(fileURLToPath(KEYCHAIN_SIGNER_BIN_URL));
  const walletBinPath = await realpath(fileURLToPath(WALLET_BIN_URL));
  const securityCommandPath = await realpath(fileURLToPath(SECURITY_FIXTURE_URL));
  const securityStats = lstatSync(securityCommandPath);
  if (securityStats.isSymbolicLink() || !securityStats.isFile()) {
    fail('isolated child setup requires the fixed security fixture to be a regular file');
  }

  // `PATH` is fixed to exactly the directory of the pinned Node interpreter actually running this
  // process (`process.execPath`'s own directory), never this process's inherited `process.env.PATH`
  // -- a helper spawned by the wallet/signer children (the macOS Keychain lookup shells out via
  // `/usr/bin/env node ...`) needs *some* PATH to resolve `node`, and this ties that resolution to
  // the same interpreter already pinned by `process.execPath` everywhere else in this function,
  // not to whatever directories a caller's environment happened to list.
  const childEnv = Object.freeze({
    PATH: dirname(process.execPath),
    HOOKEMON_OPERATIONS_SECURITY_COMMAND: securityCommandPath,
    HOOKEMON_TEST_KEYCHAIN_RECORD_PATH: join(directory, 'security-records.jsonl'),
    HOOKEMON_TEST_KEYCHAIN_STORE_PATH: join(directory, 'security-store.json'),
    HOOKEMON_TEST_KEYCHAIN_PATH: join(directory, 'login.keychain-db'),
    HOOKEMON_TEST_KEYCHAIN_PID_PATH: join(directory, 'security.pid'),
    HOOKEMON_TEST_KEYCHAIN_MODE: 'success',
  });
  assertAllowlistedChildEnv(childEnv);
  assertRegularOrAbsentChildPath(childEnv.HOOKEMON_TEST_KEYCHAIN_STORE_PATH, 'security store');
  assertRegularOrAbsentChildPath(childEnv.HOOKEMON_TEST_KEYCHAIN_RECORD_PATH, 'security record log');
  assertRegularOrAbsentChildPath(childEnv.HOOKEMON_TEST_KEYCHAIN_PID_PATH, 'security pid');

  const identities = {};
  for (const identity of ['operations-evm', 'operations-solana']) {
    identities[identity] = await readOrGenerateIdentity({ walletBinPath, securityCommandPath, childEnv, identity });
  }

  // Written read-only (0o500) and, on a reopened root, replaced by an atomic rename over the
  // existing file rather than an in-place overwrite -- `rename` only needs write permission on
  // `directory` itself, so a prior launch's read-only wrapper never blocks this one from
  // deterministically rewriting it (the content is identical anyway, since it is a pure function of
  // `directory`'s own fixed paths).
  const wrapperPath = join(directory, 'collector-isolated-keychain-child.mjs');
  const wrapperTempPath = join(directory, `.collector-isolated-keychain-child.${process.pid}.mjs`);
  const wrapperSource = isolatedChildWrapperSource(signerBinPath, childEnv);
  await writeFile(wrapperTempPath, wrapperSource, { mode: 0o500 });
  await rename(wrapperTempPath, wrapperPath);

  const setup = Object.freeze({
    command: wrapperPath,
    wrapperDigest: wrapperSourceDigest(wrapperSource),
    // Lowercased: the same normalized form the rest of this codebase compares/digests EVM
    // addresses in (see docs/modules -- a checksummed literal would never match a lowercase compare).
    evmAddress: String(identities['operations-evm']?.address ?? '').toLowerCase(),
    solanaPublicKey: identities['operations-solana']?.publicKey ?? null,
  });
  if (setup.evmAddress.length === 0 || setup.solanaPublicKey === null) {
    fail('isolated child setup did not receive both ephemeral identities');
  }
  OWNED_ISOLATED_CHILD_SETUPS.add(setup);
  return setup;
}

/**
 * Requires `config.signer.keychain.isolatedChildSetup` to be the exact object
 * `createIsolatedKeychainChildSetup` returned (module-private `WeakSet` membership, not a value or
 * shape match -- a caller cannot fabricate membership by reconstructing an identical-looking
 * object), `config.signer.keychain.command` to equal that same setup's own `command`, and the
 * wrapper file currently on disk at that path to still hash to the digest captured when it was
 * written -- so a writable wrapper that has since been edited cannot retain the brand its
 * unmodified original earned. Requires `config.signer.backend === 'keychain'` (the real child
 * protocol, never a fake signer substitute) and `config.signer.liveMode === true` -- the same live
 * signing protocol production itself requires whenever it is not a dry run, run here against the
 * isolated setup's own wrapper instead of a real Keychain. `liveMode` is not itself a
 * network/credential isolation boundary; the endpoint confinement and the authenticated,
 * re-verified wrapper around it are what make it safe.
 */
function assertOfflineSignerCapability(config) {
  if (config?.signer?.backend !== 'keychain') {
    fail('offline execution boundary requires the real Keychain signer backend');
  }
  if (config?.signer?.liveMode !== true) {
    fail('offline execution boundary requires the real live-signing protocol (config.signer.liveMode === true), run against the isolated child setup');
  }
  const setup = config?.signer?.keychain?.isolatedChildSetup;
  if (!OWNED_ISOLATED_CHILD_SETUPS.has(setup)) {
    fail('offline execution boundary requires the isolated child setup this module itself constructed');
  }
  if (config.signer.keychain.command !== setup.command) {
    fail('offline execution boundary Keychain command does not match its authenticated isolated setup');
  }
  let currentBytes;
  try {
    currentBytes = readFileSync(setup.command, 'utf8');
  } catch {
    fail('offline execution boundary could not read the isolated child wrapper file to verify it');
  }
  if (wrapperSourceDigest(currentBytes) !== setup.wrapperDigest) {
    fail('offline execution boundary refuses an isolated child wrapper that no longer matches its authenticated content');
  }
}

/**
 * Refuses to run unless every one of these independently checked facts holds together. Each is
 * individually insufficient by design (a single explicit "approved" flag, a lone localhost
 * Collector URL, a bare NODE_TEST_CONTEXT check, or the production profile name alone are all
 * refused elsewhere in this codebase as inadequate isolation): only the full composite -- the
 * explicit synthetic-offline authority selection, every actually-transport-read endpoint present
 * and resolving to an explicit loopback `http:`/`https:` URL with no embedded userinfo, an
 * authenticated (`WeakSet`-branded) isolated Keychain child setup this module itself constructed,
 * and the real live-signing protocol run against it -- is accepted as an offline execution
 * boundary. `NODE_TEST_CONTEXT` is never read here. No credential value is checked directly: since
 * every endpoint above is already pinned to loopback, whatever credential-shaped string is
 * configured can only ever reach the isolated local fixture behind it, never a real provider.
 *
 * This function proves the checked config fields are local and that the configured Keychain
 * command is exactly the wrapper `createIsolatedKeychainChildSetup` built; it does not itself
 * prove the constructed HTTP/RPC clients can never be redirected to a nonlocal origin at request
 * time (see `createLoopbackConfinedFetch`, which the caller must actually thread into the
 * constructed transport for that), nor anything about the wrapper's own runtime behavior beyond
 * what `createIsolatedKeychainChildSetup`'s fixed construction already guarantees.
 */
export function assertCollectorOfflineExecutionBoundary(config) {
  if (config?.execution?.profile !== 'production') {
    fail('offline execution boundary requires the real production execution profile');
  }
  if (config?.rehearsal !== null && config?.rehearsal !== undefined) {
    fail('offline execution boundary refuses rehearsal configuration');
  }
  if (config?.collectorCrypt?.productionBindingAuthority !== COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE) {
    fail('offline execution boundary requires the explicit synthetic-offline binding authority');
  }
  for (const path of REQUIRED_LOCAL_ENDPOINT_FIELDS) {
    assertLocalOnlyUrl(readNestedField(config, path), `${path[0]}.${path[1]}`);
  }
  assertOfflineSignerCapability(config);
}

/**
 * A small scoped `fetch` wrapper for exactly the offline execution boundary: refuses to send a
 * request whose URL is not an explicit loopback `http:`/`https:` URL (reusing the same check
 * `assertCollectorOfflineExecutionBoundary` applies to configured endpoints, so a client
 * constructed with an already-validated loopback `baseUrl` cannot be redirected to a different
 * origin through a request-time argument either), and refuses to silently follow a 3xx response
 * instead of returning it -- `collector-crypt.mjs`/`relay-client.mjs`/`solana-rpc.mjs` all accept
 * an injectable `fetchImpl`; `compose.mjs` threads this wrapper into the ones it constructs for the
 * `synthetic-offline` authority. This is not a generic HTTP hardening framework: it refuses exactly
 * the one behavior (following a redirect) that would let an isolated loopback endpoint hand a
 * client an outward-pointing URL to fetch next.
 */
export function createLoopbackConfinedFetch(baseFetch = globalThis.fetch) {
  if (typeof baseFetch !== 'function') fail('loopback-confined fetch requires a fetch implementation');
  return async function loopbackConfinedFetch(input, init = {}) {
    const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    assertLocalOnlyUrl(requestUrl, 'transport request URL');
    const response = await baseFetch(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      fail('offline execution boundary refuses a transport redirect response');
    }
    return response;
  };
}

/**
 * Resolves exactly one registry entry for `{ authority, stage }`, or refuses. A missing authority
 * or stage refuses before any intent write, provider generation, or signing -- this function is
 * meant to be called at that same preflight point the existing per-pack fixture-binding capture
 * already occupies, never after. The returned binding was already schema/digest-validated and
 * deep-frozen by `loadCollectorProductionBindingRegistry`; re-running the stage validator here
 * (`assertCollectorPurchaseBindingV1`/`assertCollectorBuybackBindingV1`) only reconfirms that
 * nothing mutated the loaded registry object since, it never re-derives trust from anything the
 * caller supplies fresh.
 */
export function resolveCollectorProductionBinding({ registry, authority, stage, config }) {
  plainObject(registry, 'Collector production binding registry');
  if (!REGISTRY_AUTHORITIES.includes(authority)) fail('Collector production binding authority is invalid');
  if (!REGISTRY_STAGES.includes(stage)) fail('Collector production binding stage is invalid');
  // Defense-in-depth against `loadCollectorProductionBindingRegistry`'s own load-time refusal: even
  // a registry object built or mutated some other way can never resolve live authority through this
  // function. No separately pinned live-authority mechanism exists to check against instead, so this
  // is an unconditional refusal, not a placeholder for one.
  if (authority === COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE) {
    fail('Collector production binding live authority is never approved: no independently pinned live entry exists in this codebase');
  }
  assertCollectorOfflineExecutionBoundary(config);
  const entry = registry.entries.find(candidate => candidate.authority === authority && candidate.stage === stage);
  if (entry === undefined) fail(`no Collector production binding is registered for authority "${authority}" and stage "${stage}"`);
  const validate = STAGE_BINDING_VALIDATORS[stage];
  const binding = validate(entry.binding, entry.expectedDigest);
  return Object.freeze({ binding, expectedDigest: entry.expectedDigest });
}
