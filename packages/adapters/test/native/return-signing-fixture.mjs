import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {keccak256} from 'viem';
import {PublicKey} from '@solana/web3.js';
import {createRelayClient,createQuoteUsdValuation,readProcessQuoteUsdProvenance} from '../../src/relay-client.mjs';
import {createTestNativePaymentBinding} from '../../src/native-payment-proof.mjs';
import {createTestProfileMutationAuthority} from '../../../runner/src/cycle/preflight.mjs';
import {buildRelayLegacyTransaction,deriveAssociatedTokenAddress} from '../../src/solana-rpc.mjs';
export function returnSigningFixture({sender,recipient='0x2222222222222222222222222222222222222222',amount='17',blockhash='11111111111111111111111111111111'}={}) {
 const capture=JSON.parse(readFileSync(new URL('../../../../docs/evidence/native-relay-source-instruction-20260908/relay-return-scenario-response.json',import.meta.url)));
 const plan=structuredClone(capture.steps[0].items[0].data),ix=plan.instructions[0],mint=ix.keys[4].pubkey;
 ix.keys[1].pubkey=sender;ix.keys[2].pubkey=sender;ix.keys[5].pubkey=deriveAssociatedTokenAddress(sender,mint).toBase58();
 const data=Buffer.from(ix.data,'hex');data.writeBigUInt64LE(BigInt(amount),8);ix.data=data.toString('hex');const orderId=`0x${data.subarray(16).toString('hex')}`;
 const intent=createRelayClient().prepareExecution({liveMode:true,quote:{direction:'RETURN',tradeType:'EXACT_INPUT',requestId:capture.steps[0].requestId,orderId,sender,recipient,deadlineUnixSeconds:2000000000,origin:{chainId:792703809,address:mint,decimals:6,amount},destination:{chainId:4663,address:'0x0000000000000000000000000000000000000000',decimals:18,amount:'42',minimumAmount:'40'},raw:{steps:[]}}}).intent;
 const programDataAddress='6y7C7Lfh1WRRbKohE2FQmFBD2asw3yMi17kStwEcAWWF',loaderOwner='BPFLoaderUpgradeab1e11111111111111111111111',elf=Buffer.from('7f454c46010203','hex');
 const program=Buffer.alloc(36);program.writeUInt32LE(2);new PublicKey(programDataAddress).toBuffer().copy(program,4);const programData=Buffer.alloc(45+elf.length);programData.writeUInt32LE(3);programData.writeBigUInt64LE(1n,4);elf.copy(programData,45);
 const observation={context:{slot:11},value:[{owner:loaderOwner,executable:true,data:[program.toString('base64'),'base64']},{owner:loaderOwner,executable:false,data:[programData.toString('base64'),'base64']}]};
 const sourceRuntime={schema:'hookemon.solana-upgradeable-runtime.v1',programId:ix.programId,programDataAddress,loaderOwner,normalizedRuntimeSha256:createHash('sha256').update(elf).digest('hex')};
 const nativePaymentBinding=createTestNativePaymentBinding({schema:'hookemon.native-payment-binding.v1',chainId:'4663',relay:{schema:'hookemon.relay-native-route.v1',emitter:'0x1111111111111111111111111111111111111111',runtimeHash:keccak256('0x6000'),metadataEncoding:'order-id',sourceRuntime,sourceInstruction:{programId:ix.programId,discriminatorHex:'0b9c60da27a3b413',dataLengthBytes:48,amountOffsetBytes:8,orderIdOffsetBytes:16}}},createTestProfileMutationAuthority());
 return {configured:{solana:sender,evm:recipient},request:{inputAmount:{chainId:'792703809',assetId:mint,decimals:6,amountAtomic:amount},intent,solanaInstructionPlan:plan},nativePaymentBinding,observation,transaction:buildRelayLegacyTransaction({feePayer:sender,recentBlockhash:blockhash,instructionPlan:plan})};
}

// Isolated synthetic HTTP quote with the captured instruction grammar. The real adapter creates
// the valuation capability; these fixture prices confer no live provider or release authority.
export async function producedReturnSigningFixture({cycleId='cycle-return-fixture',nowMs=1700000000000,requestId=null,destinationAmount=null,...options}={}) {
 const native=returnSigningFixture(options),intent={...native.request.intent};
 const raw=JSON.parse(readFileSync(new URL('../../../../docs/evidence/native-relay-source-instruction-20260908/relay-return-scenario-response.json',import.meta.url)));
 if(requestId!==null){raw.requestId=requestId;raw.steps[0].requestId=requestId;}
 if(destinationAmount!==null){intent.quotedDestinationAmount=destinationAmount;intent.quotedDestinationMinimumAmount=destinationAmount;}
 raw.details.sender=intent.sender;raw.details.recipient=intent.recipient;
 Object.assign(raw.details.currencyIn,{amount:intent.originAmount,minimumAmount:intent.originAmount,amountUsd:'0.000016'});
 Object.assign(raw.details.currencyOut,{amount:intent.quotedDestinationAmount,minimumAmount:intent.quotedDestinationMinimumAmount,amountUsd:'0.000015'});
 const order=raw.protocol.v2.orderData;
 order.inputs[0].payment.amount=intent.originAmount;
 for(const refund of order.inputs[0].refunds){refund.recipient=refund.chainId==='solana'?intent.sender:intent.recipient;refund.deadline=intent.deadlineUnixSeconds;}
 Object.assign(order.output.payments[0],{recipient:intent.recipient,expectedAmount:intent.quotedDestinationAmount,minimumAmount:intent.quotedDestinationMinimumAmount});
 order.output.deadline=intent.deadlineUnixSeconds;
 raw.steps[0].items[0].data=native.request.solanaInstructionPlan;
 const relay=createRelayClient({now:()=>nowMs,quoteValidityMs:60000,fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify(raw)})});
 const quote=await relay.quote({direction:'RETURN',tradeType:'EXACT_INPUT',user:intent.sender,recipient:intent.recipient,amount:intent.originAmount,skipRouteCheck:true});
 const destinationTypedAmount={chainId:'4663',assetId:'native',decimals:18,amountAtomic:quote.destination.amount};
 const destinationUsd=createQuoteUsdValuation({quote,side:'destination',amount:destinationTypedAmount,rounding:'down',nowMs});
 native.request={...native.request,schema:'hookemon.return-relay-request.v2',cycleId,intent:relay.prepareExecution({quote,liveMode:true}).intent,
  destinationAmount:destinationTypedAmount,destinationUsd,destinationUsdEvidence:{...readProcessQuoteUsdProvenance(destinationUsd),quote},
  requestCreatedAtUnixSeconds:String(Math.floor(nowMs/1000)),maxSettlementWindowSeconds:'600'};
 return {...native,relay};
}
