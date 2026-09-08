// Narrow mutation admission for the owner-operated Collector-only rehearsal. This replaces the
// frozen generic production authority only for the sealed Solana-only configuration; every other
// caller remains subject to the generic authority check.
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
} from '../../runner/src/cycle/preflight.mjs';
import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  deriveAssociatedTokenAddress,
} from '../src/solana-rpc.mjs';

const PACK_PRICE_ATOMIC = '25000000';
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameAsset(value, asset) {
  return plainObject(value)
    && value.chainId === asset.chainId
    && value.assetId === asset.assetId
    && value.decimals === asset.decimals;
}

function canonicalPositiveAmount(value, asset, label, { exact = null } = {}) {
  if (!sameAsset(value, asset) || typeof value.amountAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.amountAtomic)
    || value.amountAtomic === '0' || (exact !== null && value.amountAtomic !== exact)) {
    throw new Error(`${label} is invalid for the live collector-only rehearsal`);
  }
  return value;
}

export function isLiveCollectorOnlyRehearsal(config) {
  return config?.execution?.profile === 'rehearsal'
    && config.execution?.providerMode === 'live'
    && config.rehearsal?.mode === 'collector-only';
}

function assertCollectorOnlyConfiguration(config) {
  const operator = config?.accounts?.solana;
  const asset = Object.freeze({ chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS });
  if (config?.accounts?.evm !== null || typeof operator !== 'string' || operator.length === 0
    || config?.solana?.chainId !== asset.chainId
    || typeof config?.pack?.code !== 'string' || config.pack.code.length === 0) {
    throw new Error('live collector-only rehearsal configuration is incomplete');
  }
  if (config?.signer?.backend !== 'keychain' || config.signer.liveMode !== true
    || !Array.isArray(config.signer.roles) || config.signer.roles.length !== 1 || config.signer.roles[0] !== 'operator-solana'
    || config.signer.keychain?.solanaAccount !== 'operator-solana') {
    throw new Error('live collector-only rehearsal requires the Operations Solana Keychain signer');
  }
  if (!sameAsset(config.collectorCrypt?.settlementAsset, asset)) {
    throw new Error('live collector-only rehearsal settlement asset is invalid');
  }
  canonicalPositiveAmount(config.collectorCrypt?.packPrice, asset, 'configured pack price', { exact: PACK_PRICE_ATOMIC });
  if (!sameAsset(config.moneyConfiguration?.assets?.solanaStablecoin, asset)) {
    throw new Error('live collector-only rehearsal typed money asset is invalid');
  }
  canonicalPositiveAmount(
    config.moneyConfiguration?.solana?.lamportReserve,
    { chainId: asset.chainId, assetId: 'native', decimals: 9 },
    'configured lamport reserve',
  );
  const proceeds = config.rehearsal?.proceedsAccount;
  const recipients = config.rehearsal?.payoutRecipients;
  if (typeof proceeds !== 'string' || !Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('live collector-only rehearsal requires a dedicated proceeds account and recipients');
  }
  let expectedProceeds;
  try {
    expectedProceeds = deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58();
  } catch {
    throw new Error('live collector-only rehearsal has an invalid Operations Solana account');
  }
  if (proceeds !== expectedProceeds) {
    throw new Error('live collector-only rehearsal requires the canonical dedicated proceeds account');
  }
  for (const recipient of recipients) {
    let recipientAccount;
    try {
      recipientAccount = deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT).toBase58();
    } catch {
      throw new Error('live collector-only rehearsal has an invalid payout recipient');
    }
    if (recipient === operator || recipientAccount === proceeds) {
      throw new Error('live collector-only rehearsal proceeds account must be distinct from every payout recipient');
    }
  }
  return Object.freeze({ profile: 'collector-only', operator, proceedsAccount: proceeds, asset });
}

/**
 * Assert the sealed Collector-only live configuration before an effect boundary. Production and
 * all other profiles preserve the generic frozen-interface authority check.
 *
 * `preflightAuthority` admits exactly one additional capability: the frozen singleton returned by
 * `createTestProfileMutationAuthority()`, forwarded unchanged from `stage-driver.mjs`, and only
 * while `NODE_TEST_CONTEXT` is present. Any other defined value -- a structural clone, an
 * unrelated object, a serialized config flag -- refuses rather than falling back to a live path.
 */
export function requireCollectorOnlyMutationAuthority(config, preflightAuthority) {
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('collector-only fixture authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (preflightAuthority !== undefined) throw new Error('collector-only fixture authority is invalid');
  if (!isLiveCollectorOnlyRehearsal(config)) return requireLiveMutationAuthority();
  return assertCollectorOnlyConfiguration(config);
}
