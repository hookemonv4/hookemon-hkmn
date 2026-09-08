import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import {
  COLLECTOR_BUYBACK_BINDING_SCHEMA,
  CollectorBuybackPolicyError,
  assertCollectorBuybackBindingV1,
  createCollectorBuybackPolicy,
} from '../../src/signing/collector-buyback-policy.mjs';
import { TransactionPolicyError, decodeProviderTransaction, evaluate } from '../../src/signing/transaction-policy.mjs';

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const COLLECTOR_PROGRAM_ID = Keypair.generate().publicKey.toBase58();
const DISCRIMINATOR_HEX = 'a1b2c3d4e5f60718';

const operator = Keypair.generate();
const authority = Keypair.generate();
const proceedsSource = Keypair.generate().publicKey;
const proceedsMint = Keypair.generate().publicKey;
const proceedsDestination = Keypair.generate().publicKey;
const collectorRecipient = Keypair.generate().publicKey;
const openedAssetMint = Keypair.generate().publicKey;
const recentBlockhash = Keypair.generate().publicKey.toBase58();

const RAW_BINDING = Object.freeze({
  schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
  version: 1,
  provider: 'collector-crypt',
  chainId: 'solana-mainnet',
  format: 'legacy',
  addressLookupTables: [],
  proceeds: {
    source: proceedsSource.toBase58(),
    mint: proceedsMint.toBase58(),
    decimals: 6,
  },
  collectorAuthority: authority.publicKey.toBase58(),
  collectorRecipient: collectorRecipient.toBase58(),
  instructions: [
    {
      kind: 'compute-budget-set-unit-limit',
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      accounts: [],
      computeUnitLimit: 40000,
      priorityFeeCapAtomic: null,
      discriminatorHex: null,
    },
    {
      kind: 'compute-budget-set-unit-price',
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      accounts: [],
      computeUnitLimit: null,
      priorityFeeCapAtomic: '5000',
      discriminatorHex: null,
    },
    {
      kind: 'unknown',
      programId: COLLECTOR_PROGRAM_ID,
      accounts: [
        { role: 'operator-fee-payer', isSigner: true, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
        { role: 'opened-asset-mint', isSigner: false, isWritable: true },
        { role: 'collector-recipient', isSigner: false, isWritable: true },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: DISCRIMINATOR_HEX,
    },
    {
      kind: 'spl-transfer-checked',
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { role: 'proceeds-source', isSigner: false, isWritable: true },
        { role: 'proceeds-mint', isSigner: false, isWritable: false },
        { role: 'proceeds-destination', isSigner: false, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: null,
    },
  ],
});
const EXPECTED_DIGEST = digest(RAW_BINDING);

const CYCLE_FACTS = Object.freeze({
  operatorFeePayer: operator.publicKey.toBase58(),
  proceedsDestination: proceedsDestination.toBase58(),
  openedAssetMint: openedAssetMint.toBase58(),
  currentOwner: operator.publicKey.toBase58(),
  quoteAtomic: '1000000',
  minimumAtomic: '900000',
  refundAtomic: '1000000',
  requestDigest: digest({ schema: 'test.collector-buyback-request.v1', cycleId: 'cycle-0001' }),
});

const BLOCKHASH_CONTEXT = Object.freeze({
  blockhash: recentBlockhash,
  lastValidBlockHeight: '1000',
  currentBlockHeight: '500',
});

function factoryInput(overrides = {}) {
  return {
    binding: RAW_BINDING,
    expectedDigest: EXPECTED_DIGEST,
    cycleFacts: CYCLE_FACTS,
    blockhashContext: BLOCKHASH_CONTEXT,
    ...overrides,
  };
}

function mutatedBinding(mutator) {
  const mutated = mutator(structuredClone(RAW_BINDING));
  return { binding: mutated, expectedDigest: digest(mutated) };
}

function transferCheckedData(amountAtomic, decimals) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amountAtomic), 1);
  data.writeUInt8(decimals, 9);
  return data;
}

function settleData(discriminatorHex, minimumAtomic, refundAtomic) {
  const data = Buffer.alloc(24);
  Buffer.from(discriminatorHex, 'hex').copy(data, 0);
  data.writeBigUInt64LE(BigInt(minimumAtomic), 8);
  data.writeBigUInt64LE(BigInt(refundAtomic), 16);
  return data;
}

