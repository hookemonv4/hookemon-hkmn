"""Verify retained evidence integrity and observed bindings; performs no network calls."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).parent
load = lambda name: json.loads((root / name).read_text())
for entry in load('quote-sources.json'):
    for kind in ('request', 'response'):
        raw = (root / (entry['name'] + '-' + kind + '.json')).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == entry[kind + 'Sha256']
rpc = load('relay-runtime-rpc.json')['observations']
assert rpc[0]['response']['result'] == hex(4663)
for contract in load('relay-source-runtime-binding.json'):
    current = next(x['response']['result'] for x in rpc
        if x['request']['method'] == 'eth_getCode'
        and x['request']['params'] == [contract['address'].lower(), 'latest'])
    assert current.lower() == contract['onchainBytecode'].lower()
    rebuilt = bytearray.fromhex(contract['recompiledBytecode'][2:])
    for change in contract['transformations']:
        assert change['type'] == 'replace' and change['reason'] == 'immutable'
        value = bytes.fromhex(contract['transformationValues']['immutables'][change['id']][2:])
        rebuilt[change['offset']:change['offset'] + len(value)] = value
    assert rebuilt.hex() == current[2:].lower()
    for source in contract['sources'].values():
        if 'file' in source:
            assert hashlib.sha256((root / source['file']).read_bytes()).hexdigest() == source['sha256']
out = load('relay-outbound-response.json')
assert len(out['steps']) == 1 and len(out['steps'][0]['items']) == 1
step = out['steps'][0]['items'][0]['data']
assert step['chainId'] == 4663 and step['data'][:10] == '0x49290c1c'
assert '0x' + step['data'][34:74] == step['from'].lower()
assert '0x' + step['data'][74:] == out['protocol']['v2']['orderId']
assert step['value'] == out['protocol']['v2']['paymentDetails']['amount']
assert step['to'] == out['protocol']['v2']['paymentDetails']['depository']
assert out['details']['currencyOut']['amount'] == '25000000'
ret = load('relay-return-scenario-response.json')
assert ret['steps'][0]['items'][0]['data']['addressLookupTableAddresses']
assert ret['protocol']['v2']['orderData']['output']['payments'][0]['currency'] == '0x' + '0' * 40
print('PASS: retained quote hashes, chain identity, current bytecode, immutable transformations, source hashes and scenario bindings. No order-signature or finalized-payment claim.')
