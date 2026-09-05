// Reads the production composition's configuration from environment variables (and, for the one
// piece of real key material this process ever touches indirectly, an operator-supplied module
// path) — never from a file inside this repository, and never with a bundled default credential.
// Every field is validated against an exact schema (`readEnvironment` rejects unknown
// `HOOKEMON_*` variables and any recognized field whose value fails validation) before compose.mjs
// ever sees it.
//
// WP-33 additions (the signer/authority subsystem, packages/adapters/src/signing): this module now
// also reads (a) an optional keychain backend for the operator signer client — an alternative to
// `HOOKEMON_SIGNER_MODULE`, built through `../signing/keychain-signer.mjs`'s injected-`exec` seam,
// never by this module reading a key file — and (b) an optional standing-authority document path
// plus its owner and policy public-key PEM paths, loaded and fully verified through
// `../signing/standing-authority.mjs` against exactly the rules
// `packages/runner/src/cycle/authorization-provider.mjs`'s `StandingAuthorityProvider` enforces.
// `readEnvironment` remains the configuration boundary and `loadOperatorSignerClient` is a
// separate construction step. `bin/hookemon-runner.mjs` invokes it only after the selected
// profile passes repository, Keychain, policy, and canary readiness. Per decision D7, note what is
// deliberately absent here: no verifier-role signer client is ever constructed by this module or by
// `compose.mjs` — the verifier is `bin/hookemon-verifier.mjs`'s own, separate process and key.
//
// Secret material: `HOOKEMON_COLLECTOR_CRYPT_API_KEY` / `HOOKEMON_RELAY_API_KEY` are read from the
// environment (never written back anywhere, never logged, never placed in the journal — stage-driver
// evidence never carries a raw config value, only structured facts about what was read/would be
// done) and `HOOKEMON_SIGNER_MODULE` is a filesystem path to a module the *operator* controls,
// dynamically imported at startup exactly the way
// packages/runner/src/distribution/distribution-signer.mjs's `loadSignerClient` already does for
// the distribution-signer/verifier roles — this module holds no key material of its own and
// fabricates no default signer. `assertNoSecretLookingValue` additionally fails closed if any
// non-secret field (an RPC URL, an address, an interval) happens to look like raw key material (a
// 32/64-byte hex blob or a bip39-shaped word list) — a defense-in-depth check against the mistake of
// a key ending up pasted into the wrong environment variable.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  loadPublicKeyFromPemFile,
  loadVerifiedStandingAuthorityDocument,
} from '../signing/standing-authority.mjs';
import {
  createStandingAuthorityProvider,
  createStandingAuthorityStepAuthorizationResolver,
} from '../../../runner/src/cycle/authorization-provider.mjs';
import { canonicalJson, digest } from '../../../runner/src/cycle/journal.mjs';
import { assertMoneyConfiguration } from '../../../runner/src/cycle/money-schemas.mjs';

// Signing dependencies load only when a signer is actually constructed. Read-only configuration,
// repository status, and direct keychain readiness must not initialize the transaction-policy path.
const OPERATOR_EVM_ROLE = 'operator-evm';
const OPERATOR_SOLANA_ROLE = 'operator-solana';
const OPERATIONS_TRIGGER_ROLE = 'operations-trigger';
const DISTRIBUTION_SIGNER_ROLE = 'distribution-signer';
const STANDING_AUTHORITY_ARTIFACT_FILE = 'standing-authority-step-authorizations.json';

function readinessRequestDigest(request) {
  return digest(request);
}