function buildCandidateTransaction(overrides = {}) {
  const {
    feePayer = operator,
    authorityKey = authority,
    proceedsSourceKey = proceedsSource,
    proceedsMintKey = proceedsMint,
    proceedsDestinationKey = proceedsDestination,
    collectorRecipientKey = collectorRecipient,
    openedAssetMintKey = openedAssetMint,
    proceedsWritable = true,
    amountAtomic = CYCLE_FACTS.quoteAtomic,
    decimals = RAW_BINDING.proceeds.decimals,
    computeUnitLimit = RAW_BINDING.instructions[0].computeUnitLimit,
    priorityFeeMicroLamports = 4000,
    minimumAtomic = CYCLE_FACTS.minimumAtomic,
    refundAtomic = CYCLE_FACTS.refundAtomic,
    discriminatorHex = DISCRIMINATOR_HEX,
    blockhash = BLOCKHASH_CONTEXT.blockhash,
    instructionOrder = ['limit', 'price', 'settle', 'transfer'],
    extraInstruction = false,
  } = overrides;

  const instructionsByKind = {
    limit: ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    price: ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    settle: new TransactionInstruction({
      programId: new PublicKey(COLLECTOR_PROGRAM_ID),
      keys: [
        { pubkey: feePayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: authorityKey.publicKey, isSigner: true, isWritable: false },
        { pubkey: openedAssetMintKey, isSigner: false, isWritable: true },
        { pubkey: collectorRecipientKey, isSigner: false, isWritable: true },
      ],
      data: settleData(discriminatorHex, minimumAtomic, refundAtomic),
    }),
    transfer: new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: proceedsSourceKey, isSigner: false, isWritable: proceedsWritable },
        { pubkey: proceedsMintKey, isSigner: false, isWritable: false },
        { pubkey: proceedsDestinationKey, isSigner: false, isWritable: true },
        { pubkey: authorityKey.publicKey, isSigner: true, isWritable: false },
      ],
      data: transferCheckedData(amountAtomic, decimals),
    }),
  };

  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash });
  for (const kind of instructionOrder) transaction.add(instructionsByKind[kind]);
  if (extraInstruction) {
    transaction.add(new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID.slice(0, -1) === TOKEN_PROGRAM_ID ? TOKEN_PROGRAM_ID : COMPUTE_BUDGET_PROGRAM_ID),
      keys: [],
      data: Buffer.from([9, 9, 9, 9, 9]),
    }));
  }
  transaction.partialSign(feePayer, authorityKey);
  return Buffer.from(transaction.serialize()).toString('base64');
}

async function decodeCandidate(transactionBase64, decodeOverrides = {}) {
  return decodeProviderTransaction({
    family: 'solana',
    chainId: 'solana-mainnet',
    transaction: transactionBase64,
    lastValidBlockHeight: BLOCKHASH_CONTEXT.lastValidBlockHeight,
    currentBlockHeight: BLOCKHASH_CONTEXT.currentBlockHeight,
    ...decodeOverrides,
  });
}

test('accepts a legacy Collector buyback transaction built exactly from the binding and facts', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction());
  const result = evaluate(policy, decoded);
  assert.equal(result.allowed, true);
  assert.equal(result.ruleId, 'collector-buyback-v1');
});

test('refuses a factory input that adds a candidate-shaped field beside the trusted inputs', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({ candidateTransaction: 'anything' })),
    CollectorBuybackPolicyError,
  );
});

test('refuses construction with no blockhash context at all', () => {
  const input = factoryInput();
  delete input.blockhashContext;
  assert.throws(() => createCollectorBuybackPolicy(input), CollectorBuybackPolicyError);
});

test('refuses construction with an incomplete durable cycle fact set', () => {
  const { minimumAtomic, ...incompleteFacts } = CYCLE_FACTS;
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({ cycleFacts: incompleteFacts })),
    CollectorBuybackPolicyError,
  );
});

