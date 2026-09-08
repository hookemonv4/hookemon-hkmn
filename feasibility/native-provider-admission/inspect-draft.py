"""Record direct required/type/const violations, not a full JSON Schema validator."""
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent

def digest(data):
    return hashlib.sha256(data).hexdigest()

def inspect(value, schema, path='$'):
    issues = []
    expected = schema.get('type')
    types = {'object': dict, 'array': list, 'string': str, 'integer': int,
             'number': (int, float), 'boolean': bool, 'null': type(None)}
    if expected:
        allowed = expected if isinstance(expected, list) else [expected]
        if not any(isinstance(value, types[t]) and not (t in ('integer', 'number') and isinstance(value, bool)) for t in allowed):
            return [{'path': path, 'reason': 'type', 'expected': expected,
                     'actual': 'null' if value is None else type(value).__name__}]
    if 'const' in schema and value != schema['const']:
        issues.append({'path': path, 'reason': 'const', 'expected': schema['const']})
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                issues.append({'path': path + '.' + key, 'reason': 'required'})
        for key, child in schema.get('properties', {}).items():
            if key in value:
                issues.extend(inspect(value[key], child, path + '.' + key))
    if isinstance(value, list) and isinstance(schema.get('items'), dict):
        for index, child in enumerate(value):
            issues.extend(inspect(child, schema['items'], f'{path}[{index}]'))
    return issues

if __name__ == '__main__':
    draft_bytes = (BASE / 'input-create-request.snapshot.json').read_bytes()
    schema_bytes = (BASE / 'create-schema.json').read_bytes()
    draft = json.loads(draft_bytes)
    issues = inspect(draft, json.loads(schema_bytes))
    result = {
        'schema': 'hookemon.native-provider-admission-inspection.v1',
        'requestSha256': digest(draft_bytes), 'requestBytes': len(draft_bytes),
        'schemaSha256': digest(schema_bytes),
        'scope': 'Direct required/type/const checks only; no full schema, cryptographic, economics or server validation.',
        'preflightSent': False, 'apiKeyRead': False,
        'verdict': 'incomplete-request' if issues else 'requires-full-validation',
        'directViolations': issues,
        'targets': [{'targetId': t['targetId'], 'creationBytecodeBytes': (len(t['creationBytecode']) - 2) // 2,
                     'creationBytecodeSha256': digest(bytes.fromhex(t['creationBytecode'][2:]))}
                    for t in draft['graphBundle']['targets']]
    }
    (BASE / 'inspection.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f"{len(issues)} direct schema violations; preflight not sent")
