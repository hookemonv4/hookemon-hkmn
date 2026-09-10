import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAddresses } from '../launch/derive-addresses.mjs';
import { encodeNativeConstructorConfig, mineProgrammableSalt } from '../mine-hook-address.mjs';
import { keccak256 } from '../../packages/contracts/tooling/payout/canonical-merkle-sum.mjs';
import { deriveNativeIssuanceCommitments, envelope, sha256 } from '../programmable/lib/native-issuance-commitments.mjs';
import { verifyNativeReleaseIdentities } from '../programmable/lib/native-release-identities.mjs';

// Synthetic compiler artifacts and fixed public identities, copied from the native address
// derivation fixture. They test byte consistency only and are not deployment evidence.
const fixtureInput = {"schemaVersion":"hookemon.phase3.launch-inputs.v2","chain":{"chainId":"4663","factory":"0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd","authorizedLauncher":"0x34965F2A2ee9254522232C32F02056E92BE0C98a","routeNamespace":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","routeNonce":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"graphAuthorization":{"topologyHash":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","totalValue":{"chainId":"4663","assetId":"native","decimals":18,"amountAtomic":"0"}},"compilerProfile":{"solc":"0.8.26+commit.8a97fa7a","optimizer":{"enabled":true,"runs":200},"viaIR":true,"evmVersion":"cancun","metadata":{"appendCBOR":false,"bytecodeHash":"none","useLiteralContent":false}},"roles":{"manager":"0x1111111111111111111111111111111111111111","positionManager":"0x2222222222222222222222222222222222222222","permit2":"0x3333333333333333333333333333333333333333","programmable":"0x4444444444444444444444444444444444444444","treasury":"0x5555555555555555555555555555555555555555","operations":"0x6666666666666666666666666666666666666666","launchAuthority":"0x7777777777777777777777777777777777777777","issuanceAuthority":"0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd"},"pool":{"fee":0,"tickSpacing":60,"priceCandidates":{"nativeCurrency0":{"sqrtPriceX96":"12527072418752396559322253362376889"}},"seedMaximumWei":"40000000000000000","hkmnAtomic":"1000000000000000000000000000"},"hookConstructorConfig":{"manager":{"ref":"roles.manager"},"positionManager":{"ref":"roles.positionManager"},"permit2":{"ref":"roles.permit2"},"hkmn":{"ref":"addresses.token"},"tickSpacing":{"ref":"pool.tickSpacing"},"programmable":{"ref":"roles.programmable"},"treasury":{"ref":"roles.treasury"},"operations":{"ref":"roles.operations"},"launchAuthority":{"ref":"roles.launchAuthority"},"issuanceAuthority":{"ref":"roles.issuanceAuthority"},"expectedDecimals":18,"bindingDigest":"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","runtimeDigest":"0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","processClaimMaxCount":"8","operationsRotationDelay":"259200","quoteCurrency":{"ref":"quoteCurrency"},"processClaimLimit6hWei":"10000000000000000","processClaimLimitMaxWei":"20000000000000000"},"targets":{"token":{"targetIndex":0,"targetId":"token","targetIdHash":"0x1111111111111111111111111111111111111111111111111111111111111111","applicantSalt":{"mode":"fixed","value":"0x0000000000000000000000000000000000000000000000000000000000000004"},"artifactPath":"token.json","contractName":"HKMNToken","constructorArguments":[{"ref":"chain.factory"},{"ref":"quoteCurrency"},18,{"ref":"pool.selectedPriceCandidate.sqrtPriceX96"}],"initializerCalldata":"0xffd7d9830000000000000000000000003ec2bdc568a4e300321be2361ecafe081c7820cc","deploymentValue":{"chainId":"4663","assetId":"native","decimals":18,"amountAtomic":"0"},"initializerValue":{"chainId":"4663","assetId":"native","decimals":18,"amountAtomic":"0"},"runtimeImmutablePatches":[]},"hook":{"targetIndex":2,"targetId":"hook","targetIdHash":"0x2222222222222222222222222222222222222222222222222222222222222222","applicantSalt":{"mode":"mine","start":"0","maxAttempts":"200000"},"artifactPath":"hook.json","contractName":"HookemonHook","initializerCalldata":"0x726bb4ae000000000000000000000000df2baa725f6e0c6a9a1bbaefdab09f40c33e28a000000000000000000000000000000000000269a1e20cd6f98de0e6990952b0b9","deploymentValue":{"chainId":"4663","assetId":"native","decimals":18,"amountAtomic":"0"},"initializerValue":{"chainId":"4663","assetId":"native","decimals":18,"amountAtomic":"0"},"runtimeImmutablePatches":[]},"custody":{"targetIndex":1,"targetId":"custody","targetIdHash":"0x3333333333333333333333333333333333333333333333333333333333333333","applicantSalt":{"mode":"fixed","value":"0x0000000000000000000000000000000000000000000000000000000000000003"},"artifactPath":"custody.json","contractName":"PermanentPositionCustody","constructorArguments":[{"ref":"roles.positionManager"},0],"initializerCalldata":"0xc81cbd430000000000000000000000003ec2bdc568a4e300321be2361ecafe081c7820cc","deploymentValue":{"chainId":"4663","assetId":"native","decimals":18,"amountAtomic":"0"},"initializerValue":{"chainId":"4663","assetId":"native","decimals":18,"amountAtomic":"0"},"runtimeImmutablePatches":[]}},"quoteCurrency":"0x0000000000000000000000000000000000000000","seedIntent":{"payer":"0x7777777777777777777777777777777777777777","tickLower":-887220,"tickUpper":887220,"maxDeadlineSeconds":900}};
const fixtureArtifacts = {"token.json":{"contractName":"HKMNToken","abi":[{"type":"constructor","inputs":[{"name":"issuanceAuthority_","type":"address"},{"name":"expectedQuoteCurrency_","type":"address"},{"name":"decimals_","type":"uint8"},{"name":"launchSqrtPriceX96_","type":"uint160"}]}],"bytecode":{"object":"0x600a600c600039600a6000f3602a60005260206000f3"},"deployedBytecode":{"object":"0x60006000f3"},"metadata":"{\"compiler\":{\"version\":\"0.8.26+commit.8a97fa7a\"},\"settings\":{\"optimizer\":{\"enabled\":true,\"runs\":200},\"viaIR\":true,\"evmVersion\":\"cancun\",\"metadata\":{\"appendCBOR\":false,\"bytecodeHash\":\"none\",\"useLiteralContent\":false},\"compilationTarget\":{\"src/launch/HKMNToken.sol\":\"HKMNToken\"}}}"},"hook.json":{"contractName":"HookemonHook","abi":[{"type":"constructor","inputs":[{"name":"config","type":"tuple","components":[{"name":"manager","type":"address"},{"name":"positionManager","type":"address"},{"name":"permit2","type":"address"},{"name":"quoteCurrency","type":"address"},{"name":"hkmn","type":"address"},{"name":"tickSpacing","type":"int24"},{"name":"programmable","type":"address"},{"name":"treasury","type":"address"},{"name":"operations","type":"address"},{"name":"launchAuthority","type":"address"},{"name":"issuanceAuthority","type":"address"},{"name":"expectedDecimals","type":"uint8"},{"name":"bindingDigest","type":"bytes32"},{"name":"runtimeDigest","type":"bytes32"},{"name":"processClaimLimit6hWei","type":"uint256"},{"name":"processClaimLimitMaxWei","type":"uint256"},{"name":"processClaimMaxCount","type":"uint256"},{"name":"operationsRotationDelay","type":"uint256"}]}]}],"bytecode":{"object":"0x600b600c600039600b6000f3602b60005260206000f3"},"deployedBytecode":{"object":"0x6001600055"},"metadata":"{\"compiler\":{\"version\":\"0.8.26+commit.8a97fa7a\"},\"settings\":{\"optimizer\":{\"enabled\":true,\"runs\":200},\"viaIR\":true,\"evmVersion\":\"cancun\",\"metadata\":{\"appendCBOR\":false,\"bytecodeHash\":\"none\",\"useLiteralContent\":false},\"compilationTarget\":{\"src/HookemonHook.sol\":\"HookemonHook\"}}}"},"custody.json":{"contractName":"PermanentPositionCustody","abi":[{"type":"constructor","inputs":[{"name":"manager","type":"address"},{"name":"tokenId","type":"uint256"}]}],"bytecode":{"object":"0x600c600c600039600c6000f3602c60005260206000f3"},"deployedBytecode":{"object":"0x6002600055"},"metadata":"{\"compiler\":{\"version\":\"0.8.26+commit.8a97fa7a\"},\"settings\":{\"optimizer\":{\"enabled\":true,\"runs\":200},\"viaIR\":true,\"evmVersion\":\"cancun\",\"metadata\":{\"appendCBOR\":false,\"bytecodeHash\":\"none\",\"useLiteralContent\":false},\"compilationTarget\":{\"src/bindings/RobinhoodBindings.sol\":\"PermanentPositionCustody\"}}}"}};
const hash = value => `0x${Buffer.from(keccak256(Buffer.from(value.slice(2), 'hex'))).toString('hex')}`;
const word = value => value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const selector = signature => `0x${Buffer.from(keccak256(Buffer.from(signature))).toString('hex').slice(0, 8)}`;
const files = bytes => Object.keys(bytes).sort().map(path => ({ path, sha256: sha256(bytes[path]) }));

