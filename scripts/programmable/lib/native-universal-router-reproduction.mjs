import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { keccak256Hex } from './keccak.mjs';

const INPUT = new URL('../../../feasibility/native-universal-router-reproduction/compiler-input.json', import.meta.url);
const CONSTRUCTOR = new URL('../../../feasibility/native-universal-router-reproduction/constructor.json', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashText = value => keccak256Hex(Buffer.from(value));
const word = value => value.slice(2).toLowerCase().padStart(64, '0');
const shortString = value => Buffer.from(value).toString('hex').padEnd(62, '0') + Buffer.byteLength(value).toString(16).padStart(2, '0');
const need = (condition, message) => { if (!condition) throw new Error(`UNIVERSAL_ROUTER_REPRODUCTION: ${message}`); };

/** Recompile the fixed, closed official source input; no caller-defined source or constructor. */
export function reproduceNativeUniversalRouter({ compilerPath, observedCode }) {
  const compiler = readFileSync(compilerPath);
  need(sha(compiler) === '0ff016aef2396b12d1fc65429d8ea6cf53c2ee4b041bb8925644615ee1c30ab9', 'compiler distribution changed');
  const input = readFileSync(INPUT), constructorBytes = readFileSync(CONSTRUCTOR);
  need(sha(input) === '402c71cee3e1205b59ed168fed5f0e76b95146e6a8c6a708d36f729baea4480a', 'closed compiler input changed');
  need(sha(constructorBytes) === 'db6d68a1735e4cb856875fd02ea01ce4fd6bce06627d1f3beb3c71ac585ae943', 'official constructor record changed');
  const outputBytes = execFileSync(compilerPath, ['--standard-json'], { input, maxBuffer: 12_000_000, timeout: 120_000 });
  need(sha(outputBytes) === '29f7981ec9e032e8103d3903420d31be8921f6d0c643620bd8cee82d5b29ce7e', 'compiler output differs from independently reproduced artifact');
  const output = JSON.parse(outputBytes), registry = JSON.parse(constructorBytes);
  need(!output.errors?.some(error => error.severity === 'error'), 'compiler error');
  const target = output.contracts['contracts/UniversalRouter.sol'].UniversalRouter;
  const runtime = Buffer.from(target.evm.deployedBytecode.object, 'hex');
  const params = registry.input.constructor.params;
  const name = hashText('UniversalRouter'), version = hashText('2');
  const domain = keccak256Hex(Buffer.from([
    word(hashText('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
    word(name), word(version), (4663n).toString(16).padStart(64, '0'), word(registry.address),
  ].join(''), 'hex'));
  const values = {
    poolManager: word(params.v4PoolManager), SPOKE_POOL: word(params.spokePool),
    V3_POSITION_MANAGER: word(params.v3NFTPositionManager), V4_POSITION_MANAGER: word(params.v4PositionManager),
    WETH9: word(params.weth9), PERMIT2: word(params.permit2), UNISWAP_V2_FACTORY: word(params.v2Factory),
    UNISWAP_V2_PAIR_INIT_CODE_HASH: word(params.pairInitCodeHash), UNISWAP_V3_FACTORY: word(params.v3Factory),
    UNISWAP_V3_POOL_INIT_CODE_HASH: word(params.poolInitCodeHash), _cachedDomainSeparator: word(domain),
    _cachedChainId: (4663n).toString(16).padStart(64, '0'), _cachedThis: word(registry.address),
    _hashedName: word(name), _hashedVersion: word(version), _name: shortString('UniversalRouter'), _version: shortString('2'),
  };
  const names = new Map();
  function visit(value) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (value.nodeType === 'VariableDeclaration') names.set(String(value.id), value.name);
      Object.values(value).forEach(visit);
    }
  }
  Object.values(output.sources).forEach(source => visit(source.ast));
  const bound = new Set();
  for (const [id, slots] of Object.entries(target.evm.deployedBytecode.immutableReferences)) {
    const variable = names.get(id), value = values[variable];
    need(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), `unbound immutable ${variable}`);
    bound.add(variable);
    for (const slot of slots) {
      need(slot.length === 32 && Number.isSafeInteger(slot.start) && slot.start >= 0 && slot.start + 32 <= runtime.length, 'invalid immutable slot');
      Buffer.from(value, 'hex').copy(runtime, slot.start);
    }
  }
  need(bound.size === 17, 'immutable inventory changed');
  need(Buffer.isBuffer(observedCode) && runtime.equals(observedCode), 'full runtime differs from independent constructor reproduction');
  need(keccak256Hex(runtime) === '0xbe8e8191bb42d843c2e948a5a55772eaab864ce01e54dcd47c9d089170b302d5', 'runtime commitment differs');
  return { abi: target.abi, input, constructorBytes, outputBytes, runtime };
}
