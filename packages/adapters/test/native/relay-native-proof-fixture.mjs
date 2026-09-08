import { createHash } from 'node:crypto';
// Synthetic public-key fixtures and injected RPC only. No provider admission or launch evidence.
import { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from 'viem';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createSolanaRpcClient, signedSolanaTransactionSignature } from '../../src/solana-rpc.mjs';
import { createRelayNativePaymentProof, createTestNativePaymentBinding, readReleaseBoundRelaySourceDebit, isProcessNativePaymentProof } from '../../src/native-payment-proof.mjs';
export const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const orderId = `0x${'ab'.repeat(32)}`;
export const emitter = `0x${'11'.repeat(20)}`;
export const recipient = `0x${'22'.repeat(20)}`;
const txHash = `0x${'33'.repeat(32)}`;
const blockHash = `0x${'44'.repeat(32)}`;
const runtime = '0x6000';
export async function setup({ corruptSourceBytes = false, corruptSourceSlot = false, runtimeMutation = () => {},
  runtimeObservation = null, sourceSlot = 10, sourceTimestamp = 100, seed = 7 } = {}) {
  const owner = Keypair.fromSeed(typeof seed === 'number' ? Uint8Array.from({ length: 32 }, () => seed) : seed); // Public synthetic fixture seed.
  const programId = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
  const programDataAddress = '6y7C7Lfh1WRRbKohE2FQmFBD2asw3yMi17kStwEcAWWF';
  const loaderOwner = 'BPFLoaderUpgradeab1e11111111111111111111111';
  const executable = Buffer.from('7f454c46010203000000', 'hex');
  const programBytes = Buffer.alloc(36); programBytes.writeUInt32LE(2); new PublicKey(programDataAddress).toBuffer().copy(programBytes, 4);
  const programDataBytes = Buffer.alloc(45 + executable.length); programDataBytes.writeUInt32LE(3);
  programDataBytes.writeBigUInt64LE(9n, 4); programDataBytes[12] = 1; executable.copy(programDataBytes, 45);
  const observation = runtimeObservation ?? { context: { slot: 11 }, value: [
    { owner: loaderOwner, executable: true, data: [programBytes.toString('base64'), 'base64'] },
    { owner: loaderOwner, executable: false, data: [programDataBytes.toString('base64'), 'base64'] },
  ] };
  const runtimeBytes = Buffer.from(observation.value[1].data[0], 'base64').subarray(45);
  let end = runtimeBytes.length; while (runtimeBytes[end - 1] === 0) end -= 1;
  const sourceRuntime = { schema: 'hookemon.solana-upgradeable-runtime.v1', programId, programDataAddress, loaderOwner,
    normalizedRuntimeSha256: createHash('sha256').update(runtimeBytes.subarray(0, end)).digest('hex') };
  runtimeMutation(observation);
  const runtimeRequests = [];
  const route = { schema: 'hookemon.relay-native-route.v1', emitter, runtimeHash: keccak256(runtime), metadataEncoding: 'order-id', sourceRuntime,
    sourceInstruction: { programId, discriminatorHex: '0102', dataLengthBytes: 42, amountOffsetBytes: 2, orderIdOffsetBytes: 10 } };
  const binding = createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663', relay: route }, createTestProfileMutationAuthority());
  const data = Buffer.alloc(42); data.writeUInt16BE(0x0102, 0); data.writeBigUInt64LE(25_000_000n, 2); Buffer.from(orderId.slice(2), 'hex').copy(data, 10);
  const transaction = new Transaction({ feePayer: owner.publicKey, recentBlockhash: SystemProgram.programId.toBase58() }).add(new TransactionInstruction({
    programId: new PublicKey(programId), keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data }));
  transaction.sign(owner);
  const encoded = transaction.serialize().toString('base64');
  const signature = signedSolanaTransactionSignature(encoded);
  const meta = { err: null, preTokenBalances: [{ accountIndex: 0, mint, owner: owner.publicKey.toBase58(), uiTokenAmount: { amount: '25000000' } }],
    postTokenBalances: [{ accountIndex: 0, mint, owner: owner.publicKey.toBase58(), uiTokenAmount: { amount: '0' } }] };
  const sourceClient = createSolanaRpcClient({ fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'getMultipleAccounts') {
      runtimeRequests.push(request);
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: observation }) };
    }
    const raw = request.params[1].encoding === 'base64';
    const result = { slot: raw && corruptSourceSlot ? sourceSlot + 1 : sourceSlot, blockTime: sourceTimestamp, meta, transaction: raw
      ? [corruptSourceBytes ? Buffer.from('different bytes').toString('base64') : encoded, 'base64'] : { message: { accountKeys: [owner.publicKey.toBase58()] } } };
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) };
  } });
  const sourceProof = await readReleaseBoundRelaySourceDebit({ client: sourceClient, binding, signature, owner: owner.publicKey.toBase58(), mint,
    amountAtomic: '25000000', signedTransactionBase64: encoded });
  const abi = parseAbi(['event FundsMovement(address from, address to, address currency, uint256 amount, bytes metadata)']);
  const log = { address: emitter, logIndex: 0, transactionHash: txHash, blockHash, blockNumber: 10n, topics: encodeEventTopics({ abi, eventName: 'FundsMovement' }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [emitter, recipient, `0x${'00'.repeat(20)}`, 42n, orderId]) };
  const receipt = { transactionHash: txHash, blockNumber: 10n, blockHash, status: 'success', logs: [log] };
  const client = { getChainId: async () => 4663, getCode: async () => runtime,
    getTransactionReceipt: async () => receipt, getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 101n }) };
  const expected = { kind: 'relay-return', chainId: '4663', assetId: 'native', decimals: 18, transactionHash: txHash,
    sourceTransactionHash: signature, sourceOwner: owner.publicKey.toBase58(), sourceMint: mint, sourceAmountAtomic: '25000000',
    relayRequestId: 'synthetic-request', orderId, recipient };
  return { client, binding, sourceProof, expected, receipt, route, encoded, sourceClient, runtimeRequests, observation };
}