function fixture(programmableFeeBps = '20') {
  const inputDirectory = mkdtempSync(join(tmpdir(), 'native-release-identities-'));
  const launchInputs = structuredClone(fixtureInput);
  const sourceBytes = Object.fromEntries(Object.entries(fixtureArtifacts).map(([path, artifact]) => {
    const bytes = Buffer.from(JSON.stringify(artifact));
    writeFileSync(join(inputDirectory, path), bytes);
    return [path, bytes];
  }));
  sourceBytes['compiler'] = Buffer.from('synthetic compiler, not executable');
  sourceBytes['input.json'] = Buffer.from(JSON.stringify({ language: 'Solidity', sources: {}, settings: {} }));
  const initial = deriveAddresses({ launchInputs, inputDirectory });
  const h = `0x${'11'.repeat(32)}`;
  const evidenceBytes = { 'abi.json': Buffer.from('[]'), 'code.bin': Buffer.from([0]), 'observation.json': Buffer.from('{"synthetic":true}') };
  const runtime = { schema: 'hookemon.native-issuance-runtime-authority.v1', chainId: '4663', genesisHash: h,
    providerProtocol: 'synthetic', providerVersion: 'test-only', contracts: [{ role: 'issuance',
      address: launchInputs.roles.issuanceAuthority.toLowerCase(), codePath: 'code.bin', abiPath: 'abi.json',
      observationPath: 'observation.json', blockNumber: '1', blockHash: h }], evidenceFiles: files(evidenceBytes) };
  const binding = { schema: 'hookemon.native-issuance-prebinding.v1', chainId: '4663', genesisHash: h,
    requirementsSha256: h, sourceClosure: { compilerPath: 'compiler', standardInputPath: 'input.json', files: files(sourceBytes) },
    roles: Object.fromEntries(Object.entries(launchInputs.roles).map(([role, address]) => [role === 'manager' ? 'poolManager' : role, address.toLowerCase()])),
    economics: { name: 'Hookemon', symbol: 'HKMN', decimals: '18', totalSupplyAtomic: launchInputs.pool.hkmnAtomic,
      marketAllocationBps: '10000', quoteAsset: 'native', tickSpacing: '60', lpFee: '0', totalFeeBps: '300',
      programmableFeeBps, treasuryFeeBps: '40', hookPermissionMask: '8396',
      processClaimLimit6hWei: launchInputs.hookConstructorConfig.processClaimLimit6hWei,
      processClaimLimitMaxWei: launchInputs.hookConstructorConfig.processClaimLimitMaxWei,
      processClaimMaxCount: String(launchInputs.hookConstructorConfig.processClaimMaxCount),
      operationsRotationDelay: String(launchInputs.hookConstructorConfig.operationsRotationDelay) },
    independentDeployment: { graphFactory: initial.chain.factory.toLowerCase(), tokenInitCodeHash: initial.targets.token.initCodeHash,
      tokenEffectiveSalt: initial.targets.token.effectiveSalt, custodyInitCodeHash: initial.targets.custody.initCodeHash,
      custodyEffectiveSalt: initial.targets.custody.effectiveSalt }, runtimeAuthorityDigest: envelope('HOOKEMON_NATIVE_ISSUANCE_RUNTIME_AUTHORITY_V1', runtime) };
  const commitments = { binding, runtime, sourceBytes, evidenceBytes };
  Object.assign(launchInputs.hookConstructorConfig, deriveNativeIssuanceCommitments(commitments));
  const config = Object.fromEntries(Object.entries(launchInputs.hookConstructorConfig).map(([key, value]) => [key,
    value?.ref ? value.ref.split('.').reduce((node, segment) => node[segment], { ...launchInputs, addresses: { token: initial.targets.token.address } }) : value]));
  const initCodeHashHex = hash(`${fixtureArtifacts['hook.json'].bytecode.object}${encodeNativeConstructorConfig(config).slice(2)}`);
  const mined = mineProgrammableSalt({ ...launchInputs.chain, targetIdHash: launchInputs.targets.hook.targetIdHash,
    initCodeHashHex, mask: 16383n, required: 8396n, startSalt: 0n, maxAttempts: 200000 });
  launchInputs.targets.hook.applicantSalt = { mode: 'fixed', value: mined.applicantSalt };
  launchInputs.targets.token.initializerCalldata = `${selector('allocate(address)')}${word(mined.address)}`;
  launchInputs.targets.custody.initializerCalldata = `${selector('configureBindingHook(address)')}${word(mined.address)}`;
  const derived = deriveAddresses({ launchInputs, inputDirectory });
  return { launchInputs, inputDirectory, derived, commitments };
}

