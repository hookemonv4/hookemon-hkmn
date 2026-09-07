import json,urllib.request,time
from pathlib import Path
URL='http://127.0.0.1:18550'
def rpc(m,p):
 r=json.load(urllib.request.urlopen(urllib.request.Request(URL,data=json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p}).encode(),headers={'Content-Type':'application/json'})))
 if 'error'in r:raise RuntimeError(r['error'])
 return r['result']
def w(x):return (int(x,16) if isinstance(x,str) else x).to_bytes(32,'big').hex()
m=json.load(open('packages/contracts/test/release/.generated/local-gasseed-metadata.json'));permit='0x000000000022d473030f116ddee9f6b43ac78ba3';manager='0x8366a39CC670B4001A1121B8F6A443A643e40951'
def bal(t,a):return int(rpc('eth_call',[{'to':t,'data':'0x70a08231'+w(a)},'latest']),16)
def snapshot():return {key:str(bal(t,a)) for key,t,a in [('payerUsdg',m['usdg'],m['payer']),('managerUsdg',m['usdg'],manager),('hookHkmn',m['hkmn'],m['hook']),('managerHkmn',m['hkmn'],manager)]}
initial=snapshot();assert initial['payerUsdg']=='100000000' and initial['hookHkmn']==str(10**27) and initial['managerHkmn']=='0'
rows=[]
for a in [m['payer'],m['authority']]:rpc('anvil_impersonateAccount',[a]);rpc('anvil_setBalance',[a,hex(10**20)])
def send(a,to,data):
 h=rpc('eth_sendTransaction',[{'from':a,'to':to,'data':data,'gas':'0x989680'}]);r=None
 while r is None:time.sleep(.1);r=rpc('eth_getTransactionReceipt',[h])
 rows.append({'from':a,'to':to,'calldata':data,'receipt':r});Path('.local-gas/seed-receipts.json').write_text(json.dumps(rows,indent=2));assert r['status']=='0x1',r
send(m['payer'],m['usdg'],'0x095ea7b3'+w(permit)+w(100000000))
send(m['payer'],permit,'0x87517c45'+w(m['usdg'])+w(m['hook'])+w(100000000)+w(2**48-1))
send(m['authority'],m['hook'],m['seedCalldata'])
final=snapshot();assert final['payerUsdg']=='0' and final['hookHkmn']=='0' and final['managerHkmn']==str(10**27);assert int(final['managerUsdg'])-int(initial['managerUsdg'])==100000000
owner=rpc('eth_call',[{'to':m['positionManager'],'data':'0x6352211e'+w(m['positionId'])},'latest']);assert owner[-40:].lower()==m['custody'][2:].lower()
out={'initial':initial,'final':final,'positionId':str(m['positionId']),'positionOwner':m['custody'],'gasEach':[str(int(x['receipt']['gasUsed'],16)) for x in rows],'totalGas':str(sum(int(x['receipt']['gasUsed'],16) for x in rows))};Path('.local-gas/seed-summary.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