test('refuses cycle facts whose currentOwner is not the operator fee payer', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      cycleFacts: { ...CYCLE_FACTS, currentOwner: Keypair.generate().publicKey.toBase58() },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses cycle facts whose minimum exceeds the persisted quote', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      cycleFacts: { ...CYCLE_FACTS, minimumAtomic: '1500000' },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses cycle facts whose refund does not equal the persisted quote', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      cycleFacts: { ...CYCLE_FACTS, refundAtomic: '999999' },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses a blockhash context whose current height already passed the last valid height', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      blockhashContext: { ...BLOCKHASH_CONTEXT, currentBlockHeight: '1500' },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses a binding digest that does not match the externally supplied expected digest', () => {
  const wrongDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => assertCollectorBuybackBindingV1(RAW_BINDING, wrongDigest), CollectorBuybackPolicyError);
});

test('refuses a binding with an extra unexpected field', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, extra: 'nope' }));
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding missing a required field', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    const { collectorRecipient: _drop, ...rest } = value;
    return rest;
  });
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring the same collector authority and recipient', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, collectorRecipient: value.collectorAuthority }));
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring an unknown account role', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    value.instructions[2].accounts[0].role = 'nonexistent-role';
    return value;
  });
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring an invalid discriminator', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    value.instructions[2].discriminatorHex = 'zz';
    return value;
  });
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring a non-empty address lookup table list', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, addressLookupTables: ['placeholder'] }));
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a candidate transaction paying a different proceeds destination', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ proceedsDestinationKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction naming a different collector recipient', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ collectorRecipientKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction settling a different opened asset', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ openedAssetMintKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction signed by a different collector authority co-signer', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ authorityKey: Keypair.generate() }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction moving proceeds to a different mint', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ proceedsMintKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction crediting a different proceeds amount than the persisted quote', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ amountAtomic: '2000000' }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction encoding a different minimum than the persisted fact', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ minimumAtomic: '1' }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction with a swapped instruction order', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ instructionOrder: ['price', 'limit', 'settle', 'transfer'] }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction using a different blockhash than the trusted context', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ blockhash: Keypair.generate().publicKey.toBase58() }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction observed after its trusted deadline has expired', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction(), { currentBlockHeight: '1500' });
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction carrying an extra instruction', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ extraInstruction: true }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

