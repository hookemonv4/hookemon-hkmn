import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const sourceRoot = resolve(process.env.HOOKEMON_DASHBOARD_PLAN_SOURCE_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url)));
const source = path => pathToFileURL(join(sourceRoot, path)).href;
const { CycleRepository } = await import(source('packages/adapters/src/app/cycle-repository.mjs'));
const { createOperatorControl } = await import(source('packages/runner/src/operator/control.mjs'));
const { readOperatorState } = await import(source('packages/runner/src/operator/state-file.mjs'));
const { OPERATIONAL_CYCLE_STAGES } = await import(source('packages/runner/src/cycle/money-schemas.mjs'));
const git = args => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' });
const readSourceEvidence = () => ({
  sourceHead: git(['rev-parse', 'HEAD']).trim(),
  trackedDiffSha256: createHash('sha256').update(git(['diff', 'HEAD', '--', 'packages/runner/src', 'packages/adapters/src'])).digest('hex'),
  untrackedSourcePaths: git(['ls-files', '--others', '--exclude-standard', '--', 'packages/runner/src', 'packages/adapters/src']).trim(),
  evidence: 'OFFLINE_PERSISTENCE_AND_SNAPSHOT_ONLY',
});
const sourceEvidence = readSourceEvidence();

const original = [{ pack: 'alpha', quantity: 2 }, { pack: 'beta', quantity: 1 }];
const changed = [{ pack: 'alpha', quantity: 1 }, { pack: 'gamma', quantity: 2 }];
const custody = async () => ({ realizedLossMicroUsd: '0', atRiskMicroUsd: '0', outstandingMicroUsd: '0',
  heldAssets: false, heldPositions: { count: 0, valueMicroUsd: '0', positions: [] }, unattributed: false,
  unvaluedExposure: false, cycles: [] });

// Stage completions are explicit offline fixtures, not claims of executed purchases or fork writes.
async function closeFixtureCycle(repository, cycleId) {
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, { stage, finalized: true });
  }
  await repository.completeCycle(cycleId);
}

for (let attempt = 1; attempt <= 3; attempt++) {
  test(`attempt ${attempt}: saved plan survives repeated cycle snapshots, active edit and restart`, async t => {
    t.diagnostic(JSON.stringify(sourceEvidence));
    assert.equal(sourceEvidence.untrackedSourcePaths, '', 'Source must not contain unhashed new implementation files');
    const directory = await mkdtemp(join(tmpdir(), 'dashboard-plan-acceptance-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = join(directory, 'operator.json');
    const cycleDirectory = join(directory, 'cycles');
    let repository = await CycleRepository.open(cycleDirectory, () => 1000);
    const control = createOperatorControl({ statePath, cycleRepository: repository,
      policyEngine: { recordManualApproval: async () => { throw new Error('No approvals in this test'); } }, readCustody: custody });
    const save = (orders, revision) => control.execute({ expectedRevision: revision,
      command: { type: 'update-configuration', configuration: { packPlan: { orders } } } });
    const first = await save(original, null);
    assert.deepEqual(first.configuration.packPlan.orders, original);
    const openFromSaved = async id => repository.createCycle({ cycleId: id, releaseAmount: '1', mode: 'rehearsal',
      packPlan: (await readOperatorState(statePath)).configuration.packPlan });
    const firstCycle = await openFromSaved('acceptance-first');
    assert.deepEqual(firstCycle.packPlanSnapshot.plan.orders, original);
    await closeFixtureCycle(repository, firstCycle.cycleId);
    const secondCycle = await openFromSaved('acceptance-second');
    assert.deepEqual(secondCycle.packPlanSnapshot.plan.orders, original);
    const beforeEdit = structuredClone(secondCycle.packPlanSnapshot);
    const second = await save(changed, first.revision);
    assert.deepEqual(second.configuration.packPlan.orders, changed);
    assert.deepEqual((await repository.readActiveCycle()).packPlanSnapshot, beforeEdit);
    const restartScript = `import { CycleRepository } from ${JSON.stringify(source('packages/adapters/src/app/cycle-repository.mjs'))}; import { readOperatorState } from ${JSON.stringify(source('packages/runner/src/operator/state-file.mjs'))}; console.log(JSON.stringify({ active: await (await CycleRepository.open(process.argv[1])).readActiveCycle(), saved: await readOperatorState(process.argv[2]) }));`;
    const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', restartScript, cycleDirectory, statePath], { encoding: 'utf8' }));
    assert.deepEqual(restarted.active.packPlanSnapshot, beforeEdit);
    assert.deepEqual(restarted.saved.configuration.packPlan.orders, changed);
    await assert.rejects(save(original, first.revision), /stale operator state revision/);
    repository = await CycleRepository.open(cycleDirectory, () => 2000);
    await closeFixtureCycle(repository, secondCycle.cycleId);
    const thirdCycle = await openFromSaved('acceptance-third');
    assert.deepEqual(thirdCycle.packPlanSnapshot.plan.orders, changed);
    assert.deepEqual((await repository.describeCycle(firstCycle.cycleId)).packPlanSnapshot.plan.orders, original);
    assert.deepEqual((await repository.describeCycle(secondCycle.cycleId)).packPlanSnapshot, beforeEdit);
    assert.deepEqual((await readOperatorState(statePath)).configuration.packPlan, second.configuration.packPlan);
    assert.deepEqual(readSourceEvidence(), sourceEvidence, 'Source changed during acceptance run');
  });
}
