import { createHash } from 'node:crypto';

import { keccak256Hex } from './keccak.mjs';
export { isEip55Address, toEip55Address } from './eip55.mjs';

export const PHASE_THREE_FACTORY = '0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd';
export const PHASE_THREE_ROUTER = '0x34965F2A2ee9254522232C32F02056E92BE0C98a';
export const PHASE_THREE_TICK_SPACING = 60;
export const PHASE_THREE_MIN_TICK = -887220;
export const PHASE_THREE_MAX_TICK = 887220;
export const PHASE_THREE_SOLC_VERSION = '0.8.26+commit.8a97fa7a';
export const PHASE_THREE_SOLC_LONG_VERSION = '0.8.26+commit.8a97fa7a';
export const PHASE_THREE_SOLC_SHORT_VERSION = '0.8.26';

const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_EXACT_LIQUIDITY_SEARCH = 20_000_000n;
const EXACT_FULL_STOCK_SELECTIONS = Object.freeze({
  '240000000:1000000000000000000000000000': Object.freeze({
    hkmnCurrency0: Object.freeze({
      sqrtPriceX96: 38813714284914462669n,
      liquidity: 489897948572597439n,
    }),
  }),
});
export const PHASE_THREE_TICK_MATH_MULTIPLIERS = Object.freeze([
  'fffcb933bd6fad37aa2d162d1a594001',
  'fff97272373d413259a46990580e213a',
  'fff2e50f5f656932ef12357cf3c7fdcc',
  'ffe5caca7e10e4e61c3624eaa0941cd0',
  'ffcb9843d60f6159c9db58835c926644',
  'ff973b41fa98c081472e6896dfb254c0',
  'ff2ea16466c96a3843ec78b326b52861',
  'fe5dee046a99a2a811c461f1969c3053',
  'fcbe86c7900a88aedcffc83b479aa3a4',
  'f987a7253ac413176f2b074cf7815e54',
  'f3392b0822b70005940c7a398e4b70f3',
  'e7159475a2c29b7443b29c7fa6e889d9',
  'd097f3bdfd2022b8845ad8f792aa5825',
  'a9f746462d870fdf8a65dc1f90e061e5',
  '70d869a156d2a1b890bb3df62baf32f7',
  '31be135f97d08fd981231505542fcfa6',
  '9aa508b5b7a84e1c677de54f3e99bc9',
  '5d6af8dedb81196699c329225ee604',
  '2216e584f5fa1ea926041bedfe98',
  '48a170391f7dc42444e8fa2',
].map((value) => BigInt(`0x${value}`)));

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function artifactHashes(bytes, artifact) {
  const creation = typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode?.object;
  const runtime = typeof artifact.deployedBytecode === 'string' ? artifact.deployedBytecode : artifact.deployedBytecode?.object;
  if (!/^0x[0-9a-f]+$/i.test(creation ?? '') || !/^0x[0-9a-f]+$/i.test(runtime ?? '')) {
    throw new Error('artifact does not contain hex creation and runtime bytecode');
  }
  return {
    creationBytecodeHash: keccak256Hex(Buffer.from(creation.slice(2), 'hex')),
    runtimeTemplateCodeHash: keccak256Hex(Buffer.from(runtime.slice(2), 'hex')),
    artifactSha256: sha256(bytes),
  };
}

export function sourceContentCommitment(buildInfo) {
  const input = buildInfo?.input ?? buildInfo;
  const sources = input?.sources;
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error('Standard JSON input.sources is required');
  }
  const sourceHashes = Object.values(sources).map((source) => {
    if (typeof source?.content !== 'string') throw new Error('Standard JSON source content is required');
    return sha256(Buffer.from(source.content, 'utf8'));
  }).sort();
  return {
    sourceCount: sourceHashes.length,
    sourceContentSha256: sha256(Buffer.from(JSON.stringify(sourceHashes), 'utf8')),
  };
}

