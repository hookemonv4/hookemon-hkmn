#!/usr/bin/env node
// Anvil integration check for src/hook-contract-client.mjs and src/robinhood-rpc.mjs.
//
// Separate, non-blocking, real-tooling script (same pattern as
// test/relay-client.live-chains.mjs) — never part of `node --test test/*.test.mjs`, since it
// shells out to Foundry (`forge`/`anvil`) rather than running under `node --test`.
//
// What this proves, and what it does not:
//   - It deploys the REAL, unmodified `packages/contracts/src/process/PegCycleVault.sol` (copied
//     verbatim into test/fixtures/anvil-fork/src/process/, not reimplemented) to a local anvil
//     node, and drives its full authorizeFunding -> openPegCycle -> executeOutbound ->
//     authorizePayout -> fundPayoutFromPegCycle (consumePayoutAuthorization) happy path using
//     ONLY calldata this adapter's build*Call functions produced — no calldata is hand-written
//     for this script. Every transaction succeeding is direct proof the adapter's encoding is
//     byte-compatible with the real compiled ABI, independent of the cast-calldata cross-check in
//     test/hook-contract-client.test.mjs.
//   - `openPegCycle`/`fundPayoutFromPegCycle` are called against `test/fixtures/anvil-fork/src/MockHook.sol`,
//     a minimal stand-in that reproduces only the on-chain call sequence
//     `ProcessBudget.openPegCycle`/`PayoutCommitment.fundPayoutFromPegCycle` make against
//     `PegCycleVault` (see that file's own header for why): deploying the REAL `HookemonHook`
//     needs a CREATE2 address satisfying Uniswap v4's hook-permission-bit mask, which is WP-20's
//     scope (design.md §7), not WP-10's. `PegCycleVault`/`PegCycleReturnEscrow` themselves are
//     used completely unmodified.
//   - This is NOT a fork of live Robinhood Chain state — HKMN and the peg-cycle contracts are not
//     deployed there yet (verified live, see scratchpad/w1/summaries/external-facts.json:
//     `market.poolKey` is `INTEGRATION_PENDING`), so there is no finalized Robinhood state
//     containing these contracts to fork. This is the closest available proof: the real compiled
//     contract bytecode, deployed fresh, driven end-to-end by this adapter's own calldata.
//   - Anvil's default accounts/private keys used below are Foundry's publicly documented,
//     well-known local test accounts (identical every time anvil starts with no `--mnemonic`
//     flag) — not a secret, not a real credential, and this script never touches any other chain.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPublicClient, createWalletClient, http, keccak256, toBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  buildAuthorizeFundingCall,
  buildOpenPegCycleCall,
  buildExecuteOutboundCall,
  buildAuthorizePayoutCall,
  buildFundPayoutFromPegCycleCall,
  readCycleLifecycle,
  readCommittedPayoutBinding,
  CYCLE_LIFECYCLE,
} from '../src/hook-contract-client.mjs';
import { readTransactionReceipt } from '../src/robinhood-rpc.mjs';
import { payoutDistributionDigest } from '../src/signing/payout-typed-data.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/anvil-fork/', import.meta.url));
// Foundry's well-known, publicly documented default anvil accounts (deterministic, no --mnemonic
// flag needed) — see https://book.getfoundry.sh/reference/anvil/ "Default accounts".
const ANVIL_DEFAULT_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  // WP-39: two more of Foundry's well-known default anvil accounts, deployed here as
  // `PegCycleVault`'s pinned `distributionSigner`/`distributionVerifier` immutables (WP-38's
  // constructor addition) — never a real secret, identical to every anvil start with no
  // `--mnemonic` flag, exactly like the two keys above.
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
];

