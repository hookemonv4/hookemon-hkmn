from pathlib import Path
import subprocess,json,time
root=Path.cwd(); dest=root/'docs/evidence/native-relay-runtime-build-20260908'; src=root/'.session/relay-runtime/relay-depository-458a64c310a3504aaf37e112af9a8707c9eb11ad/packages/solana-vm'
image='solanafoundation/solana-verifiable-build@sha256:ec2e20e1f80607150a71e4c72adfe64be24347ed0b4fb741c32b34eaf7549a25'
cmd=['docker','--config',str(root/'.session/relay-runtime/docker-public'),'--host','unix:///Users/kerim/.docker/run/docker.sock','run','--rm','--platform','linux/amd64','-v',f'{src}:/build','-w','/build/programs/relay-depository',image,'bash','-c','rustc --version && solana --version && cargo build-sbf --version && cargo build-sbf -- --config \'registries.crates-io.protocol="sparse"\' --locked']
(root/'.session/relay-runtime/docker-public').mkdir(parents=True, exist_ok=True)
started=time.time()
with (dest/'candidate-build.log').open('w') as f:
 r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT)
(dest/'candidate-build.json').write_text(json.dumps({'command':cmd,'exitCode':r.returncode,'elapsedSeconds':round(time.time()-started,3),'compiled':r.returncode==0},indent=2)+'\n')
print('build exit',r.returncode)
