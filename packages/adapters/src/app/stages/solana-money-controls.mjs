import { readSolBalance, SOLANA_RELAY_CHAIN_ID } from '../../solana-rpc.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import { assertMoneyConfiguration, assertTypedAmount } from '../../../../runner/src/cycle/money-schemas.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const microLamportsPerLamport = 1_000_000n;

// MoneyConfigurationV1's Relay-namespaced identity for the same mint/decimals the native
// Collector settlement asset trades in production (docs/modules/composition-root.md:99-106):
// Relay numbers Solana `792703809`, never `solana-mainnet`.
const PRODUCTION_RELAY_SOLANA_STABLECOIN_ASSET = Object.freeze({
  ...COLLECTOR_CRYPT_SETTLEMENT_ASSET,
  chainId: String(SOLANA_RELAY_CHAIN_ID),
});

function sameAsset(left, right) {
  return left?.chainId === right?.chainId
    && left?.assetId === right?.assetId
    && left?.decimals === right?.decimals;
}

function positiveAtomic(value, label) {
  if (typeof value !== 'string' || !canonicalUnsignedInteger.test(value) || value === '0') {
    throw new Error(`${label} must be a positive canonical atomic amount`);
  }
  return BigInt(value);
}

function priorityFee(decoded, stage) {
  if (!decoded || typeof decoded !== 'object') {
    throw new Error(`${stage} decoded transaction is invalid`);
  }
  if (decoded.priorityFee === null) return null;
  const value = decoded.priorityFee;
  if (!value || typeof value !== 'object' || typeof value.amountAtomic !== 'string'
    || !canonicalUnsignedInteger.test(value.amountAtomic)) {
    throw new Error(`${stage} decoded priority fee is invalid`);
  }
  return value;
}

function maximumPriorityFeeLamports(decoded, stage) {
  const fee = priorityFee(decoded, stage);
  if (fee === null) return 0n;
  const computeUnitLimit = positiveAtomic(decoded.gas?.computeUnitLimit, `${stage} decoded compute-unit limit`);
  return ((computeUnitLimit * BigInt(fee.amountAtomic)) + (microLamportsPerLamport - 1n)) / microLamportsPerLamport;
}

/**
 * Validates the canonical configuration against the Solana asset a signer can spend.
 *
 * `asset` is the native Collector/signing identity (chain id `solana-mainnet`, from
 * `COLLECTOR_CRYPT_SETTLEMENT_ASSET`); `money.assets.solanaStablecoin` is necessarily typed in
 * MoneyConfigurationV1's own Relay namespace (chain id `792703809`) in production. Both name the
 * same mint and decimals but are never the same chain id, by design
 * (docs/modules/composition-root.md:99-106) -- so the two are compared through this one closed,
 * constant-backed mapping rather than by literal equality.
 */
export function assertSolanaSignerMoneyConfiguration({ config, asset, stage }) {
  let money;
  try {
    money = assertMoneyConfiguration(config?.moneyConfiguration, `${stage} money configuration`);
  } catch (error) {
    throw new Error(`${stage} requires MoneyConfigurationV1: ${error.message}`);
  }
  if (!sameAsset(asset, COLLECTOR_CRYPT_SETTLEMENT_ASSET) || config?.solana?.chainId !== asset?.chainId) {
    throw new Error(`${stage} Solana signing asset does not match the trusted native Collector settlement identity`);
  }
  const expectedMoneyConfigurationAsset = config?.execution?.profile === 'production'
    ? PRODUCTION_RELAY_SOLANA_STABLECOIN_ASSET
    : COLLECTOR_CRYPT_SETTLEMENT_ASSET;
  if (!sameAsset(money.assets.solanaStablecoin, expectedMoneyConfigurationAsset)) {
    throw new Error(`${stage} MoneyConfigurationV1 Solana asset does not match the configured settlement asset`);
  }
  return money;
}

/**
 * Normalizes a durably admitted Solana purchase amount into the native Collector settlement asset.
 *
 * An admitted amount (e.g. `admission.unitPurchase`, packages/adapters/src/app/compose.mjs) is
 * necessarily typed in whatever asset `assertSolanaSignerMoneyConfiguration` already validated as
 * `money.assets.solanaStablecoin` for this execution profile: the production Relay tuple (chain id
 * `792703809`) or, in every non-production profile, the native Collector tuple (chain id
 * `solana-mainnet`). Comparing it to the native `asset` by literal equality, as purchase code once
 * did, refuses every real production admission before policy preflight ever runs. This is the one
 * place that maps an admitted amount typed in either namespace back onto the native tuple, in each
 * case accepting only the exact already-validated `money.assets.solanaStablecoin` tuple and
 * carrying the original canonical `amountAtomic` across unchanged.
 */
export function assertSolanaAdmittedPurchaseAmount({ money, asset, amount, label }) {
  const asserted = assertTypedAmount(amount, label);
  if (!sameAsset(asserted, money.assets.solanaStablecoin)) {
    throw new Error(`${label} does not match the configured MoneyConfigurationV1 Solana settlement asset`);
  }
  return { ...asset, amountAtomic: asserted.amountAtomic };
}

/**
 * Refuses an unaffordable or over-cap Solana priority-fee envelope before signing.
 *
 * The decoded fee is typed in the native decoder chain (`nativeChainId`, i.e. `config.solana.chainId`);
 * `money.solana.priorityFeeCap` is typed in MoneyConfigurationV1's Relay namespace. The cap's
 * chain id is therefore never compared to the decoded fee's -- only asset id, decimals, and
 * amount are, against the already-validated MoneyConfigurationV1 cap.
 */
export async function assertSolanaSignerFeeEnvelope({ client, owner, money, decoded, nativeChainId, stage }) {
  const fee = priorityFee(decoded, stage);
  if (fee !== null) {
    const cap = money.solana.priorityFeeCap;
    if (fee.chainId !== nativeChainId || fee.assetId !== cap.assetId || fee.decimals !== cap.decimals
      || BigInt(fee.amountAtomic) > BigInt(cap.amountAtomic)) {
      throw new Error(`${stage} priority fee exceeds the configured MoneyConfigurationV1 cap`);
    }
  }
  const required = BigInt(money.solana.lamportReserve.amountAtomic) + maximumPriorityFeeLamports(decoded, stage);
  const balance = await readSolBalance(client, owner);
  if (balance < required) {
    throw new Error(`${stage} Operations SOL balance does not retain the configured lamport reserve after the maximum priority fee`);
  }
}
