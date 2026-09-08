import { isProcessRpcRelaySourceDebit, readFinalizedRelaySourceDebit } from './solana-rpc.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTestProfileMutationAuthority, requireLiveMutationAuthority } from '../../runner/src/cycle/preflight.mjs';
import { decodeEventLog, decodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { digest } from '../../runner/src/cycle/journal.mjs';
import { readFinalizedTransactionReceipt, readBlockByNumber } from './robinhood-rpc.mjs';

export const NATIVE_PAYMENT_PROOF_SCHEMA = 'hookemon.native-payment-proof.v1';
const capabilities = new WeakMap();
const gasCapabilities = new WeakMap();
const releaseBindings = new WeakSet();
const testBindings = new WeakSet();
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
      need(log.removed !== true && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0
        && log.transactionHash === transactionHash && log.blockHash === observed.receiptBlockHash
        && log.blockNumber === observed.receiptBlockNumber, 'invalid claim event inclusion');
      matches.push(log.logIndex);
    }
    need(matches.length === 1, 'claim requires one unique post-payment event');
    [logIndex] = matches;
  }
  const block = await readBlockByNumber(client, observed.receiptBlockNumber);
  need(block.hash === observed.receiptBlockHash, 'payment checkpoint reorged');
  const receipt = observed.receipt;
  need(typeof signed.gas === 'bigint' && receipt.gasUsed <= signed.gas
    && receipt.effectiveGasPrice <= (signed.maxFeePerGas ?? signed.gasPrice), 'gas costs exceed signed bounds');
  need(typeof receipt.gasUsed === 'bigint' && receipt.gasUsed >= 0n
    && typeof receipt.effectiveGasPrice === 'bigint' && receipt.effectiveGasPrice >= 0n, 'missing separate gas cost');
  const facts = {
    schema: NATIVE_PAYMENT_PROOF_SCHEMA, kind: intent.kind, chainId: '4663', assetId: 'native', decimals: 18,
    transactionHash, transactionDigest: digest(signedTransaction), blockNumber: block.number.toString(), blockHash: block.hash, timestampUnixSeconds: block.timestamp.toString(),
    source, recipient, amountWei, calldataDigest: keccak256(data), nonce: intent.nonce, receiptStatus: 'success',
    gasSpentWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    ...(intent.kind === 'hook-claim' ? { cycleId: intent.cycleId, hookRuntimeHash: intent.hookRuntimeHash.toLowerCase(), logIndex } : {}),
  };
  const proof = Object.freeze({ ...facts, evidenceDigest: digest(facts) });
  capabilities.set(proof, proof);
  return proof;
}

/** Environment selects bytes only; the frozen coordinator interface selects their authority. */
export function requireNativePaymentBinding(path) {
  const authority = requireLiveMutationAuthority();
  const interfaces = JSON.parse(readFileSync(new URL('../../../architecture/interfaces.json', import.meta.url)));
  need(interfaces.requirementsRevision === authority.requirementsRevision && authority.requirementsRevision === 71
    && interfaces.architectureRevision === authority.architectureRevision, 'native release revision mismatch');
  const pinned = interfaces.nativeMigration?.nativePaymentBindingSha256;
  need(typeof pinned === 'string' && /^[a-f0-9]{64}$/.test(pinned), 'native payment binding is not release-pinned');
  const bytes = readFileSync(path);
  need(createHash('sha256').update(bytes).digest('hex') === pinned, 'native payment binding bytes differ from release');
  const binding = JSON.parse(bytes);
  need(binding.schema === 'hookemon.native-payment-binding.v1' && binding.chainId === '4663', 'native payment binding identity mismatch');
  address(binding.hook?.address); hash(binding.hook?.runtimeHash);
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  releaseBindings.add(binding);
  return freeze(binding);
}