export function extractFoundryStandardJsonInput(buildInfo) {
  const input = buildInfo?.input;
  if (input?.language !== 'Solidity' || input.sources === null || typeof input.sources !== 'object' || Array.isArray(input.sources)) {
    throw new Error('pinned compiler output does not contain Standard JSON sources');
  }
  if (input.settings === null || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
    throw new Error('pinned compiler output does not contain Standard JSON settings');
  }
  return {
    language: input.language,
    sources: input.sources,
    settings: input.settings,
  };
}

function compilerVersionFromMetadata(value, field) {
  if (value === null || value === undefined) return null;
  const metadata = typeof value === 'string' ? JSON.parse(value) : value;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`Foundry ${field} must be a JSON object`);
  }
  return typeof metadata.compiler?.version === 'string' ? metadata.compiler.version : null;
}

export function foundryCompilerVersion(artifact) {
  const versions = [];
  if (typeof artifact?.compiler?.version === 'string') versions.push(artifact.compiler.version);
  for (const field of ['metadata', 'rawMetadata']) {
    const version = compilerVersionFromMetadata(artifact?.[field], field);
    if (version !== null) versions.push(version);
  }
  const longVersions = [...new Set(versions.filter((version) => /^0\.[0-9]+\.[0-9]+\+commit\.[0-9a-f]{8}$/.test(version)))];
  if (longVersions.length === 1) return longVersions[0];
  if (longVersions.length > 1) throw new Error('Foundry metadata has conflicting compiler versions');
  if (versions.length === 1) return versions[0];
  if (versions.length > 1 && new Set(versions).size === 1) return versions[0];
  throw new Error('Foundry artifact does not contain one compiler version');
}

export function sqrtPriceAtTickWithMultipliers(tick, multipliers) {
  if (!Number.isInteger(tick) || tick < -887272 || tick > 887272) throw new Error('tick is outside TickMath bounds');
  if (!Array.isArray(multipliers) || multipliers.length !== PHASE_THREE_TICK_MATH_MULTIPLIERS.length || multipliers.some((value) => typeof value !== 'bigint' || value <= 0n)) {
    throw new Error('TickMath multiplier table is invalid');
  }
  const absoluteTick = BigInt(Math.abs(tick));
  let ratio = absoluteTick & 1n ? multipliers[0] : 1n << 128n;
  for (let index = 1; index < multipliers.length; index += 1) {
    if ((absoluteTick & (1n << BigInt(index))) !== 0n) ratio = (ratio * multipliers[index]) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio & ((1n << 32n) - 1n) ? 1n : 0n);
}

export function sqrtPriceAtTick(tick) {
  return sqrtPriceAtTickWithMultipliers(tick, PHASE_THREE_TICK_MATH_MULTIPLIERS);
}

