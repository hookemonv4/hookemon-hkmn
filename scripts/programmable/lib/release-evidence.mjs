const CODE_HASH = /^0x[0-9a-fA-F]{64}$/;

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function cloneJson(value) {
  return structuredClone(value);
}

function constructorConfigName(internalType) {
  if (typeof internalType !== 'string') return 'ConstructorConfig';
  const match = internalType.match(/^struct\s+HookemonHook\.([A-Za-z_][A-Za-z0-9_]*)$/);
  return match?.[1] ?? 'ConstructorConfig';
}

export function hookConstructorConfigSchemaFromCompiledAbi(artifact) {
  const abi = requireObject(artifact, 'HookemonHook artifact').abi;
  if (!Array.isArray(abi)) fail('HookemonHook artifact ABI must be an array');
  const constructors = abi.filter((entry) => entry?.type === 'constructor');
  if (constructors.length !== 1) fail('HookemonHook artifact ABI must declare exactly one constructor');

  const inputs = constructors[0].inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    fail('HookemonHook constructor ABI must declare exactly one config argument');
  }
  const [config] = inputs;
  if (config?.type !== 'tuple' || !Array.isArray(config.components)) {
    fail('HookemonHook constructor config ABI must be a tuple');
  }

  const names = new Set();
  const components = config.components.map((component, index) => {
    if (
      typeof component?.name !== 'string'
      || component.name.length === 0
      || typeof component?.type !== 'string'
      || component.type.length === 0
    ) {
      fail(`HookemonHook constructor component ${index} is invalid`);
    }
    if (names.has(component.name)) fail(`HookemonHook constructor component ${component.name} is duplicated`);
    names.add(component.name);
    return `${component.name}:${component.type}`;
  });
  if (components.length === 0) fail('HookemonHook constructor config ABI must not be empty');

  return {
    type: 'tuple',
    name: constructorConfigName(config.internalType),
    components,
  };
}

function archivePinnedHash(source, constantName) {
  const match = source.match(new RegExp(
    `\\b${constantName}\\s*=\\s*\\n?\\s*(0x[0-9a-fA-F]{64})`,
  ));
  if (!match) fail(`archive fork source is missing ${constantName}`);
  return match[1].toLowerCase();
}

export function regeneratePhaseThreeGraphGasEvidence(evidence, archiveForkSource) {
  const next = cloneJson(evidence);
  const route = requireObject(next.route, 'graph gas evidence route');
  const deployments = requireObject(route.deployments, 'graph gas evidence deployments');
  for (const targetId of ['token', 'custody', 'hook']) {
    requireObject(deployments[targetId], `graph gas evidence deployment ${targetId}`);
  }

  deployments.token.runtimeCodeHash = archivePinnedHash(
    archiveForkSource,
    'PROVIDER_GAS_TOKEN_RUNTIME_CODEHASH',
  );
  deployments.custody.runtimeCodeHash = archivePinnedHash(
    archiveForkSource,
    'PROVIDER_GAS_CUSTODY_RUNTIME_CODEHASH',
  );
  deployments.hook.runtimeCodeHash = archivePinnedHash(
    archiveForkSource,
    'PROVIDER_GAS_HOOK_RUNTIME_CODEHASH',
  );
  route.graphDeploymentHash = archivePinnedHash(
    archiveForkSource,
    'PROVIDER_GAS_GRAPH_DEPLOYMENT_HASH',
  );

  for (const [targetId, deployment] of Object.entries(deployments)) {
    if (typeof deployment.runtimeCodeHash !== 'string' || !CODE_HASH.test(deployment.runtimeCodeHash)) {
      fail(`graph gas evidence deployment ${targetId} runtime code hash is invalid`);
    }
  }
  if (typeof route.graphDeploymentHash !== 'string' || !CODE_HASH.test(route.graphDeploymentHash)) {
    fail('graph gas evidence graph deployment hash is invalid');
  }
  return next;
}
