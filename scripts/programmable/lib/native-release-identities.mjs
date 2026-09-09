import { verifyDerivedAddresses } from '../../launch/derive-addresses.mjs';
import { sha256Bytes } from './canonical-json.mjs';
import { deriveNativeIssuanceCommitments, snapshotNativeCommitmentInputs } from './native-issuance-commitments.mjs';

const equal = (actual, expected, label) => {
  if (expected === undefined || actual !== expected) throw new Error(`native release identity mismatch: ${label}`);
};

/**
 * Read-only local consistency check. Neither supplied evidence nor this result grants authority.
 * Use explicit target artifactPath keys matching the committed closure and an inputDirectory
 * rooted at those paths. The complete producer must also bind deploymentManifestPath.
 */
export function verifyNativeReleaseIdentities({ commitments, derived, ...derivation }) {
  commitments = snapshotNativeCommitmentInputs(commitments);
  const launchInputs = structuredClone(derivation.launchInputs);
  equal(launchInputs?.schemaVersion, 'hookemon.phase3.launch-inputs.v2', 'native launch schema');
  equal(derived?.schemaVersion, 'hookemon.phase3.derived-addresses.v2', 'native derived schema');
  const hashes = deriveNativeIssuanceCommitments(commitments);
  const { binding } = commitments;
  equal(binding.chainId, launchInputs.chain.chainId, 'chain');
  equal(launchInputs.hookConstructorConfig.bindingDigest, hashes.bindingDigest, 'constructor bindingDigest');
  equal(launchInputs.hookConstructorConfig.runtimeDigest, hashes.runtimeDigest, 'constructor runtimeDigest');
  // Recompute every constructor, salt, address, immutable patch, PoolKey and graph call from
  // the actual artifact files. A caller's stored derived object is only a comparison target.
  const recomputed = structuredClone(derived);
  verifyDerivedAddresses({ ...derivation, launchInputs, derived: recomputed });
  for (const [role, address] of Object.entries(binding.roles)) {
    equal(address, launchInputs.roles[role === 'poolManager' ? 'manager' : role]?.toLowerCase(), `role ${role}`);
  }
  const economics = {
    name: 'Hookemon', symbol: 'HKMN', decimals: '18', totalSupplyAtomic: launchInputs.pool.hkmnAtomic,
    marketAllocationBps: '10000', quoteAsset: 'native', tickSpacing: String(launchInputs.pool.tickSpacing),
    lpFee: String(launchInputs.pool.fee), totalFeeBps: '300', programmableFeeBps: '10', treasuryFeeBps: '40',
    hookPermissionMask: '8396', processClaimLimit6hWei: launchInputs.hookConstructorConfig.processClaimLimit6hWei,
    processClaimLimitMaxWei: launchInputs.hookConstructorConfig.processClaimLimitMaxWei,
    processClaimMaxCount: String(launchInputs.hookConstructorConfig.processClaimMaxCount),
    operationsRotationDelay: String(launchInputs.hookConstructorConfig.operationsRotationDelay),
  };
  for (const [field, value] of Object.entries(economics)) equal(binding.economics[field], value, `economics ${field}`);
  equal(binding.independentDeployment.graphFactory, recomputed.chain.factory.toLowerCase(), 'graph factory');
  for (const name of ['token', 'custody']) {
    equal(binding.independentDeployment[`${name}InitCodeHash`], recomputed.targets[name].initCodeHash, `${name} init code`);
    equal(binding.independentDeployment[`${name}EffectiveSalt`], recomputed.targets[name].effectiveSalt, `${name} effective salt`);
  }
  for (const [name, target] of Object.entries(recomputed.targets)) {
    const bytes = commitments.sourceBytes[target.artifactPath];
    if (!Object.hasOwn(commitments.sourceBytes, target.artifactPath) || !Buffer.isBuffer(bytes)) throw new Error(`native release artifact missing from committed closure: ${name}`);
    equal(sha256Bytes(bytes), target.artifactDigest, `${name} artifact bytes`);
  }
  return { bindingDigest: hashes.bindingDigest, runtimeDigest: hashes.runtimeDigest, derived: recomputed };
}
