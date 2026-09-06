import { requireEip55Address, toEip55Address } from './eip55.mjs';
import { keccak256Hex } from './keccak.mjs';

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT256_MODULUS = 1n << 256n;
const SEED_PARAM_WORD_COUNT = 8;

export const MAX_SEED_DEADLINE_SECONDS = 900;
export const SEED_CANONICAL_LIQUIDITY_SIGNATURE =
  'seedCanonicalLiquidity((int24,int24,uint256,uint128,uint128,uint256,address,address))';
export const SEED_CANONICAL_LIQUIDITY_SELECTOR =
  keccak256Hex(Buffer.from(SEED_CANONICAL_LIQUIDITY_SIGNATURE, 'utf8')).slice(0, 10);

function unsigned(value, label, bits = 256) {
  const source = typeof value === 'number' ? String(value) : value;
  if (typeof source !== 'string' || !DECIMAL.test(source)) {
    throw new Error(`${label} must be a canonical unsigned integer`);
  }
  const parsed = BigInt(source);
  if (parsed >= (1n << BigInt(bits))) throw new Error(`${label} is outside uint${bits}`);
  return parsed;
}

function signed24(value, label) {
  if (!Number.isSafeInteger(value) || value < -(1 << 23) || value > (1 << 23) - 1) {
    throw new Error(`${label} is outside int24`);
  }
  return BigInt(value);
}

function word(value) {
  return value.toString(16).padStart(64, '0');
}

function signedWord(value) {
  return word(value < 0n ? UINT256_MODULUS + value : value);
}

function addressWord(value, label) {
  return requireEip55Address(value, label).toLowerCase().slice(2).padStart(64, '0');
}

function normalizeSeedIntent({
  payer,
  tickLower,
  tickUpper,
  liquidity,
  amount0Max,
  amount1Max,
  maxDeadlineSeconds,
}) {
  const normalizedMaxDeadlineSeconds = unsigned(maxDeadlineSeconds, 'maxDeadlineSeconds');
  if (normalizedMaxDeadlineSeconds !== BigInt(MAX_SEED_DEADLINE_SECONDS)) {
    throw new Error(`maxDeadlineSeconds must equal ${MAX_SEED_DEADLINE_SECONDS}`);
  }
  return {
    payer: requireEip55Address(payer, 'payer'),
    tickLower: Number(signed24(tickLower, 'tickLower')),
    tickUpper: Number(signed24(tickUpper, 'tickUpper')),
    liquidity: unsigned(liquidity, 'liquidity').toString(),
    amount0Max: unsigned(amount0Max, 'amount0Max', 128).toString(),
    amount1Max: unsigned(amount1Max, 'amount1Max', 128).toString(),
    maxDeadlineSeconds: Number(normalizedMaxDeadlineSeconds),
  };
}

export function deriveSeedIntent(fields) {
  const intent = normalizeSeedIntent(fields);
  const encoded = [
    addressWord(intent.payer, 'payer'),
    signedWord(BigInt(intent.tickLower)),
    signedWord(BigInt(intent.tickUpper)),
    word(BigInt(intent.liquidity)),
    word(BigInt(intent.amount0Max)),
    word(BigInt(intent.amount1Max)),
    word(BigInt(intent.maxDeadlineSeconds)),
  ].join('');
  return {
    ...intent,
    digest: keccak256Hex(Buffer.from(encoded, 'hex')),
  };
}

export function computeSeedIntentDigest(fields) {
  return deriveSeedIntent(fields).digest;
}

function calldataWords(calldata) {
  if (!HEX.test(calldata ?? '')) throw new Error('seed calldata must be even-length hex');
  const expectedLength = 2 + 8 + SEED_PARAM_WORD_COUNT * 64;
  if (calldata.length !== expectedLength) throw new Error('seed calldata has an unexpected length');
  if (calldata.slice(0, 10).toLowerCase() !== SEED_CANONICAL_LIQUIDITY_SELECTOR) {
    throw new Error('seed calldata selector is invalid');
  }
  return Array.from(
    { length: SEED_PARAM_WORD_COUNT },
    (_, index) => calldata.slice(10 + index * 64, 10 + (index + 1) * 64),
  );
}

