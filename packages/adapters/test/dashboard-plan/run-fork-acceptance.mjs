// Manual local-fork acceptance. Never starts or resets the coordinator's node.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const required = name => { assert.ok(process.env[name], `${name} is required`); return resolve(process.env[name]); };
const artifactRoot = required('HOOKEMON_DASHBOARD_FORK_ARTIFACT_ROOT');
const solc = required('HOOKEMON_DASHBOARD_FORK_SOLC');
const harnessSourcePath = required('HOOKEMON_DASHBOARD_FORK_HARNESS_SOURCE');
const anvilBinary = required('HOOKEMON_DASHBOARD_FORK_ANVIL');
const sha = value => createHash('sha256').update(value).digest('hex');
const solcVersion = execFileSync(solc, ['--version'], { encoding: 'utf8' });
const anvilVersion = execFileSync(anvilBinary, ['--version'], { encoding: 'utf8' });
assert.match(solcVersion, /0\.8\.26\+commit\.8a97fa7a/);
assert.match(anvilVersion, /Version: 1\.7\.1/);
const directory = join(root, '.session', `dashboard-fork-${Date.now()}`);
await mkdir(directory, { recursive: true });
const source = join(directory, 'source');
const manifest = JSON.parse(await readFile(join(artifactRoot, '..', 'address-manifest.json'), 'utf8'));
const artifactHashes = {};
const frozenArtifacts = join(directory, 'artifacts');
await mkdir(frozenArtifacts);
for (const name of ['token', 'hook', 'custody']) {
  const bytes = await readFile(join(artifactRoot, `${name}.json`));
  artifactHashes[name] = `sha256:${sha(bytes)}`;
  assert.equal(artifactHashes[name], manifest.targets.find(target => target.targetId === name).artifactSha256);
  await writeFile(join(frozenArtifacts, `${name}.json`), bytes);
}
const harnessContent = await readFile(harnessSourcePath, 'utf8');
const provenance = JSON.parse(await readFile(new URL('./fork-fixture-provenance.json', import.meta.url), 'utf8'));
assert.equal(sha(harnessContent), provenance.sourceSha256['packages/contracts/test/integration/ForkCycleHarness.sol']);
const compilerInput = { language: 'Solidity', sources: { 'ForkCycleHarness.sol': { content: harnessContent } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const compiled = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(compilerInput), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
assert.deepEqual((compiled.errors ?? []).filter(error => error.severity === 'error'), []);
const harnessOutput = join(directory, 'harness-output.json');
await writeFile(harnessOutput, JSON.stringify(compiled));
for (const name of ['packages/adapters', 'packages/runner', 'packages/dashboard', 'packages/domain', 'packages/contracts/tooling', 'architecture', 'bindings']) {
  await cp(join(root, name), join(source, name), { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/.session/') });
}
await symlink(join(root, 'packages/adapters/node_modules'), join(source, 'packages/adapters/node_modules'));
const key = `0x${randomBytes(32).toString('hex')}`;
const solana = Keypair.generate();
const policyPath = join(source, 'packages/runner/src/automation/policy-engine.mjs');
const original = await readFile(policyPath, 'utf8');
const oldEvm = "const OPERATIONS_EVM = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';";
const oldSolana = "const OPERATIONS_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';";
assert.equal(original.split(oldEvm).length, 2); assert.equal(original.split(oldSolana).length, 2);
const changed = original.replace(oldEvm, `const OPERATIONS_EVM = '${privateKeyToAccount(key).address.toLowerCase()}';`)
  .replace(oldSolana, `const OPERATIONS_SOLANA = '${solana.publicKey.toBase58()}';`);
assert.equal(original.split('\n').filter((line, index) => line !== changed.split('\n')[index]).length, 2);
await writeFile(policyPath, changed);
const catalogResponse = await fetch('https://gacha.collectorcrypt.com/api/machines', { redirect: 'error', signal: AbortSignal.timeout(15000) });
assert.equal(catalogResponse.status, 200);
const catalogBytes = await catalogResponse.text();
const catalog = JSON.parse(catalogBytes);
assert.ok(Array.isArray(catalog.machines));
for (const code of ['pokemon_25', 'pokemon_50']) assert.ok(catalog.machines.some(machine => machine.code === code && machine.public === true));
const catalogPath = join(directory, 'catalog.json');
await writeFile(catalogPath, catalogBytes);
const rpc = async (url, method, params = []) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const body = await response.json(); assert.ok(!body.error); return body.result;
};
const localRpc = 'http://127.0.0.1:28545';
let occupied = false;
try { await rpc(localRpc, 'web3_clientVersion'); occupied = true; } catch {}
assert.equal(occupied, false, 'Refusing to replace an existing process at port 28545');
const publicRpc = 'https://rpc.mainnet.chain.robinhood.com';
const forkBlock = await rpc(publicRpc, 'eth_getBlockByNumber', ['latest', false]);
assert.equal(Number(await rpc(publicRpc, 'eth_chainId')), 4663);
const node = spawn(anvilBinary, ['--host', '127.0.0.1', '--port', '28545', '--accounts', '0', '--silent', '--fork-url', publicRpc,
  '--fork-block-number', String(Number(forkBlock.number))], { stdio: 'ignore' });
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (node.exitCode !== null) throw new Error('Owned Anvil exited before readiness');
    try { await rpc(localRpc, 'anvil_metadata'); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Owned Anvil did not become ready');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const copiedFileHashes = {};
  async function hashTree(relative = '') {
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await hashTree(name);
      else if (entry.isFile()) copiedFileHashes[name] = sha(await readFile(join(source, name)));
    }
  }
  await hashTree();
  const evidence = { launcherSha256: sha(await readFile(fileURLToPath(import.meta.url))), copiedFileHashes, scope: 'LOCAL_EVM_MAINNET_FORK_WITH_SIMULATED_RELAY_COLLECTOR_SOLANA',
    sourceHead: git(['rev-parse', 'HEAD']).trim(), trackedDiffSha256: sha(git(['diff', 'HEAD'])),
    originalPolicySha256: sha(original), isolatedPolicySha256: sha(changed), identityTransformation: 'Two operations identity pins in disposable source only',
    solcVersion, anvilVersion, artifactHashes, harnessSourceSha256: sha(harnessContent),
    catalog: { source: 'https://gacha.collectorcrypt.com/api/machines', observedAt: new Date().toISOString(), sha256: sha(catalogBytes), count: catalog.machines.length },
    forkBlock: { number: Number(forkBlock.number), hash: forkBlock.hash } };
  await writeFile(join(directory, 'scope.json'), JSON.stringify(evidence, null, 2));
  console.log(`Evidence directory: ${directory}`);
  const child = spawn(process.execPath, ['--test', join(source, 'packages/adapters/test/dashboard-plan/builtin-fork-acceptance.test.mjs')], {
    cwd: source, env: { ...process.env, FORK_TEST_EVM_KEY: key, FORK_TEST_SOLANA_KEY: Buffer.from(solana.secretKey).toString('base64'),
      FORK_ARTIFACT_ROOT: frozenArtifacts, FORK_HARNESS_OUTPUT: harnessOutput, DASHBOARD_FORK_OUTPUT: directory, DASHBOARD_FORK_CATALOG: catalogPath }, stdio: 'inherit' });
  process.exitCode = await new Promise(resolve => child.once('exit', code => resolve(code ?? 1)));
} finally {
  node.kill('SIGTERM');
  await new Promise(resolve => { if (node.exitCode !== null) resolve(); else node.once('exit', resolve); });
}
