import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {createRelayClient} from '../../src/relay-client.mjs';
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
 const nativePaymentBinding=createTestNativePaymentBinding({schema:'hookemon.native-payment-binding.v1',chainId:'4663',relay:{sourceRuntime,sourceInstruction:{programId:ix.programId,discriminatorHex:'0b9c60da27a3b413',dataLengthBytes:48,amountOffsetBytes:8,orderIdOffsetBytes:16}}},createTestProfileMutationAuthority());
 return {configured:{solana:sender,evm:recipient},request:{inputAmount:{chainId:'792703809',assetId:mint,decimals:6,amountAtomic:amount},intent,solanaInstructionPlan:plan},nativePaymentBinding,observation,transaction:buildRelayLegacyTransaction({feePayer:sender,recentBlockhash:blockhash,instructionPlan:plan})};
}