// Public historical reference; mock validity below is test-only, never current RPC evidence.
const coreReference = JSON.parse((await import('node:fs')).readFileSync(new URL('../fixtures/collector-core-buyback-public.json', import.meta.url), 'utf8'));
const coreProgram='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const ataProgram='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const coreMemo='cc-a4ef0bdc-e309-4ba8-aa9e-867f949f0659';
const entry=(role,isSigner=false,isWritable=false)=>({role,isSigner,isWritable});
const template=(kind,programId,accounts=[],extra={})=>({kind,programId,accounts,computeUnitLimit:null,priorityFeeCapAtomic:null,discriminatorHex:null,...extra});
const coreBinding={schema:COLLECTOR_BUYBACK_BINDING_SCHEMA,version:1,provider:'collector-crypt',chainId:'solana-mainnet',format:'legacy',addressLookupTables:[],profile:'core-transfer-v1',
 proceeds:{source:'D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk',mint:usdc,decimals:6},
 collectorAuthority:'GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3',collectorRecipient:'riftWhN8A3gmqsZSNh728z7bZPqNPP5eKep77nCY4Zj',collection:'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac',
 instructions:[
  template('compute-budget-set-unit-limit',COMPUTE_BUDGET_PROGRAM_ID,[],{computeUnitLimit:250000}),
  template('unknown',coreProgram,[entry('opened-asset-mint',false,true),entry('collection'),entry('collector-authority',true,true),entry('operator-owner',true),entry('collector-recipient'),entry('core-program'),entry('core-program')],{discriminatorHex:'0e00'}),
  template('compute-budget-set-unit-price',COMPUTE_BUDGET_PROGRAM_ID,[],{priorityFeeCapAtomic:'10000'}),
  template('unknown',ataProgram,[entry('collector-authority',true,true),entry('proceeds-destination',false,true),entry('operator-owner',true),entry('proceeds-mint'),entry('system-program'),entry('token-program')],{discriminatorHex:'01'}),
  template('spl-transfer-checked',TOKEN_PROGRAM_ID,[entry('proceeds-source',false,true),entry('proceeds-mint'),entry('proceeds-destination',false,true),entry('collector-authority',true,true)]),
  template('unknown','MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
 ]};
function coreFacts(){return {operatorFeePayer:'FVWiwDoc3Dthm9X7SVshTkRYr78V4doAz79VRJfdeWMq',currentOwner:'FVWiwDoc3Dthm9X7SVshTkRYr78V4doAz79VRJfdeWMq',openedAssetMint:'7Jhmf2Rs12aQdcHiVb5DBaWgAx9QF3ypYLtDcEjPZQCQ',proceedsDestination:'GED2f7TkujBkQRzpQdqSjPserYqWby1xuJiU2wxpie5a',quoteAtomic:'51150000',minimumAtomic:'51150000',refundAtomic:'51150000',memoValue:coreMemo,requestDigest:digest({testOnly:'public-reference'})};}
const coreContext={type:'rpc-blockhash-validity',blockhash:'3qaFXCLkZkyMkbXSgQWKJYrDsdcESXosw5QzZGHKq2mw',valid:true,observedSlot:String(coreReference.slot)};
function corePolicy(binding=coreBinding,facts=coreFacts(),blockhashContext=coreContext){return createCollectorBuybackPolicy({binding,expectedDigest:digest(binding),cycleFacts:facts,blockhashContext});}
const coreDecodeOptions={family:'solana',chainId:'solana-mainnet',blockhashContextResolver:async blockhash=>({type:'rpc-blockhash-validity',blockhash,valid:true,observedSlot:coreContext.observedSlot}),currentBlockHeightResolver:async()=>1n};
async function decodeCore(transaction){return decodeProviderTransaction({...coreDecodeOptions,transaction});}

test('Core policy accepts the signature-authenticated historical six-instruction structure',async()=>{
 const tx=Transaction.from(Buffer.from(coreReference.serializedTransaction,'base64'));
 assert.equal(tx.verifySignatures(),true);
 const decoded=await decodeCore(coreReference.serializedTransaction);
 assert.equal(decoded.feePayer,coreBinding.collectorAuthority);
 assert.deepEqual(decoded.requiredSigners,[coreBinding.collectorAuthority,coreFacts().currentOwner]);
 assert.doesNotThrow(()=>evaluate(corePolicy(),decoded));
});
test('Core policy refuses changed accounts, flags, bytes, order, amounts and extra instructions',async()=>{
 const mutations=[
  tx=>{tx.feePayer=operator.publicKey;},
  ...[0,1,2,3,4,5,6].map(i=>tx=>{tx.instructions[1].keys[i].pubkey=Keypair.generate().publicKey;}),
  tx=>{tx.instructions[1].keys[3].isWritable=true;},
  tx=>{tx.instructions[1].data=Buffer.from('0e01','hex');},
  tx=>{tx.instructions[3].data=Buffer.from([0]);},
  tx=>{tx.instructions[4].data.writeBigUInt64LE(51149999n,1);},
  tx=>{tx.instructions[4].keys[2].pubkey=operator.publicKey;},
  tx=>{tx.instructions[4].keys[0].pubkey=operator.publicKey;},
  tx=>{tx.instructions[5].data=Buffer.from(coreMemo+':open');},
  tx=>{[tx.instructions[0],tx.instructions[2]]=[tx.instructions[2],tx.instructions[0]];},
  tx=>{tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:250000}));},
 ];
 for(const mutate of mutations){
  const tx=Transaction.from(Buffer.from(coreReference.serializedTransaction,'base64'));mutate(tx);tx.signatures=[];
  const bytes=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  await assert.rejects(async()=>evaluate(corePolicy(),await decodeCore(bytes)));
 }
});
test('Core authority refuses malformed binding, noncanonical ATA, changed owner and false validity',()=>{
 for(const mutate of [b=>{b.profile='other';},b=>{b.collection=undefined;},b=>{b.instructions[1].discriminatorHex='0e01';},b=>{b.instructions[1].accounts[3].isWritable=true;},b=>{b.proceeds.mint=operator.publicKey.toBase58();}]){
  const binding=structuredClone(coreBinding);mutate(binding);assert.throws(()=>corePolicy(binding));
 }
 for(const mutate of [f=>{f.proceedsDestination=operator.publicKey.toBase58();},f=>{f.currentOwner=operator.publicKey.toBase58();},f=>{f.minimumAtomic='51150001';},f=>{f.memoValue=coreMemo+':buyback';}]){
  const facts=coreFacts();mutate(facts);assert.throws(()=>corePolicy(coreBinding,facts));
 }
 assert.throws(()=>corePolicy(coreBinding,coreFacts(),{...coreContext,valid:false}));
});

