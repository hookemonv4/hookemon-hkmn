import pathlib,json,urllib.request,datetime,hashlib,concurrent.futures,subprocess
out=pathlib.Path(__file__).resolve().parent;root=out.parents[1]
# Retained raw observations are immutable; use a fresh copied directory for another capture.
if (out/'observations.json').exists():
 raise SystemExit('Refusing to overwrite retained observations; choose a fresh evidence directory')
sources={}
def fetch(item):
 name,url,path=item;data=(root/path).read_bytes();(out/f'{name}-request.json').write_bytes(data)
 try:
  completed=subprocess.run(['curl','--max-time','25','--fail-with-body','-sS','-H','content-type: application/json','--data-binary','@-',url],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  result=completed.stdout;status=200 if completed.returncode==0 else None
  if not result:result=json.dumps({'error':completed.stderr.decode()}).encode()
 except Exception as e: result=json.dumps({'error':str(e)}).encode();status=None
 (out/f'{name}-response.json').write_bytes(result)
 return name,{'url':url,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'httpStatus':status,'sha256':hashlib.sha256(result).hexdigest(),'purpose':'Read-only quote or public RPC observation, never provider creation/preflight/signing'}
requests=[('relay-outbound','https://api.relay.link/quote/v2','feasibility/native-test-capital-20260908/relay-outbound-request.json'),('relay-return-scenario','https://api.relay.link/quote/v2','feasibility/native-test-capital-20260908/relay-return-scenario-request.json'),('evm-network','https://rpc.mainnet.chain.robinhood.com','feasibility/native-test-capital-20260908/evm-network-request.json')]
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:sources=dict(pool.map(fetch,requests))
(out/'observations.json').write_text(json.dumps(sources,indent=2)+'\n');print(json.dumps(sources))
