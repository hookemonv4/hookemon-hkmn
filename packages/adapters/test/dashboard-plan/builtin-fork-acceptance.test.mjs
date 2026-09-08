import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createLocalForkRuntime } from './fork-runtime.mjs';
import { runBuiltInForkCycle } from './fork-cycle-fixture.mjs';

const enabled = Boolean(process.env.DASHBOARD_FORK_OUTPUT);
const attempts = Number(process.env.HOOKEMON_DASHBOARD_FORK_ATTEMPTS ?? 3);
assert.ok([1, 3].includes(attempts));
for (let attempt = 1; attempt <= attempts; attempt++) {
  test(`attempt ${attempt}: real handlers on local Robinhood fork preserve and repeat HTTP-selected plan`,
    { skip: !enabled && 'Run run-fork-acceptance.mjs to provision an isolated local fork', timeout: 240000 }, async t => {
      const directory = join(process.env.DASHBOARD_FORK_OUTPUT, `attempt-${attempt}`);
      await mkdir(directory, { recursive: true });
      const checks = [];
      const check = (description, assertion) => { assertion(); checks.push({ number: checks.length + 1, description, result: 'PASS' }); };
      try {
        const catalog = JSON.parse(await readFile(process.env.DASHBOARD_FORK_CATALOG, 'utf8'));
        const runtime = await createLocalForkRuntime({ rpcUrl: 'http://127.0.0.1:28545', artifactRoot: process.env.FORK_ARTIFACT_ROOT,
          harnessOutput: process.env.FORK_HARNESS_OUTPUT, operationsAccount: privateKeyToAccount(process.env.FORK_TEST_EVM_KEY) });
        const credential = randomBytes(32).toString('hex');
        const original = [{ pack: 'pokemon_25', quantity: 1 }, { pack: 'pokemon_50', quantity: 1 }];
        const changed = [{ pack: 'pokemon_50', quantity: 2 }];
        const first = await runBuiltInForkCycle(t, { runtime, directory, credential, initialOrders: original, catalog });
        check('Authenticated dashboard lists the observed public catalog', () => assert.equal(first.catalog.machines.length, catalog.machines.length));
        check('First real-handler local fork cycle completes with selected plan', () => {
          assert.equal(first.cycle.terminalState, 'COMPLETED'); assert.deepEqual(first.cycle.packPlanSnapshot.plan.orders, original);
        });
        await first.composition.shutdown();
        const second = await runBuiltInForkCycle(t, { runtime, directory, credential, initialOrders: original, catalog,
          duringPurchase: async ({ composition, request, cycleId }) => {
            const bootstrap = await request('/operator/api/bootstrap');
            const response = await request('/operator/api/decisions', { requestId: `change-${cycleId}`, expectedVersion: bootstrap.body.state.version,
              command: { type: 'update-configuration', configuration: { packPlan: { orders: changed } } } });
            assert.equal(response.status, 200, JSON.stringify(response));
            const active = await composition.cycleRepository.readActiveCycle();
            check('Saved edit leaves in-flight cycle snapshot unchanged', () => assert.deepEqual(active.packPlanSnapshot.plan.orders, original));
          } });
        check('Unchanged plan repeats in the second completed cycle', () => {
          assert.equal(second.cycle.terminalState, 'COMPLETED'); assert.deepEqual(second.cycle.packPlanSnapshot.plan.orders, original);
        });
        await second.composition.shutdown();
        const third = await runBuiltInForkCycle(t, { runtime, directory, credential, initialOrders: original, catalog });
        check('Recomposed runner uses changed plan only for the next cycle', () => {
          assert.equal(third.cycle.terminalState, 'COMPLETED'); assert.deepEqual(third.cycle.packPlanSnapshot.plan.orders, changed);
        });
        await third.composition.shutdown();
        check('Built-in handlers produced actual local EVM claim, bridge deposit and payout receipts', () => {
          for (const label of ['bot signed claim-process', 'bot signed outbound', 'bot signed payout']) assert.ok(runtime.receipts.some(receipt => receipt.label === label));
        });
        await writeFile(join(directory, 'result.json'), JSON.stringify({ attempt, scope: runtime.proof.scope,
          checks, cycles: [first, second, third].map(value => ({ cycleId: value.cycle.cycleId, terminalState: value.cycle.terminalState,
            snapshot: value.cycle.packPlanSnapshot, stages: [...value.cycle.stages].map(([stage, record]) => ({ stage, status: record.status })) })),
          receipts: runtime.receipts }, null, 2));
      } catch (error) {
        await writeFile(join(directory, 'result.json'), JSON.stringify({ attempt, checks, result: 'FAIL', error: error.message }, null, 2));
        throw error;
      }
    });
}
