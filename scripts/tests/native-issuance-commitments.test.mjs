// All identities, compiler bytes and economics below are synthetic, non-launch-authoritative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, deriveNativeIssuanceCommitments, envelope, sha256 } from '../programmable/lib/native-issuance-commitments.mjs';
const h=`0x${'11'.repeat(32)}`, a=`0x${'22'.repeat(20)}`;
function fixture() {
 const sourceBytes={'Hook.sol':Buffer.from('contract Synthetic {}'),'compiler':Buffer.from('synthetic compiler, not executable'),'input.json':Buffer.from(JSON.stringify({language:'Solidity',sources:{'Hook.sol':{content:'contract Synthetic {}'}},settings:{optimizer:{enabled:true,runs:200}}}))};
 const evidenceBytes={'abi.json':Buffer.from('[]'),'code.bin':Buffer.from([0]),'observation.json':Buffer.from('{"synthetic":true}')};
 const files=(bytes)=>Object.keys(bytes).sort().map(path=>({path,sha256:sha256(bytes[path])}));
 const runtime={schema:'hookemon.native-issuance-runtime-authority.v1',chainId:'999999',genesisHash:h,providerProtocol:'synthetic',providerVersion:'test-only',contracts:[{role:'issuance',address:a,codePath:'code.bin',abiPath:'abi.json',observationPath:'observation.json',blockNumber:'1',blockHash:h}],evidenceFiles:files(evidenceBytes)};
 const binding={schema:'hookemon.native-issuance-prebinding.v1',chainId:'999999',genesisHash:h,requirementsSha256:h,sourceClosure:{compilerPath:'compiler',standardInputPath:'input.json',files:files(sourceBytes)},roles:Object.fromEntries(['poolManager','positionManager','permit2','programmable','treasury','operations','launchAuthority','issuanceAuthority'].map(k=>[k,a])),economics:{name:'Synthetic',symbol:'TEST',decimals:'18',totalSupplyAtomic:'1',marketAllocationBps:'10000',quoteAsset:'native',tickSpacing:'1',lpFee:'0',totalFeeBps:'300',programmableFeeBps:'10',treasuryFeeBps:'40',hookPermissionMask:'8396',processClaimLimit6hWei:'1',processClaimLimitMaxWei:'2',processClaimMaxCount:'1',operationsRotationDelay:'1'},independentDeployment:{graphFactory:a,tokenInitCodeHash:h,tokenEffectiveSalt:h,custodyInitCodeHash:h,custodyEffectiveSalt:h},runtimeAuthorityDigest:envelope('HOOKEMON_NATIVE_ISSUANCE_RUNTIME_AUTHORITY_V1',runtime)};
 return {binding,runtime,sourceBytes,evidenceBytes};
}
test('canonical envelope matches independent Python hashlib vector',()=>{
 assert.equal(canonical({z:'1',a:'x'}),'{"a":"x","z":"1"}');
 assert.equal(envelope('SYNTHETIC_TEST_V1',{z:'1',a:'x'}),'0xfc5b98071f41fe0c87ab08a3d5377e932774b9752bff8a98f61ee894df843cc2');
});
test('synthetic commitments are reproducible and domain separated',()=>{
 const f=fixture(), result=deriveNativeIssuanceCommitments(f);
 assert.deepEqual(result,deriveNativeIssuanceCommitments(f));
 assert.notEqual(result.bindingDigest,result.runtimeDigest);
 assert.notEqual(envelope('A',f.runtime),envelope('B',f.runtime));
});
test('constructor self-reference and unrecognized field refuse',()=>{
 for(const field of ['hookAddress','hookSalt','hookInitCodeHash','hookRuntimeHash','poolId','finalReleaseHash']) {
  const f=fixture(); f.binding[field]=h; assert.throws(()=>deriveNativeIssuanceCommitments(f),/unexpected fields/);
 }
});
test('bytes, source closure, runtime identity and stale commitment mutations refuse',()=>{
 let f=fixture();f.sourceBytes['Hook.sol'][0]^=1;assert.throws(()=>deriveNativeIssuanceCommitments(f),/hash mismatch/);
 f=fixture();f.sourceBytes.extra=Buffer.from('extra');assert.throws(()=>deriveNativeIssuanceCommitments(f),/closure bytes/);
 f=fixture();f.runtime.chainId='1';assert.throws(()=>deriveNativeIssuanceCommitments(f),/identity mismatch/);
 f=fixture();f.runtime.providerVersion='changed';assert.throws(()=>deriveNativeIssuanceCommitments(f),/commitment mismatch/);
 f=fixture();delete f.evidenceBytes['code.bin'];assert.throws(()=>deriveNativeIssuanceCommitments(f),/closure bytes/);
});
test('every direct role and economic change changes the binding commitment',()=>{
 for(const group of ['roles','economics']) for(const key of Object.keys(fixture().binding[group])) {
  const f=fixture(), before=deriveNativeIssuanceCommitments(f).bindingDigest;
  f.binding[group][key]=group==='roles'?`0x${'33'.repeat(20)}`:['name','symbol','quoteAsset'].includes(key)?'changed':String(BigInt(f.binding[group][key])+1n);
  assert.notEqual(deriveNativeIssuanceCommitments(f).bindingDigest,before,key);
 }
});
test('unsafe canonical types refuse',()=>{
 for(const v of [1,NaN,undefined,new Date(),{x:'line\nbreak'}])assert.throws(()=>canonical(v));
});

test('merged field names cannot replace required commitment fields',()=>{
 for (const [group, first, second] of [
  ['roles','permit2','poolManager'],
  ['economics','processClaimLimit6hWei','processClaimLimitMaxWei'],
  ['independentDeployment','custodyEffectiveSalt','custodyInitCodeHash'],
 ]) {
  const f=fixture(), object=f.binding[group];
  object[`${first}|${second}`]=object[first]; delete object[first]; delete object[second];
  assert.throws(()=>deriveNativeIssuanceCommitments(f),/unexpected fields/);
 }
});
test('hash address and decimal validators reject coercible arrays',()=>{
 for(const mutate of [
  f=>{f.binding.requirementsSha256=[h];},
  f=>{f.binding.roles.operations=[a];},
  f=>{f.binding.economics.totalSupplyAtomic=['1'];},
  f=>{f.runtime.contracts[0].blockNumber=['1'];},
 ]) {
  const f=fixture(); mutate(f);
  assert.throws(()=>deriveNativeIssuanceCommitments(f),/invalid (hash|address|unsigned decimal)/);
 }
});

test('commitment paths reject coercion and metadata accessors cannot change hashed values',()=>{
 for(const mutate of [f=>{f.binding.sourceClosure.compilerPath=['compiler'];},f=>{f.runtime.contracts[0].abiPath=['abi.json'];}]){
  const f=fixture();mutate(f);assert.throws(()=>deriveNativeIssuanceCommitments(f),/invalid ASCII text/);
 }
 const f=fixture();Object.defineProperty(f.binding,'chainId',{enumerable:true,get(){return '999999';}});
 assert.throws(()=>deriveNativeIssuanceCommitments(f),/accessors refused/);
 assert.throws(()=>canonical(new Array(2)),/no numbers or exotic objects/);
});