function toolAvailable(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return resolve();
      } catch {
        // keep polling until timeout
      }
      if (Date.now() > deadline) return reject(new Error('timed out waiting for anvil to become ready'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function readArtifact(relPath) {
  const path = fileURLToPath(new URL(`./fixtures/anvil-fork/out/${relPath}`, import.meta.url));
  const json = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object, linkReferences: json.bytecode.linkReferences };
}

// `PayoutDistributionSignatures`/`FundingAuthorizationValidation`/`PegCycleEscrowFactory` are
// declared `external` libraries (see their own docstrings), so `PegCycleVault`'s compiled
// bytecode carries unresolved `__$<34-hex-char placeholder>$__` slots at the byte offsets
// `linkReferences` reports — solc's ordinary linking step, which `forge script`/Solidity's own
// `new` normally does transparently. This adapter's raw-bytecode deploy path does not go through
// either, so it performs that same linking itself: each library is deployed independently below,
// then its address is written into the vault's bytecode at every reported offset before the vault
// itself is deployed.
function linkLibraries(bytecodeHex, linkReferences, addressesByLibraryName) {
  let code = bytecodeHex.startsWith('0x') ? bytecodeHex.slice(2) : bytecodeHex;
  for (const files of Object.values(linkReferences ?? {})) {
    for (const [libraryName, references] of Object.entries(files)) {
      const address = addressesByLibraryName[libraryName];
      assert.ok(address, `missing deployed address for library ${libraryName}`);
      const addressHex = address.slice(2).toLowerCase().padStart(40, '0');
      for (const { start, length } of references) {
        const byteStart = start * 2;
        const byteLength = length * 2;
        code = code.slice(0, byteStart) + addressHex.slice(0, byteLength) + code.slice(byteStart + byteLength);
      }
    }
  }
  return `0x${code}`;
}

async function main() {
  if (!toolAvailable('forge') || !toolAvailable('anvil')) {
    console.log('SKIP: forge/anvil not found on PATH — this script requires the Foundry toolchain (pinned 1.7.1).');
    return;
  }

  console.log('Building the anvil-fork fixture project (real PegCycleVault.sol + minimal mocks)...');
  try {
    execFileSync('forge', ['build'], { cwd: FIXTURE_DIR, stdio: 'pipe' });
  } catch (error) {
    console.error(error.stdout?.toString() ?? '');
    console.error(error.stderr?.toString() ?? '');
    throw error;
  }

  const port = 8700 + Math.floor(Math.random() * 500);
  const rpcUrl = `http://127.0.0.1:${port}`;
  console.log(`Starting anvil on ${rpcUrl}...`);
  const anvil = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });

  try {
    await waitFor(async () => {
      const res = await fetch(rpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      return res.ok;
    });

    const deployer = privateKeyToAccount(ANVIL_DEFAULT_KEYS[0]); // also authorizer + deploymentAuthority
    const operations = privateKeyToAccount(ANVIL_DEFAULT_KEYS[1]); // operationsTrigger
    const distributionSigner = privateKeyToAccount(ANVIL_DEFAULT_KEYS[2]); // WP-38/WP-39: distributionSigner
    const distributionVerifier = privateKeyToAccount(ANVIL_DEFAULT_KEYS[3]); // WP-38/WP-39: distributionVerifier

    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const deployerClient = createWalletClient({ account: deployer, transport: http(rpcUrl) });
    const operationsClient = createWalletClient({ account: operations, transport: http(rpcUrl) });
    const chainId = await publicClient.getChainId();

    async function deploy(artifactPath, args = [], { bytecodeOverride } = {}) {
      const { abi, bytecode } = readArtifact(artifactPath);
      const hash = await deployerClient.deployContract({ abi, bytecode: bytecodeOverride ?? bytecode, args, chain: null });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success', `${artifactPath} deployment failed`);
      return { address: receipt.contractAddress, abi };
    }

    async function sendCall(walletClient, callSpec, label) {
      const hash = await walletClient.sendTransaction({ to: callSpec.to, data: callSpec.data, chain: null });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success', `${label} reverted (hash ${hash})`);
      return receipt;
    }

    async function writeContract(client, { address, abi }, functionName, args) {
      const hash = await client.writeContract({ address, abi, functionName, args, chain: null });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success', `${functionName} reverted (hash ${hash})`);
      return receipt;
    }

    console.log('Deploying MockUsdg, MockRouteExecutor...');
    const usdg = await deploy('MockUsdg.sol/MockUsdg.json');
    const routeExecutor = await deploy('MockRouteExecutor.sol/MockRouteExecutor.json');

    const bindingManifestDigest = keccak256(toBytes('wp-10-anvil-integration-manifest'));
    console.log('Deploying PegCycleVault\'s external libraries (PayoutDistributionSignatures, '
      + 'FundingAuthorizationValidation, PegCycleEscrowFactory)...');
    const payoutDistributionSignatures = await deploy('PayoutDistributionSignatures.sol/PayoutDistributionSignatures.json');
    const fundingAuthorizationValidation = await deploy('FundingAuthorizationValidation.sol/FundingAuthorizationValidation.json');
    const pegCycleEscrowFactory = await deploy('PegCycleEscrowFactory.sol/PegCycleEscrowFactory.json');

    console.log('Deploying PegCycleVault (real, unmodified contract, linked against the libraries above)...');
    const vaultArtifact = readArtifact('PegCycleVault.sol/PegCycleVault.json');
    const linkedVaultBytecode = linkLibraries(vaultArtifact.bytecode, vaultArtifact.linkReferences, {
      PayoutDistributionSignatures: payoutDistributionSignatures.address,
      FundingAuthorizationValidation: fundingAuthorizationValidation.address,
      PegCycleEscrowFactory: pegCycleEscrowFactory.address,
    });
    const vault = await deploy('PegCycleVault.sol/PegCycleVault.json', [
      usdg.address, deployer.address, routeExecutor.address, bindingManifestDigest, deployer.address,
      distributionSigner.address, distributionVerifier.address,
    ], { bytecodeOverride: linkedVaultBytecode });

    console.log('Deploying MockHook and binding it to the vault...');
    const hook = await deploy('MockHook.sol/MockHook.json', [vault.address, usdg.address]);
    await writeContract(deployerClient, vault, 'bindHook', [hook.address]);

    console.log('Funding MockHook with mock USDG...');
    await writeContract(deployerClient, usdg, 'mint', [hook.address, 1_000_000_000n]);

    const cycleId = keccak256(toBytes('wp-10-anvil-cycle-1'));
    const escrow = await publicClient.readContract({ address: vault.address, abi: vault.abi, functionName: 'computeCycleEscrow', args: [cycleId] });

    const routeData = '0xdeadbeef';
    const outboundActionDigest = keccak256(routeData);
    const returnActionDigest = keccak256(toBytes('wp-10-anvil-return-action'));
    const amount = 25_000_000n;
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const fundingAuthorization = {
      requirementsRevision: 57, chainId: BigInt(chainId), cycleId, hook: hook.address, vault: vault.address,
      usdg: usdg.address, operationsTrigger: operations.address, amount, bindingManifestDigest,
      outboundActionDigest, returnActionDigest, returnDestination: escrow,
      minimumRobinhoodReceive: 1n, minimumSolanaReceive: 1n, minimumReturnUsdg: 20_000_000n,
      robinhoodNativeGasCap: 1n, solanaNativeGasCap: 1n, expiresAt, nonce: 1n,
    };

    console.log('1/5 authorizeFunding (via this adapter\'s buildAuthorizeFundingCall)...');
    await sendCall(deployerClient, buildAuthorizeFundingCall(vault.address, fundingAuthorization), 'authorizeFunding');

    console.log('2/5 openPegCycle on MockHook (via this adapter\'s buildOpenPegCycleCall)...');
    await sendCall(operationsClient, buildOpenPegCycleCall(hook.address, cycleId), 'openPegCycle');
    assert.equal(
      await readCycleLifecycle(publicClient, vault.address, cycleId),
      CYCLE_LIFECYCLE.FUNDED,
      'lifecycle should be FUNDED after openPegCycle',
    );

    console.log('3/5 executeOutbound (via this adapter\'s buildExecuteOutboundCall)...');
    await sendCall(operationsClient, buildExecuteOutboundCall(vault.address, cycleId, routeData), 'executeOutbound');
    assert.equal(
      await readCycleLifecycle(publicClient, vault.address, cycleId),
      CYCLE_LIFECYCLE.OUTBOUND,
      'lifecycle should be OUTBOUND after executeOutbound',
    );

    // Simulate the return leg landing: mint the returned amount directly into the escrow (this
    // adapter does not perform bridging itself — see src/solana-rpc.mjs / relay-client.mjs for
    // that leg; this script only proves the vault-side calldata this adapter produces).
    const rootSum = 20_000_000n;
    await writeContract(deployerClient, usdg, 'mint', [escrow, rootSum]);

    const payoutAuthorization = {
      requirementsRevision: 57, chainId: BigInt(chainId), cycleId, hook: hook.address, vault: vault.address,
      usdg: usdg.address, operationsTrigger: operations.address, bindingManifestDigest,
      payoutId: keccak256(toBytes('wp-10-anvil-payout-1')), manifestDigest: keccak256(toBytes('wp-10-anvil-manifest-1')),
      rootHash: keccak256(toBytes('wp-10-anvil-root-1')), rootSum, returnActionDigest,
      returnReceiptDigest: keccak256(toBytes('wp-10-anvil-receipt-1')), expiresAt, nonce: 2n,
    };

    console.log('4/5 authorizePayout (via this adapter\'s buildAuthorizePayoutCall, dual EIP-712 signed)...');
    // The exact digest PegCycleVault._recoverSigner checks a signature against
    // (../src/signing/payout-typed-data.mjs) — signed here by the two anvil accounts deployed
    // above as distributionSigner/distributionVerifier, proving this adapter's typed-data
    // encoding and viem's local signing produce a signature the real compiled contract accepts.
    const digest = payoutDistributionDigest(payoutAuthorization);
    const distributionSignature = await distributionSigner.sign({ hash: digest });
    const verifierSignature = await distributionVerifier.sign({ hash: digest });
    await sendCall(
      deployerClient,
      buildAuthorizePayoutCall(vault.address, payoutAuthorization, distributionSignature, verifierSignature),
      'authorizePayout',
    );
    assert.equal(
      await readCycleLifecycle(publicClient, vault.address, cycleId),
      CYCLE_LIFECYCLE.RETURNED,
      'lifecycle should be RETURNED after authorizePayout',
    );

    console.log('5/5 fundPayoutFromPegCycle on MockHook, i.e. consumePayoutAuthorization '
      + '(via this adapter\'s buildFundPayoutFromPegCycleCall)...');
    await sendCall(operationsClient, buildFundPayoutFromPegCycleCall(hook.address, payoutAuthorization), 'fundPayoutFromPegCycle');
    assert.equal(
      await readCycleLifecycle(publicClient, vault.address, cycleId),
      CYCLE_LIFECYCLE.PAYOUT_COMMITTED,
      'lifecycle should be PAYOUT_COMMITTED after fundPayoutFromPegCycle',
    );

    const [, committedPayoutId] = await readCommittedPayoutBinding(publicClient, vault.address, cycleId);
    assert.equal(committedPayoutId, payoutAuthorization.payoutId, 'committed payoutId should match the authorization consumed');

    // Also exercise robinhood-rpc.mjs's receipt reader against a real anvil-mined transaction.
    const lastTxHash = (await publicClient.getBlock({ blockTag: 'latest' })).transactions.at(-1);
    if (lastTxHash) {
      const receipt = await readTransactionReceipt(publicClient, lastTxHash);
      assert.equal(receipt.status, 'success');
    }

    console.log('\nALL 5 CALLS ACCEPTED BY THE REAL COMPILED PegCycleVault BYTECODE — adapter encoding confirmed end to end.');
  } finally {
    anvil.kill();
  }
}

main().catch((error) => {
  console.error('\nFAIL:', error.message);
  process.exitCode = 1;
});
