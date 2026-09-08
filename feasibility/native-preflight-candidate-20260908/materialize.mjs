import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveNativePriceCandidate } from '../../scripts/programmable/lib/phase3-release.mjs';
import { deriveSeedIntent } from '../../scripts/programmable/lib/seed-intent.mjs';
const cli = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass checksum-verified official CLI 4.1.0 directory');
const out = 'feasibility/native-preflight-candidate-20260908';
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, data) => writeFile(`${out}/${name}`, JSON.stringify(data, null, 2) + '\n');
const sources = await read('feasibility/native-preflight-materialization/sources.json');
for (const [p,h] of Object.entries(sources.officialCli.moduleSha256)) {
  if (sha(await readFile(resolve(cli,p))) !== h) throw new Error(`Official module mismatch: ${p}`);
}
const mod = name => import(pathToFileURL(resolve(cli,'src',name)));
const { encodeAbiParameters, encodeFunctionData, parseAbiParameters, keccak256, stringToHex, concatHex, getContractAddress } = await import(pathToFileURL(resolve(cli,'node_modules/viem/_esm/index.js')));
const { deriveRouteNamespace } = await mod('graph.mjs');
const { GRAPH_TARGET_SALT_TYPE } = await mod('constants.mjs');
const { v4GraphChainContext } = await mod('v4-contract.mjs');
const { normalizeRuntimeMaterialization, materializeRuntimeCode } = await mod('runtime-immutables.mjs');
const request = await read('feasibility/native-preflight-materialization/proposed-create-request.json');
for (const entry of request.sourceBundleManifest.entries) {
  if (entry.kind !== 'file' || `sha256:${sha(await readFile(entry.path))}` !== entry.contentSha256) throw new Error(`Source bundle drift: ${entry.path}`);
}
const inputs = await read('release/phase3/launch-inputs.json');
const roles = inputs.roles;
const price = deriveNativePriceCandidate({nativeWei:'40000000000000000',hkmnAtomic:inputs.pool.baseAsset.amountAtomic});
const seed = deriveSeedIntent({...price,payer:roles.launchWallet,tickLower:-887220,tickUpper:887220,maxDeadlineSeconds:900});
const scenario = {status:'PROPOSED_UNAPPROVED_READ_ONLY',seedMaximumWei:price.amount0Max,reusableTradingFloatWei:'20000000000000000',processClaimLimit6hWei:'15000000000000000',processClaimLimitMaxWei:'20000000000000000',price,seedIntent:seed,allInBudgetProven:false,providerAdmissionProven:false,signable:false};
const context = v4GraphChainContext(request.chainDeployment);
const namespace = deriveRouteNamespace(request.sourceDescriptor.bundleContentSha256,request.launchWallet,context);
const artifacts = Object.fromEntries(await Promise.all(['token','custody','hook'].map(async n=>[n,await read(`release/phase3/artifacts/${n}.json`)])));
const predictions=[];
const runtimeValues = {
 token:{decimals:['uint8','18'],totalSupply:['uint256',inputs.token.totalSupply.amountAtomic],issuanceAuthority:['address',roles.issuanceAuthority],expectedQuoteCurrency:['address',roles.quoteCurrency],launchSqrtPriceX96:['uint160',price.sqrtPriceX96]},
 custody:{deployer:['address',roles.issuanceAuthority],positionManager:['address',roles.positionManager]},

};
const runtimeEvidence=[];
for(const name of ['token','custody']) {
 const artifact=artifacts[name];const refs=Object.keys(artifact.deployedBytecode.immutableReferences);const nodes=[];
 function visit(x){if(!x||typeof x!=='object')return;if(refs.includes(String(x.id)))nodes.push(x);for(const v of Object.values(x))if(v&&typeof v==='object')Array.isArray(v)?v.forEach(visit):visit(v);}
 visit(artifact.ast);
 if(nodes.length!==refs.length)throw new Error(`Incomplete AST immutable identity for ${name}`);
 const immutables=nodes.map(n=>{const value=runtimeValues[name][n.name];if(!value||value[0]!==n.typeDescriptions.typeString)throw new Error(`Unbound immutable ${name}.${n.name}`);return {immutableId:String(n.id),abiType:value[0],literal:value[1]};});
 const plan=normalizeRuntimeMaterialization({runtimeCode:artifact.deployedBytecode.object,immutableReferences:artifact.deployedBytecode.immutableReferences,runtimeImmutables:immutables,label:name});
 const code=materializeRuntimeCode(plan,new Map(),name);const hash=keccak256(code);
 request.graphBundle.targets.find(t=>t.targetId===name).expectedRuntimeCodeHash=hash;
 request.verificationBundle.components.find(t=>t.targetId===name).runtimeMaterialization={immutableReferences:plan.immutableReferences,runtimeImmutables:plan.runtimeImmutables,deployedRuntimeCodeBase64:Buffer.from(code.slice(2),'hex').toString('base64'),deployedRuntimeCodeHash:hash};
 runtimeEvidence.push({targetId:name,artifactSha256:sha(await readFile(`release/phase3/artifacts/${name}.json`)),runtimeCodeHash:hash,immutableBindings:immutables});
 const args=name==='token'?[roles.issuanceAuthority,roles.quoteCurrency,18,BigInt(price.sqrtPriceX96)]:[roles.positionManager,0n];
 const encoded=encodeAbiParameters(artifact.abi.find(x=>x.type==='constructor').inputs,args);
 const target=request.graphBundle.targets.find(t=>t.targetId===name);target.constructorArguments=encoded;
 request.verificationBundle.components.find(t=>t.targetId===name).constructorArguments=encoded;
 // Exact formulas from official graph.mjs: target ID framing, effectiveTargetSalt, predictedTargetAddress.
 const frameLength=Buffer.alloc(4);frameLength.writeUInt32BE(Buffer.byteLength(name));
 const targetIdHash=keccak256(`0x${Buffer.concat([Buffer.from('programmable.create2-graph-target-id.v1'),Buffer.from([0]),frameLength,Buffer.from(name)]).toString('hex')}`);
 const effectiveSalt=keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,bytes32,bytes32,bytes32,bytes32,address'),[keccak256(stringToHex(GRAPH_TARGET_SALT_TYPE)),BigInt(context.chainId),context.graphFactory,namespace,request.nonce,targetIdHash,target.applicantSalt,context.router]));
 const initCodeHash=keccak256(concatHex([target.creationBytecode,encoded]));
 predictions.push({targetId:name,targetIdHash,effectiveSalt,initCodeHash,applicantSalt:target.applicantSalt,predictedAddress:getContractAddress({opcode:'CREATE2',from:context.graphFactory,salt:effectiveSalt,bytecodeHash:initCodeHash})});
}
// Submitted graph uses zeroed address locator words; official prediction later patches identities.
for(const [name,fn,args] of [['token','allocate',[roles.quoteCurrency]],['custody','configureBindingHook',[roles.quoteCurrency]],['hook','initializeGraphLaunch',[roles.quoteCurrency,BigInt(price.sqrtPriceX96)]]]) {
 request.graphBundle.targets.find(t=>t.targetId===name).initializerCalldata=encodeFunctionData({abi:artifacts[name].abi,functionName:fn,args});
}
const {default:Ajv}=await import(pathToFileURL(resolve(cli,'node_modules/ajv/dist/2020.js')));
const validate=new Ajv({allErrors:true,strict:false,validateFormats:false,logger:false}).compile(await read('feasibility/native-provider-admission/create-schema.json'));
const valid=validate(request);
const preimage = await read('feasibility/native-preflight-materialization/preimage-map.json');
for (const field of preimage.hookConstructor) {
 if(field.name === 'hkmn') field.value = predictions.find(p=>p.targetId==='token').predictedAddress;
 if(field.name === 'processClaimLimit6hWei') field.value = scenario.processClaimLimit6hWei;
 if(field.name === 'processClaimLimitMaxWei') field.value = scenario.processClaimLimitMaxWei;
 if(['bindingDigest','runtimeDigest'].includes(field.name)) field.dependency = 'OPEN FACT: native noncircular manifest/runtime-authority preimages and their producer are not established. Existing derive-addresses only validates supplied nonzero digests.';
}
await save('hook-constructor-fields.json',preimage.hookConstructor);
await save('scenario.json',scenario);
await save('derived-coordinates.json',{status:scenario.status,routeNamespace:namespace,nonce:request.nonce,sourceDescriptor:request.sourceDescriptor,predictions,runtimeEvidence,hookConstructorArgumentsStatus:'Incomplete: bindingDigest/runtimeDigest lack verified native preimage; hook permission salt/address remain unresolved.'});
await save('proposed-create-request.json',request);
await save('validation.json',{valid,errors:validate.errors??[],scope:'Structural schema validation only. No profile acceptance, full graph consistency, owner approval or signability.'});
console.log(JSON.stringify({valid,errorCount:validate.errors?.length??0,price:price.sqrtPriceX96,predictions}));
