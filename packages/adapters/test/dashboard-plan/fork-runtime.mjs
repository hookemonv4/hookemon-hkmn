import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbiParameters, parseAbi, keccak256, getContractAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN = { id: 4663, name: 'Local Robinhood fork', nativeCurrency: {name:'Ether',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:['http://127.0.0.1:28545']}} };
export const FORK_ROLES = {
 manager:'0x8366a39CC670B4001A1121B8F6A443A643e40951',
 positions:'0x58daec3116aae6D93017bAAea7749052E8a04fA7',
 permit:'0x000000000022D473030F116dDEE9F6B43aC78BA3',
 router:'0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99',
 programmable:'0x4957f49620AFf3Adbbe8195a4f633E49cc93376c',
};
export async function createLocalForkRuntime({rpcUrl,artifactRoot,harnessOutput,operationsAccount}) {
 const url=new URL(rpcUrl);
 assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.port,'28545');assert.equal(url.pathname,'/');assert.equal(url.search,'');
 const client=createPublicClient({chain:CHAIN,transport:http(rpcUrl,{retryCount:0,timeout:30000})});
 const request=(method,params=[])=>client.request({method,params});
 const forkInfo=await request('anvil_nodeInfo');assert.equal(forkInfo.environment.chainId,4663);assert.ok(forkInfo.forkConfig?.forkUrl);
 const initialBlock=await client.getBlock({blockNumber:BigInt(forkInfo.forkConfig.forkBlockNumber)});
 const roles=Object.fromEntries(Object.entries(FORK_ROLES).map(([k,v])=>[k,v.toLowerCase()]));
 const codeHashes={};for(const k of ['manager','positions','permit','router']) {const code=await client.getCode({address:roles[k]});assert.ok(code&&code!=='0x',k+' absent');codeHashes[k]=keccak256(code);}
 const account=privateKeyToAccount('0x'+randomBytes(32).toString('hex'));
 const treasury=privateKeyToAccount('0x'+randomBytes(32).toString('hex')).address.toLowerCase();
 const holders=Array.from({length:3},()=>privateKeyToAccount('0x'+randomBytes(32).toString('hex')).address.toLowerCase()).sort();
 const wallet=createWalletClient({account,chain:CHAIN,transport:http(rpcUrl,{retryCount:0,timeout:30000})});
 await request('anvil_setBalance',[account.address,toHex(100n*10n**18n)]);
 await request('anvil_setBalance',[operationsAccount.address,toHex(1n*10n**18n)]);
 for(const holder of holders) {await request('anvil_setBalance',[holder,'0x0']);assert.equal(await client.getBalance({address:holder}),0n);}
 const receipts=[];
 async function send(tx,label){const hash=await wallet.sendTransaction({...tx,gas:tx.gas??15000000n,maxFeePerGas:3000000000n,maxPriorityFeePerGas:1000000n});const receipt=await client.waitForTransactionReceipt({hash,pollingInterval:20});assert.equal(receipt.status,'success',label);receipts.push({label,hash,blockNumber:receipt.blockNumber.toString(),gasUsed:receipt.gasUsed.toString(),gasPrice:receipt.effectiveGasPrice.toString()});return receipt;}
 const harness=JSON.parse(await readFile(harnessOutput,'utf8')).contracts['ForkCycleHarness.sol'];
 const executorArtifact=harness.ForkCycleExecutor;
 const executorReceipt=await send({data:'0x'+executorArtifact.evm.bytecode.object},'local simulation executor');
 const executor=executorReceipt.contractAddress;
 const relayReceipt=await send({data:'0x'+harness.ForkCycleRelaySimulator.evm.bytecode.object},'explicit simulated bridge solver');
 const relay=relayReceipt.contractAddress;
 const load=async name=>JSON.parse(await readFile(artifactRoot+'/'+name+'.json','utf8'));
 const artifacts={token:await load('token'),custody:await load('custody'),hook:await load('hook')};
 const PRICE=12527072418752396559322253362376889n;
 async function deploy(name,args,mine=false){
  const artifact=artifacts[name];const data=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args});
  let salt=0n,predicted;do{predicted=getContractAddress({opcode:'CREATE2',from:executor,salt:toHex(salt++,{size:32}),bytecodeHash:keccak256(data)});}while(mine&&(BigInt(predicted)&0x3fffn)!==0x20ccn);
  const receipt=await send({to:executor,data:encodeFunctionData({abi:executorArtifact.abi,functionName:'deploy',args:[toHex(salt-1n,{size:32}),data]})},name+' real CREATE2 deployment');
  assert.ok((await client.getCode({address:predicted}))?.length>2);
  return {address:predicted.toLowerCase(),receipt};
 }
 const tokenRecord=await deploy('token',[executor,'0x0000000000000000000000000000000000000000',18,PRICE]);const token=tokenRecord.address;
 const custody=(await deploy('custody',[roles.positions,0n])).address;
 const hook=(await deploy('hook',[[roles.manager,roles.positions,roles.permit,'0x0000000000000000000000000000000000000000',token,60,roles.programmable,treasury,operationsAccount.address,account.address,executor,18,keccak256(toHex('LOCAL SIMULATION ONLY binding')),keccak256(toHex('LOCAL SIMULATION ONLY runtime')),10000000000000000n,20000000000000000n,24n,43200n]],true)).address;
 for(const [name,address,functionName,args] of [['token',token,'allocate',[hook]],['custody',custody,'configureBindingHook',[hook]],['hook',hook,'initializeGraphLaunch',[custody,PRICE]]])await send({to:executor,data:encodeFunctionData({abi:executorArtifact.abi,functionName:'forward',args:[address,encodeFunctionData({abi:artifacts[name].abi,functionName,args})]})},functionName);
 const readToken=(functionName,args=[])=>client.readContract({address:token,abi:artifacts.token.abi,functionName,args});
 const readHook=(functionName,args=[])=>client.readContract({address:hook,abi:artifacts.hook.abi,functionName,args});
 const supply=await readToken('totalSupply');const seedMaximum=40000000000000000n;
 await send({to:hook,value:seedMaximum,data:encodeFunctionData({abi:artifacts.hook.abi,functionName:'seedCanonicalLiquidity',args:[[-887220,887220,6324555320336758663997n,seedMaximum,supply,BigInt(initialBlock.timestamp)+100000n,account.address,custody]]})},'seed canonical liquidity');
 const amountIn=20000000000000000n;
 const pool=['0x0000000000000000000000000000000000000000',token,0,60,hook];
 const params=[encodeAbiParameters(parseAbiParameters('((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'),[[pool,true,amountIn,1n,0n,'0x']]),encodeAbiParameters(parseAbiParameters('address,uint256'),[pool[0],amountIn]),encodeAbiParameters(parseAbiParameters('address,uint256'),[token,1n])];
 await send({to:roles.router,value:amountIn,data:encodeFunctionData({abi:parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']),functionName:'execute',args:['0x10',[encodeAbiParameters(parseAbiParameters('bytes,bytes[]'),['0x060c0f',params])],BigInt(initialBlock.timestamp)+100000n]})},'real Universal Router swap');
 const bought=await readToken('balanceOf',[account.address]);assert.ok(bought>0n);
 const quantities=[bought/10n,bought*2n/10n,0n];quantities[2]=bought-quantities[0]-quantities[1];
 for(let i=0;i<holders.length;i++)await send({to:token,data:encodeFunctionData({abi:artifacts.token.abi,functionName:'transfer',args:[holders[i],quantities[i]]})},'distribute acquired HKMN to holder '+(i+1));
 const liability=await readHook('processLiability');assert.ok(liability>0n);
 await request('anvil_mine',['0x50']);
 const artifactHashes=Object.fromEntries(Object.entries(artifacts).map(([name,a])=>[name,{creationCodeHash:keccak256(a.bytecode.object),runtimeTemplateHash:keccak256(a.deployedBytecode.object)}]));
 return {client,request,send,wallet,account,operationsAccount,roles,executor,relay,relayAbi:harness.ForkCycleRelaySimulator.abi,artifacts,hook,token,custody,treasury,holders,quantities,bought,liability,deployBlock:tokenRecord.receipt.blockNumber,readToken,readHook,receipts,proof:{scope:'LOCAL_MAINNET_FORK_ONLY_WITH_SIMULATED_BRIDGE_AND_COLLECTOR',forkBlock:initialBlock.number.toString(),forkHash:initialBlock.hash,codeHashes,artifactHashes}};
}
