import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertNativeReturnInstruction } from '../../src/signing/native-return-policy.mjs';
import { createTestNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { buildRelayLegacyTransaction } from '../../src/solana-rpc.mjs';
const read = path => JSON.parse(readFileSync(new URL(`../../../../${path}`, import.meta.url)));
const raw = read('docs/evidence/native-relay-source-instruction-20260908/relay-return-scenario-response.json');
const grammar = read('docs/evidence/native-relay-source-instruction-20260908/derived.json').sourceInstruction;
const configured = { solana: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE', evm: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384' };
const blockhash = '11111111111111111111111111111111';
function fixture() {
 const plan = structuredClone(raw.steps[0].items[0].data);
 const request = { solanaInstructionPlan: plan, inputAmount: {chainId:'792703809',assetId:plan.instructions[0].keys[4].pubkey,decimals:6,amountAtomic:'25000000'}, intent:{sender:configured.solana,recipient:configured.evm,originChainId:792703809,destinationChainId:4663,originAssetId:plan.instructions[0].keys[4].pubkey,originDecimals:6,originAmount:'25000000',destinationAssetId:'0x0000000000000000000000000000000000000000',destinationDecimals:18,orderId:`0x${plan.instructions[0].data.slice(32)}`}};
 const binding = createTestNativePaymentBinding({schema:'hookemon.native-payment-binding.v1',chainId:'4663',relay:{sourceInstruction:grammar,sourceRuntime:{schema:'hookemon.solana-upgradeable-runtime.v1',programId:grammar.programId}}},createTestProfileMutationAuthority());
 const transaction=buildRelayLegacyTransaction({feePayer:configured.solana,recentBlockhash:blockhash,instructionPlan:plan});
 return {binding,request,configured,transaction,blockhash};
}
test('captured deposit_token with ALT metadata retains exact legacy message and independent amount/order/account proof',()=>{const f=fixture();assert.equal(f.request.solanaInstructionPlan.addressLookupTableAddresses.length,1);assert.equal(assertNativeReturnInstruction(f).programId,grammar.programId);});
for(const [name,mutate] of [
 ['program',f=>f.request.solanaInstructionPlan.instructions[0].programId=blockhash],
 ['layout',f=>f.request.solanaInstructionPlan.instructions[0].data+='00'],
 ['amount',f=>f.request.solanaInstructionPlan.instructions[0].data=f.request.solanaInstructionPlan.instructions[0].data.slice(0,16)+'0000000000000000'+f.request.solanaInstructionPlan.instructions[0].data.slice(32)],
 ['order',f=>f.request.intent.orderId='0x'+'ab'.repeat(32)],
 ['recipient',f=>f.request.intent.recipient='0x'+'ab'.repeat(20)],
 ['vault account',f=>f.request.solanaInstructionPlan.instructions[0].keys[3].pubkey=configured.solana],
 ['privileges',f=>f.request.solanaInstructionPlan.instructions[0].keys[4].isWritable=true],
 ['extra instruction',f=>f.request.solanaInstructionPlan.instructions.push({programId:blockhash,keys:[],data:'00'})],
 ['plain binding',f=>f.binding=structuredClone(f.binding)],
 ['message',f=>f.blockhash='SysvarRent111111111111111111111111111111111']
])test(`native return refuses changed ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>assertNativeReturnInstruction(f));});

import { createSolanaRpcClient, readCurrentRelaySourceRuntime } from '../../src/solana-rpc.mjs';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
test('presign runtime observation refuses stale slots, changed ELF and loader identities', async () => {
 const programDataAddress='6y7C7Lfh1WRRbKohE2FQmFBD2asw3yMi17kStwEcAWWF';
 const elf=Buffer.from('7f454c46010203','hex');
 const binding={schema:'hookemon.solana-upgradeable-runtime.v1',programId:grammar.programId,programDataAddress,loaderOwner:'BPFLoaderUpgradeab1e11111111111111111111111',normalizedRuntimeSha256:createHash('sha256').update(elf).digest('hex')};
 const program=Buffer.alloc(36);program.writeUInt32LE(2);Buffer.from(new PublicKey(programDataAddress).toBytes()).copy(program,4);
 const data=Buffer.alloc(45+elf.length);data.writeUInt32LE(3);data.writeBigUInt64LE(1n,4);elf.copy(data,45);
 const observed={context:{slot:11},value:[{owner:binding.loaderOwner,executable:true,data:[program.toString('base64'),'base64']},{owner:binding.loaderOwner,executable:false,data:[data.toString('base64'),'base64']}]};
 const client = observation => createSolanaRpcClient({fetchImpl:async(_url,init)=>{const request=JSON.parse(init.body);assert(['getSlot','getMultipleAccounts'].includes(request.method));return {ok:true,status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='getSlot'?11:observation})};}});
 assert.equal((await readCurrentRelaySourceRuntime(client(observed),binding)).deploymentSlot,'1');
 for(const modify of [v=>v.context.slot=10,v=>v.value[0].owner=blockhash,v=>{const bytes=Buffer.from(v.value[1].data[0],'base64');bytes[46]^=1;v.value[1].data[0]=bytes.toString('base64');}]){const bad=structuredClone(observed);modify(bad);await assert.rejects(()=>readCurrentRelaySourceRuntime(client(bad),binding));}
});

import { createReturnPolicySigner } from '../../src/app/stages/return.mjs';
test('return signer builds exact byte policy for captured deposit without fabricated TransferChecked semantics', async () => {
 const f=fixture();
 const client=createSolanaRpcClient({fetchImpl:async(_url,init)=>({ok:true,status:200,text:async()=>JSON.stringify({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:9})})});
 const signer=await createReturnPolicySigner({...f,nativePaymentBinding:f.binding,client,signerClient:{solana:{async sign(){throw new Error('not invoked');},async broadcast(){throw new Error('not invoked');}}},requestDigest:`sha256:${'1'.repeat(64)}`,blockhashLastValidHeight:'100',money:{solana:{priorityFeeCap:{chainId:'792703809',assetId:'microlamports-per-compute-unit',decimals:0,amountAtomic:'1000'}}},now:()=>1700000000000,preflightAuthority:createTestProfileMutationAuthority()});
 assert.equal(signer.decoded.amount,null);assert.equal(signer.decoded.mint,null);assert.equal(signer.decoded.instructions[0].kind,'unknown');assert.equal(signer.policyRules.length,1);
});
test('native return refuses duplicate compute-budget instructions',()=>{const f=fixture();const ix={programId:'ComputeBudget111111111111111111111111111111',keys:[],data:'02400d0300'};f.request.solanaInstructionPlan.instructions.unshift(ix,structuredClone(ix));assert.throws(()=>assertNativeReturnInstruction(f),/duplicate compute budget/);});
