import json,urllib.request,time
from pathlib import Path
URL='http://127.0.0.1:18549'
assert URL.startswith('http://127.0.0.1:')
meta=json.load(open('packages/contracts/test/release/.generated/local-gasclaim-metadata.json'))
def rpc(method,params):
 r=json.load(urllib.request.urlopen(urllib.request.Request(URL,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})))
 if 'error' in r:raise RuntimeError(r['error'])
 return r['result']
def w(x):return int(x,16).to_bytes(32,'big') if isinstance(x,str) else x.to_bytes(32,'big')
def b(x):return w(len(x))+x+b'\x00'*((-len(x))%32)
def arr(xs):
 off=32*len(xs);o=[]
 for x in xs:o.append(w(off));off+=len(b(x))
 return w(len(xs))+b''.join(o)+b''.join(b(x) for x in xs)
def enc(zero,amount):
 c0,c1=sorted([meta['usdg'],meta['hkmn']],key=lambda x:int(x,16));head=b''.join(map(w,[c0,c1,0,60,meta['hook'],int(zero),amount,0,0,320]));p0=w(32)+head+w(0)
 ps=[p0,w(c0 if zero else c1)+w(2**256-1),w(c1 if zero else c0)+w(0)]
 a=w(64)+w(128)+b(bytes.fromhex('060c0f'))+arr(ps)
 commands=b(bytes.fromhex('10'));inputs=arr([a]);deadline=int(rpc('eth_getBlockByNumber',['latest',False])['timestamp'],16)+3600
 return '0x3593564c'+(w(96)+w(96+len(commands))+w(deadline)+commands+inputs).hex()
def balance(token):return int(rpc('eth_call',[{'to':token,'data':'0x70a08231'+w(meta['trader']).hex()},'latest']),16)
def send(zero,amount):
 data=enc(zero,amount);h=rpc('eth_sendTransaction',[{'from':meta['trader'],'to':meta['router'],'data':data,'gas':'0x1e8480'}]);r=rpc('eth_getTransactionReceipt',[h]);
 while r is None:
  time.sleep(0.1)
  r=rpc('eth_getTransactionReceipt',[h])
 assert r['status']=='0x1',r
 return {'hash':h,'gasUsed':int(r['gasUsed'],16),'blockNumber':int(r['blockNumber'],16),'calldataBytes':(len(data)-2)//2,'amountInAtomic':amount,'receipt':r}


rpc('anvil_impersonateAccount',[meta['trader']])
manager='0x8366a39CC670B4001A1121B8F6A443A643e40951'
def balanceOf(token,who):return int(rpc('eth_call',[{'to':token,'data':'0x70a08231'+w(who).hex()},'latest']),16)
initialManager=balanceOf(meta['usdg'],manager)
assert initialManager==int(meta['initialManagerUsdgAtomic'])
assert balance(meta['usdg'])==50_000_000 and balance(meta['hkmn'])==0
assert balanceOf(meta['usdg'],meta['hook'])==0
rows=[]
def save():
 state={'traderUsdgAtomic':str(balance(meta['usdg'])),'traderHkmnAtomic':str(balance(meta['hkmn'])),'hookUsdgAtomic':str(balanceOf(meta['usdg'],meta['hook'])),'managerUsdgAtomic':str(balanceOf(meta['usdg'],manager))}
 Path('.local-gas/transactionsclaim.json').write_text(json.dumps({'metadata':meta,'initialManagerUsdgAtomic':str(initialManager),'initialSeedUsdgAtomic':'100000000','initialTraderUsdgAtomic':'50000000','state':state,'transactions':rows},indent=2))
for i in range(16):
 available=balance(meta['usdg']);assert available>0
 rows.append(send(int(meta['usdg'],16)<int(meta['hkmn'],16),available));save()
 bought=balance(meta['hkmn']);assert bought>0
 rows.append(send(int(meta['hkmn'],16)<int(meta['usdg'],16),bought));save()
 assert balance(meta['hkmn'])==0
 assert balance(meta['usdg'])+balanceOf(meta['usdg'],meta['hook'])+balanceOf(meta['usdg'],manager)-initialManager+100_000_000==150_000_000
process=int(rpc('eth_call',[{'to':meta['hook'],'data':'0x3e4c7986'},'latest']),16)
assert process>=25_298_644
print(json.dumps({'count':len(rows),'gasTotal':sum(x['gasUsed'] for x in rows),'gasEach':[x['gasUsed'] for x in rows],'processAtomic':str(process)}))

operations='0x0000000000000000000000000000000000007000'
amount=25_298_644
before=balanceOf(meta['usdg'],operations)
rpc('anvil_setBalance',[operations,hex(10**18)])
rpc('anvil_impersonateAccount',[operations])
data='0xfea0767c'+b'local-budget-150'.ljust(32,b'\x00').hex()+w(amount).hex()+w(operations).hex()
h=rpc('eth_sendTransaction',[{'from':operations,'to':meta['hook'],'data':data,'gas':'0x1e8480'}])
r=None
while r is None:
 time.sleep(0.1)
 r=rpc('eth_getTransactionReceipt',[h])
Path('.local-gas/claim-receipt.json').write_text(json.dumps(r,indent=2))
assert r['status']=='0x1',r
afterProcess=int(rpc('eth_call',[{'to':meta['hook'],'data':'0x3e4c7986'},'latest']),16)
assert afterProcess==process-amount
assert balanceOf(meta['usdg'],operations)-before==amount
assert balance(meta['usdg'])+balanceOf(meta['usdg'],meta['hook'])+balanceOf(meta['usdg'],manager)-initialManager+100_000_000+amount==150_000_000
out={'claimAmountAtomic':str(amount),'processBeforeAtomic':str(process),'processAfterAtomic':str(afterProcess),'operationsCreditAtomic':str(balanceOf(meta['usdg'],operations)-before),'traderUsdgAtomic':str(balance(meta['usdg'])),'hookUsdgAtomic':str(balanceOf(meta['usdg'],meta['hook'])),'managerDeltaAtomic':str(balanceOf(meta['usdg'],manager)-initialManager),'claimGasUsed':int(r['gasUsed'],16),'swapGasUsed':sum(x['gasUsed'] for x in rows),'ownerCapitalAtomic':'150000000','claimReceipt':r}
Path('.local-gas/claim-summary.json').write_text(json.dumps(out,indent=2))
print(json.dumps({k:v for k,v in out.items() if k!='claimReceipt'}))