/** Explicit synthetic test authority; production composition only loads release-pinned bytes. */
export function createTestNativePaymentBinding(value, authority) {
  need(authority === createTestProfileMutationAuthority(), 'synthetic binding requires the exact test profile capability');
  const binding = structuredClone(value);
  need(binding.schema === 'hookemon.native-payment-binding.v1' && binding.chainId === '4663', 'invalid synthetic binding');
  function freeze(item) { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; }
  releaseBindings.add(binding);
  testBindings.add(binding);
  return freeze(binding);
}

export function isTestNativePaymentBinding(value, authority) {
  return authority === createTestProfileMutationAuthority() && testBindings.has(value);
}

export function relaySourceRuntimeBinding(binding) {
  need(releaseBindings.has(binding), 'Relay source runtime binding is not release authenticated');
  const runtime = binding.relay?.sourceRuntime;
  need(runtime?.schema === 'hookemon.solana-upgradeable-runtime.v1'
    && runtime.programId === binding.relay?.sourceInstruction?.programId,
  'Relay source runtime and instruction program binding mismatch');
  return runtime;
}

/** The source runtime identity originates only in release-branded configuration. */
export async function readReleaseBoundRelaySourceDebit({ client, binding, ...expected }) {
  const runtimeBinding = relaySourceRuntimeBinding(binding);
  return readFinalizedRelaySourceDebit(client, { ...expected, runtimeBinding });
}

