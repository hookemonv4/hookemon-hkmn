import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductionTestFixture, productionCyclePreflight } from './production-cycle.mjs';

const preflightUrl = new URL('../../src/cycle/preflight.mjs', import.meta.url);
const evidenceProfileUrl = new URL('../../src/cycle/evidence-profile.mjs', import.meta.url);

test('loads under a provisional interface authority and rejects a live mutation authority request', async () => {
  const preflight = await import(preflightUrl.href);

  assert.match(preflight.FIXTURE_BINDING_MANIFEST_DIGEST, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof preflight.requireLiveMutationAuthority, 'function');
  assert.equal(typeof preflight.requireLiveBindingManifestDigest, 'function');
  assert.equal(typeof preflight.assertRetainedCustodyMutationAuthority, 'function');
  assert.throws(
    () => preflight.requireLiveMutationAuthority(),
    /active frozen interface authority is invalid/,
  );
  assert.throws(
    () => preflight.requireLiveBindingManifestDigest(),
    /active frozen interface authority is invalid/,
  );

  const genericallyFrozenPhase3 = {
    schemaVersion: 'hookemon.interfaces.v1',
    productPhase: 3,
    requirementsRevision: 60,
    architectureRevision: 7,
    status: 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING',
    bindingManifestDigest: `sha256:${'a'.repeat(64)}`,
    freezeRules: { legacyCustodyFamily: 'FROZEN_NOT_DEPLOYED' },
    phaseBoundary: { legacyCustodyFamilyDeployment: 'FORBIDDEN' },
  };
  assert.throws(
    () => preflight.assertRetainedCustodyMutationAuthority(genericallyFrozenPhase3),
    /retained custody mutation is forbidden/,
  );
});

test('production evidence profiles remain read-only while the test factory supplies simulation authority', async () => {
  const {
    createProductionEvidenceProfile,
    createTestProductionEvidenceProfile,
  } = await import(evidenceProfileUrl.href);

  assert.throws(
    () => createProductionEvidenceProfile(),
    /production evidence profile requires an injected Solana chain observer/,
  );
  assert.throws(
    () => createTestProductionEvidenceProfile(),
    /production evidence profile requires an injected Solana chain observer/,
  );
});

test('production evidence profile refuses an absent authoritative MoneyConfigurationV1', () => {
  assert.throws(
    () => createProductionTestFixture({ moneyConfiguration: null }),
    /MoneyConfigurationV1/,
  );
});

test('production preflight rejects a scalar projection that diverges from MoneyConfigurationV1', () => {
  const fixture = createProductionTestFixture();
  const projected = fixture.evidenceProfile.preflight.verify(
    productionCyclePreflight(`0x${'7'.repeat(64)}`, fixture),
  );
  const forged = {
    ...projected,
    minimumReceives: { ...projected.minimumReceives, return: '2' },
  };
  assert.throws(
    () => fixture.evidenceProfile.preflight.verify(forged),
    /does not match the MoneyConfigurationV1 projection/,
  );
});
