#!/usr/bin/env python3
"""Recompute the retained runtime hash; optionally compare a local build. No RPC."""
import base64, gzip, hashlib, json, pathlib, sys
root = pathlib.Path(__file__).resolve().parent
record = json.loads((root / 'runtime-comparison.json').read_text())
response = json.loads(gzip.decompress((root.parent / 'native-relay-source-instruction-20260908/programdata-response.json.gz').read_bytes()))
data = base64.b64decode(response['result']['value']['data'][0], validate=True)
assert hashlib.sha256(data).hexdigest() == record['accountSha256']
assert response['result']['context']['slot'] == record['observationSlot']
assert data[:4] == (3).to_bytes(4, 'little')
runtime = data[45:]
assert runtime[:4] == b'\x7fELF'
assert hashlib.sha256(runtime).hexdigest() == record['runtimeRegionSha256']
actual = hashlib.sha256(runtime.rstrip(b'\0')).hexdigest()
assert actual == record['solanaVerifyProgramHash']
assert len(runtime) - len(runtime.rstrip(b'\0')) == record['trailingZeroBytes']
result = {'recordedProgramHash': actual, 'localExecutableHash': None, 'match': None}
if len(sys.argv) == 2:
    local = pathlib.Path(sys.argv[1]).read_bytes()
    assert local[:4] == b'\x7fELF', 'Local candidate must be ELF'
    result['localExecutableHash'] = hashlib.sha256(local.rstrip(b'\0')).hexdigest()
    result['match'] = result['localExecutableHash'] == actual
print(json.dumps(result, indent=2))
if result['match'] is False:
    sys.exit(1)
