import { readSolBalance } from '../../solana-rpc.mjs';
import { assertMoneyConfiguration } from '../../../../runner/src/cycle/money-schemas.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const microLamportsPerLamport = 1_000_000n;

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

/** Validates the canonical configuration against the Solana asset a signer can spend. */
export function assertSolanaSignerMoneyConfiguration({ config, asset, stage }) {
  let money;
  try {
    money = assertMoneyConfiguration(config?.moneyConfiguration, `${stage} money configuration`);
  } catch (error) {
    throw new Error(`${stage} requires MoneyConfigurationV1: ${error.message}`);
  }
  if (!sameAsset(asset, money.assets.solanaStablecoin)) {
    throw new Error(`${stage} MoneyConfigurationV1 Solana asset does not match the configured settlement asset`);
  }
  return money;
}

/** Refuses an unaffordable or over-cap Solana priority-fee envelope before signing. */
export async function assertSolanaSignerFeeEnvelope({ client, owner, money, decoded, stage }) {
  const fee = priorityFee(decoded, stage);
  if (fee !== null && (!sameAsset(fee, money.solana.priorityFeeCap)
    || BigInt(fee.amountAtomic) > BigInt(money.solana.priorityFeeCap.amountAtomic))) {
    throw new Error(`${stage} priority fee exceeds the configured MoneyConfigurationV1 cap`);
  }
  const required = BigInt(money.solana.lamportReserve.amountAtomic) + maximumPriorityFeeLamports(decoded, stage);
  const balance = await readSolBalance(client, owner);
  if (balance < required) {
    throw new Error(`${stage} Operations SOL balance does not retain the configured lamport reserve after the maximum priority fee`);
  }
}