const ALLOWED_ENV_VARS = Object.freeze([
  'HOOKEMON_STATE_DIR',
  'HOOKEMON_WORKER_OWNER',
  'HOOKEMON_LEASE_TTL_MS',
  'HOOKEMON_DEFAULT_INTERVAL_MS',
  'HOOKEMON_CHAIN_ID',
  'HOOKEMON_ROBINHOOD_RPC_URL',
  // A separate archive endpoint is mandatory in production for block-pinned ERC20 settlement
  // evidence. The public Robinhood endpoint is latest-only for contract state reads.
  'HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL',
  'HOOKEMON_SOLANA_RPC_URL',
  'HOOKEMON_RELAY_BASE_URL',
  'HOOKEMON_RELAY_API_KEY',
  // Exact Solana mint accepted by the outbound and return Relay legs. It is intentionally unset
  // by default: a live bridge request must bind a configured asset identity rather than assume a
  // ticker or a 1:1 substitute.
  'HOOKEMON_RELAY_SOLANA_MINT',
  // The configured mint's exact atomic-unit precision. A Relay quote is accepted only when its
  // own decimals agree with this typed asset metadata.
  'HOOKEMON_RELAY_SOLANA_DECIMALS',
  // Explicit local allowlist for the EVM Relay depository. It is intentionally unset by default:
  // an outbound signer must never accept a provider-supplied destination as its own authority.
  'HOOKEMON_RELAY_EVM_DEPOSITORY',
  'HOOKEMON_COLLECTOR_CRYPT_BASE_URL',
  'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
  'HOOKEMON_VAULT_ADDRESS',
  'HOOKEMON_HOOK_ADDRESS',
  'HOOKEMON_EVM_ACCOUNT',
  // Retained only to reject a legacy third EVM identity explicitly. Phase 3 Operations uses
  // exactly the EVM and Solana identities below.
  'HOOKEMON_OPERATIONS_TRIGGER_ACCOUNT',
  'HOOKEMON_SOLANA_ACCOUNT',
  'HOOKEMON_SIGNER_MODULE',
  'HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG',
  'HOOKEMON_BUDGET_PACK_PRICE_USDG',
  'HOOKEMON_BUDGET_OUTBOUND_CAP_USDG',
  'HOOKEMON_BUDGET_RETURN_CAP_USDG',
  'HOOKEMON_BUDGET_OPERATING_MARGIN_USDG',
  // WP-33: the operator signer client's backend selection. 'external-module' (default) is the
  // existing HOOKEMON_SIGNER_MODULE flow, unchanged. 'keychain' builds it instead from
  // HOOKEMON_KEYCHAIN_COMMAND/HOOKEMON_KEYCHAIN_EVM_ACCOUNT/HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT through
  // ../signing/keychain-signer.mjs. HOOKEMON_SIGNER_LIVE_MODE is a construction-time,
  // defense-in-depth gate on `loadOperatorSignerClient`'s own client (see its own doc comment) —
  // distinct from, and in addition to, the per-tick liveMode the scheduler/stage-driver already
  // gate on; it is not read or applied by `loadSignerClient` (the existing, unchanged entry point).
  'HOOKEMON_SIGNER_BACKEND',
  'HOOKEMON_SIGNER_LIVE_MODE',
  'HOOKEMON_KEYCHAIN_COMMAND',
  'HOOKEMON_KEYCHAIN_EVM_ACCOUNT',
  'HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT',
  // The owner-signed standing-authority document and public keys this process verifies before a
  // production signing boundary. All three are optional together; no private key is read here.
  'HOOKEMON_STANDING_AUTHORITY_PATH',
  'HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH',
  'HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH',
  // WP-35: the live stage paths' own configuration — the pack every automated cycle purchases (a
  // plain env var here is this package's own configuration seam pending real dashboard wiring, not
  // a guess) and the minimum-receive /
  // native-gas-cap floors `funding.mjs`'s `authorizeFunding` call and each action's own digest
  // (`stages/leg-actions.mjs`) are built from. Every value here is a validated configuration value,
  // never a fabricated on-chain fact — see stages/*.mjs's own headers for exactly how each is used.
  'HOOKEMON_PACK_CODE',
  'HOOKEMON_MIN_ROBINHOOD_RECEIVE',
  'HOOKEMON_MIN_SOLANA_RECEIVE',
  'HOOKEMON_MIN_RETURN_USDG',
  'HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD',
  'HOOKEMON_NATIVE_GAS_CAP_SOLANA',
  'HOOKEMON_EVM_GAS_PRICE_CAP',
  'HOOKEMON_EVM_NATIVE_RESERVE',
  'HOOKEMON_SOLANA_PRIORITY_FEE_CAP',
  'HOOKEMON_SOLANA_LAMPORT_RESERVE',
  'HOOKEMON_REHEARSAL_MODE',
  'HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS',
  'HOOKEMON_REHEARSAL_PAYOUT_SPLIT',
  'HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT',
  // An explicit provider mode prevents a caller from accidentally selecting test doubles for a
  // production profile, or live providers for the sealed collector-only rehearsal profile.
  'HOOKEMON_PROVIDER_MODE',
  // An approved, non-secret canary/start-preflight document. The runner reads and validates it
  // before constructing a transaction-capable signer.
  'HOOKEMON_OBSERVABILITY_CONFIG_PATH',
  // WP-36: distribution.mjs's own configuration. HOOKEMON_HKMN_ADDRESS is the HKMN token contract
  // (once launched); HOOKEMON_HKMN_DEPLOY_BLOCK bounds how far back getTransferLogs must page from
  // (never guessed — 0 by default, a correct but expensive-to-page starting point until an operator
  // supplies the real deploy block). HOOKEMON_DISTRIBUTION_DIR is the absolute directory this
  // process shares with the separate `bin/hookemon-verifier.mjs` process (pending/receipts/failed).
  'HOOKEMON_HKMN_ADDRESS',
  'HOOKEMON_HKMN_DEPLOY_BLOCK',
  'HOOKEMON_DISTRIBUTION_DIR',
  // WP-39: the production evidence profile's own configuration. HOOKEMON_DISTRIBUTION_PROFILE is
  // 'fixture' (default — the existing Ed25519 local-pairing scheme, unchanged) or 'production' (the
  // vault's own EIP-712 secp256k1 dual signature, decision D7). HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS/
  // HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS are the two configured production identities — required
  // together when the profile is 'production'; this module never falls back to a fixture key.
  'HOOKEMON_DISTRIBUTION_PROFILE',
  'HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS',
  'HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS',
  // WP-37: the holder-snapshot exclusion set's own configuration. HOOKEMON_TREASURY_ADDRESS is
  // the current treasury fee-liability beneficiary — genuinely owner-rotatable on-chain
  // (`MoneyRoles.sol`'s `proposeTreasury`/`acceptTreasury`), so it can only ever be supplied as
  // current configuration, never derived. HOOKEMON_POOL_ADDRESS is a canonical-pool-adjacent
  // custody address fallback for when `bindings/robinhood-chain.json`'s `market.poolKey` does not
  // yet carry one (true today — `status: "INTEGRATION_PENDING"`); the pool manager itself (which
  // actually holds every Uniswap v4 pool's token balance, canonical USDG/HKMN pool included) is
  // always read from that binding file directly, needing no env var. HOOKEMON_EXCLUDED_HOLDER_
  // ADDRESSES is an additional, operator-supplied, comma-separated exclusion list — validated and
  // de-duplicated here so a malformed entry fails closed at construction, never silently.
  'HOOKEMON_TREASURY_ADDRESS',
  'HOOKEMON_POOL_ADDRESS',
  'HOOKEMON_EXCLUDED_HOLDER_ADDRESSES',
  // Dashboard-only: not read by this module. `bin/hookemon-runner.mjs run` reads these separately,
  // through packages/dashboard/src/server.mjs's own `readEnvironmentConfig`, to compose the dashboard
  // control service in the same process (compose.mjs's `config.dashboard`) unless --no-dashboard is
  // given. Listed here only so `assertNoUnknownVars` below does not reject them when both readers see
  // the same `process.env`.
  'HOOKEMON_DASHBOARD_STATE_PATH',
  'HOOKEMON_DASHBOARD_PROXY_CREDENTIAL',
  'HOOKEMON_DASHBOARD_PROFILE',
  'HOOKEMON_DASHBOARD_PORT',
  'HOOKEMON_DASHBOARD_SQLITE_PATH',
  'HOOKEMON_DASHBOARD_AUDIT_LOG_PATH',
  'HOOKEMON_DASHBOARD_ACCESS_JWKS_URL',
  'HOOKEMON_DASHBOARD_ACCESS_ISSUER',
  'HOOKEMON_DASHBOARD_ACCESS_AUDIENCE',
]);
const ALLOWED_ENV_SET = new Set(ALLOWED_ENV_VARS);

const DEFAULT_LEASE_TTL_MS = 90_000;
const DEFAULT_CHAIN_ID = 4663;
const DEFAULT_ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_RELAY_BASE_URL = 'https://api.relay.link';
const DEFAULT_COLLECTOR_CRYPT_BASE_URL = 'https://gacha.collectorcrypt.com';

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const urlPattern = /^https:\/\//;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const packCodePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A bare 32-byte or 64-byte hex string (with or without 0x) is exactly the shape of a raw EVM/ed25519
// private key or a Solana secret-key seed — never a valid value for any of this schema's own fields
// (URLs start with https://, addresses are 20-byte 0x-prefixed, ids are short alnum tokens), so its
// presence anywhere in the resolved config is treated as a probable secret-material mistake.
const rawKeyLookingPattern = /^(0x)?[0-9a-fA-F]{64}$|^(0x)?[0-9a-fA-F]{128}$/;
const EXECUTION_PROFILES = new Set(['inspection', 'production', 'rehearsal']);
const PROVIDER_MODES = new Set(['live', 'fake']);
const REHEARSAL_MODES = new Set(['collector-only', 'relay-roundtrip']);
let cachedFrozenUsdg = null;

export class EnvironmentConfigurationError extends Error {}

export class MoneyConfigurationRejected extends EnvironmentConfigurationError {
  constructor(message, { cause } = {}) {
    super(`MoneyConfigurationRejected: ${message}`, { cause });
    this.name = 'MoneyConfigurationRejected';
  }
}

function fail(message) {
  throw new EnvironmentConfigurationError(message);
}

