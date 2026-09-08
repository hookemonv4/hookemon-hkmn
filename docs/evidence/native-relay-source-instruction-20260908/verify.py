#!/usr/bin/env python3
"""Offline consistency checks; does not attest deployed-source equivalence."""
import base64, gzip, hashlib, json, pathlib, re
root = pathlib.Path(__file__).resolve().parent
for item in json.loads((root / 'sources.json').read_text()):
    assert hashlib.sha256((root / item['file']).read_bytes()).hexdigest() == item['sha256']
for item in json.loads((root / 'retained-files.json').read_text()):
    assert hashlib.sha256((root / item['file']).read_bytes()).hexdigest() == item['sha256']
provenance = json.loads((root / 'quote-provenance.json').read_text())
assert hashlib.sha256((root / 'relay-return-scenario-response.json').read_bytes()).hexdigest() == provenance['responseSha256']
source = (root / 'depository.rs').read_text()
idl = (root / 'oracle-idl.ts').read_text()
assert 'pub fn deposit_token(ctx: Context<DepositToken>, amount: u64, id: [u8; 32])' in source
assert 'name: "deposit_token",\n      discriminator: [11, 156, 96, 218, 39, 163, 180, 19]' in idl
assert 'name: "amount",\n          type: "u64"' in idl
assert 'array: ["u8", 32]' in idl
quote = json.loads((root / 'relay-return-scenario-response.json').read_text())
step = quote['steps'][0]
ixs = step['items'][0]['data']['instructions']
assert len(ixs) == 1
ix = ixs[0]
program_id = re.search(r'declare_id!\("([^"]+)"\)', source).group(1)
assert ix['programId'] == program_id == quote['protocol']['v2']['paymentDetails']['depository']
# These offsets follow the published argument types and Anchor 0.30.1 discriminator.
amount_offset, order_offset, length = 8, 8 + 8, 8 + 8 + 32
raw = bytes.fromhex(ix['data'])
discriminator = hashlib.sha256(b'global:deposit_token').digest()[:8]
assert raw[:8] == discriminator and len(raw) == length
amount = str(int.from_bytes(raw[amount_offset:order_offset], 'little'))
order_id = '0x' + raw[order_offset:].hex()
assert amount == quote['details']['currencyIn']['amount'] == quote['protocol']['v2']['paymentDetails']['amount']
assert order_id == quote['protocol']['v2']['orderId']
assert order_id != quote['requestId'] == step['requestId']
assert ix['keys'][2]['pubkey'] == quote['details']['sender']
assert ix['keys'][4]['pubkey'] == quote['protocol']['v2']['paymentDetails']['currency']
observation = json.loads((root / 'programdata-observation.json').read_text())
rpc_bytes = gzip.decompress((root / 'programdata-response.json.gz').read_bytes())
assert hashlib.sha256(rpc_bytes).hexdigest() == observation['responseSha256']
data = base64.b64decode(json.loads(rpc_bytes)['result']['value']['data'][0])
assert hashlib.sha256(data).hexdigest() == observation['accountDataSha256']
assert hashlib.sha256(data[45:]).hexdigest() == observation['runtimeBytesSha256Excluding45ByteMetadata']
assert int.from_bytes(data[:4], 'little') == 3
status = json.loads((root / 'verified-build-status.json').read_text())
assert status['is_verified'] is False
result = {'status': 'SOURCE_LAYOUT_CONFIRMED_RUNTIME_EQUIVALENCE_UNVERIFIED', 'sourceInstruction': {'programId': program_id, 'discriminatorHex': discriminator.hex(), 'dataLengthBytes': length, 'amountOffsetBytes': amount_offset, 'orderIdOffsetBytes': order_offset}, 'amountAtomic': amount, 'depositOrderId': order_id, 'requestId': quote['requestId'], 'originalAddressLookupTableAddresses': step['items'][0]['data']['addressLookupTableAddresses'], 'programDataLastDeploymentSlot': int.from_bytes(data[4:12], 'little'), 'upgradeAuthorityPresent': data[12] == 1}
print(json.dumps(result, indent=2))
