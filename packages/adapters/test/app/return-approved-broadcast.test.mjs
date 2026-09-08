import { returnSigningFixture } from '../native/return-signing-fixture.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createReturnPolicySigner } from '../../src/app/stages/return.mjs';
import { chainBroadcastTransports } from '../../bin/hookemon-runner.mjs';
import { createIsolatedKeychainChildSetup } from '../../src/signing/collector-production-binding.mjs';
import { createKeychainSignerClient, isOwnedKeychainSignOnlyClient } from '../../src/signing/keychain-signer.mjs';
import { createProcessExec } from '../../src/signing/keychain-process-exec.mjs';
import { createSolanaRpcClient, signedSolanaTransactionSignature, TOKEN_PROGRAM_ID } from '../../src/solana-rpc.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const authority = createTestProfileMutationAuthority();

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-return-approved-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = await createIsolatedKeychainChildSetup({ directory });
  const blockhash = Keypair.generate().publicKey.toBase58();
  const native = returnSigningFixture({ sender: child.solanaPublicKey, blockhash });
  let broadcasts = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    let result;
    if (rpc.method === 'getBlockHeight') result = 10;
    else if (rpc.method === 'getSlot') result = 11;
    else if (rpc.method === 'getMultipleAccounts') result = native.observation;
    else if (rpc.method === 'sendTransaction') {
      broadcasts += 1;
      const transaction = Transaction.from(Buffer.from(rpc.params[0], 'base64'));
      assert.equal(transaction.verifySignatures(), true);
      result = signedSolanaTransactionSignature(rpc.params[0]);
    } else throw new Error(`unexpected RPC ${rpc.method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  const transport = chainBroadcastTransports({
    collectorCrypt: { productionBindingAuthority: 'synthetic-offline' }, solana: { rpcUrl },
  });
  const backend = createKeychainSignerClient({
    role: 'operator-solana', liveMode: true, preflightAuthority: authority,
    exec: createProcessExec(), command: child.command, account: 'operator-solana', broadcast: transport.solana,
  });
  const args = {
    signerClient: { solana: backend }, client: createSolanaRpcClient({ rpcUrl }),
    ...native,
    transaction: native.transaction, requestDigest: `sha256:${'c'.repeat(64)}`, blockhash, blockhashLastValidHeight: '100',
    money: {}, now: () => 1700000000000, preflightAuthority: authority,
  };
  return { args, backend, broadcasts: () => broadcasts };
}

test('return signs through the real owned child and broadcasts only through its approved RPC port', async t => {
  const { args, backend, broadcasts } = await setup(t);
  assert.equal(backend.broadcast, undefined);
  assert.equal(typeof backend.broadcastApproved, 'function');
  assert.equal(isOwnedKeychainSignOnlyClient(backend), true);
  await assert.rejects(() => backend.broadcastApproved({ signedTxBase64: args.transaction }, {}), /proof|policy/i);
  const signer = await createReturnPolicySigner(args);
  await assert.rejects(() => signer.broadcast({ signedTxBase64: args.transaction }), /unsigned|unapproved/);
  assert.equal(broadcasts(), 0);
  const signed = await signer.sign();
  const result = await signer.broadcast(signed);
  assert.equal(result.signature, signedSolanaTransactionSignature(signed.signedTxBase64));
  assert.equal(broadcasts(), 1);
  await assert.rejects(() => signer.broadcast(signed), /unsigned|unapproved/);
  assert.equal(broadcasts(), 1);
});

test('return preserves an existing plain broadcast backend', async t => {
  const { args, backend, broadcasts } = await setup(t);
  // Legacy plain backends remain accepted; use the same real child signApproved port but a
  // separate ordinary RPC broadcast port, which the outer policy signer must still gate.
  // Reuse the actual approved transport through a plain backend's own policy wrapper.
  const inner = await createReturnPolicySigner(args);
  const plain = { role: backend.role, sign: () => inner.sign(), broadcast: signed => inner.broadcast(signed) };
  const signer = await createReturnPolicySigner({ ...args, signerClient: { solana: plain } });
  const signed = await signer.sign();
  await signer.broadcast(signed);
  assert.equal(broadcasts(), 1);
});


test('the real stage-driver lease fence refuses approved return broadcast after signing', async t => {
  const { args, backend, broadcasts } = await setup(t);
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-return-approved-lease-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '17', mode: 'production' });
  let current = true;
  let signed = false;
  const driver = createStageDriver({
    liveMode: true, adapters: {}, signerClient: { solana: backend }, cycleRepository: repository,
    config: { contracts: { vault: null, hook: null }, accounts: { evm: null, solana: null } },
    preflightAuthority: authority,
    // This narrow test handler exercises the actual driver's capability fencing around the actual
    // return policy helper. It is not a substitute production handler or a full-cycle proof.
    stageHandlers: { return: {
      async probe() { return null; },
      async prepareRequest() { return { purpose: 'return-approved-port-lease-proof' }; },
      async reconcileLive() { return null; },
      async mutate({ signerClient }) {
        assert.equal(signerClient.solana.broadcast, undefined);
        const signer = await createReturnPolicySigner({ ...args, signerClient });
        const bytes = await signer.sign();
        signed = true;
        current = false;
        return signer.broadcast(bytes);
      },
    } },
  });
  await assert.rejects(() => driver.execute({ cycleId, stage: 'return', async assertMutationAllowed() {}, assertLease() {
    if (!current) throw new Error('controlled return lease loss');
  } }), /controlled return lease loss/);
  assert.equal(signed, true);
  assert.equal(broadcasts(), 0);
});