function decodeUnsignedWord(value, bits, label) {
  const parsed = BigInt(`0x${value}`);
  if (parsed >= (1n << BigInt(bits))) throw new Error(`${label} is not canonically encoded`);
  return parsed;
}

function decodeSignedWord(value, bits, label) {
  const parsed = BigInt(`0x${value}`);
  const width = BigInt(bits);
  const modulus = 1n << width;
  const sign = 1n << (width - 1n);
  const low = parsed & (modulus - 1n);
  const decoded = low >= sign ? low - modulus : low;
  const encoded = decoded < 0n ? UINT256_MODULUS + decoded : decoded;
  if (parsed !== encoded) throw new Error(`${label} is not canonically encoded`);
  return decoded;
}

function decodeAddressWord(value, label) {
  const parsed = decodeUnsignedWord(value, 160, label);
  return toEip55Address(`0x${parsed.toString(16).padStart(40, '0')}`);
}

export function decodeSeedCanonicalLiquidityCalldata(calldata) {
  const [tickLower, tickUpper, liquidity, amount0Max, amount1Max, deadline, payer, custody] =
    calldataWords(calldata);
  return {
    tickLower: Number(decodeSignedWord(tickLower, 24, 'tickLower')),
    tickUpper: Number(decodeSignedWord(tickUpper, 24, 'tickUpper')),
    liquidity: decodeUnsignedWord(liquidity, 256, 'liquidity').toString(),
    amount0Max: decodeUnsignedWord(amount0Max, 128, 'amount0Max').toString(),
    amount1Max: decodeUnsignedWord(amount1Max, 128, 'amount1Max').toString(),
    deadline: decodeUnsignedWord(deadline, 256, 'deadline').toString(),
    payer: decodeAddressWord(payer, 'payer'),
    custody: decodeAddressWord(custody, 'custody'),
  };
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported fields`);
  }
  return value;
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function validateNativeValue(value, chainId) {
  exactKeys(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], 'seed transaction value');
  if (unsigned(value.chainId, 'seed transaction value.chainId').toString() !== unsigned(chainId, 'chainId').toString()) {
    throw new Error('seed transaction value chainId mismatch');
  }
  if (value.assetId !== 'native' || value.decimals !== 18 || unsigned(value.amountAtomic, 'seed transaction value.amountAtomic') !== 0n) {
    throw new Error('seed transaction value must be zero native value');
  }
}

export function verifyMaterializedSeedTransaction({
  transaction,
  chainId,
  expectedHook,
  expectedCustody,
  expectedIntent,
  referenceTimestamp,
}) {
  exactKeys(transaction, ['to', 'value', 'data'], 'seed transaction');
  const hook = requireEip55Address(expectedHook, 'expectedHook');
  const custody = requireEip55Address(expectedCustody, 'expectedCustody');
  const to = requireEip55Address(transaction.to, 'seed transaction to');
  if (!sameAddress(to, hook)) throw new Error('seed transaction target mismatch');
  validateNativeValue(transaction.value, chainId);

  const intent = deriveSeedIntent(expectedIntent);
  if (expectedIntent?.digest !== undefined && expectedIntent.digest.toLowerCase() !== intent.digest) {
    throw new Error('expected seed intent digest mismatch');
  }
  const params = decodeSeedCanonicalLiquidityCalldata(transaction.data);
  if (!sameAddress(params.custody, custody)) throw new Error('seed custody mismatch');
  const actualDigest = computeSeedIntentDigest({
    ...params,
    maxDeadlineSeconds: intent.maxDeadlineSeconds,
  });
  if (actualDigest !== intent.digest) throw new Error('seed intent digest mismatch');

  const deadline = unsigned(params.deadline, 'seed deadline');
  const timestamp = unsigned(referenceTimestamp, 'referenceTimestamp');
  const maximumDeadline = timestamp + BigInt(intent.maxDeadlineSeconds);
  if (deadline < timestamp) throw new Error('seed deadline is in the past');
  if (deadline > maximumDeadline) throw new Error('seed deadline exceeds its maximum window');
  return { params, digest: actualDigest };
}
