import { PublicKey, Transaction } from '@solana/web3.js';
import { relaySourceRuntimeBinding } from '../native-payment-proof.mjs';
import { buildRelayLegacyTransaction, deriveAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, CIRCLE_USD_MINT } from '../solana-rpc.mjs';

const PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
const need = (ok, message) => { if (!ok) throw new Error(`return native deposit policy: ${message}`); };
/** Audited deposit_token layout: retained Relay source 458a64c, DepositToken accounts. */
export function assertNativeReturnInstruction({ binding, request, configured, transaction, blockhash }) {
  const runtime = relaySourceRuntimeBinding(binding);
  const grammar = binding.relay.sourceInstruction;
  need(grammar.programId === PROGRAM && grammar.discriminatorHex === '0b9c60da27a3b413'
    && grammar.dataLengthBytes === 48 && grammar.amountOffsetBytes === 8 && grammar.orderIdOffsetBytes === 16, 'unsupported release instruction grammar');
  const amount = request.inputAmount;
  need(amount?.chainId === '792703809' && amount.assetId === CIRCLE_USD_MINT && amount.decimals === 6
    && /^[1-9][0-9]*$/.test(amount.amountAtomic), 'invalid typed source amount');
  const intent = request.intent;
  need(intent?.sender === configured.solana && intent.recipient?.toLowerCase() === configured.evm.toLowerCase()
    && String(intent.originChainId) === '792703809' && String(intent.destinationChainId) === '4663'
    && intent.originAssetId === amount.assetId && intent.originDecimals === 6
    && String(intent.originAmount) === amount.amountAtomic
    && intent.destinationAssetId?.toLowerCase() === '0x0000000000000000000000000000000000000000'
    && intent.destinationDecimals === 18 && /^0x[0-9a-f]{64}$/.test(intent.orderId), 'intent identity mismatch');
  const plan = request.solanaInstructionPlan;
  need(Array.isArray(plan?.instructions) && plan.instructions.length > 0, 'missing frozen plan');
  const deposits = plan.instructions.filter(ix => ix.programId === PROGRAM);
  need(deposits.length === 1, 'requires exactly one deposit');
  const computeKinds = new Set();
  for (const ix of plan.instructions) {
    if (ix.programId === PROGRAM) continue;
    need(ix.programId === 'ComputeBudget111111111111111111111111111111' && ix.keys.length === 0
      && /^(02[0-9a-f]{8}|03[0-9a-f]{16})$/.test(ix.data), 'extra instruction is not an allowed compute limit or price');
    need(!computeKinds.has(ix.data.slice(0,2)), 'duplicate compute budget instruction');
    computeKinds.add(ix.data.slice(0,2));
  }
  const ix = deposits[0], data = Buffer.from(ix.data, 'hex');
  need(data.length === 48 && data.toString('hex') === ix.data && data.subarray(0,8).toString('hex') === grammar.discriminatorHex
    && data.readBigUInt64LE(8).toString() === amount.amountAtomic
    && `0x${data.subarray(16).toString('hex')}` === intent.orderId, 'deposit amount/order/layout mismatch');
  const program = new PublicKey(PROGRAM);
  const depository = PublicKey.findProgramAddressSync([Buffer.from('relay_depository')], program)[0].toBase58();
  const vault = PublicKey.findProgramAddressSync([Buffer.from('vault')], program)[0].toBase58();
  const keys = [depository, configured.solana, configured.solana, vault, amount.assetId,
    deriveAssociatedTokenAddress(configured.solana, amount.assetId).toBase58(),
    deriveAssociatedTokenAddress(vault, amount.assetId).toBase58(), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID];
  need(ix.keys.length === keys.length && ix.keys.every((key,i) => key.pubkey === keys[i]
    && key.isSigner === (i === 1) && key.isWritable === [1,5,6].includes(i)), 'deposit accounts or privileges mismatch');
  const expected = buildRelayLegacyTransaction({feePayer:configured.solana,recentBlockhash:blockhash,instructionPlan:plan});
  need(Transaction.from(Buffer.from(transaction,'base64')).serializeMessage().equals(Transaction.from(Buffer.from(expected,'base64')).serializeMessage()), 'message differs from frozen instruction plan');
  return runtime;
}
