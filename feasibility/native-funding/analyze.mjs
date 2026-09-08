import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const source = JSON.parse(readFileSync(`${directory}scenario-source.json`, 'utf8'));
const output = readFileSync(`${directory}forge-output.txt`, 'utf8');
const target = BigInt(source.processPrincipalWei);
const usdMicro = BigInt(source.displayedInputMicroUsd);
const ceil = (a, b) => (a + b - 1n) / b;
const minimumGross = ceil(target * 10000n, 250n);
assert.equal(minimumGross * 250n / 10000n, target);
assert.equal((minimumGross - 1n) * 250n / 10000n, target - 1n);
const minimumStreams = [10n, 40n, 250n].map(bps => minimumGross * bps / 10000n);
const minimumFees = minimumStreams.reduce((sum, value) => sum + value, 0n);
const scenarios = [...output.matchAll(/\[PASS\] (testSeed\w+)\(\) .*?\nLogs:\n([\s\S]*?)(?=\n\[PASS\]|\nSuite result:)/g)].map(([, name, block]) => {
  const row = Object.fromEntries([...block.matchAll(/^  (\w+): (\d+)$/gm)].map(([, key, value]) => [key, value]));
  for (const key of ['initialCapitalWei','seedLockedWei','initialTradingFloatWei','grossExecutedWei','earnedProcessWei','feeLiabilitiesWei','traderRemainingWei','poolRemainingWei','swapCount','swapExecutionGasLocal']) assert.ok(row[key], key);
  const value = key => BigInt(row[key]);
  const refund = value('initialCapitalWei') - value('initialTradingFloatWei') - value('seedLockedWei');
  assert.equal(refund + value('traderRemainingWei') + value('poolRemainingWei') + value('feeLiabilitiesWei'), value('initialCapitalWei'));
  assert.equal(value('earnedProcessWei'), value('grossExecutedWei') * 250n / 10000n);
  assert.equal(value('feeLiabilitiesWei'), [10n,40n,250n].reduce((sum,bps)=>sum+value('grossExecutedWei')*bps/10000n,0n));
  const funded = value('earnedProcessWei') >= target;
  assert.equal(Boolean(row.claimGasLocal), funded);
  const initialCost = ceil(value('initialCapitalWei') * usdMicro, target);
  const localGas = ['tokenDeploymentGasLocal','hookDeploymentGasLocal','custodyDeploymentGasLocal','graphWiringGasLocal','seedGasLocal','swapExecutionGasLocal','claimGasLocal'].reduce((sum,key)=>sum+BigInt(row[key]??'0'),0n);
  return { name, ...row, seedRefundWei: refund.toString(), historicalBridgePrincipalClaimedWei: funded ? target.toString() : '0',
    remainingProcessLiabilityWei: (value('earnedProcessWei')-(funded?target:0n)).toString(),
    reachesHistoricalPrincipal: funded, initialCapitalScenarioCostMicroUsdCeil: initialCost.toString(),
    unpricedCostsHeadroomMicroUsd: (250000000n-initialCost).toString(),
    localMeasuredExecutionGasSum: localGas.toString(),
    swapSeparateTransactionIntrinsicGasLowerBound: (value('swapCount')*21000n).toString(),
    allInBudgetProven: false };
});
assert.equal(scenarios.length, 3);
assert.equal(scenarios.filter(row=>row.reachesHistoricalPrincipal).length,2);
assert.ok(BigInt(scenarios[0].initialTradingFloatWei)<minimumFees);
const result = { schema:'hookemon.native-funding-feasibility.v1', status:'partial-local-feasibility-only', source,
  minimumGrossExecutedWei:minimumGross.toString(), minimumCumulativeFeesWei:minimumFees.toString(),
  minimumFeeStreamsWei:{programmable:minimumStreams[0].toString(),treasury:minimumStreams[1].toString(),process:minimumStreams[2].toString()},
  forgeOutputSha256:createHash('sha256').update(output).digest('hex'), scenarios };
writeFileSync(`${directory}results.json`, `${JSON.stringify(result,null,2)}\n`);
console.log('Validated 3 production-native scenarios, exact cumulative fee bound, capital conservation, and conservative historical USD conversion. No all-in budget pass.');
