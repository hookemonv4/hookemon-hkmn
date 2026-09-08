import {readFileSync} from 'node:fs';
import {ComputeBudgetProgram,Keypair,PublicKey,Transaction} from '@solana/web3.js';
const reference=JSON.parse(readFileSync(new URL('./collector-core-buyback-public.json',import.meta.url),'utf8'));
const core='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',ata='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',mint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const r=(role,isSigner=false,isWritable=false)=>({role,isSigner,isWritable});
const t=(kind,programId,accounts=[],extra={})=>({kind,programId,accounts,computeUnitLimit:null,priorityFeeCapAtomic:null,discriminatorHex:null,...extra});
// Generated local keys and provider stubs only. The public message is a structural seed.
export function syntheticCoreBuyback({operator,asset,amountAtomic,memo}){
 const provider=Keypair.generate(),owner=operator.publicKey.toBase58();
 const destination=PublicKey.findProgramAddressSync([operator.publicKey.toBuffer(),new PublicKey(token).toBuffer(),new PublicKey(mint).toBuffer()],new PublicKey(ata))[0].toBase58();
 const binding={schema:'hookemon.collector-buyback-binding.v1',version:1,provider:'collector-crypt',chainId:'solana-mainnet',format:'legacy',addressLookupTables:[],profile:'core-transfer-v1',
  proceeds:{source:'D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk',mint,decimals:6},collectorAuthority:provider.publicKey.toBase58(),collectorRecipient:'riftWhN8A3gmqsZSNh728z7bZPqNPP5eKep77nCY4Zj',collection:'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac',
  instructions:[t('compute-budget-set-unit-limit',ComputeBudgetProgram.programId.toBase58(),[],{computeUnitLimit:250000}),
   t('unknown',core,[r('opened-asset-mint',false,true),r('collection'),r('collector-authority',true,true),r('operator-owner',true),r('collector-recipient'),r('core-program'),r('core-program')],{discriminatorHex:'0e00'}),
   t('compute-budget-set-unit-price',ComputeBudgetProgram.programId.toBase58(),[],{priorityFeeCapAtomic:'10000'}),
   t('unknown',ata,[r('collector-authority',true,true),r('proceeds-destination',false,true),r('operator-owner',true),r('proceeds-mint'),r('system-program'),r('token-program')],{discriminatorHex:'01'}),
   t('spl-transfer-checked',token,[r('proceeds-source',false,true),r('proceeds-mint'),r('proceeds-destination',false,true),r('collector-authority',true,true)]),
   t('unknown','MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')]};
 const replacements=new Map([['GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3',binding.collectorAuthority],['FVWiwDoc3Dthm9X7SVshTkRYr78V4doAz79VRJfdeWMq',owner],['GED2f7TkujBkQRzpQdqSjPserYqWby1xuJiU2wxpie5a',destination],['7Jhmf2Rs12aQdcHiVb5DBaWgAx9QF3ypYLtDcEjPZQCQ',asset]]);
 const transaction=Transaction.from(Buffer.from(reference.serializedTransaction,'base64'));transaction.signatures=[];transaction.feePayer=provider.publicKey;
 for(const ix of transaction.instructions)for(const key of ix.keys)if(replacements.has(key.pubkey.toBase58()))key.pubkey=new PublicKey(replacements.get(key.pubkey.toBase58()));
 transaction.instructions[4].data.writeBigUInt64LE(BigInt(amountAtomic),1);transaction.instructions[5].data=Buffer.from(`${memo}:buyback`);transaction.partialSign(provider);
 return {binding,transaction,serializedTransaction:transaction.serialize({requireAllSignatures:false}).toString('base64')};
}
