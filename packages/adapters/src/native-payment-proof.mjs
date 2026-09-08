import { decodeEventLog, decodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { digest } from '../../runner/src/cycle/journal.mjs';
import { readFinalizedTransactionReceipt, readBlockByNumber } from './robinhood-rpc.mjs';

export const NATIVE_PAYMENT_PROOF_SCHEMA = 'hookemon.native-payment-proof.v1';
const capabilities = new WeakMap();
const CLAIM_ABI = parseAbi([
  'function claimProcess(bytes32 cycleId, uint256 amountWei, address destination)',
  'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountWei, address indexed destination, uint256 timestamp, uint256 capWei, uint256 usedAfterWei)',
]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
function need(ok, message) { if (!ok) throw new Error(`native payment proof refuses: ${message}`); }
function address(value) { need(typeof value === 'string' && ADDRESS.test(value), 'invalid address'); return value.toLowerCase(); }
function hash(value) { need(typeof value === 'string' && HASH.test(value), 'invalid hash'); return value.toLowerCase(); }
function atomic(value) { need(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78, 'invalid wei'); return value; }

/** Runtime capability only. JSON persistence never preserves authority; restart must reread RPC. */
export function isProcessNativePaymentProof(value, expected = {}) {
  const facts = value && capabilities.get(value);
  if (!facts) return false;
  return Object.entries(expected).every(([key, wanted]) => Object.hasOwn(facts, key) && facts[key] === wanted);
}

/**
 * Read finalized native payment facts from the configured RPC and persisted signed bytes.
 * `expected` is the repository's previously approved intent, not facts supplied by a receipt.
 * Hook runtime identity must come from the verified release binding at composition.
 */
export async function createNativePaymentProof({ client, signedTransaction, expected }) {
  const intent = structuredClone(expected);
  need(intent && ['direct', 'hook-claim'].includes(intent.kind), 'native route has no admitted proof producer');
  need(intent.chainId === '4663' && intent.assetId === 'native' && intent.decimals === 18, 'wrong native identity');
  const source = address(intent.source);
  const recipient = address(intent.recipient);
  const amountWei = atomic(intent.amountWei);
  need(BigInt(amountWei) > 0n, 'zero payment');
  const transactionHash = hash(intent.transactionHash);
  need(typeof signedTransaction === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(signedTransaction), 'missing persisted signed bytes');
  need(keccak256(signedTransaction) === transactionHash, 'signed transaction hash mismatch');
  const signed = parseTransaction(signedTransaction);
  need(signed.chainId === 4663, 'signed chain mismatch');
  const signer = address(await recoverTransactionAddress({ serializedTransaction: signedTransaction }));
  need(signer === address(intent.transactionSender ?? source), 'signed sender mismatch');
  const to = address(signed.to);
  const data = signed.data ?? '0x';
  need(hash(intent.calldataDigest) === keccak256(data), 'signed calldata mismatch');
  need(String(signed.nonce) === intent.nonce, 'signed nonce mismatch');
  if (intent.kind === 'direct') {
    need(to === recipient && signer === source && (signed.value ?? 0n) === BigInt(amountWei), 'direct payment intent mismatch');
  } else {
    need(to === source && (signed.value ?? 0n) === 0n, 'claim target/value mismatch');
    const call = decodeFunctionData({ abi: CLAIM_ABI, data });
    need(call.functionName === 'claimProcess' && call.args[0] === hash(intent.cycleId)
      && call.args[1] === BigInt(amountWei) && address(call.args[2]) === recipient && signer === recipient, 'claim intent mismatch');
    hash(intent.hookRuntimeHash);
  }
  need(await client.getChainId() === 4663, 'RPC chain mismatch');
  const observed = await readFinalizedTransactionReceipt(client, transactionHash);
  need(observed.finalized && observed.receipt.status === 'success', 'receipt is unsuccessful or nonfinal');
  const tx = await client.getTransaction({ hash: transactionHash });
  need(hash(tx.hash) === transactionHash && address(tx.from) === signer && address(tx.to) === to
    && tx.value === (signed.value ?? 0n) && (tx.input ?? tx.data ?? '0x') === data
    && String(tx.nonce) === intent.nonce && tx.blockNumber === observed.receiptBlockNumber
    && hash(tx.blockHash) === observed.receiptBlockHash, 'RPC transaction differs from persisted bytes or inclusion');
  let logIndex = null;
  if (intent.kind === 'hook-claim') {
    // No latest-code fallback: an unavailable historical runtime supplies no payment capability.
    const code = await client.getCode({ address: source, blockNumber: observed.receiptBlockNumber });
    need(code && code !== '0x' && keccak256(code) === intent.hookRuntimeHash.toLowerCase(), 'hook runtime mismatch');
    const matches = [];
    for (const log of observed.receipt.logs) {
      if (address(log.address) !== source) continue;
      let decoded;
      try { decoded = decodeEventLog({ abi: CLAIM_ABI, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
      if (decoded.eventName !== 'ProcessClaimed' || decoded.args.cycleId !== intent.cycleId) continue;
      need(decoded.args.amountWei === BigInt(amountWei) && address(decoded.args.destination) === recipient, 'claim event mismatch');
      need(log.removed !== true && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0, 'invalid claim event inclusion');
      matches.push(log.logIndex);
    }
    need(matches.length === 1, 'claim requires one unique post-payment event');
    [logIndex] = matches;
  }
  const block = await readBlockByNumber(client, observed.receiptBlockNumber);
  need(block.hash === observed.receiptBlockHash, 'payment checkpoint reorged');
  const receipt = observed.receipt;
  need(typeof receipt.gasUsed === 'bigint' && receipt.gasUsed >= 0n
    && typeof receipt.effectiveGasPrice === 'bigint' && receipt.effectiveGasPrice >= 0n, 'missing separate gas cost');
  const facts = {
    schema: NATIVE_PAYMENT_PROOF_SCHEMA, kind: intent.kind, chainId: '4663', assetId: 'native', decimals: 18,
    transactionHash, transactionDigest: digest(signedTransaction), blockNumber: block.number.toString(), blockHash: block.hash,
    source, recipient, amountWei, calldataDigest: keccak256(data), nonce: intent.nonce, receiptStatus: 'success',
    gasSpentWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    ...(intent.kind === 'hook-claim' ? { cycleId: intent.cycleId, hookRuntimeHash: intent.hookRuntimeHash.toLowerCase(), logIndex } : {}),
  };
  const proof = Object.freeze({ ...facts, evidenceDigest: digest(facts) });
  capabilities.set(proof, proof);
  return proof;
}
