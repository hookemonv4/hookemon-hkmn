// Approved revision-72 hashing contract. Evidence authentication and launch authority remain separate.
import { createHash } from 'node:crypto';
export const sha256 = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (message) => { throw new Error(message); };
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('unexpected fields');
};
const hash = (v) => { if (!/^0x[0-9a-f]{64}$/.test(v)) fail('invalid hash'); };
const address = (v) => { if (!/^0x[0-9a-f]{40}$/.test(v)) fail('invalid address'); };
const uint = (v) => { if (!/^(0|[1-9][0-9]*)$/.test(v)) fail('invalid unsigned decimal'); };
const text = (v) => { if (typeof v !== 'string' || !/^[\x20-\x7e]+$/.test(v)) fail('invalid ASCII text'); };
export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { text(value); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
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
  if (new Set(names).size !== names.length || names.join('|') !== [...names].sort().join('|')) fail('unordered closure');
  if (Object.keys(bytes).sort().join('|') !== names.join('|')) fail('closure bytes differ');
  for (const f of files) {
    exact(f, ['path', 'sha256']); hash(f.sha256);
    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(f.path) || f.path.split('/').some(p => p === '.' || p === '..')) fail('invalid path');
    if (!Buffer.isBuffer(bytes[f.path]) || sha256(bytes[f.path]) !== f.sha256) fail('file hash mismatch');
  }
}
export function deriveNativeIssuanceCommitments({ binding, runtime, sourceBytes, evidenceBytes }) {
  exact(binding, ['schema','chainId','genesisHash','requirementsSha256','sourceClosure','roles','economics','independentDeployment','runtimeAuthorityDigest']);
  if (binding.schema !== 'hookemon.native-issuance-prebinding.v1') fail('binding schema');
  uint(binding.chainId); hash(binding.genesisHash); hash(binding.requirementsSha256);
  exact(binding.sourceClosure, ['compilerPath','standardInputPath','files']);
  verifyFiles(binding.sourceClosure.files, sourceBytes);
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
  if (new Set(ids).size!==ids.length || ids.join('|')!==[...ids].sort().join('|')) fail('unordered authorities');
  for (const c of runtime.contracts) {
    exact(c,['role','address','codePath','abiPath','observationPath','blockNumber','blockHash']);
    text(c.role); address(c.address); uint(c.blockNumber); hash(c.blockHash);
    for (const key of ['codePath','abiPath','observationPath']) if (!Object.hasOwn(evidenceBytes,c[key])) fail('missing authority evidence');
  }
  const runtimeDigest=envelope('HOOKEMON_NATIVE_ISSUANCE_RUNTIME_AUTHORITY_V1',runtime);
  if (binding.runtimeAuthorityDigest !== runtimeDigest) fail('runtime commitment mismatch');
  return { bindingDigest:envelope('HOOKEMON_NATIVE_ISSUANCE_BINDING_V1',binding), runtimeDigest };
}