function assertNoUnknownVars(env) {
  const unknown = Object.keys(env).filter(key => key.startsWith('HOOKEMON_') && !ALLOWED_ENV_SET.has(key));
  if (unknown.length > 0) fail(`unknown HOOKEMON_* environment variable(s): ${unknown.sort().join(', ')}`);
}

function assertNoSecretLookingValue(value, label) {
  if (typeof value === 'string' && rawKeyLookingPattern.test(value.trim())) {
    fail(`${label} looks like raw key material and is refused; this process only ever accepts key material through an injected signer module (HOOKEMON_SIGNER_MODULE)`);
  }
}

function readString(env, name, { required = false, defaultValue = null } = {}) {
  const raw = Object.hasOwn(env, name) ? env[name] : undefined;
  if (raw === undefined || raw === '') {
    if (required) fail(`${name} is required`);
    return defaultValue;
  }
  assertNoSecretLookingValue(raw, name);
  return raw;
}

function assertExecutionProfile(profile) {
  if (!EXECUTION_PROFILES.has(profile)) {
    fail('execution profile must be "inspection", "production", or "rehearsal"');
  }
  return profile;
}

function requireExplicit(env, names) {
  for (const name of names) readString(env, name, { required: true });
}

function requireProfileInputs(env, profile) {
  if (profile === 'inspection') return;
  const moneyFields = [
    'HOOKEMON_CHAIN_ID',
    'HOOKEMON_ROBINHOOD_RPC_URL',
    'HOOKEMON_SOLANA_RPC_URL',
    'HOOKEMON_EVM_ACCOUNT',
    'HOOKEMON_SOLANA_ACCOUNT',
    'HOOKEMON_SIGNER_BACKEND',
    'HOOKEMON_SIGNER_LIVE_MODE',
    'HOOKEMON_KEYCHAIN_COMMAND',
    'HOOKEMON_KEYCHAIN_EVM_ACCOUNT',
    'HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT',
    'HOOKEMON_PACK_CODE',
    'HOOKEMON_MIN_ROBINHOOD_RECEIVE',
    'HOOKEMON_MIN_SOLANA_RECEIVE',
    'HOOKEMON_MIN_RETURN_USDG',
    'HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD',
    'HOOKEMON_NATIVE_GAS_CAP_SOLANA',
    'HOOKEMON_EVM_GAS_PRICE_CAP',
    'HOOKEMON_EVM_NATIVE_RESERVE',
    'HOOKEMON_SOLANA_PRIORITY_FEE_CAP',
    'HOOKEMON_SOLANA_LAMPORT_RESERVE',
    'HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG',
    'HOOKEMON_BUDGET_PACK_PRICE_USDG',
    'HOOKEMON_BUDGET_OUTBOUND_CAP_USDG',
    'HOOKEMON_BUDGET_RETURN_CAP_USDG',
    'HOOKEMON_BUDGET_OPERATING_MARGIN_USDG',
    'HOOKEMON_PROVIDER_MODE',
  ];
  requireExplicit(env, moneyFields);
  if (profile === 'production') {
    requireExplicit(env, [
      'HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL',
      'HOOKEMON_RELAY_BASE_URL',
      'HOOKEMON_RELAY_API_KEY',
      'HOOKEMON_RELAY_SOLANA_MINT',
      'HOOKEMON_RELAY_SOLANA_DECIMALS',
      'HOOKEMON_RELAY_EVM_DEPOSITORY',
      'HOOKEMON_EVM_ACCOUNT',
      'HOOKEMON_VAULT_ADDRESS',
      'HOOKEMON_HOOK_ADDRESS',
      'HOOKEMON_COLLECTOR_CRYPT_BASE_URL',
      'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
    ]);
  } else {
    const providerMode = readString(env, 'HOOKEMON_PROVIDER_MODE', { required: true });
    if (providerMode === 'fake') {
      requireExplicit(env, [
        'HOOKEMON_REHEARSAL_MODE',
        'HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS',
        'HOOKEMON_REHEARSAL_PAYOUT_SPLIT',
        'HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT',
        'HOOKEMON_RELAY_SOLANA_MINT',
        'HOOKEMON_RELAY_SOLANA_DECIMALS',
      ]);
    } else if (providerMode === 'live') {
      if (readString(env, 'HOOKEMON_REHEARSAL_MODE', { defaultValue: null }) === 'relay-roundtrip') return;
      requireExplicit(env, [
        'HOOKEMON_RELAY_BASE_URL',
        'HOOKEMON_RELAY_API_KEY',
        'HOOKEMON_RELAY_SOLANA_MINT',
        'HOOKEMON_RELAY_SOLANA_DECIMALS',
        'HOOKEMON_RELAY_EVM_DEPOSITORY',
        'HOOKEMON_EVM_ACCOUNT',
        'HOOKEMON_VAULT_ADDRESS',
        'HOOKEMON_HOOK_ADDRESS',
        'HOOKEMON_COLLECTOR_CRYPT_BASE_URL',
        'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
      ]);
    }
  }
}

function readUrl(env, name, { defaultValue }) {
  const value = readString(env, name, { defaultValue });
  if (value === null) return null;
  if (!urlPattern.test(value)) fail(`${name} must be an https:// URL`);
  return value;
}

function readPositiveInteger(env, name, { defaultValue }) {
  const raw = readString(env, name, { defaultValue: null });
  if (raw === null) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

function readAssetDecimals(env, name, { defaultValue = null } = {}) {
  const raw = readString(env, name, { defaultValue: null });
  if (raw === null) return defaultValue;
  if (!decimalPattern.test(raw)) fail(`${name} must be a canonical unsigned decimal string`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 255) fail(`${name} must be an integer from 0 through 255`);
  return value;
}

function readEvmAddress(env, name) {
  const raw = readString(env, name, { defaultValue: null });
  if (raw === null) return null;
  if (!evmAddressPattern.test(raw)) fail(`${name} must be a 0x-prefixed 20-byte EVM address`);
  return raw;
}

function readFrozenUsdgBinding() {
  if (cachedFrozenUsdg !== null) return cachedFrozenUsdg;
  const bindingUrl = new URL('../../../../bindings/robinhood-chain.json', import.meta.url);
  let binding;
  try {
    binding = JSON.parse(readFileSync(bindingUrl, 'utf8'));
  } catch {
    fail('frozen USDG binding is unreadable');
  }
  const chainId = binding?.chain?.chainId;
  const address = binding?.contracts?.usdg?.address;
  const decimals = binding?.contracts?.usdg?.metadata?.decimals;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || typeof address !== 'string' || !evmAddressPattern.test(address)
    || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    fail('frozen USDG binding is invalid');
  }
  cachedFrozenUsdg = Object.freeze({ chainId, address: address.toLowerCase(), decimals });
  return cachedFrozenUsdg;
}

function readSolanaAddress(value, name) {
  if (typeof value !== 'string' || !solanaAddressPattern.test(value)) {
    fail(`${name} must be a base58 Solana address`);
  }
  return value;
}

