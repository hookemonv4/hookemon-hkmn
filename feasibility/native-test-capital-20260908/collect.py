#!/usr/bin/env python3
"""Public read-only scenario collection. No credentials, generated transactions or submission."""
import concurrent.futures,datetime,hashlib,json,pathlib,subprocess
P=pathlib.Path(__file__).resolve().parent
EVM='https://rpc.mainnet.chain.robinhood.com'; SOL='https://api.mainnet-beta.solana.com'
LAUNCH='0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729'; OPS='0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384'; SOPS='BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE'; USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
def fetch(name,url,request):
 req=P/(name+'-request.json');req.write_text(json.dumps(request,separators=(',',':'))+'\n');dest=P/(name+'-response.json');at=datetime.datetime.now(datetime.timezone.utc).isoformat()
 r=subprocess.run(['/usr/bin/curl','--max-time','45','-sS','-w','%{http_code}','-H','Content-Type: application/json','--data-binary','@'+str(req),url,'-o',str(dest)],capture_output=True,text=True)
 return {'name':name,'url':url,'at':at,'httpStatus':r.stdout,'exitCode':r.returncode,'stderr':r.stderr,'requestSha256':hashlib.sha256(req.read_bytes()).hexdigest(),'responseSha256':hashlib.sha256(dest.read_bytes()).hexdigest() if dest.exists() else None}
def rpc(i,m,p):return {'jsonrpc':'2.0','id':i,'method':m,'params':p}
out={'user':OPS,'recipient':SOPS,'originChainId':4663,'destinationChainId':792703809,'originCurrency':'0x'+'0'*40,'destinationCurrency':USDC,'amount':'25000000','tradeType':'EXACT_OUTPUT','refundTo':OPS,'explicitDeposit':True,'includeProtocolData':True}
back={'user':SOPS,'recipient':OPS,'originChainId':792703809,'destinationChainId':4663,'originCurrency':USDC,'destinationCurrency':'0x'+'0'*40,'amount':'25000000','tradeType':'EXACT_INPUT','refundTo':SOPS,'explicitDeposit':True,'includeProtocolData':True}
requests=[('relay-outbound','https://api.relay.link/quote/v2',out),('relay-return-scenario','https://api.relay.link/quote/v2',back),('evm-network',EVM,[rpc(1,'eth_chainId',[]),rpc(2,'eth_getBlockByNumber',['latest',False]),rpc(3,'eth_gasPrice',[])]),('solana-balances',SOL,[rpc(1,'getBalance',[SOPS,{'commitment':'finalized'}]),rpc(2,'getTokenAccountsByOwner',[SOPS,{'mint':USDC},{'encoding':'jsonParsed','commitment':'finalized'}]),rpc(3,'getMinimumBalanceForRentExemption',[165,{'commitment':'finalized'}]),rpc(4,'getLatestBlockhash',[{'commitment':'finalized'}])])]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as e: rows=list(e.map(lambda a:fetch(*a),requests))
network=json.loads((P/'evm-network-response.json').read_text());block=next(a['result'] for a in network if a['id']==2)['number']
rows.append(fetch('evm-wallets',EVM,[rpc(1,'eth_getBalance',[LAUNCH,block]),rpc(2,'eth_getTransactionCount',[LAUNCH,block]),rpc(3,'eth_getBalance',[OPS,block]),rpc(4,'eth_getTransactionCount',[OPS,block])]))
(P/'collection-sources.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows,indent=2))