/** A successful router cleanup event is authority only under a release-pinned runtime and source decoder. */
export async function createRelayNativePaymentProof({ client, binding, sourceProof, signedSourceTransaction, expected }) {
  need(releaseBindings.has(binding), 'Relay route binding is not authenticated by this release');
  const route = binding.relay;
  need(route?.schema === 'hookemon.relay-native-route.v1' && route.metadataEncoding === 'order-id', 'Relay native route semantics are unverified');
  const intent = structuredClone(expected);
  need(['relay-return', 'relay-refund'].includes(intent.kind) && intent.chainId === '4663' && intent.assetId === 'native' && intent.decimals === 18, 'invalid Relay native intent');
  const orderId = hash(intent.orderId);
  if (intent.kind === 'relay-return') {
  need(isProcessRpcRelaySourceDebit(sourceProof, { transactionHash: intent.sourceTransactionHash, owner: intent.sourceOwner,
    mint: intent.sourceMint, debitedAmountAtomic: intent.sourceAmountAtomic, runtimeBinding: relaySourceRuntimeBinding(binding) }), 'Relay source lacks finalized persisted-byte provenance');
  const grammar = route.sourceInstruction;
  need(grammar && typeof grammar.programId === 'string' && /^[a-f0-9]+$/.test(grammar.discriminatorHex)
    && grammar.discriminatorHex.length % 2 === 0, 'Relay source instruction decoder is unverified');
  need(Number.isSafeInteger(grammar.dataLengthBytes) && grammar.dataLengthBytes > 0
    && Number.isSafeInteger(grammar.amountOffsetBytes) && grammar.amountOffsetBytes >= grammar.discriminatorHex.length / 2
    && Number.isSafeInteger(grammar.orderIdOffsetBytes) && grammar.orderIdOffsetBytes >= grammar.amountOffsetBytes + 8
    && grammar.orderIdOffsetBytes + 32 === grammar.dataLengthBytes, 'Relay source instruction decoder is invalid');
  need(sourceProof.instructions.length === 1, 'Relay source requires one exact admitted instruction');
  const ix = sourceProof.instructions[0];
  need(ix.programId === grammar.programId && ix.data.startsWith(grammar.discriminatorHex)
    && ix.data.length === grammar.dataLengthBytes * 2, 'Relay source program/discriminator mismatch');
  const sourceData = Buffer.from(ix.data, 'hex');
  need(sourceData.readBigUInt64LE(grammar.amountOffsetBytes) === BigInt(intent.sourceAmountAtomic)
    && `0x${sourceData.subarray(grammar.orderIdOffsetBytes).toString('hex')}` === orderId, 'Relay source order or principal mismatch');
  } else {
    need(route.refundsSupported === true, 'Relay native refund semantics are unverified');
    need(isProcessNativePaymentProof(sourceProof, { kind: 'direct', transactionHash: intent.sourceTransactionHash,
      source: address(intent.recipient), recipient: address(intent.depository), amountWei: atomic(intent.sourceAmountAtomic) }),
    'Relay refund source lacks finalized persisted native payment provenance');
    need(typeof signedSourceTransaction === 'string' && keccak256(signedSourceTransaction) === sourceProof.transactionHash,
      'Relay refund source bytes differ from finalized payment');
    const sourceTx = parseTransaction(signedSourceTransaction);
    const deposit = decodeFunctionData({ abi: parseAbi(['function depositNative(address depositor, bytes32 id)']), data: sourceTx.data });
    need(deposit.functionName === 'depositNative' && address(deposit.args[0]) === address(intent.recipient)
      && hash(deposit.args[1]) === orderId && sourceTx.value === BigInt(intent.sourceAmountAtomic), 'Relay refund source order mismatch');
  }
  const emitter = address(route.emitter);
  const runtimeHash = hash(route.runtimeHash);
  const recipient = address(intent.recipient);
  const transactionHash = hash(intent.transactionHash);
  need(await client.getChainId() === 4663, 'Relay destination RPC chain mismatch');
  const observed = await readFinalizedTransactionReceipt(client, transactionHash);
  need(observed.finalized && observed.receipt.status === 'success', 'Relay native destination is unsuccessful or nonfinal');
  const code = await client.getCode({ address: emitter, blockNumber: observed.receiptBlockNumber });
  need(code && code !== '0x' && keccak256(code) === runtimeHash, 'Relay native runtime differs at payment checkpoint');
  const abi = parseAbi(['event FundsMovement(address from, address to, address currency, uint256 amount, bytes metadata)']);
  const matches = [];
  for (const log of observed.receipt.logs) {
    if (address(log.address) !== emitter) continue;
    let event;
    try { event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
    if (event.args.metadata.toLowerCase() !== orderId) continue;
    need(event.args.from.toLowerCase() === emitter && event.args.to.toLowerCase() === recipient
      && event.args.currency === '0x0000000000000000000000000000000000000000'
      && event.args.amount > 0n && log.removed !== true && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0
      && log.transactionHash === transactionHash && log.blockHash === observed.receiptBlockHash
      && log.blockNumber === observed.receiptBlockNumber,
    'Relay native payment event conflicts with the attributed order');
    matches.push({ amountWei: event.args.amount.toString(), logIndex: log.logIndex });
  }
  need(matches.length === 1, 'Relay native payment requires exactly one attributable successful cleanup');
  const block = await readBlockByNumber(client, observed.receiptBlockNumber);
  need(block.hash === observed.receiptBlockHash, 'Relay native payment checkpoint reorged');
  const facts = { schema: NATIVE_PAYMENT_PROOF_SCHEMA, kind: intent.kind, chainId: '4663', assetId: 'native', decimals: 18,
    transactionHash, sourceTransactionHash: sourceProof.transactionHash, sourceTransactionDigest: sourceProof.signedTransactionDigest ?? sourceProof.transactionDigest,
    relayRequestId: intent.relayRequestId, orderId, source: emitter, recipient, runtimeHash, ...matches[0],
    blockNumber: block.number.toString(), blockHash: block.hash, timestampUnixSeconds: block.timestamp.toString(), receiptStatus: 'success' };
  const proof = Object.freeze({ ...facts, evidenceDigest: digest(facts) });
  capabilities.set(proof, proof);
  return proof;
}


/** Idempotent per-transaction gas projection; spread these fields into the same custody write. */
export function applyNativeCustodyGasPayment(ledger, proof) {
  need((isProcessNativePaymentProof(proof, { chainId: '4663', assetId: 'native', decimals: 18 }) || gasCapabilities.has(proof))
    && typeof proof.gasSpentWei === 'string', 'gas cost requires a process native payment proof');
  need(ledger?.schema === 'hookemon.custody-ledger.v3' && ledger.chainId === '4663' && ledger.assetId === 'native'
    && ledger.decimals === 18 && Array.isArray(ledger.gasPayments), 'gas accounting requires native custody v3');
  const gasPayments = ledger.gasPayments.map(item => ({ ...item }));
  const existing = gasPayments.find(item => item.transactionHash === proof.transactionHash);
  if (existing) need(existing.amountWei === proof.gasSpentWei, 'gas transaction cost changed');
  else gasPayments.push({ transactionHash: proof.transactionHash, amountWei: proof.gasSpentWei });
  const previousTotal = ledger.gasPayments.reduce((sum, item) => sum + BigInt(atomic(item.amountWei)), 0n);
  need(previousTotal.toString() === ledger.gasSpent.amountAtomic, 'gas ledger sum is inconsistent');
  return { gasPayments, gasSpent: { chainId: '4663', assetId: 'native', decimals: 18,
    amountAtomic: (previousTotal + (existing ? 0n : BigInt(proof.gasSpentWei))).toString() } };
}


/** Finalized transaction gas is distinct from payment authority, including reverted transactions. */
export async function createNativeTransactionGasProof({ client, signedTransaction, expected }) {
  const intent = structuredClone(expected);
  need(intent.chainId === '4663' && intent.assetId === 'native' && intent.decimals === 18, 'invalid gas identity');
  const transactionHash = hash(intent.transactionHash);
  need(typeof signedTransaction === 'string' && keccak256(signedTransaction) === transactionHash, 'gas signed hash mismatch');
  const signed = parseTransaction(signedTransaction);
  const sender = address(await recoverTransactionAddress({ serializedTransaction: signedTransaction }));
  need(signed.chainId === 4663 && sender === address(intent.transactionSender ?? intent.source)
    && address(signed.to) === address(intent.recipient) && (signed.value ?? 0n) === BigInt(atomic(intent.amountWei))
    && keccak256(signed.data ?? '0x') === hash(intent.calldataDigest) && String(signed.nonce) === intent.nonce,
  'gas signed intent mismatch');
  need(await client.getChainId() === 4663, 'gas RPC chain mismatch');
  const observed = await readFinalizedTransactionReceipt(client, transactionHash);
  need(observed.finalized && ['success', 'reverted'].includes(observed.receipt.status), 'gas receipt is nonfinal or unknown');
  const tx = await client.getTransaction({ hash: transactionHash });
  need(hash(tx.hash) === transactionHash && address(tx.from) === sender && address(tx.to) === address(signed.to)
    && tx.value === (signed.value ?? 0n) && (tx.input ?? tx.data ?? '0x') === (signed.data ?? '0x')
    && String(tx.nonce) === intent.nonce && tx.blockNumber === observed.receiptBlockNumber
    && hash(tx.blockHash) === observed.receiptBlockHash, 'gas RPC transaction mismatch');
  const block = await readBlockByNumber(client, observed.receiptBlockNumber);
  const receipt = observed.receipt;
  need(block.hash === observed.receiptBlockHash && typeof receipt.gasUsed === 'bigint' && receipt.gasUsed >= 0n
    && typeof receipt.effectiveGasPrice === 'bigint' && receipt.effectiveGasPrice >= 0n, 'gas receipt checkpoint or costs are invalid');
  need(typeof signed.gas === 'bigint' && receipt.gasUsed <= signed.gas
    && receipt.effectiveGasPrice <= (signed.maxFeePerGas ?? signed.gasPrice), 'gas costs exceed signed bounds');
  const facts = { schema: 'hookemon.native-transaction-gas-proof.v1', chainId: '4663', assetId: 'native', decimals: 18,
    transactionHash, transactionDigest: digest(signedTransaction), sender, receiptStatus: receipt.status,
    blockNumber: block.number.toString(), blockHash: block.hash, timestampUnixSeconds: block.timestamp.toString(),
    gasSpentWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
  const proof = Object.freeze({ ...facts, evidenceDigest: digest(facts) });
  gasCapabilities.set(proof, proof);
  return proof;
}
