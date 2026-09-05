import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

function readJson(file) {
  return JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
}

function isFutureDecisionPath(path) {
  if (typeof path !== 'string') return false;
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === 'future' || normalized.startsWith('future/');
}

function activeControlInputs() {
  const boundary = readJson('product/delivery-boundary.json');
  const initGate = readJson('gates/init.json');
  const registryInputs = boundary.registries.flatMap(registry =>
    registry.sources.flatMap(source => typeof source.file === 'string' ? [source.file] : []));
  const gateInputs = initGate.items.flatMap(item => {
    const policy = item.evidencePolicy;
    return [
      ...policy.requiredInputs,
      ...policy.requiredPrefixes,
      ...policy.allowedInputs,
      ...policy.allowedPrefixes,
    ];
  });

  return [...registryInputs, ...gateInputs];
}

test('the machine-readable delivery boundary opens Phase 3 under revision 65 and architecture revision 9', () => {
  const boundary = readJson('product/delivery-boundary.json');
  const requirements = readJson('specs/requirements.json');
  const interfaces = readJson('architecture/interfaces.json');

  assert.equal(boundary.openDeliveryPhase, 3);
  assert.deepEqual(boundary.phases, {
    1: 'COMPLETE',
    2: 'COMPLETE',
    3: 'OPEN',
  });
  assert.equal(requirements.revision, 65);
  assert.equal(interfaces.productPhase, 3);
  assert.equal(interfaces.requirementsRevision, 65);
  assert.equal(interfaces.architectureRevision, 9);
});

test('future decision storage is excluded from machine-effective inputs', () => {
  assert.equal(isFutureDecisionPath('future/example.md'), true);
  assert.equal(isFutureDecisionPath('./future/example.md'), true);
  assert.equal(isFutureDecisionPath('product/PRD.md'), false);

  const unexpected = [...new Set(activeControlInputs())]
    .filter(isFutureDecisionPath)
    .sort();

  assert.deepEqual(unexpected, []);
});

test('Phase 3 interfaces and module index share the active provisional boundary', () => {
  const interfaces = readJson('architecture/interfaces.json');
  const provisional = readJson('architecture/provisional-interfaces.json');
  const capabilityMap = readJson('architecture/capability-map.json');
  const moduleIndex = readJson('docs/modules/index.json');
  const interfaceIds = interfaces.moduleInterfaces.map(module => module.id);
  const provisionalIds = provisional.modules.map(module => module.id);
  const indexIds = moduleIndex.modules.map(module => module.id);

  for (const artifact of [interfaces, provisional, capabilityMap, moduleIndex]) {
    assert.equal(artifact.productPhase, 3);
    assert.equal(artifact.requirementsRevision, 65);
    assert.equal(artifact.architectureRevision, 9);
  }
  assert.equal(interfaces.status, 'PROVISIONAL_PHASE3_PENDING_FEASIBILITY');
  assert.equal(provisional.status, 'PROVISIONAL');
  assert.equal(moduleIndex.interfaceStatus, 'PROVISIONAL');
  assert.deepEqual(interfaceIds, provisionalIds);
  assert.deepEqual(indexIds, capabilityMap.topologicalOrder);
  assert.equal(interfaces.bindingManifest, 'release/phase3/deployment-manifest.json');
  assert.equal(interfaces.bindingManifestDigest, null);
  assert.equal(interfaces.phaseBoundary.codeReadinessDoesNotAuthorizeLive, true);
  assert.equal(interfaces.phaseBoundary.launchEligibleRequiredForLive, true);
});

test('Foundry remappings expose the nested forge-std dependency from both repository roots', () => {
  const packageRemappings = readFileSync(join(repoRoot, 'packages/contracts/remappings.txt'), 'utf8')
    .split('\n');
  const rootRemappings = readFileSync(join(repoRoot, 'remappings.txt'), 'utf8').split('\n');

  assert.equal(packageRemappings.includes('forge-std/=lib/v4-core/lib/forge-std/src/'), true);
  assert.equal(rootRemappings.includes('forge-std/=packages/contracts/lib/v4-core/lib/forge-std/src/'), true);
});
