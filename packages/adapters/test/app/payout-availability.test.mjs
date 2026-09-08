import assert from 'node:assert/strict';
import test from 'node:test';
import { createCycleAttributableFinalizedAvailableReader } from '../../src/app/payout-availability.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
const operations=`0x${'a'.repeat(40)}`, hash=`0x${'b'.repeat(64)}`, planDigest=`sha256:${'c'.repeat(64)}`;
const amount=amountAtomic=>({chainId:'4663',assetId:'native',decimals:18,amountAtomic});
function fixture({zero=false,dust='0',balance=1000n}={}) {
 const leg={schema:'hookemon.relay-leg.v2',cycleId:'cycle-native',relayRequestId:'relay-native',direction:'return',state:'SETTLED',destinationChainId:'4663',destinationAssetId:'native',destinationDecimals:18,netDeltaAtomic:'9',finalizedAtDestination:{height:'100',hash},returnAttribution:{intent:{recipient:operations}}};
 const evidence=zero?{schema:'hookemon.return-zero-proceeds-evidence.v2',cycleId:leg.cycleId,finalized:true,noBridge:true,destinationAccount:operations,destinationAsset:'native',destinationCreditAmount:'0'}:{schema:'hookemon.return-relay-settlement-evidence.v2',relayLeg:leg};
 const key='4663\0native';
 const cycle={relayLegs:new Map(zero?[]:[['relay-native',leg]]),returnLegLedgerKeys:new Map([['relay-native',key]]),custodyLedgers:new Map([[key,{schema:'hookemon.custody-ledger.v3',cycleId:leg.cycleId,chainId:'4663',assetId:'native',decimals:18,returnReceived:'9'}]])};
 const source={cycleId:'predecessor',digest:`sha256:${'d'.repeat(64)}`,planDigest:`sha256:${'e'.repeat(64)}`};
 const request={cycleId:leg.cycleId,operations,assetId:'native',returnDelta:amount(zero?'0':'9'),returnEvidence:{operations,assetId:'native',evidenceDigest:digest({schema:'hookemon.direct-payout-finalized-return.v2',cycleId:leg.cycleId,returnEvidence:evidence})},previousDust:amount(dust),previousDustSource:dust==='0'?null:source,planDigest};
 const calls=[];
 const repository={async describeCycle(){return cycle;},async readStage(){return {status:'COMPLETE',evidence};},async readStageAttempt(){return null;},async readPayoutDust(){return {amount:amount(dust),source};}};
 const publicClient={async getBlock({blockTag}){calls.push(blockTag==='finalized'?'finalized':'recheck');return {number:100n,hash,timestamp:1700000000n};}};
 const archiveClient={async readNativeBalanceAtBlock({blockNumber,blockHash}){calls.push('archive');return {value:balance,blockNumber,blockHash};}};
 const read=createCycleAttributableFinalizedAvailableReader({cycleRepository:repository,publicClient,archiveClient});
 return {leg,evidence,cycle,key,request,repository,publicClient,archiveClient,calls,read};
}
test('returns only native return plus provenance-bound dust with ordered finalized checkpoint reads',async()=>{
 const f=fixture({dust:'2'}); assert.deepEqual(await f.read(f.request),amount('11'));assert.deepEqual(f.calls,['finalized','archive','recheck']);
});
test('zero proceeds without dust require no native wallet RPC',async()=>{const f=fixture({zero:true});assert.deepEqual(await f.read(f.request),amount('0'));assert.deepEqual(f.calls,[]);});
for(const [name,mutate,pattern] of [
 ['old USDG identity',f=>{f.request.assetId=operations;},/native/],
 ['wrong decimals',f=>{f.request.returnDelta.decimals=6;},/18/],
 ['forged evidence digest',f=>{f.request.returnEvidence.evidenceDigest=planDigest;},/authenticate/],
 ['mismatched attributed amount',f=>{f.request.returnDelta.amountAtomic='10';},/attributed return delta/],
 ['missing ledger association',f=>f.cycle.returnLegLedgerKeys.clear(),/durable association/],
 ['historical custody',f=>{f.cycle.custodyLedgers.get(f.key).schema='hookemon.custody-ledger.v2';},/matching canonical/],
 ['ledger principal mismatch',f=>{f.cycle.custodyLedgers.get(f.key).returnReceived='8';},/returnReceived/],
 ['ambiguous second return',f=>f.cycle.relayLegs.set('other',{...f.leg,relayRequestId:'other',state:'SENT_UNKNOWN'}),/ambiguous/],
 ['unsettled durable return',f=>f.cycle.relayLegs.set('relay-native',{...f.leg,state:'SENT_UNKNOWN'}),/not settled/],
 ['wrong native recipient',f=>{f.leg.returnAttribution.intent.recipient=`0x${'f'.repeat(40)}`;},/authenticate/],
 ['wallet principal shortfall',f=>{f.archiveClient.readNativeBalanceAtBlock=async({blockNumber,blockHash})=>({value:8n,blockNumber,blockHash});},/below/],
 ['archive wrong checkpoint',f=>{f.archiveClient.readNativeBalanceAtBlock=async()=>({value:1000n,blockNumber:99n,blockHash:hash});},/checkpoint/],
 ['public reorg',f=>{f.publicClient.getBlock=async({blockTag})=>({number:100n,hash:blockTag==='finalized'?hash:`0x${'f'.repeat(64)}`,timestamp:1700000000n});},/checkpoint changed/],
]) test(`refuses ${name}`,async()=>{const f=fixture();mutate(f);await assert.rejects(()=>f.read(f.request),pattern);});
test('dust replay accepts only the exact prior consumption and plan digest',async()=>{
 const f=fixture({dust:'2'});f.repository.readPayoutDust=async()=>null;
 const consumption={sourceCycleId:f.request.previousDustSource.cycleId,sourceDigest:f.request.previousDustSource.digest,sourcePlanDigest:f.request.previousDustSource.planDigest,amount:amount('2'),planDigest};
 f.repository.readPayoutDustConsumption=async()=>consumption;
 assert.deepEqual(await f.read(f.request),amount('11'));
 consumption.planDigest=`sha256:${'f'.repeat(64)}`;await assert.rejects(()=>f.read(f.request),/different payout plan/);
 consumption.planDigest=planDigest;f.repository.readStageAttempt=async()=>({schema:'conflicting'});await assert.rejects(()=>f.read(f.request),/conflicts/);
});
test('missing or mismatched dust ownership cannot enlarge the pool',async()=>{const f=fixture({dust:'2'});f.repository.readPayoutDust=async()=>null;await assert.rejects(()=>f.read(f.request),/unconsumed/);});