test('native final identities bind constructor commitments, artifacts and the complete atomic graph without authority', () => {
  const f = fixture();
  try {
    const result = verifyNativeReleaseIdentities(f);
    assert.deepEqual(result.derived, f.derived);
    assert.deepEqual(Object.keys(result).sort(), ['bindingDigest', 'derived', 'runtimeDigest']);
    assert.equal(result.derived.pool.currency0, '0x0000000000000000000000000000000000000000');
    assert.deepEqual(result.derived.graph.orderedTargetIds, ['token', 'custody', 'hook']);
    for (const change of [
      d => { d.targets.hook.constructorArguments += '00'; },
      d => { d.targets.token.initCodeHash = `0x${'12'.repeat(32)}`; },
      d => { d.targets.custody.effectiveSalt = `0x${'12'.repeat(32)}`; },
      d => { d.targets.hook.effectiveSalt = `0x${'12'.repeat(32)}`; },
      d => { d.targets.hook.address = d.targets.token.address; },
      d => { d.targets.hook.runtimeCode += '00'; },
      d => { d.pool.poolId = `0x${'12'.repeat(32)}`; },
      d => { d.targets.token.initializerCalldata = '0x'; },
      d => { d.graph.orderedTargetIds.reverse(); },
    ]) {
      const derived = structuredClone(f.derived); change(derived);
      assert.throws(() => verifyNativeReleaseIdentities({ ...f, derived }), /derived address mismatch/);
    }
    const changed = structuredClone(f.launchInputs);
    changed.hookConstructorConfig.bindingDigest = `0x${'12'.repeat(32)}`;
    assert.throws(() => verifyNativeReleaseIdentities({ ...f, launchInputs: changed }), /constructor bindingDigest/);
    changed.hookConstructorConfig.bindingDigest = f.launchInputs.hookConstructorConfig.bindingDigest;
    changed.hookConstructorConfig.runtimeDigest = `0x${'12'.repeat(32)}`;
    assert.throws(() => verifyNativeReleaseIdentities({ ...f, launchInputs: changed }), /constructor runtimeDigest/);
    const sourceBytes = { ...f.commitments.sourceBytes };
    delete sourceBytes['token.json'];
    assert.throws(() => verifyNativeReleaseIdentities({ ...f, commitments: { ...f.commitments, sourceBytes } }), /closure bytes differ/);
    assert.throws(() => verifyNativeReleaseIdentities({ ...f, launchInputs: { ...f.launchInputs, schemaVersion: 'hookemon.phase3.launch-inputs.v1' } }), /native launch schema/);
  } finally { rmSync(f.inputDirectory, { recursive: true, force: true }); }
});

test('native release economics rejects the superseded 10-bps platform allocation', () => {
  const f = fixture('10');
  try {
    assert.throws(() => verifyNativeReleaseIdentities(f), /economics programmableFeeBps/);
  } finally { rmSync(f.inputDirectory, { recursive: true, force: true }); }
});