function readRehearsal(env, solanaAccount) {
  const mode = readString(env, 'HOOKEMON_REHEARSAL_MODE', { defaultValue: null });
  const recipientsRaw = readString(env, 'HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS', { defaultValue: null });
  const split = readString(env, 'HOOKEMON_REHEARSAL_PAYOUT_SPLIT', { defaultValue: 'equal' });
  const proceedsAccountRaw = readString(env, 'HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT', { defaultValue: null });
  if (mode === null) {
    if (recipientsRaw !== null) fail('HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS requires HOOKEMON_REHEARSAL_MODE');
    if (Object.hasOwn(env, 'HOOKEMON_REHEARSAL_PAYOUT_SPLIT')) {
      fail('HOOKEMON_REHEARSAL_PAYOUT_SPLIT requires HOOKEMON_REHEARSAL_MODE');
    }
    if (proceedsAccountRaw !== null) fail('HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT requires HOOKEMON_REHEARSAL_MODE');
    return null;
  }
  if (!REHEARSAL_MODES.has(mode)) fail('HOOKEMON_REHEARSAL_MODE must be "collector-only" or "relay-roundtrip"');
  if (!solanaAccount) fail(`HOOKEMON_SOLANA_ACCOUNT is required in ${mode} rehearsal mode`);
  readSolanaAddress(solanaAccount, 'HOOKEMON_SOLANA_ACCOUNT');
  if (recipientsRaw === null) fail(`HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS is required in ${mode} rehearsal mode`);
  if (split !== 'equal') fail('HOOKEMON_REHEARSAL_PAYOUT_SPLIT must be "equal"');
  const rawRecipients = recipientsRaw.split(',').map(value => value.trim());
  if (rawRecipients.length < 1 || rawRecipients.length > 50 || rawRecipients.some(value => value === '')) {
    fail('HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS must contain 1 to 50 comma-separated addresses');
  }
  const recipients = [];
  const seen = new Set();
  for (const recipient of rawRecipients) {
    readSolanaAddress(recipient, 'HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS entry');
    if (recipient === solanaAccount) fail('HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS must not include HOOKEMON_SOLANA_ACCOUNT');
    if (seen.has(recipient)) fail('HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS must contain distinct addresses');
    seen.add(recipient);
    recipients.push(recipient);
  }
  const rehearsal = { mode, payoutRecipients: Object.freeze(recipients), split };
  if (proceedsAccountRaw !== null) {
    const proceedsAccount = readSolanaAddress(proceedsAccountRaw, 'HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT');
    if (proceedsAccount === solanaAccount) {
      fail('HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT must be distinct from HOOKEMON_SOLANA_ACCOUNT');
    }
    if (seen.has(proceedsAccount)) {
      fail('HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT must be distinct from each payout recipient');
    }
    rehearsal.proceedsAccount = proceedsAccount;
  }
  return Object.freeze(rehearsal);
}

/** Every field decideCycleBudget (packages/runner/src/automation/budget-gate.mjs) needs, each a
 * canonical unsigned-decimal atomic-USDG string. Defaults are the same conservative "never ready to
 * spend" posture state-schema.mjs's own default operator configuration documents:
 * `availableProcessUsdg: '0'` — a positive `packPriceUsdg` (budget-gate itself requires it to be
 * positive) with zero available process liability means `decideCycleBudget` never reports `ready`
 * until the operator explicitly configures a real available balance. */
function readBudgetAmount(env, name, { defaultValue }) {
  const raw = readString(env, name, { defaultValue: null });
  if (raw === null) return defaultValue;
  if (!decimalPattern.test(raw)) fail(`${name} must be a canonical unsigned decimal string`);
  return raw;
}

function freezeTypedAmount(value) {
  return Object.freeze({ ...value });
}

function freezeMoneyConfiguration(value) {
  return Object.freeze({
    schema: value.schema,
    assets: Object.freeze({
      usdg: Object.freeze({ ...value.assets.usdg }),
      solanaStablecoin: Object.freeze({ ...value.assets.solanaStablecoin }),
    }),
    minimums: Object.freeze({
      robinhoodReceive: freezeTypedAmount(value.minimums.robinhoodReceive),
      solanaReceive: freezeTypedAmount(value.minimums.solanaReceive),
      returnUsdg: freezeTypedAmount(value.minimums.returnUsdg),
    }),
    evm: Object.freeze({
      perTransactionGasPriceCap: freezeTypedAmount(value.evm.perTransactionGasPriceCap),
      nativeReserve: freezeTypedAmount(value.evm.nativeReserve),
    }),
    solana: Object.freeze({
      priorityFeeCap: freezeTypedAmount(value.solana.priorityFeeCap),
      lamportReserve: freezeTypedAmount(value.solana.lamportReserve),
    }),
  });
}

/** Validates the canonical MoneyConfigurationV1 at the environment boundary. */
export function validateMoneyConfiguration(value) {
  try {
    return freezeMoneyConfiguration(assertMoneyConfiguration(value));
  } catch (error) {
    throw new MoneyConfigurationRejected(error.message, { cause: error });
  }
}

function buildMoneyConfiguration({ profile, chainId, frozenUsdg, relaySolanaMint, relaySolanaDecimals, minimums, evmGasPriceCap, evmNativeReserve, solanaPriorityFeeCap, solanaLamportReserve }) {
  if (profile === 'inspection') return null;
  if (relaySolanaMint === null || relaySolanaDecimals === null) {
    throw new MoneyConfigurationRejected('configured Solana stablecoin asset metadata is required');
  }
  const usdg = Object.freeze({
    chainId: String(chainId),
    assetId: frozenUsdg.address,
    decimals: frozenUsdg.decimals,
  });
  const solanaStablecoin = Object.freeze({
    chainId: '792703809',
    assetId: relaySolanaMint,
    decimals: relaySolanaDecimals,
  });
  const evmNative = Object.freeze({ chainId: usdg.chainId, assetId: 'native', decimals: 18 });
  const solanaNative = Object.freeze({ chainId: solanaStablecoin.chainId, assetId: 'native', decimals: 9 });
  const solanaPriorityFee = Object.freeze({
    chainId: solanaStablecoin.chainId,
    assetId: 'microlamports-per-compute-unit',
    decimals: 0,
  });
  return validateMoneyConfiguration({
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: minimums.robinhoodReceive },
      solanaReceive: { ...solanaStablecoin, amountAtomic: minimums.solanaReceive },
      returnUsdg: { ...usdg, amountAtomic: minimums.returnUsdg },
    },
    evm: {
      perTransactionGasPriceCap: { ...evmNative, amountAtomic: evmGasPriceCap },
      nativeReserve: { ...evmNative, amountAtomic: evmNativeReserve },
    },
    solana: {
      priorityFeeCap: { ...solanaPriorityFee, amountAtomic: solanaPriorityFeeCap },
      lamportReserve: { ...solanaNative, amountAtomic: solanaLamportReserve },
    },
  });
}

