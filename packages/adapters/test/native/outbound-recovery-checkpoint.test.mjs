import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256} from 'viem';
import {CycleRepository} from '../../src/app/cycle-repository.mjs';
const d=n=>`sha256:${String(n).repeat(64)}`;
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'native-checkpoint-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const repository=await CycleRepository.open(directory);const {cycleId}=await repository.createCycle({releaseAmount:'1',mode:'production'});
 const account=privateKeyToAccount(`0x${'01'.repeat(32)}`); // Public isolated fixture key.
 const to=`0x${'22'.repeat(20)}`,rawBytes=await account.signTransaction({chainId:4663,type:'eip1559',nonce:7,to,value:42n,gas:21000n,maxFeePerGas:2n,maxPriorityFeePerGas:1n});const hash=keccak256(rawBytes);
 const requestDigest=d(1);await repository.prepareChainTransactionAttempt(cycleId,'outbound',{schema:'hookemon.chain-transaction-attempt.v1',cycleId,stage:'outbound',state:'PREPARED',requestDigest,rawBytes:null,nonce:null,blockhash:null,hash:null});
 const relayIntent={schema:'hookemon.relay-intent.v2',direction:'OUTBOUND',tradeType:'EXACT_OUTPUT',quoteDigest:d(2),requestId:'fixture',orderId:`0x${'33'.repeat(32)}`,originChainId:4663,destinationChainId:792703809,originAssetId:'native',originDecimals:18,destinationAssetId:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',destinationDecimals:6,originAmount:'42',quotedDestinationAmount:'40',quotedDestinationMinimumAmount:'40',sender:account.address,recipient:'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE',deadlineUnixSeconds:2000000000};
 const context={stage:'outbound',recipient:null,requestDigest,policyDigest:d(3),approvalDigest:d(4),fencingToken:'11111111-1111-4111-8111-111111111111',fencingTokenDigest:d(5),approvedSemanticsDigest:d(6),rawSignedBytesHash:hash,signedMessageDigest:d(7),relayQuoteDeadlineUnixSeconds:'2000000000',relayIntent,relayRoute:{sourceSender:account.address,sourceRecipient:to,destinationOwner:relayIntent.recipient}};
 return {directory,repository,cycleId,requestDigest,context,material:{rawBytes,nonce:'7',blockhash:null,hash}};
}
test('native signed outbound checkpoint persists exact bytes and native intent through reopen',async t=>{const f=await fixture(t);await f.repository.recordSignedTransactionWithRecoveryContext(f.cycleId,'outbound',f.requestDigest,f.material,f.context);const reopened=await CycleRepository.open(f.directory);const record=await reopened.readChainTransactionAttempt(f.cycleId,'outbound',f.requestDigest);assert.equal(record.attempt.rawBytes,f.material.rawBytes);assert.equal(record.attempt.state,'SIGNED');const context=await reopened.readChainAttemptRecoveryContext(f.cycleId,{stage:'outbound',recipient:null,requestDigest:f.requestDigest,rawSignedBytesHash:f.material.hash});assert.equal(context.relayIntent.originAssetId,'native');assert.equal(context.relayIntent.originDecimals,18);});
for(const [name,mutation] of [['wrong chain',{originChainId:1}],['wrong decimals',{originDecimals:6}],['wrong sender',{sender:'native'}],['old schema',{schema:'hookemon.relay-intent.v1'}]])test(`native outbound checkpoint refuses ${name} before signed-state persistence`,async t=>{const f=await fixture(t);Object.assign(f.context.relayIntent,mutation);await assert.rejects(()=>f.repository.recordSignedTransactionWithRecoveryContext(f.cycleId,'outbound',f.requestDigest,f.material,f.context));assert.equal((await f.repository.readChainTransactionAttempt(f.cycleId,'outbound',f.requestDigest)).attempt.state,'PREPARED');});
