// Approved revision-72 hashing contract. Evidence authentication and launch authority remain separate.
import { createHash } from 'node:crypto';
export const sha256 = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (message) => { throw new Error(message); };
const sameKeys = (actual, expected) => actual.length === expected.length && actual.every((key, index) => key === expected[index]);
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      !sameKeys(Object.keys(value).sort(), [...keys].sort())) fail('unexpected fields');
};
const hash = (v) => { if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/.test(v)) fail('invalid hash'); };
const address = (v) => { if (typeof v !== 'string' || !/^0x[0-9a-f]{40}$/.test(v)) fail('invalid address'); };
const uint = (v) => { if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) fail('invalid unsigned decimal'); };
const text = (v) => { if (typeof v !== 'string' || !/^[\x20-\x7e]+$/.test(v)) fail('invalid ASCII text'); };
const path = value => { text(value); if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) fail('invalid path'); };
export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { text(value); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('no numbers or exotic objects');
  return `{${Object.keys(value).sort().map(k => { text(k); return `${JSON.stringify(k)}:${canonical(value[k])}`; }).join(',')}}`;
}
export function envelope(domain, document) {
  text(domain);
  return sha256(Buffer.concat([Buffer.from(domain, 'ascii'), Buffer.from([0]), Buffer.from(canonical(document), 'utf8')]));
}
function verifyFiles(files, bytes) {
  if (!Array.isArray(files) || !files.length) fail('empty closure');
  const names = files.map(f => f.path);
  if (new Set(names).size !== names.length || !sameKeys(names, [...names].sort())) fail('unordered closure');
  if (!sameKeys(Object.keys(bytes).sort(), names)) fail('closure bytes differ');
  for (const f of files) {
    exact(f, ['path', 'sha256']); hash(f.sha256);
    path(f.path);
    if (!Buffer.isBuffer(bytes[f.path]) || sha256(bytes[f.path]) !== f.sha256) fail('file hash mismatch');
  }
}
function plainSnapshot(value) {
  if (Array.isArray(value)) return Array.from(value, plainSnapshot);
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) fail('commitment metadata must be plain data');
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
    if (!Object.hasOwn(descriptor, 'value')) fail('commitment metadata accessors refused');
    return [key, plainSnapshot(descriptor.value)];
  }));
}
function byteSnapshot(value) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('commitment bytes must be a plain map');
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
    if (!Object.hasOwn(descriptor, 'value') || !Buffer.isBuffer(descriptor.value)) fail('commitment bytes must be own buffers');
    return [key, Buffer.from(descriptor.value)];
  }));
}
export function snapshotNativeCommitmentInputs(input) {
  return {binding:plainSnapshot(input.binding),runtime:plainSnapshot(input.runtime),sourceBytes:byteSnapshot(input.sourceBytes),evidenceBytes:byteSnapshot(input.evidenceBytes)};
}
export function deriveNativeIssuanceCommitments(commitmentInput) {
  const { binding, runtime, sourceBytes, evidenceBytes } = snapshotNativeCommitmentInputs(commitmentInput);
  exact(binding, ['schema','chainId','genesisHash','requirementsSha256','sourceClosure','roles','economics','independentDeployment','runtimeAuthorityDigest']);
  if (binding.schema !== 'hookemon.native-issuance-prebinding.v1') fail('binding schema');
  uint(binding.chainId); hash(binding.genesisHash); hash(binding.requirementsSha256);
  exact(binding.sourceClosure, ['compilerPath','standardInputPath','files']);
  verifyFiles(binding.sourceClosure.files, sourceBytes);
  path(binding.sourceClosure.compilerPath); path(binding.sourceClosure.standardInputPath);
  if (!Object.hasOwn(sourceBytes,binding.sourceClosure.compilerPath) || !Object.hasOwn(sourceBytes,binding.sourceClosure.standardInputPath)) fail('missing compiler input');
  const input = JSON.parse(sourceBytes[binding.sourceClosure.standardInputPath].toString('utf8'));
  if (input.language !== 'Solidity' || !input.sources || !input.settings) fail('invalid standard input');
  // Every compiler source is embedded, and its exact UTF-8 bytes occur in the closure.
  for (const [path, source] of Object.entries(input.sources)) {
    exact(source,['content']);
    if (typeof source.content !== 'string' || !Object.hasOwn(sourceBytes,path) || !sourceBytes[path].equals(Buffer.from(source.content,'utf8'))) fail('source closure mismatch');
  }
  exact(binding.roles, ['poolManager','positionManager','permit2','programmable','treasury','operations','launchAuthority','issuanceAuthority']);
  for (const v of Object.values(binding.roles)) address(v);
  exact(binding.economics, ['name','symbol','decimals','totalSupplyAtomic','marketAllocationBps','quoteAsset','tickSpacing','lpFee','totalFeeBps','programmableFeeBps','treasuryFeeBps','hookPermissionMask','processClaimLimit6hWei','processClaimLimitMaxWei','processClaimMaxCount','operationsRotationDelay']);
  for (const [k,v] of Object.entries(binding.economics)) ['name','symbol','quoteAsset'].includes(k) ? text(v) : uint(v);
  exact(binding.independentDeployment, ['graphFactory','tokenInitCodeHash','tokenEffectiveSalt','custodyInitCodeHash','custodyEffectiveSalt']);
  address(binding.independentDeployment.graphFactory);
  for (const [k,v] of Object.entries(binding.independentDeployment)) if (k !== 'graphFactory') hash(v);
  exact(runtime,['schema','chainId','genesisHash','providerProtocol','providerVersion','contracts','evidenceFiles']);
  if (runtime.schema !== 'hookemon.native-issuance-runtime-authority.v1' || runtime.chainId !== binding.chainId || runtime.genesisHash !== binding.genesisHash) fail('runtime identity mismatch');
  text(runtime.providerProtocol); text(runtime.providerVersion);
  verifyFiles(runtime.evidenceFiles,evidenceBytes);
  if (!Array.isArray(runtime.contracts) || !runtime.contracts.length) fail('empty runtime authorities');
  const ids=runtime.contracts.map(c=>c.role);
  if (new Set(ids).size!==ids.length || !sameKeys(ids,[...ids].sort())) fail('unordered authorities');
  for (const c of runtime.contracts) {
    exact(c,['role','address','codePath','abiPath','observationPath','blockNumber','blockHash']);
    text(c.role); address(c.address); uint(c.blockNumber); hash(c.blockHash);
    for (const key of ['codePath','abiPath','observationPath']) { path(c[key]); if (!Object.hasOwn(evidenceBytes,c[key])) fail('missing authority evidence'); }
  }
  const runtimeDigest=envelope('HOOKEMON_NATIVE_ISSUANCE_RUNTIME_AUTHORITY_V1',runtime);
  if (binding.runtimeAuthorityDigest !== runtimeDigest) fail('runtime commitment mismatch');
  return { bindingDigest:envelope('HOOKEMON_NATIVE_ISSUANCE_BINDING_V1',binding), runtimeDigest };
}