/**
 * WP-37: `HOOKEMON_EXCLUDED_HOLDER_ADDRESSES` — a comma-separated operator exclusion list. Every
 * entry must be a well-formed 0x EVM address (whitespace around a comma is tolerated; an empty
 * entry, e.g. a trailing comma, is refused rather than silently skipped, so a copy/paste mistake
 * fails loudly at construction instead of quietly excluding one fewer address than intended).
 * Returns a sorted, de-duplicated, lower-cased array — `[]` when unset.
 */
function readExcludedHolderAddresses(env, name) {
  const raw = readString(env, name, { defaultValue: null });
  if (raw === null) return Object.freeze([]);
  const parts = raw.split(',').map(part => part.trim());
  const seen = new Set();
  for (const part of parts) {
    if (!evmAddressPattern.test(part)) fail(`${name} contains a malformed entry: ${JSON.stringify(part)} is not a 0x-prefixed 20-byte EVM address`);
    seen.add(part.toLowerCase());
  }
  return Object.freeze([...seen].sort());
}

function readAbsolutePath(env, name, { required }) {
  const raw = readString(env, name, { required });
  if (raw === null) return null;
  if (!isAbsolute(raw)) fail(`${name} must be an absolute path`);
  return raw;
}

function readJsonObjectFile(env, name, { required = false } = {}) {
  const path = readAbsolutePath(env, name, { required });
  if (path === null) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${name} must name a readable JSON object`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} must name a JSON object`);
  }
  return Object.freeze(value);
}

/**
 * Dynamically imports an operator-supplied signer module (never a path inside this repository's own
 * tree in any real deployment, though nothing here enforces that beyond documentation — the module
 * itself is the seam, see packages/adapters/README.md). The module must export
 * `createSignerClient()` (or a default factory) returning `{ evm, solana }`, each either `null` or
 * `{ sign }`/whatever shape the concrete stage-driver mutation for that chain expects — mirroring
 * `packages/runner/src/distribution/distribution-signer.mjs`'s `loadSignerClient` convention exactly
 * (own doc comment there: "This is the only place a real key could ever enter the process, and it
 * happens only on explicit invocation with an explicit path — never implicitly, never with a bundled
 * default.").
 */
export async function loadSignerClient(modulePath) {
  if (modulePath === null) return null;
  const moduleUrl = pathToFileURL(resolvePath(modulePath)).href;
  const loaded = await import(moduleUrl);
  const factory = loaded.createSignerClient ?? loaded.default;
  if (typeof factory !== 'function') {
    fail(`signer module "${modulePath}" must export createSignerClient() or a default factory`);
  }
  const signerClient = await factory();
  if (!signerClient || typeof signerClient !== 'object' || Array.isArray(signerClient)) {
    fail(`signer module "${modulePath}" factory must return a plain object`);
  }
  return signerClient;
}

/**
 * Runs the two sign-only readiness probes directly through the keychain command. This deliberately
 * precedes `loadOperatorSignerClient`: startup can prove both Operations identities are available
 * before it constructs anything capable of signing or broadcasting a transaction.
 *
 * @param {ReturnType<typeof readEnvironment>} config
 * @param {(call: {command: string, args: string[], input: string, timeoutMs: number}) => Promise<{code:number,stdout:string,stderr?:string}>} options.exec
 */
export async function probeKeychainOperations(config, { exec } = {}) {
  if (!config || config.signer?.backend !== 'keychain') {
    fail('keychain Operations readiness requires the keychain signer backend');
  }
  if (typeof exec !== 'function') fail('probeKeychainOperations requires an injected exec(...) function');
  const { command, evmAccount, solanaAccount } = config.signer.keychain;
  const probe = async (role, account) => {
    const payload = { kind: 'hookemon-keychain-sign-only-readiness.v1' };
    const input = `${JSON.stringify({
      operation: 'probe',
      role,
      account,
      digest: readinessRequestDigest(payload),
      request: { encoding: 'json', data: payload },
    })}\n`;
    let result;
    try {
      result = await exec({
        command,
        args: ['probe', '--role', role, '--account', account],
        input,
        timeoutMs: 10_000,
      });
    } catch {
      fail(`keychain readiness probe failed for ${role}`);
    }
    if (!result || result.code !== 0) fail(`keychain readiness probe failed for ${role}`);
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      fail(`keychain readiness probe returned invalid JSON for ${role}`);
    }
    if (!response || typeof response !== 'object' || response.ready !== true) {
      fail(`keychain readiness probe did not confirm readiness for ${role}`);
    }
    return Object.freeze({ ready: true });
  };
  const evm = await probe(OPERATOR_EVM_ROLE, evmAccount);
  const solana = await probe(OPERATOR_SOLANA_ROLE, solanaAccount);
  return Object.freeze({ [OPERATOR_EVM_ROLE]: evm, [OPERATOR_SOLANA_ROLE]: solana });
}

/**
 * Reads and validates the full composition configuration from `env` (defaults to `process.env`).
 * Returns a plain object shaped exactly for `compose.mjs`'s `compose(config)`. Never reads
 * `HOOKEMON_SIGNER_MODULE`'s target file itself here — resolving that module (and therefore ever
 * touching real key material) is `loadSignerClient`'s job, called separately by the CLI once this
 * function has finished validating everything else.
 */
