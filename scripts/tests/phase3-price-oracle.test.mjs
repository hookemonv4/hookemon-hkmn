import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import * as phaseThreeRelease from '../programmable/lib/phase3-release.mjs';
import { keccak256Hex } from '../programmable/lib/keccak.mjs';

const root = resolve(import.meta.dirname, '../..');
const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const MIN_TICK = -887220;
const MAX_TICK = 887220;
const TICK_MATH_VECTORS_PATH = 'release/phase3/tickmath-vectors.json';
const TICK_MATH_VECTORS_KECCAK = '0xe23d9e5874ff6be7e6f9e0351d765746773b1e6f094a0c82b6a0fb56408c8401';
const EXACT_FULL_STOCK_CANDIDATES = Object.freeze({
  usdgCurrency0: Object.freeze({
    sqrtPriceX96: '161723809515207654588927258648643645224',
    liquidity: '489897948556635619',
  }),
  hkmnCurrency0: Object.freeze({
    sqrtPriceX96: '38813714284914462669',
    liquidity: '489897948572597439',
  }),
});

function readLaunchInputs() {
  return JSON.parse(readFileSync(resolve(root, 'release/phase3/launch-inputs.json'), 'utf8'));
}

function readTickMathVectors() {
  const bytes = readFileSync(resolve(root, TICK_MATH_VECTORS_PATH));
  assert.equal(keccak256Hex(bytes), TICK_MATH_VECTORS_KECCAK);
  return JSON.parse(bytes);
}

function expectedTickMathVectorTicks() {
  return Array.from({ length: 20 }, (_, bit) => [-(1 << bit), 1 << bit])
    .flat()
    .concat([-887272, 887272, MIN_TICK, MAX_TICK]);
}

function floorSquareRoot(value) {
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low + 1n < high) {
    const middle = (low + high) >> 1n;
    if (middle <= value / middle) low = middle;
    else high = middle;
  }
  return low;
}

function mulDivDown(left, right, denominator) {
  return (left * right) / denominator;
}

function mulDivUp(left, right, denominator) {
  return (left * right + denominator - 1n) / denominator;
}

function divUp(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  const intermediate = mulDivDown(sqrtA, sqrtB, Q96);
  return mulDivDown(amount0, intermediate, sqrtB - sqrtA);
}

function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  return mulDivDown(amount1, Q96, sqrtB - sqrtA);
}

function liquidityForAmounts(sqrtPriceX96, sqrtLowerX96, sqrtUpperX96, amount0, amount1) {
  if (sqrtPriceX96 <= sqrtLowerX96) return liquidityForAmount0(sqrtLowerX96, sqrtUpperX96, amount0);
  if (sqrtPriceX96 >= sqrtUpperX96) return liquidityForAmount1(sqrtLowerX96, sqrtUpperX96, amount1);
  return [
    liquidityForAmount0(sqrtPriceX96, sqrtUpperX96, amount0),
    liquidityForAmount1(sqrtLowerX96, sqrtPriceX96, amount1),
  ].reduce((minimum, current) => current < minimum ? current : minimum);
}

function amount0ForLiquidity(sqrtPriceX96, sqrtUpperX96, liquidity) {
  return divUp(
    mulDivUp(liquidity << 96n, sqrtUpperX96 - sqrtPriceX96, sqrtUpperX96),
    sqrtPriceX96,
  );
}

function amount1ForLiquidity(sqrtLowerX96, sqrtPriceX96, liquidity) {
  return mulDivUp(liquidity, sqrtPriceX96 - sqrtLowerX96, Q96);
}

function exactFullStockOracle({ usdgAtomic, hkmnAtomic, sqrtLowerX96, sqrtUpperX96 }) {
  const usdg = BigInt(usdgAtomic);
  const hkmn = BigInt(hkmnAtomic);
  const lower = BigInt(sqrtLowerX96);
  const upper = BigInt(sqrtUpperX96);
  const usdgCurrency0SqrtPriceX96 = BigInt(EXACT_FULL_STOCK_CANDIDATES.usdgCurrency0.sqrtPriceX96);
  const hkmnCurrency0SqrtPriceX96 = BigInt(EXACT_FULL_STOCK_CANDIDATES.hkmnCurrency0.sqrtPriceX96);
  const usdgCurrency0Liquidity = BigInt(EXACT_FULL_STOCK_CANDIDATES.usdgCurrency0.liquidity);
  const hkmnCurrency0Liquidity = BigInt(EXACT_FULL_STOCK_CANDIDATES.hkmnCurrency0.liquidity);
  return {
    usdgCurrency0: {
      sqrtPriceX96: usdgCurrency0SqrtPriceX96.toString(),
      sqrtLowerX96: lower.toString(),
      sqrtUpperX96: upper.toString(),
      liquidity: usdgCurrency0Liquidity.toString(),
      amount0Max: usdg.toString(),
      amount1Max: hkmn.toString(),
      consumedAmount0: amount0ForLiquidity(usdgCurrency0SqrtPriceX96, upper, usdgCurrency0Liquidity).toString(),
      consumedAmount1: amount1ForLiquidity(lower, usdgCurrency0SqrtPriceX96, usdgCurrency0Liquidity).toString(),
      consumedHkmn: amount1ForLiquidity(lower, usdgCurrency0SqrtPriceX96, usdgCurrency0Liquidity).toString(),
    },
    hkmnCurrency0: {
      sqrtPriceX96: hkmnCurrency0SqrtPriceX96.toString(),
      sqrtLowerX96: lower.toString(),
      sqrtUpperX96: upper.toString(),
      liquidity: hkmnCurrency0Liquidity.toString(),
      amount0Max: hkmn.toString(),
      amount1Max: usdg.toString(),
      consumedAmount0: amount0ForLiquidity(hkmnCurrency0SqrtPriceX96, upper, hkmnCurrency0Liquidity).toString(),
      consumedAmount1: amount1ForLiquidity(lower, hkmnCurrency0SqrtPriceX96, hkmnCurrency0Liquidity).toString(),
      consumedHkmn: amount0ForLiquidity(hkmnCurrency0SqrtPriceX96, upper, hkmnCurrency0Liquidity).toString(),
    },
  };
}