export function integerSqrt(value) {
  if (value < 0n) throw new Error('square root requires a non-negative value');
  if (value < 2n) return value;
  let current = 1n << BigInt((value.toString(2).length + 1) >> 1);
  let next = (current + value / current) >> 1n;
  while (next < current) {
    current = next;
    next = (current + value / current) >> 1n;
  }
  return current;
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function liquidityForAmounts(amount0, amount1, sqrtPriceX96) {
  const sqrtLowerX96 = sqrtPriceAtTick(PHASE_THREE_MIN_TICK);
  const sqrtUpperX96 = sqrtPriceAtTick(PHASE_THREE_MAX_TICK);
  const liquidityFromAmount0 = (amount0 * sqrtPriceX96 * sqrtUpperX96) / (Q96 * (sqrtUpperX96 - sqrtPriceX96));
  const liquidityFromAmount1 = (amount1 * Q96) / (sqrtPriceX96 - sqrtLowerX96);
  return {
    liquidity: liquidityFromAmount0 < liquidityFromAmount1 ? liquidityFromAmount0 : liquidityFromAmount1,
    sqrtLowerX96,
    sqrtUpperX96,
  };
}

function consumedAmounts(liquidity, sqrtPriceX96, sqrtLowerX96, sqrtUpperX96) {
  return {
    amount0: ceilDiv(liquidity * (sqrtUpperX96 - sqrtPriceX96) * Q96, sqrtUpperX96 * sqrtPriceX96),
    amount1: ceilDiv(liquidity * (sqrtPriceX96 - sqrtLowerX96), Q96),
  };
}

function assertExactSeedCandidate({
  liquidity,
  sqrtPriceX96,
  sqrtLowerX96,
  sqrtUpperX96,
  amount0Max,
  amount1Max,
}) {
  if (liquidity <= 0n || liquidity > ((1n << 128n) - 1n)) {
    throw new Error('exact Phase 3 liquidity is outside uint128');
  }
  if (sqrtPriceX96 <= sqrtLowerX96 || sqrtPriceX96 >= sqrtUpperX96) {
    throw new Error('exact Phase 3 sqrt price is outside the full range');
  }
  const consumed = consumedAmounts(liquidity, sqrtPriceX96, sqrtLowerX96, sqrtUpperX96);
  if (consumed.amount0 !== amount0Max || consumed.amount1 !== amount1Max) {
    throw new Error('exact Phase 3 price candidate does not consume both seed maximums');
  }
  return consumed;
}

function selectUsdgCurrency0ExactCandidate({ usdg, hkmn, baselineLiquidity }) {
  const sqrtLowerX96 = sqrtPriceAtTick(PHASE_THREE_MIN_TICK);
  const sqrtUpperX96 = sqrtPriceAtTick(PHASE_THREE_MAX_TICK);
  const sqrtPriceX96 = sqrtLowerX96 + ((hkmn - 1n) * Q96) / baselineLiquidity + 1n;
  const liquidity = liquidityForAmounts(usdg, hkmn, sqrtPriceX96);
  if (liquidity.liquidity !== baselineLiquidity) {
    throw new Error('USDG-currency0 exact candidate changed the limiting liquidity');
  }
  const consumed = assertExactSeedCandidate({
    liquidity: baselineLiquidity,
    sqrtPriceX96,
    sqrtLowerX96,
    sqrtUpperX96,
    amount0Max: usdg,
    amount1Max: hkmn,
  });
  return { sqrtPriceX96, sqrtLowerX96, sqrtUpperX96, liquidity: baselineLiquidity, consumed };
}

function selectHkmnCurrency0ExactCandidate({ usdg, hkmn, baselineLiquidity, knownSelection }) {
  const sqrtLowerX96 = sqrtPriceAtTick(PHASE_THREE_MIN_TICK);
  const sqrtUpperX96 = sqrtPriceAtTick(PHASE_THREE_MAX_TICK);
  if (knownSelection !== undefined) {
    const derivedLiquidity = liquidityForAmounts(hkmn, usdg, knownSelection.sqrtPriceX96);
    if (derivedLiquidity.liquidity !== knownSelection.liquidity) {
      throw new Error('pinned HKMN-currency0 candidate no longer derives its selected liquidity');
    }
    const consumed = assertExactSeedCandidate({
      liquidity: knownSelection.liquidity,
      sqrtPriceX96: knownSelection.sqrtPriceX96,
      sqrtLowerX96,
      sqrtUpperX96,
      amount0Max: hkmn,
      amount1Max: usdg,
    });
    return {
      sqrtPriceX96: knownSelection.sqrtPriceX96,
      sqrtLowerX96,
      sqrtUpperX96,
      liquidity: knownSelection.liquidity,
      consumed,
    };
  }
  const searchLimit = baselineLiquidity + MAX_EXACT_LIQUIDITY_SEARCH;

  for (let liquidity = baselineLiquidity; liquidity <= searchLimit; liquidity += 1n) {
    const sqrtPriceX96 = ceilDiv(
      liquidity * sqrtUpperX96 * Q96,
      hkmn * sqrtUpperX96 + liquidity * Q96,
    );
    const derivedLiquidity = liquidityForAmounts(hkmn, usdg, sqrtPriceX96);
    if (derivedLiquidity.liquidity !== liquidity) continue;

    try {
      const consumed = assertExactSeedCandidate({
        liquidity,
        sqrtPriceX96,
        sqrtLowerX96,
        sqrtUpperX96,
        amount0Max: hkmn,
        amount1Max: usdg,
      });
      return { sqrtPriceX96, sqrtLowerX96, sqrtUpperX96, liquidity, consumed };
    } catch (error) {
      if (error.message !== 'exact Phase 3 price candidate does not consume both seed maximums') {
        throw error;
      }
    }
  }
  throw new Error('could not derive an exact HKMN-currency0 Phase 3 seed candidate');
}

/**
 * Computes the release candidates with an injectable square-root operation for
 * mutation testing. Production callers use derivePriceCandidates.
 */
export function derivePriceCandidatesWithMath(
  { usdgAtomic, hkmnAtomic },
  { integerSquareRoot = integerSqrt } = {},
) {
  if (typeof integerSquareRoot !== 'function') throw new Error('integerSquareRoot must be a function');
  const usdg = BigInt(usdgAtomic);
  const hkmn = BigInt(hkmnAtomic);
  if (usdg <= 0n || hkmn <= 0n) throw new Error('Phase 3 seed amounts must be positive');
  const usdgCurrency0SqrtPriceX96 = integerSquareRoot((hkmn * Q192) / usdg);
  const hkmnCurrency0SqrtPriceX96 = integerSquareRoot((usdg * Q192) / hkmn);
  const usdgBaselineLiquidity = liquidityForAmounts(usdg, hkmn, usdgCurrency0SqrtPriceX96);
  const hkmnBaselineLiquidity = liquidityForAmounts(hkmn, usdg, hkmnCurrency0SqrtPriceX96);
  const knownSelection = integerSquareRoot === integerSqrt
    ? EXACT_FULL_STOCK_SELECTIONS[`${usdg}:${hkmn}`]?.hkmnCurrency0
    : undefined;
  const usdgCandidate = selectUsdgCurrency0ExactCandidate({
    usdg,
    hkmn,
    baselineLiquidity: usdgBaselineLiquidity.liquidity,
  });
  const hkmnCandidate = selectHkmnCurrency0ExactCandidate({
    usdg,
    hkmn,
    baselineLiquidity: hkmnBaselineLiquidity.liquidity,
    knownSelection,
  });
  return {
    usdgCurrency0: {
      sqrtPriceX96: usdgCandidate.sqrtPriceX96.toString(),
      reciprocalSqrtPriceX96: (Q192 / usdgCandidate.sqrtPriceX96).toString(),
      sqrtLowerX96: usdgCandidate.sqrtLowerX96.toString(),
      sqrtUpperX96: usdgCandidate.sqrtUpperX96.toString(),
      liquidity: usdgCandidate.liquidity.toString(),
      amount0Max: usdg.toString(),
      amount1Max: hkmn.toString(),
      consumedAmount0: usdgCandidate.consumed.amount0.toString(),
      consumedAmount1: usdgCandidate.consumed.amount1.toString(),
      consumedHkmn: usdgCandidate.consumed.amount1.toString(),
    },
    hkmnCurrency0: {
      sqrtPriceX96: hkmnCandidate.sqrtPriceX96.toString(),
      reciprocalSqrtPriceX96: (Q192 / hkmnCandidate.sqrtPriceX96).toString(),
      sqrtLowerX96: hkmnCandidate.sqrtLowerX96.toString(),
      sqrtUpperX96: hkmnCandidate.sqrtUpperX96.toString(),
      liquidity: hkmnCandidate.liquidity.toString(),
      amount0Max: hkmn.toString(),
      amount1Max: usdg.toString(),
      consumedAmount0: hkmnCandidate.consumed.amount0.toString(),
      consumedAmount1: hkmnCandidate.consumed.amount1.toString(),
      consumedHkmn: hkmnCandidate.consumed.amount0.toString(),
    },
  };
}

export function derivePriceCandidates(input) {
  return derivePriceCandidatesWithMath(input);
}