export function readEnvironment(env = process.env, { profile = 'inspection', dryRun = false } = {}) {
  assertNoUnknownVars(env);
  assertExecutionProfile(profile);
  if (typeof dryRun !== 'boolean') fail('dryRun must be a boolean');
  if (dryRun && profile !== 'production') fail('dryRun requires the production profile');
  requireProfileInputs(env, profile);

  const stateDir = readAbsolutePath(env, 'HOOKEMON_STATE_DIR', { required: true });
  const workerOwner = readString(env, 'HOOKEMON_WORKER_OWNER', { defaultValue: 'hookemon-runner' });
  if (!ownerPattern.test(workerOwner)) fail('HOOKEMON_WORKER_OWNER must be a short alphanumeric identifier');
  const leaseTtlMs = readPositiveInteger(env, 'HOOKEMON_LEASE_TTL_MS', { defaultValue: DEFAULT_LEASE_TTL_MS });
  const defaultIntervalMs = readPositiveInteger(env, 'HOOKEMON_DEFAULT_INTERVAL_MS', { defaultValue: 1_200_000 });
  const chainId = readPositiveInteger(env, 'HOOKEMON_CHAIN_ID', { defaultValue: DEFAULT_CHAIN_ID });
  const frozenUsdg = readFrozenUsdgBinding();
  if (chainId !== frozenUsdg.chainId) fail('HOOKEMON_CHAIN_ID must match the frozen USDG binding chainId');

  const robinhoodRpcUrl = readUrl(env, 'HOOKEMON_ROBINHOOD_RPC_URL', { defaultValue: DEFAULT_ROBINHOOD_RPC_URL });
  const robinhoodArchiveRpcUrl = readUrl(env, 'HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL', { defaultValue: null });
  if (profile === 'production' && robinhoodArchiveRpcUrl === robinhoodRpcUrl) {
    fail('HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL must be distinct from HOOKEMON_ROBINHOOD_RPC_URL');
  }
  const solanaRpcUrl = readUrl(env, 'HOOKEMON_SOLANA_RPC_URL', { defaultValue: DEFAULT_SOLANA_RPC_URL });
  const relayBaseUrl = readUrl(env, 'HOOKEMON_RELAY_BASE_URL', { defaultValue: DEFAULT_RELAY_BASE_URL });
  const relayApiKey = readString(env, 'HOOKEMON_RELAY_API_KEY', { defaultValue: null });
  const relaySolanaMintRaw = readString(env, 'HOOKEMON_RELAY_SOLANA_MINT', { defaultValue: null });
  const relaySolanaMint = relaySolanaMintRaw === null ? null : readSolanaAddress(relaySolanaMintRaw, 'HOOKEMON_RELAY_SOLANA_MINT');
  const relaySolanaDecimals = readAssetDecimals(env, 'HOOKEMON_RELAY_SOLANA_DECIMALS');
  const relayEvmDepository = readEvmAddress(env, 'HOOKEMON_RELAY_EVM_DEPOSITORY');
  const collectorCryptBaseUrl = readUrl(env, 'HOOKEMON_COLLECTOR_CRYPT_BASE_URL', { defaultValue: DEFAULT_COLLECTOR_CRYPT_BASE_URL });
  const collectorCryptApiKey = readString(env, 'HOOKEMON_COLLECTOR_CRYPT_API_KEY', { defaultValue: null });

  const vaultAddress = readEvmAddress(env, 'HOOKEMON_VAULT_ADDRESS');
  const hookAddress = readEvmAddress(env, 'HOOKEMON_HOOK_ADDRESS');
  const treasuryAddress = readEvmAddress(env, 'HOOKEMON_TREASURY_ADDRESS');
  const poolAddress = readEvmAddress(env, 'HOOKEMON_POOL_ADDRESS');
  const excludedHolderAddresses = readExcludedHolderAddresses(env, 'HOOKEMON_EXCLUDED_HOLDER_ADDRESSES');
  const evmAccount = readEvmAddress(env, 'HOOKEMON_EVM_ACCOUNT');
  const legacyOperationsTriggerAccount = readString(env, 'HOOKEMON_OPERATIONS_TRIGGER_ACCOUNT', { defaultValue: null });
  if (legacyOperationsTriggerAccount !== null) {
    fail('HOOKEMON_OPERATIONS_TRIGGER_ACCOUNT is not supported; use HOOKEMON_EVM_ACCOUNT for the Operations EVM identity');
  }
  const solanaAccount = readString(env, 'HOOKEMON_SOLANA_ACCOUNT', { defaultValue: null });
  if (solanaAccount !== null) readSolanaAddress(solanaAccount, 'HOOKEMON_SOLANA_ACCOUNT');
  const rehearsal = readRehearsal(env, solanaAccount);

  const signerModulePath = readString(env, 'HOOKEMON_SIGNER_MODULE', { defaultValue: null });
  if (signerModulePath !== null && !isAbsolute(signerModulePath)) fail('HOOKEMON_SIGNER_MODULE must be an absolute path');

  const signerBackend = readString(env, 'HOOKEMON_SIGNER_BACKEND', { defaultValue: 'external-module' });
  if (!['external-module', 'keychain'].includes(signerBackend)) fail('HOOKEMON_SIGNER_BACKEND must be "external-module" or "keychain"');
  const signerLiveModeRaw = readString(env, 'HOOKEMON_SIGNER_LIVE_MODE', { defaultValue: 'false' });
  if (!['true', 'false'].includes(signerLiveModeRaw)) fail('HOOKEMON_SIGNER_LIVE_MODE must be "true" or "false"');
  const keychainCommand = readAbsolutePath(env, 'HOOKEMON_KEYCHAIN_COMMAND', { required: signerBackend === 'keychain' });
  const keychainEvmAccount = readString(env, 'HOOKEMON_KEYCHAIN_EVM_ACCOUNT', { defaultValue: null });
  const keychainSolanaAccount = readString(env, 'HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT', { defaultValue: null });
  if (signerBackend === 'keychain' && (!keychainEvmAccount || !keychainSolanaAccount)) {
    fail('HOOKEMON_KEYCHAIN_EVM_ACCOUNT and HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT are both required when HOOKEMON_SIGNER_BACKEND is "keychain"');
  }

  const providerMode = readString(env, 'HOOKEMON_PROVIDER_MODE', { defaultValue: null });
  if (providerMode !== null && !PROVIDER_MODES.has(providerMode)) {
    fail('HOOKEMON_PROVIDER_MODE must be "live" or "fake"');
  }

  if (profile === 'production') {
    if (rehearsal !== null) fail('production profile refuses HOOKEMON_REHEARSAL_MODE');
    if (dryRun) {
      if (providerMode !== 'fake') fail('production dryRun requires HOOKEMON_PROVIDER_MODE=fake');
    } else {
      if (providerMode !== 'live') fail('production profile requires HOOKEMON_PROVIDER_MODE=live');
      if (signerBackend !== 'keychain') fail('production profile requires HOOKEMON_SIGNER_BACKEND=keychain');
      if (signerLiveModeRaw !== 'true') fail('production profile requires HOOKEMON_SIGNER_LIVE_MODE=true');
      if (keychainEvmAccount !== 'operator-evm' || keychainSolanaAccount !== 'operator-solana') {
        fail('production profile requires the operator-evm and operator-solana keychain identities');
      }
    }
    if (evmAccount === null || solanaAccount === null) {
      fail('production profile requires both Operations identities');
    }
    if (relaySolanaMint === null || relayEvmDepository === null) {
      fail('production profile requires explicit USDG and Solana stablecoin asset routes');
    }
  }
  if (profile === 'rehearsal') {
    if (providerMode === 'fake') {
      if (rehearsal === null || rehearsal.proceedsAccount === undefined) {
        fail('fake rehearsal requires HOOKEMON_REHEARSAL_MODE and HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT');
      }
      if (signerLiveModeRaw === 'true') fail(`${rehearsal.mode} rehearsal refuses a live signer`);
      if (relayApiKey !== null || relayEvmDepository !== null || vaultAddress !== null || hookAddress !== null
        || collectorCryptApiKey !== null) {
        fail(`${rehearsal.mode} rehearsal refuses production bridge, contract, and provider credentials`);
      }
    } else if (providerMode === 'live') {
      if (rehearsal?.mode === 'relay-roundtrip') {
        fail('relay-roundtrip rehearsal requires HOOKEMON_PROVIDER_MODE=fake');
      }
      if (rehearsal !== null) fail('live rehearsal refuses the collector-only rehearsal flags');
      if (evmAccount === null || solanaAccount === null || relaySolanaMint === null || relayEvmDepository === null) {
        fail('live rehearsal requires both Operations identities and explicit bridge asset routes');
      }
      if (signerLiveModeRaw !== 'true') fail('live rehearsal requires HOOKEMON_SIGNER_LIVE_MODE=true');
      fail('live rehearsal is unavailable until the dedicated Solana proceeds projection is integrated');
    } else {
      fail('rehearsal profile requires HOOKEMON_PROVIDER_MODE=live or HOOKEMON_PROVIDER_MODE=fake');
    }
  }

  const standingAuthorityPath = readAbsolutePath(env, 'HOOKEMON_STANDING_AUTHORITY_PATH', { required: false });
  const standingAuthorityOwnerPublicKeyPath = readAbsolutePath(env, 'HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH', { required: false });
  const standingAuthorityPolicyPublicKeyPath = readAbsolutePath(env, 'HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH', { required: false });
  const standingAuthorityPaths = [
    standingAuthorityPath,
    standingAuthorityOwnerPublicKeyPath,
    standingAuthorityPolicyPublicKeyPath,
  ];
  if (standingAuthorityPaths.some(path => path === null) && standingAuthorityPaths.some(path => path !== null)) {
    fail('HOOKEMON_STANDING_AUTHORITY_PATH, HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH, and HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH must be set together');
  }
  const observability = readJsonObjectFile(env, 'HOOKEMON_OBSERVABILITY_CONFIG_PATH', {
    required: profile !== 'inspection',
  });

  const packCode = readString(env, 'HOOKEMON_PACK_CODE', { defaultValue: null });
  if (packCode !== null && !packCodePattern.test(packCode)) fail('HOOKEMON_PACK_CODE must be a lowercase pack code');
  const minimums = Object.freeze({
    robinhoodReceive: readBudgetAmount(env, 'HOOKEMON_MIN_ROBINHOOD_RECEIVE', { defaultValue: '0' }),
    solanaReceive: readBudgetAmount(env, 'HOOKEMON_MIN_SOLANA_RECEIVE', { defaultValue: '0' }),
    returnUsdg: readBudgetAmount(env, 'HOOKEMON_MIN_RETURN_USDG', { defaultValue: '0' }),
  });
  const nativeGasCaps = Object.freeze({
    robinhood: readBudgetAmount(env, 'HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD', { defaultValue: '0' }),
    solana: readBudgetAmount(env, 'HOOKEMON_NATIVE_GAS_CAP_SOLANA', { defaultValue: '0' }),
  });
  const moneyConfiguration = buildMoneyConfiguration({
    profile,
    chainId,
    frozenUsdg,
    relaySolanaMint,
    relaySolanaDecimals,
    minimums,
    evmGasPriceCap: readBudgetAmount(env, 'HOOKEMON_EVM_GAS_PRICE_CAP', { defaultValue: null }),
    evmNativeReserve: readBudgetAmount(env, 'HOOKEMON_EVM_NATIVE_RESERVE', { defaultValue: null }),
    solanaPriorityFeeCap: readBudgetAmount(env, 'HOOKEMON_SOLANA_PRIORITY_FEE_CAP', { defaultValue: null }),
    solanaLamportReserve: readBudgetAmount(env, 'HOOKEMON_SOLANA_LAMPORT_RESERVE', { defaultValue: null }),
  });

  const hkmnAddress = readEvmAddress(env, 'HOOKEMON_HKMN_ADDRESS');
  const hkmnDeployBlockRaw = readBudgetAmount(env, 'HOOKEMON_HKMN_DEPLOY_BLOCK', { defaultValue: '0' });
  const distributionDir = readAbsolutePath(env, 'HOOKEMON_DISTRIBUTION_DIR', { required: false });
  const distributionProfile = readString(env, 'HOOKEMON_DISTRIBUTION_PROFILE', { defaultValue: 'fixture' });
  if (!['fixture', 'production'].includes(distributionProfile)) fail('HOOKEMON_DISTRIBUTION_PROFILE must be "fixture" or "production"');
  const distributionSignerAddress = readEvmAddress(env, 'HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS');
  const distributionVerifierAddress = readEvmAddress(env, 'HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS');
  if (distributionProfile === 'production' && (!distributionSignerAddress || !distributionVerifierAddress)) {
    fail('HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS and HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS are both required when HOOKEMON_DISTRIBUTION_PROFILE is "production"');
  }
  if (distributionSignerAddress && distributionVerifierAddress && distributionSignerAddress.toLowerCase() === distributionVerifierAddress.toLowerCase()) {
    fail('HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS and HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS must be distinct EVM identities');
  }

  const budget = Object.freeze({
    availableProcessUsdg: readBudgetAmount(env, 'HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG', { defaultValue: '0' }),
    packPriceUsdg: readBudgetAmount(env, 'HOOKEMON_BUDGET_PACK_PRICE_USDG', { defaultValue: '0' }),
    outboundCapUsdg: readBudgetAmount(env, 'HOOKEMON_BUDGET_OUTBOUND_CAP_USDG', { defaultValue: '0' }),
    returnCapUsdg: readBudgetAmount(env, 'HOOKEMON_BUDGET_RETURN_CAP_USDG', { defaultValue: '0' }),
    operatingMarginUsdg: readBudgetAmount(env, 'HOOKEMON_BUDGET_OPERATING_MARGIN_USDG', { defaultValue: '0' }),
  });

  return Object.freeze({
    stateDir,
    workerOwner,
    leaseTtlMs,
    defaultIntervalMs,
    chainId,
    execution: Object.freeze({ profile, networkProfile: 'mainnet', providerMode: providerMode ?? 'live', dryRun }),
    robinhood: Object.freeze({ rpcUrl: robinhoodRpcUrl, archiveRpcUrl: robinhoodArchiveRpcUrl }),
    solana: Object.freeze({ rpcUrl: solanaRpcUrl }),
    relay: Object.freeze({
      baseUrl: relayBaseUrl,
      apiKey: relayApiKey,
      solanaMint: relaySolanaMint,
      evmDepository: relayEvmDepository,
    }),
    collectorCrypt: Object.freeze({ baseUrl: collectorCryptBaseUrl, apiKey: collectorCryptApiKey }),
    contracts: Object.freeze({
      vault: vaultAddress,
      hook: hookAddress,
      usdg: frozenUsdg.address,
      usdgDecimals: frozenUsdg.decimals,
      treasury: treasuryAddress,
      pool: poolAddress,
    }),
    accounts: Object.freeze({ evm: evmAccount, solana: solanaAccount }),
    budget,
    signerModulePath,
    signer: Object.freeze({
      backend: signerBackend,
      liveMode: signerLiveModeRaw === 'true',
      keychain: Object.freeze({ command: keychainCommand, evmAccount: keychainEvmAccount, solanaAccount: keychainSolanaAccount }),
    }),
    standingAuthority: Object.freeze({
      documentPath: standingAuthorityPath,
      ownerPublicKeyPath: standingAuthorityOwnerPublicKeyPath,
      policyPublicKeyPath: standingAuthorityPolicyPublicKeyPath,
    }),
    pack: Object.freeze({ code: packCode }),
    moneyConfiguration,
    // Compatibility projection for pre-revision-63 consumers. It cannot satisfy the explicit
    // MoneyConfigurationV1 controls above and will be removed after all stages read typed values.
    minimums,
    nativeGasCaps,
    rehearsal,
    hkmn: Object.freeze({ address: hkmnAddress, deployBlock: BigInt(hkmnDeployBlockRaw) }),
    distribution: Object.freeze({
      dir: distributionDir,
      excludedHolderAddresses,
      profile: distributionProfile,
      signerAddress: distributionSignerAddress,
      verifierAddress: distributionVerifierAddress,
    }),
    observability,
  });
}