function comparable(candidate) {
  return {
    sqrtPriceX96: candidate.sqrtPriceX96,
    sqrtLowerX96: candidate.sqrtLowerX96,
    sqrtUpperX96: candidate.sqrtUpperX96,
    liquidity: candidate.liquidity,
    amount0Max: candidate.amount0Max,
    amount1Max: candidate.amount1Max,
    consumedAmount0: candidate.consumedAmount0,
    consumedAmount1: candidate.consumedAmount1,
    consumedHkmn: candidate.consumedHkmn,
  };
}

function releaseComparable(candidate) {
  return {
    sqrtPriceX96: candidate.sqrtPriceX96,
    sqrtLowerX96: candidate.sqrtLowerX96,
    sqrtUpperX96: candidate.sqrtUpperX96,
    liquidity: candidate.liquidity,
    amount0Max: candidate.amount0Max,
    amount1Max: candidate.amount1Max,
    consumedAmount0: candidate.consumedAmount0,
    consumedAmount1: candidate.consumedAmount1,
    consumedHkmn: candidate.consumedHkmn,
  };
}

test('the production TickMath implementation matches every signed one-bit vector and both bounds', () => {
  const evidence = readTickMathVectors();
  assert.equal(evidence.schemaVersion, 'hookemon.phase3.tickmath-vectors.v1');
  assert.equal(evidence.canonicalSource.path, 'packages/contracts/lib/v4-core/src/libraries/TickMath.sol');
  assert.deepEqual(evidence.vectors.map(({ tick }) => tick), expectedTickMathVectorTicks());

  for (const { tick, sqrtPriceX96 } of evidence.vectors) {
    assert.equal(phaseThreeRelease.sqrtPriceAtTick(tick).toString(), sqrtPriceX96, `tick ${tick}`);
  }

  assert.deepEqual(evidence.phaseThreeFullRange, {
    minimumTick: MIN_TICK,
    maximumTick: MAX_TICK,
    sqrtLowerX96: phaseThreeRelease.sqrtPriceAtTick(MIN_TICK).toString(),
    sqrtUpperX96: phaseThreeRelease.sqrtPriceAtTick(MAX_TICK).toString(),
  });
});

test('every TickMath multiplier mutation changes its signed one-bit vectors', () => {
  assert.equal(typeof phaseThreeRelease.sqrtPriceAtTickWithMultipliers, 'function');
  assert.equal(phaseThreeRelease.PHASE_THREE_TICK_MATH_MULTIPLIERS.length, 20);

  for (let bit = 0; bit < 20; bit += 1) {
    const multipliers = [...phaseThreeRelease.PHASE_THREE_TICK_MATH_MULTIPLIERS];
    multipliers[bit] ^= 1n << 64n;

    for (const tick of [-(1 << bit), 1 << bit]) {
      assert.notEqual(
        phaseThreeRelease.sqrtPriceAtTickWithMultipliers(tick, multipliers),
        phaseThreeRelease.sqrtPriceAtTick(tick),
        `mutated multiplier ${bit} did not change tick ${tick}`,
      );
    }
  }
});

test('the exact-allocation oracle binds full Phase 3 price, bounds, liquidity, and consumed tuples', () => {
  const inputs = readLaunchInputs();
  const { phaseThreeFullRange } = readTickMathVectors();
  const expected = exactFullStockOracle({
    usdgAtomic: inputs.pool.quoteAsset.amountAtomic,
    hkmnAtomic: inputs.pool.baseAsset.amountAtomic,
    ...phaseThreeFullRange,
  });
  const actual = phaseThreeRelease.derivePriceCandidates({
    usdgAtomic: inputs.pool.quoteAsset.amountAtomic,
    hkmnAtomic: inputs.pool.baseAsset.amountAtomic,
  });

  for (const ordering of ['usdgCurrency0', 'hkmnCurrency0']) {
    assert.deepEqual(comparable(actual[ordering]), expected[ordering]);
    assert.deepEqual(releaseComparable(inputs.pool.priceCandidates[ordering]), releaseComparable(expected[ordering]));
    assert.equal(actual[ordering].consumedHkmn, inputs.pool.baseAsset.amountAtomic);
    assert.equal(actual[ordering].consumedAmount0, actual[ordering].amount0Max);
    assert.equal(actual[ordering].consumedAmount1, actual[ordering].amount1Max);
  }
});

test('the exact-allocation solver rejects a mutated square-root operation', () => {
  assert.equal(typeof phaseThreeRelease.derivePriceCandidatesWithMath, 'function');
  const inputs = readLaunchInputs();
  assert.throws(() => phaseThreeRelease.derivePriceCandidatesWithMath({
    usdgAtomic: inputs.pool.quoteAsset.amountAtomic,
    hkmnAtomic: inputs.pool.baseAsset.amountAtomic,
  }, {
    integerSquareRoot: () => 0n,
  }), /outside the full range|changed the limiting liquidity/);
});
