import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const dir = 'feasibility/native-preflight-candidate-20260908/';
const read = name => JSON.parse(readFileSync(dir + name));
const scenario = read('scenario.json');
const gas = read('gas-inventory.json');
assert.equal(BigInt(scenario.price.consumedAmount0) + BigInt(scenario.price.refundWei), BigInt(scenario.seedMaximumWei));
assert.equal(scenario.price.consumedHkmn, '1000000000000000000000000000');
assert(BigInt(scenario.processClaimLimit6hWei) >= 10214270236945073n);
assert(BigInt(scenario.processClaimLimitMaxWei) >= BigInt(scenario.processClaimLimit6hWei));
assert.equal(BigInt(gas.localFundingGas) - BigInt(gas.replacedDeploymentAndWiringGas) + BigInt(gas.replacementArchiveRouteGas), BigInt(gas.combinedMeasuredGasScenario));
assert.equal(read('validation.json').errors.length, 7);
assert.equal(read('derived-coordinates.json').predictions.length, 2);
assert.equal(scenario.signable, false);
assert.equal(scenario.allInBudgetProven, false);
for (const [path, expected] of Object.entries(read('sources.json').sha256)) {
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected, path);
}
console.log('PASS: source/output digests, seed conservation, ordered ceilings, gas replacement arithmetic, explicit incomplete request.');