const {wrapTransactionPolicySignerClient,OPERATOR_SOLANA_ROLE}=await import('../../src/signing/signer-client.mjs');
const {captureSolanaCoSignerSignatures,expectedBroadcastIdentifier}=await import('../../src/signing/transaction-policy.mjs');
function syntheticCoreSigning(){
 const binding=structuredClone(coreBinding),facts=coreFacts();
 const oldProvider=binding.collectorAuthority,oldOwner=facts.currentOwner,oldAta=facts.proceedsDestination;
 binding.collectorAuthority=authority.publicKey.toBase58();facts.operatorFeePayer=operator.publicKey.toBase58();facts.currentOwner=facts.operatorFeePayer;
 facts.proceedsDestination=PublicKey.findProgramAddressSync([operator.publicKey.toBuffer(),new PublicKey(TOKEN_PROGRAM_ID).toBuffer(),new PublicKey(usdc).toBuffer()],new PublicKey(ataProgram))[0].toBase58();
 const replacements=new Map([[oldProvider,binding.collectorAuthority],[oldOwner,facts.currentOwner],[oldAta,facts.proceedsDestination]]);
 const tx=Transaction.from(Buffer.from(coreReference.serializedTransaction,'base64'));tx.signatures=[];tx.feePayer=authority.publicKey;
 for(const ix of tx.instructions)for(const key of ix.keys)if(replacements.has(key.pubkey.toBase58()))key.pubkey=new PublicKey(replacements.get(key.pubkey.toBase58()));
 tx.partialSign(authority);
 return {binding,facts,tx,policy:corePolicy(binding,facts),bytes:tx.serialize({requireAllSignatures:false}).toString('base64')};
}
test('Core provider-first signature is verified before Operations and preserved through recovery',async()=>{
 const f=syntheticCoreSigning();let signs=0,broadcasts=0,context={...coreContext};
 assert.equal(captureSolanaCoSignerSignatures(f.bytes,1).length,1);
 assert.throws(()=>captureSolanaCoSignerSignatures(f.bytes),/signature slot 1 is missing/);
 const options={policy:f.policy,solanaOperatorAddress:operator.publicKey.toBase58(),decodeOptions:{...coreDecodeOptions,blockhashContextResolver:async()=>context},
  client:{role:OPERATOR_SOLANA_ROLE,async sign(bytes){signs++;const tx=Transaction.from(Buffer.from(bytes,'base64'));tx.partialSign(operator);return {signedTxBase64:tx.serialize().toString('base64')};}},
  broadcast:async signed=>{broadcasts++;return {signature:expectedBroadcastIdentifier(signed,'solana')};}};
 const wrapper=wrapTransactionPolicySignerClient(options),signed=await wrapper.sign(f.bytes),approval=wrapper.readApprovalContext(signed);
 const resumed=wrapTransactionPolicySignerClient(options);await resumed.recoverApproval(signed,approval);
 assert.equal(signs,1);await resumed.broadcast(signed);assert.equal(broadcasts,1);assert.equal(signs,1);
 const stale=wrapTransactionPolicySignerClient(options);context={...coreContext,valid:false};await assert.rejects(()=>stale.recoverApproval(signed,approval));
 context={...coreContext,observedSlot:String(BigInt(coreContext.observedSlot)-1n)};
 const weakened=wrapTransactionPolicySignerClient({...options,policy:corePolicy(f.binding,f.facts,context)});
 await assert.rejects(()=>weakened.recoverApproval(signed,approval),/recovery context does not match/);
});
test('Core missing or corrupt provider signature refuses before the Operations signer',async()=>{
 for(const corrupt of [false,true]){
  const f=syntheticCoreSigning();let signs=0;
  if(corrupt)f.tx.signatures[0].signature[0]^=1;else f.tx.signatures[0].signature=null;
  const wrapper=wrapTransactionPolicySignerClient({policy:f.policy,solanaOperatorAddress:operator.publicKey.toBase58(),decodeOptions:coreDecodeOptions,
   client:{role:OPERATOR_SOLANA_ROLE,async sign(){signs++;throw new Error('must not sign');}},broadcast:async()=>{throw new Error('must not broadcast');}});
  const bytes=f.tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  await assert.rejects(()=>wrapper.sign(bytes),/signature slot 0/);assert.equal(signs,0);
 }
});