/**
 * WP-33 addition: an alternative to `loadSignerClient` for the operator's `{ evm, solana }` client,
 * offering the keychain backend (`config.signer.backend === 'keychain'`) alongside the existing
 * external-module flow, both wrapped with the construction-time `HOOKEMON_SIGNER_LIVE_MODE` gate
 * (`config.signer.liveMode`) — a defense-in-depth check distinct from the scheduler's own per-tick
 * liveMode gate, enforced by `../signing/signer-client.mjs`'s `wrapSignerClient` itself, not by this
 * function. `bin/hookemon-runner.mjs` invokes it only after the selected profile has passed
 * repository, Keychain, policy, and canary readiness.
 *
 * WP-36 addition: the external-module backend may also export a `distributionSigner` client — a
 * distinct role (decision D7: never the operator's own `evm`/`solana` key, and this function still
 * never constructs a `verifier`-role client at all, matching this module's own header note). The
 * keychain backend does not offer this role today (documented scope boundary, not an oversight):
 * the distribution-signer is meant to run at a lower, semi-manual cadence on separate custody, not
 * wired to the same always-on keychain command the operator's own broadcast keys use.
 *
 * A signer module must expose at most the two Operations clients (`evm` and `solana`). Legacy
 * third Operations signers are refused before wrapping so no configuration can reactivate them.
 *
 * @param {ReturnType<typeof readEnvironment>} config
 * @param {(call: {command: string, args: string[], input: string}) => Promise<{code:number,stdout:string,stderr?:string}>} [options.exec] -
 *   required only when `config.signer.backend === 'keychain'`; this function never spawns a
 *   process itself (see `keychain-signer.mjs`'s own header for why).
 * @param {object} [options.preflightAuthority] - exact Node test-runner fixture authority passed
 *   through to signer wrappers. Production callers omit it and revalidate current authority at
 *   each mutation.
 * @returns {Promise<{evm: object|null, solana: object|null, distributionSigner: object|null}>}
 */
export async function loadOperatorSignerClient(config, { exec, preflightAuthority } = {}) {
  if (config.signer.backend === 'keychain') {
    if (typeof exec !== 'function') fail('loadOperatorSignerClient requires an injected exec(...) function for the keychain backend');
    const { command, evmAccount, solanaAccount } = config.signer.keychain;
    const { createKeychainSignerClient } = await import('../signing/keychain-signer.mjs');
    return {
      evm: createKeychainSignerClient({ role: OPERATOR_EVM_ROLE, liveMode: config.signer.liveMode, preflightAuthority, exec, command, account: evmAccount }),
      solana: createKeychainSignerClient({ role: OPERATOR_SOLANA_ROLE, liveMode: config.signer.liveMode, preflightAuthority, exec, command, account: solanaAccount }),
      distributionSigner: null,
    };
  }
  const raw = await loadSignerClient(config.signerModulePath);
  if (raw === null) return { evm: null, solana: null, distributionSigner: null };
  if (raw.operationsTrigger) {
    fail('external signer module exports a third Operations signer; this is not supported');
  }
  if (config.signer.liveMode === true && (raw.evm || raw.solana)) {
    fail('live Operations signer loading requires pinned transaction policies and trusted decode context');
  }
  const { wrapSignerClient } = await import('../signing/signer-client.mjs');
  return {
    evm: raw.evm ? wrapSignerClient({ role: OPERATOR_EVM_ROLE, liveMode: config.signer.liveMode, inner: raw.evm, preflightAuthority }) : null,
    solana: raw.solana ? wrapSignerClient({ role: OPERATOR_SOLANA_ROLE, liveMode: config.signer.liveMode, inner: raw.solana, preflightAuthority }) : null,
    distributionSigner: raw.distributionSigner ? wrapSignerClient({ role: DISTRIBUTION_SIGNER_ROLE, liveMode: config.signer.liveMode, inner: raw.distributionSigner, preflightAuthority }) : null,
  };
}

function readPrivateStandingAuthorityArtifact(path) {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    fail('standing authority artifact is required for the production profile');
  }
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o600) {
    fail('standing authority artifact must be a private regular file');
  }
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    fail('standing authority artifact requires no-follow file support');
  }
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') fail('standing authority artifact must be a private regular file');
    fail('standing authority artifact could not be read');
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600) {
      fail('standing authority artifact must be a private regular file');
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('standing authority artifact changed while opening');
    }
    try {
      return readFileSync(fd, 'utf8');
    } catch {
      fail('standing authority artifact could not be read');
    }
  } finally {
    closeSync(fd);
  }
}

function loadPersistedStandingAuthorityArtifact(stateDir, authorityDigest) {
  const path = join(stateDir, STANDING_AUTHORITY_ARTIFACT_FILE);
  const text = readPrivateStandingAuthorityArtifact(path);
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch {
    fail('standing authority artifact is not valid JSON');
  }
  try {
    if (`${canonicalJson(artifact)}\n` !== text) fail('standing authority artifact must use canonical JSON');
    return createStandingAuthorityStepAuthorizationResolver({ authorityDigest, artifact });
  } catch (error) {
    if (error instanceof EnvironmentConfigurationError) throw error;
    fail(`standing authority artifact is invalid: ${error.message}`);
  }
  return undefined;
}

/**
 * Loads and verifies `config.standingAuthority`'s configured document and its policy public-key
 * binding, then creates the production provider used at each live signing boundary. Production
 * additionally requires a private, canonical, state-directory artifact whose entries are bound to
 * the verified document digest and contain only already policy-signed step intents. Returns `null`
 * only when authority material is intentionally absent; a live signing request then fails closed in
 * stage-driver before the signer can be reached.
 *
 * @param {ReturnType<typeof readEnvironment>} config
 */
export function loadStandingAuthority(config) {
  if (config.standingAuthority.documentPath === null) return null;
  const document = loadVerifiedStandingAuthorityDocument({
    documentPath: config.standingAuthority.documentPath,
    ownerPublicKeyPath: config.standingAuthority.ownerPublicKeyPath,
  });
  const ownerPublicKey = loadPublicKeyFromPemFile(config.standingAuthority.ownerPublicKeyPath);
  const policyPublicKey = loadPublicKeyFromPemFile(config.standingAuthority.policyPublicKeyPath);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey, policyPublicKey });
  const resolveStepAuthorization = config.execution.profile === 'production'
    ? loadPersistedStandingAuthorityArtifact(config.stateDir, document.documentDigest)
    : null;
  return Object.freeze({
    ...document,
    provider,
    ...(resolveStepAuthorization === null ? {} : { resolveStepAuthorization }),
  });
}
